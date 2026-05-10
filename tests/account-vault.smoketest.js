// OZ Browser — Account Vault smoke test (mock-Electron + mock-Keychain).
//
// Cómo correr:
//   cd oz-browser
//   node tests/account-vault.smoketest.js
//
// Cubre:
//   - First-time setup: genera key 32 bytes en Keychain + crea vault file vacío
//   - unlock() con key existente + accounts persisted → recupera accounts
//   - unlock() es idempotente (segunda llamada no rompe ni regenera)
//   - lock() limpia accounts y key, getAccounts() throws después
//   - setAccounts() round-trip: re-cifra y se persiste, otra instancia lo lee
//   - getAccounts() devuelve copia (mutación externa NO afecta state interno)
//   - IV cambia en cada save (CRÍTICO de AES-GCM)
//   - destroy() borra file + Keychain key, próximo unlock = first-time again
//   - Detect tampering: alterar 1 byte del ciphertext → unlock falla con
//     code 'VAULT_TAMPERED'
//   - Header version mismatch → VAULT_VERSION_MISMATCH
//   - Crypto primitives _encrypt/_decrypt round-trip correcto

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-vault-'))
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

// ---------- Mock Keychain (in-memory map) -----------------------------------

function makeMockKeychain() {
  const store = new Map()
  return {
    _store: store,
    getPassword(service, account) {
      return store.get(`${service}:${account}`) || null
    },
    setPassword(service, account, password) {
      store.set(`${service}:${account}`, password)
    },
    deletePassword(service, account) {
      return store.delete(`${service}:${account}`)
    },
  }
}

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/account-vault.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const mod = require('../browser/account-vault.js')
  const keychain = makeMockKeychain()
  return { mod, keychain }
}

// ---------- async main ------------------------------------------------------

async function main() {
  console.log('OZ Browser — Account Vault smoke test')
  console.log(`Test userData: ${TEST_USERDATA}`)

  // 1. First-time setup
  section('First-time setup: genera key + crea vault vacío')
  {
    const { mod, keychain } = freshSetup()
    const v = new mod.Vault({ keychain })
    ok('isUnlocked === false antes de unlock', v.isUnlocked === false)

    let err = null
    try {
      await v.unlock()
    } catch (e) {
      err = e
    }

    ok('unlock no throws', err === null, err && err.message)
    ok('isUnlocked === true', v.isUnlocked === true)
    ok(
      'Keychain tiene key 32 bytes hex (64 chars)',
      (() => {
        const k = keychain.getPassword('oz-browser-vault', 'master-key-v1')
        return k && k.length === 64 && /^[0-9a-f]+$/i.test(k)
      })(),
    )
    ok('vault.enc creado', fs.existsSync(path.join(TEST_USERDATA, 'data', 'vault.enc')))
    ok('getAccounts() === []', v.getAccounts().length === 0)
  }

  // 2. Round-trip persistence
  section('Round-trip: setAccounts → re-instance → unlock → getAccounts')
  {
    const { mod, keychain } = freshSetup()
    const v1 = new mod.Vault({ keychain })
    await v1.unlock()

    v1.setAccounts([
      {
        id: 'acc1',
        identityId: 'default',
        site: 'x.com',
        username: '@joe',
        password: 'sup3rsecret!',
      },
      {
        id: 'acc2',
        identityId: 'cliente-a',
        site: 'instagram.com',
        username: 'joe_ig',
        password: 'pwd2',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
    ])

    const v2 = new mod.Vault({ keychain })
    await v2.unlock()

    const accounts = v2.getAccounts()
    ok('round-trip 2 accounts', accounts.length === 2)
    ok('acc1 password preservado', accounts[0].password === 'sup3rsecret!')
    ok('acc2 totpSecret preservado', accounts[1].totpSecret === 'JBSWY3DPEHPK3PXP')
    ok('acc2 site preservado', accounts[1].site === 'instagram.com')
  }

  // 3. Idempotent unlock
  section('unlock() es idempotente')
  {
    const { mod, keychain } = freshSetup()
    const v = new mod.Vault({ keychain })
    await v.unlock()

    v.setAccounts([{ id: 'a' }])

    const keyBefore = keychain.getPassword('oz-browser-vault', 'master-key-v1')
    await v.unlock() // segundo unlock — noop esperado
    const keyAfter = keychain.getPassword('oz-browser-vault', 'master-key-v1')

    ok('Key NO cambió', keyBefore === keyAfter)
    ok('Accounts preservados', v.getAccounts().length === 1)
  }

  // 4. lock() wipes state
  section('lock() limpia state + getAccounts() throws')
  {
    const { mod, keychain } = freshSetup()
    const v = new mod.Vault({ keychain })
    await v.unlock()

    v.setAccounts([{ id: 'lockable' }])
    ok('isUnlocked === true antes', v.isUnlocked === true)

    v.lock()
    ok('isUnlocked === false post-lock', v.isUnlocked === false)

    let err = null
    try {
      v.getAccounts()
    } catch (e) {
      err = e
    }
    ok('getAccounts() throws con code=LOCKED', err && err.code === 'LOCKED')
  }

  // 5. getAccounts() returns copy (no shared state)
  section('getAccounts() devuelve copia profunda')
  {
    const { mod, keychain } = freshSetup()
    const v = new mod.Vault({ keychain })
    await v.unlock()

    v.setAccounts([{ id: 'a', meta: { count: 1 } }])
    const a = v.getAccounts()
    a[0].meta.count = 999

    const b = v.getAccounts()
    ok(
      'mutación externa NO afecta state interno',
      b[0].meta.count === 1,
      `b[0].meta.count = ${b[0].meta.count}`,
    )
  }

  // 6. IV changes per save
  section('IV cambia en cada save (anti-AES-GCM-nonce-reuse)')
  {
    const { mod, keychain } = freshSetup()
    const v = new mod.Vault({ keychain })
    await v.unlock()

    v.setAccounts([{ id: 'a', payload: 'same data' }])
    const file1 = JSON.parse(
      fs.readFileSync(path.join(TEST_USERDATA, 'data', 'vault.enc'), 'utf-8'),
    )
    const iv1 = file1.cipher.iv

    v.setAccounts([{ id: 'a', payload: 'same data' }])
    const file2 = JSON.parse(
      fs.readFileSync(path.join(TEST_USERDATA, 'data', 'vault.enc'), 'utf-8'),
    )
    const iv2 = file2.cipher.iv

    ok('iv distinto en saves consecutivos', iv1 !== iv2, `iv1=${iv1} iv2=${iv2}`)
  }

  // 7. destroy() removes file + Keychain
  section('destroy() borra file + Keychain key')
  {
    const { mod, keychain } = freshSetup()
    const v = new mod.Vault({ keychain })
    await v.unlock()

    v.setAccounts([{ id: 'doomed' }])
    ok('vault file existe pre-destroy', fs.existsSync(v.filePath))
    ok(
      'Keychain key existe pre-destroy',
      keychain.getPassword('oz-browser-vault', 'master-key-v1') !== null,
    )

    v.destroy()
    ok('vault file removed post-destroy', !fs.existsSync(v.filePath))
    ok(
      'Keychain key removed post-destroy',
      keychain.getPassword('oz-browser-vault', 'master-key-v1') === null,
    )
    ok('isUnlocked === false post-destroy', v.isUnlocked === false)

    await v.unlock()
    ok('post-destroy unlock = fresh empty', v.getAccounts().length === 0)
    ok(
      'nueva key generada en Keychain',
      keychain.getPassword('oz-browser-vault', 'master-key-v1') !== null,
    )
  }

  // 8. Detect tampering
  section('Detect tampering: VAULT_TAMPERED')
  {
    const { mod, keychain } = freshSetup()
    const v = new mod.Vault({ keychain })
    await v.unlock()

    v.setAccounts([{ id: 'a' }])

    const file = JSON.parse(fs.readFileSync(v.filePath, 'utf-8'))
    const ct = Buffer.from(file.ciphertext, 'base64')
    ct[0] = ct[0] ^ 0xff
    file.ciphertext = ct.toString('base64')
    fs.writeFileSync(v.filePath, JSON.stringify(file), 'utf-8')

    const v2 = new mod.Vault({ keychain })
    let err = null
    try {
      await v2.unlock()
    } catch (e) {
      err = e
    }

    ok('unlock falla con error', err !== null)
    ok(
      'error code === VAULT_TAMPERED',
      err && err.code === 'VAULT_TAMPERED',
      err && `code=${err.code} msg=${err.message}`,
    )
  }

  // 9. Header version mismatch
  section('Header version mismatch → VAULT_VERSION_MISMATCH')
  {
    const { mod, keychain } = freshSetup()
    const v = new mod.Vault({ keychain })
    await v.unlock()

    const fake = {
      version: 999,
      mode: 'auto',
      cipher: {
        algo: 'aes-256-gcm',
        iv: 'AAAAAAAAAAAAAAAA',
        authTag: 'AAAAAAAAAAAAAAAAAAAAAAAA',
      },
      ciphertext: '',
    }
    fs.writeFileSync(v.filePath, JSON.stringify(fake), 'utf-8')

    const v2 = new mod.Vault({ keychain })
    let err = null
    try {
      await v2.unlock()
    } catch (e) {
      err = e
    }

    ok(
      'error code === VAULT_VERSION_MISMATCH',
      err && err.code === 'VAULT_VERSION_MISMATCH',
      err && `code=${err.code}`,
    )
  }

  // 10. Crypto primitives round-trip
  section('_encrypt / _decrypt round-trip primitives')
  {
    const { mod } = freshSetup()
    const key = require('crypto').randomBytes(32)
    const plaintext = 'hello vault — JSON.stringify(accounts) goes here'
    const enc = mod._encrypt(key, plaintext)
    ok('iv 12 bytes', enc.iv.length === 12)
    ok('authTag 16 bytes', enc.authTag.length === 16)

    const cipherHeader = {
      algo: 'aes-256-gcm',
      iv: enc.iv.toString('base64'),
      authTag: enc.authTag.toString('base64'),
    }
    const decoded = mod._decrypt(key, cipherHeader, enc.ciphertext.toString('base64'))
    ok('round-trip text exacto', decoded === plaintext, `decoded=${decoded.slice(0, 40)}`)
  }
}

// ---------- Run -------------------------------------------------------------

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
