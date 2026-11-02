/**
 * One interface over the two OpenCode server generations:
 * - 1.x: `@opencode-ai/sdk/v2` (`/session`, `/event`, `/global/health`)
 * - 2.x: `@opencode/client` (`/api/*`), which T3 Code drives as "OpenCode 2"
 */

import type { CatalogModel } from './catalog.ts'
import type { ApiGeneration, ServerConnection } from './runtime.ts'
import type { Chunk, PermissionDecision, TurnOutcome } from './turn.ts'

export interface ImageInput {
  mime: string
  /** `data:` URL with the image bytes. */
  url: string
  name?: string
}

/** A permission request, normalized across generations. */
export interface PermissionAsk {
  id: string
  sessionID: string
  /** 1.x `permission`, 2.x `action` (e.g. `bash` / `shell`, `edit`, `webfetch`). */
  permission: string
  /** 1.x `patterns`, 2.x `resources`. */
  patterns: string[]
  metadata: Record<string, unknown>
}

export interface CreateSessionInput {
  directory: string
  model: { providerID: string; modelID: string }
  variant?: string
  title: string
}

export interface TurnRunInput {
  sessionID: string
  directory: string
  model: { providerID: string; modelID: string }
  variant?: string
  text: string
  images: ImageInput[]
  signal?: AbortSignal
  timeoutMs: number
  showToolActivity: boolean
  decidePermission(request: PermissionAsk, signal: AbortSignal): Promise<PermissionDecision>
}

export interface Backend {
  readonly api: ApiGeneration
  readonly connection: ServerConnection
  listModels(directory: string, signal?: AbortSignal): Promise<CatalogModel[]>
  createSession(input: CreateSessionInput): Promise<string>
  runTurn(input: TurnRunInput): AsyncGenerator<Chunk, TurnOutcome>
  deleteSession(sessionID: string, directory: string): Promise<void>
}

export async function makeBackend(connection: ServerConnection): Promise<Backend> {
  if (connection.api === 'v2') {
    const { BackendV2 } = await import('./backend-v2.ts')
    return BackendV2.create(connection)
  }
  const { BackendV1 } = await import('./backend-v1.ts')
  return new BackendV1(connection)
}
