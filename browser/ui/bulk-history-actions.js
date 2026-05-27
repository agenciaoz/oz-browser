// OZ Browser — Bulk History retry actions (v2 Etapa 4.3).
//
// Extracted from bulk-history.js to keep that file under the 500 LOC budget
// (ADR 0005). Same pattern as account-manager-session.js / identity-manager-
// sync.js — standalone functions that take the UI instance as first arg and
// mutate via its public surface.
//
// Loaded as a regular <script> in webui.html AFTER bulk-history-helpers.js
// and BEFORE bulk-history.js (so the IIFE in bulk-history.js can read
// `window.OZ.bulkHistoryActions`).
//
// ADR: docs/architecture/0032-bulk-history-dashboard.md (§Retry-failed)
// Doc: docs/modules/bulk-history.md (§Retry workflow)

;(function () {
  'use strict'

  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

  const helpers = (window.OZ && window.OZ.bulkHistoryHelpers) || {
    getFailedIdentityIds: () => [],
    getRetryableIdentityIds: () => [],
    buildRetrySpec: () => {
      throw new Error('helpers missing')
    },
    canRetryRun: () => false,
    TERMINAL_RUN_STATUSES: new Set(),
  }

  /** Show/hide the retry toolbar based on run state. */
  function updateRetryBar(ui) {
    if (!ui.$retryBar) return
    if (ui.$retryError) ui.$retryError.hidden = true
    const run = ui._currentDetailRun
    const can = helpers.canRetryRun && helpers.canRetryRun(run)
    ui.$retryBar.hidden = !can
    if (!can) return
    const failedIds = helpers.getFailedIdentityIds(run)
    const retryableCount = helpers.getRetryableIdentityIds(run).length
    if (ui.$retryFailed) {
      ui.$retryFailed.hidden = failedIds.length === 0
      ui.$retryFailed.disabled = failedIds.length === 0
      ui.$retryFailed.textContent = t('bulkHistory.retry.retryFailedN', {
        n: failedIds.length,
      })
    }
    if (ui.$retryHint) {
      ui.$retryHint.textContent = t('bulkHistory.retry.hintN', {
        n: retryableCount,
      })
    }
    if (ui.$checkAll) ui.$checkAll.checked = false
    updateRetrySelectedButton(ui)
  }

  /** Recompute the "Retry selected (M)" button state. */
  function updateRetrySelectedButton(ui) {
    if (!ui.$retrySelected || !ui.$detailBody) return
    const checked = ui.$detailBody.querySelectorAll(
      'input[type="checkbox"][data-identity]:checked',
    )
    const n = checked.length
    ui.$retrySelected.disabled = n === 0
    ui.$retrySelected.textContent = t('bulkHistory.retry.retrySelectedN', { n })
  }

  /** Show an inline error in the retry error bar (detail view). */
  function showInlineError(ui, message) {
    if (!ui.$retryError) return
    ui.$retryError.textContent = message
    ui.$retryError.hidden = false
  }

  /** Retry only items with status=failed in the current detail run. */
  async function retryFailedItems(ui) {
    const run = ui._currentDetailRun
    if (!run) return
    const failed = helpers.getFailedIdentityIds(run)
    if (failed.length === 0) return
    await dispatchRetry(ui, run.meta, failed)
  }

  /** Retry the items the user checked in the detail table. */
  async function retrySelectedItems(ui) {
    const run = ui._currentDetailRun
    if (!run || !ui.$detailBody) return
    const checked = ui.$detailBody.querySelectorAll(
      'input[type="checkbox"][data-identity]:checked',
    )
    const ids = Array.from(checked).map((cb) => cb.getAttribute('data-identity'))
    if (ids.length === 0) return
    await dispatchRetry(ui, run.meta, ids)
  }

  /** Retry-from-list: same as failed-button but from a row in list view. */
  async function retryRowFromList(ui, runId) {
    if (!runId || !window.oz || !window.oz.bulk) return
    const full = await Promise.resolve(window.oz.bulk.get(runId)).catch(() => null)
    if (!full) return
    ui._enrichedItems.set(runId, full.items || [])
    const failed = helpers.getFailedIdentityIds(full)
    if (failed.length === 0) {
      showInlineError(ui, t('bulkHistory.retry.noFailedItems'))
      return
    }
    await dispatchRetry(ui, full.meta, failed)
  }

  /**
   * Validate + invoke oz.bulk.run. Surfaces errors inline. On success:
   * refreshes the dashboard and navigates to the new run's detail.
   */
  async function dispatchRetry(ui, originalMeta, identityIds) {
    if (!window.oz || !window.oz.bulk || !window.oz.bulk.run) {
      showInlineError(ui, t('bulkHistory.noBackend'))
      return
    }
    // Defensive: re-check terminal state at dispatch time. A live-update
    // event between user click and dispatch could push a 'completed' run
    // back through the engine (very unlikely but cheap to guard).
    const run = ui._currentDetailRun
    const TERMINAL = helpers.TERMINAL_RUN_STATUSES || new Set()
    if (run && run.meta && !TERMINAL.has(run.meta.status)) {
      showInlineError(ui, t('bulkHistory.retry.notTerminal'))
      return
    }
    let spec
    try {
      spec = helpers.buildRetrySpec(originalMeta, identityIds)
    } catch (err) {
      showInlineError(ui, err.message)
      return
    }
    // Edge: confirm action still in registry. Non-fatal if listActions
    // itself blows up — we only block when we explicitly know the action
    // is gone.
    try {
      const actions = await Promise.resolve(window.oz.bulk.listActions()).catch(
        () => null,
      )
      if (Array.isArray(actions)) {
        const known = actions.some((a) => a && a.id === spec.actionId)
        if (!known) {
          showInlineError(
            ui,
            t('bulkHistory.retry.actionGone', { actionId: spec.actionId }),
          )
          return
        }
      }
    } catch {
      // Non-fatal.
    }
    const confirmMsg = t('bulkHistory.retry.confirm', {
      n: identityIds.length,
      action: originalMeta.actionLabel || originalMeta.actionId,
    })
    if (typeof window.confirm === 'function' && !window.confirm(confirmMsg)) {
      return
    }
    const result = await Promise.resolve(window.oz.bulk.run(spec)).catch((err) => ({
      __error: { message: err && err.message ? err.message : String(err) },
    }))
    if (result && result.__error) {
      showInlineError(
        ui,
        t('bulkHistory.retry.dispatchFailed', {
          msg: result.__error.message || 'unknown',
        }),
      )
      return
    }
    await ui.reload({ silent: true })
    if (result && result.runId) {
      await ui._openDetail(result.runId)
    }
  }

  // ─── CSV export (v2 Etapa 4.5) ──────────────────────────────────────

  /** Trigger a browser download with a Blob payload + filename. */
  function _downloadBlob(text, filename) {
    try {
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      // Append to body for Firefox compat — Chrome works without but it's
      // a 1-line safety net.
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Small delay before revoke so Safari can finish reading the blob.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      if (window.oz && window.oz.log) {
        window.oz.log.warn('webui/bulk-history', 'csv download failed', err)
      }
    }
  }

  function _isoSlug(date) {
    return new Date(date).toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
  }

  /**
   * Export the currently-filtered+sorted list (NOT capped to the 100
   * visible rows — exports the full filtered set so the operator can
   * audit large windows externally).
   */
  function exportListCsv(ui) {
    if (!helpers.runsToCSV) return
    // Mirror the filter/sort the UI applies in _renderList. We re-apply
    // here so the export matches exactly what the user is seeing
    // semantically, regardless of the 100-row visual cap.
    const allRuns = ui._allRuns || []
    let rows = allRuns
    if (helpers.filterRuns) rows = helpers.filterRuns(rows, ui._filters || {})
    if (helpers.sortRuns) rows = helpers.sortRuns(rows, ui._sort || 'newest')
    const csv = helpers.runsToCSV(rows)
    const filename = `bulk-runs-${_isoSlug(Date.now())}.csv`
    _downloadBlob(csv, filename)
  }

  /** Export the items of the run currently shown in the detail view. */
  function exportDetailCsv(ui) {
    if (!helpers.runDetailToCSV) return
    const run = ui._currentDetailRun
    if (!run) return
    const csv = helpers.runDetailToCSV(run)
    const runId = (run.meta && run.meta.runId) || 'unknown'
    const filename = `bulk-run-${runId}.csv`
    _downloadBlob(csv, filename)
  }

  // ─── Open-intent listeners (4.1/4.2/4.4) ─────────────────────────────
  // Extracted from bulk-history.js _boot() to keep that file under the
  // 500 LOC budget. Wires renderer-side IPC handlers that the UI exposes.

  function wireOpenIntents(uiGetter) {
    const bulk = window.oz && window.oz.bulk
    if (!bulk) return
    if (bulk.onOpenHistory) {
      bulk.onOpenHistory(() => uiGetter() && uiGetter().open())
    }
    if (bulk.onOpenHistoryAtRun) {
      bulk.onOpenHistoryAtRun(async ({ runId } = {}) => {
        const u = uiGetter()
        if (!u || !runId) return
        await u.open()
        await u._openDetail(runId)
      })
    }
    if (bulk.onOpenHistoryForIdentity) {
      bulk.onOpenHistoryForIdentity(async ({ identityId } = {}) => {
        const u = uiGetter()
        if (!u || !identityId) return
        u._filters.identityId = identityId
        await u.open()
      })
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.bulkHistoryActions = {
    updateRetryBar,
    updateRetrySelectedButton,
    showInlineError,
    retryFailedItems,
    retrySelectedItems,
    retryRowFromList,
    dispatchRetry,
    exportListCsv,
    exportDetailCsv,
    wireOpenIntents,
  }
})()
