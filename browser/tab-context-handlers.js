// OZ Browser — Tab context-menu domain handlers (1.7).
//
// Qué hace: factoriza la lógica de los items del context menu (Ghost-style 16
// opciones) en handlers puros consumibles tanto por IPC (oz:tabs:*) como por
// MCP (oz.tabs.*).
//
// Doc: docs/modules/tab-context-handlers.md
// ADR: docs/architecture/0016-tab-context-menu.md
//
// Exports: buildTabContextHandlers(browser) -> Record<string, (args) => any>
//
// Convención: spread'eados sobre browser.handlers.tabs en ipc-handlers.js — los
// nombres NO chocan con los del tab-handlers.js (list/openInIdentity/select/close/
// moveToWorkspace/getIdentity/bulkCreateLazy).
//
// Notas:
//  - Todos los handlers retornan {ok: false, reason: '...'} con códigos
//    estables, NUNCA throw — para que el consumer (IPC + MCP) muestre errores
//    estructurados en vez de crashes.
//  - moveToNewWindow auto-crea un workspace "Window N" porque ADR 0015 dice
//    1 ventana = 1 workspace (no se puede compartir).
//  - duplicateInTemporary crea una identity nueva "Temp YYYY-MM-DD HH:MM" en
//    cada llamada — sin reuso, para que el user pueda borrarla sin afectar
//    otras tabs temporales que abrió antes (privacidad).

const log = require('./logger')

function buildTabContextHandlers(browser) {
  const im = () => browser.identityManager
  const wm = () => browser.workspaceManager

  // Find which window owns a tab. Returns { win, tab } or null.
  function findOwning(tabId) {
    for (const w of browser.windows || []) {
      const t = w.tabs && w.tabs.get && w.tabs.get(tabId)
      if (t) return { win: w, tab: t }
    }
    return null
  }

  // Insert a new tab right after the source tab in the same window's tabList.
  // Used by all duplicate* handlers so the clone appears next to its source.
  function insertAfter(win, sourceTabId, opts) {
    const newTab = win.tabs.create(opts)
    const list = win.tabs.tabList
    const srcIdx = list.findIndex((t) => t.id === sourceTabId)
    const newIdx = list.findIndex((t) => t.id === newTab.id)
    if (srcIdx >= 0 && newIdx >= 0 && newIdx !== srcIdx + 1) {
      list.splice(newIdx, 1)
      list.splice(srcIdx + 1, 0, newTab)
    }
    return newTab
  }

  return {
    // ---------- Reload ----------
    reload(tabId) {
      const found = findOwning(tabId)
      if (!found) return { ok: false, reason: 'tab-not-found', tabId }
      if (typeof found.tab.reload === 'function') found.tab.reload()
      log.info('tab-context', 'reload', { tabId, windowId: found.win.id })
      return { ok: true, tabId }
    },

    // ---------- Duplicate variants ----------

    /** Same identity as the source. Inserted right after source in its window. */
    duplicate(tabId) {
      const found = findOwning(tabId)
      if (!found) return { ok: false, reason: 'tab-not-found', tabId }
      const spec = found.tab.toSpec ? found.tab.toSpec() : null
      if (!spec) return { ok: false, reason: 'cannot-serialize-tab', tabId }
      const clone = insertAfter(found.win, tabId, {
        identityId: spec.identityId,
        url: spec.url,
        title: spec.title,
        favicon: spec.favicon,
        source: 'tab-context.duplicate',
      })
      browser.broadcastToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...clone.serialize(), windowId: found.win.id },
      })
      log.info('tab-context', 'duplicate ok', { sourceTabId: tabId, newTabId: clone.id })
      return { ok: true, tabId, newTabId: clone.id }
    },

    /** Clone into a fresh "Temp ..." identity. */
    duplicateInTemporary(tabId) {
      const found = findOwning(tabId)
      if (!found) return { ok: false, reason: 'tab-not-found', tabId }
      const spec = found.tab.toSpec ? found.tab.toSpec() : null
      if (!spec) return { ok: false, reason: 'cannot-serialize-tab', tabId }
      // Reuse identityManager.create — it returns a structured error if the
      // free-tier cap is hit, which we propagate to the caller.
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
      let tempIdent
      try {
        tempIdent = im().create({ name: `Temp ${stamp}`, color: '#a8a8a8' })
      } catch (err) {
        if (err && err.code === 'IDENTITY_CAP_REACHED') {
          return {
            ok: false,
            reason: 'identity-cap-reached',
            current: err.current,
            max: err.max,
          }
        }
        throw err
      }
      browser.broadcastToWebUI('oz:identities:changed')
      const clone = insertAfter(found.win, tabId, {
        identityId: tempIdent.id,
        url: spec.url,
        title: spec.title,
        favicon: spec.favicon,
        source: 'tab-context.duplicateInTemporary',
      })
      browser.broadcastToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...clone.serialize(), windowId: found.win.id },
      })
      log.info('tab-context', 'duplicateInTemporary ok', {
        sourceTabId: tabId,
        newTabId: clone.id,
        tempIdentityId: tempIdent.id,
      })
      return { ok: true, tabId, newTabId: clone.id, tempIdentityId: tempIdent.id }
    },

    /** Clone into an existing identity by id. */
    duplicateInIdentity(tabId, identityId) {
      const found = findOwning(tabId)
      if (!found) return { ok: false, reason: 'tab-not-found', tabId }
      const target = im().get(identityId)
      if (!target) return { ok: false, reason: 'identity-not-found', tabId, identityId }
      const spec = found.tab.toSpec ? found.tab.toSpec() : null
      if (!spec) return { ok: false, reason: 'cannot-serialize-tab', tabId }
      const clone = insertAfter(found.win, tabId, {
        identityId: target.id,
        url: spec.url,
        title: spec.title,
        favicon: spec.favicon,
        source: 'tab-context.duplicateInIdentity',
      })
      browser.broadcastToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...clone.serialize(), windowId: found.win.id },
      })
      log.info('tab-context', 'duplicateInIdentity ok', {
        sourceTabId: tabId,
        newTabId: clone.id,
        identityId: target.id,
      })
      return { ok: true, tabId, newTabId: clone.id, identityId: target.id }
    },

    /** Create a brand-new identity and clone into it. */
    duplicateInNewIdentity(tabId, name) {
      const found = findOwning(tabId)
      if (!found) return { ok: false, reason: 'tab-not-found', tabId }
      const spec = found.tab.toSpec ? found.tab.toSpec() : null
      if (!spec) return { ok: false, reason: 'cannot-serialize-tab', tabId }
      let newIdent
      try {
        newIdent = im().create({ name: name || 'New Identity' })
      } catch (err) {
        if (err && err.code === 'IDENTITY_CAP_REACHED') {
          return {
            ok: false,
            reason: 'identity-cap-reached',
            current: err.current,
            max: err.max,
          }
        }
        throw err
      }
      browser.broadcastToWebUI('oz:identities:changed')
      const clone = insertAfter(found.win, tabId, {
        identityId: newIdent.id,
        url: spec.url,
        title: spec.title,
        favicon: spec.favicon,
        source: 'tab-context.duplicateInNewIdentity',
      })
      browser.broadcastToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...clone.serialize(), windowId: found.win.id },
      })
      log.info('tab-context', 'duplicateInNewIdentity ok', {
        sourceTabId: tabId,
        newTabId: clone.id,
        identityId: newIdent.id,
      })
      return { ok: true, tabId, newTabId: clone.id, identityId: newIdent.id }
    },

    // ---------- Refresh All in this Identity ----------

    /**
     * Reload every materialized tab whose identityId === identityId, across all
     * windows. Lazy tabs are skipped (they reload fresh on materialize).
     * Returns count of tabs reloaded.
     */
    refreshAllInIdentity(identityId) {
      let count = 0
      for (const w of browser.windows || []) {
        for (const t of (w.tabs && w.tabs.tabList) || []) {
          if (t.identityId === identityId && t.materialized) {
            if (typeof t.reload === 'function') {
              t.reload()
              count += 1
            }
          }
        }
      }
      log.info('tab-context', 'refreshAllInIdentity ok', { identityId, count })
      return { ok: true, identityId, count }
    },

    // ---------- Move Tab to New Window ----------

    /**
     * Move a tab to a brand-new window. Because of the 1-1 lock (ADR 0015),
     * the new window needs its own workspace — we auto-create one named
     * "Window N" (next available integer). The tab is moved via
     * moveToWorkspace primitive (handled in tab-handlers.js).
     *
     * Returns { ok, tabId, newWindowId, newWorkspaceId } or {ok:false,reason}.
     */
    moveToNewWindow(tabId) {
      const found = findOwning(tabId)
      if (!found) return { ok: false, reason: 'tab-not-found', tabId }
      if (!wm()) return { ok: false, reason: 'no-workspace-manager' }
      // H2: locked tabs cannot be moved (would destroy the live tab in the
      // source window — equivalent to closing it).
      if (found.tab.locked) {
        log.warn('tab-context', 'moveToNewWindow blocked: tab is locked', { tabId })
        return { ok: false, reason: 'tab-locked', tabId }
      }
      // Pick a name not yet used.
      const existing = wm().list()
      let n = 2
      while (existing.some((ws) => ws.name === `Window ${n}`)) n += 1
      const newWs = wm().create({ name: `Window ${n}` })

      // Snapshot + remove the live tab from source. Persist spec into new WS.
      const spec = found.tab.toSpec()
      wm().appendTabSpec(newWs.id, spec)
      if (typeof wm().flush === 'function') wm().flush()
      found.win.tabs.remove(tabId)
      browser.broadcastToWebUI('oz:tabs:updated', { kind: 'removed', tabId })

      // Create the new window already targeting newWs — _createInitialTab
      // hydrates from tabSpecs (recreates our moved tab as lazy).
      const newWin = browser.createWindow
        ? browser.createWindow({ workspaceId: newWs.id })
        : null
      if (!newWin) {
        log.error('tab-context', 'moveToNewWindow: createWindow returned null', {
          tabId,
          newWorkspaceId: newWs.id,
        })
        return { ok: false, reason: 'create-window-failed', tabId }
      }
      log.info('tab-context', 'moveToNewWindow ok', {
        tabId,
        sourceWindowId: found.win.id,
        newWindowId: newWin.id,
        newWorkspaceId: newWs.id,
      })
      return {
        ok: true,
        tabId,
        sourceWindowId: found.win.id,
        newWindowId: newWin.id,
        newWorkspaceId: newWs.id,
      }
    },

    // ---------- Pin / Unpin ----------

    pin(tabId) {
      return setPinned(tabId, true)
    },
    unpin(tabId) {
      return setPinned(tabId, false)
    },

    // ---------- Lock / Unlock (H2) ----------
    // Lock = "no me cierres por accidente". Persisted in tabSpecs (same path
    // as pin). Locked tabs reject close + moveToWorkspace; closeOthers and
    // closeToRight silently skip them. Pin/mute/duplicate/reload still work.
    lock(tabId) {
      return setLocked(tabId, true)
    },
    unlock(tabId) {
      return setLocked(tabId, false)
    },

    // ---------- Mute / Unmute ----------

    mute(tabId) {
      return setMuted(tabId, true)
    },
    unmute(tabId) {
      return setMuted(tabId, false)
    },

    // ---------- Close variants ----------

    /**
     * Close every tab in the same window EXCEPT tabId. Pinned tabs are
     * preserved (Chrome convention). H2: locked tabs are also preserved.
     * Returns count closed + count skipped due to lock/pin.
     */
    closeOthers(tabId) {
      const found = findOwning(tabId)
      if (!found) return { ok: false, reason: 'tab-not-found', tabId }
      const others = found.win.tabs.tabList.filter((t) => t.id !== tabId)
      const toClose = others.filter((t) => !t.pinned && !t.locked).map((t) => t.id)
      const skippedLocked = others.filter((t) => t.locked).length
      for (const id of toClose) {
        found.win.tabs.remove(id)
        browser.broadcastToWebUI('oz:tabs:updated', { kind: 'removed', tabId: id })
      }
      log.info('tab-context', 'closeOthers ok', {
        keptTabId: tabId,
        closedCount: toClose.length,
        skippedLocked,
        windowId: found.win.id,
      })
      return { ok: true, tabId, closedCount: toClose.length, skippedLocked }
    },

    /**
     * Close every tab to the right of tabId in the same window's tabList order.
     * Pinned and locked (H2) tabs are preserved.
     */
    closeToRight(tabId) {
      const found = findOwning(tabId)
      if (!found) return { ok: false, reason: 'tab-not-found', tabId }
      const list = found.win.tabs.tabList
      const idx = list.findIndex((t) => t.id === tabId)
      if (idx < 0) return { ok: false, reason: 'tab-not-found', tabId }
      const right = list.slice(idx + 1)
      const toClose = right.filter((t) => !t.pinned && !t.locked).map((t) => t.id)
      const skippedLocked = right.filter((t) => t.locked).length
      for (const id of toClose) {
        found.win.tabs.remove(id)
        browser.broadcastToWebUI('oz:tabs:updated', { kind: 'removed', tabId: id })
      }
      log.info('tab-context', 'closeToRight ok', {
        anchorTabId: tabId,
        closedCount: toClose.length,
        skippedLocked,
        windowId: found.win.id,
      })
      return { ok: true, tabId, closedCount: toClose.length, skippedLocked }
    },
  }

  // ---- helpers (closure over browser) --------------------------------------

  function setPinned(tabId, pinned) {
    const found = findOwning(tabId)
    if (!found) return { ok: false, reason: 'tab-not-found', tabId }
    found.tab.pinned = !!pinned
    // Persist to the owning window's workspace immediately so the pin survives
    // a switch / restart without waiting for the next snapshot trigger.
    if (wm() && found.win.workspaceId) {
      const specs = found.win.tabs.toSpecs ? found.win.tabs.toSpecs() : []
      const activeId = found.win.tabs.selected ? found.win.tabs.selected.id : null
      wm().setTabSpecs(found.win.workspaceId, specs, activeId)
    }
    browser.broadcastToWebUI('oz:tabs:updated', {
      kind: 'updated',
      tabId,
      tab: { ...found.tab.serialize(), windowId: found.win.id },
    })
    log.info('tab-context', pinned ? 'pin ok' : 'unpin ok', {
      tabId,
      windowId: found.win.id,
    })
    return { ok: true, tabId, pinned: !!pinned }
  }

  function setLocked(tabId, locked) {
    const found = findOwning(tabId)
    if (!found) return { ok: false, reason: 'tab-not-found', tabId }
    found.tab.locked = !!locked
    // Persist to the owning window's workspace immediately (same path as pin).
    if (wm() && found.win.workspaceId) {
      const specs = found.win.tabs.toSpecs ? found.win.tabs.toSpecs() : []
      const activeId = found.win.tabs.selected ? found.win.tabs.selected.id : null
      wm().setTabSpecs(found.win.workspaceId, specs, activeId)
    }
    browser.broadcastToWebUI('oz:tabs:updated', {
      kind: 'updated',
      tabId,
      tab: { ...found.tab.serialize(), windowId: found.win.id },
    })
    log.info('tab-context', locked ? 'lock ok' : 'unlock ok', {
      tabId,
      windowId: found.win.id,
    })
    return { ok: true, tabId, locked: !!locked }
  }

  function setMuted(tabId, muted) {
    const found = findOwning(tabId)
    if (!found) return { ok: false, reason: 'tab-not-found', tabId }
    if (!found.tab.materialized || !found.tab.webContents) {
      // Lazy tabs don't have webContents yet — silently noop, don't error.
      log.debug('tab-context', 'mute on lazy tab — noop', { tabId, muted })
      return { ok: true, tabId, muted: !!muted, lazyNoop: true }
    }
    try {
      found.tab.webContents.setAudioMuted(!!muted)
    } catch (err) {
      log.warn('tab-context', 'setAudioMuted failed', {
        tabId,
        muted,
        message: err.message,
      })
      return { ok: false, reason: 'set-muted-failed', message: err.message }
    }
    log.info('tab-context', muted ? 'mute ok' : 'unmute ok', {
      tabId,
      windowId: found.win.id,
    })
    return { ok: true, tabId, muted: !!muted }
  }
}

module.exports = { buildTabContextHandlers }
