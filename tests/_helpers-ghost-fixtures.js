// OZ Browser — shared fixture builders for Ghost Browser reader/importer tests.
//
// Builds in-memory SQLite databases matching the Chromium 'cookies' and
// 'logins' schemas as they appear in Ghost Browser data dirs. Used by:
//   - tests/ghost-browser-reader.smoketest.js
//   - tests/ghost-browser-reader-sqlite.smoketest.js
//   - (future) tests/ghost-browser-importer.smoketest.js (G-2)
//
// Also exports a small assertion runner factory so the test files don't
// duplicate ok()/section()/summary boilerplate.

const fs = require('fs')
const os = require('os')
const path = require('path')

const initSqlJs = require('sql.js')

let _sql = null
async function getSQL() {
  if (!_sql) _sql = await initSqlJs()
  return _sql
}

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function mkInstall(root, name) {
  const dir = fs.mkdtempSync(path.join(root, `${name}-`))
  fs.mkdirSync(path.join(dir, 'Default/Identities'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'Default/Projects'), { recursive: true })
  return dir
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj))
}

async function makeCookiesDb(rows) {
  const sql = await getSQL()
  const db = new sql.Database()
  db.run(
    `CREATE TABLE cookies(
      creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT,
      name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
      has_expires INTEGER, is_persistent INTEGER, priority INTEGER,
      samesite INTEGER, source_scheme INTEGER, source_port INTEGER,
      last_access_utc INTEGER, last_update_utc INTEGER
    )`,
  )
  const stmt = db.prepare(
    `INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name,
      value, encrypted_value, path, expires_utc, is_secure, is_httponly,
      has_expires, is_persistent, priority, samesite, source_scheme,
      source_port, last_access_utc, last_update_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  for (const r of rows) {
    stmt.run([
      r.creation_utc || 0,
      r.host_key,
      r.top_frame_site_key || '',
      r.name,
      r.value || '',
      r.encrypted_value || new Uint8Array([0x76, 0x31, 0x30, 1, 2, 3]),
      r.path || '/',
      r.expires_utc || 0,
      r.is_secure ? 1 : 0,
      r.is_httponly ? 1 : 0,
      r.has_expires ? 1 : 0,
      r.is_persistent ? 1 : 0,
      r.priority || 1,
      r.samesite || -1,
      r.source_scheme || 1,
      r.source_port || 443,
      r.last_access_utc || 0,
      r.last_update_utc || 0,
    ])
  }
  stmt.free()
  const buf = Buffer.from(db.export())
  db.close()
  return buf
}

async function makeLoginDataDb(rows) {
  const sql = await getSQL()
  const db = new sql.Database()
  db.run(
    `CREATE TABLE logins(
      origin_url VARCHAR NOT NULL, action_url VARCHAR,
      username_element VARCHAR, username_value VARCHAR,
      password_element VARCHAR, password_value BLOB,
      submit_element VARCHAR, signon_realm VARCHAR NOT NULL,
      date_created INTEGER NOT NULL, blacklisted_by_user INTEGER NOT NULL,
      scheme INTEGER NOT NULL, password_type INTEGER,
      times_used INTEGER, form_data BLOB, display_name VARCHAR,
      icon_url VARCHAR, federation_url VARCHAR, skip_zero_click INTEGER,
      generation_upload_status INTEGER, possible_username_pairs BLOB,
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_last_used INTEGER NOT NULL DEFAULT 0
    )`,
  )
  const stmt = db.prepare(
    `INSERT INTO logins (origin_url, action_url, username_element,
      username_value, password_element, password_value, signon_realm,
      date_created, blacklisted_by_user, scheme, date_last_used)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
  for (const r of rows) {
    stmt.run([
      r.origin_url,
      r.action_url || r.origin_url,
      r.username_element || 'username',
      r.username_value,
      r.password_element || 'password',
      r.password_value || new Uint8Array([0x76, 0x31, 0x30, 5, 6, 7, 8]),
      r.signon_realm || r.origin_url,
      r.date_created || 0,
      r.blacklisted_by_user ? 1 : 0,
      r.scheme || 0,
      r.date_last_used || 0,
    ])
  }
  stmt.free()
  const buf = Buffer.from(db.export())
  db.close()
  return buf
}

async function makeEmptyLoginDataStub() {
  // Per-identity Login Data files in Ghost have NO 'logins' table. We
  // simulate that by creating a DB with a different (irrelevant) table.
  const sql = await getSQL()
  const db = new sql.Database()
  db.run('CREATE TABLE meta(key TEXT, value TEXT)')
  const buf = Buffer.from(db.export())
  db.close()
  return buf
}

// Returns a runner with ok/section/done helpers. Each test file gets its
// own counters so summaries are independent.
function makeRunner(title) {
  const state = { passed: 0, failed: 0, failures: [] }
  const ok = (label, cond, detail) => {
    if (cond) {
      state.passed++
      console.log(`  ✓ ${label}`)
    } else {
      state.failed++
      state.failures.push({ label, detail })
      console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
    }
  }
  const section = (name) => console.log(`\n— ${name} —`)
  const done = () => {
    console.log('')
    console.log(`Passed: ${state.passed}`)
    console.log(`Failed: ${state.failed}`)
    if (state.failed > 0) {
      console.log('\nFailures:')
      for (const f of state.failures) {
        console.log(`  - ${f.label}${f.detail ? ': ' + f.detail : ''}`)
      }
      process.exit(1)
    }
  }
  console.log(title)
  return { ok, section, done }
}

module.exports = {
  getSQL,
  makeRoot,
  mkInstall,
  writeJson,
  makeCookiesDb,
  makeLoginDataDb,
  makeEmptyLoginDataStub,
  makeRunner,
}
