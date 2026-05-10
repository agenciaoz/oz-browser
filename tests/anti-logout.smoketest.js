// OZ Browser — Anti-logout smoke test (1.5d).
//
// Cómo correr:
//   cd oz-browser
//   node tests/anti-logout.smoketest.js
//
// Cubre:
//   - SOCIAL_HOSTS contains los hosts canonicales de los 10 templates
//   - isSocialCookie identifica cookies de hosts conocidos (con y sin .)
//   - isSocialCookie rechaza cookies de hosts no whitelisted
//   - isSessionCookie identifica cookies sin expiración
//   - install() hookea cookies.on('changed') por cada identity
//   - install() es idempotente (no doble-hook)
//   - uninstall() remueve los listeners
//   - Cookie social + session → re-set con expirationDate +1 año
//   - Cookie no-social → ignorada
//   - Cookie ya con expiración → ignorada (no extender lo que no es session)
//   - Cooldown — no re-extender la misma cookie en < 1h
//   - Cookie social removida con cause='explicit' + vault unlocked + matching
//     account → status='needs_relogin' + notification disparada
//   - Sin vault unlocked → no flag de needs_relogin
//   - Sin matching account (identityId distinto) → no flag

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-al-'))
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

// ---------- Mocks -----------------------------------------------------------

class FakeSession {
  constructor(label = 'session') {
    this.label = label
    this.cookies = {
      _listeners: [],
      _setCalls: [],
      on(event, listener) {
        if (event === 'changed') this._listeners.push(listener)
      },
      removeListener(event, listener) {
        if (event === 'changed') {
          this._listeners = this._listeners.filter((l) => l !== listener)
        }
      },
      set(details) {
        this._setCalls.push(details)
        return Promise.resolve()
      },
      _emit(cookie, cause, removed) {
        for (const l of this._listeners) l({}, cookie, cause, removed)
      },
    }
  }
}

function makeFakeIdentityManager(identities) {
  const sessions = new Map()
  for (const id of identities) sessions.set(id, new FakeSession(`s-${id}`))
  return {
    list: () => identities.map((id) => ({ id })),
    getSession: (id) => sessions.get(id),
    _sessions: sessions,
  }
}

function makeFakeVault(initialAccounts = [], unlocked = true) {
  let accounts = JSON.parse(JSON.stringify(initialAccounts))
  return {
    isUnlocked: unlocked,
    getAccounts: () => JSON.parse(JSON.stringify(accounts)),
    setAccounts: (arr) => {
      accounts = JSON.parse(JSON.stringify(arr))
    },
    _peek: () => accounts,
  }
}

function makeFakeNotification() {
  const log = []
  function FakeNotification(opts) {
    this.opts = opts
    log.push(opts)
  }
  FakeNotification.prototype.show = function () {}
  return { Notification: FakeNotification, _log: log }
}

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/anti-logout.js')]
  delete require.cache[require.resolve('../browser/site-templates.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  return require('../browser/anti-logout.js')
}

// ---------- Tests -----------------------------------------------------------

console.log('OZ Browser — Anti-logout smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. Constants
section('SOCIAL_HOSTS y helpers')
{
  const m = freshSetup()
  ok('SOCIAL_HOSTS contiene x.com', m.SOCIAL_HOSTS.has('x.com'))
  ok('SOCIAL_HOSTS contiene .x.com (cookie domain)', m.SOCIAL_HOSTS.has('.x.com'))
  ok('SOCIAL_HOSTS contiene instagram.com', m.SOCIAL_HOSTS.has('instagram.com'))
  ok('SOCIAL_HOSTS contiene facebook.com', m.SOCIAL_HOSTS.has('facebook.com'))
  ok('SOCIAL_HOSTS contiene .discord.com', m.SOCIAL_HOSTS.has('.discord.com'))
  ok('SOCIAL_HOSTS NO contiene foo.com', !m.SOCIAL_HOSTS.has('foo.com'))
  ok('ONE_YEAR_MS === 365d', m.ONE_YEAR_MS === 365 * 24 * 60 * 60 * 1000)
  ok('REEXTEND_COOLDOWN_MS === 1h', m.REEXTEND_COOLDOWN_MS === 60 * 60 * 1000)
}

// 2. isSocialCookie
section('isSocialCookie identifica correctamente')
{
  const m = freshSetup()
  ok('cookie de x.com → true', m.isSocialCookie({ domain: 'x.com', name: 'auth_token' }))
  ok(
    'cookie de .x.com → true',
    m.isSocialCookie({ domain: '.x.com', name: 'auth_token' }),
  )
  ok(
    'cookie de api.x.com → true (suffix match con .x.com)',
    m.isSocialCookie({ domain: 'api.x.com', name: 'auth_token' }),
  )
  ok(
    'cookie de instagram.com → true',
    m.isSocialCookie({ domain: 'instagram.com', name: 'sessionid' }),
  )
  ok(
    'cookie de foo.com → false',
    !m.isSocialCookie({ domain: 'foo.com', name: 'whatever' }),
  )
  ok('cookie sin domain → false', !m.isSocialCookie({ name: 'x' }))
  ok('null → false', !m.isSocialCookie(null))
}

// 3. isSessionCookie
section('isSessionCookie identifica cookies sin expiración')
{
  const m = freshSetup()
  ok('cookie con session=true → true', m.isSessionCookie({ session: true, name: 'x' }))
  ok(
    'cookie sin expirationDate → true',
    m.isSessionCookie({ name: 'x', domain: 'x.com' }),
  )
  ok(
    'cookie con expirationDate → false',
    !m.isSessionCookie({ expirationDate: 9999999999, name: 'x' }),
  )
  ok(
    'cookie con session=false + expirationDate → false',
    !m.isSessionCookie({ session: false, expirationDate: 1, name: 'x' }),
  )
}

// 4. install() hookea cookies.on
section('install() hookea cookies.on por identity')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default', 'cliente-a', 'cliente-b'])
  const al = new m.AntiLogout({ identityManager: im })
  al.install()

  ok(
    'session default tiene 1 listener',
    im.getSession('default').cookies._listeners.length === 1,
  )
  ok(
    'session cliente-a tiene 1 listener',
    im.getSession('cliente-a').cookies._listeners.length === 1,
  )
  ok(
    'session cliente-b tiene 1 listener',
    im.getSession('cliente-b').cookies._listeners.length === 1,
  )
}

// 5. Idempotencia
section('install() es idempotente')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default'])
  const al = new m.AntiLogout({ identityManager: im })
  al.install()
  al.install()
  al.installForIdentity('default')
  ok(
    'session default sigue con 1 listener (no doble hook)',
    im.getSession('default').cookies._listeners.length === 1,
  )
}

// 6. uninstall
section('uninstall() remueve listeners')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default'])
  const al = new m.AntiLogout({ identityManager: im })
  al.install()
  ok('hooked antes', im.getSession('default').cookies._listeners.length === 1)

  al.uninstall()
  ok('unhooked post-uninstall', im.getSession('default').cookies._listeners.length === 0)
}

// 7. Cookie social + session → re-set con expiry
section('Cookie social + session → extender expiry +1 año')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default'])
  const al = new m.AntiLogout({ identityManager: im })
  al.install()

  const session = im.getSession('default')
  // Reset _setCalls
  session.cookies._setCalls.length = 0

  session.cookies._emit(
    {
      name: 'auth_token',
      domain: '.x.com',
      value: 'abc',
      path: '/',
      secure: true,
      httpOnly: true,
      session: true,
    },
    'explicit',
    false, // not removed
  )

  ok(
    'cookies.set llamado 1 vez',
    session.cookies._setCalls.length === 1,
    `count=${session.cookies._setCalls.length}`,
  )
  const setCall = session.cookies._setCalls[0]
  ok('set.name === auth_token', setCall && setCall.name === 'auth_token')
  ok('set.domain === .x.com', setCall && setCall.domain === '.x.com')
  ok('set.url comienza con https://', setCall && setCall.url.startsWith('https://'))
  ok(
    'set.expirationDate ~= now + 1 año',
    setCall && Math.abs(setCall.expirationDate - (Date.now() + m.ONE_YEAR_MS) / 1000) < 5,
    setCall ? `expirationDate=${setCall.expirationDate}` : 'no setCall',
  )
}

// 8. Cookie NO social → ignorada
section('Cookie NO social → ignorada (no re-set)')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default'])
  const al = new m.AntiLogout({ identityManager: im })
  al.install()

  const session = im.getSession('default')
  session.cookies._setCalls.length = 0

  session.cookies._emit(
    { name: 'cart_id', domain: 'amazon.com', value: 'xyz', session: true },
    'explicit',
    false,
  )

  ok('cookies.set NO llamado', session.cookies._setCalls.length === 0)
}

// 9. Cookie con expiración (no session) → ignorada
section('Cookie no-session → ignorada')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default'])
  const al = new m.AntiLogout({ identityManager: im })
  al.install()

  const session = im.getSession('default')
  session.cookies._setCalls.length = 0

  session.cookies._emit(
    {
      name: 'persistent_token',
      domain: '.x.com',
      value: 'abc',
      session: false,
      expirationDate: 9999999999,
    },
    'explicit',
    false,
  )

  ok(
    'cookies.set NO llamado (cookie no es session)',
    session.cookies._setCalls.length === 0,
  )
}

// 10. Cooldown — no re-extender la misma cookie en < 1h
section('Cooldown 1h — segunda extensión consecutiva ignorada')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default'])
  const al = new m.AntiLogout({ identityManager: im })
  al.install()

  const session = im.getSession('default')
  session.cookies._setCalls.length = 0

  const cookie = {
    name: 'auth_token',
    domain: '.x.com',
    value: 'abc',
    session: true,
  }

  session.cookies._emit(cookie, 'explicit', false)
  session.cookies._emit(cookie, 'explicit', false)
  session.cookies._emit(cookie, 'explicit', false)

  ok(
    'cookies.set solo 1 vez (cooldown bloquea las otras 2)',
    session.cookies._setCalls.length === 1,
    `count=${session.cookies._setCalls.length}`,
  )
}

// 11. Logout detection: cookie social removida + vault con matching account
section('Logout detection: flag account needs_relogin + notify')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default'])
  const vault = makeFakeVault(
    [
      {
        id: 'a1',
        identityId: 'default',
        site: 'x.com',
        username: '@joe',
        password: 'pwd',
        status: 'active',
      },
    ],
    true,
  )
  const notif = makeFakeNotification()
  const al = new m.AntiLogout({
    identityManager: im,
    accountVault: vault,
    notificationFactory: () => notif.Notification,
  })
  al.install()

  const session = im.getSession('default')

  session.cookies._emit(
    { name: 'auth_token', domain: '.x.com', value: 'abc', session: true },
    'explicit',
    true, // removed
  )

  const updated = vault._peek()[0]
  ok('account marcado needs_relogin', updated.status === 'needs_relogin')
  ok('notification disparada', notif._log.length === 1)
  ok(
    'notification title === OZ Browser',
    notif._log[0] && notif._log[0].title === 'OZ Browser',
  )
}

// 12. Sin vault unlocked → no flag
section('Vault locked → no flag de needs_relogin')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default'])
  const vault = makeFakeVault(
    [
      {
        id: 'a1',
        identityId: 'default',
        site: 'x.com',
        username: '@joe',
        password: 'pwd',
        status: 'active',
      },
    ],
    false, // locked
  )
  const al = new m.AntiLogout({
    identityManager: im,
    accountVault: vault,
  })
  al.install()

  const session = im.getSession('default')
  session.cookies._emit(
    { name: 'auth_token', domain: '.x.com', value: 'abc', session: true },
    'explicit',
    true,
  )

  ok('account NO modificado', vault._peek()[0].status === 'active')
}

// 13. Sin matching account → no flag
section('Sin matching account → no flag')
{
  const m = freshSetup()
  const im = makeFakeIdentityManager(['default', 'cliente-a'])
  const vault = makeFakeVault(
    [
      {
        id: 'a1',
        identityId: 'cliente-a', // distinta identity
        site: 'x.com',
        username: '@joe',
        password: 'pwd',
        status: 'active',
      },
    ],
    true,
  )
  const al = new m.AntiLogout({
    identityManager: im,
    accountVault: vault,
  })
  al.install()

  // Emit del session 'default' — el account es de 'cliente-a'
  const session = im.getSession('default')
  session.cookies._emit(
    { name: 'auth_token', domain: '.x.com', value: 'abc', session: true },
    'explicit',
    true,
  )

  ok('account de OTRA identity NO modificado', vault._peek()[0].status === 'active')
}

// ---------- Cleanup ---------------------------------------------------------

Module._load = originalLoad

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
