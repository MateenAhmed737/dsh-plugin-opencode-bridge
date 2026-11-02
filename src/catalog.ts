/**
 * Model catalog read from the running OpenCode server: every model of every
 * *connected* provider (the user's own logins plus OpenCode's built-in free
 * models), keeping OpenCode's `provider/model` ids. Mirrors T3 Code's
 * openCode2Catalog.ts (Copyright (c) 2026 T3 Tools Inc., MIT — see NOTICE.md).
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2/client'

export interface CatalogModel {
  /** `providerID/modelID` — the DSH model id. */
  id: string
  providerID: string
  modelID: string
  name: string
  providerName: string
  image: boolean
  reasoning: boolean
  contextWindow: number | undefined
  maxOutput: number | undefined
  variants: string[]
  free: boolean
}

interface RawModel {
  id: string
  name?: string
  status?: string
  capabilities?: { reasoning?: boolean; input?: { image?: boolean } }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number }
  variants?: Record<string, unknown>
}
interface RawProvider {
  id: string
  name?: string
  models?: Record<string, RawModel>
}
interface RawProviderList {
  all?: RawProvider[]
  connected?: string[]
}

/** Turn a `provider.list` response into catalog entries (pure; tested directly). */
export function catalogFromProviderList(list: RawProviderList): CatalogModel[] {
  const connected = new Set(list.connected ?? [])
  const out: CatalogModel[] = []
  for (const provider of list.all ?? []) {
    if (!connected.has(provider.id)) continue
    for (const model of Object.values(provider.models ?? {})) {
      if (model.status === 'deprecated') continue
      const free = (model.cost?.input ?? 1) === 0 && (model.cost?.output ?? 1) === 0
      out.push({
        id: `${provider.id}/${model.id}`,
        providerID: provider.id,
        modelID: model.id,
        name: model.name || model.id,
        providerName: provider.name || provider.id,
        image: model.capabilities?.input?.image === true,
        reasoning: model.capabilities?.reasoning === true,
        contextWindow: positive(model.limit?.context),
        maxOutput: positive(model.limit?.output),
        variants: Object.keys(model.variants ?? {}),
        free,
      })
    }
  }
  // OpenCode's own provider first (its free models are why most people use this), then by provider and name.
  return out.sort((a, b) =>
    rank(a) - rank(b) || a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name))
}

function rank(model: CatalogModel): number {
  return model.providerID === 'opencode' ? 0 : 1
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export async function loadCatalog(client: OpencodeClient, signal?: AbortSignal): Promise<CatalogModel[]> {
  const result = await client.provider.list(undefined, signal ? { signal } : undefined)
  return catalogFromProviderList((result.data ?? {}) as RawProviderList)
}

/** Split `provider/model` (the model part may itself contain slashes). */
export function parseModelId(id: string): { providerID: string; modelID: string } | null {
  const trimmed = id.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return null
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) }
}
