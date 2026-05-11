// OZ Browser — Bulk multi-account opener (C-4).
//
// Use case real (Jose, social media management): "Tengo 30 cuentas IG y quiero
// abrirlas todas con instagram.com en un workspace nuevo, una tab por
// identity, sin clickear 30 veces." Este módulo orquesta las primitivas
// existentes (IdentityManager, WorkspaceManager, tab-handlers) para soportar
// dos modos:
//
//   • fromExisting:  abre N identities ya creadas, una tab cada una.
//   • createNew:     crea N identities nuevas con pattern de naming, abre
//                    una tab por cada una.
//
// El target workspace puede ser uno existente o uno nuevo auto-creado. Cuando
// las identities seleccionadas viven en otro workspace, las cascade-movemos al
// target (per ADR 0023 D2: 1 identity = 1 workspace). Locked identities NO
// se mueven (per D5) — las skipeamos y se reportan en `errors`.
//
// Pure module — los managers entran inyectados, así puedo testear sin Electron.
//
// Doc: docs/modules/bulk-opener.md (created in C-4 close)
// Tests: tests/bulk-opener.smoketest.js
// Exports: bulkOpenFromExisting, bulkCreateNew, resolveUrlPattern,
//          resolveNamePattern, validateInput

'use strict'

// URL / name pattern token: `{n}` is the 1-indexed iteration counter.
// Example: 'IG Account {n}' with N=3 → ['IG Account 1', 'IG Account 2', 'IG Account 3'].
// Also accepted: `{i}` (0-indexed, mirror of bulkCreateLazy convention).
function resolveTemplate(template, n, i) {
  if (typeof template !== 'string') return template
  return template.replace(/\{n\}/g, String(n)).replace(/\{i\}/g, String(i))
}

// Same as above but exported so tests + UI preview can reuse.
function resolveUrlPattern(template, n) {
  return resolveTemplate(template, n, n - 1)
}
function resolveNamePattern(template, n) {
  return resolveTemplate(template, n, n - 1)
}

// Validate the form input early so the UI can show errors without invoking
// the managers. Returns { ok: true } or { ok: false, reason, field }.
function validateInput(input) {
  const mode = input && input.mode
  if (mode !== 'fromExisting' && mode !== 'createNew') {
    return { ok: false, reason: 'invalid-mode', field: 'mode' }
  }
  if (mode === 'fromExisting') {
    if (!Array.isArray(input.identityIds) || input.identityIds.length === 0) {
      return { ok: false, reason: 'no-identities-selected', field: 'identityIds' }
    }
    if (input.identityIds.length > 200) {
      return { ok: false, reason: 'too-many-identities', field: 'identityIds' }
    }
  }
  if (mode === 'createNew') {
    const count = Number(input.count)
    if (!Number.isFinite(count) || count < 1 || count > 200) {
      return { ok: false, reason: 'invalid-count', field: 'count' }
    }
    if (!input.namePattern || typeof input.namePattern !== 'string') {
      return { ok: false, reason: 'name-pattern-required', field: 'namePattern' }
    }
  }
  return { ok: true }
}

// Resolve the target workspace. Returns { ok, workspaceId, created } or error.
// `target` shape:
//   { kind: 'current', workspaceId }     — use an existing ws (current or any)
//   { kind: 'new', name?, color? }       — create a new ws
function resolveTargetWorkspace(target, deps) {
  const { workspaceManager, log } = deps
  if (!target || !target.kind) {
    return { ok: false, reason: 'no-target' }
  }
  if (target.kind === 'current') {
    if (!target.workspaceId) return { ok: false, reason: 'no-workspace-id' }
    const ws = workspaceManager.get(target.workspaceId)
    if (!ws) return { ok: false, reason: 'workspace-not-found' }
    if (ws.isArchived) return { ok: false, reason: 'workspace-archived' }
    return { ok: true, workspaceId: target.workspaceId, created: false }
  }
  if (target.kind === 'new') {
    const name = target.name || `Bulk Open — ${new Date().toISOString().slice(0, 16)}`
    const color = target.color || '#6b8e9f'
    const ws = workspaceManager.create({ name, color })
    if (!ws || !ws.id) {
      if (log) log.warn('bulk-opener', 'workspace create failed')
      return { ok: false, reason: 'workspace-create-failed' }
    }
    return { ok: true, workspaceId: ws.id, created: true }
  }
  return { ok: false, reason: 'unknown-target-kind' }
}

/**
 * Open N existing identities, one tab each.
 *
 * @param {object} input
 * @param {string[]} input.identityIds      — identities to open
 * @param {string}   [input.urlPattern]     — URL or template with {n}/{i}; default 'about:blank'
 * @param {object}   input.target           — { kind: 'current'|'new', ... }
 * @param {object}   deps                   — injected managers
 * @returns {object} { ok, opened: [{identityId, tabId, url}], errors: [{identityId, reason}], workspaceId }
 */
function bulkOpenFromExisting(input, deps) {
  const { identityManager, tabsHandlers, log } = deps
  const v = validateInput({ mode: 'fromExisting', ...input })
  if (!v.ok) return { ok: false, ...v, opened: [], errors: [] }

  const wsResult = resolveTargetWorkspace(input.target, deps)
  if (!wsResult.ok) {
    return { ok: false, reason: wsResult.reason, opened: [], errors: [] }
  }
  const targetWorkspaceId = wsResult.workspaceId

  const opened = []
  const errors = []
  let counter = 0
  for (const identityId of input.identityIds) {
    counter += 1
    const ident = identityManager.get
      ? identityManager.get(identityId)
      : identityManager.list().find((i) => i.id === identityId)
    if (!ident) {
      errors.push({ identityId, reason: 'identity-not-found' })
      continue
    }

    // Move identity to target workspace if not already there.
    if (ident.workspaceId !== targetWorkspaceId) {
      const mv = identityManager.moveToWorkspace(identityId, targetWorkspaceId)
      if (!mv || mv.ok === false) {
        // locked / default / etc — skip but report.
        errors.push({
          identityId,
          reason: (mv && mv.reason) || 'move-failed',
          name: ident.name,
        })
        if (log) {
          log.warn('bulk-opener', 'skip move failure', {
            identityId,
            reason: mv && mv.reason,
          })
        }
        continue
      }
    }

    // Open a tab in this identity.
    const url = input.urlPattern
      ? resolveUrlPattern(input.urlPattern, counter)
      : 'about:blank'
    const tab = tabsHandlers.openInIdentity(identityId, url)
    if (!tab || (tab.ok === false && !tab.id)) {
      errors.push({ identityId, reason: 'open-failed', name: ident.name })
      continue
    }
    opened.push({
      identityId,
      tabId: tab.id != null ? tab.id : null,
      url,
      name: ident.name,
    })
  }

  if (log) {
    log.info('bulk-opener', 'fromExisting done', {
      requested: input.identityIds.length,
      opened: opened.length,
      errors: errors.length,
      workspaceId: targetWorkspaceId,
      workspaceCreated: wsResult.created,
    })
  }

  return {
    ok: true,
    opened,
    errors,
    workspaceId: targetWorkspaceId,
    workspaceCreated: wsResult.created,
  }
}

/**
 * Create N new identities and open one tab each.
 *
 * @param {object} input
 * @param {number} input.count              — how many to create
 * @param {string} input.namePattern        — e.g. 'IG Account {n}'
 * @param {string} [input.color]            — color applied to all (UI can offer randomize later)
 * @param {string} [input.urlPattern]       — same template token as namePattern
 * @param {object} input.target             — { kind: 'current'|'new', ... }
 * @param {object} deps                     — injected managers
 * @returns {object} { ok, created: [{identityId, tabId, name, url}], errors, workspaceId }
 */
function bulkCreateNew(input, deps) {
  const { identityManager, tabsHandlers, log } = deps
  const v = validateInput({ mode: 'createNew', ...input })
  if (!v.ok) return { ok: false, ...v, created: [], errors: [] }

  const wsResult = resolveTargetWorkspace(input.target, deps)
  if (!wsResult.ok) {
    return { ok: false, reason: wsResult.reason, created: [], errors: [] }
  }
  const targetWorkspaceId = wsResult.workspaceId

  const created = []
  const errors = []
  for (let n = 1; n <= input.count; n++) {
    const name = resolveNamePattern(input.namePattern, n)
    const ident = identityManager.create({
      name,
      color: input.color,
      workspaceId: targetWorkspaceId,
    })
    if (!ident || !ident.id) {
      errors.push({ n, reason: 'identity-create-failed', name })
      continue
    }
    const url = input.urlPattern ? resolveUrlPattern(input.urlPattern, n) : 'about:blank'
    const tab = tabsHandlers.openInIdentity(ident.id, url)
    if (!tab || (tab.ok === false && !tab.id)) {
      errors.push({ n, reason: 'open-failed', identityId: ident.id, name })
      continue
    }
    created.push({
      identityId: ident.id,
      tabId: tab.id != null ? tab.id : null,
      name,
      url,
    })
  }

  if (log) {
    log.info('bulk-opener', 'createNew done', {
      requested: input.count,
      created: created.length,
      errors: errors.length,
      workspaceId: targetWorkspaceId,
      workspaceCreated: wsResult.created,
    })
  }

  return {
    ok: true,
    created,
    errors,
    workspaceId: targetWorkspaceId,
    workspaceCreated: wsResult.created,
  }
}

module.exports = {
  bulkOpenFromExisting,
  bulkCreateNew,
  resolveUrlPattern,
  resolveNamePattern,
  resolveTargetWorkspace,
  validateInput,
}
