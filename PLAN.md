# oc-256k implementation plan

## Goal and decisions

Create an OpenCode V2 plugin that automatically requests native session compaction
when active context reaches **256,000 tokens**. Interpret `256k` as decimal tokens,
not 262,144 tokens or lifetime usage. Make the threshold configurable.

Target the published `@opencode/plugin` **2.0.26** API. Use `Plugin.define`,
`ctx.session.hook("context", ...)`, `ctx.session.context`, and
`ctx.session.compact`. Keep the selected model's real limits and OpenCode's summary,
recent-history retention, provider-native compaction, and continuation behavior.

## Implementation

1. Create a standalone TypeScript ESM package in `oc-256k`, following the adjacent
   plugins' package and build conventions. Include TypeScript sources for Bun and a
   compiled entrypoint for Node/npm.
2. Estimate the assembled primary request's system instructions, tool schemas,
   message text, tool calls/results, and media. Follow V2's four-characters-per-token
   heuristic and fixed image/PDF allowances; do not count base64 bytes as text.
3. Read active durable context before each primary request. Use the newest valid
   assistant's provider token count (input, cache read/write, output, reasoning)
   plus content after that assistant when its ID and model match the request.
   Use the larger of this measurement and the assembled-request estimate.
   Also observe settled primary-step usage to trigger after a final response and
   measure opaque provider-native checkpoints.
4. Admit one durable compaction control per session with the default steering
   delivery. Suppress requests while admission or compaction is pending, including
   manual/native compaction. Keep a stable admission ID across ambiguous failures.
5. Re-arm after successful compaction only when context falls below the threshold,
   preventing loops when instructions, tools, or retained context remain too large.
   Retry failed admission/compaction only on a later observation after a cooldown.
   Recover outcome state from durable context as well as lifecycle events.
6. Act on lifecycle events only for sessions that this instance has seen through
   its location-scoped context hook. Dispose hooks, abort event subscriptions and
   requests, and discard session state on deletion/unload. Reconnect the event
   stream after transient disconnects.
7. Document local installation, defaults, behavior, API sources, and limitations.

## Validation

- Compile against the published V2 SDK with strict TypeScript.
- Test exact threshold boundaries, cached tokens, latest-request accounting,
  tool continuations, media estimates, existing sessions, and native checkpoints.
- Exercise concurrent observations, manual compaction, success/failure outcomes,
  cooldowns, event scoping, stream reconnection, deletion, and unload with a mocked
  SDK. No paid inference calls are required.
- Verify the npm package contains usable runtime entries and documentation.

## Public API limitation

V2's context hook can enqueue compaction but cannot veto and rebuild the current
model request. The native runner processes the request at its next safe boundary;
one model step can exceed 256,000 tokens. This plugin is a threshold trigger, not a
hard context cap. Built-in automatic compaction can still run earlier for smaller
models. Summary generation itself does not trigger the plugin.

## Sources checked

- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins/)
- [V2 compaction behavior](https://opencode.ai/v2/docs/compaction)
- [2.0.26 compaction accounting and estimates](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/compaction.ts)
- [2.0.26 message conversion](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/runner/to-llm-message.ts)

## Status

Implemented and verified:

- `npm install --no-audit --no-fund` and the strict TypeScript build succeed.
- `npm test`: **27 passed**, covering accounting, concurrency, lifecycle outcomes,
  cooldowns, native checkpoints, stream reconnection, and cleanup.
- `bun run src/index.ts` loads the source entrypoint successfully.
- `npm run test:local` verifies OpenCode's real Bun host resolves and loads the
  local directory through its root `index.ts`.
- `npm pack --dry-run --json` verifies the compiled/source entries, declarations,
  plan, README, and license are included.

Global installation was verified against the running OpenCode **2.0.26** service.
The package is installed at `~/.config/opencode/plugins/oc-256k`, with a relative
entry in global `opencode.json`; the service reports `oc-256k` as active. Existing
configuration values were preserved and the original config was backed up.
The service reloaded the plugin automatically. Live inference/summary generation
was not performed; threshold behavior is covered by the SDK harness tests.
