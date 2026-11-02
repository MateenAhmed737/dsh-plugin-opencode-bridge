/**
 * Mapping DSH conversations onto OpenCode sessions.
 *
 * DSH sends the whole transcript on every request. OpenCode keeps history in
 * its own session. So per DSH conversation we remember the OpenCode session id
 * and a digest of the transcript OpenCode has already seen (user turns plus the
 * assistant text we streamed back). When the next request's history matches
 * that digest, only the new user turn is sent. Otherwise (DSH restart, edited
 * or forked history, compaction, a failed turn) a fresh OpenCode session is
 * created and seeded with the DSH transcript.
 */

import { createHash } from 'node:crypto'

/** Structural subset of DSH's content blocks that this plugin reads. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: ImageRef; offloaded?: true }
  | { type: 'file'; attachment: { attachmentId: string; name?: string; bytes?: number } }
  | { type: string; [key: string]: unknown }

export interface ImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export interface Msg {
  role: string
  content: readonly Block[] | string
}

/** One conversational message (system/developer/tool are not part of the OpenCode conversation). */
export interface Turn {
  role: 'user' | 'assistant'
  blocks: readonly Block[]
}

function blocksOf(message: Msg): readonly Block[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
}

export function conversation(messages: readonly Msg[]): Turn[] {
  const out: Turn[] = []
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') out.push({ role: message.role, blocks: blocksOf(message) })
  }
  return out
}

/** Split into prior history and the trailing user turn(s) that are new in this request. */
export function splitNewTurn(turns: readonly Turn[]): { history: Turn[]; newTurn: Turn[] } {
  let cut = turns.length
  while (cut > 0 && turns[cut - 1]!.role === 'user') cut--
  return { history: turns.slice(0, cut), newTurn: turns.slice(cut) }
}

/** Text of a block list as OpenCode saw it; images by id. Used for digests and rebuilds. */
export function turnText(turn: Turn, forDigest = false): string {
  const parts: string[] = []
  for (const block of turn.blocks) {
    switch (block.type) {
      case 'text':
        parts.push((block as { text: string }).text)
        break
      case 'image': {
        const ref = (block as { attachment: ImageRef }).attachment
        parts.push(forDigest ? `[image ${ref.attachmentId}]` : `[image${ref.name ? `: ${ref.name}` : ''}]`)
        break
      }
      case 'file': {
        const ref = (block as { attachment: { attachmentId: string; name?: string } }).attachment
        parts.push(forDigest ? `[file ${ref.attachmentId}]` : `[file${ref.name ? `: ${ref.name}` : ''}]`)
        break
      }
      default:
        // reasoning, tool blocks etc. are not part of what OpenCode was sent / what we compare.
        break
    }
  }
  return turn.role === 'assistant' ? parts.join('').trim() : parts.join('\n').trim()
}

export function digest(turns: readonly Turn[]): string {
  const hash = createHash('sha256')
  for (const turn of turns) {
    hash.update(turn.role)
    hash.update('\u0000')
    hash.update(turnText(turn, true))
    hash.update('\u0001')
  }
  return hash.digest('hex')
}

/** Preamble used when a session is rebuilt from the DSH transcript. */
export function rebuildPreamble(history: readonly Turn[]): string | null {
  if (history.length === 0) return null
  const lines = [
    'Earlier conversation (restored from DeepSeek Harness; treat it as the history of this chat and continue from it):',
    '<conversation>',
  ]
  for (const turn of history) {
    const text = turnText(turn)
    if (!text) continue
    lines.push(`<${turn.role}>`, text, `</${turn.role}>`)
  }
  lines.push('</conversation>', '', 'New message from the user follows.')
  return lines.join('\n')
}

export interface SessionBinding {
  sessionID: string
  directory: string
  /** Digest of the transcript OpenCode has seen, including our last reply. */
  digest: string
  /** Server generation the session lives on (a restart does not lose sessions, but an attach switch does). */
  serverKey: string
  /** `provider/model#variant` the session was last run with. */
  model: string
}

/** In-memory DSH-conversation → OpenCode-session bindings. */
export class SessionMap {
  private readonly bindings = new Map<string, SessionBinding>()
  private readonly locks = new Map<string, Promise<void>>()

  get(key: string): SessionBinding | undefined {
    return this.bindings.get(key)
  }

  set(key: string, binding: SessionBinding): void {
    this.bindings.set(key, binding)
  }

  delete(key: string): void {
    this.bindings.delete(key)
  }

  clear(): void {
    this.bindings.clear()
  }

  /** Serialize turns of one conversation (generator form). */
  async *lockGen<T>(key: string, run: () => AsyncGenerator<T, void>): AsyncGenerator<T, void> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chained = previous.then(() => current)
    this.locks.set(key, chained)
    await previous
    try {
      yield* run()
    } finally {
      release()
      if (this.locks.get(key) === chained) this.locks.delete(key)
    }
  }

  /** Serialize turns of one conversation. */
  async lock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chained = previous.then(() => current)
    this.locks.set(key, chained)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.locks.get(key) === chained) this.locks.delete(key)
    }
  }
}
