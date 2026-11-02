import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Codes } from '../src/errors.ts'
import { OpenCodeRuntime, verifyServer } from '../src/runtime.ts'
import { alive, FAKE_OPENCODE, makeRuntime, quietLogger, readLog, tempLog, waitFor } from './helpers.ts'

for (const version of ['1.15.0', '2.2.5']) {
  const api = version.startsWith('2') ? 'v2' : 'v1'

  describe(`runtime with OpenCode ${version}`, () => {
    it('starts one shared server on 127.0.0.1 with a random password and the full environment', async () => {
      const log = tempLog()
      const runtime = makeRuntime({ version, log, env: { FAKE_OC_MARKER: 'user-env-visible' } })
      try {
        const [a, b] = await Promise.all([runtime.connect(), runtime.connect()])
        assert.equal(a, b, 'connect is single-flight')
        assert.equal(a.api, api)
        assert.equal(a.version, version)
        assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+$/)
        assert.ok(a.password && a.password.length >= 24)

        const starts = readLog(log).filter((e) => e.kind === 'start')
        assert.equal(starts.length, 1)
        const start = starts[0]!
        assert.equal(start.marker, 'user-env-visible')
        assert.ok(start.argv.includes('--hostname=127.0.0.1'))
        if (api === 'v1') {
          assert.equal(start.hasServerPassword, true)
          const config = JSON.parse(start.configContent)
          assert.deepEqual(Object.keys(config), ['permission'])
          assert.ok(!start.configContent.includes('deny'))
        } else {
          assert.equal(start.hasPassword, true)
          assert.equal(start.hasServerPassword, false)
        }

        // The password is required.
        await assert.rejects(verifyServer(a.url, 'wrong'), (error: any) => error.code === Codes.AUTH)
      } finally {
        await runtime.dispose()
      }
    })

    it('kills the server and its helpers on dispose', async () => {
      const log = tempLog()
      const runtime = makeRuntime({ version, log })
      await runtime.connect()
      const start = readLog(log).find((e) => e.kind === 'start')!
      assert.ok(alive(start.pid))
      assert.ok(alive(start.helperPid))
      await runtime.dispose()
      await waitFor(() => !alive(start.pid) && !alive(start.helperPid), 5_000, 'process group to exit')
      assert.equal(runtime.isRunning, false)
    })
  })
}

describe('runtime failures and recovery', () => {
  it('restarts a crashed server with a new password', async () => {
    const log = tempLog()
    const runtime = makeRuntime({ log, env: { FAKE_OC_EXIT_MS: '400' } })
    try {
      const first = await runtime.connect()
      await waitFor(() => readLog(log).filter((e) => e.kind === 'start').length >= 2, 8_000, 'restart')
      const second = await runtime.connect()
      assert.notEqual(second.serial, first.serial)
      assert.notEqual(second.password, first.password)
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects an OpenCode that is too old', async () => {
    const runtime = makeRuntime({ version: '1.14.18', log: tempLog() })
    try {
      await assert.rejects(runtime.connect(), (error: any) => error.code === Codes.OPENCODE_VERSION && /too old/.test(error.message))
    } finally {
      await runtime.dispose()
    }
  })

  it('explains how to install OpenCode when it is missing', async () => {
    const runtime = makeRuntime({ log: tempLog(), settings: { binaryPath: '/nonexistent/opencode' } })
    try {
      await assert.rejects(runtime.connect(), (error: any) => error.code === Codes.OPENCODE_MISSING && /npm i -g opencode-ai/.test(error.message))
    } finally {
      await runtime.dispose()
    }
  })

  it('attaches to an existing server with serverUrl + serverPassword', async () => {
    const log = tempLog()
    const owner = makeRuntime({ version: '2.2.5', log })
    try {
      const running = await owner.connect()
      const attached = new OpenCodeRuntime({
        settings: () => ({ binaryPath: FAKE_OPENCODE, serverUrl: running.url, serverPassword: running.password! }),
        logger: quietLogger,
      })
      const connection = await attached.connect()
      assert.equal(connection.external, true)
      assert.equal(connection.api, 'v2')
      await attached.dispose()
      assert.ok(owner.isRunning, 'disposing an attached runtime leaves the server alone')

      const wrong = new OpenCodeRuntime({
        settings: () => ({ binaryPath: FAKE_OPENCODE, serverUrl: running.url, serverPassword: 'nope' }),
        logger: quietLogger,
      })
      await assert.rejects(wrong.connect(), (error: any) => error.code === Codes.AUTH)
      await wrong.dispose()
    } finally {
      await owner.dispose()
    }
  })
})
