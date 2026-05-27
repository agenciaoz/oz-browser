# Module: Bulk Run History dashboard

**Files:**

- `browser/ui/bulk-history.js` — IIFE UI layer (modal + render + IPC wire)
- `browser/ui/bulk-history-helpers.js` — pure helpers (`filterRuns`,
  `sortRuns`, `buildStats`, `buildFilterOptions`)
- `tests/bulk-history-helpers.smoketest.js` — Node smoke test (34 assertions)

**Markup:** `<div id="oz-bh-modal">` in `browser/ui/webui.html`.

**ADR:** [`0032-bulk-history-dashboard.md`](../architecture/0032-bulk-history-dashboard.md).

## How it works

1. Modal markup is hidden by default in `webui.html`.
2. Triggers:
   - **Cmd+K palette** → `action:open-bulk-history` →
     `command-palette.js` `modalMap.bulkHistory` → `window.OZ.bulkHistoryUI.open()`
   - **View menu → "Bulk Run History…"** → `menu.js` emits IPC
     `oz:bulk-history:open` → preload `window.oz.bulk.onOpenHistory` →
     `window.OZ.bulkHistoryUI.open()`
3. `open()` reveals the modal, switches to list phase, and calls `reload()`.
4. `reload()` calls `window.oz.bulk.list()` (no backend changes —
   `BulkRunner.list()` from alpha.1).
5. List is rendered through the pure helpers:
   - `buildStats(allRuns)` → stats line ("12 runs · 8 completed · 2 failed…")
   - `buildFilterOptions(allRuns)` → action + identity dropdowns populated
   - `filterRuns(allRuns, filters)` → AND-chain (status, action, identity,
     date, search)
   - `sortRuns(filtered, mode)` → newest (default), oldest, status
   - First 100 rendered; counter shown when truncated.
6. Click a row's "View →" → `_openDetail(runId)` calls
   `window.oz.bulk.get(runId)` and renders the items table.
7. Live update: while modal is open, `onCreated/onStarted/onCompleted` events
   call `reload({silent:true})`.

## Identity filter quirk

`BulkRunner.list()` returns meta only (no items). The identity filter needs
items to evaluate. To avoid an N+1 on every list load, items are hydrated
lazily: only when the identity filter is switched OFF→ON, we `.get()` every
run missing items and cache the result in `_enrichedItems` (in-memory Map).
Subsequent identity switches are free.

## i18n

Namespace: `bulkHistory.*` in `browser/ui/locales/en.json` +
`browser/ui/locales/es.json`. Includes the palette entry
(`bulkHistory.paletteEntry`) and keywords (`bulkHistory.paletteKeywords`).

## Tests

```bash
node tests/bulk-history-helpers.smoketest.js
```

Covers filter combinations (status/action/identity/date/search/AND),
sort modes (newest/oldest/status), stats aggregation (including
cancelling→running bucketing), filter dropdown dedup + alpha sort,
and edge cases (empty, null, dirty entries).

DOM-side smoke is operator-validated end-to-end before each alpha publish
(see feedback `feedback_smoke_visual_bugs.md`).

## Retry workflow (alpha.25, Etapa 4.3)

Three entry points all funnel through `_dispatchRetry(meta, identityIds)`:

1. **Primary "Retry failed items (N)" button** in the detail-view retry
   bar — re-runs only items with `status='failed'`. Visible only when
   `getFailedIdentityIds(run).length > 0`.
2. **Manual subset via checkboxes** — only retryable items
   (`failed|cancelled`) get an active checkbox. "Retry selected (M)"
   button counts checked items live.
3. **List-row retry** — `↻ Retry` button per row when
   `meta.stats.failed > 0`. Equivalent to (1) without opening detail.

`_dispatchRetry` validates (action still registered, run still terminal),
confirms with the user, calls `oz.bulk.run`, and on success refreshes
the list + opens detail of the new run.

Pure helpers in `bulk-history-helpers.js`:

- `RETRYABLE_ITEM_STATUSES = {failed, cancelled}` — Set
- `TERMINAL_RUN_STATUSES = {completed, failed, cancelled}` — Set
- `getRetryableIdentityIds(run)` — items in failed|cancelled status
- `getFailedIdentityIds(run)` — strict subset, failed only
- `buildRetrySpec(meta, identityIds)` — `{actionId, identityIds, params, options}`
  with deep-copied params + options
- `canRetryRun(run)` — predicate: terminal status AND ≥1 retryable

## Export CSV (alpha.26, Etapa 4.5)

Two buttons:

- **List toolbar → "⬇ Export CSV"** — exports the filtered+sorted set
  (NOT capped at 100). Filename `bulk-runs-<ISO>.csv`.
- **Detail retry bar → "⬇ Export CSV"** — exports the items of the
  current run. Filename `bulk-run-<runId>.csv`.

Pure helpers in `bulk-history-helpers.js`:

- `toCsvCell(value)` — RFC 4180 escape (quote if `,"\r\n`, double internal quotes)
- `runsToCSV(rows)` — list export; skips invalid entries (no
  `meta.status` → not a real run)
- `runDetailToCSV(run)` — single-run items export; JSON-stringifies
  object results

Blob + `<a download>` trigger in `bulk-history-actions.js`
(`_downloadBlob`, `exportListCsv`, `exportDetailCsv`).

## Cross-references

- Reuses `bulkRunnerCodes` (`browser/ui/bulk-runner-codes.js`) for
  error-code tooltips in detail view.
- Sibling of `bulk-runner-ui.js` (composer + reporter for current/new runs).
