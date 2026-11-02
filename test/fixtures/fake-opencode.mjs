#!/usr/bin/env node
/**
 * A fake `opencode` executable for tests. It speaks just enough of the
 * OpenCode 1.x (`/global/health`, `/session`, `/event`) or 2.x (`/api/*`) HTTP
 * API for the plugin, chosen by FAKE_OC_VERSION.
 *
 *   fake-opencode --version
 *   fake-opencode serve --hostname=127.0.0.1 --port=N
 *
 * Environment:
 *   FAKE_OC_VERSION   version to report (default 1.15.0; 2.x switches API)
 *   FAKE_OC_LOG       JSONL file that records start info and requests
 *   FAKE_OC_EXIT_MS   exit(3) this many ms after start (crash simulation)
 *   FAKE_OC_NO_READY  never print the "listening" line
 *
 * Prompt keywords pick a scenario: [[bash]] permission ask, [[ratelimit]] a
 * 429 FreeUsageLimitError, [[slow]] streams until aborted, [[question]] asks a
 * question; anything else echoes the last line with the session's turn count.
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import http from 'node:http'

const VERSION = process.env.FAKE_OC_VERSION || '1.15.0'
const V2 = Number(VERSION.split('.')[0]) >= 2
const LOG = process.env.FAKE_OC_LOG

function log(entry) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
}

const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}
if (args[0] !== 'serve') {
  process.stderr.write('usage: fake-opencode serve\n')
  process.exit(2)
}

const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const hostname = arg('hostname') || '127.0.0.1'
const port = Number(arg('port') || 0)
const password = V2 ? process.env.OPENCODE_PASSWORD : process.env.OPENCODE_SERVER_PASSWORD

// A helper child in the same process group, like an LSP or MCP server would be.
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

log({
  kind: 'start',
  pid: process.pid,
  helperPid: helper.pid,
  version: VERSION,
  argv: args,
  hasServerPassword: !!process.env.OPENCODE_SERVER_PASSWORD,
  hasPassword: !!process.env.OPENCODE_PASSWORD,
  configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null,
  marker: process.env.FAKE_OC_MARKER ?? null,
})

if (process.env.FAKE_OC_EXIT_MS) setTimeout(() => process.exit(3), Number(process.env.FAKE_OC_EXIT_MS))

// ---------------------------------------------------------------------------

const clients = new Set()
const sessions = new Map()
const pendingPermissions = new Map()
let seq = 0
const id = (prefix) => `${prefix}_${++seq}`

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) res.write(line)
}
const emit1 = (type, properties) => broadcast({ type, properties })
const emit2 = (type, data) => broadcast({ id: id('evt'), created: Date.now(), type, data })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : undefined) } catch { resolve(body) }
    })
  })
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
function noContent(res) {
  res.writeHead(204)
  res.end()
}

function authorized(req) {
  if (!password) return true
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  return req.headers.authorization === expected
}

function promptText(body) {
  if (V2) return String(body?.text ?? '')
  return (body?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
}
function promptFiles(body) {
  if (V2) return (body?.files ?? []).map((f) => ({ url: f.uri, name: f.name }))
  return (body?.parts ?? []).filter((p) => p.type === 'file').map((p) => ({ url: p.url, name: p.filename, mime: p.mime }))
}

// ---- turn scenarios (generation-neutral) ----------------------------------

async function runTurn(session, text, files) {
  session.turns++
  session.aborted = false
  const t = sessionApi(session)
  t.start()
  const lastLine = text.trim().split('\n').filter(Boolean).pop() ?? ''

  if (text.includes('[[ratelimit]]')) {
    t.fail({ name: 'APIError', message: 'FreeUsageLimitError: Rate limit exceeded. Please try again later.', status: 429 })
    return
  }
  if (text.includes('[[slow]]')) {
    const part = t.textPart()
    for (let i = 0; i < 200 && !session.aborted; i++) {
      part.delta(`tick ${i} `)
      await sleep(50)
    }
    if (session.aborted) { part.end(); t.interrupted(); return }
    part.end()
    t.done('stop')
    return
  }
  if (text.includes('[[bash]]')) {
    // Reasoning before the tool call, text after it (both ordinal 0 in 2.x).
    const before = t.reasoningPart()
    before.delta('I should run the command.')
    before.end()
    const requestID = id('per')
    const reply = new Promise((resolve) => pendingPermissions.set(requestID, resolve))
    t.permission(requestID, 'ls -la')
    const answer = await reply
    const part = t.textPart()
    part.delta(`permission ${answer.reply}`)
    if (answer.message) part.delta(`: ${answer.message}`)
    part.end()
    t.done('stop')
    return
  }
  if (text.includes('[[question]]')) {
    t.question(id('que'))
    await sleep(100)
  }
  const reasoning = t.reasoningPart()
  reasoning.delta('thinking')
  reasoning.end()
  const part = t.textPart()
  const reply = `Echo(${session.turns}): ${lastLine}${files.length ? ` +${files.length} file(s) ${files.map((f) => f.url.slice(0, 22)).join(',')}` : ''}`
  part.delta(reply.slice(0, 6))
  await sleep(5)
  part.delta(reply.slice(6))
  part.end()
  t.done('stop')
}

function sessionApi(session) {
  const sessionID = session.id
  const messageID = id('msg')
  // Like OpenCode 2: ordinals count per kind within an assistant message.
  const ordinals = { text: 0, reasoning: 0 }
  if (!V2) {
    return {
      start() {
        emit1('message.updated', { info: { id: id('msg'), sessionID, role: 'user' } })
        emit1('session.status', { sessionID, status: { type: 'busy' } })
        emit1('message.updated', { info: { id: messageID, sessionID, role: 'assistant', time: { created: Date.now() } } })
      },
      textPart() { return partV1('text') },
      reasoningPart() { return partV1('reasoning') },
      permission(requestID, command) {
        emit1('permission.asked', { id: requestID, sessionID, permission: 'bash', patterns: [command], metadata: { command }, always: [] })
      },
      question(requestID) {
        emit1('question.asked', { id: requestID, sessionID, questions: [{ question: 'Which?', options: [] }] })
      },
      fail(error) {
        emit1('message.updated', { info: { id: messageID, sessionID, role: 'assistant', error: { name: error.name, data: { message: error.message, statusCode: error.status } }, time: { created: Date.now(), completed: Date.now() } } })
        emit1('session.error', { sessionID, error: { name: error.name, data: { message: error.message, statusCode: error.status } } })
        emit1('session.status', { sessionID, status: { type: 'idle' } })
      },
      interrupted() {
        emit1('message.updated', { info: { id: messageID, sessionID, role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } })
        emit1('session.status', { sessionID, status: { type: 'idle' } })
      },
      done(finish) {
        emit1('message.part.updated', { part: { id: id('prt'), sessionID, messageID, type: 'step-finish', reason: finish, tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 0 } }, cost: 0 } })
        emit1('message.updated', { info: { id: messageID, sessionID, role: 'assistant', finish, time: { created: Date.now(), completed: Date.now() } } })
        emit1('session.status', { sessionID, status: { type: 'idle' } })
        emit1('session.idle', { sessionID })
      },
    }
    function partV1(type) {
      const partID = id('prt')
      let text = ''
      emit1('message.part.updated', { part: { id: partID, sessionID, messageID, type, text: '', time: { start: Date.now() } } })
      return {
        delta(d) { text += d; emit1('message.part.delta', { sessionID, messageID, partID, field: 'text', delta: d }) },
        end() { emit1('message.part.updated', { part: { id: partID, sessionID, messageID, type, text, time: { start: Date.now(), end: Date.now() } } }) },
      }
    }
  }
  return {
    start() {
      emit2('session.execution.started', { sessionID })
    },
    textPart() { return partV2('text') },
    reasoningPart() { return partV2('reasoning') },
    permission(requestID, command) {
      emit2('permission.asked', { id: requestID, sessionID, action: 'shell', resources: [command], metadata: { command } })
    },
    question(formID) {
      emit2('form.created', { form: { id: formID, sessionID, fields: [] } })
    },
    fail(error) {
      emit2('session.step.failed', { sessionID, assistantMessageID: messageID, error: { type: error.name, message: error.message, status: error.status } })
      emit2('session.execution.failed', { sessionID, error: { type: error.name, message: error.message, status: error.status } })
    },
    interrupted() {
      emit2('session.execution.interrupted', { sessionID, reason: 'user' })
    },
    done(finish) {
      emit2('session.step.ended', { sessionID, assistantMessageID: messageID, finish, cost: 0, tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 0 } } })
      emit2('session.execution.succeeded', { sessionID })
    },
  }
  function partV2(kind) {
    const n = ordinals[kind]++
    let text = ''
    return {
      delta(d) { text += d; emit2(`session.${kind}.delta`, { sessionID, assistantMessageID: messageID, ordinal: n, delta: d }) },
      end() { emit2(`session.${kind}.ended`, { sessionID, assistantMessageID: messageID, ordinal: n, text }) },
    }
  }
}

// ---- HTTP -----------------------------------------------------------------

function newSession(directory, extra) {
  const session = { id: id('ses'), directory, turns: 0, aborted: false, ...extra }
  sessions.set(session.id, session)
  return session
}

async function handleV1(req, res, url, body) {
  const path = url.pathname
  if (req.method === 'GET' && path === '/global/health') return json(res, 200, { healthy: true, version: VERSION })
  if (req.method === 'GET' && path === '/provider') {
    return json(res, 200, {
      all: [
        { id: 'opencode', name: 'OpenCode Zen', models: {
          'big-pickle': { id: 'big-pickle', name: 'Big Pickle', cost: { input: 0, output: 0 }, capabilities: { reasoning: true, input: { image: true } }, limit: { context: 200000, output: 32000 }, variants: { high: {}, low: {} } },
          'old-model': { id: 'old-model', name: 'Old', status: 'deprecated', cost: { input: 0, output: 0 } },
        } },
        { id: 'anthropic', name: 'Anthropic', models: { 'claude-x': { id: 'claude-x', name: 'Claude X', cost: { input: 3, output: 15 }, capabilities: { input: { image: false } }, limit: { context: 100000, output: 8000 } } } },
        { id: 'unconnected', name: 'Nope', models: { m: { id: 'm', name: 'M' } } },
      ],
      connected: ['opencode', 'anthropic'],
      default: {},
    })
  }
  if (req.method === 'GET' && path === '/event') return sse(req, res, () => emit1('server.connected', {}))
  if (req.method === 'POST' && path === '/session') {
    const session = newSession(url.searchParams.get('directory') ?? body?.directory, { permission: body?.permission, title: body?.title })
    return json(res, 200, { id: session.id, directory: session.directory, title: body?.title })
  }
  let m = path.match(/^\/session\/([^/]+)\/prompt_async$/)
  if (req.method === 'POST' && m) {
    const session = sessions.get(m[1])
    if (!session) return json(res, 404, { name: 'NotFoundError', data: { message: 'no session' } })
    session.lastModel = body?.model
    session.lastVariant = body?.variant
    noContent(res)
    void runTurn(session, promptText(body), promptFiles(body))
    return
  }
  m = path.match(/^\/session\/([^/]+)\/abort$/)
  if (req.method === 'POST' && m) {
    const session = sessions.get(m[1])
    if (session) session.aborted = true
    return json(res, 200, true)
  }
  m = path.match(/^\/session\/([^/]+)$/)
  if (req.method === 'DELETE' && m) {
    sessions.delete(m[1])
    return json(res, 200, true)
  }
  m = path.match(/^\/permission\/([^/]+)\/reply$/)
  if (req.method === 'POST' && m) {
    pendingPermissions.get(m[1])?.({ reply: body?.reply, message: body?.message })
    pendingPermissions.delete(m[1])
    return json(res, 200, true)
  }
  m = path.match(/^\/question\/([^/]+)\/reject$/)
  if (req.method === 'POST' && m) return json(res, 200, true)
  return json(res, 404, { name: 'NotFoundError', data: { message: `no route ${req.method} ${path}` } })
}

async function handleV2(req, res, url, body) {
  const path = url.pathname
  if (req.method === 'GET' && path === '/api/info') return json(res, 200, { version: VERSION, pid: process.pid })
  if (req.method === 'GET' && path === '/api/model') {
    const location = { directory: url.searchParams.get('location[directory]') ?? '' }
    return json(res, 200, { location, data: [
      { id: 'big-pickle', modelID: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', type: 'chat', capabilities: { input: ['text', 'image'] }, variants: [{ id: 'high' }], time: { released: 1 }, cost: [{ input: 0, output: 0 }], status: 'active', enabled: true, limit: { context: 200000, output: 32000 } },
      { id: 'old', modelID: 'old', providerID: 'opencode', name: 'Old', capabilities: { input: ['text'] }, variants: [], time: { released: 1 }, cost: [], status: 'deprecated', enabled: true, limit: { context: 1, output: 1 } },
      { id: 'claude-x', modelID: 'claude-x', providerID: 'anthropic', name: 'Claude X', capabilities: { input: ['text'] }, variants: [], time: { released: 1 }, cost: [{ input: 3, output: 15 }], status: 'active', enabled: true, limit: { context: 100000, output: 8000 } },
    ] })
  }
  if (req.method === 'GET' && path === '/api/provider') {
    return json(res, 200, { location: {}, data: [{ id: 'opencode', name: 'OpenCode Zen' }, { id: 'anthropic', name: 'Anthropic' }] })
  }
  if (req.method === 'GET' && path === '/api/event') return sse(req, res, () => broadcast({ type: 'server.connected', data: {} }))
  if (req.method === 'POST' && path === '/api/session') {
    const session = newSession(body?.location?.directory, { permissions: body?.permissions, title: body?.title, model: body?.model })
    return json(res, 200, { data: { id: session.id, projectID: 'prj_1', cost: 0, tokens: {}, time: { created: Date.now(), updated: Date.now() } } })
  }
  let m = path.match(/^\/api\/session\/([^/]+)\/prompt$/)
  if (req.method === 'POST' && m) {
    const session = sessions.get(m[1])
    if (!session) return json(res, 404, { _tag: 'NotFoundError', message: 'no session' })
    json(res, 200, { data: { id: id('msg'), sessionID: session.id, text: body?.text ?? '' } })
    void runTurn(session, promptText(body), promptFiles(body))
    return
  }
  m = path.match(/^\/api\/session\/([^/]+)\/interrupt$/)
  if (req.method === 'POST' && m) {
    const session = sessions.get(m[1])
    if (session) session.aborted = true
    return noContent(res)
  }
  m = path.match(/^\/api\/session\/([^/]+)\/model$/)
  if (req.method === 'POST' && m) {
    const session = sessions.get(m[1])
    if (session) session.model = body?.model
    return noContent(res)
  }
  m = path.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/)
  if (req.method === 'POST' && m) {
    pendingPermissions.get(m[2])?.({ reply: body?.decision, message: body?.message })
    pendingPermissions.delete(m[2])
    return noContent(res)
  }
  m = path.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)$/)
  if (req.method === 'DELETE' && m) return noContent(res)
  m = path.match(/^\/api\/session\/([^/]+)$/)
  if (req.method === 'DELETE' && m) {
    sessions.delete(m[1])
    return noContent(res)
  }
  return json(res, 404, { _tag: 'NotFoundError', message: `no route ${req.method} ${path}` })
}

function sse(req, res, hello) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  clients.add(res)
  hello()
  req.on('close', () => clients.delete(res))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!authorized(req)) {
    log({ kind: 'request', method: req.method, path: url.pathname, authorized: false })
    res.writeHead(401, { 'www-authenticate': 'Basic' })
    res.end()
    return
  }
  const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req)
  log({ kind: 'request', method: req.method, path: url.pathname, query: url.search, authorized: true, body })
  try {
    if (V2) await handleV2(req, res, url, body)
    else await handleV1(req, res, url, body)
  } catch (error) {
    json(res, 500, { message: String(error) })
  }
})

server.listen(port, hostname, () => {
  const address = server.address()
  if (!process.env.FAKE_OC_NO_READY) {
    process.stdout.write(`opencode server listening on http://${hostname}:${address.port}\n`)
  }
})

const shutdown = () => {
  try { helper.kill('SIGKILL') } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
