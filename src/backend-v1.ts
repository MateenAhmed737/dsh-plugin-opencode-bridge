/** OpenCode 1.x backend, through the official `@opencode-ai/sdk/v2` client. */

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client'
import type { Backend, CreateSessionInput, TurnRunInput } from './backend.ts'
import { loadCatalog, type CatalogModel } from './catalog.ts'
import { permissionRules } from './permissions.ts'
import { basicAuth, type ServerConnection } from './runtime.ts'
import { runTurn, type Chunk, type TurnOutcome } from './turn.ts'

export class BackendV1 implements Backend {
  readonly api = 'v1' as const
  private readonly clients = new Map<string, OpencodeClient>()

  readonly connection: ServerConnection

  constructor(connection: ServerConnection) {
    this.connection = connection
  }

  client(directory: string): OpencodeClient {
    let client = this.clients.get(directory)
    if (!client) {
      client = createOpencodeClient({
        baseUrl: this.connection.url,
        directory,
        headers: basicAuth(this.connection.password),
        throwOnError: true,
      })
      this.clients.set(directory, client)
    }
    return client
  }

  listModels(directory: string, signal?: AbortSignal): Promise<CatalogModel[]> {
    return loadCatalog(this.client(directory), signal)
  }

  async createSession(input: CreateSessionInput): Promise<string> {
    const result = await this.client(input.directory).session.create({
      directory: input.directory,
      title: input.title,
      permission: permissionRules(),
    })
    const id = (result.data as { id?: string } | undefined)?.id
    if (!id) throw new Error('OpenCode did not return a session id')
    return id
  }

  runTurn(input: TurnRunInput): AsyncGenerator<Chunk, TurnOutcome> {
    return runTurn({
      client: this.client(input.directory),
      sessionID: input.sessionID,
      directory: input.directory,
      model: input.model,
      ...(input.variant ? { variant: input.variant } : {}),
      parts: [
        ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
        ...input.images.map((image) => ({
          type: 'file' as const,
          mime: image.mime,
          url: image.url,
          ...(image.name ? { filename: image.name } : {}),
        })),
      ],
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: input.timeoutMs,
      showToolActivity: input.showToolActivity,
      decidePermission: (request, signal) => input.decidePermission({
        id: request.id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
      }, signal),
    })
  }

  async deleteSession(sessionID: string, directory: string): Promise<void> {
    await this.client(directory).session.delete({ sessionID, directory }).catch(() => {})
  }
}
