# Module: BulkNotifications

**Files:**

- `browser/bulk-notifications.js` — `class BulkNotifications` (main-process)
- `tests/bulk-notifications.smoketest.js` — 22 assertions

**ADR:** [`0033-bulk-notifications.md`](../architecture/0033-bulk-notifications.md).

## How it works

1. Constructor takes `{bulkRunner, browser, settingsManager?,
notificationFactory?, logger?}`. Default factory lazily requires
   `electron.Notification`.
2. `install()` subscribes to `bulkRunner.on('completed')`. Idempotent.
3. On each completion, `_handleCompleted(runId, meta)`:
   - Checks `settings.notifications.showOSAlert` (defaults to true)
   - Validates meta
   - Calls `formatMessage(meta)` → `{title, body}`
   - Calls `_show(title, body, runId)` which constructs the
     `Notification`, registers a click handler, and calls `show()`
4. Click handler broadcasts IPC `oz:bulk-history:open-at-run`
   with `{runId}` and focuses the window.

## formatMessage contract (pure)

```
formatMessage({actionLabel:'IG Like', status:'completed',
               stats:{done:3,failed:1}})
→ {
    title: 'Bulk run finished — IG Like',
    body:  '3 done · 1 failed',
  }
```

Title prefix by status: `completed` → "Bulk run finished",
`failed` → "Bulk run failed", `cancelled` → "Bulk run cancelled".

Body omits zero buckets to keep it scannable. Returns `"no items"`
when all stats are zero (rare — empty run).

## Wire-up

In `browser/main.js` (after `bulkRunnerSetup.setupBulkRunner(this)`):

```js
const { BulkNotifications } = require('./bulk-notifications')
this.bulkNotifications = new BulkNotifications({
  bulkRunner: this.bulkRunner,
  browser: this,
  settingsManager: this.settingsManager,
  logger: log,
})
this.bulkNotifications.install()
```

## Cross-references

- Reuses `settings.notifications.showOSAlert` (same flag as
  `anti-logout.js`).
- Renderer-side bridge: `window.oz.bulk.onOpenHistoryAtRun(cb)` in
  `preload-bulk-api.js`.
- Click handler opens [bulk-history.js](./bulk-history.md) at detail.
