/**
 * One model turn against an OpenCode session: subscribe to the event stream,
 * send the prompt, translate OpenCode events into DSH stream chunks, answer
 * permission requests, and finish with a classified reason.
 *
 * The event handling follows T3 Code's OpenCode adapter
 * (packages/provider-opencode/src/server/adapter.ts, Copyright (c) 2026
 * T3 Tools Inc., MIT — see NOTICE.md): text/reasoning parts and deltas,
 * step-finish token usage, permission.asked / question.asked, session.status
 * idle as the end of the turn, session.error for failures.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2/client'
import { BridgeError, Codes, classifyOpenCodeError, classifyThrown, type Failure, type OpenCodeErrorLike } from './errors.ts'
import { describePermission } from './permissions.ts'

/** Structural copy of DSH's StreamChunk (kept local so the plugin has no runtime import of dsh-llm). */
export type Chunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text' | 'reasoning'; text: string } }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason }

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: Failure }
  | { kind: 'error'; failure: Failure }

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  tool?: { messageID: string; callID: string }
}

export interface PermissionDecision {
  reply: 'once' | 'always' | 'reject'
  message?: string
}

export interface FilePart {
  type: 'file'
  mime: string
  url: string
  filename?: string
}
export interface TextPart {
  type: 'text'
  text: string
}

export interface TurnInput {
  client: OpencodeClient
  sessionID: string
  directory: string
  model: { providerID: string; modelID: string }
  variant?: string
  parts: Array<TextPart | FilePart>
  signal?: AbortSignal
  timeoutMs: number
  showToolActivity: boolean
  decidePermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>
}

export interface TurnOutcome {
  /** Concatenated text of every text block we emitted (for the transcript digest). */
  text: string
  finish: FinishReason
}

interface BlockState {
  index: number
  kind: 'text' | 'reasoning'
  text: string
  ended: boolean
}

interface OcEvent {
  type: string
  properties: Record<string, any>
}

/** Minimal async queue fed by the SSE pump. */
class Queue<T> {
  private items: T[] = []
  private waiters: Array<(value: T | undefined) => void> = []
  private closed = false
  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }
  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
  next(): Promise<T | undefined> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    if (this.closed) return Promise.resolve(undefined)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

type Signal =
  | { kind: 'event'; event: OcEvent }
  | { kind: 'stream-ended'; error?: unknown }
  | { kind: 'abort' }
  | { kind: 'timeout' }
  | { kind: 'prompt-failed'; error: unknown }
  | { kind: 'chunk'; chunk: Chunk }

const TOOL_LABELS: Record<string, string> = { bash: 'Ran', edit: 'Edited', write: 'Wrote', read: 'Read', glob: 'Searched files', grep: 'Searched', webfetch: 'Fetched', websearch: 'Searched the web', task: 'Subagent', todowrite: 'Updated todos', patch: 'Patched', apply_patch: 'Patched' }

function toolLine(part: { tool: string; state: Record<string, any> }): string {
  const state = part.state
  const input = (state.input ?? {}) as Record<string, unknown>
  const subject = (typeof state.title === 'string' && state.title)
    || (typeof input.command === 'string' && input.command)
    || (typeof input.filePath === 'string' && input.filePath)
    || (typeof input.pattern === 'string' && input.pattern)
    || (typeof input.url === 'string' && input.url)
    || (typeof input.description === 'string' && input.description)
    || ''
  const clipped = String(subject).replace(/\s+/g, ' ').slice(0, 160)
  const label = TOOL_LABELS[part.tool] ?? `Tool ${part.tool}`
  if (state.status === 'error') {
    const reason = String(state.error ?? 'failed').replace(/\s+/g, ' ').slice(0, 200)
    return `\n\n> ⚠️ ${label}${clipped ? ` \`${clipped}\`` : ''} — ${reason}\n\n`
  }
  return `\n\n> 🔧 ${label}${clipped ? ` \`${clipped}\`` : ''}\n\n`
}

/**
 * Run one turn. Yields DSH chunks; the generator's return value is the outcome.
 * The caller owns session creation and the transcript digest.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<Chunk, TurnOutcome> {
  const { client, sessionID } = input
  const queue = new Queue<Signal>()
  const sse = new AbortController()
  const related = new Set<string>([sessionID])
  const roles = new Map<string, 'user' | 'assistant'>()
  const blocks = new Map<string, BlockState>()
  /** Part id → kind, known before the part has any text (deltas arrive for empty parts). */
  const partKinds = new Map<string, 'text' | 'reasoning'>()
  const toolsShown = new Set<string>()
  const stepIds = new Set<string>()
  const handledRequests = new Set<string>()
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, seen: false }
  let nextIndex = 0
  let emittedText = ''
  let sawActivity = false
  let started = false
  let error: OpenCodeErrorLike | undefined
  let lastFinish: string | undefined
  let aborted = false


  const onAbort = () => queue.push({ kind: 'abort' })
  input.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = input.timeoutMs > 0 ? setTimeout(() => queue.push({ kind: 'timeout' }), input.timeoutMs) : undefined
  timer?.unref?.()

  // ---- event subscription ------------------------------------------------
  let connected!: () => void
  const connectedP = new Promise<void>((resolve) => { connected = resolve })
  const pump = (async () => {
    try {
      const sub = await client.event.subscribe(
        { directory: input.directory },
        { signal: sse.signal, sseMaxRetryAttempts: 1, onSseError: () => {} } as never,
      )
      for await (const raw of sub.stream as AsyncIterable<unknown>) {
        const event = raw as OcEvent
        if (!event || typeof event.type !== 'string') continue
        if (event.type === 'server.connected') { connected(); continue }
        queue.push({ kind: 'event', event })
      }
      queue.push({ kind: 'stream-ended' })
    } catch (err) {
      queue.push({ kind: 'stream-ended', error: err })
    } finally {
      connected()
    }
  })()

  const cleanup = async () => {
    input.signal?.removeEventListener('abort', onAbort)
    if (timer) clearTimeout(timer)
    sse.abort()
    queue.close()
    await pump.catch(() => {})
  }

  try {
    if (input.signal?.aborted) {
      return { text: '', finish: { kind: 'aborted', failure: { message: 'Request was cancelled.', code: Codes.ABORTED } } }
    }
    // Wait until the subscription is live so no event of this turn is missed.
    await Promise.race([connectedP, new Promise((r) => setTimeout(r, 10_000).unref?.())])

    // ---- send the prompt -------------------------------------------------
    client.session.promptAsync({
      sessionID,
      directory: input.directory,
      model: input.model,
      ...(input.variant ? { variant: input.variant } : {}),
      parts: input.parts,
    }, { signal: sse.signal }).catch((err: unknown) => {
      if (!sse.signal.aborted) queue.push({ kind: 'prompt-failed', error: err })
    })

    // ---- helpers ------------------------------------------------------------
    const pending: Chunk[] = []
    const setText = (partId: string, kind: 'text' | 'reasoning', full: string) => {
      let block = blocks.get(partId)
      if (!block) {
        if (!full) return
        block = { index: nextIndex++, kind, text: '', ended: false }
        blocks.set(partId, block)
        pending.push({ type: 'block-start', index: block.index, blockType: kind })
      }
      if (block.ended || !full.startsWith(block.text) || full.length === block.text.length) return
      const delta = full.slice(block.text.length)
      block.text = full
      if (kind === 'text') emittedText += delta
      pending.push(kind === 'text'
        ? { type: 'text-delta', index: block.index, text: delta }
        : { type: 'reasoning-delta', index: block.index, text: delta })
    }
    const endBlock = (block: BlockState) => {
      if (block.ended) return
      block.ended = true
      pending.push({ type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } })
    }
    const emitStandalone = (text: string) => {
      const index = nextIndex++
      emittedText += text
      pending.push({ type: 'block-start', index, blockType: 'text' })
      pending.push({ type: 'text-delta', index, text })
      pending.push({ type: 'block-end', index, block: { type: 'text', text } })
    }
    const answerPermission = (request: PermissionRequest) => {
      if (handledRequests.has(request.id)) return
      handledRequests.add(request.id)
      void (async () => {
        let decision: PermissionDecision
        try {
          decision = await input.decidePermission(request, sse.signal)
        } catch {
          decision = { reply: 'reject', message: `Permission "${request.permission}" was not granted.` }
        }
        if (sse.signal.aborted) return
        // Note first, so it lands before whatever the model does next.
        if (decision.reply === 'reject' && input.showToolActivity) {
          queue.push({ kind: 'chunk', chunk: { type: 'text-delta', index: -1, text: `\n\n> 🚫 Rejected ${describePermission(request)}\n\n` } })
        }
        try {
          await client.permission.reply({
            requestID: request.id,
            directory: input.directory,
            reply: decision.reply,
            ...(decision.message ? { message: decision.message } : {}),
          })
        } catch { /* already answered or session aborted */ }
      })()
    }

    // ---- main loop ------------------------------------------------------------
    for (;;) {
      const signal = await queue.next()
      if (signal === undefined) break
      if (signal.kind === 'abort' || signal.kind === 'timeout') {
        if (signal.kind === 'abort') aborted = true

        try {
          await client.session.abort({ sessionID, directory: input.directory }, { signal: AbortSignal.timeout(5_000) })
        } catch { /* best effort */ }
        break
      }
      if (signal.kind === 'prompt-failed') {
        error = undefined
        throw classifiedThrow(signal.error)
      }
      if (signal.kind === 'stream-ended') {
        throw new BridgeError(
          'Lost the connection to the local OpenCode server before the reply finished.',
          Codes.TRANSPORT, undefined, { cause: signal.error },
        )
      }
      if (signal.kind === 'chunk') {
        // A note from an async handler (e.g. a rejected permission): standalone block.
        const chunk = signal.chunk
        if (chunk.type === 'text-delta') { sawActivity = true; emitStandalone(chunk.text) }
        yield* drain(pending)
        continue
      }

      const { type, properties: p } = signal.event
      switch (type) {
        case 'session.created':
        case 'session.updated': {
          const info = p.info as { id?: string; parentID?: string } | undefined
          if (info?.id && info.parentID && related.has(info.parentID)) related.add(info.id)
          break
        }
        case 'message.updated': {
          const info = p.info as { id: string; sessionID: string; role: 'user' | 'assistant'; error?: OpenCodeErrorLike; finish?: string; time?: { completed?: number } }
          if (!info || info.sessionID !== sessionID) break
          roles.set(info.id, info.role)
          if (info.role === 'assistant') {
            started = true
            if (info.error) error = info.error
            if (info.finish) lastFinish = info.finish
          }
          break
        }
        case 'message.part.updated': {
          const part = p.part as Record<string, any>
          if (!part || part.sessionID !== sessionID) break
          const role = roles.get(part.messageID)
          if (role === 'user') break
          if (part.type === 'text' || part.type === 'reasoning') {
            if (part.synthetic || part.ignored) break
            // User text parts carry no timing; assistant parts always do.
            if (role === undefined && !part.time) break
            started = true
            partKinds.set(part.id, part.type)
            setText(part.id, part.type, String(part.text ?? ''))
            const block = blocks.get(part.id)
            if (block && part.time?.end) endBlock(block)
          } else if (part.type === 'tool') {
            started = true
            sawActivity = true
            const status = part.state?.status
            if (input.showToolActivity && (status === 'completed' || status === 'error') && !toolsShown.has(part.id)) {
              toolsShown.add(part.id)
              // Rejected permissions already produced a note.
              const rejected = status === 'error' && /permission|rejected/i.test(String(part.state?.error ?? ''))
              if (!rejected) emitStandalone(toolLine(part as never))
            }
          } else if (part.type === 'step-finish' && !stepIds.has(part.id)) {
            stepIds.add(part.id)
            const t = part.tokens ?? {}
            usage.seen = true
            usage.input += Number(t.input ?? 0)
            usage.output += Number(t.output ?? 0)
            usage.reasoning += Number(t.reasoning ?? 0)
            usage.cacheRead += Number(t.cache?.read ?? 0)
            usage.cacheWrite += Number(t.cache?.write ?? 0)
            if (typeof part.reason === 'string') lastFinish = part.reason
          }
          break
        }
        case 'message.part.delta': {
          if (p.sessionID !== sessionID || p.field !== 'text') break
          const kind = blocks.get(p.partID)?.kind ?? partKinds.get(p.partID)
          if (kind) setText(p.partID, kind, (blocks.get(p.partID)?.text ?? '') + String(p.delta ?? ''))
          break
        }
        case 'permission.asked':
        case 'permission.updated': {
          if (!related.has(p.sessionID)) break
          sawActivity = true
          answerPermission({
            id: String(p.id),
            sessionID: String(p.sessionID),
            permission: String(p.permission ?? p.type ?? 'unknown'),
            patterns: Array.isArray(p.patterns) ? p.patterns.map(String) : [],
            metadata: (p.metadata ?? {}) as Record<string, unknown>,
            ...(p.tool ? { tool: p.tool } : {}),
          })
          break
        }
        case 'question.asked': {
          if (!related.has(p.sessionID) || handledRequests.has(p.id)) break
          handledRequests.add(p.id)
          // DSH cannot show OpenCode's question UI; dismiss it so the model continues.
          client.question.reject({ requestID: String(p.id), directory: input.directory }).catch(() => {})
          break
        }
        case 'session.error': {
          if (p.sessionID !== undefined && p.sessionID !== sessionID) break
          if (p.error) error = p.error as OpenCodeErrorLike
          if (p.sessionID === undefined) started = true
          break
        }
        case 'session.status': {
          if (p.sessionID !== sessionID) break
          if (p.status?.type === 'busy' || p.status?.type === 'retry') started = true
          else if (p.status?.type === 'idle' && started) {
            yield* drain(pending)
            return yield* finish()
          }
          break
        }
        case 'session.idle': {
          if (p.sessionID !== sessionID || !started) break
          yield* drain(pending)
          return yield* finish()
        }
        default:
          break
      }
      yield* drain(pending)
    }

    // Aborted or timed out.
    for (const block of blocks.values()) if (!block.ended) { block.ended = true; yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } } }
    if (usage.seen) yield { type: 'usage', usage: toUsage(usage) }
    const finishReason: FinishReason = aborted
      ? { kind: 'aborted', failure: { message: 'Request was cancelled; the OpenCode run was aborted.', code: Codes.ABORTED } }
      : { kind: 'error', failure: { message: `OpenCode did not finish within ${Math.round(input.timeoutMs / 1000)}s (requestTimeoutMs); the run was aborted.`, code: Codes.TRANSPORT } }
    yield { type: 'finish', reason: finishReason }
    return { text: emittedText, finish: finishReason }
  } catch (err) {
    for (const block of blocks.values()) if (!block.ended) { block.ended = true; yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } } }
    const failure = classifyThrown(err)
    const finishReason: FinishReason = { kind: 'error', failure }
    yield { type: 'finish', reason: finishReason }
    return { text: emittedText, finish: finishReason }
  } finally {
    await cleanup()
  }

  function* finish(): Generator<Chunk, TurnOutcome> {
    for (const block of blocks.values()) {
      if (!block.ended) { block.ended = true; yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } } }
    }
    if (usage.seen) yield { type: 'usage', usage: toUsage(usage) }
    let reason: FinishReason
    if (error) {
      const failure = classifyOpenCodeError(error)
      reason = failure.code === Codes.ABORTED
        ? { kind: 'aborted', failure }
        : error.name === 'MessageOutputLengthError' ? { kind: 'max-tokens' } : { kind: 'error', failure }
    } else if (lastFinish === 'length') {
      reason = { kind: 'max-tokens' }
    } else if (!emittedText.trim() && !sawActivity && ![...blocks.values()].some((b) => b.text)) {
      reason = { kind: 'error', failure: { message: 'OpenCode finished without any reply.', code: Codes.EMPTY } }
    } else {
      reason = { kind: 'stop' }
    }
    yield { type: 'finish', reason }
    return { text: emittedText, finish: reason }
  }
}

function* drain(pending: Chunk[]): Generator<Chunk, void> {
  while (pending.length) yield pending.shift()!
}

function classifiedThrow(err: unknown): BridgeError {
  const failure = classifyThrown(err)
  return new BridgeError(failure.message, failure.code, failure.status, { cause: err })
}

function toUsage(u: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }): Usage {
  const usage: Usage = {
    inputTokens: u.input,
    outputTokens: u.output + u.reasoning,
    totalTokens: u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite,
  }
  if (u.cacheRead) usage.cacheReadTokens = u.cacheRead
  if (u.cacheWrite) usage.cacheWriteTokens = u.cacheWrite
  if (u.reasoning) usage.reasoningTokens = u.reasoning
  return usage
}
