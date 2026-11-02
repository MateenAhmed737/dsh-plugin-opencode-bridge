import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenCodeRuntime, type RuntimeSettings } from '../src/runtime.ts'

const FAKE_SCRIPT = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url))

/** The fake executable: the script itself (shebang) on POSIX, a .cmd shim on Windows, like npm's. */
export const FAKE_OPENCODE = process.platform === 'win32' ? windowsShim() : FAKE_SCRIPT

function windowsShim(): string {
  // A directory with a space, like C:\Users\First Last\AppData\Roaming\npm.
  const file = join(mkdtempSync(join(tmpdir(), 'oc local ')), 'opencode.cmd')
  writeFileSync(file, `@"${process.execPath}" "${FAKE_SCRIPT}" %*\r\n`)
  return file
}

export const quietLogger = { debug() {}, info() {}, warn() {} }

export interface LogEntry {
  kind: 'start' | 'request'
  [key: string]: any
}

export function tempLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'oc-local-')), 'fake.jsonl')
}

export function readLog(file: string): LogEntry[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry)
  } catch {
    return []
  }
}

export function makeRuntime(options: {
  version?: string
  log: string
  settings?: Partial<RuntimeSettings>
  env?: Record<string, string>
}): OpenCodeRuntime {
  const settings: RuntimeSettings = { binaryPath: FAKE_OPENCODE, serverUrl: '', serverPassword: '', ...options.settings }
  return new OpenCodeRuntime({
    settings: () => settings,
    logger: quietLogger,
    env: () => ({
      ...process.env,
      FAKE_OC_VERSION: options.version ?? '1.15.0',
      FAKE_OC_LOG: options.log,
      ...options.env,
    }),
  })
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
