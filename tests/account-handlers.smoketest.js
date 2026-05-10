// OZ Browser — Account + Vault handlers smoke test (1.5b).
//
// Cómo correr:
//   cd oz-browser
//   node tests/account-handlers.smoketest.js
//
// Cubre:
//   - vault.status() siempre callable, accountsCount=null cuando locked
//   - vault.unlock() abre, vault.lock() cierra
//   - accounts.* devuelven {__error:LOCKED} si vault locked
//   - accounts.create requires identityId+site+username+password
//   - accounts.create asigna defaults (status='active', timestamps, customFields={})
//   - accounts.list filter por identityId/workspaceId/site/status
//   - accounts.get por id
//   - accounts.update whitelist + invalid status ignorado
//   - accounts.update updatedAt cambia
//   - accounts.remove devuelve true/false correctamente
//   - accounts.setAll bulk replace con count check
//   - vault.destroy() borra y resetea — accounts list vuelve vacía después
//     de unlock fresh

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-acc-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

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

function makeMockKeychain() {
  const store = new Map()
  return {
    getPassword(s, a) {
      return store.get(`${s}:${a}`) || null
    },
    setPassword(s, a, p) {
      store.set(`${s}:${a}`, p)
    },
    deletePassword(s, a) {
      return store.delete(`${s}:${a}`)
    },
  }
}

function makeFakeBrowser(vault) {
  const broadcasts = []
  return {
    accountVault: vault,
    broadcasts,
    broadcastToWebUI(channel, ...args) {
      broadcasts.push({ channel, args })
    },
  }
}

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/account-vault.js')]
  delete require.cache[require.resolve('../browser/account-handlers.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const vaultMod = require('../browser/account-vault.js')
  const handlersMod = require('../browser/account-handlers.js')
  const keychain = makeMockKeychain()
  const vault = new vaultMod.Vault({ keychain })
  const browser = makeFakeBrowser(vault)
  const vaultHandlers = handlersMod.buildVaultHandlers(browser)
  const accountHandlers = handlersMod.buildAccountHandlers(browser)
  return { vault, browser, vaultHandlers, accountHandlers, vaultMod, handlersMod }
}

async function main() {
  console.log('OZ Browser — Account + Vault handlers smoke test')
  console.log(`Test userData: ${TEST_USERDATA}`)

  // 1. vault.status() siempre callable
  section('vault.status() locked vs unlocked')
  {
    const { vault, vaultHandlers } = freshSetup()
    const sBefore = vaultHandlers.status()
    ok('exists === true', sBefore.exists === true)
    ok('isUnlocked === false antes', sBefore.isUnlocked === false)
    ok('accountsCount === null antes', sBefore.accountsCount === null)

    await vault.unlock()
    const sAfter = vaultHandlers.status()
    ok('isUnlocked === true post-unlock', sAfter.isUnlocked === true)
    ok('accountsCount === 0 post-unlock', sAfter.accountsCount === 0)
  }

  // 2. accounts.* devuelven LOCKED si vault locked
  section('accounts.* devuelven LOCKED si vault locked')
  {
    const { accountHandlers } = freshSetup()
    const r1 = accountHandlers.list()
    ok('list() => __error LOCKED', r1.__error && r1.__error.code === 'LOCKED')

    const r2 = accountHandlers.create({
      identityId: 'x',
      site: 'y',
      username: 'u',
      password: 'p',
    })
    ok('create() => __error LOCKED', r2.__error && r2.__error.code === 'LOCKED')

    const r3 = accountHandlers.get('whatever')
    ok('get() => __error LOCKED', r3.__error && r3.__error.code === 'LOCKED')

    const r4 = accountHandlers.update('x', {})
    ok('update() => __error LOCKED', r4.__error && r4.__error.code === 'LOCKED')

    const r5 = accountHandlers.remove('x')
    ok('remove() => __error LOCKED', r5.__error && r5.__error.code === 'LOCKED')
  }

  // 3. accounts.create validation
  section('accounts.create requiere identityId + site + username + password')
  {
    const { vault, accountHandlers } = freshSetup()
    await vault.unlock()

    const r1 = accountHandlers.create({})
    ok('create({}) => BAD_ARG', r1.__error && r1.__error.code === 'BAD_ARG')

    const r2 = accountHandlers.create({ identityId: 'i', site: 's' })
    ok(
      'create con campos faltantes => BAD_ARG',
      r2.__error && r2.__error.code === 'BAD_ARG',
    )

    const r3 = accountHandlers.create({
      identityId: 'default',
      site: 'x.com',
      username: '@joe',
      password: 'pwd',
    })
    ok('create OK con required fields', r3.id && r3.site === 'x.com')
  }

  // 4. accounts.create defaults
  section('accounts.create asigna defaults')
  {
    const { vault, accountHandlers } = freshSetup()
    await vault.unlock()
    const a = accountHandlers.create({
      identityId: 'd',
      site: 'x.com',
      username: 'u',
      password: 'p',
    })
    ok('status default === active', a.status === 'active')
    ok('workspaceId default === null', a.workspaceId === null)
    ok('cookies default === null', a.cookies === null)
    ok('totpSecret default === null', a.totpSecret === null)
    ok('notes default === ""', a.notes === '')
    ok('customFields default === {}', JSON.stringify(a.customFields) === '{}')
    ok('createdAt > 0', a.createdAt > 0)
    ok('updatedAt === createdAt', a.updatedAt === a.createdAt)
    ok('id es 16 hex chars', /^[0-9a-f]{16}$/.test(a.id))
  }

  // 5. list filtering
  section('accounts.list filter')
  {
    const { vault, accountHandlers } = freshSetup()
    await vault.unlock()

    accountHandlers.create({
      identityId: 'i1',
      workspaceId: 'w1',
      site: 'x.com',
      username: 'u1',
      password: 'p',
    })
    accountHandlers.create({
      identityId: 'i1',
      workspaceId: 'w2',
      site: 'instagram.com',
      username: 'u2',
      password: 'p',
    })
    accountHandlers.create({
      identityId: 'i2',
      workspaceId: 'w1',
      site: 'x.com',
      username: 'u3',
      password: 'p',
      status: 'inactive',
    })

    ok('list() todos === 3', accountHandlers.list().length === 3)
    ok(
      'filter identityId=i1 → 2',
      accountHandlers.list({ identityId: 'i1' }).length === 2,
    )
    ok(
      'filter workspaceId=w1 → 2',
      accountHandlers.list({ workspaceId: 'w1' }).length === 2,
    )
    ok('filter site=x.com → 2', accountHandlers.list({ site: 'x.com' }).length === 2)
    ok(
      'filter status=inactive → 1',
      accountHandlers.list({ status: 'inactive' }).length === 1,
    )
    ok(
      'filter combinado i1+x.com → 1',
      accountHandlers.list({ identityId: 'i1', site: 'x.com' }).length === 1,
    )
  }

  // 6. accounts.get
  section('accounts.get por id')
  {
    const { vault, accountHandlers } = freshSetup()
    await vault.unlock()
    const a = accountHandlers.create({
      identityId: 'd',
      site: 'x.com',
      username: 'u',
      password: 'p',
    })
    const got = accountHandlers.get(a.id)
    ok('get encontrado', got && got.id === a.id)
    ok('get inexistente → null', accountHandlers.get('nope') === null)
  }

  // 7. update whitelist + invalid status
  section('accounts.update whitelist + invalid status ignorado')
  {
    const { vault, accountHandlers } = freshSetup()
    await vault.unlock()
    const a = accountHandlers.create({
      identityId: 'd',
      site: 'x.com',
      username: 'u',
      password: 'p',
    })
    const beforeUpdated = a.updatedAt
    // pequeña espera para que updatedAt cambie
    await new Promise((r) => setTimeout(r, 10))

    const u1 = accountHandlers.update(a.id, {
      password: 'newpwd',
      notes: 'nueva nota',
      bogusField: 'ignored',
    })
    ok('update password persiste', u1.password === 'newpwd')
    ok('update notes persiste', u1.notes === 'nueva nota')
    ok('bogusField NO está en el output', u1.bogusField === undefined)
    ok('updatedAt incrementó', u1.updatedAt > beforeUpdated)

    const u2 = accountHandlers.update(a.id, { status: 'invalid-status' })
    ok('status inválido NO cambió', u2.status === 'active')

    const u3 = accountHandlers.update(a.id, { status: 'needs_relogin' })
    ok('status válido cambió', u3.status === 'needs_relogin')

    const u4 = accountHandlers.update('nonexistent', { password: 'x' })
    ok('update id inexistente → null', u4 === null)
  }

  // 8. remove
  section('accounts.remove devuelve true/false')
  {
    const { vault, accountHandlers } = freshSetup()
    await vault.unlock()
    const a = accountHandlers.create({
      identityId: 'd',
      site: 'x.com',
      username: 'u',
      password: 'p',
    })
    ok('remove existente → true', accountHandlers.remove(a.id) === true)
    ok('list post-remove === 0', accountHandlers.list().length === 0)
    ok('remove ya removido → false', accountHandlers.remove(a.id) === false)
  }

  // 9. setAll bulk replace
  section('accounts.setAll bulk')
  {
    const { vault, accountHandlers } = freshSetup()
    await vault.unlock()
    accountHandlers.create({
      identityId: 'd',
      site: 'x.com',
      username: 'u1',
      password: 'p',
    })
    accountHandlers.create({
      identityId: 'd',
      site: 'instagram.com',
      username: 'u2',
      password: 'p',
    })
    ok('start con 2 accounts', accountHandlers.list().length === 2)

    const r = accountHandlers.setAll([
      { id: 'imported-1', identityId: 'i1', site: 'x.com', username: 'a', password: 'b' },
      {
        id: 'imported-2',
        identityId: 'i2',
        site: 'fb.com',
        username: 'c',
        password: 'd',
      },
      {
        id: 'imported-3',
        identityId: 'i3',
        site: 'tiktok.com',
        username: 'e',
        password: 'f',
      },
    ])
    ok('setAll ok', r.ok === true)
    ok('setAll count === 3', r.count === 3)
    ok('list post-setAll === 3', accountHandlers.list().length === 3)
    ok(
      'imported-2 en lista',
      accountHandlers.list().find((a) => a.id === 'imported-2') !== undefined,
    )

    const rBad = accountHandlers.setAll('not an array')
    ok('setAll non-array => BAD_ARG', rBad.__error && rBad.__error.code === 'BAD_ARG')
  }

  // 10. vault.destroy() reset
  section('vault.destroy() borra y unlock fresh devuelve list vacía')
  {
    const { vault, accountHandlers, vaultHandlers } = freshSetup()
    await vault.unlock()
    accountHandlers.create({
      identityId: 'd',
      site: 'x.com',
      username: 'u',
      password: 'p',
    })
    ok('list pre-destroy === 1', accountHandlers.list().length === 1)

    vaultHandlers.destroy()
    ok('isUnlocked false post-destroy', vault.isUnlocked === false)

    await vault.unlock() // first-time again
    ok('list post-destroy + unlock === 0', accountHandlers.list().length === 0)
  }

  // 11. broadcast events
  section('broadcasts events fire')
  {
    const { vault, accountHandlers, vaultHandlers, browser } = freshSetup()
    await vault.unlock()

    browser.broadcasts.length = 0
    accountHandlers.create({
      identityId: 'd',
      site: 'x.com',
      username: 'u',
      password: 'p',
    })
    ok(
      'oz:accounts:changed broadcast post-create',
      browser.broadcasts.some((b) => b.channel === 'oz:accounts:changed'),
    )

    browser.broadcasts.length = 0
    vaultHandlers.lock()
    ok(
      'oz:vault:changed broadcast post-lock',
      browser.broadcasts.some((b) => b.channel === 'oz:vault:changed'),
    )
  }
}

main()
  .catch((err) => {
    console.error('UNEXPECTED ERROR in test runner:', err)
    failed++
    failures.push({ label: 'runner crash', detail: err.message })
  })
  .finally(() => {
    Module._load = originalLoad
    console.log(`\n=== ${passed} passed · ${failed} failed ===`)
    if (failed > 0) {
      console.log('\nFailures:')
      for (const f of failures)
        console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
      process.exit(1)
    }
    process.exit(0)
  })
