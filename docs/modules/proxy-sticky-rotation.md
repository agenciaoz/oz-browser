# Module: StickyRotation (proxy-sticky-rotation.js)

**Files:**

- `browser/proxy-sticky-rotation.js` — class StickyRotation + pure helpers
- `tests/proxy-sticky-rotation.smoketest.js` — 40 assertions

**ADR:** [`0034-sticky-sessid-rotation.md`](../architecture/0034-sticky-sessid-rotation.md).

## How it works

Each identity bound to a proxy whose username has `-sessid-XXX-`
(Oxylabs format) receives an **ephemeral** sessid generated on first
activation. The ephemeral sessid:

- Is stored in an in-memory `Map<identityId, {sessid, generatedAt}>`
- Persists for the **sticky window** (30 min by default — matches Oxylabs `sesstime-30`)
- Is regenerated when the window expires AND the identity is re-activated
- Is reset on every cold boot (no disk persistence)

## Wire-up in main.js

```js
const { StickyRotation } = require('./proxy-sticky-rotation')
this.stickyRotation = new StickyRotation({
  proxyAssignment: this.proxyAssignment,
  toProxyRulesString,
  identityManager: this.identityManager,
  logger: log,
})

// On session create — first-time per boot per identity.
this.identityManager.setProxyResolutionHook((identityId, session) => {
  this.stickyRotation.applyForIdentity(identityId, session)
})
```

In `identity-handlers.setActive(id)`:

```js
browser.stickyRotation.refreshActiveSession(id)
```

`refreshActiveSession` is a no-op within the sticky window, rotates and
re-applies `setProxy` once the window expires.

## API

| Method | Effect |
|---|---|
| `getOrRotateSessid(identityId, proxy)` | Returns the current sessid for the identity, rotating if stale. Returns `null` if the proxy lacks `-sessid-` pattern. |
| `buildRulesForIdentity(identityId)` | Resolves the proxy via `proxyAssignment`, substitutes the ephemeral sessid into the username, returns `{proxy, rules, sessid}`. |
| `applyForIdentity(identityId, session)` | Calls `session.setProxy({proxyRules})` with the rotated rules. Returns `{proxyId, sessid, rules}`. |
| `refreshActiveSession(identityId)` | Convenience for callers that don't have the session handle — looks it up via `identityManager.getSession(identityId)` and calls `applyForIdentity`. |
| `forget(identityId)` | Clears the ephemeral state for an identity. Call when the identity is deleted. |
| `isStale(generatedAt)` | Predicate: true if `now - generatedAt > windowMs`. Exposed for tests. |

## Configuration

`new StickyRotation({ windowMs })` accepts a custom window in
milliseconds. Default is 30 min. Tests inject 5 min to exercise the
expiration path quickly.

## Pure helpers (exported)

- `replaceSessidInUsername(username, newSessid)` — RFC-stable string
  replacement; returns input as-is if no `-sessid-` marker.
- `generateSessid()` — base36 8-char random; same shape as the manual
  "Rotate sticky" button in proxy-actions.js.
- `DEFAULT_STICKY_WINDOW_MS` — `30 * 60 * 1000`.

## Cross-references

- Consumed by `browser/main.js` (`setProxyResolutionHook`).
- Triggered by `browser/identity-handlers.js setActive`.
- Pure helpers mirror `_normalizeSessidInUsername` in
  `browser/proxy-actions.js` (the manual rotation path). The two paths
  could be merged in a follow-up if a regression appears.
