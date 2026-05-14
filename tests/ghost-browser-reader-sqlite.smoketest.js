// OZ Browser — Ghost Browser reader (G-1) smoke test — SQLite paths.
//
// Cómo correr:
//   cd oz-browser
//   node tests/ghost-browser-reader-sqlite.smoketest.js
//
// Cubre las funciones del reader que tocan SQLite via sql.js:
//   - readIdentity: cookies array, encrypted_value as Uint8Array, boolean
//     coercion of is_secure/is_httponly, missing Cookies → empty array,
//     missing identity throws, missing identity.json → metadata={}
//   - readLoginData: pool-global passwords, missing file, empty stub
//     (per-identity Login Data has no 'logins' table), password_value as
//     Uint8Array, blacklisted_by_user boolean coercion
//   - readDefaultCookies: pool-global cookies, same shape as identity
//     cookies, missing file
//
// JSON-only fn tests live in ghost-browser-reader.smoketest.js.

const fs = require('fs')
const path = require('path')

const helpers = require('./_helpers-ghost-fixtures.js')
const reader = require('../browser/migrations/ghost-browser-reader.js')

const ROOT = helpers.makeRoot('oz-ghost-reader-sqlite-')
const mkInstall = (name) => helpers.mkInstall(ROOT, name)
const writeJson = helpers.writeJson

const { ok, section, done } = helpers.makeRunner(
  'OZ Browser — Ghost Browser reader (G-1) smoke test [SQLite paths]',
)
console.log(`Test root: ${ROOT}`)

async function run() {
  // ---------- readIdentity ----------
  section('readIdentity (with cookies SQLite)')
  {
    const dir = mkInstall('rid')
    const hash = 'abc123'
    const identityDir = path.join(dir, 'Default/Identities', hash)
    fs.mkdirSync(identityDir, { recursive: true })
    writeJson(path.join(identityDir, 'identity.json'), {
      id: hash,
      name: 'Pedro',
      color: 'BC789C',
      tag: 'work',
      dedication: '',
    })
    const blob = new Uint8Array([0x76, 0x31, 0x30, 1, 2, 3, 4])
    fs.writeFileSync(
      path.join(identityDir, 'Cookies'),
      await helpers.makeCookiesDb([
        {
          host_key: '.google.com',
          name: 'NID',
          encrypted_value: blob,
          is_secure: true,
          is_httponly: false,
          has_expires: true,
        },
        {
          host_key: '.tiktok.com',
          name: 'sessionid',
          encrypted_value: blob,
          is_secure: true,
          is_httponly: true,
        },
      ]),
    )
    const r = await reader.readIdentity(dir, hash)
    ok('hash echoed back', r.hash === hash)
    ok('metadata.name parsed', r.metadata.name === 'Pedro')
    ok('metadata.color parsed', r.metadata.color === 'BC789C')
    ok('cookies array has 2 rows', r.cookies.length === 2)
    ok('cookie.host_key correct', r.cookies[0].host_key === '.google.com')
    ok(
      'cookie.encrypted_value is Uint8Array',
      r.cookies[0].encrypted_value instanceof Uint8Array,
    )
    ok(
      'cookie.is_secure is boolean true',
      r.cookies[0].is_secure === true && r.cookies[1].is_secure === true,
    )
    ok(
      'cookie.is_httponly preserves false vs true',
      r.cookies[0].is_httponly === false && r.cookies[1].is_httponly === true,
    )
    ok(
      'encrypted_value bytes preserved',
      r.cookies[0].encrypted_value[0] === 0x76 && r.cookies[0].encrypted_value[3] === 1,
    )
  }
  {
    const dir = mkInstall('rid-missing')
    let threw = false
    try {
      await reader.readIdentity(dir, 'nope')
    } catch (e) {
      threw = e.message.includes('not found')
    }
    ok('missing identity throws', threw)
  }
  {
    const dir = mkInstall('rid-no-cookies')
    const hash = 'no-cookies-hash'
    const identityDir = path.join(dir, 'Default/Identities', hash)
    fs.mkdirSync(identityDir, { recursive: true })
    writeJson(path.join(identityDir, 'identity.json'), { id: hash, name: 'X' })
    const r = await reader.readIdentity(dir, hash)
    ok('missing Cookies file → cookies=[]', r.cookies.length === 0)
    ok('metadata still parsed', r.metadata.name === 'X')
  }
  {
    const dir = mkInstall('rid-no-metadata')
    const hash = 'no-meta'
    fs.mkdirSync(path.join(dir, 'Default/Identities', hash), {
      recursive: true,
    })
    const r = await reader.readIdentity(dir, hash)
    ok(
      'missing identity.json → metadata={}',
      typeof r.metadata === 'object' && Object.keys(r.metadata).length === 0,
    )
  }

  // ---------- readLoginData ----------
  section('readLoginData')
  {
    const dir = mkInstall('ld-missing')
    const r = await reader.readLoginData(dir)
    ok('missing Login Data → []', r.length === 0)
  }
  {
    const dir = mkInstall('ld-stub')
    fs.writeFileSync(
      path.join(dir, 'Default/Login Data'),
      await helpers.makeEmptyLoginDataStub(),
    )
    const r = await reader.readLoginData(dir)
    ok('empty stub (no logins table) → []', Array.isArray(r) && r.length === 0)
  }
  {
    const dir = mkInstall('ld-basic')
    const blob = new Uint8Array([0x76, 0x31, 0x30, 9, 9, 9])
    fs.writeFileSync(
      path.join(dir, 'Default/Login Data'),
      await helpers.makeLoginDataDb([
        {
          origin_url: 'https://www.instagram.com/',
          username_value: 'contexto.ec',
          password_value: blob,
          signon_realm: 'https://www.instagram.com/',
        },
        {
          origin_url: 'https://twitter.com/',
          username_value: 'user@example.com',
          password_value: blob,
          signon_realm: 'https://twitter.com/',
        },
      ]),
    )
    const r = await reader.readLoginData(dir)
    ok('2 login rows returned', r.length === 2)
    ok(
      'origin_url + username_value preserved',
      r[0].origin_url === 'https://www.instagram.com/' &&
        r[0].username_value === 'contexto.ec',
    )
    ok('password_value is Uint8Array', r[0].password_value instanceof Uint8Array)
    ok('blacklisted_by_user coerced to boolean', r[0].blacklisted_by_user === false)
  }

  // ---------- readDefaultCookies ----------
  section('readDefaultCookies')
  {
    const dir = mkInstall('dc-missing')
    const r = await reader.readDefaultCookies(dir)
    ok('missing Default/Cookies → []', r.length === 0)
  }
  {
    const dir = mkInstall('dc-basic')
    fs.writeFileSync(
      path.join(dir, 'Default/Cookies'),
      await helpers.makeCookiesDb([
        { host_key: '.ghostbrowser.com', name: 'session', is_secure: true },
      ]),
    )
    const r = await reader.readDefaultCookies(dir)
    ok('Default/Cookies parsed', r.length === 1)
    ok('same shape as identity cookies', r[0].host_key === '.ghostbrowser.com')
  }

  done()
}

run()
  .catch((e) => {
    console.error('UNCAUGHT:', e.stack || e.message)
    process.exit(1)
  })
  .finally(() => {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
  })
