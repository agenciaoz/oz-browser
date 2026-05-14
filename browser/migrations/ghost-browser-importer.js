// OZ Browser — Ghost Browser importer (G-2b).
//
// Orchestrates the full import flow from a Ghost Browser data dir into
// OZ state. Wires reader (G-1) + crypto (G-2a) to identityManager,
// workspaceManager, bookmarkManager, accountVault, backupManager. Uses a
// sidecar state file (`userData/data/ghost-migration-state.json`) for
// idempotency — the wizard (G-3) consults this to offer skip/re-merge.
//
// Public API:
//   - dryRun({ reader, crypto?, ghostDataDir, options? }) → Promise<plan>
//     Pre-computes counts without touching OZ state. Used by Preview.
//     `crypto` is optional — if omitted (or no Keychain key fetchable),
//     password/cookie counts are reported as encrypted blob counts rather
//     than decrypted plaintext counts.
//
//   - runImport({ reader, crypto, ghostDataDir, deps, options? })
//       → Promise<summary>
//     Performs the actual import. `deps` must expose:
//       identityManager, workspaceManager, bookmarkManager (optional),
//       accountVault, backupManager, getSession(identityId) → Session,
//       userDataDir
//     Returns a summary { ok, snapshotId, identityMap, workspaceMap,
//       counts: { identities, cookies, workspaces, bookmarks, passwords },
//       skipped: { cookies: N, passwords: N }, error? }
//
// Decisions baked here:
//   - Passwords import with identityId = null (Ghost passwords are pool-
//     global, no identity binding; user reassigns later via UI).
//   - Default/Cookies (pool-global) are NOT imported by default — they are
//     mostly Ghost welcome-page cookies. Set options.includeDefaultCookies
//     true to import them under a synthetic "Imported default" identity.
//   - Orphan project dirs (on disk but not in projects_list.json) are
//     IGNORED. Only projects in the active list become workspaces.
//   - Bookmarks: imported if the file exists. Joses install has no
//     Bookmarks file; module just skips silently.
//   - On any throw mid-import, snapshot is restored automatically (via
//     backupManager.restoreSnapshot) and the state file is not updated.

const fs = require('fs')
const path = require('path')

const STATE_FILENAME = 'ghost-migration-state.json'

// Chrome's epoch is 1601-01-01; Unix's is 1970-01-01. Diff = 11644473600 sec.
const CHROME_EPOCH_DELTA_SEC = 11644473600

// Chromium samesite int → Electron string mapping.
const SAMESITE_MAP = {
  '-1': 'unspecified',
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
  3: 'unspecified',
}

function _stateFilePath(userDataDir) {
  return path.join(userDataDir, 'data', STATE_FILENAME)
}

function _loadState(userDataDir) {
  if (!userDataDir) return null
  const p = _stateFilePath(userDataDir)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (_err) {
    return null
  }
}

function _saveState(userDataDir, state) {
  const p = _stateFilePath(userDataDir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8')
}

function _defaultOptions(opts = {}) {
  return {
    importIdentities: opts.importIdentities !== false,
    importCookies: opts.importCookies !== false,
    importWorkspaces: opts.importWorkspaces !== false,
    importBookmarks: opts.importBookmarks !== false,
    importPasswords: opts.importPasswords !== false,
    includeDefaultCookies: !!opts.includeDefaultCookies,
    includeArchived: !!opts.includeArchived,
  }
}

// _chromeTimeToUnixSec(chromeMicros) → number (Unix epoch seconds)
// Returns 0 if input is falsy or before 1970 (cookies without expires_utc).
function _chromeTimeToUnixSec(chromeMicros) {
  if (!chromeMicros) return 0
  const seconds = Number(chromeMicros) / 1e6 - CHROME_EPOCH_DELTA_SEC
  return seconds > 0 ? Math.floor(seconds) : 0
}

// _cookieDetailsForElectron(ghostCookie) → details object for session.cookies.set()
// Maps Ghost / Chromium cookie row to Electron's API shape. Returns null if
// the cookie has no decrypted plaintext (skipped).
function _cookieDetailsForElectron(c) {
  if (c.value_plaintext === null || c.value_plaintext === undefined) return null
  const isHostOnly = !c.host_key.startsWith('.')
  const domain = isHostOnly ? c.host_key : c.host_key.slice(1) // strip leading dot
  const scheme = c.source_scheme === 1 ? 'http' : 'https' // Chromium 1=http, 2=https
  const url = `${scheme}://${domain}${c.path || '/'}`
  const details = {
    url,
    name: c.name,
    value: c.value_plaintext,
    path: c.path || '/',
    secure: !!c.is_secure,
    httpOnly: !!c.is_httponly,
    sameSite: SAMESITE_MAP[String(c.samesite)] || 'unspecified',
  }
  if (!isHostOnly) details.domain = c.host_key
  if (c.has_expires && c.expires_utc) {
    const exp = _chromeTimeToUnixSec(c.expires_utc)
    if (exp > 0) details.expirationDate = exp
  }
  return details
}

// _buildAccountFromLogin(login, now) → OZ account object
// Matches the OZ vault Account model (see account-handlers.js). Origin URL
// is preserved in `site` (we keep full URL for reassignment context); UI
// can extract hostname for display.
function _buildAccountFromLogin(login, now) {
  return {
    id: _uuid(),
    identityId: null, // unassigned — user reassigns via UI
    workspaceId: null,
    site: login.origin_url || login.signon_realm || '',
    username: login.username_value || '',
    password: login.password_plaintext || '',
    totpSecret: null,
    cookies: null,
    lastLoginAt: null,
    lastIp: null,
    status: 'active',
    notes: `Imported from Ghost Browser ${new Date(now).toISOString().slice(0, 10)}`,
    customFields: { importedFrom: 'ghost-browser' },
    createdAt: now,
    updatedAt: now,
  }
}

function _uuid() {
  return require('crypto').randomBytes(8).toString('hex')
}

// dryRun — computes counts without writing.
async function dryRun({ reader, crypto: gc, ghostDataDir, options = {} }) {
  const opts = _defaultOptions(options)
  const hashes = reader.readIdentitiesIndex(ghostDataDir)
  const projects = reader.readProjectsList(ghostDataDir)
  const archived = reader.archived(ghostDataDir)

  let totalCookies = 0
  for (const h of hashes) {
    const id = await reader.readIdentity(ghostDataDir, h)
    totalCookies += id.cookies.length
  }
  const defaultCookies = await reader.readDefaultCookies(ghostDataDir)
  const logins = await reader.readLoginData(ghostDataDir)
  const bookmarks = reader.readBookmarks(ghostDataDir)

  return {
    options: opts,
    counts: {
      identities: hashes.length,
      workspaces: projects.length,
      archived: archived.length,
      cookies: totalCookies,
      defaultCookies: defaultCookies.length,
      bookmarks: bookmarks.length,
      passwords: logins.length,
    },
    // For Preview UI — list of identity hashes + project uuids that WILL
    // be imported under current options.
    plan: {
      identityHashes: opts.importIdentities ? hashes : [],
      projectUuids: opts.importWorkspaces ? projects : [],
    },
  }
}

// runImport — full pipeline. Throws-then-rolls-back on failure.
async function runImport({ reader, crypto: gc, ghostDataDir, deps, options = {} }) {
  const opts = _defaultOptions(options)
  const t0 = Date.now()
  const summary = {
    ok: false,
    snapshotId: null,
    identityMap: {},
    workspaceMap: {},
    counts: {
      identities: 0,
      cookies: 0,
      workspaces: 0,
      bookmarks: 0,
      passwords: 0,
    },
    skipped: { cookies: 0, passwords: 0 },
    error: null,
  }

  // Pre-flight
  if (!deps || !deps.accountVault || !deps.identityManager) {
    summary.error = {
      code: 'BAD_DEPS',
      message: 'missing accountVault or identityManager',
    }
    return summary
  }
  if (!deps.accountVault.isUnlocked) {
    summary.error = { code: 'VAULT_LOCKED', message: 'Vault must be unlocked' }
    return summary
  }

  // Snapshot
  let snap = null
  if (deps.backupManager && typeof deps.backupManager.createSnapshot === 'function') {
    try {
      snap = deps.backupManager.createSnapshot({ reason: 'pre-ghost-migration' })
      summary.snapshotId = snap && snap.id ? snap.id : null
    } catch (err) {
      summary.error = { code: 'SNAPSHOT_FAILED', message: err.message }
      return summary
    }
  }

  try {
    // Fetch Keychain key. If denied/missing, we still do identities +
    // workspaces + bookmarks; cookies + passwords get skipped.
    let derivedKey = null
    let keychainError = null
    if (opts.importCookies || opts.importPasswords) {
      try {
        const safeKey = await gc.fetchGhostKeychainKey()
        derivedKey = gc.deriveKey(safeKey)
      } catch (err) {
        keychainError = err.code || 'KEYCHAIN_FAILURE'
        // Non-fatal — log and continue without crypto-dependent imports.
      }
    }

    // 1. Identities
    const ghostHashes = reader.readIdentitiesIndex(ghostDataDir)
    const ghostIdentityData = []
    for (const hash of ghostHashes) {
      ghostIdentityData.push(await reader.readIdentity(ghostDataDir, hash))
    }

    if (opts.importIdentities) {
      for (const id of ghostIdentityData) {
        const ozId = deps.identityManager.create({
          name: id.metadata.name || 'Imported',
          color: id.metadata.color || undefined,
        })
        summary.identityMap[id.hash] = ozId.id
        summary.counts.identities++
      }
    }

    // 2. Cookies — only if we have a key AND identities mapping
    if (opts.importCookies && derivedKey && deps.getSession) {
      for (const id of ghostIdentityData) {
        const ozId = summary.identityMap[id.hash]
        if (!ozId) continue
        const session = deps.getSession(ozId)
        if (!session || !session.cookies || typeof session.cookies.set !== 'function') {
          continue
        }
        const decrypted = gc.decryptCookies(id.cookies, derivedKey)
        for (const c of decrypted) {
          if (c._decryptError) {
            summary.skipped.cookies++
            continue
          }
          const det = _cookieDetailsForElectron(c)
          if (!det) {
            summary.skipped.cookies++
            continue
          }
          try {
            await session.cookies.set(det)
            summary.counts.cookies++
          } catch (_err) {
            summary.skipped.cookies++
          }
        }
      }
    }

    // 3. Workspaces
    if (opts.importWorkspaces && deps.workspaceManager) {
      const projectUuids = reader.readProjectsList(ghostDataDir)
      for (const uuid of projectUuids) {
        const proj = reader.readProject(ghostDataDir, uuid)
        if (!proj) continue
        const ws = deps.workspaceManager.create({ name: proj.name || 'Imported' })
        summary.workspaceMap[uuid] = ws.id
        summary.counts.workspaces++
        for (const ghostHash of proj.identities) {
          const ozId = summary.identityMap[ghostHash]
          if (ozId) deps.workspaceManager.addIdentity(ws.id, ozId)
        }
        // Build tabSpecs with OZ identity ids.
        const tabSpecs = []
        for (const tab of proj.tabs) {
          const ozId = tab.identityHash ? summary.identityMap[tab.identityHash] : null
          tabSpecs.push({
            id: _uuid(),
            url: tab.url || '',
            title: tab.title || '',
            identityId: ozId || null,
          })
        }
        if (typeof deps.workspaceManager.setTabSpecs === 'function') {
          deps.workspaceManager.setTabSpecs(ws.id, tabSpecs, null)
        }
      }
    }

    // 4. Bookmarks
    //
    // Ghost stores bookmarks pool-global (Chromium Default/Bookmarks). They
    // have no per-identity binding, so we assign them to the 'default'
    // identity — the closest semantic match. User can reassign via UI.
    //
    // Real OZ BookmarkManager.add() requires `identityId` (returns null +
    // warns when missing). Earlier G-2b versions omitted it; the G-4 e2e
    // test against the real manager surfaces this. We also only count the
    // bookmark when add() returns a non-deduped record.
    if (opts.importBookmarks && deps.bookmarkManager) {
      const bookmarks = reader.readBookmarks(ghostDataDir)
      const bookmarkIdentityId = opts.bookmarkIdentityId || 'default'
      for (const bk of bookmarks) {
        if (!bk.url) continue
        try {
          const created = deps.bookmarkManager.add({
            identityId: bookmarkIdentityId,
            url: bk.url,
            title: bk.title || bk.url,
            folder: bk.folder || null,
          })
          if (created && !created.deduped) summary.counts.bookmarks++
        } catch (_err) {
          // dedup or other non-fatal — skip silently
        }
      }
    }

    // 5. Passwords (append to vault, identityId=null)
    if (opts.importPasswords && derivedKey) {
      const logins = await reader.readLoginData(ghostDataDir)
      const decrypted = gc.decryptPasswords(logins, derivedKey)
      const now = Date.now()
      const newAccounts = []
      for (const login of decrypted) {
        if (login._decryptError) {
          summary.skipped.passwords++
          continue
        }
        newAccounts.push(_buildAccountFromLogin(login, now))
      }
      if (newAccounts.length) {
        const existing = deps.accountVault.getAccounts()
        deps.accountVault.setAccounts([...existing, ...newAccounts])
        summary.counts.passwords = newAccounts.length
      }
    }

    // Save state for idempotency (G-3 wizard reads this).
    if (deps.userDataDir) {
      _saveState(deps.userDataDir, {
        version: 1,
        lastImportAt: new Date().toISOString(),
        ghostDataDir,
        durationMs: Date.now() - t0,
        identityMap: summary.identityMap,
        workspaceMap: summary.workspaceMap,
        counts: summary.counts,
        skipped: summary.skipped,
        keychainError,
      })
    }

    summary.ok = true
    summary.keychainError = keychainError
    return summary
  } catch (err) {
    summary.error = { code: 'IMPORT_FAILED', message: err.message, stack: err.stack }
    // Best-effort rollback. If restore is unavailable, leave the partial
    // state and surface the error — caller can decide what to do.
    if (
      snap &&
      deps.backupManager &&
      typeof deps.backupManager.restoreSnapshot === 'function'
    ) {
      try {
        await deps.backupManager.restoreSnapshot(snap.id || snap)
        summary.rolledBack = true
      } catch (rollbackErr) {
        summary.rollbackError = { code: 'ROLLBACK_FAILED', message: rollbackErr.message }
      }
    }
    return summary
  }
}

// readState — exposed for G-3 wizard ("already imported?" check).
function readState(userDataDir) {
  return _loadState(userDataDir)
}

// clearState — exposed for "forget import history" button in Settings.
function clearState(userDataDir) {
  const p = _stateFilePath(userDataDir)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

module.exports = {
  dryRun,
  runImport,
  readState,
  clearState,
  // helpers exposed for tests:
  _cookieDetailsForElectron,
  _buildAccountFromLogin,
  _chromeTimeToUnixSec,
  STATE_FILENAME,
  SAMESITE_MAP,
}
