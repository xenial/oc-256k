# oc-256k

An [OpenCode V2](https://opencode.ai/v2/docs/) plugin that automatically requests
native session compaction at **256,000 active context tokens**. Targets OpenCode
2.0.26 and its `@opencode/plugin` API.

## Install from GitHub

```sh
opencode plugin add github:xenial/oc-256k
```

OpenCode V2 loads the package's TypeScript entrypoint with Bun. If the running
service does not reload the plugin automatically, run `opencode service restart`.

## Install locally

From this directory:

```sh
npm install
npm test
```

Add the plugin directory to `plugins` in your project or global `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/oc-256k"
  ]
}
```

You can also place the built package and its installed dependencies at
`~/.config/opencode/plugins/oc-256k` for automatic global discovery. This package
includes TypeScript sources for Bun and compiled JavaScript for Node/npm.

## Options

All options are optional. The values below are the defaults:

```jsonc
{
  "plugins": [
    {
      "package": "github:xenial/oc-256k",
      "options": {
        "thresholdTokens": 256000,
        "retryDelayMs": 30000
      }
    }
  ]
}
```

Both options must be positive safe integers. Invalid values fail plugin setup
with a descriptive error. Use `262144` if you prefer a binary 256k threshold.

## Behavior

- Before each primary model request, including tool continuations, inspect the
  active context and estimate system text, tool definitions, messages, tool
  calls/results, images, and PDFs. Text/JSON uses about four characters per token;
  images use 1,500 tokens and PDFs use 2,000 tokens per content item. Other media
  has no local allowance and depends on provider usage.
- Use the latest valid assistant request's measured input, cache read/write,
  output, and reasoning tokens, plus estimated content after that assistant.
  Counts must match the active model and message ID and be newer than the latest
  completed checkpoint. Use the larger of this count and the full request estimate.
  Settled primary-step counts also detect crossing the threshold after a final
  answer and measure encrypted provider-native checkpoints.
- Request compaction at or above the threshold through `ctx.session.compact`.
  The native runner handles the summary, retained recent history, continuation,
  and provider-native compaction where configured. The plugin keeps the model's
  advertised limits and the normal compaction prompt.
- Admit one request per session while compaction is pending. Manual and built-in
  compaction also suppress duplicate requests. After success, re-arm when context
  falls below the threshold; if compaction cannot shrink it enough, this avoids
  repeatedly compacting the same oversized window. For encrypted checkpoints,
  re-arming requires a measured count below the threshold.
- After admission or compaction failure, retry only on a later context/usage
  observation after `retryDelayMs`. Ambiguous admission retries reuse their ID.
  Each session is independent. Events from sessions unseen by this plugin
  instance are ignored. Deletion and unload abort monitoring and requests.

`256k` means active context, not cumulative session spend. Long sessions can pass
the threshold repeatedly as each compacted window grows again. Existing sessions
are checked when they next issue a model request; no polling or startup-wide
compaction is performed.

## Timing and limits

The public [V2 context hook](https://opencode.ai/v2/docs/build/plugins/#model-requests)
cannot veto and rebuild the request it is inspecting. Compaction is queued for
the runner's **next safe boundary**, so one model step may exceed 256,000 tokens.
This is a threshold trigger, not a hard context cap. Token estimates are approximate
and hooks registered later can change the request further.

OpenCode's own [automatic compaction](https://opencode.ai/v2/docs/compaction) remains
available and can trigger earlier for a model with a smaller window. Keep it
enabled for that protection. This plugin's explicit requests also work with
`compaction.auto: false`. Configure recent history separately with
`compaction.keep.tokens`; the plugin uses the existing setting.

Provider title/generate/compaction requests and lifetime usage updates do not
trigger this plugin. Pending durable controls remain owned by OpenCode if the
plugin unloads. In-memory suppression resets on reload, and durable checkpoint
state is inspected on the next request. An event disconnect is retried with
bounded backoff; durable context inspection remains available during reconnection.

## Development

```sh
npm run build
npm test
npm run test:local
npm pack --dry-run
```

`npm test` rebuilds first. `npm run test:local` uses OpenCode's real Bun host to
resolve and load this directory through its root `index.ts`. Tests exercise token accounting and mocked V2 hooks,
admission, lifecycle events, and cleanup without calling an inference provider.
See [PLAN.md](PLAN.md) for the implementation plan and source references.

Decisions and failures are logged to stderr with the `[oc-256k]` prefix.
