# ADR 0033 — Bulk Run Native OS Notifications

**Status:** Accepted — v2.0.0-alpha.27 (2026-05-25).
**Context:** v2 Etapa 4 — Reliability + Observabilidad, sub-bloque 4.2.

## Context

`BulkRunner` emits `'completed'` with `{runId, meta}` at the end of every
run. Until alpha.27, this event was only consumed by:

- Internal IPC broadcast `oz:bulk:completed` → bulk-runner-ui modal
  (only relevant when the modal is open in the foreground)
- The dashboard's live-update reload (only when the dashboard is open)

For the agency use case — Jose dispatches a 50-identity run from his
laptop and then context-switches to other apps — there was no signal
when the run finished. He had to alt-tab back to OZ and check the
dashboard manually.

## Decision

Add a new main-process module `BulkNotifications` that:

1. Hooks `bulkRunner.on('completed')`
2. Formats a friendly title + body from the run meta
3. Shows an Electron Notification via `electron.Notification`
4. Wires a click handler that broadcasts IPC
   `oz:bulk-history:open-at-run` with the runId, opening the dashboard
   directly at the detail view of that run

### Gating

Reuse the **existing** `settings.notifications.showOSAlert` flag that
already controls anti-logout notifications. No new key — Jose has one
single toggle for "let OZ notify me natively".

This is a deliberate UX choice. A separate `bulkRuns` sub-key was
considered and rejected:

- Most users want all or none for native toasts (anti-logout +
  bulk-run completion are both "important async events").
- One key is fewer surfaces to maintain and fewer locales to
  translate.
- If granular control is requested later, the key can be added
  without breaking the existing toggle (`showOSAlert &&
bulkRuns !== false`).

### Click → IPC instead of opening a new window

The notification click broadcasts IPC `oz:bulk-history:open-at-run`
with `{runId}`. The renderer-side dashboard listens via
`window.oz.bulk.onOpenHistoryAtRun(cb)` (new in
`preload-bulk-api.js`), calls `ui.open()` and then
`ui._openDetail(runId)`. This piggybacks on the existing dashboard
plumbing rather than building a parallel "run summary" surface.

## Module layout

```
browser/bulk-notifications.js     — class BulkNotifications (~170 LOC)
tests/bulk-notifications.smoketest.js  — 22 assertions
```

Wired in `browser/main.js` AFTER `bulkRunnerSetup.setupBulkRunner(this)`
because the constructor requires `this.bulkRunner` to exist.

`browser/preload-bulk-api.js` exports a new bridge method
`onOpenHistoryAtRun(cb) → unsubscribe`.

`browser/ui/bulk-history.js` listens to that IPC in the `_boot()`
sequence and chains `open() → _openDetail(runId)`.

## Failure modes

- **macOS notification permission denied** — Electron handles silently,
  show() is a no-op. We log nothing because the user explicitly
  declined.
- **`Notification.isSupported()` false** — guarded; skip cleanly.
  Covers headless environments and very old OS versions.
- **`notificationFactory()` throws** — caught + logged at WARN, no
  user-facing impact.
- **Click before window is alive** — falls back to
  `broadcastToWebUI` which targets all webUI windows; if none exist,
  the click is a no-op (acceptable — user can re-open OZ and the run
  is still in history).
- **Setting unreadable** — defaults to ON (fail-safe to "notify").

## Test strategy

`tests/bulk-notifications.smoketest.js` uses a fake `Notification`
class and an `EventEmitter` bulkRunner. Covers:

- formatMessage: completed/failed/cancelled title prefixes, body
  omits zero buckets, "no items" fallback, actionId fallback
- install/uninstall lifecycle + idempotency
- gate by `showOSAlert`
- skip when factory returns null
- skip when `isSupported()` false
- click handler dispatches IPC + focuses window
- missing meta → silent skip

End-to-end visual smoke (actual macOS toast appears) is operator-
validated before each alpha publish.

## Future-compatibility

When v3 SaaS lands and runs happen server-side, the same
`BulkNotifications` interface can subscribe to a websocket stream
instead of a local EventEmitter — the `formatMessage` + click
handler stay identical.
