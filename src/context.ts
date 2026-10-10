import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"

export const DEFAULT_THRESHOLD_TOKENS = 256_000
export const DEFAULT_RETRY_DELAY_MS = 30_000

export interface Options {
  thresholdTokens: number
  retryDelayMs: number
}

export type History = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
export type RequestContext = Pick<SessionContext, "system" | "messages" | "tools" | "model">
type ContentPart = SessionContext["messages"][number]["content"][number]

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export function parseOptions(raw: Record<string, unknown>): Options {
  function integer(name: string, fallback: number): number {
    const value = raw[name]
    if (value === undefined) return fallback
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`[oc-256k] ${name} must be a positive safe integer`)
    }
    return value
  }
  return {
    thresholdTokens: integer("thresholdTokens", DEFAULT_THRESHOLD_TOKENS),
    retryDelayMs: integer("retryDelayMs", DEFAULT_RETRY_DELAY_MS),
  }
}

// OpenCode normalizes uncached input, cached input, output, and reasoning into
// separate fields. These are one request's usage, never session lifetime totals.
export function contextTokens(tokens: TokenUsage): number {
  const values = [tokens.input, tokens.cache.read, tokens.cache.write, tokens.output, tokens.reasoning]
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return 0
  if (tokens.input + tokens.cache.read + tokens.cache.write === 0) return 0
  return values.reduce((sum, value) => sum + value, 0)
}

const textTokens = (text: string) => Math.ceil(text.length / 4)
const json = (value: unknown) => JSON.stringify(value) ?? ""
const mediaTokens = (mime: string) => {
  const type = mime.toLowerCase()
  return type.startsWith("image/") ? 1_500 : type === "application/pdf" ? 2_000 : 0
}

function estimatePart(part: ContentPart): number {
  switch (part.type) {
    case "text":
    case "reasoning":
      return textTokens(part.text)
    case "compaction":
      // Encrypted provider checkpoints cannot be tokenized locally.
      return textTokens(part.text ?? "")
    case "effort":
      return 0
    case "media":
      return mediaTokens(part.media.mediaType)
    case "tool-call":
      return textTokens(part.name + json(part.input))
    case "tool-result":
      if (part.result.type === "content") {
        return part.result.value.reduce((sum, item) => sum + (
          item.type === "text" ? textTokens(item.text) : mediaTokens(item.mime)
        ), 0)
      }
      return textTokens(typeof part.result.value === "string" ? part.result.value : json(part.result.value))
  }
}

export function estimateMessages(messages: RequestContext["messages"]): number {
  return messages.reduce((sum, message) => sum + message.content.reduce(
    (total, part) => total + estimatePart(part), 0,
  ), 0)
}

export function estimateRequest(request: RequestContext): number {
  return request.system.reduce((sum, part) => sum + textTokens(part.text), 0)
    + Object.entries(request.tools).reduce((sum, [name, tool]) => (
      sum + textTokens(name + tool.description + json(tool.input))
    ), 0)
    + estimateMessages(request.messages)
}

export interface ContextSize {
  tokens: number
  measured: boolean
  opaque: boolean
}

export function measureContext(request: RequestContext, history: History): ContextSize {
  const estimated = estimateRequest(request)
  const opaque = request.messages.some((message) => message.content.some(
    (part) => part.type === "compaction" && part.encrypted !== undefined,
  ))
  // Do not reuse pre-compaction counts or a different model's opaque window.
  const checkpoint = history.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  for (let i = history.length - 1; i > checkpoint; i--) {
    const message = history[i]
    if (message.type !== "assistant" || message.error || !message.tokens
      || message.model.providerID !== request.model.providerID || message.model.id !== request.model.id) continue
    const measured = contextTokens(message.tokens)
    if (measured === 0) continue
    const anchor = request.messages.findIndex((item) => item.role === "assistant" && item.id === message.id)
    if (anchor < 0) continue
    // The provider saw the assistant output, but has not seen local tool results
    // or newer user input yet. Those appear after the assistant in this request.
    return { tokens: Math.max(estimated, measured + estimateMessages(request.messages.slice(anchor + 1))), measured: true, opaque }
  }
  return { tokens: estimated, measured: false, opaque }
}
