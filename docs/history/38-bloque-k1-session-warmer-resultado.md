# Bloque K1 (session-warmer) — Scheduled Action handler keep social cookies fresh

**Status:** ✅ K1 session warmer cerrado 2026-05-15
**Commits:** `2599fe8` (feat) + `5f1d534` (test fix-up)
**Version:** 1.4.1 (patch)
**Tiempo efectivo:** ~1.5h
**Deps nuevas:** ninguna
**Tests nuevos:** +16 (session-warmer.smoketest.js) + 2 fixed pre-existing (scheduled-action-handlers consumer)

## Origen

El setup core de Jose ("50 cuentas IG logueadas que se queden logueadas") sufre de session expiry por inactividad. Plataformas como IG/X/FB rotan session cookies en cada request server-side — sin tráfico real, las cookies vencen y la cuenta queda logged out. Anti-logout (existing) extiende cookies localmente, pero algunos providers solo refrescan al ver requests reales.

## Decisión: lightweight HTTP touch, NO BrowserWindows

Considerado:

1. **Hidden BrowserWindow por identity**: spawnear `BrowserWindow({show:false})` con partition de la identity, navegar a la URL, wait, close. Pros: ejecuta JS real, refresca cookies como si fuese tab real. Contras: pesado, ~50MB/window × N identities = posible OOM. Cron daily con 50 identities = un mini DDoS al binario.

2. **net.request via session** ← ELEGIDO: `session.fromPartition('persist:identity-<id>')` + `net.request({url, session, useSessionCookies:true})`. Va por el proxy de la identity, envía cookies actuales, recibe Set-Cookie en response (Electron auto-merge a la session). Sin JS execution, sin window, sin memory bloat. Throttle 1s entre identities, timeout 8s por request, cap 50 identities por run.

3. **No-op**: dejar que anti-logout maneje solo. Insuficiente para providers que solo refrescan server-side (X confirmado, IG sospechoso).

## v1.4.1 — implementación

### Nuevo `ACTION_SESSION_WARMER = 'session-warmer'`

Agregado al registry de `browser/scheduled-action-handlers.js` (sumado a los existentes `open-workspace` + `sync-push` + `backup-snapshot` del Bloque F-1).

### `createSessionWarmerHandler({identityManager, workspaceManager, accountVault, sessionFactory, netRequest, vault})`

Factory pattern matching the rest del file. Inyectables todos los deps para test pinning. Defaults:

- `sessionFactory` → `(partition) => require('electron').session.fromPartition(partition, {cache: true})`
- `netRequest` → `(opts) => require('electron').net.request(opts)`

### Resolution flow

1. **Locked vault → benign skip**: `{skipped:true, reason:'vault-locked'}` (paridad con otros handlers F).
2. **Identity list resolution**: `params.identityIds` (priority) OR derived from `params.workspaceId` via `workspaceManager.get(wsId).identityIds`. Cap a `WARMER_MAX_IDENTITIES=50`. Throw `BAD_PARAMS` si ninguno provisto.
3. **Account-by-identity map**: best-effort load de `accountVault.getAccounts()` filtered por identity. Si vault locked o getAccounts throws, sigue con map vacío.
4. **Per-identity loop sequential**:
   - URL resolution priority: `params.urlsBySite[account.site]` → `https://<account.site>/` from accountVault primer match → `params.fallbackUrl` → null (skip).
   - `_fetchAndDiscard`: `net.request` con session de la identity, drop bytes después de 16KB (memory cap), timeout `WARMER_PER_REQ_TIMEOUT_MS=8000`. Returns statusCode o `'timeout'` / `'error'` / `'throw'`.
   - Throttle: `await setTimeout(WARMER_THROTTLE_MS=1000)` entre identities.
5. **Result shape**: `{warmed:[{identityId, url, status}], skipped:[{identityId, reason}], errors:[{identityId, url, message}], totalRequested}`.

### Wire en `scheduled-setup._buildDeps`

```js
if (browser.identityManager && typeof browser.identityManager.list === 'function') {
  deps.identityManager = browser.identityManager
  if (browser.workspaceManager) deps.workspaceManager = browser.workspaceManager
  if (browser.accountVault) deps.accountVault = browser.accountVault
}
```

Pattern matches sync-push + backup-snapshot wire: present → registered, absent → handler simply not registered.

## Cómo lo usa Jose

Scheduled Actions panel (existing UI desde F-3):

```
"+ Add action"
  type: session-warmer
  params: { workspaceId: "<insta-ws-id>" }   // o identityIds: [...]
  schedule: { type: 'cron', cron: '0 */6 * * *' }   // cada 6h
  name: "Warm IG sessions"
```

Daemon fire cada 6h → todas las identities del workspace reciben un GET a `https://instagram.com/` (or whatever account.site primary) → cookies se refrescan server-side → identities siguen logueadas.

## Tests

`tests/session-warmer.smoketest.js` (~220 LOC, **16 asserts**):

- **Factory guards** (3): throws sin identityManager, ACTION_TYPES contiene 'session-warmer', ACTION_SESSION_WARMER constant valor correcto.
- **Locked vault** (1): vault locked → `{skipped:true, reason:'vault-locked'}`.
- **identityIds resolution from workspaceId** (8): warmed array orden + status, totalRequested, errors/skipped empty, throttle ≥ 1000ms × N enforced (real setTimeout), fakeNet called N veces.
- **urlsBySite override** (1): explicit url map overrides homepage derivation.
- **no-url skip** (1): identidades sin accounts → `skipped:[{reason:'no-url'}]`.
- **fallbackUrl** (1): cuando no hay accounts pero hay fallbackUrl, fetched correctly.
- **BAD_PARAMS** (1): sin workspaceId ni identityIds throws.

Inyecta fakes (identityManager / workspaceManager / accountVault / sessionFactory / netRequest) — NO toca Electron real.

## Test fix-up follow-up

Commit `5f1d534` (1 file, 9+/-5−): el commit feat (`2599fe8`) tenía suite exit=1 porque dos tests pre-existentes en `tests/scheduled-action-handlers.smoketest.js` asumían `ACTION_TYPES.length === 3` — al sumar 'session-warmer' pasó a 4 y rompió. Actualicé las assertions para reflejar 4 tipos.

Lección guardada en memory: `feedback_grep_consumers_on_const_add.md` — antes de extender una const exported (ACTION_TYPES, STATUSES, FIX_KINDS, COUNTRIES, etc.), grep `tests/*` para consumers que assumen size exacto.

## Version bumps

- `package.json` 1.4.0 → 1.4.1 (patch)
- `browser/ui/manifest.json` 1.4.0 → 1.4.1

Lint clean. `check:loc` max 499. Suite full verde (post-fix-up).

## Pendiente

Smoke visual REAL pendiente: crear scheduled action `session-warmer` con workspaceId, schedule cada 1 min para test rápido. Logs `scheduled-actions` deben mostrar handler fire + `warmed:[...]` array. ipleak.net o IG mobile session de la identity debería refrescarse (verificar mediante un curl manual al endpoint con la session token + ver TTL).
