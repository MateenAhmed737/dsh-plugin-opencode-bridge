/**
 * The shared `opencode serve` process, started from the user's own OpenCode
 * install with the user's full environment (HOME, XDG paths, auth.json,
 * config) — the same method T3 Code uses (packages/provider-opencode/src/server/
 * OpenCodeRuntime.ts, Copyright (c) 2026 T3 Tools Inc., MIT — see NOTICE.md).
 *
 * - one server per plugin instance, on 127.0.0.1 and a free port
 * - a fresh random OPENCODE_SERVER_PASSWORD on each start
 * - OPENCODE_CONFIG_CONTENT carries only the permission policy
 * - readiness = "server listening on" + /global/health healthy with version ≥ 1.14.19
 * - crash → restart with exponential backoff
 * - dispose / process exit → kill the whole process group (POSIX) or tree (Windows)
 * - or attach to a server the user already runs (serverUrl + serverPassword)
 */

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { BridgeError, Codes, describeError, redact } from './errors.ts'
import { configContent } from './permissions.ts'
import { compareSemver, parseSemver } from './semver.ts'

export const MINIMUM_OPENCODE_VERSION = '1.14.19'
const HOSTNAME = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 5_000
const OUTPUT_CAP = 16 * 1024
const RESTART_BASE_MS = 1_000
const RESTART_MAX_MS = 30_000
const RESTART_MAX_ATTEMPTS = 6

export const INSTALL_HINT =
  'Install OpenCode (https://opencode.ai/docs/#install), for example `npm i -g opencode-ai`, ' +
  'then sign in with `opencode auth login` if you use paid providers. ' +
  'If it is installed somewhere not on PATH, set the plugin\'s `binaryPath` setting.'

export interface RuntimeSettings {
  binaryPath: string
  serverUrl: string
  serverPassword: string
}

/** OpenCode 1.x serves the `/global/health` + `/session` API; 2.x serves `/api/*`. */
export type ApiGeneration = 'v1' | 'v2'

export interface ServerConnection {
  readonly url: string
  readonly version: string
  readonly api: ApiGeneration
  readonly external: boolean
  /** Server password (never logged). */
  readonly password: string | undefined
  /** Bumped on every (re)start or re-attach; lets callers notice a new server. */
  readonly serial: number
}

export interface Logger {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

export interface RuntimeDeps {
  settings(): RuntimeSettings
  /** Resolve a command name to an absolute path (DSH's ctx.subprocess). */
  resolveExecutable?(command: string, env: Record<string, string>): Promise<string>
  logger: Logger
  /** Environment for the child; defaults to the full process.env. */
  env?(): NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

interface Running {
  child: ChildProcess
  watchdog: ChildProcess | undefined
  /** Server-side pids besides the child (2.x reported pid, Windows shim descendants). */
  pids: number[]
  connection: ServerConnection
  password: string
}

export function basicAuth(password: string | undefined): Record<string, string> {
  if (!password) return {}
  return { Authorization: `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}` }
}

export function apiOf(version: string): ApiGeneration {
  return (parseSemver(version)?.major ?? 1) >= 2 ? 'v2' : 'v1'
}

async function getJson(url: string, password: string | undefined): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...basicAuth(password) },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  })
  const type = response.headers.get('content-type') ?? ''
  let json: unknown
  if (type.includes('application/json')) json = await response.json().catch(() => undefined)
  else await response.body?.cancel().catch(() => {})
  return { status: response.status, json }
}

/**
 * Ask a server for its version and enforce the minimum. `api` forces one
 * generation (a server we started); omitted, both are probed (attach mode),
 * like T3 Code's versionProbe.ts.
 */
export async function verifyServer(url: string, password: string | undefined, api?: ApiGeneration): Promise<{ version: string; api: ApiGeneration; pid?: number }> {
  const base = url.replace(/\/+$/, '')
  const order: ApiGeneration[] = api ? [api] : ['v2', 'v1']
  let lastStatus: number | undefined
  for (const generation of order) {
    let result: { status: number; json: unknown }
    try {
      result = await getJson(`${base}${generation === 'v2' ? '/api/info' : '/global/health'}`, password)
    } catch (error) {
      throw new BridgeError(`Could not reach the OpenCode server at ${url}: ${describeError(error)}`, Codes.TRANSPORT, undefined, { cause: error })
    }
    if (result.status === 401) {
      throw new BridgeError(`The OpenCode server at ${url} rejected the server password.`, Codes.AUTH, 401)
    }
    lastStatus = result.status
    const body = result.json as { version?: unknown; healthy?: unknown; pid?: unknown } | undefined
    if (result.status !== 200 || !body || typeof body.version !== 'string') continue
    if (generation === 'v1' && body.healthy !== true) continue
    if (generation === 'v2' && typeof body.pid !== 'number') continue
    assertVersion(body.version)
    return { version: body.version, api: generation, ...(typeof body.pid === 'number' ? { pid: body.pid } : {}) }
  }
  throw new BridgeError(
    `The server at ${url} did not answer like an OpenCode server${lastStatus ? ` (HTTP ${lastStatus})` : ''}. OpenCode v${MINIMUM_OPENCODE_VERSION} or newer is required.`,
    Codes.OPENCODE_VERSION,
  )
}

export function assertVersion(version: string): void {
  if (parseSemver(version) === null) {
    throw new BridgeError(`OpenCode reported an unreadable version "${version}". OpenCode v${MINIMUM_OPENCODE_VERSION} or newer is required.`, Codes.OPENCODE_VERSION)
  }
  if (compareSemver(version, MINIMUM_OPENCODE_VERSION) < 0) {
    throw new BridgeError(`OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer (\`opencode upgrade\` or \`npm i -g opencode-ai@latest\`).`, Codes.OPENCODE_VERSION)
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, HOSTNAME, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

export function parseListeningUrl(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = line.match(/server listening on\s+(https?:\/\/[^\s]+)/i)
    if (match?.[1]) return match[1]
  }
  return null
}

/** Kill extra pids (and their trees on Windows) that may have outlived their parent. */
export function killPids(pids: readonly number[], platform: NodeJS.Platform = process.platform): void {
  for (const pid of pids) {
    if (platform === 'win32') {
      try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* gone */ }
    } else {
      try { process.kill(pid, 0) } catch { continue }
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }
}

/** Kill a whole process group (POSIX) or process tree (Windows). Safe to call twice. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid
  if (pid === undefined) return
  if (platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch { /* already gone */ }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/**
 * Environment for `opencode serve`: the user's full environment plus a fresh
 * password. OpenCode 1.x reads OPENCODE_SERVER_PASSWORD and gets the permission
 * policy through OPENCODE_CONFIG_CONTENT. OpenCode 2.x reads OPENCODE_PASSWORD
 * (which overrides the 1.x variable, so that one is dropped) and receives the
 * policy as session permission rules instead, as T3 Code does.
 */
export function serverEnvironment(env: NodeJS.ProcessEnv, password: string, api: ApiGeneration): NodeJS.ProcessEnv {
  if (api === 'v2') {
    const { OPENCODE_SERVER_PASSWORD: _drop, ...rest } = env
    return { ...rest, OPENCODE_PASSWORD: password }
  }
  return {
    ...env,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: configContent(env.OPENCODE_CONFIG_CONTENT),
  }
}

function needsShell(file: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(file)
}

/**
 * npm installs `opencode.cmd` shims on Windows. Running a shim goes through
 * cmd.exe, and if the host is killed hard, cmd.exe dies while the real
 * opencode.exe it started lives on. When the shim just forwards to an .exe,
 * run that .exe directly instead.
 */
export function resolveWindowsShim(file: string, platform: NodeJS.Platform = process.platform): string {
  if (!needsShell(file, platform)) return file
  try {
    const text = readFileSync(file, 'utf8')
    const targets = [...text.matchAll(/"%(?:~)?dp0%\\?([^"]+?\.exe)"/gi)].map((m) => m[1]!)
    for (const relative of targets.reverse()) {
      const target = path.join(path.dirname(file), relative.replace(/[\\/]+/g, path.sep))
      if (!/[\\/]node\.exe$/i.test(target) && existsSync(target)) return target
    }
  } catch { /* keep the shim */ }
  return file
}

/** One command line for `shell: true` (Node joins args unquoted anyway); quotes paths like `C:\Users\A B\...\opencode.cmd`. */
function shellLine(file: string, args: readonly string[]): string {
  return [`"${file}"`, ...args].join(' ')
}

function spawnArgs(file: string, args: string[], platform: NodeJS.Platform): [string, string[], boolean] {
  return needsShell(file, platform) ? [shellLine(file, args), [], true] : [file, args, false]
}

/**
 * A small detached process that kills the server if the host dies without
 * running its exit handlers (killed from Task Manager, SIGKILL, crash).
 * Exits by itself once the server is gone. Skipped when this runtime cannot
 * run plain Node scripts (an Electron host without ELECTRON_RUN_AS_NODE).
 */
const WATCHDOG = `
const [parent, ...targets] = process.argv.slice(1).map(Number);
const { spawnSync } = require('node:child_process');
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } };
setInterval(() => {
  if (!targets.some(alive)) process.exit(0);
  if (alive(parent)) return;
  for (const pid of targets) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} } }
  }
  process.exit(0);
}, 1000);
`

/**
 * Windows: every process below `root` (cmd.exe shim → node launcher → opencode).
 * cmd.exe can die with the host while its children live on, so the watchdog
 * needs their pids up front. Best effort; empty on any failure.
 */
export function windowsDescendants(root: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
    { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve([])
      const children = new Map<number, number[]>()
      for (const line of stdout.split(/\r?\n/)) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number)
        if (!pid || parent === undefined || Number.isNaN(parent)) continue
        children.set(parent, [...(children.get(parent) ?? []), pid])
      }
      const out: number[] = []
      const queue = [root]
      while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
          if (!out.includes(child)) { out.push(child); queue.push(child) }
        }
      }
      resolve(out)
    })
  })
}

export function startWatchdog(targets: readonly number[], logger?: Logger): ChildProcess | undefined {
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) return undefined
  try {
    const watchdog = spawn(process.execPath, ['-e', WATCHDOG, String(process.pid), ...targets.map(String)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    })
    watchdog.on('error', () => {})
    watchdog.unref()
    return watchdog
  } catch (error) {
    logger?.debug('opencode-bridge: watchdog not started: %s', describeError(error))
    return undefined
  }
}

/**
 * Owns the shared server. `connect()` is single-flight and lazy: the first
 * model list or request starts the server.
 */
export class OpenCodeRuntime {
  private running: Running | undefined
  private starting: Promise<ServerConnection> | undefined
  private external: ServerConnection | undefined
  private externalKey = ''
  private disposed = false
  private serial = 0
  private restartAttempts = 0
  private restartTimer: NodeJS.Timeout | undefined
  private lastError: BridgeError | undefined
  private readonly platform: NodeJS.Platform
  private readonly exitHook = () => this.killNow()

  private readonly deps: RuntimeDeps

  constructor(deps: RuntimeDeps) {
    this.deps = deps
    this.platform = deps.platform ?? process.platform
    process.once('exit', this.exitHook)
  }

  /** Current connection, starting or attaching as needed. */
  async connect(): Promise<ServerConnection> {
    if (this.disposed) throw new BridgeError('The OpenCode bridge plugin was disposed.', Codes.TRANSPORT)
    const settings = this.deps.settings()
    const serverUrl = settings.serverUrl.trim()
    if (serverUrl) return this.attach(serverUrl, settings.serverPassword)
    if (this.running && this.running.child.exitCode === null && this.running.child.signalCode === null) {
      return this.running.connection
    }
    this.starting ??= this.start(settings).finally(() => { this.starting = undefined })
    return this.starting
  }

  /** Whether a server is currently up (no start is triggered). */
  get isRunning(): boolean {
    return !!this.running && this.running.child.exitCode === null
  }

  private async attach(url: string, password: string): Promise<ServerConnection> {
    const key = `${url}\u0000${password}`
    if (this.external && this.externalKey === key) return this.external
    const { version, api } = await verifyServer(url, password || undefined)
    this.externalKey = key
    this.external = { url, version, api, external: true, password: password || undefined, serial: ++this.serial }
    this.deps.logger.info('opencode-bridge: attached to OpenCode %s at %s', version, url)
    return this.external
  }

  private async resolveBinary(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string> {
    const command = binaryPath.trim() || 'opencode'
    if (!this.deps.resolveExecutable) return command
    try {
      const stringEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(env)) if (typeof v === 'string') stringEnv[k] = v
      return await this.deps.resolveExecutable(command, stringEnv)
    } catch (error) {
      throw new BridgeError(`OpenCode was not found ("${command}"). ${INSTALL_HINT}`, Codes.OPENCODE_MISSING, undefined, { cause: error })
    }
  }

  /** `opencode --version`, with a clear error when the binary is missing or too old. */
  private probeVersion(file: string, env: NodeJS.ProcessEnv): string {
    const [command, commandArgs, shell] = spawnArgs(file, ['--version'], this.platform)
    const result = spawnSync(command, commandArgs, {
      env,
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      shell,
    })
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new BridgeError(`OpenCode was not found ("${file}"). ${INSTALL_HINT}`, Codes.OPENCODE_MISSING)
      throw new BridgeError(`Could not run "${file} --version": ${result.error.message}`, Codes.OPENCODE_STARTUP)
    }
    const text = `${result.stdout ?? ''}`.trim()
    const version = text.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0]
    if (result.status !== 0 || !version) {
      throw new BridgeError(`"${file} --version" failed (exit ${result.status}). ${INSTALL_HINT}`, Codes.OPENCODE_STARTUP)
    }
    assertVersion(version)
    return version
  }

  private async start(settings: RuntimeSettings): Promise<ServerConnection> {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined }
    const env = { ...(this.deps.env?.() ?? process.env) }
    const file = resolveWindowsShim(await this.resolveBinary(settings.binaryPath, env), this.platform)
    const cliVersion = this.probeVersion(file, env)
    const api = apiOf(cliVersion)

    const port = await freePort()
    const password = randomBytes(24).toString('base64url')
    const childEnv = serverEnvironment(env, password, api)
    const args = ['serve', `--hostname=${HOSTNAME}`, `--port=${port}`]
    const [command, commandArgs, shell] = spawnArgs(file, args, this.platform)
    const child = spawn(command, commandArgs, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: this.platform !== 'win32',
      windowsHide: true,
      shell,
    })

    let stdout = ''
    let stderr = ''
    let ready = false
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        killTree(child, 'SIGKILL', this.platform)
        reject(new BridgeError(`Timed out after ${STARTUP_TIMEOUT_MS / 1000}s waiting for \`opencode serve\` to start.${tail(stderr, password)}`, Codes.OPENCODE_STARTUP))
      }, STARTUP_TIMEOUT_MS)
      const onStdout = (chunk: Buffer) => {
        if (ready) return
        stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_CAP)
        const found = parseListeningUrl(stdout)
        if (found) { cleanup(); resolve(found) }
      }
      const onStderr = (chunk: Buffer) => { if (!ready) stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_CAP) }
      const onError = (error: NodeJS.ErrnoException) => {
        cleanup()
        reject(error.code === 'ENOENT'
          ? new BridgeError(`OpenCode was not found ("${file}"). ${INSTALL_HINT}`, Codes.OPENCODE_MISSING)
          : new BridgeError(`Could not start \`opencode serve\`: ${error.message}`, Codes.OPENCODE_STARTUP))
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        const locked = /SQLITE_BUSY|database is locked/i.test(stderr)
        reject(new BridgeError(
          `\`opencode serve\` exited before it was ready (${code ?? signal}).${locked ? ' The OpenCode database is locked by another process; try again.' : ''}${tail(stderr, password)}`,
          Codes.OPENCODE_STARTUP,
        ))
      }
      const cleanup = () => {
        clearTimeout(timer)
        child.off('error', onError)
        child.off('exit', onExit)
      }
      // Keep draining both pipes for the life of the process so OpenCode never blocks on a full pipe.
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      child.on('error', onError)
      child.on('exit', onExit)
    })
    ready = true
    stdout = ''
    stderr = ''

    let version: string
    let serverPid: number | undefined
    try {
      const verified = await verifyServer(url, password, api)
      version = verified.version
      serverPid = verified.pid
    } catch (error) {
      killTree(child, 'SIGKILL', this.platform)
      throw error
    }
    const pids = [...new Set([child.pid, serverPid])].filter((pid): pid is number => typeof pid === 'number' && pid > 0)
    if (this.disposed) {
      killTree(child, 'SIGKILL', this.platform)
      killPids(pids, this.platform)
      throw new BridgeError('The OpenCode bridge plugin was disposed.', Codes.TRANSPORT)
    }

    const connection: ServerConnection = { url, version, api, external: false, password, serial: ++this.serial }
    const running: Running = { child, watchdog: undefined, pids, connection, password }
    this.running = running
    this.restartAttempts = 0
    this.lastError = undefined
    child.once('exit', (code, signal) => this.onExit(child, code, signal))
    this.deps.logger.info('opencode-bridge: started OpenCode %s on %s', version, url)
    if (shell && child.pid !== undefined) {
      // Listing processes takes a second or two on Windows; don't hold up the first request.
      void windowsDescendants(child.pid).then((descendants) => {
        const extra = descendants.filter((pid) => !running.pids.includes(pid))
        if (this.running !== running) {
          // Exited or disposed meanwhile: make sure nothing below the shim survives.
          killPids(extra, this.platform)
          return
        }
        running.pids.push(...extra)
        running.watchdog = startWatchdog(running.pids, this.deps.logger)
      })
    } else {
      running.watchdog = startWatchdog(running.pids, this.deps.logger)
    }
    return connection
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    const running = this.running
    if (running?.child !== child) return
    this.running = undefined
    // Make sure helpers it spawned (LSPs, MCP servers) go too.
    killTree(child, 'SIGKILL', this.platform)
    killPids(running.pids.filter((pid) => pid !== child.pid), this.platform)
    if (this.disposed) return
    this.deps.logger.warn('opencode-bridge: OpenCode server exited unexpectedly (%s); restarting', code ?? signal)
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer || this.restartAttempts >= RESTART_MAX_ATTEMPTS) return
    const delay = Math.min(RESTART_BASE_MS * 2 ** this.restartAttempts, RESTART_MAX_MS)
    this.restartAttempts++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.disposed || this.running || this.starting) return
      this.connect().catch((error: unknown) => {
        this.lastError = error instanceof BridgeError ? error : new BridgeError(describeError(error), Codes.OPENCODE_STARTUP)
        this.deps.logger.warn('opencode-bridge: restart failed: %s', this.lastError.message)
        this.scheduleRestart()
      })
    }, delay)
    this.restartTimer.unref?.()
  }

  /** Synchronous last-resort kill (process exit). */
  private killNow(): void {
    const running = this.running
    this.running = undefined
    if (running) { killTree(running.child, 'SIGKILL', this.platform); killPids(running.pids, this.platform) }
    try { running?.watchdog?.kill() } catch { /* gone */ }
  }

  /** Stop the server: SIGTERM the group, then SIGKILL after a grace period. */
  async dispose(): Promise<void> {
    this.disposed = true
    process.off('exit', this.exitHook)
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined }
    const starting = this.starting
    if (starting) await starting.catch(() => {})
    const running = this.running
    this.running = undefined
    this.external = undefined
    if (!running) return
    const { child } = running
    // The watchdog exits by itself once the server is gone; stop it now anyway.
    const stopWatchdog = () => {
      killPids(running.pids.filter((pid) => pid !== child.pid), this.platform)
      try { running.watchdog?.kill() } catch { /* gone */ }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      killTree(child, 'SIGKILL', this.platform)
      stopWatchdog()
      return
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    killTree(child, 'SIGTERM', this.platform)
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref?.())
    await Promise.race([exited, timer])
    // The group may hold helpers even after the leader exited.
    killTree(child, 'SIGKILL', this.platform)
    stopWatchdog()
  }

  get lastStartError(): BridgeError | undefined {
    return this.lastError
  }
}

function tail(text: string, password: string): string {
  const trimmed = redact(text.trim(), [password]).slice(-1500)
  return trimmed ? `\n${trimmed}` : ''
}
