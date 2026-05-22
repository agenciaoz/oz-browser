// OZ Browser — Bulk Runner auto-login retry smoke test (v2 sub-bloque 4).
//
// Tests del run loop wrapper que detecta err.code='needs_login' y dispara
// el flow attemptLogin + retry. Extraído de bulk-runner.smoketest.js por
// LOC budget (ADR 0005).
//
// Cubre:
//   - happy path: needs_login → login OK → action retried con success
//   - sin accountsAPI wired → no retry attempted, err.code preservado
//   - action sin platform field → no retry attempted
//   - login attempt falla → action queda failed, loginAttempt.code persisted

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const registry = require('../browser/bulk-actions-registry')
const { BulkRunner, STATUS_DONE, STATUS_FAILED } = require('../browser/bulk-runner')

let passed = 0
let failed = 0
const failures = []

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

function section(name) {
  console.log(`\n— ${name} —`)
}

function makeIM() {
  const map = new Map([['id1', { id: 'id1', name: 'Alice' }]])
  return {
    get(id) {
      return map.get(id) || null
    },
    list() {
      return Array.from(map.values())
    },
  }
}

function noDelayClock() {
  return {
    sleep() {
      return Promise.resolve()
    },
  }
}

async function main() {
  const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bulk-autologin-'))
  const im = makeIM()

  section('needs_login → login OK → action retried + result persisted')
  {
    let calls = 0
    const flaky = {
      id: 'flaky_login',
      label: 'flaky',
      platform: 'instagram.com',
      paramsSchema: { type: 'object' },
      async run() {
        calls++
        if (calls === 1) {
          const err = new Error('needs login')
          err.code = 'needs_login'
          throw err
        }
        return { okAfterLogin: true }
      },
    }
    registry.register(flaky)
    const accountsAPI = {
      list: () => [
        {
          id: 'acc',
          identityId: 'id1',
          site: 'instagram.com',
          username: 'u',
          password: 'p',
          status: 'active',
          lastLoginAt: 1,
        },
      ],
      getTotpForSite: () => null,
    }
    // Real `tryLoginAndRetry` calls action.run() after login succeeds.
    // Mirror that so the test verifies the runner observes a retried call.
    const fakeLoginFn = async ({ action, identity, params, ctx }) => {
      const result = await action.run(identity, params, ctx)
      return {
        loginAttempt: { ok: true, accountId: 'acc', durationMs: 5 },
        retried: true,
        result,
      }
    }
    const runner = new BulkRunner({
      userDataDir: path.join(TEST_HOME, 'r1'),
      identityManager: im,
      registry,
      clock: noDelayClock(),
      accountsAPI,
      autoLoginFn: fakeLoginFn,
    })
    const runId = await runner.create({
      actionId: 'flaky_login',
      identityIds: ['id1'],
      options: { minDelayMs: 0, maxDelayMs: 0 },
    })
    runner.start(runId)
    await runner.waitFor(runId)
    const rec = runner.get(runId)
    ok('item.status = done', rec.items[0].status === STATUS_DONE)
    ok(
      'loginAttempt persisted (ok=true)',
      rec.items[0].loginAttempt && rec.items[0].loginAttempt.ok === true,
    )
    ok('action.run called twice (original + retry)', calls === 2)
    registry.unregister('flaky_login')
  }

  section('needs_login + no accountsAPI wired → no retry, err.code preserved')
  {
    let calls = 0
    const flaky = {
      id: 'flaky_no_api',
      label: 'flaky',
      platform: 'instagram.com',
      paramsSchema: { type: 'object' },
      async run() {
        calls++
        const err = new Error('needs login')
        err.code = 'needs_login'
        throw err
      },
    }
    registry.register(flaky)
    const runner = new BulkRunner({
      userDataDir: path.join(TEST_HOME, 'r2'),
      identityManager: im,
      registry,
      clock: noDelayClock(),
      // no accountsAPI wired
    })
    const runId = await runner.create({
      actionId: 'flaky_no_api',
      identityIds: ['id1'],
      options: { minDelayMs: 0, maxDelayMs: 0 },
    })
    runner.start(runId)
    await runner.waitFor(runId)
    const rec = runner.get(runId)
    ok('item.status = failed', rec.items[0].status === STATUS_FAILED)
    ok(
      'item.error.code = needs_login (preserved on item.error)',
      rec.items[0].error && rec.items[0].error.code === 'needs_login',
    )
    ok('action called once (no retry)', calls === 1)
    registry.unregister('flaky_no_api')
  }

  section('action without platform → autoLoginFn NOT invoked')
  {
    let calls = 0
    const flaky = {
      id: 'flaky_no_platform',
      label: 'flaky',
      // NO platform field
      paramsSchema: { type: 'object' },
      async run() {
        calls++
        const err = new Error('needs login')
        err.code = 'needs_login'
        throw err
      },
    }
    registry.register(flaky)
    let loginFnCalled = false
    const runner = new BulkRunner({
      userDataDir: path.join(TEST_HOME, 'r3'),
      identityManager: im,
      registry,
      clock: noDelayClock(),
      accountsAPI: { list: () => [], getTotpForSite: () => null },
      autoLoginFn: async () => {
        loginFnCalled = true
        return { loginAttempt: { ok: true }, retried: true, result: {} }
      },
    })
    const runId = await runner.create({
      actionId: 'flaky_no_platform',
      identityIds: ['id1'],
      options: { minDelayMs: 0, maxDelayMs: 0 },
    })
    runner.start(runId)
    await runner.waitFor(runId)
    const rec = runner.get(runId)
    ok('item.status = failed', rec.items[0].status === STATUS_FAILED)
    ok('autoLoginFn NOT invoked', loginFnCalled === false)
    ok('action called once', calls === 1)
    registry.unregister('flaky_no_platform')
  }

  section('login attempt fails → action still failed, loginAttempt persisted')
  {
    let calls = 0
    const flaky = {
      id: 'flaky_login_fail',
      label: 'flaky',
      platform: 'instagram.com',
      paramsSchema: { type: 'object' },
      async run() {
        calls++
        const err = new Error('needs login')
        err.code = 'needs_login'
        throw err
      },
    }
    registry.register(flaky)
    const runner = new BulkRunner({
      userDataDir: path.join(TEST_HOME, 'r4'),
      identityManager: im,
      registry,
      clock: noDelayClock(),
      accountsAPI: { list: () => [], getTotpForSite: () => null },
      autoLoginFn: async () => ({
        loginAttempt: { ok: false, code: 'login-failed', message: 'wrong pw' },
        retried: false,
      }),
    })
    const runId = await runner.create({
      actionId: 'flaky_login_fail',
      identityIds: ['id1'],
      options: { minDelayMs: 0, maxDelayMs: 0 },
    })
    runner.start(runId)
    await runner.waitFor(runId)
    const rec = runner.get(runId)
    ok('item.status = failed', rec.items[0].status === STATUS_FAILED)
    ok(
      'loginAttempt.code = login-failed persisted',
      rec.items[0].loginAttempt && rec.items[0].loginAttempt.code === 'login-failed',
    )
    ok('action NOT retried (called once)', calls === 1)
    registry.unregister('flaky_login_fail')
  }

  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    }
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Test harness crashed:', err)
  process.exit(1)
})
