# Módulo `proxy-actions`

**Path:** `browser/proxy-actions.js`
**Líneas:** ~190
**Bloque:** H-2c + H-2d ✅ (2026-05-15, v1.1.2)
**Tests:** `tests/proxy-actions.smoketest.js` (52 assertions)

## Qué hace

Factory que construye el set de acciones operativas que el Proxy Health Dashboard expone al usuario. Las acciones cubren el pool de proxies (test/reset/disable/rotate/delete) + assignments per-identity (reload session, reassign). Todas las acciones retornan `{ok: bool, ...detail}` y nunca throw — los errores se convierten en `ok:false + reason + message`.

## Exports

| Símbolo                                | Tipo     | Descripción                                                                                   |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `buildProxyActions(deps)`              | function | Factory. Throws si `deps.proxyManager` missing. Retorna objeto con las 7 funciones de acción. |
| `_normalizeSessidInUsername(username)` | function | Helper interno expuesto para tests. Rotación Oxylabs sticky session-id.                       |

### `deps` shape

```js
buildProxyActions({
  proxyManager, // required
  proxyAssignment, // optional — needed for delete/reassign cleanup
  proxyHealth, // optional — needed for test/reset re-test
  identityManager, // optional — needed for reloadSession/reassign
  toProxyRulesString, // function (proxy) → string — from proxy-assignment.js
})
```

## Acciones expuestas

### `testProxy(proxyId)` → Promise<{ok, result?, reason?, message?}>

Dispara `proxyHealth.testOne(proxyId)` y devuelve el resultado. Si no hay daemon → `NO_HEALTH_DAEMON`. Si testOne throws → `TEST_FAILED + message`.

### `resetProxy(proxyId)` → Promise<{ok, proxyId?, reason?}>

Patches `failureCount=0, isDisabled=false, isActive=true, lastTestedAt=null, lastLatencyMs=null, lastTestedIp=null` en el proxy. Luego best-effort re-test (errores ignorados, no afectan `ok`). Si proxy missing → `NOT_FOUND`.

### `setDisabled(proxyId, disabled)` → {ok, proxyId?, isDisabled?, reason?}

Toggle manual `isDisabled` flag. Independiente del auto-disable del daemon (3 fallos consecutivos). Útil para deshabilitar proactivamente sin esperar fallos.

### `rotateSticky(proxyId)` → {ok, proxyId?, newUsername?, reason?, message?}

Rota el `session-id` en formato Oxylabs (`-sessid-XXX-`) generando uno nuevo random base36. Si el username no tiene `-sessid-` marker → `NOT_STICKY`. Use case: cuando una IP residential sticky lleva días en uso (anti-detect risk), rotarla pide una nueva IP del provider al próximo connect.

### `deleteProxy(proxyId)` → {ok, proxyId?, reason?, message?}

Limpia el proxy de cualquier `byIdentity/byWorkspace` assignment vía `proxyAssignment.clearByProxyId(id)` (si está disponible) y después llama `proxyManager.remove(id)`. Identidades que tenían este proxy fallback al `defaultStrategy` (puede ser otra auto-\* o null). NO destruye sessions cacheadas — siguen con su proxy aplicado hasta que se invaliden.

### `reloadSession(identityId)` → Promise<{ok, identityId?, proxyId?, rules?, reason?, message?}>

Re-aplica el proxy resuelto sobre la session Electron cacheada de esa identity vía `session.setProxy({proxyRules})`. **Esta es la operación clave que resuelve el bug de sessions cacheadas pre-proxy-assignment** (caso de Jose 2026-05-14: la session de Contexto IG se creó en un boot anterior sin proxy → quedó con `direct://`).

Flow interno:

1. `identityManager.get(identityId)` → identidad existe?
2. `identityManager.getSession(identityId)` → handle al Session de Electron
3. `proxyAssignment.resolve({identityId, workspaceId})` → proxy actual
4. `toProxyRulesString(proxy)` → string `host:port` (o `'direct://'` si null)
5. `await ses.setProxy({proxyRules})`

Errores posibles: `NO_IDENTITY_MGR`, `NOT_FOUND`, `NO_SESSION`, `SET_PROXY_FAILED + message`.

### `reassignProxy(identityId, value)` → Promise<{ok, identityId?, value, sessionReload?, reason?}>

Updatea `proxyAssignment.assignToIdentity(identityId, value)` donde `value` puede ser:

- `proxyId string` — proxy concreto
- `'auto-random'` — estrategia auto
- `'auto-round-robin'` — estrategia auto
- `null` — limpia la asignación (fallback a workspace/defaultStrategy)

Después cascade-llama `reloadSession(identityId)` para aplicar el cambio sobre la session actual sin esperar a un nuevo session create.

Si no hay `proxyAssignment` → `NO_ASSIGNMENT_MGR`. Si assignToIdentity throws → `ASSIGN_FAILED`.

## Helper `_normalizeSessidInUsername(username)`

Regex `-sessid-([^-]+)` aplicado sobre el username. Si match:

- Genera nuevo sessid: `Math.floor(Math.random() * 1e8).toString(36).slice(0, 8)`
- Reemplaza con `string.replace(/-sessid-[^-]+/, '-sessid-${new}')`
- Preserva resto del username (incluyendo `-sesstime-N`)

Sin match → returns `null` (signal de "este proxy no es sticky, no se puede rotar").

Input edge cases: `null` → `null`, `undefined` → `undefined`, `''` → `''`, non-string → input passthrough.

## Side effects

- `proxyManager.update(...)` / `proxyManager.remove(...)`
- `proxyAssignment.assignToIdentity(...)` / `proxyAssignment.clearByProxyId(...)`
- `proxyHealth.testOne(...)`
- `session.setProxy({proxyRules})` sobre el Electron Session de la identity
- `log.info('proxy-actions', ...)` en sticky rotation + session reload

## Tests

`tests/proxy-actions.smoketest.js` — 52 assertions:

- `_normalizeSessidInUsername` 7 edge cases (sticky/no-sessid/null/undefined/empty/non-string/rotation-preserves-format)
- `buildProxyActions` factory validation
- `testProxy` happy path / no daemon / throws
- `resetProxy` patches correctly + re-test fires + not found
- `setDisabled` toggle both directions + not found
- `rotateSticky` happy + non-sticky + not found
- `deleteProxy` clears assignments + removes + not found
- `reloadSession` happy + not found / no session / setProxy throws / direct fallback
- `reassignProxy` cascade reloadSession + no assignment mgr

## Gotchas

1. **session caching**: `session.fromPartition('persist:identity-X')` retorna la misma instance cada vez (Electron-managed). Re-applying proxy NO destruye cookies/state — solo cambia el proxyRules para futuros requests.

2. **rotateSticky depende del username format Oxylabs**. Para otros providers (Bright Data, Smartproxy, etc.) que usan otro formato de sticky, el regex puede no aplicar — caso por caso. Si el username no tiene `-sessid-`, retorna `NOT_STICKY` (no error catastrófico).

3. **deleteProxy NO invalida sessions cacheadas**. Una identity que estaba usando el proxy borrado sigue ruteando vía ese proxy (en memoria) hasta que la session se recree O hasta que el user llame `reloadSession`. Para forzar re-resolution masiva post-delete, llamar reloadSession sobre todas las identities afectadas.

4. **reassignProxy con value=null**: la identity cae al `defaultStrategy` del `proxyAssignment.assignments.defaultStrategy`. Si ese también es null → la identity queda **sin proxy** = leak risk. UI debería advertir al user antes de set null si no hay defaultStrategy.

## Referencias

- `browser/proxy-manager.js` — pool storage
- `browser/proxy-assignment.js` — resolution cascade + assignment storage
- `browser/proxy-health.js` — testOne daemon + auto-disable
- `browser/ipc-handlers-extra.js` — IPC wiring `oz:proxyAction:*`
- `preload-proxy.js` — renderer-side bindings `window.oz.proxyAction.*`
- `browser/ui/proxy-dashboard.js` — UI delegated handlers
- `docs/history/32-bloque-h2-resultado.md` — context del bloque H-2
