import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { OpenCodeLocalAdapter, type AdapterSettings, type GenerateRequest } from '../src/adapter.ts'
import { Codes } from '../src/errors.ts'
import type { OpenCodeRuntime } from '../src/runtime.ts'
import type { Chunk } from '../src/turn.ts'
import { makeRuntime, quietLogger, readLog, tempLog } from './helpers.ts'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))

interface Harness {
  adapter: OpenCodeLocalAdapter
  settings: AdapterSettings
  services: Record<string, unknown>
}

function harness(runtime: OpenCodeRuntime): Harness {
  const settings: AdapterSettings = {
    cwd: process.cwd(),
    allowRestrictedTools: false,
    askForApproval: true,
    requestTimeoutMs: 60_000,
    modelRefreshSeconds: 300,
    showToolActivity: true,
    localSessionTitles: true,
  }
  const services: Record<string, unknown> = {
    agents: { get: (id: string) => ({ id, session: { id } }) },
    attachments: {
      readImageRequest: async () => ({ data: PNG, mediaType: 'image/png' }),
    },
  }
  const adapter = new OpenCodeLocalAdapter({
    ctx: { get: (name: string) => services[name] },
    runtime,
    logger: quietLogger,
    settings: () => settings,
  })
  return { adapter, settings, services }
}

async function run(adapter: OpenCodeLocalAdapter, request: Partial<GenerateRequest> & { messages: GenerateRequest['messages'] }) {
  const chunks: Chunk[] = []
  for await (const chunk of adapter.stream({ provider: 'opencode-local', model: 'opencode/big-pickle', ...request })) chunks.push(chunk)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  const finish = chunks.findLast((c) => c.type === 'finish') as Extract<Chunk, { type: 'finish' }>
  const usage = chunks.find((c) => c.type === 'usage') as Extract<Chunk, { type: 'usage' }> | undefined
  return { chunks, text, reasoning, finish: finish.reason, usage: usage?.usage }
}

const user = (text: string) => ({ role: 'user', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

for (const version of ['1.15.0', '2.2.5']) {
  const v2 = version.startsWith('2')
  const prompts = (log: string) => readLog(log).filter((e) => e.kind === 'request' && /\/prompt(_async)?$/.test(e.path))
  const creates = (log: string) => readLog(log).filter((e) => e.kind === 'request' && e.method === 'POST' && /\/session$/.test(e.path))
  const promptText = (entry: any): string => v2 ? entry.body.text : entry.body.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')

  describe(`adapter against fake OpenCode ${version}`, () => {
    const log = tempLog()
    const runtime = makeRuntime({ version, log })
    const { adapter, settings, services } = harness(runtime)

    before(async () => { await runtime.connect() })
    after(async () => {
      adapter.dispose()
      await runtime.dispose()
    })

    it('lists the server\'s models with provider/model ids, free models first', async () => {
      const models = await adapter.listModels('opencode-local')
      assert.deepEqual(models.map((m) => m.id), ['opencode/big-pickle', 'anthropic/claude-x'])
      assert.equal(models[0]!.name, 'Big Pickle (free)')
      assert.deepEqual(models[0]!.inputModalities, ['text', 'image'])
      const resolved = await adapter.resolveModel('opencode-local', 'opencode/big-pickle')
      assert.equal(resolved.context?.contextWindow, 200000)
      assert.ok(resolved.reasoning?.efforts.some((e) => e.id === 'high'))
    })

    it('keeps multi-turn context in one OpenCode session and sends only the new turn', async () => {
      const first = await run(adapter, { sessionId: 'conv-1', messages: [{ role: 'system', content: 'sys' }, user('hello')] })
      assert.equal(first.finish.kind, 'stop')
      assert.equal(first.text, 'Echo(1): hello')
      assert.equal(first.reasoning, 'thinking')
      assert.ok(first.usage && first.usage.inputTokens === 11)

      const second = await run(adapter, { sessionId: 'conv-1', messages: [{ role: 'system', content: 'sys' }, user('hello'), assistant(first.text), user('again')] })
      assert.equal(second.text, 'Echo(2): again', 'same OpenCode session, second turn')
      assert.equal(creates(log).length, 1)
      assert.equal(promptText(prompts(log).at(-1)), 'again')
    })

    it('rebuilds a fresh session from the transcript when the history changed', async () => {
      const result = await run(adapter, { sessionId: 'conv-1', messages: [user('hello'), assistant('an edited reply'), user('third')] })
      assert.equal(result.text, 'Echo(1): third')
      const sent = promptText(prompts(log).at(-1))
      assert.match(sent, /<conversation>/)
      assert.match(sent, /an edited reply/)
      assert.ok(sent.endsWith('third'))
    })

    it('rejects a restricted tool and the model receives the rejection message', async () => {
      const result = await run(adapter, { sessionId: 'conv-bash', messages: [user('run it [[bash]]')] })
      assert.equal(result.finish.kind, 'stop')
      assert.match(result.text, /🚫 Rejected (bash|shell): ls -la/)
      assert.match(result.text, /permission reject: Permission "(bash|shell)" was not granted/)
      assert.equal(result.reasoning, 'I should run the command.', 'text after a tool call stays text')
      const reply = readLog(log).find((e) => e.kind === 'request' && /\/reply$/.test(e.path))!
      assert.equal(v2 ? reply.body.decision : reply.body.reply, 'reject')
      assert.match(reply.body.message, /was not granted/)
    })

    it('asks DSH\'s approval prompt and allows once when the user approves', async () => {
      const asked: unknown[] = []
      services.approval = { request: async (req: unknown) => { asked.push(req); return 'allowed-once' } }
      try {
        const result = await run(adapter, { sessionId: 'conv-approve', messages: [user('run it [[bash]]')] })
        assert.match(result.text, /permission once/)
        assert.equal(asked.length, 1)
        assert.match((asked[0] as { toolName: string }).toolName, /^opencode:(bash|shell)$/)
      } finally {
        delete services.approval
      }
    })

    it('allowRestrictedTools allows without asking', async () => {
      settings.allowRestrictedTools = true
      try {
        const result = await run(adapter, { sessionId: 'conv-allow', messages: [user('[[bash]]')] })
        assert.match(result.text, /permission once/)
      } finally {
        settings.allowRestrictedTools = false
      }
    })

    it('maps a 429 FreeUsageLimitError to RATE_LIMIT with OpenCode\'s message', async () => {
      const result = await run(adapter, { sessionId: 'conv-429', messages: [user('[[ratelimit]]')] })
      assert.equal(result.finish.kind, 'error')
      const failure = (result.finish as { failure: { code: string; message: string } }).failure
      assert.equal(failure.code, Codes.RATE_LIMIT)
      assert.equal(failure.message, 'FreeUsageLimitError: Rate limit exceeded. Please try again later.')
      assert.deepEqual(adapter.providerRetryPolicy('opencode-local').retryableCodes, ['TRANSPORT'])
    })

    it('aborts a running turn and interrupts OpenCode', async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 300)
      const result = await run(adapter, { sessionId: 'conv-abort', signal: controller.signal, messages: [user('[[slow]]')] })
      assert.equal(result.finish.kind, 'aborted')
      assert.match(result.text, /tick 0/)
      const path = v2 ? /\/interrupt$/ : /\/abort$/
      assert.ok(readLog(log).some((e) => e.kind === 'request' && path.test(e.path)))
    })

    it('sends images as data URLs', async () => {
      const result = await run(adapter, {
        sessionId: 'conv-image',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', attachment: { attachmentId: 'img1', mediaType: 'image/png', bytes: PNG.byteLength, width: 1, height: 1, name: 'dot.png' } }] }],
      })
      assert.match(result.text, /\+1 file\(s\) data:image\/png;base64/)
    })

    it('declines OpenCode questions and continues', async () => {
      const result = await run(adapter, { sessionId: 'conv-q', messages: [user('pick [[question]]')] })
      assert.equal(result.finish.kind, 'stop')
      assert.match(result.text, /Echo\(1\)/)
    })

    it('uses a throwaway session for requests without a DSH session and removes it', async () => {
      const result = await run(adapter, { purpose: 'compaction', system: 'Summarize.', messages: [user('summarize please')] })
      assert.equal(result.finish.kind, 'stop')
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.ok(readLog(log).some((e) => e.kind === 'request' && e.method === 'DELETE' && /\/session\/[^/]+$/.test(e.path)))
    })

    it('answers session-title requests locally', async () => {
      const before = readLog(log).length
      const result = await run(adapter, { purpose: 'session-title', messages: [user('Fix the flaky login test please')] })
      assert.equal(result.text, 'Fix the flaky login test please')
      assert.equal(readLog(log).length, before)
    })

    it('rejects ids that are not provider/model', async () => {
      const result = await run(adapter, { model: 'nonsense', sessionId: 'x', messages: [user('hi')] })
      assert.equal(result.finish.kind, 'error')
    })
  })
}
