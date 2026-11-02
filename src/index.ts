/**
 * dsh-plugin-opencode-bridge — a DeepSeek Harness LLM provider that serves
 * every request through the user's own installed OpenCode, the way T3 Code
 * does: one shared `opencode serve` on 127.0.0.1 started with the user's full
 * environment (their login and config), driven only through OpenCode's
 * official clients.
 *
 * Plugin shape (inject, registerAdapter, registerConfigurableProviders,
 * Schemastery Config, cordis.patch.yml) follows @quonaro/dsh-plugin-opencode.
 *
 * @module dsh-plugin-opencode-bridge
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { OpenCodeBridgeAdapter, PROVIDER_ID, PROVIDER_NAME } from './adapter.ts'
import { OpenCodeRuntime } from './runtime.ts'

/** Plugin name; must match package.json and the cordis.patch.yml row. */
export const name = 'dsh-plugin-opencode-bridge'

/** `llm` registers the provider; `subprocess` resolves the opencode executable the way DSH does. */
export const inject = ['llm', 'subprocess']

export interface Config {
  /** Path or PATH-resolved name of your opencode executable. */
  binaryPath: Volatile<string>
  /** Attach to an `opencode serve` you already run (e.g. http://127.0.0.1:4096). Empty = start one. */
  serverUrl: Volatile<string>
  /** Password of that server (OPENCODE_SERVER_PASSWORD / OPENCODE_PASSWORD). Never logged. */
  serverPassword: Volatile<string>
  /** Working directory for OpenCode sessions. Empty = the DSH conversation's working directory. */
  cwd: Volatile<string>
  /** Allow bash, edit, webfetch, websearch, codesearch, external_directory and doom_loop without asking. */
  allowRestrictedTools: Volatile<boolean>
  /** Ask in DSH's approval prompt before allowing a restricted tool. Off = reject them. */
  askForApproval: Volatile<boolean>
  /** Upper bound for one model turn, in milliseconds (0 = no limit). */
  requestTimeoutMs: Volatile<number>
  /** How often the model list is re-read from OpenCode, in seconds. */
  modelRefreshSeconds: Volatile<number>
  /** Show OpenCode's tool activity as short lines in the reply. */
  showToolActivity: Volatile<boolean>
  /** Make DSH session titles locally instead of spending a model request on them. */
  localSessionTitles: Volatile<boolean>
}

export const Config = Schema.object({
  binaryPath: Schema.string().default('opencode').description('Path or name of your opencode executable.').volatile(),
  serverUrl: Schema.string().default('').description('Attach to an existing `opencode serve` instead of starting one.').volatile(),
  serverPassword: Schema.string().role('secret').default('').description('Password of the server in `serverUrl`.').volatile(),
  cwd: Schema.string().default('').description('Working directory for OpenCode. Empty = the conversation\'s working directory.').volatile(),
  allowRestrictedTools: Schema.boolean().default(false).description('Allow bash/edit/web tools without asking.').volatile(),
  askForApproval: Schema.boolean().default(true).description('Ask in DSH before allowing a restricted tool; off = reject.').volatile(),
  requestTimeoutMs: Schema.number().min(0).default(1_800_000).description('Upper bound for one turn (ms, 0 = none).').volatile(),
  modelRefreshSeconds: Schema.number().min(10).default(300).description('How often to re-read the model list (s).').volatile(),
  showToolActivity: Schema.boolean().default(true).description('Show OpenCode tool activity in replies.').volatile(),
  localSessionTitles: Schema.boolean().default(true).description('Make session titles locally (saves free-tier requests).').volatile(),
})

interface LoggerLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

function loggerOf(ctx: Context): LoggerLike {
  const logger = (ctx as unknown as { logger?: Partial<LoggerLike> }).logger
  const noop = () => {}
  return {
    debug: logger?.debug?.bind(logger) ?? noop,
    info: logger?.info?.bind(logger) ?? noop,
    warn: logger?.warn?.bind(logger) ?? noop,
  }
}

interface LlmLike {
  registerAdapter(providers: string[], adapter: unknown): () => void
  registerConfigurableProviders(entries: readonly { provider: string; displayName: string; settingsNs: string; settingsPath: readonly string[] }[]): () => void
}
interface SubprocessLike {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
}

export function apply(ctx: Context, config: Config): void {
  const logger = loggerOf(ctx)
  const host = ctx as unknown as { llm: LlmLike; subprocess?: SubprocessLike; get(name: string): unknown; emit?(...args: unknown[]): void }

  const runtime = new OpenCodeRuntime({
    settings: () => ({
      binaryPath: config.binaryPath.get(),
      serverUrl: config.serverUrl.get(),
      serverPassword: config.serverPassword.get(),
    }),
    ...(host.subprocess ? { resolveExecutable: (command: string, env: Record<string, string>) => host.subprocess!.resolveExecutable(command, env) } : {}),
    logger,
  })

  const adapter = new OpenCodeBridgeAdapter({
    ctx: host,
    runtime,
    logger,
    settings: () => ({
      cwd: config.cwd.get(),
      allowRestrictedTools: config.allowRestrictedTools.get(),
      askForApproval: config.askForApproval.get(),
      requestTimeoutMs: config.requestTimeoutMs.get(),
      modelRefreshSeconds: config.modelRefreshSeconds.get(),
      showToolActivity: config.showToolActivity.get(),
      localSessionTitles: config.localSessionTitles.get(),
    }),
    onModelsChanged: () => {
      try { host.emit?.('llm/adapters-updated') } catch { /* observers are optional */ }
    },
  })

  host.llm.registerAdapter([PROVIDER_ID], adapter)
  host.llm.registerConfigurableProviders([{
    provider: PROVIDER_ID,
    displayName: PROVIDER_NAME,
    settingsNs: name,
    settingsPath: [],
  }])

  // Periodic catalog refresh, only while a server is up (never starts one by itself).
  const refresh = setInterval(() => {
    if (!runtime.isRunning && !config.serverUrl.get().trim()) return
    adapter.models(true).catch(() => {})
  }, Math.max(10, config.modelRefreshSeconds.get()) * 1000)
  refresh.unref?.()

  ctx.effect(() => () => {
    clearInterval(refresh)
    adapter.dispose()
    void runtime.dispose()
  })
}

export { OpenCodeBridgeAdapter } from './adapter.ts'
export { OpenCodeRuntime } from './runtime.ts'
