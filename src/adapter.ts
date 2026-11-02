/**
 * The DSH LLM adapter (duck-typed against `LlmAdapter`, as in
 * @quonaro/dsh-plugin-opencode): model picker entries from the running
 * OpenCode server, and every request served by the user's own OpenCode.
 */

import type { Context } from '@deepseek-ai/cordis'
import { makeBackend, type Backend, type ImageInput, type PermissionAsk } from './backend.ts'
import type { BackendV2 } from './backend-v2.ts'
import { parseModelId, type CatalogModel } from './catalog.ts'
import { BridgeError, Codes, classifyThrown, describeError } from './errors.ts'
import { ALWAYS_ALLOWED, describePermission, rejectionMessage } from './permissions.ts'
import type { OpenCodeRuntime } from './runtime.ts'
import { conversation, digest, rebuildPreamble, SessionMap, splitNewTurn, turnText, type Block, type ImageRef, type Msg, type Turn } from './transcript.ts'
import type { Chunk, FinishReason, PermissionDecision, TurnOutcome } from './turn.ts'

export const PROVIDER_ID = 'opencode-bridge'
export const PROVIDER_NAME = 'OpenCode (local)'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface AdapterSettings {
  cwd: string
  allowRestrictedTools: boolean
  askForApproval: boolean
  requestTimeoutMs: number
  modelRefreshSeconds: number
  showToolActivity: boolean
  localSessionTitles: boolean
}

/** The request fields this adapter reads (structural subset of GenerateOptions). */
export interface GenerateRequest {
  provider: string
  model: string
  messages: Msg[]
  system?: string
  signal?: AbortSignal
  sessionId?: string
  reasoningEffort?: string
  purpose?: 'compaction' | 'session-title'
}

interface Logger {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
interface ApprovalLike {
  request(req: { agent: unknown; toolName: string; reason?: string; displayReason?: { en: string }; signal?: AbortSignal }): Promise<ApprovalOutcome>
}
interface AttachmentsLike {
  readImageRequest?(ref: ImageRef, target: { width: number; height: number; maxBytes: number }, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
  readImage?(ref: ImageRef, signal?: AbortSignal): Promise<{ data: Uint8Array }>
}

/** Retry only transport failures, once; never retry rate limits (OpenCode's message is shown as-is). */
const RETRY_POLICY = Object.freeze({
  mode: 'normal' as const,
  maxRetries: 1,
  retryableCodes: Object.freeze([Codes.TRANSPORT]) as readonly string[],
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

export interface AdapterDeps {
  ctx: Pick<Context, 'get'> | { get(name: string): unknown }
  runtime: OpenCodeRuntime
  settings(): AdapterSettings
  logger: Logger
  /** Called when the model list changed so pickers can refresh. */
  onModelsChanged?(): void
}

export class OpenCodeBridgeAdapter {
  private backend: Backend | undefined
  private catalog: { at: number; models: CatalogModel[]; key: string } | undefined
  private catalogLoading: Promise<CatalogModel[]> | undefined
  private readonly sessions = new SessionMap()

  private readonly deps: AdapterDeps

  constructor(deps: AdapterDeps) {
    this.deps = deps
  }

  // ---- LlmAdapter surface ----------------------------------------------------

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(_provider: string) {
    return RETRY_POLICY
  }

  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  imageRequestTarget(_provider: string, _model: string, image: { width: number; height: number; bytes: number }) {
    return { width: image.width, height: image.height, maxBytes: Math.min(image.bytes, MAX_IMAGE_BYTES) }
  }

  async listModels(provider: string) {
    let models: CatalogModel[]
    try {
      models = await this.models()
    } catch (error) {
      this.deps.logger.warn('opencode-bridge: could not list OpenCode models: %s', describeError(error))
      return []
    }
    return models.map((model) => ({
      provider,
      id: model.id,
      name: `${model.name}${model.free ? ' (free)' : ''}`,
      description: `${model.providerName} via your local OpenCode`,
      inputModalities: model.image ? (['text', 'image'] as const) : (['text'] as const),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal) {
    let entry: CatalogModel | undefined
    try {
      entry = (await this.models()).find((m) => m.id === model)
    } catch { /* unknown capabilities; routing still works */ }
    return {
      provider,
      id: model,
      name: entry ? entry.name : model,
      inputModalities: entry?.image ? (['text', 'image'] as const) : (['text'] as const),
      ...(entry?.contextWindow ? { context: { contextWindow: entry.contextWindow } } : {}),
      ...(entry && entry.variants.length > 0
        ? { reasoning: { efforts: entry.variants.map((id) => ({ id, name: id })) } }
        : {}),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateRequest) => this.stream(options),
    }
  }

  async *stream(options: GenerateRequest): AsyncGenerator<Chunk, void> {
    try {
      yield* this.streamInner(options)
    } catch (error) {
      const failure = classifyThrown(error)
      yield { type: 'finish', reason: options.signal?.aborted ? { kind: 'aborted', failure: { message: 'Request was cancelled.', code: Codes.ABORTED } } : { kind: 'error', failure } }
    }
  }

  // ---- internals ---------------------------------------------------------------

  /** Shared backend for the current server; rebuilt when the server is restarted or re-attached. */
  async getBackend(): Promise<Backend> {
    const connection = await this.deps.runtime.connect()
    if (!this.backend || this.backend.connection.serial !== connection.serial) {
      if (this.backend && this.backend.connection.url !== connection.url && connection.external) this.sessions.clear()
      this.backend = await makeBackend(connection)
    }
    return this.backend
  }

  private defaultDirectory(): string {
    return this.deps.settings().cwd.trim() || process.cwd()
  }

  /** Cached catalog, refreshed after `modelRefreshSeconds`. */
  async models(force = false): Promise<CatalogModel[]> {
    const backend = await this.getBackend()
    const key = `${backend.connection.url}#${backend.connection.serial}`
    const maxAge = Math.max(10, this.deps.settings().modelRefreshSeconds) * 1000
    if (!force && this.catalog && this.catalog.key === key && Date.now() - this.catalog.at < maxAge) return this.catalog.models
    this.catalogLoading ??= (async () => {
      try {
        let models = await backend.listModels(this.defaultDirectory(), AbortSignal.timeout(30_000))
        // Cold catalogs can come back empty for a moment; retry once (as T3 Code does).
        if (models.length === 0) {
          await new Promise((r) => setTimeout(r, 1_500))
          models = await backend.listModels(this.defaultDirectory(), AbortSignal.timeout(30_000))
        }
        const changed = !this.catalog || this.catalog.models.map((m) => m.id).join('\n') !== models.map((m) => m.id).join('\n')
        this.catalog = { at: Date.now(), models, key }
        if (changed) this.deps.onModelsChanged?.()
        return models
      } finally {
        this.catalogLoading = undefined
      }
    })()
    return this.catalogLoading
  }

  private agentFor(sessionId: string | undefined): unknown {
    const agents = this.deps.ctx.get('agents') as { get?(id: string): unknown; currentInitiator?(): unknown } | undefined
    if (!agents) return undefined
    try {
      return (sessionId ? agents.get?.(sessionId) : undefined) ?? agents.currentInitiator?.()
    } catch {
      return undefined
    }
  }

  private directoryFor(agent: unknown): string {
    const configured = this.deps.settings().cwd.trim()
    if (configured) return configured
    const wd = this.deps.ctx.get('workingDirectory') as { get?(session: unknown): string } | undefined
    const session = (agent as { session?: unknown } | undefined)?.session
    if (wd?.get && session) {
      try {
        const dir = wd.get(session)
        if (dir) return dir
      } catch { /* fall through */ }
    }
    return process.cwd()
  }

  private async decidePermission(ask: PermissionAsk, agent: unknown, signal: AbortSignal): Promise<PermissionDecision> {
    const settings = this.deps.settings()
    const name = ask.permission.toLowerCase()
    const dotenv = name === 'read' && ask.patterns.some((p) => /(^|[\\/])\.env(\.|$)/.test(p) && !/\.env\.example$/.test(p))
    if ((ALWAYS_ALLOWED as readonly string[]).includes(name) && !dotenv) return { reply: 'once' }
    if (settings.allowRestrictedTools) return { reply: 'once' }
    const approval = this.deps.ctx.get('approval') as ApprovalLike | undefined
    if (!settings.askForApproval || !approval || !agent) {
      return { reply: 'reject', message: rejectionMessage(ask.permission, approval && agent ? 'policy' : settings.askForApproval ? 'unavailable' : 'policy') }
    }
    const summary = describePermission(ask)
    let outcome: ApprovalOutcome
    try {
      outcome = await approval.request({
        agent,
        toolName: `opencode:${ask.permission}`,
        reason: `OpenCode wants to run ${summary}`,
        displayReason: { en: `OpenCode wants permission for ${summary}` },
        signal,
      })
    } catch (error) {
      this.deps.logger.debug('opencode-bridge: approval prompt failed: %s', describeError(error))
      outcome = 'unavailable'
    }
    if (outcome === 'allowed-once') return { reply: 'once' }
    const reason = outcome === 'rejected' ? 'user' : outcome === 'cancelled' ? 'cancelled' : 'unavailable'
    return { reply: 'reject', message: rejectionMessage(ask.permission, reason) }
  }

  private async imagesFor(turns: readonly Turn[], model: CatalogModel | undefined, signal?: AbortSignal): Promise<{ images: ImageInput[]; notes: string[] }> {
    const images: ImageInput[] = []
    const notes: string[] = []
    const attachments = this.deps.ctx.get('attachments') as AttachmentsLike | undefined
    for (const turn of turns) {
      for (const block of turn.blocks) {
        if (block.type !== 'image' || (block as { offloaded?: true }).offloaded) continue
        const ref = (block as { attachment: ImageRef }).attachment
        const label = ref.name ?? 'image'
        if (model && !model.image) { notes.push(`[${label} omitted: ${model.name} does not accept images]`); continue }
        if (!IMAGE_MIMES.has(ref.mediaType)) { notes.push(`[${label} omitted: unsupported type ${ref.mediaType}]`); continue }
        if (!attachments?.readImageRequest && !attachments?.readImage) { notes.push(`[${label} omitted: attachments unavailable]`); continue }
        try {
          const read = attachments.readImageRequest
            ? await attachments.readImageRequest(ref, this.imageRequestTarget('', '', ref), signal)
            : { ...(await attachments.readImage!(ref, signal)), mediaType: ref.mediaType }
          if (read.data.byteLength > MAX_IMAGE_BYTES) { notes.push(`[${label} omitted: larger than 20 MB]`); continue }
          images.push({ mime: read.mediaType, url: `data:${read.mediaType};base64,${Buffer.from(read.data).toString('base64')}`, ...(ref.name ? { name: ref.name } : {}) })
        } catch (error) {
          notes.push(`[${label} omitted: ${describeError(error)}]`)
        }
      }
    }
    return { images, notes }
  }

  private async *streamInner(options: GenerateRequest): AsyncGenerator<Chunk, void> {
    const settings = this.deps.settings()

    if (options.purpose === 'session-title' && settings.localSessionTitles) {
      yield* localTitle(options.messages)
      return
    }

    const parsed = parseModelId(options.model)
    if (!parsed) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `"${options.model}" is not an OpenCode model id; expected provider/model.`, code: Codes.INVALID_MODEL } } }
      return
    }
    const backend = await this.getBackend()
    const catalogEntry = await this.models().then((m) => m.find((x) => x.id === options.model)).catch(() => undefined)
    const agent = this.agentFor(options.sessionId)
    const directory = this.directoryFor(agent)
    const variant = options.reasoningEffort && catalogEntry?.variants.includes(options.reasoningEffort) ? options.reasoningEffort : undefined

    const turns = conversation(options.messages)
    const { history, newTurn } = splitNewTurn(turns)
    const ephemeral = !options.sessionId || options.purpose !== undefined
    const key = ephemeral ? `ephemeral:${Math.random()}` : `dsh:${options.sessionId}`

    yield* this.sessions.lockGen(key, async function* (this: OpenCodeBridgeAdapter): AsyncGenerator<Chunk, void> {
      const existing = ephemeral ? undefined : this.sessions.get(key)
      const historyDigest = digest(history)
      const reuse = !!existing && existing.directory === directory && existing.digest === historyDigest && newTurn.length > 0
      let sessionID: string
      const textParts: string[] = []
      if (reuse) {
        sessionID = existing!.sessionID
        if (backend.api === 'v2' && existing!.model !== `${options.model}#${variant ?? ''}`) {
          await (backend as BackendV2).switchModel(sessionID, parsed, variant)
        }
      } else {
        sessionID = await backend.createSession({
          directory,
          model: parsed,
          ...(variant ? { variant } : {}),
          title: ephemeral ? `DeepSeek Harness ${options.purpose ?? 'request'}` : 'DeepSeek Harness',
        })
        if (ephemeral && options.system) textParts.push(`Instructions:\n${options.system}`)
        const preamble = rebuildPreamble(newTurn.length > 0 ? history : history.slice(0, -1))
        if (preamble) textParts.push(preamble)
        if (newTurn.length === 0 && history.length > 0) textParts.push(turnText(history[history.length - 1]!))
      }
      for (const turn of newTurn) {
        const text = turnText({ role: 'user', blocks: turn.blocks.filter((b: Block) => b.type !== 'image') })
        if (text) textParts.push(text)
      }
      const { images, notes } = await this.imagesFor(newTurn, catalogEntry, options.signal)
      textParts.push(...notes)
      const text = textParts.join('\n\n')

      const generator = backend.runTurn({
        sessionID,
        directory,
        model: parsed,
        ...(variant ? { variant } : {}),
        text,
        images,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: settings.requestTimeoutMs,
        showToolActivity: settings.showToolActivity,
        decidePermission: (ask, signal) => this.decidePermission(ask, agent, signal),
      })
      let outcome: TurnOutcome | undefined
      for (;;) {
        const step = await generator.next()
        if (step.done) { outcome = step.value; break }
        yield step.value
      }

      if (ephemeral) {
        void backend.deleteSession(sessionID, directory)
        return
      }
      if (keepsSession(outcome.finish)) {
        const after: Turn[] = [...history, ...newTurn, { role: 'assistant', blocks: [{ type: 'text', text: outcome.text }] }]
        this.sessions.set(key, { sessionID, directory, digest: digest(after), serverKey: backend.connection.url, model: `${options.model}#${variant ?? ''}` })
      } else {
        // The OpenCode session now holds a failed turn; rebuild from DSH's transcript next time.
        this.sessions.delete(key)
      }
    }.bind(this))
  }

  dispose(): void {
    this.sessions.clear()
    this.backend = undefined
    this.catalog = undefined
  }
}

function keepsSession(finish: FinishReason): boolean {
  return finish.kind === 'stop' || finish.kind === 'max-tokens' || finish.kind === 'aborted'
}

/*
 * Local session titles, adapted from @quonaro/dsh-plugin-opencode (MIT): the
 * host wraps title requests in a JSON frame; answer from the first human
 * message instead of spending a model request (and free-tier quota) on it.
 */
const TITLE_FRAME_PREFIX = 'Generate the session title from this JSON array of human messages:'

export function sessionTitleText(messages: readonly Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const raw = turnText({ role: 'user', blocks: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content })
    const at = raw.indexOf(TITLE_FRAME_PREFIX)
    if (at === -1) return raw.replace(/\s+/g, ' ').trim() || 'OpenCode chat'
    try {
      const items = JSON.parse(raw.slice(at + TITLE_FRAME_PREFIX.length)) as unknown
      if (Array.isArray(items)) {
        for (const item of items as Array<{ text?: unknown }>) {
          const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : ''
          if (text) return text
        }
      }
    } catch { /* fall through */ }
    return 'OpenCode chat'
  }
  return 'OpenCode chat'
}

function* localTitle(messages: readonly Msg[]): Generator<Chunk, void> {
  const full = sessionTitleText(messages)
  const text = full.length > 60 ? `${full.slice(0, 57).trimEnd()}…` : full
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

export { BridgeError }
