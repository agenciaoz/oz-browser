// OZ Browser — Tab domain handlers (pure map of name → fn).
//
// Qué hace: factoriza los IPC handlers de Tabs en un mapa consumible por IPC y MCP.
//
// Doc: docs/modules/tab-handlers.md
// ADR: docs/architecture/0012-oz-mcp-server.md
//
// Exports: buildTabHandlers(browser) -> Record<string, (args) => any>
// IPC: ninguno directo (los registra ipc-handlers.js).

const log = require('./logger')
const { normalizeOmniboxInput } = require('./url-normalize')

function buildTabHandlers(browser) {
  return {
    list() {
      const result = []
      for (const win of browser.windows) {
        for (const t of win.tabs.tabList) {
          result.push({ ...t.serialize(), windowId: win.id })
        }
      }
      return result
    },

    getIdentity(tabId) {
      for (const win of browser.windows) {
        const tab = win.tabs.get(tabId)
        if (tab) return tab.identityId
      }
      return null
    },

    openInIdentity(identityId, url) {
      const win = browser.getFocusedWindow()
      if (!win) {
        log.warn('tab-handlers', 'openInIdentity: no focused window')
        return null
      }
      // Hotfix BugCrawl: MCP/programmatic callers pueden pasar URL sin
      // scheme. Normalizar antes de tabs.create para que webContents.loadURL
      // no falle con ERR_INVALID_ARGUMENT silente al materializar.
      // about:blank y URLs sin valor pasan as-is via la ruta SCHEME_RE.
      const normalizedUrl = url ? normalizeOmniboxInput(url) || url : url
      const tab = win.tabs.create({
        identityId,
        url: normalizedUrl,
        source: 'tab-handlers.openInIdentity',
      })
      browser.broadcastToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...tab.serialize(), windowId: win.id },
      })
      log.info('tab-handlers', 'openInIdentity ok', {
        tabId: tab.id,
        identityId,
        url,
        windowId: win.id,
      })
      return tab.id
    },

    select(tabId) {
      for (const win of browser.windows) {
        if (win.tabs.get(tabId)) {
          win.tabs.select(tabId)
          return true
        }
      }
      log.warn('tab-handlers', 'select: tabId not found', { tabId })
      return false
    },

    // Drag-and-drop reorder within a window's tab list. `toIndex` is the
    // target position in that window's tabList.
    reorder(tabId, toIndex) {
      for (const win of browser.windows) {
        if (win.tabs.get(tabId)) {
          const moved = win.tabs.reorder(tabId, Number(toIndex))
          if (moved) browser.broadcastToWebUI('oz:tabs:updated', { kind: 'reordered' })
          return moved
        }
      }
      log.warn('tab-handlers', 'reorder: tabId not found', { tabId })
      return false
    },

    close(tabId) {
      for (const win of browser.windows) {
        const tab = win.tabs.get(tabId)
        if (tab) {
          // H2: locked tabs reject close. Caller (UI close button, Cmd+W,
          // closeOthers/closeToRight, MCP) must unlock first.
          if (tab.locked) {
            log.warn('tab-handlers', 'close blocked: tab is locked', {
              tabId,
              windowId: win.id,
            })
            return false
          }
          // H1: snapshot the tab spec BEFORE remove() destroys it. Push to
          // the closed-tabs stack ONLY for user-initiated closes (this
          // handler) — NOT for workspace-switch destroys. The audit caught
          // that hooking inside Tabs.remove() would also capture the snapshot
          // path (every workspace switch destroys all tabs via remove() in a
          // loop), filling the stack with stale tabs.
          const spec = tab.toSpec ? tab.toSpec() : null
          win.tabs.remove(tabId)
          if (spec) win.tabs.pushClosed(spec)
          browser.broadcastToWebUI('oz:tabs:updated', { kind: 'removed', tabId })
          log.info('tab-handlers', 'close ok', { tabId, windowId: win.id })
          return true
        }
      }
      log.warn('tab-handlers', 'close: tabId not found', { tabId })
      return false
    },

    /**
     * H1 — reopen the most recently closed tab in the focused window. Pops
     * from that window's closedTabsStack and re-creates a lazy tab. Returns
     * the new tab id, or null if the stack is empty / no focused window.
     *
     * Stack is per-window — closing tabs in window A does NOT populate
     * window B's reopen stack. This matches Chrome's behavior + sidesteps
     * the cross-window confusion of "which window did this tab come from".
     */
    reopenClosed() {
      const win = browser.getFocusedWindow()
      if (!win) {
        log.warn('tab-handlers', 'reopenClosed: no focused window')
        return null
      }
      const spec = win.tabs.popClosed ? win.tabs.popClosed() : null
      if (!spec) {
        log.info('tab-handlers', 'reopenClosed: stack empty')
        return null
      }
      // Restore unlocked + unpinned by default — locks/pins are intentional
      // user state we don't preserve through close→reopen. URL + identity
      // are what we care about; the rest is fresh.
      const tab = win.tabs.create({
        identityId: spec.identityId,
        url: spec.url || 'about:blank',
        title: spec.title,
        favicon: spec.favicon,
        source: 'tab-handlers.reopenClosed',
      })
      if (typeof win.tabs.select === 'function') win.tabs.select(tab.id)
      browser.broadcastToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...tab.serialize(), windowId: win.id },
      })
      log.info('tab-handlers', 'reopenClosed ok', {
        newTabId: tab.id,
        identityId: spec.identityId,
        url: spec.url,
        windowId: win.id,
        stackRemaining: win.tabs.closedTabsStack ? win.tabs.closedTabsStack.length : 0,
      })
      return tab.id
    },

    bulkCreateLazy(count, identityId, urlTemplate) {
      const win = browser.getFocusedWindow()
      if (!win) return 0
      for (let i = 0; i < count; i++) {
        const rawUrl = urlTemplate ? urlTemplate.replace('{i}', String(i)) : 'about:blank'
        // Hotfix BugCrawl: normalizar tras el template substitution.
        const url =
          rawUrl === 'about:blank' ? rawUrl : normalizeOmniboxInput(rawUrl) || rawUrl
        win.tabs.create({
          identityId,
          url,
          source: 'tab-handlers.bulkCreateLazy',
        })
      }
      browser.broadcastToWebUI('oz:tabs:updated', { kind: 'bulk-created', count })
      log.info('tab-handlers', 'bulkCreateLazy ok', { count, identityId })
      return count
    },

    /**
     * Move a tab from its current workspace to another (1.4d).
     *
     * Strategy:
     *   1. Find which window owns the tab.
     *   2. Snapshot the tab → tabSpec.
     *   3. Append spec to target workspace's tabSpecs (sync).
     *   4. Destroy the tab in the source window.
     *   5. If target workspace is currently active in some window, also create
     *      the tab live there (lazy) so it appears immediately.
     *
     * Edge cases:
     *   - Same workspace as current → noop.
     *   - Target workspace archived → reject (UX confusion if archived).
     *   - Target workspace frozen → allow (frozen blocks CRUD, not runtime).
     *   - Target not found → reject.
     *   - Tab not found → reject.
     */
    moveToWorkspace(tabId, targetWorkspaceId) {
      if (!browser.workspaceManager) {
        return { ok: false, reason: 'no-workspace-manager' }
      }
      const target = browser.workspaceManager.get(targetWorkspaceId)
      if (!target) {
        log.warn('tab-handlers', 'moveToWorkspace: target not found', {
          tabId,
          targetWorkspaceId,
        })
        return { ok: false, reason: 'target-not-found', tabId, targetWorkspaceId }
      }
      if (target.isArchived) {
        log.warn('tab-handlers', 'moveToWorkspace: target is archived', {
          tabId,
          targetWorkspaceId,
        })
        return { ok: false, reason: 'target-archived', tabId, targetWorkspaceId }
      }

      // Find source window owning the tab.
      let sourceWin = null
      let sourceTab = null
      for (const w of browser.windows) {
        const t = w.tabs && w.tabs.get && w.tabs.get(tabId)
        if (t) {
          sourceWin = w
          sourceTab = t
          break
        }
      }
      if (!sourceWin || !sourceTab) {
        log.warn('tab-handlers', 'moveToWorkspace: tab not found', { tabId })
        return { ok: false, reason: 'tab-not-found', tabId }
      }

      // H2: locked tabs cannot be moved (would silently destroy the live tab
      // in the source window — equivalent to closing it).
      if (sourceTab.locked) {
        log.warn('tab-handlers', 'moveToWorkspace blocked: tab is locked', {
          tabId,
          targetWorkspaceId,
        })
        return { ok: false, reason: 'tab-locked', tabId, targetWorkspaceId }
      }

      // Already in target workspace — noop.
      if (sourceWin.workspaceId === targetWorkspaceId) {
        return { ok: true, noop: true, tabId, targetWorkspaceId }
      }

      // H3a (D5): if the tab's identity doesn't live in the target workspace,
      // cascade-move the identity itself. Per ADR 0023 D5: "Auto-mueve la
      // identity también, si la identity no está locked. Si está locked →
      // reject."
      const im = browser.identityManager
      if (im && sourceTab.identityId) {
        const ident = im.get(sourceTab.identityId)
        if (ident && ident.workspaceId && ident.workspaceId !== targetWorkspaceId) {
          if (ident.locked) {
            log.warn('tab-handlers', 'moveToWorkspace blocked: identity locked', {
              tabId,
              identityId: ident.id,
              identityWorkspaceId: ident.workspaceId,
              targetWorkspaceId,
            })
            return {
              ok: false,
              reason: 'identity-locked-in-source-workspace',
              tabId,
              identityId: ident.id,
              identityWorkspaceId: ident.workspaceId,
            }
          }
          // Default identity is pinned to general (D2). If the user moves a
          // tab from Default into another workspace, the cleanest semantics
          // is to reject — Default cannot follow. Caller can clone the tab
          // into another identity (Move tab to identity) instead.
          if (ident.isDefault && targetWorkspaceId !== 'general') {
            log.warn('tab-handlers', 'moveToWorkspace blocked: Default pinned', {
              tabId,
              identityId: ident.id,
              targetWorkspaceId,
            })
            return {
              ok: false,
              reason: 'default-identity-pinned-to-general',
              tabId,
              identityId: ident.id,
            }
          }
          const moveResult = im.moveToWorkspace(ident.id, targetWorkspaceId)
          if (moveResult && moveResult.ok === false) {
            // Forward the underlying reject reason as-is (already typed).
            return moveResult
          }
          log.info('tab-handlers', 'moveToWorkspace cascade-moved identity', {
            tabId,
            identityId: ident.id,
            from: ident.workspaceId,
            to: targetWorkspaceId,
          })
        }
      }

      // 1) Snapshot the tab before destroying it.
      const spec = sourceTab.toSpec ? sourceTab.toSpec() : null
      if (!spec) {
        return { ok: false, reason: 'cannot-serialize-tab', tabId }
      }

      // 2) Append spec to target workspace.
      browser.workspaceManager.appendTabSpec(targetWorkspaceId, spec)
      if (browser.workspaceManager.flush) browser.workspaceManager.flush()

      // 3) Destroy tab in source.
      sourceWin.tabs.remove(tabId)
      browser.broadcastToWebUI('oz:tabs:updated', { kind: 'removed', tabId })

      // 4) If target workspace is open in some window, mirror the tab live there.
      let targetWin = null
      for (const w of browser.windows) {
        if (w.workspaceId === targetWorkspaceId) {
          targetWin = w
          break
        }
      }
      if (targetWin) {
        const liveTab = targetWin.tabs.create({
          id: spec.id,
          identityId: spec.identityId,
          url: spec.url,
          title: spec.title,
          favicon: spec.favicon,
          pinned: spec.pinned,
          source: 'tab-handlers.moveToWorkspace',
        })
        // The append we did earlier puts the spec twice (once in storage,
        // once via the tab-created listener that re-appends on snapshot).
        // To avoid dupes, the snapshot path uses setTabSpecs (replace) — but
        // appendTabSpec is straight append, so we leave it alone here.
        log.info('tab-handlers', 'moveToWorkspace mirrored to live target', {
          tabId,
          targetWindowId: targetWin.id,
          newLiveTabId: liveTab.id,
        })
      }

      log.info('tab-handlers', 'moveToWorkspace ok', {
        tabId,
        from: sourceWin.workspaceId,
        to: targetWorkspaceId,
        sourceWindowId: sourceWin.id,
        targetWindowId: targetWin && targetWin.id,
      })
      return {
        ok: true,
        tabId,
        from: sourceWin.workspaceId,
        to: targetWorkspaceId,
      }
    },
  }
}

module.exports = { buildTabHandlers }
