import { test } from "node:test"
import assert from "node:assert/strict"
import { contextTokens, estimateRequest, measureContext, parseOptions } from "../dist/context.js"

const model = { providerID: "p1", id: "m1" }
const usage = (input, extra = {}) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...extra })
const text = (id, value, role = "user") => ({ id, role, content: [{ type: "text", text: value }] })
const request = (messages, extra = {}) => ({ model, system: [], tools: {}, messages, ...extra })
const assistant = (id, tokens, extra = {}) => ({ type: "assistant", id, model, tokens, ...extra })

test("defaults use decimal 256k; invalid settings fail visibly", () => {
  assert.deepEqual(parseOptions({}), { thresholdTokens: 256000, retryDelayMs: 30000 })
  assert.deepEqual(parseOptions({ thresholdTokens: 262144, retryDelayMs: 1 }), { thresholdTokens: 262144, retryDelayMs: 1 })
  for (const value of [0, -1, 1.5, NaN, Infinity, "256000", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseOptions({ thresholdTokens: value }), /thresholdTokens must be/)
    assert.throws(() => parseOptions({ retryDelayMs: value }), /retryDelayMs must be/)
  }
})

test("context usage includes cached input, output and separate reasoning", () => {
  assert.equal(contextTokens(usage(100, { output: 20, reasoning: 10, cache: { read: 200, write: 30 } })), 360)
  assert.equal(contextTokens(usage(0, { cache: { read: 256000, write: 0 } })), 256000)
  assert.equal(contextTokens(usage(0, { output: 10 })), 0, "missing input usage is unknown")
  assert.equal(contextTokens(usage(-1)), 0)
  assert.equal(contextTokens(usage(NaN)), 0)
})

test("assembled estimates include instructions and advertised tool schemas", () => {
  const tools = { read: { description: "read file", input: { type: "object", properties: {} } } }
  const size = estimateRequest(request([text("u1", "abcd")], { system: [{ type: "text", text: "abcdefgh" }], tools }))
  assert.equal(size, 3 + Math.ceil(("read" + "read file" + JSON.stringify(tools.read.input)).length / 4))
})

test("tool results, reasoning and media are counted without encoded image byte inflation", () => {
  const parts = [
    { type: "reasoning", text: "12345678" },
    { type: "effort", effort: "high" },
    { type: "tool-call", id: "call1", name: "read", input: { path: "a" } },
    { type: "tool-result", id: "call1", name: "read", result: { type: "json", value: { ok: true } } },
    { type: "tool-result", id: "call2", name: "read", result: { type: "content", value: [
      { type: "text", text: "1234" }, { type: "image", mime: "image/png", data: "x".repeat(1000000) },
    ] } },
    { type: "media", media: { mediaType: "application/pdf", source: {} } },
    { type: "media", media: { mediaType: "audio/wav", source: {} } },
  ]
  assert.equal(estimateRequest(request([{ role: "assistant", content: parts }])),
    2 + Math.ceil(("read" + JSON.stringify({ path: "a" })).length / 4)
      + Math.ceil(JSON.stringify({ ok: true }).length / 4) + 1 + 1500 + 2000)
})

test("latest measured request plus new tool/user content replaces lifetime accumulation", () => {
  const history = [assistant("a0", usage(200000)), assistant("a1", usage(240000, { output: 1000, cache: { read: 5000, write: 0 } }))]
  const messages = [text("a0", "old", "assistant"), text("a1", "answer", "assistant"),
    { role: "tool", content: [{ type: "tool-result", id: "call", name: "read", result: { type: "text", value: "x".repeat(40000) } }] },
    text("u2", "abcd")]
  assert.deepEqual(measureContext(request(messages), history), { tokens: 256001, measured: true, opaque: false })
})

test("a larger assembled request wins over a provider anchor estimate", () => {
  assert.equal(measureContext(request([text("a1", "abcd", "assistant")], {
    system: [{ type: "text", text: "x".repeat(2000) }],
  }), [assistant("a1", usage(10))]).tokens, 501)
})

test("failed, missing, mismatched and pre-checkpoint anchors are ignored", () => {
  const outgoing = request([text("a1", "12345678", "assistant")])
  for (const history of [
    [assistant("a1", usage(256000), { error: { type: "provider.error" } })],
    [assistant("a1", usage(256000), { model: { providerID: "other", id: "m1" } })],
    [assistant("a1", usage(256000), { model: { providerID: "p1", id: "other" } })],
    [assistant("missing", usage(256000))],
    [assistant("a1", usage(256000)), { type: "compaction", status: "completed", id: "c1" }],
    [assistant("a1", usage(0))],
  ]) assert.deepEqual(measureContext(outgoing, history), { tokens: 2, measured: false, opaque: false })
})

test("opaque native checkpoints wait for a post-checkpoint primary measurement", () => {
  const checkpoint = { type: "compaction", id: "c1", status: "completed" }
  const messages = [{ role: "assistant", content: [{ type: "compaction", provider: "openai", encrypted: "x".repeat(1000000) }] }]
  assert.deepEqual(measureContext(request(messages), [checkpoint]), { tokens: 0, measured: false, opaque: true })
  messages.push(text("a2", "abcd", "assistant"))
  assert.deepEqual(measureContext(request(messages), [checkpoint, assistant("a2", usage(256000))]),
    { tokens: 256000, measured: true, opaque: true })
})
