# ADR 0032 — Bulk Run History Dashboard

**Status:** Accepted — v2.0.0-alpha.24 (2026-05-25). Extended in alpha.25 (Etapa 4.3 Retry-failed), alpha.26 (Etapa 4.5 Export CSV), and alpha.28 (Etapa 4.4 Per-identity entry point — see §Per-identity activity).
**Context:** v2 Etapa 4 — Reliability + Observabilidad, sub-bloques 4.1 + 4.3 + 4.4 + 4.5 (4.2 lives in ADR 0033).

## Context

The `BulkRunner` motor (alpha.1+) persists every run in
`userData/bulk-runs/<runId>.json` and re-hydrates them at boot. From alpha.1
through alpha.23 those records were only reachable through:

- `oz.bulk.list` / `oz.bulk.get` MCP tools (Claude side)
- The bulk-runner modal's "running" phase — but only for the **current** run
- Hand-opening JSONs on disk

The agency use case had a clear blind spot: the operator can't see what
ran yesterday, what failed last week, or audit per-identity history without
poking at JSON files. Etapa 4.1 ships a first-class UI for browsing run
history.

## Decision

Add a new modal "Bulk Run History" exposed via:

- Cmd+K palette entry: `action:open-bulk-history` ("Bulk Run History…" 📜)
- View menu item: "Bulk Run History…" (no accelerator — Cmd+Shift+H is the
  macOS system hide-window shortcut and we won't override it)

The modal has two phases (same single-modal-two-section pattern as
bulk-runner-ui):

1. **List phase** — filterable + sortable table of run-meta entries.
   Filters: status, action, identity, date range (7d/30d/all), text search.
   Sort: newest (default), oldest, by-status.
   Default limit: 100 visible. Counter when filtered set > 100.
2. **Detail phase** — drill-down into one run: meta header + per-identity
   items table. Reuses `bulkRunnerCodes` for error-code tooltips.

The dashboard live-updates via the existing `oz:bulk:created/started/
completed` broadcast events when open.

## Retry-failed (alpha.25, Etapa 4.3)

Three entry points wired off the dashboard:

1. **Detail view → primary button** "↻ Retry failed items (N)" — re-runs
   only items with `status='failed'`. Cancelled items are NOT included
   (the user explicitly cancelled them — re-running would override that
   intent).
2. **Detail view → manual subset** — checkbox column on retryable rows
   (`failed | cancelled`). "↻ Retry selected (M)" button enables when ≥1
   checked. Lets the operator re-run a curated subset, including
   re-running cancelled items.
3. **List view → row action** "↻ Retry" — equivalent to entry point 1 but
   without opening detail. Visible only when `meta.stats.failed > 0` AND
   the run is in terminal status.

All three paths funnel through `_dispatchRetry(meta, identityIds)` which:

- Re-checks `TERMINAL_RUN_STATUSES` (defensive against live-update races)
- Validates the action is still in the registry (`oz.bulk.actions`)
- Confirms with the user (native `window.confirm`)
- Calls `oz.bulk.run({actionId, identityIds, params, options})` — params
  and options are deep-copied from the original meta (`buildRetrySpec`)
- On success: refreshes the dashboard, jumps to the new run's detail page
- On error: surfaces a friendly message in the inline error bar

Pure helpers (testable without DOM):
`getRetryableIdentityIds`, `getFailedIdentityIds`, `buildRetrySpec`,
`canRetryRun`. Tests in `tests/bulk-history-helpers.smoketest.js`
(+~25 assertions, total 59).

### Why not retry skipped items?

`status='skipped'` means rate-limit fired — re-running immediately would
just hit the same gate. We surface the count but exclude from retryable
set. The operator can manually re-run later via the bulk-runner modal
when the daily window resets.

## Export CSV (alpha.26, Etapa 4.5)

Two buttons:

1. **List view → "⬇ Export CSV"** in the filter toolbar. Exports the
   currently-filtered + sorted set — **NOT** capped at the 100-visible
   limit. The operator filters down semantically (e.g. "last 30 days,
   IG Like, status=failed") and gets the full matching set in CSV.
   Columns: `createdAt, runId, actionId, actionLabel, identityCount,
status, done, failed, skipped, cancelled, finishedAt`.
   Filename: `bulk-runs-<ISO-timestamp>.csv`.
2. **Detail view → "⬇ Export CSV"** in the retry bar. Exports the items
   of the run currently shown. Columns: `runId, identityId, identityName,
status, result, errorCode, errorMessage, startedAt, finishedAt`.
   `result` is JSON-stringified for object results, then RFC 4180
   escaped. Filename: `bulk-run-<runId>.csv`.

### RFC 4180 compliance

- Fields containing `,`, `"`, `\r`, or `\n` are wrapped in double-quotes
- Internal double-quotes are doubled (`"` → `""`)
- Line terminator: CRLF (`\r\n`) — Excel/Numbers happy path
- Trailing CRLF on the last line for tool compatibility

### Implementation

`toCsvCell`, `runsToCSV`, `runDetailToCSV` are pure helpers in
`bulk-history-helpers.js` — fully tested in
`tests/bulk-history-helpers.smoketest.js` (+~30 assertions, total 91).

The Blob + `<a download>` download trigger lives in
`bulk-history-actions.js` (`_downloadBlob`, `exportListCsv`,
`exportDetailCsv`). DOM-side but trivial — no special browser API.

### Why not server-side?

Backend cero. Tomar el cache in-memory de `BulkRunner.list()` y serializar
en el renderer es la opción más simple y suficiente para los volúmenes
reales (decenas a cientos de runs). Si el volumen sube por 100×, se puede
mover la generación al main process via MCP `oz.bulk.export` sin cambiar
la signature de los helpers.

## Per-identity activity (alpha.28, Etapa 4.4)

The original plan called for a dedicated activity tab embedded in
account-manager. After cost/benefit review (account-manager is large
and critical, while the dashboard's existing identity filter already
gives 80% of the value), the operator chose a **mini scope**:

1. **Command palette entry per identity** — for every identity, an
   "Activity for {name}…" 📜 entry is injected next to the existing
   "Switch to Identity X" entry. Discoverable by typing the identity
   name or `activity`.
2. **Dispatcher `open-history-for-identity`** in renderer
   command-palette.js — sets `ui._filters.identityId` directly then
   calls `ui.open()`.
3. **IPC `oz:bulk-history:open-for-identity`** + preload bridge
   `window.oz.bulk.onOpenHistoryForIdentity` — parallel to the other
   open-intent IPC channels (4.1 `open`, 4.2 `open-at-run`).
   No main-process emitter yet; pre-wired for future deep-linking and
   scheduled-action follow-ups.
4. **`wireOpenIntents(uiGetter)` in bulk-history-actions.js** —
   centralises the three open-intent IPC listeners (open / open-at-run
   / open-for-identity). Extracted out of `bulk-history.js _boot()` to
   keep that file under the 500 LOC budget.

The dashboard reuses its existing identity filter dropdown for both
manual filtering and the pre-set from this entry point — no parallel
"per-identity activity" surface.

## Non-decisions (parking for future sub-bloques)

All Etapa 4 sub-bloques shipped in alpha.24-28. Etapa 5 (v3 SaaS) is
the next bucket — see roadmap memory.

## Why no backend changes

`BulkRunner.list()` and `.get()` already do exactly what this UI needs.
`oz.bulk.list` was even documented as "Useful for the dashboard / history
view" since alpha.1 — the docstring foresaw this sub-bloque.

Adding `oz.bulk.list` filters server-side was considered and rejected:

- The runtime cache is in-memory and tiny (~few hundred runs in practice).
- Filtering on the renderer side keeps the MCP surface simple.
- Pre-existing `oz.bulk.list` callers (Claude prompts) don't need to learn
  filter args.

## Module layout

```
browser/ui/bulk-history.js         — IIFE UI (~370 LOC)
browser/ui/bulk-history-helpers.js — pure CommonJS (filterRuns/sortRuns/
                                     buildStats/buildFilterOptions, ~160 LOC)
```

The helpers module is split so the smoke test (`tests/bulk-history-
helpers.smoketest.js`) can `require()` it in Node without a DOM stub. This
mirrors the `browser/command-palette.js` (data) / `browser/ui/command-
palette.js` (UI) split that already exists in the codebase.

## Failure modes considered

- **Script load order** — `bulk-history-helpers.js` MUST load before
  `bulk-history.js` in webui.html. If reversed, helpers are absent at
  construction time and the UI degrades to no-op filters (defensive
  fallback baked in). The webui.html comment makes the order explicit.
- **Identity filter without items** — `BulkRunner.list()` returns meta only;
  the identity filter needs items to evaluate. Solution: lazy hydration
  via `.get(runId)` on filter switch. Cached after first fetch.
- **Live update during open** — subscribing to `onCreated/onStarted/
onCompleted` triggers `reload({silent:true})`. Cheap because the engine
  cache is in-memory and the modal table only renders the first 100 rows.
- **N grandes (1000+ runs)** — limit to 100 visible + counter explanation.
  If real-world telemetry shows degradation, switch to virtual scroll.

## Smoke validation

Etapa 4.1 ships with the helpers smoke test only. End-to-end visual smoke
(open modal → filter → drill into a real run) is operator-validated
manually before each alpha publish, per the lessons in
[`feedback_smoke_visual_bugs.md`](../../memory/) and
[`feedback_silent_ui_bug_patterns.md`](../../memory/).

## Future-compatibility

When v3 SaaS lands (Etapa 5), the persistence layer moves from
`userData/bulk-runs/` to a remote DB; `BulkRunner.list/get` stay the same
contract but read from a backend. This dashboard becomes the source of
truth for ops dashboards across the team.
