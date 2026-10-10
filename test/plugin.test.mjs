import { test } from "node:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import plugin from "../dist/index.js"

const usage = (input, extra = {}) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...extra })
const model = { providerID: "p1", id: "m1" }
const text = (tokens, id = "u1", role = "user") => ({ id, role, content: [{ type: "text", text: "x".repeat(tokens * 4) }] })
const checkpoint = (id, status = "completed") => ({ type: "compaction", id, status })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function eventStream(signal) {
  const queue = []
  let pending
  let ended = false
  const stream = {
    [Symbol.asyncIterator]() { return this },
    next() {
      if (queue.length) return Promise.resolve({ done: false, value: queue.shift() })
      if (ended) return Promise.resolve({ done: true })
      return new Promise((resolve, reject) => { pending = { resolve, reject } })
    },
    return() {
      ended = true
      pending?.resolve({ done: true })
      pending = undefined
      signal.removeEventListener("abort", abort)
      return Promise.resolve({ done: true })
    },
    push(event) {
      if (pending) { pending.resolve({ done: false, value: event }); pending = undefined }
      else queue.push(event)
    },
    fail(error) {
      ended = true
      pending?.reject(error)
      pending = undefined
    },
  }
  const abort = () => { void stream.return() }
  signal.addEventListener("abort", abort, { once: true })
  return stream
}

async function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 })
  const logs = []
  t.mock.method(console, "error", (line) => logs.push(line))
  const hooks = new Map()
  const streams = []
  const calls = []
  const histories = new Map()
  const disposed = []
  let compactImpl
  let contextImpl
  let cleaned = false
  const ctx = {
    options: { thresholdTokens: 100, retryDelayMs: 1000, ...options },
    session: {
      async hook(name, fn) {
        hooks.set(name, fn)
        return { async dispose() { disposed.push(name); hooks.delete(name) } }
      },
      async context(input, requestOptions) {
        if (contextImpl) return contextImpl(input, requestOptions)
        return histories.get(input.sessionID) ?? []
      },
      async compact(input, requestOptions) {
        calls.push({ ...input, signal: requestOptions.signal })
        if (compactImpl) return compactImpl(input, requestOptions)
        return { id: input.id, sessionID: input.sessionID, type: "compaction" }
      },
    },
    event: {
      subscribe({ signal }) {
        const stream = eventStream(signal)
        streams.push(stream)
        return stream
      },
    },
  }
  const cleanup = await plugin.setup(ctx)
  const h = {
    calls, histories, streams, logs, disposed,
    setCompact(fn) { compactImpl = fn },
    setContext(fn) { contextImpl = fn },
    async context(tokens = 100, sessionID = "s1", extra = {}) {
      const event = { sessionID, agent: "build", model, system: [], tools: {}, messages: [text(tokens)], options: {}, ...extra }
      await hooks.get("context")?.(event)
      return event
    },
    async emit(type, sessionID = "s1", data = {}) {
      streams.at(-1).push({ type, data: { sessionID, ...data } })
      await setImmediate()
    },
    async tick(ms) { t.mock.timers.tick(ms); await setImmediate() },
    async cleanup() { if (!cleaned) { cleaned = true; await cleanup() } },
  }
  t.after(() => h.cleanup())
  return h
}

test("queues at exactly 256,000 tokens and leaves request content unchanged", async (t) => {
  const h = await harness(t, { thresholdTokens: 256000 })
  await h.context(255999)
  assert.equal(h.calls.length, 0)
  const event = await h.context(256000)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0].id, /^msg_oc256k_/)
  assert.equal(h.calls[0].delivery, undefined, "native default runs at next safe boundary")
  assert.equal(event.messages[0].content[0].text.length, 1024000)
  assert.deepEqual(event.options, {})
  await h.context(300000)
  assert.equal(h.calls.length, 1)
})

test("simultaneous context observations admit only one control", async (t) => {
  const h = await harness(t)
  const admission = deferred()
  h.setCompact(() => admission.promise)
  const first = h.context()
  await setImmediate()
  await h.context()
  assert.equal(h.calls.length, 1)
  admission.resolve({ id: h.calls[0].id })
  await first
  await h.context()
  assert.equal(h.calls.length, 1, "admission completion is not compaction completion")
})

test("sessions compact independently and unseen server-wide usage is ignored", async (t) => {
  const h = await harness(t)
  await h.emit("session.step.ended", "foreign", { tokens: usage(1000) })
  assert.equal(h.calls.length, 0)
  await h.context(100, "s1")
  await h.context(100, "s2")
  assert.deepEqual(h.calls.map((call) => call.sessionID), ["s1", "s2"])
})

test("cached primary usage triggers after the final answer without summing session totals", async (t) => {
  const h = await harness(t)
  await h.context(1)
  await h.emit("session.usage.updated", "s1", { tokens: usage(1000) })
  await h.emit("session.usage.recorded", "s1", { source: "compaction", tokens: usage(1000) })
  await h.emit("session.step.ended", "s1", { tokens: usage(60) })
  await h.emit("session.step.ended", "s1", { tokens: usage(60) })
  assert.equal(h.calls.length, 0, "two small requests are not a 120-token context")
  await h.emit("session.step.ended", "s1", { tokens: usage(0, { cache: { read: 99, write: 0 }, output: 1 }) })
  assert.equal(h.calls.length, 1)
})

test("existing measured context detects newly returned tool output", async (t) => {
  const h = await harness(t)
  h.histories.set("s1", [{ type: "assistant", id: "a1", model, tokens: usage(90) }])
  await h.context(1, "s1", { messages: [text(1, "a1", "assistant"),
    { role: "tool", content: [{ type: "tool-result", id: "call", name: "read", result: { type: "text", value: "x".repeat(40) } }] }] })
  assert.equal(h.calls.length, 1)
})

test("successful compaction latches until context drops below the threshold", async (t) => {
  const h = await harness(t)
  await h.context()
  await h.emit("session.compaction.started")
  await h.emit("session.compaction.ended")
  h.histories.set("s1", [checkpoint("c1")])
  await h.context(100)
  await h.emit("session.step.ended", "s1", { tokens: usage(150) })
  assert.equal(h.calls.length, 1, "an oversized summary/system/tool set does not cause a loop")
  await h.context(99)
  await h.context(100)
  assert.equal(h.calls.length, 2)
  assert.notEqual(h.calls[0].id, h.calls[1].id)
})

test("manual compaction is suppressed through hooks and durable outcomes", async (t) => {
  const h = await harness(t)
  h.histories.set("s1", [checkpoint("manual", "running")])
  await h.context(100)
  assert.equal(h.calls.length, 0)
  h.histories.set("s1", [checkpoint("manual")])
  await h.context(100)
  assert.equal(h.calls.length, 0)
  await h.context(50)
  await h.context(100)
  assert.equal(h.calls.length, 1)
})

test("a missed success event is recovered from the next durable context", async (t) => {
  const h = await harness(t)
  await h.context()
  h.histories.set("s1", [checkpoint(h.calls[0].id)])
  await h.context(50)
  await h.context(100)
  assert.equal(h.calls.length, 2)
})

test("an existing checkpoint does not inhibit a session that has already grown", async (t) => {
  const h = await harness(t)
  h.histories.set("s1", [checkpoint("old")])
  await h.context(100)
  assert.equal(h.calls.length, 1)
})

test("admission failure waits for cooldown and reuses the admission ID", async (t) => {
  const h = await harness(t)
  h.setCompact(() => { throw new Error("network response lost") })
  await h.context()
  await h.context()
  assert.equal(h.calls.length, 1)
  await h.tick(999)
  await h.context()
  assert.equal(h.calls.length, 1)
  await h.tick(1)
  h.setCompact(undefined)
  await h.context()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[0].id, h.calls[1].id)
})

test("failed compaction retries on a later observation with a fresh ID", async (t) => {
  const h = await harness(t)
  await h.context()
  h.histories.set("s1", [checkpoint(h.calls[0].id, "failed")])
  await h.emit("session.compaction.failed")
  await h.context()
  assert.equal(h.calls.length, 1)
  await h.tick(1000)
  await h.context()
  assert.equal(h.calls.length, 2)
  assert.notEqual(h.calls[0].id, h.calls[1].id)
})

test("manual compaction lifecycle events suppress requests without a running snapshot", async (t) => {
  const h = await harness(t)
  await h.context(1)
  await h.emit("session.compaction.started", "s1", { inputID: "manual" })
  await h.context(100)
  assert.equal(h.calls.length, 0)
  await h.emit("session.compaction.failed")
  h.histories.set("s1", [checkpoint("manual", "failed")])
  await h.tick(1000)
  await h.context(100)
  assert.equal(h.calls.length, 1, "the durable failure does not restart its cooldown")
})

test("a missed failed event is recovered once from durable context", async (t) => {
  const h = await harness(t)
  await h.context()
  h.histories.set("s1", [checkpoint(h.calls[0].id, "failed")])
  await h.context()
  await h.tick(999)
  await h.context()
  assert.equal(h.calls.length, 1)
  await h.tick(1)
  await h.context()
  assert.equal(h.calls.length, 2)
})

test("opaque checkpoints require measured below-threshold usage to re-arm", async (t) => {
  const h = await harness(t)
  await h.context()
  await h.emit("session.compaction.ended")
  h.histories.set("s1", [checkpoint("c1")])
  const opaque = { messages: [{ role: "assistant", content: [{ type: "compaction", provider: "p1", encrypted: "opaque" }] }] }
  await h.context(0, "s1", opaque)
  await h.emit("session.step.ended", "s1", { tokens: usage(0) })
  await h.emit("session.step.ended", "s1", { tokens: usage(150) })
  assert.equal(h.calls.length, 1)
  await h.emit("session.step.ended", "s1", { tokens: usage(50) })
  await h.emit("session.step.ended", "s1", { tokens: usage(100) })
  assert.equal(h.calls.length, 2)
})

test("lifecycle completion before admission returns is preserved", async (t) => {
  const h = await harness(t)
  const admission = deferred()
  h.setCompact(() => admission.promise)
  const request = h.context()
  await setImmediate()
  await h.emit("session.compaction.started")
  await h.emit("session.compaction.ended")
  admission.reject(new Error("late response failure"))
  await request
  await h.tick(1000)
  await h.context()
  assert.equal(h.calls.length, 1)
})

test("context inspection errors do not fail or rewrite the model request", async (t) => {
  const h = await harness(t)
  h.setContext(() => { throw new Error("service unavailable") })
  const event = await h.context(100)
  assert.equal(h.calls.length, 0)
  assert.deepEqual(event.options, {})
  assert.ok(h.logs.some((line) => line.includes("context inspection failed")))
})

test("event-stream disconnects reconnect and monitoring resumes", async (t) => {
  const h = await harness(t)
  await h.context(1)
  h.streams[0].fail(new Error("disconnected"))
  await setImmediate()
  await h.tick(1000)
  assert.equal(h.streams.length, 2)
  await h.emit("session.step.ended", "s1", { tokens: usage(100) })
  assert.equal(h.calls.length, 1)
})

test("deletion cancels a pending admission without blocking other sessions", async (t) => {
  const h = await harness(t)
  h.setCompact((input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  }))
  await h.context(1)
  await h.emit("session.step.ended", "s1", { tokens: usage(100) })
  assert.equal(h.calls.length, 1)
  await h.emit("session.deleted")
  assert.equal(h.calls[0].signal.aborted, true)
  await h.emit("session.step.ended", "s1", { tokens: usage(100) })
  assert.equal(h.calls.length, 1)
})

test("unload disposes hooks and aborts in-flight context inspection", async (t) => {
  const h = await harness(t)
  let signal
  h.setContext((input, options) => new Promise((resolve, reject) => {
    signal = options.signal
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  }))
  const request = h.context()
  await setImmediate()
  await h.cleanup()
  await request
  assert.equal(signal.aborted, true)
  assert.deepEqual(h.disposed, ["context"])
  assert.equal(h.calls.length, 0)
})
