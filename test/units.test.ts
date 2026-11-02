import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sessionTitleText } from '../src/adapter.ts'
import { catalogFromModelList, classifyV2Error, permissionRulesV2 } from '../src/backend-v2.ts'
import { catalogFromProviderList, parseModelId } from '../src/catalog.ts'
import { classifyOpenCodeError, classifyThrown, Codes, readableProviderErrorMessage, redact } from '../src/errors.ts'
import { ALWAYS_ALLOWED, configContent, permissionConfig, permissionRules, RESTRICTED } from '../src/permissions.ts'
import { apiOf, assertVersion, basicAuth, parseListeningUrl, serverEnvironment } from '../src/runtime.ts'
import { compareSemver } from '../src/semver.ts'
import { conversation, digest, rebuildPreamble, splitNewTurn, type Msg } from '../src/transcript.ts'

describe('errors', () => {
  it('maps 429 / FreeUsageLimitError to RATE_LIMIT and keeps the message', () => {
    const message = 'FreeUsageLimitError: Rate limit exceeded. Please try again later.'
    assert.deepEqual(classifyOpenCodeError({ name: 'APIError', data: { message, statusCode: 429 } }), { message, code: Codes.RATE_LIMIT, status: 429 })
    assert.equal(classifyOpenCodeError({ name: 'UnknownError', data: { message } }).code, Codes.RATE_LIMIT)
    assert.equal(classifyV2Error({ type: 'APIError', message, status: 429 }).code, Codes.RATE_LIMIT)
    assert.equal(classifyV2Error({ type: 'APIError', message, status: 429 }).message, message)
  })

  it('maps 401/403 and FreeTierError to AUTH', () => {
    assert.equal(classifyOpenCodeError({ name: 'APIError', data: { message: 'no', statusCode: 401 } }).code, Codes.AUTH)
    assert.equal(classifyOpenCodeError({ name: 'APIError', data: { message: 'no', statusCode: 403 } }).code, Codes.AUTH)
    assert.equal(classifyOpenCodeError({ name: 'UnknownError', data: { message: 'FreeTierError: denied' } }).code, Codes.AUTH)
    assert.equal(classifyOpenCodeError({ name: 'ProviderAuthError', data: { message: 'login' } }).code, Codes.AUTH)
  })

  it('maps network and timeouts to TRANSPORT, 5xx to SERVER', () => {
    assert.equal(classifyOpenCodeError({ name: 'UnknownError', data: { message: 'fetch failed: ECONNRESET' } }).code, Codes.TRANSPORT)
    assert.equal(classifyOpenCodeError({ name: 'UnknownError', data: { message: 'Request timed out' } }).code, Codes.TRANSPORT)
    assert.equal(classifyOpenCodeError({ name: 'APIError', data: { message: 'x', statusCode: 502 } }).code, Codes.SERVER)
    assert.equal(classifyThrown(new TypeError('fetch failed')).code, Codes.TRANSPORT)
  })

  it('handles <none> messages like T3 Code', () => {
    assert.equal(readableProviderErrorMessage('<none>', 502, '<html><title>Bad Gateway</title></html>'), 'Bad Gateway (HTTP 502).')
    assert.equal(readableProviderErrorMessage('<none>', 500), 'The model provider failed the request (HTTP 500).')
    assert.equal(readableProviderErrorMessage('<none>'), 'The model provider failed the request and did not include an error message.')
    const failure = classifyOpenCodeError({ name: 'APIError', data: { message: '<none>', statusCode: 429 } })
    assert.equal(failure.code, Codes.RATE_LIMIT)
    assert.equal(failure.message, 'The model provider failed the request (HTTP 429).')
  })

  it('aborts and context overflow', () => {
    assert.equal(classifyOpenCodeError({ name: 'MessageAbortedError', data: { message: 'Aborted' } }).code, Codes.ABORTED)
    assert.equal(classifyOpenCodeError({ name: 'ContextOverflowError', data: { message: 'too long' } }).code, Codes.CONTEXT)
  })

  it('redacts secrets', () => {
    assert.equal(redact('pw=hunter22 ok', ['hunter22']), 'pw=[redacted] ok')
  })
})

describe('permissions', () => {
  it('never configures deny', () => {
    assert.ok(permissionRules().every((rule) => rule.action !== 'deny'))
    assert.ok(permissionRulesV2().every((rule) => rule.effect !== 'deny'))
    assert.ok(!JSON.stringify(permissionConfig()).includes('deny'))
  })

  it('asks for every restricted tool and allows the safe ones (last match wins)', () => {
    const lastMatch = (permission: string) => [...permissionRules()].reverse().find((r) => (r.permission === permission || r.permission === '*') && r.pattern === '*')!.action
    for (const p of RESTRICTED) assert.equal(lastMatch(p), 'ask', p)
    for (const p of ALWAYS_ALLOWED) assert.equal(lastMatch(p), 'allow', p)
    assert.equal(lastMatch('something-new'), 'ask')
    const v2 = permissionRulesV2()
    const last2 = (action: string) => [...v2].reverse().find((r) => (r.action === action || r.action === '*') && r.resource === '*')!.effect
    assert.equal(last2('shell'), 'ask')
    assert.equal(last2('edit'), 'ask')
    assert.equal(last2('read'), 'allow')
  })

  it('config content keeps user config and overrides only permission', () => {
    const merged = JSON.parse(configContent(JSON.stringify({ theme: 'x', permission: { '*': 'allow' } })))
    assert.equal(merged.theme, 'x')
    assert.equal(merged.permission['*'], 'ask')
    assert.equal(merged.permission.bash, 'ask')
    assert.deepEqual(JSON.parse(configContent('not json')), { permission: permissionConfig() })
  })
})

describe('runtime helpers', () => {
  it('parses the listening line', () => {
    assert.equal(parseListeningUrl('foo\nopencode server listening on http://127.0.0.1:4096\n'), 'http://127.0.0.1:4096')
    assert.equal(parseListeningUrl('nothing'), null)
  })

  it('enforces the minimum version and picks the API generation', () => {
    assert.throws(() => assertVersion('1.14.18'), /too old/)
    assert.doesNotThrow(() => assertVersion('1.14.19'))
    assert.throws(() => assertVersion('garbage'), /unreadable/)
    assert.equal(apiOf('1.15.0'), 'v1')
    assert.equal(apiOf('2.2.5'), 'v2')
    assert.ok(compareSemver('2.0.0-beta.1', '2.0.0') < 0)
  })

  it('builds the server environment from the full user environment', () => {
    const base = { HOME: '/home/u', PATH: '/bin', OPENCODE_SERVER_PASSWORD: 'old' }
    const v1 = serverEnvironment(base, 'pw', 'v1')
    assert.equal(v1.HOME, '/home/u')
    assert.equal(v1.OPENCODE_SERVER_PASSWORD, 'pw')
    assert.ok(JSON.parse(v1.OPENCODE_CONFIG_CONTENT!).permission)
    const v2 = serverEnvironment(base, 'pw', 'v2')
    assert.equal(v2.OPENCODE_PASSWORD, 'pw')
    assert.equal(v2.OPENCODE_SERVER_PASSWORD, undefined)
    assert.equal(v2.PATH, '/bin')
  })

  it('basic auth header', () => {
    assert.deepEqual(basicAuth(undefined), {})
    assert.equal(basicAuth('pw').Authorization, `Basic ${Buffer.from('opencode:pw').toString('base64')}`)
  })
})

describe('catalog', () => {
  it('1.x: connected providers only, no deprecated, OpenCode first', () => {
    const models = catalogFromProviderList({
      all: [
        { id: 'anthropic', name: 'Anthropic', models: { a: { id: 'a', name: 'A', cost: { input: 1, output: 1 } } } },
        { id: 'opencode', name: 'OpenCode Zen', models: { free: { id: 'free', name: 'Free', cost: { input: 0, output: 0 }, capabilities: { input: { image: true } }, variants: { high: {} } }, old: { id: 'old', status: 'deprecated' } } },
        { id: 'x', name: 'X', models: { m: { id: 'm' } } },
      ],
      connected: ['anthropic', 'opencode'],
    })
    assert.deepEqual(models.map((m) => m.id), ['opencode/free', 'anthropic/a'])
    assert.equal(models[0]!.free, true)
    assert.equal(models[0]!.image, true)
    assert.deepEqual(models[0]!.variants, ['high'])
    assert.equal(models[1]!.free, false)
  })

  it('2.x: model list plus provider names', () => {
    const models = catalogFromModelList([
      { id: 'claude-x', providerID: 'anthropic', name: 'Claude X', cost: [{ input: 3, output: 15 }] },
      { id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', cost: [{ input: 0, output: 0 }], capabilities: { input: ['text', 'image'] }, variants: [{ id: 'high' }] },
      { id: 'old', providerID: 'opencode', status: 'deprecated' },
    ], new Map([['opencode', 'OpenCode Zen']]))
    assert.deepEqual(models.map((m) => m.id), ['opencode/big-pickle', 'anthropic/claude-x'])
    assert.equal(models[0]!.providerName, 'OpenCode Zen')
    assert.equal(models[0]!.image, true)
    assert.equal(models[0]!.free, true)
  })

  it('parses provider/model ids, keeping slashes in the model part', () => {
    assert.deepEqual(parseModelId('openrouter/meta/llama'), { providerID: 'openrouter', modelID: 'meta/llama' })
    assert.equal(parseModelId('nomodel'), null)
    assert.equal(parseModelId('/x'), null)
  })
})

describe('transcript', () => {
  const messages: Msg[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Hello' }, { type: 'text', text: ' there' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }, { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] },
  ]

  it('splits the new user turn from history', () => {
    const { history, newTurn } = splitNewTurn(conversation(messages))
    assert.equal(history.length, 2)
    assert.equal(newTurn.length, 1)
  })

  it('digest ignores reasoning and block boundaries but not text', () => {
    const a = conversation(messages.slice(0, 3))
    const b = conversation([...messages.slice(0, 2), { role: 'assistant', content: 'Hello there' }])
    const c = conversation([...messages.slice(0, 2), { role: 'assistant', content: 'Hello  there!' }])
    assert.equal(digest(a), digest(b))
    assert.notEqual(digest(a), digest(c))
  })

  it('rebuild preamble carries the history', () => {
    const { history } = splitNewTurn(conversation(messages))
    const text = rebuildPreamble(history)!
    assert.match(text, /<user>\nhi\n<\/user>/)
    assert.match(text, /<assistant>\nHello there\n<\/assistant>/)
    assert.equal(rebuildPreamble([]), null)
  })

  it('local session titles read the title frame', () => {
    const frame = `Generate the session title from this JSON array of human messages:${JSON.stringify([{ text: '  Fix   the build ' }])}`
    assert.equal(sessionTitleText([{ role: 'user', content: frame }]), 'Fix the build')
    assert.equal(sessionTitleText([{ role: 'user', content: 'plain question' }]), 'plain question')
  })
})
