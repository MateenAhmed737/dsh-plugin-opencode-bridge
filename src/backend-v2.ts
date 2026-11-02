/**
 * OpenCode 2.x backend, through the official `@opencode/client` promise client.
 *
 * Follows T3 Code's OpenCode 2 path (packages/provider-opencode/src/server/v2/,
 * Copyright (c) 2026 T3 Tools Inc., MIT — see NOTICE.md): session permission
 * rules instead of config, `session.prompt`, the shared `/api/event` stream,
 * `session.execution.*` as the end of a turn, and rejected permissions always
 * answered with a message (a bare reject stops the whole execution).
 */

import { OpenCode, type OpenCodeClient } from '@opencode/client'
import type { Backend, CreateSessionInput, PermissionAsk, TurnRunInput } from './backend.ts'
import type { CatalogModel } from './catalog.ts'
import { PluginError, Codes, classifyOpenCodeError, classifyThrown, type Failure } from './errors.ts'
import { ALWAYS_ALLOWED, RESTRICTED, describePermission } from './permissions.ts'
import { basicAuth, type ServerConnection } from './runtime.ts'
import type { Chunk, FinishReason, TurnOutcome, Usage } from './turn.ts'

type Rule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }

/** 2.x names `bash` as `shell`; both are listed so either spelling is covered. */
export function permissionRulesV2(): Rule[] {
  const rule = (action: string, effect: Rule['effect'], resource = '*'): Rule => ({ action, resource, effect })
  return [
    rule('*', 'ask'),
    ...ALWAYS_ALLOWED.map((action) => rule(action, 'allow')),
    rule('list', 'allow'),
    ...[...RESTRICTED, 'shell'].map((action) => rule(action, 'ask')),
    rule('read', 'ask', '*.env'),
    rule('read', 'ask', '*.env.*'),
    rule('read', 'allow', '*.env.example'),
  ]
}

interface ModelInfoLike {
  id: string
  providerID: string
  name?: string
  type?: string
  status?: string
  enabled?: boolean
  capabilities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  cost?: Array<{ input?: number; output?: number }>
  variants?: Array<{ id: string }>
}

/** Turn `model.list` (+ optional provider names) into catalog entries (pure; tested directly). */
export function catalogFromModelList(models: readonly ModelInfoLike[], providerNames: ReadonlyMap<string, string>): CatalogModel[] {
  const out: CatalogModel[] = []
  for (const model of models) {
    if (model.status === 'deprecated' || model.enabled === false) continue
    if (model.type && model.type !== 'chat') continue
    const costs = model.cost ?? []
    const free = costs.length > 0 && costs.every((c) => (c.input ?? 0) === 0 && (c.output ?? 0) === 0)
    out.push({
      id: `${model.providerID}/${model.id}`,
      providerID: model.providerID,
      modelID: model.id,
      name: model.name || model.id,
      providerName: providerNames.get(model.providerID) ?? model.providerID,
      image: (model.capabilities?.input ?? []).includes('image'),
      reasoning: false,
      contextWindow: model.limit?.context && model.limit.context > 0 ? model.limit.context : undefined,
      maxOutput: model.limit?.output && model.limit.output > 0 ? model.limit.output : undefined,
      variants: (model.variants ?? []).map((v) => v.id),
      free,
    })
  }
  return out.sort((a, b) =>
    (a.providerID === 'opencode' ? 0 : 1) - (b.providerID === 'opencode' ? 0 : 1)
    || a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name))
}

export class BackendV2 implements Backend {
  readonly api = 'v2' as const

  readonly connection: ServerConnection
  private readonly client: OpenCodeClient

  private constructor(connection: ServerConnection, client: OpenCodeClient) {
    this.connection = connection
    this.client = client
  }

  static create(connection: ServerConnection): BackendV2 {
    const client = OpenCode.make({ baseUrl: connection.url, headers: basicAuth(connection.password) })
    return new BackendV2(connection, client)
  }

  async listModels(directory: string, signal?: AbortSignal): Promise<CatalogModel[]> {
    const options = signal ? { signal } : undefined
    const [models, providers] = await Promise.all([
      this.client.model.list({ location: { directory } }, options),
      // Provider names are decoration; never let them stall the list (as T3 Code does).
      this.client.provider.list({ location: { directory } } as never, { signal: AbortSignal.timeout(3_000) }).catch(() => undefined),
    ])
    const names = new Map<string, string>()
    const providerData = (providers as { data?: Array<{ id: string; name?: string }> } | undefined)?.data ?? []
    for (const provider of providerData) if (provider?.id && provider.name) names.set(provider.id, provider.name)
    return catalogFromModelList((models as { data?: ModelInfoLike[] }).data ?? [], names)
  }

  async createSession(input: CreateSessionInput): Promise<string> {
    const session = await this.client.session.create({
      title: input.title,
      location: { directory: input.directory },
      model: { providerID: input.model.providerID, id: input.model.modelID, ...(input.variant ? { variant: input.variant } : {}) },
      permissions: permissionRulesV2(),
    })
    return session.id
  }

  async switchModel(sessionID: string, model: { providerID: string; modelID: string }, variant?: string): Promise<void> {
    await this.client.session.switchModel({
      sessionID,
      model: { providerID: model.providerID, id: model.modelID, ...(variant ? { variant } : {}) },
    })
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.client.session.remove({ sessionID }, { signal: AbortSignal.timeout(5_000) }).catch(() => {})
  }

  runTurn(input: TurnRunInput): AsyncGenerator<Chunk, TurnOutcome> {
    return runTurnV2(this.client, input)
  }
}

// ---------------------------------------------------------------------------

interface V2Event { type: string; data?: Record<string, any> }

class Writer {
  readonly pending: Chunk[] = []
  private readonly blocks = new Map<string, { index: number; kind: 'text' | 'reasoning'; text: string; ended: boolean }>()
  private next = 0
  text = ''

  append(key: string, kind: 'text' | 'reasoning', delta: string): void {
    if (!delta) return
    let block = this.blocks.get(key)
    // A closed block never takes more text; a reused key starts a new block.
    if (!block || block.ended || block.kind !== kind) {
      if (block && !block.ended) {
        block.ended = true
        this.pending.push({ type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } })
      }
      block = { index: this.next++, kind, text: '', ended: false }
      this.blocks.set(key, block)
      this.pending.push({ type: 'block-start', index: block.index, blockType: kind })
    }
    block.text += delta
    if (kind === 'text') this.text += delta
    this.pending.push(kind === 'text'
      ? { type: 'text-delta', index: block.index, text: delta }
      : { type: 'reasoning-delta', index: block.index, text: delta })
  }

  /** Final text of a block: emit whatever the deltas missed, then close it. */
  end(key: string, kind: 'text' | 'reasoning', full: string): void {
    const block = this.blocks.get(key)
    const seen = block?.text ?? ''
    if (full.startsWith(seen) && full.length > seen.length) this.append(key, kind, full.slice(seen.length))
    const current = this.blocks.get(key)
    if (current && !current.ended) {
      current.ended = true
      this.pending.push({ type: 'block-end', index: current.index, block: { type: current.kind, text: current.text } })
    }
  }

  standalone(text: string): void {
    const index = this.next++
    this.text += text
    this.pending.push({ type: 'block-start', index, blockType: 'text' })
    this.pending.push({ type: 'text-delta', index, text })
    this.pending.push({ type: 'block-end', index, block: { type: 'text', text } })
  }

  closeAll(): void {
    for (const block of this.blocks.values()) {
      if (block.ended) continue
      block.ended = true
      this.pending.push({ type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } })
    }
  }

  get hasContent(): boolean {
    return [...this.blocks.values()].some((b) => b.text.length > 0)
  }

  *drain(): Generator<Chunk, void> {
    while (this.pending.length) yield this.pending.shift()!
  }
}

type Signal =
  | { kind: 'event'; event: V2Event }
  | { kind: 'stream-ended'; error?: unknown }
  | { kind: 'abort' }
  | { kind: 'timeout' }
  | { kind: 'prompt-failed'; error: unknown }
  | { kind: 'note'; text: string }

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

/** 2.x structured error → the 1.x-shaped error the shared classifier reads. */
export function classifyV2Error(error: { type?: string; message?: string; status?: number; response?: { body?: string } } | undefined): Failure {
  if (!error) return { message: 'OpenCode failed without an error payload.', code: Codes.UPSTREAM }
  return classifyOpenCodeError({
    name: error.type ?? 'UnknownError',
    data: {
      message: error.message ?? '',
      ...(typeof error.status === 'number' ? { statusCode: error.status } : {}),
      ...(error.response?.body ? { responseBody: error.response.body } : {}),
    },
  })
}

function toolLine(name: string, input: Record<string, unknown> | undefined, error?: string): string {
  const subject = [input?.command, input?.filePath, input?.path, input?.pattern, input?.url, input?.description]
    .find((v): v is string => typeof v === 'string' && v.length > 0) ?? ''
  const clipped = subject.replace(/\s+/g, ' ').slice(0, 160)
  if (error) return `\n\n> ⚠️ ${name}${clipped ? ` \`${clipped}\`` : ''} — ${error.replace(/\s+/g, ' ').slice(0, 200)}\n\n`
  return `\n\n> 🔧 ${name}${clipped ? ` \`${clipped}\`` : ''}\n\n`
}

export async function* runTurnV2(client: OpenCodeClient, input: TurnRunInput): AsyncGenerator<Chunk, TurnOutcome> {
  const { sessionID } = input
  const queue = new Queue<Signal>()
  const sse = new AbortController()
  const related = new Set<string>([sessionID])
  const writer = new Writer()
  const tools = new Map<string, { name: string; input?: Record<string, unknown>; shown: boolean }>()
  const handled = new Set<string>()
  const steps = new Set<string>()
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, seen: false }
  let sawActivity = false
  let lastFinish: string | undefined
  let stepError: Failure | undefined

  const onAbort = () => queue.push({ kind: 'abort' })
  input.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = input.timeoutMs > 0 ? setTimeout(() => queue.push({ kind: 'timeout' }), input.timeoutMs) : undefined
  timer?.unref?.()

  let connected!: () => void
  const connectedP = new Promise<void>((resolve) => { connected = resolve })
  const pump = (async () => {
    try {
      for await (const raw of client.event.subscribe({ signal: sse.signal }) as AsyncIterable<V2Event>) {
        if (!raw || typeof raw.type !== 'string') continue
        if (raw.type === 'server.connected') { connected(); continue }
        queue.push({ kind: 'event', event: raw })
      }
      queue.push({ kind: 'stream-ended' })
    } catch (error) {
      queue.push({ kind: 'stream-ended', error })
    } finally {
      connected()
    }
  })()

  const finishWith = function* (reason: FinishReason): Generator<Chunk, TurnOutcome> {
    writer.closeAll()
    yield* writer.drain()
    if (usage.seen) yield { type: 'usage', usage: toUsage(usage) }
    yield { type: 'finish', reason }
    return { text: writer.text, finish: reason }
  }

  const answer = (ask: PermissionAsk) => {
    if (handled.has(ask.id)) return
    handled.add(ask.id)
    void (async () => {
      let decision
      try {
        decision = await input.decidePermission(ask, sse.signal)
      } catch {
        decision = { reply: 'reject' as const, message: `Permission "${ask.permission}" was not granted.` }
      }
      if (sse.signal.aborted) return
      // Note first, so it lands before whatever the model does next.
      if (decision.reply === 'reject' && input.showToolActivity) queue.push({ kind: 'note', text: `\n\n> 🚫 Rejected ${describePermission(ask)}\n\n` })
      await client.permission.reply({
        sessionID: ask.sessionID,
        requestID: ask.id,
        decision: decision.reply,
        // A reject without a message stops the whole execution; always steer instead.
        ...(decision.message ? { message: decision.message } : decision.reply === 'reject' ? { message: 'Permission was not granted.' } : {}),
      }).catch(() => {})
    })()
  }

  try {
    if (input.signal?.aborted) {
      return yield* finishWith({ kind: 'aborted', failure: { message: 'Request was cancelled.', code: Codes.ABORTED } })
    }
    await Promise.race([connectedP, new Promise((r) => setTimeout(r, 10_000).unref?.())])

    client.session.prompt({
      sessionID,
      text: input.text,
      ...(input.images.length ? { files: input.images.map((image) => ({ uri: image.url, ...(image.name ? { name: image.name } : {}) })) } : {}),
    }, { signal: sse.signal }).catch((error: unknown) => {
      if (!sse.signal.aborted) queue.push({ kind: 'prompt-failed', error })
    })

    for (;;) {
      const signal = await queue.next()
      if (signal === undefined) break
      switch (signal.kind) {
        case 'abort':
        case 'timeout': {
          await client.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(5_000) }).catch(() => {})
          return yield* finishWith(signal.kind === 'abort'
            ? { kind: 'aborted', failure: { message: 'Request was cancelled; the OpenCode run was interrupted.', code: Codes.ABORTED } }
            : { kind: 'error', failure: { message: `OpenCode did not finish within ${Math.round(input.timeoutMs / 1000)}s (requestTimeoutMs); the run was interrupted.`, code: Codes.TRANSPORT } })
        }
        case 'prompt-failed':
          return yield* finishWith({ kind: 'error', failure: classifyThrown(signal.error) })
        case 'stream-ended':
          return yield* finishWith({ kind: 'error', failure: { message: 'Lost the connection to the local OpenCode server before the reply finished.', code: Codes.TRANSPORT } })
        case 'note':
          sawActivity = true
          writer.standalone(signal.text)
          yield* writer.drain()
          continue
        case 'event':
          break
      }

      const { type } = signal.event
      const d = signal.event.data ?? {}
      if (type === 'session.created' && d.parentID && related.has(d.parentID) && d.sessionID) {
        related.add(d.sessionID)
        continue
      }
      if (type === 'permission.asked') {
        if (related.has(d.sessionID)) {
          sawActivity = true
          answer({
            id: String(d.id),
            sessionID: String(d.sessionID),
            permission: String(d.action ?? 'unknown'),
            patterns: Array.isArray(d.resources) ? d.resources.map(String) : [],
            metadata: (d.metadata ?? {}) as Record<string, unknown>,
          })
        }
        continue
      }
      if (type === 'form.created') {
        const form = d.form as { id?: string; sessionID?: string } | undefined
        if (form?.id && form.sessionID && related.has(form.sessionID) && !handled.has(form.id)) {
          handled.add(form.id)
          client.session.form.cancel({
            sessionID: form.sessionID,
            formID: form.id,
            message: 'DeepSeek Harness cannot show OpenCode questions; continue without asking.',
          }).catch(() => {})
          writer.standalone('\n\n> ❔ OpenCode asked a question that DeepSeek Harness cannot show; it was declined.\n\n')
          yield* writer.drain()
        }
        continue
      }
      if (d.sessionID !== sessionID) continue

      // Ordinals count per kind (text 0, reasoning 0, ...), so the kind is part of the key, as in T3 Code.
      const key = `${d.assistantMessageID}:${type.startsWith('session.reasoning.') ? 'reasoning' : 'text'}:${d.ordinal}`
      switch (type) {
        case 'session.text.delta':
          writer.append(key, 'text', String(d.delta ?? ''))
          break
        case 'session.text.ended':
          writer.end(key, 'text', String(d.text ?? ''))
          break
        case 'session.reasoning.delta':
          writer.append(key, 'reasoning', String(d.delta ?? ''))
          break
        case 'session.reasoning.ended':
          writer.end(key, 'reasoning', String(d.text ?? ''))
          break
        case 'session.tool.input.started':
          sawActivity = true
          tools.set(String(d.id), { name: String(d.name ?? 'tool'), shown: false })
          break
        case 'session.tool.called': {
          sawActivity = true
          const tool = tools.get(String(d.id)) ?? { name: 'tool', shown: false }
          tool.input = (d.input ?? {}) as Record<string, unknown>
          tools.set(String(d.id), tool)
          break
        }
        case 'session.tool.success':
        case 'session.tool.failed': {
          const tool = tools.get(String(d.id))
          if (tool && !tool.shown && input.showToolActivity) {
            tool.shown = true
            const message = type === 'session.tool.failed' ? String(d.error?.message ?? 'failed') : undefined
            if (!(message && /permission|rejected|declined|not granted/i.test(message))) writer.standalone(toolLine(tool.name, tool.input, message))
          }
          break
        }
        case 'session.step.ended': {
          lastFinish = d.finish
          const id = String((signal.event as { id?: string }).id ?? `${d.assistantMessageID}:${steps.size}`)
          if (!steps.has(id)) {
            steps.add(id)
            addTokens(usage, d.tokens)
          }
          break
        }
        case 'session.step.failed':
          stepError = classifyV2Error(d.error)
          if (d.tokens) addTokens(usage, d.tokens)
          break
        case 'session.execution.succeeded': {
          if (lastFinish === 'length') return yield* finishWith({ kind: 'max-tokens' })
          if (!writer.hasContent && !sawActivity && !writer.text) {
            return yield* finishWith({ kind: 'error', failure: { message: 'OpenCode finished without any reply.', code: Codes.EMPTY } })
          }
          return yield* finishWith({ kind: 'stop' })
        }
        case 'session.execution.failed': {
          const failure = d.error ? classifyV2Error(d.error) : stepError ?? classifyV2Error(undefined)
          return yield* finishWith(failure.code === Codes.ABORTED ? { kind: 'aborted', failure } : { kind: 'error', failure })
        }
        case 'session.execution.interrupted': {
          const reason = String(d.reason ?? 'unknown')
          const failure = { message: `OpenCode stopped the run (${reason}).`, code: reason === 'user' ? Codes.ABORTED : Codes.UPSTREAM }
          return yield* finishWith(reason === 'user' ? { kind: 'aborted', failure } : { kind: 'error', failure })
        }
        default:
          break
      }
      yield* writer.drain()
    }
    return yield* finishWith({ kind: 'error', failure: { message: 'The OpenCode turn ended unexpectedly.', code: Codes.TRANSPORT } })
  } catch (error) {
    const failure = error instanceof PluginError ? error.toFailure() : classifyThrown(error)
    return yield* finishWith({ kind: 'error', failure })
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    if (timer) clearTimeout(timer)
    sse.abort()
    queue.close()
    await pump.catch(() => {})
  }
}

function addTokens(usage: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; seen: boolean }, tokens: any): void {
  if (!tokens) return
  usage.seen = true
  usage.input += Number(tokens.input ?? 0)
  usage.output += Number(tokens.output ?? 0)
  usage.reasoning += Number(tokens.reasoning ?? 0)
  usage.cacheRead += Number(tokens.cache?.read ?? 0)
  usage.cacheWrite += Number(tokens.cache?.write ?? 0)
}

function toUsage(u: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }): Usage {
  const usage: Usage = { inputTokens: u.input, outputTokens: u.output + u.reasoning, totalTokens: u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite }
  if (u.cacheRead) usage.cacheReadTokens = u.cacheRead
  if (u.cacheWrite) usage.cacheWriteTokens = u.cacheWrite
  if (u.reasoning) usage.reasoningTokens = u.reasoning
  return usage
}
