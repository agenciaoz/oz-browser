# ADR 0034 — Sticky-sessid auto-rotation per identity

**Status:** Accepted — v2.0.0-alpha.30 (2026-05-27).
**Context:** Operación de identities con proxies Oxylabs sticky.

## Context

Each identity gets a fixed Oxylabs proxy assignment (dedicated, no
round-robin — set up at alpha.29). The Oxylabs username format is:

```
customer-X-cc-us-city-miami-sessid-NNNNNN-sesstime-30
```

The `sessid-NNNNNN` makes Oxylabs return the **same** residential IP for
all requests using that sessid, for up to 30 min (`sesstime-30`). Within
that window, requests are sticky to one IP. After the window expires,
Oxylabs assigns a fresh IP on the next request (still sticky for the next
30 min).

The problem: with hardcoded sessids on disk, the Oxylabs sticky window
silently extends across OZ Browser sessions. If Jose closes OZ today and
reopens it tomorrow, the proxy username still has the same sessid, and
Oxylabs gives the same (or a near-overlapping) IP. For multi-account
operation this looks like "same machine reusing the same proxy" — a
pattern that platforms (IG, X) can correlate.

## Decision

Introduce `StickyRotation` — an ephemeral, in-memory layer that
substitutes the persisted `sessid-NNNNNN` with a randomly-generated sessid
per identity, refreshing it whenever the 30-min window has expired.

### State model

- In-memory Map: `identityId → { sessid: string, generatedAt: number }`
- **Not persisted to disk.** Boot fresh = sessid fresh.
- Each identity tracks its own window independently.

### Lifecycle

1. **First activation after boot** — no state, generate random sessid,
   store, apply.
2. **Re-activation within 30 min** — reuse the cached sessid (sticky).
   At the Electron `setProxy` level this is effectively a no-op (same
   rules string), so Oxylabs continues returning the same IP.
3. **Re-activation after 30 min** — state is stale, generate new sessid,
   apply. Oxylabs gives a new IP on the next request.

### Hook points

Two wires in `browser/main.js`:

- `identityManager.setProxyResolutionHook(applyForIdentity)` — fires
  when a session is created for the first time per identity per boot.
- `browser/identity-handlers.js setActive(id)` — calls
  `refreshActiveSession(id)` which re-applies through the rotation layer.
  Within window → no-op. After window → rotate + setProxy.

The combination guarantees that whether Jose clicks the identity in the
sidebar after the window expired, or whether he closes/reopens OZ, the
next outbound request uses a fresh sticky window.

## Why "30 min from sessid generation"

Selected over "30 min of inactivity" because it matches the actual
Oxylabs `sesstime-30` semantics. If you reuse a sessid that Oxylabs has
held for 35 min, Oxylabs may have already assigned the next IP — keeping
the old sessid in our state would diverge from the truth and confuse
debugging.

## Why ephemeral (no disk persistence)

Decided with Jose. Two reasons:

1. **Simpler.** No migration, no schema, no race with config persistence.
2. **Boot = clean state.** When the operator closes and reopens OZ
   explicitly, "this is a new session" is the implicit intent. Forcing a
   new sessid on every cold boot honors that intent.

The cost is that frequent restarts of OZ trigger frequent IP rotation.
Acceptable: Jose typically runs OZ for hours at a time, not in tight
restart loops.

## Why only Oxylabs (sessid-pattern proxies)

`StickyRotation.getOrRotateSessid` returns `null` for any proxy whose
username does NOT match `-sessid-XXX-`. Brightdata uses a different
format (`brd-customer-X-zone-residential`) and supports rotation through
different means (gateway ports, `session-id` URL params). When we add
brightdata rotation it'll be a sibling helper, not an extension to this
one.

## Failure modes

- **Random collisions** — sessid is base36 8-char (~2 billion space). At
  the scale of one operator with ~5 identities rotating every 30 min,
  collisions are vanishingly unlikely.
- **Identity removed mid-rotation** — `forget(identityId)` clears the
  map; called from identity-manager when an identity is deleted (TODO:
  wire this in a follow-up if not already wired).
- **setProxy fails** — caught + logged at ERROR. The identity continues
  with whatever proxy rules were applied last (degrades gracefully).
- **Clock skew across reboots** — irrelevant; ephemeral state means each
  boot starts from a fresh clock without expectation.

## Test strategy

`tests/proxy-sticky-rotation.smoketest.js` covers (40 assertions, all
pure — no Electron, no network):

- `replaceSessidInUsername`: Oxylabs format, Brightdata no-op, null
- `isStale`: null, fresh, boundary (30 min exact), past window
- `getOrRotateSessid`: first activation, sticky reuse at 15/29 min,
  rotation after 31 min, custom window override, non-sessid proxy no-op
- `buildRulesForIdentity`: no proxy → direct, sticky → rotated, non-
  sticky → raw username
- `applyForIdentity`: setProxy called with rotated rules, null session
- `forget` cleans state + re-activation generates fresh
- Two identities track independent sessids
- Constructor validations

End-to-end visual smoke is operator-validated: launch OZ → use Pedro →
check Oxylabs dashboard IP → wait >30 min → re-activate Pedro → verify
new IP.

## Future-compatibility

When v3 SaaS lands, the same `StickyRotation` interface can be used on
the server side to manage rotation across distributed nodes — state
would move to Redis/Postgres but the public methods stay identical.
