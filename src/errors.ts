/**
 * Error helpers: readable OpenCode/provider messages and DSH failure classification.
 *
 * `readableProviderErrorMessage` is adapted from T3 Code
 * (packages/provider-opencode/src/server/providerErrorMessage.ts),
 * Copyright (c) 2026 T3 Tools Inc., MIT License. See NOTICE.md.
 */

/** DSH finish failure shape (structural copy of `LlmFailure`). */
export interface Failure {
  readonly message: string
  readonly code: string
  readonly status?: number
}

/** Stable failure codes this plugin emits. `RATE_LIMIT`/`TRANSPORT` etc. are DSH's canonical codes. */
export const Codes = {
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH: 'AUTH',
  TRANSPORT: 'TRANSPORT',
  SERVER: 'SERVER',
  CONTEXT: 'CONTEXT_WINDOW_EXCEEDED',
  EMPTY: 'EMPTY_RESPONSE',
  ABORTED: 'ABORTED',
  CONTENT_FILTER: 'CONTENT_FILTER',
  UPSTREAM: 'UPSTREAM',
  OPENCODE_MISSING: 'OPENCODE_NOT_FOUND',
  OPENCODE_VERSION: 'OPENCODE_VERSION',
  OPENCODE_STARTUP: 'OPENCODE_STARTUP',
  INVALID_MODEL: 'INVALID_MODEL',
} as const

/** Error carrying a classified failure; thrown internally and turned into a finish chunk. */
export class PluginError extends Error {
  readonly code: string
  readonly status: number | undefined
  constructor(message: string, code: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginError'
    this.code = code
    this.status = status
  }

  toFailure(): Failure {
    return { message: this.message, code: this.code, ...(this.status !== undefined ? { status: this.status } : {}) }
  }
}

/** OpenCode stores `<none>` when it cannot read the provider body. */
export function readableProviderErrorMessage(
  message?: string,
  status?: number,
  body?: string,
): string | undefined {
  const text = message?.trim() ?? ''
  if (text && text.toLowerCase() !== '<none>') return text
  const title = body
    ?.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim()
  if (title) return typeof status === 'number' ? `${title} (HTTP ${status}).` : title
  if (typeof status === 'number') return `The model provider failed the request (HTTP ${status}).`
  return text
    ? 'The model provider failed the request and did not include an error message.'
    : undefined
}

/** The error union OpenCode attaches to assistant messages and `session.error` events. */
export interface OpenCodeErrorLike {
  name?: string
  data?: Record<string, unknown>
}

const NETWORK_RE = /\b(?:ECONN[A-Z]+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|connection (?:reset|refused|closed)|premature close|terminated|other side closed|proxy)\b/i
const TIMEOUT_RE = /\btime(?:d)?\s*out\b|\btimeout\b/i

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Classify an OpenCode message error into a DSH failure. The OpenCode message is
 * kept unchanged (after `<none>` handling) so the user sees what T3 Code shows.
 */
export function classifyOpenCodeError(error: OpenCodeErrorLike | undefined): Failure {
  if (!error) return { message: 'OpenCode session failed without an error payload.', code: Codes.UPSTREAM }
  const data = error.data ?? {}
  const statusRaw = data.statusCode
  const status = typeof statusRaw === 'number' ? statusRaw : undefined
  const body = str(data.responseBody)
  const message = readableProviderErrorMessage(str(data.message), status, body) ?? error.name ?? 'OpenCode request failed.'
  const detail = `${error.name ?? ''} ${message} ${body ?? ''}`
  const withStatus = (code: string): Failure => ({ message, code, ...(status !== undefined ? { status } : {}) })

  switch (error.name) {
    case 'MessageAbortedError':
      return { message, code: Codes.ABORTED }
    case 'ContextOverflowError':
      return withStatus(Codes.CONTEXT)
    case 'ContentFilterError':
      return { message, code: Codes.CONTENT_FILTER }
    case 'ProviderAuthError':
      return withStatus(Codes.AUTH)
    default:
      break
  }
  if (status === 429 || /\bFreeUsageLimitError\b/.test(detail)) return withStatus(Codes.RATE_LIMIT)
  if (status === 401 || status === 403 || /\bFreeTierError\b/.test(detail)) return withStatus(Codes.AUTH)
  if (status !== undefined && status >= 500) return withStatus(Codes.SERVER)
  if (status === undefined && (NETWORK_RE.test(detail) || TIMEOUT_RE.test(detail))) return { message, code: Codes.TRANSPORT }
  return withStatus(Codes.UPSTREAM)
}

/**
 * Classify a thrown value from talking to the local OpenCode server
 * (SDK call, SSE stream, spawn). Anything that is not already classified is
 * a transport failure: the request never got a model answer.
 */
export function classifyThrown(value: unknown): Failure {
  if (value instanceof PluginError) return value.toFailure()
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // SDK error bodies with throwOnError: { name, data } or { error: {...} }
    const inner = (record.error ?? record.data ?? record) as OpenCodeErrorLike
    if (typeof inner?.name === 'string' && inner.data && typeof inner.data === 'object') {
      return classifyOpenCodeError(inner)
    }
  }
  const message = describeError(value)
  return { message, code: Codes.TRANSPORT }
}

/** Render an error with its cause chain, without any request bodies. */
export function describeError(value: unknown): string {
  const parts: string[] = []
  let current: unknown = value
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    if (current instanceof Error) {
      if (current.message && !parts.includes(current.message)) parts.push(current.message)
      current = (current as { cause?: unknown }).cause
    } else if (typeof current === 'object') {
      const record = current as Record<string, unknown>
      const message = str(record.message) ?? str((record.data as Record<string, unknown> | undefined)?.message)
      parts.push(message ?? 'OpenCode request failed')
      break
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.join(': ') || 'Unknown error'
}

/** Remove a secret from text before it is shown or logged. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]')
  }
  return out
}
