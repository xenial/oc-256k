import { randomUUID } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import { contextTokens, measureContext, parseOptions, type History } from "./context.js"

interface SessionState {
  phase: "armed" | "pending" | "compacting" | "latched"
  controller: AbortController
  retryAt: number
  observed: boolean
  checkpointID?: string
  failedID?: string
  requestID?: string
}

function reconnectDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}

export default Plugin.define({
  id: "oc-256k",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const sessions = new Map<string, SessionState>()
    const controller = new AbortController()
    const log = (message: string) => console.error(`[oc-256k] ${message}`)
    const active = (sessionID: string, state: SessionState) => (
      !controller.signal.aborted && sessions.get(sessionID) === state && !state.controller.signal.aborted
    )

    function stateFor(sessionID: string): SessionState {
      let state = sessions.get(sessionID)
      if (!state) {
        state = { phase: "armed", controller: new AbortController(), retryAt: 0, observed: false }
        sessions.set(sessionID, state)
      }
      return state
    }

    function completed(state: SessionState): void {
      state.phase = "latched"
      state.requestID = undefined
      state.retryAt = 0
    }

    function failed(state: SessionState): void {
      state.phase = "armed"
      state.requestID = undefined
      state.retryAt = Date.now() + options.retryDelayMs
    }

    function reconcile(state: SessionState, history: History): void {
      const latest = history.findLast((message) => message.type === "compaction")
      if (latest?.type !== "compaction") return
      if (latest.status === "running") {
        state.phase = "compacting"
        state.requestID = latest.id
      } else if (latest.status === "completed" && latest.id !== state.checkpointID) {
        // An old checkpoint on first load need not inhibit a session that has
        // already grown again. A new checkpoint must first show a smaller window.
        if (state.observed || state.phase === "pending" || state.phase === "compacting") completed(state)
        state.checkpointID = latest.id
      } else if (latest.status === "failed" && latest.id !== state.failedID) {
        failed(state)
        state.failedID = latest.id
      }
    }

    async function observe(sessionID: string, state: SessionState, tokens: number, allowRearm = true): Promise<void> {
      if (!active(sessionID, state)) return
      if (allowRearm && state.phase === "latched" && tokens < options.thresholdTokens) state.phase = "armed"
      if (state.phase !== "armed" || tokens < options.thresholdTokens || Date.now() < state.retryAt) return
      state.phase = "pending"
      // Exact admission retries reuse this ID if the first response was lost.
      state.requestID ??= `msg_oc256k_${randomUUID().replaceAll("-", "")}`
      try {
        const admitted = await ctx.session.compact(
          { sessionID, id: state.requestID }, { signal: state.controller.signal },
        )
        if (!active(sessionID, state)) return
        if (state.phase === "pending") state.requestID = admitted.id
        log(`session=${sessionID} context=${tokens} threshold=${options.thresholdTokens}: compaction requested`)
      } catch (error) {
        if (!active(sessionID, state)) return
        // A lifecycle event may have settled an ambiguously admitted request
        // before the API response failed; do not undo that outcome.
        if (state.phase === "pending") {
          state.phase = "armed"
          state.retryAt = Date.now() + options.retryDelayMs
        }
        log(`session=${sessionID}: compaction admission failed: ${String(error)}`)
      }
    }

    const contextHook = await ctx.session.hook("context", async (event) => {
      if (controller.signal.aborted) return
      const state = stateFor(event.sessionID)
      try {
        const history = await ctx.session.context({ sessionID: event.sessionID }, { signal: state.controller.signal })
        if (!active(event.sessionID, state)) return
        reconcile(state, history)
        state.observed = true
        const size = measureContext(event, history)
        await observe(event.sessionID, state, size.tokens, !size.opaque || size.measured)
      } catch (error) {
        if (!active(event.sessionID, state)) return
        // Monitoring failures should not stop the user's model request.
        log(`session=${event.sessionID}: context inspection failed: ${String(error)}`)
      }
    })

    const watch = (async () => {
      let reconnectMs = 1_000
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            reconnectMs = 1_000
            if (!("sessionID" in event.data)) continue
            const sessionID = event.data.sessionID
            const state = sessions.get(sessionID)
            // The stream is server-wide; the context hook establishes ownership.
            if (!state || !active(sessionID, state)) continue
            switch (event.type) {
              case "session.step.ended": {
                const tokens = contextTokens(event.data.tokens)
                // Never treat unknown usage as proof that compaction shrank an
                // opaque checkpoint. Admission must not block lifecycle events.
                if (tokens > 0) void observe(sessionID, state, tokens)
                break
              }
              case "session.compaction.started":
                state.phase = "compacting"
                if (event.data.inputID !== undefined) state.requestID = event.data.inputID
                break
              case "session.compaction.ended":
                completed(state)
                break
              case "session.compaction.failed":
                state.failedID = state.requestID
                failed(state)
                log(`session=${sessionID}: compaction failed; retry after ${options.retryDelayMs}ms on a later observation`)
                break
              case "session.deleted":
                sessions.delete(sessionID)
                state.controller.abort()
                break
            }
          }
          if (!controller.signal.aborted) log("event stream ended; reconnecting")
        } catch (error) {
          if (!controller.signal.aborted) log(`event stream disconnected: ${String(error)}`)
        }
        if (!controller.signal.aborted) {
          await reconnectDelay(reconnectMs, controller.signal)
          reconnectMs = Math.min(30_000, reconnectMs * 2)
        }
      }
    })()

    return async () => {
      controller.abort()
      for (const state of sessions.values()) state.controller.abort()
      sessions.clear()
      await contextHook.dispose()
      await watch
    }
  },
})
