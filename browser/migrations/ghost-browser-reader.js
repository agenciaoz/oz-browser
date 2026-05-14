// OZ Browser — Ghost Browser reader (G-1).
//
// Pure-data reader for a Ghost Browser data directory. NO side effects, NO
// decryption, NO Electron dependencies. Returns raw shapes only.
//
// Decryption of encrypted_value / password_value blobs happens in G-2
// (importer), which requires macOS Keychain access ("Ghost Browser Safe
// Storage") and is intentionally kept out of this module so the reader is
// testable in plain Node.
//
// Empirical findings from Jose's install (2026-05-13) — schemas verified
// against real data, NOT the (partially wrong) G-0 spike notes:
//
//   ~/Library/Application Support/GhostBrowser/Default/
//     identities.json          → { "identities": [hash, ...] }
//     Identities/<hash>/
//       identity.json          → { id, name, color, dedication, tag,
//                                  description, creation_time, change_time,
//                                  move_time, usage_rate, key, ... }
//       Cookies                → SQLite, Chromium 'cookies' table
//       Login Data             → SQLite, EMPTY (no 'logins' table — stub)
//     Projects/projects_list.json → { "projects": [uuid, ...],
//                                     "projects_number": N }
//     Projects/<uuid>/project.json → { id, name, windows[].tabs[]{ url, title,
//                                       identity (hash), favicon, ... } }
//     Projects/archived/<uuid>/   → archived workspaces
//     Cookies                  → pool-global cookies (Ghost welcome stuff)
//     Login Data               → pool-global passwords (Chromium logins
//                                table) — THIS is where user passwords live
//     Bookmarks                → MAY not exist (Ghost doesn't auto-create it)
//
// All `encrypted_value` / `password_value` fields are returned as Uint8Array
// (sql.js BLOB representation). G-2 decrypts via AES-128-CBC + PBKDF2 with
// key from macOS Keychain.

const fs = require('fs')
const path = require('path')
const os = require('os')

const DEFAULT_HOME_DIR = os.homedir()
const GHOST_REL_PATH = 'Library/Application Support/GhostBrowser'

let _sqlPromise = null
function _getSql(initSqlJs) {
  if (!_sqlPromise) {
    const init = initSqlJs || require('sql.js')
    _sqlPromise = init()
  }
  return _sqlPromise
}

// For tests — reset the cached sql.js instance.
function _resetSqlCache() {
  _sqlPromise = null
}

function _readJsonSafe(p) {
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (_err) {
    return null
  }
}

function _openDb(SQL, filePath) {
  const buf = fs.readFileSync(filePath)
  return new SQL.Database(buf)
}

function _execAll(db, sql) {
  const res = db.exec(sql)
  if (!res || !res[0]) return { columns: [], rows: [] }
  return { columns: res[0].columns, rows: res[0].values }
}

function _rowsToObjects(execResult) {
  const { columns, rows } = execResult
  return rows.map((row) => {
    const o = {}
    for (let i = 0; i < columns.length; i++) o[columns[i]] = row[i]
    return o
  })
}

// detectInstall({ homeDir? }) → { found, dataDir, version? }
// Looks for ~/Library/Application Support/GhostBrowser/Default. Reads
// Preferences when present to surface a version string. Never throws.
function detectInstall(opts = {}) {
  const homeDir = opts.homeDir || DEFAULT_HOME_DIR
  const dataDir = path.join(homeDir, GHOST_REL_PATH)
  const defaultDir = path.join(dataDir, 'Default')
  if (!fs.existsSync(defaultDir)) {
    return { found: false, dataDir: null, version: null }
  }
  let version = null
  const prefs = _readJsonSafe(path.join(defaultDir, 'Preferences'))
  if (prefs && prefs.profile && prefs.profile.created_by_version) {
    version = prefs.profile.created_by_version
  }
  return { found: true, dataDir, version }
}

// readIdentitiesIndex(dataDir) → [hash, hash, ...]
// Parses Default/Identities/identities.json. Empty array if missing/malformed.
function readIdentitiesIndex(dataDir) {
  const p = path.join(dataDir, 'Default/Identities/identities.json')
  const raw = _readJsonSafe(p)
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string')
  if (Array.isArray(raw.identities)) {
    return raw.identities.filter((x) => typeof x === 'string')
  }
  return []
}

// readIdentity(dataDir, hash, { initSqlJs? }) → Promise<{ hash, metadata,
//   cookies: [...] }>
// Reads identity.json + per-identity Cookies SQLite. Cookies come with
// encrypted_value as Uint8Array (raw blob — NOT decrypted).
async function readIdentity(dataDir, hash, opts = {}) {
  const identityDir = path.join(dataDir, 'Default/Identities', hash)
  if (!fs.existsSync(identityDir)) {
    throw new Error(`Identity not found: ${hash}`)
  }
  const metadata = _readJsonSafe(path.join(identityDir, 'identity.json')) || {}
  const cookies = await _readCookiesFile(
    path.join(identityDir, 'Cookies'),
    opts.initSqlJs,
  )
  return { hash, metadata, cookies }
}

async function _readCookiesFile(filePath, initSqlJs) {
  if (!fs.existsSync(filePath)) return []
  const SQL = await _getSql(initSqlJs)
  const db = _openDb(SQL, filePath)
  try {
    const res = _execAll(
      db,
      'SELECT host_key, top_frame_site_key, name, value, encrypted_value, ' +
        'path, expires_utc, is_secure, is_httponly, has_expires, ' +
        'is_persistent, samesite, source_scheme, source_port, ' +
        'last_access_utc, last_update_utc, creation_utc, priority ' +
        'FROM cookies',
    )
    return _rowsToObjects(res).map((r) => ({
      host_key: r.host_key,
      top_frame_site_key: r.top_frame_site_key,
      name: r.name,
      value: r.value,
      encrypted_value: r.encrypted_value, // Uint8Array
      path: r.path,
      expires_utc: r.expires_utc,
      is_secure: !!r.is_secure,
      is_httponly: !!r.is_httponly,
      has_expires: !!r.has_expires,
      is_persistent: !!r.is_persistent,
      samesite: r.samesite,
      source_scheme: r.source_scheme,
      source_port: r.source_port,
      last_access_utc: r.last_access_utc,
      last_update_utc: r.last_update_utc,
      creation_utc: r.creation_utc,
      priority: r.priority,
    }))
  } finally {
    db.close()
  }
}

// readProjectsList(dataDir) → [uuid, uuid, ...]
function readProjectsList(dataDir) {
  const p = path.join(dataDir, 'Default/Projects/projects_list.json')
  const raw = _readJsonSafe(p)
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string')
  if (Array.isArray(raw.projects)) {
    return raw.projects.filter((x) => typeof x === 'string')
  }
  return []
}

// readProject(dataDir, uuid) → { id, name, identities: Set, tabs, windows,
//   graveyard, raw } or null if not found
function readProject(dataDir, uuid) {
  const p = path.join(dataDir, 'Default/Projects', uuid, 'project.json')
  const raw = _readJsonSafe(p)
  if (!raw) return null
  const identities = new Set()
  const tabs = []
  const windows = Array.isArray(raw.windows) ? raw.windows : []
  for (const w of windows) {
    const wtabs = Array.isArray(w.tabs) ? w.tabs : []
    for (const t of wtabs) {
      if (t.identity && typeof t.identity === 'string') identities.add(t.identity)
      tabs.push({
        url: t.url || null,
        title: t.title || null,
        identityHash: t.identity || null,
        favicon: t.favicon || null,
        guid: t.guid || null,
      })
    }
  }
  return {
    id: raw.id || uuid,
    name: raw.name || null,
    identities,
    tabs,
    windows,
    graveyard: raw.graveyard || {},
    raw,
  }
}

// listProjectDirs(dataDir) → [uuid, ...] (all dirs in Projects/, excluding
// 'archived'). Useful for detecting orphan dirs (on disk but not in
// projects_list.json).
function listProjectDirs(dataDir) {
  const p = path.join(dataDir, 'Default/Projects')
  if (!fs.existsSync(p)) return []
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archived')
    .map((e) => e.name)
}

// readBookmarks(dataDir) → [{ url, title, dateAdded, folder }]
// Empty array if Bookmarks file is missing (Ghost doesn't always create it).
function readBookmarks(dataDir) {
  const p = path.join(dataDir, 'Default/Bookmarks')
  const raw = _readJsonSafe(p)
  if (!raw || !raw.roots) return []
  const out = []
  function walk(node, folder) {
    if (!node) return
    if (node.type === 'url') {
      out.push({
        url: node.url || null,
        title: node.name || null,
        dateAdded: node.date_added || null,
        folder: folder || null,
      })
    } else if (node.type === 'folder' && Array.isArray(node.children)) {
      const nextFolder = node.name
        ? folder
          ? `${folder}/${node.name}`
          : node.name
        : folder
      for (const c of node.children) walk(c, nextFolder)
    }
  }
  for (const key of Object.keys(raw.roots)) {
    walk(raw.roots[key], null)
  }
  return out
}

// readLoginData(dataDir, { initSqlJs? }) → Promise<[...]>
// Pool-global passwords from Default/Login Data. Per-identity Login Data
// files exist in Ghost but are empty stubs (no 'logins' table) — confirmed
// against real install. password_value is Uint8Array (raw encrypted blob).
async function readLoginData(dataDir, opts = {}) {
  const filePath = path.join(dataDir, 'Default/Login Data')
  if (!fs.existsSync(filePath)) return []
  const SQL = await _getSql(opts.initSqlJs)
  const db = _openDb(SQL, filePath)
  try {
    // Check the 'logins' table exists — per-identity Login Data files may
    // be passed by mistake and don't have it.
    const tables = _execAll(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='logins'",
    )
    if (!tables.rows.length) return []
    const res = _execAll(
      db,
      'SELECT origin_url, action_url, username_element, username_value, ' +
        'password_element, password_value, signon_realm, date_created, ' +
        'date_last_used, scheme, blacklisted_by_user ' +
        'FROM logins',
    )
    return _rowsToObjects(res).map((r) => ({
      origin_url: r.origin_url,
      action_url: r.action_url,
      username_element: r.username_element,
      username_value: r.username_value,
      password_element: r.password_element,
      password_value: r.password_value, // Uint8Array
      signon_realm: r.signon_realm,
      date_created: r.date_created,
      date_last_used: r.date_last_used,
      scheme: r.scheme,
      blacklisted_by_user: !!r.blacklisted_by_user,
    }))
  } finally {
    db.close()
  }
}

// readDefaultCookies(dataDir, { initSqlJs? }) → Promise<[...]>
// Pool-global cookies from Default/Cookies. Typically Ghost welcome-page
// stuff; G-2 importer can skip these. Same shape as per-identity cookies.
async function readDefaultCookies(dataDir, opts = {}) {
  const filePath = path.join(dataDir, 'Default/Cookies')
  return _readCookiesFile(filePath, opts.initSqlJs)
}

// archived(dataDir) → [uuid, ...]
function archived(dataDir) {
  const p = path.join(dataDir, 'Default/Projects/archived')
  if (!fs.existsSync(p)) return []
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

module.exports = {
  detectInstall,
  readIdentitiesIndex,
  readIdentity,
  readProjectsList,
  readProject,
  listProjectDirs,
  readBookmarks,
  readLoginData,
  readDefaultCookies,
  archived,
  _resetSqlCache, // exposed for tests only
}
