// OZ Browser — Excel I/O domain handlers (1.5e CORE).
//
// Doc: docs/modules/excel-handlers.md
// Bloque: 1.5e
//
// Handler map puro consumido por IPC y MCP. Vault gate uniforme — todas las
// operaciones requieren vault unlocked.
//
// Lógica de los 4 modos de import:
//   - PERMANENT_MERGE: por cada row del Excel, busca match (identityId, site,
//     username) en vault — si existe UPDATE, si no CREATE. Identities/workspaces
//     que no existen se crean (bulk identity creation).
//   - EPHEMERAL_SESSION: parsea pero NO persiste — devuelve la lista al caller.
//     1.5f UI maneja el flow de sessions in-memory.
//   - NEW_WORKSPACE: crea un workspace nuevo (nombre del file o auto-gen),
//     todos los accounts del Excel se asignan a este workspace nuevo. Sin
//     tocar workspaces/accounts existentes.
//   - OVERWRITE_TOTAL: REEMPLAZA todo el vault con el contenido del Excel.
//     ⚠️ Caller debe haber hecho snapshot Time Machine antes (1.6).

const { exportAccounts, importAccounts, IMPORT_MODES } = require('./excel-io')
const log = require('./logger')

function lockedError(msg) {
  return {
    __error: {
      code: 'LOCKED',
      message: msg || 'Vault is locked — call oz.vault.unlock() first',
    },
  }
}

function buildExcelHandlers(browser) {
  const v = () => browser.accountVault
  const im = () => browser.identityManager
  const wm = () => browser.workspaceManager

  function requireUnlocked() {
    const vault = v()
    if (!vault || !vault.isUnlocked) return null
    return vault
  }

  function buildMaps() {
    const identityById = {}
    const workspaceById = {}
    if (im()) for (const i of im().list()) identityById[i.id] = i.name
    if (wm()) for (const w of wm().list()) workspaceById[w.id] = w.name
    return { identityById, workspaceById }
  }

  // H3a (D6) — identity lookup is now scoped to a workspace. Two identities
  // with the same name in different workspaces are different identities.
  // Caller passes the resolved workspaceId; we never default it silently here.
  function findOrCreateIdentity(name, workspaceId) {
    if (!workspaceId) {
      throw new Error(
        'findOrCreateIdentity requires workspaceId (H3a D6 — identity name is scoped to a workspace)',
      )
    }
    const scoped = im().listByWorkspace(workspaceId)
    const existing = scoped.find((i) => i.name === name)
    if (existing) return existing.id
    const created = im().create({ name, workspaceId })
    log.info('excel-handlers', 'bulk identity created from import', {
      name,
      workspaceId,
      id: created.id,
    })
    return created.id
  }

  function findOrCreateWorkspace(name) {
    if (!name) return null
    const list = wm().list()
    const existing = list.find((w) => w.name === name)
    if (existing) return existing.id
    const created = wm().create({ name })
    log.info('excel-handlers', 'bulk workspace created from import', {
      name,
      id: created.id,
    })
    return created.id
  }

  return {
    /**
     * Export all vault accounts to .xlsx.
     * Returns { ok, filePath, rows } or { __error }.
     */
    async exportToFile(filePath) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()
      if (!filePath) {
        return {
          __error: { code: 'BAD_ARG', message: 'filePath is required' },
        }
      }
      try {
        const accounts = vault.getAccounts()
        const maps = buildMaps()
        const result = await exportAccounts(accounts, maps, filePath)
        return { ok: true, ...result }
      } catch (err) {
        log.error('excel-handlers', 'export failed', { message: err.message })
        return {
          __error: { code: 'EXPORT_FAILED', message: err.message },
        }
      }
    },

    /**
     * Import accounts from .xlsx with mode selection.
     * Returns { ok, mode, importedCount, identitiesCreated, workspacesCreated, ... }
     * or { __error }.
     */
    async importFromFile(filePath, mode) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()
      if (!filePath) {
        return { __error: { code: 'BAD_ARG', message: 'filePath is required' } }
      }
      if (!IMPORT_MODES.includes(mode)) {
        return {
          __error: {
            code: 'BAD_ARG',
            message: `mode must be one of ${IMPORT_MODES.join(', ')}`,
          },
        }
      }

      let parsed
      try {
        parsed = await importAccounts(filePath)
      } catch (err) {
        log.error('excel-handlers', 'import parse failed', { message: err.message })
        return { __error: { code: 'IMPORT_PARSE_FAILED', message: err.message } }
      }

      // EPHEMERAL_SESSION: don't persist, just return parsed rows.
      if (mode === 'EPHEMERAL_SESSION') {
        log.info('excel-handlers', 'import EPHEMERAL_SESSION (no persist)', {
          rows: parsed.rows.length,
        })
        return {
          ok: true,
          mode,
          importedCount: parsed.rows.length,
          ephemeralRows: parsed.rows, // caller (1.5f UI) handles in-memory sessions
        }
      }

      // H3a (D6) — for PERMANENT_MERGE / OVERWRITE_TOTAL the Excel rows MUST
      // carry a workspaceName column so identity lookups can be scoped to the
      // right workspace (D1: 1 identity = 1 workspace exact). Without the
      // column we cannot disambiguate two identities sharing a name across
      // workspaces. Reject early with a clear error so the user fixes the
      // file rather than silently importing into wrong workspaces.
      if (mode === 'PERMANENT_MERGE' || mode === 'OVERWRITE_TOTAL') {
        const missingWs = parsed.rows.filter(
          (r) => !r.workspaceName || r.workspaceName === '',
        )
        if (missingWs.length > 0) {
          log.warn('excel-handlers', 'import rejected: workspaceName missing', {
            mode,
            missingCount: missingWs.length,
            totalRows: parsed.rows.length,
          })
          return {
            __error: {
              code: 'WORKSPACE_NAME_REQUIRED',
              message: `H3a D6: ${mode} requires every row to have a workspaceName. ${missingWs.length}/${parsed.rows.length} rows missing it.`,
              missingCount: missingWs.length,
              totalRows: parsed.rows.length,
            },
          }
        }
      }

      // Resolve workspace names FIRST — identity lookups are scoped to a
      // workspace per D6.
      let dedicatedWorkspaceId = null
      const workspaceNameToId = {}
      const workspacesCreated = []

      if (mode === 'NEW_WORKSPACE') {
        // All accounts go into a single new workspace named after the import.
        const wsName = `Imported ${new Date().toISOString().slice(0, 10)}`
        const created = wm().create({ name: wsName })
        dedicatedWorkspaceId = created.id
        workspacesCreated.push(wsName)
      } else {
        for (const name of parsed.workspaceNamesNeeded) {
          const before = wm().list().length
          const id = findOrCreateWorkspace(name)
          workspaceNameToId[name] = id
          if (wm().list().length > before) workspacesCreated.push(name)
        }
      }

      // H3a (D6): identity name + workspaceId is the new uniqueness key.
      // We resolve identities row-by-row using each row's resolved workspace.
      const identityKeyToId = {}
      const identitiesCreated = []
      for (const row of parsed.rows) {
        const wsForRow =
          mode === 'NEW_WORKSPACE'
            ? dedicatedWorkspaceId
            : workspaceNameToId[row.workspaceName]
        if (!wsForRow) {
          // Should not happen given the early reject above + workspace
          // resolution loop, but defensive.
          continue
        }
        const key = `${wsForRow}::${row.identityName}`
        if (identityKeyToId[key]) continue
        const before = im().list().length
        const id = findOrCreateIdentity(row.identityName, wsForRow)
        identityKeyToId[key] = id
        if (im().list().length > before) {
          identitiesCreated.push(`${row.identityName} (in ${wsForRow})`)
        }
      }

      const newAccounts = parsed.rows.map((row) => {
        const wsForRow =
          mode === 'NEW_WORKSPACE'
            ? dedicatedWorkspaceId
            : workspaceNameToId[row.workspaceName] || null
        const key = wsForRow ? `${wsForRow}::${row.identityName}` : null
        return {
          id: _uuid(),
          identityId: key ? identityKeyToId[key] : null,
          workspaceId: wsForRow,
          site: row.site,
          username: row.username,
          password: row.password,
          totpSecret: row.totpSecret,
          cookies: null,
          lastLoginAt: row.lastLoginAt,
          lastIp: row.lastIp,
          status: row.status,
          notes: row.notes,
          customFields: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      })

      let finalAccounts
      let preDestructiveSnapshotId = null
      if (mode === 'OVERWRITE_TOTAL') {
        // Hotfix BugCrawl: ABORT si snapshot falla en vez de proceder
        // destructive sin posibilidad de revert. Mismo patrón que
        // backup-handlers.restore (que aborta con PRE_RESTORE_FAILED).
        // Sin BackupManager o vault locked → tampoco podemos hacer snapshot
        // → tampoco aceptamos OVERWRITE (caller debe pre-conditions).
        if (!browser.backupManager) {
          return {
            __error: {
              code: 'PRE_OVERWRITE_FAILED',
              message:
                'BackupManager not available — refusing destructive OVERWRITE_TOTAL without snapshot capability',
            },
          }
        }
        if (!browser.accountVault?.isUnlocked) {
          return {
            __error: {
              code: 'VAULT_LOCKED',
              message: 'Vault must be unlocked to capture pre-OVERWRITE snapshot',
            },
          }
        }
        try {
          const snap = browser.backupManager.createSnapshot({
            reason: 'pre-overwrite-total',
            label: `Pre-OVERWRITE Excel ${new Date().toISOString().slice(0, 19)}`,
          })
          preDestructiveSnapshotId = snap.id
          log.info('excel-handlers', 'pre-overwrite snapshot created', {
            snapshotId: snap.id,
          })
        } catch (err) {
          log.error('excel-handlers', 'pre-overwrite snapshot FAILED — ABORTING', {
            message: err.message,
          })
          return {
            __error: {
              code: 'PRE_OVERWRITE_FAILED',
              message: `Cannot capture pre-overwrite snapshot: ${err.message}. Refusing to proceed with destructive OVERWRITE_TOTAL.`,
            },
          }
        }
        finalAccounts = newAccounts
        log.warn('excel-handlers', 'OVERWRITE_TOTAL — vault REPLACED', {
          rowsImported: newAccounts.length,
          preDestructiveSnapshotId,
        })
      } else if (mode === 'PERMANENT_MERGE') {
        // Merge by (identityId, site, username) match.
        const existing = vault.getAccounts()
        const out = [...existing]
        let updated = 0
        let added = 0
        for (const fresh of newAccounts) {
          const idx = out.findIndex(
            (e) =>
              e.identityId === fresh.identityId &&
              e.site === fresh.site &&
              e.username === fresh.username,
          )
          if (idx >= 0) {
            out[idx] = { ...out[idx], ...fresh, id: out[idx].id }
            updated++
          } else {
            out.push(fresh)
            added++
          }
        }
        finalAccounts = out
        log.info('excel-handlers', 'PERMANENT_MERGE applied', { updated, added })
      } else if (mode === 'NEW_WORKSPACE') {
        // Append all new accounts (ignoring duplicates — they're a "fresh
        // batch" by design).
        finalAccounts = vault.getAccounts().concat(newAccounts)
        log.info('excel-handlers', 'NEW_WORKSPACE applied', {
          newAccounts: newAccounts.length,
          workspaceId: dedicatedWorkspaceId,
        })
      }

      vault.setAccounts(finalAccounts)
      browser.broadcastToWebUI('oz:accounts:changed')
      browser.broadcastToWebUI('oz:identities:changed')
      browser.broadcastToWebUI('oz:workspaces:changed')

      return {
        ok: true,
        mode,
        importedCount: newAccounts.length,
        finalAccountsCount: finalAccounts.length,
        identitiesCreated,
        workspacesCreated,
        dedicatedWorkspaceId,
        preDestructiveSnapshotId, // 1.6: rollback path for OVERWRITE_TOTAL
      }
    },
  }
}

function _uuid() {
  return require('crypto').randomBytes(8).toString('hex')
}

module.exports = { buildExcelHandlers, IMPORT_MODES }
