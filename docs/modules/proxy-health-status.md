# Módulo `proxy-health-status`

**Path:** `browser/proxy-health-status.js`
**Líneas:** ~110
**Bloque:** H-2a ✅ (2026-05-14, v1.1.1)
**Tests:** `tests/proxy-health-status.smoketest.js` (25 assertions)

## Qué hace

Aggregator puro que computa un status global agregado del pool de proxies + assignments + identities. Consumido por el badge en la toolbar superior (rojo/amarillo/verde/gris) y por el hero del Proxy Health Dashboard.

## Exports

| Símbolo                     | Tipo     | Descripción                                    |
| --------------------------- | -------- | ---------------------------------------------- |
| `computeGlobalStatus(deps)` | function | Retorna `{status, counts, lastTestedAt, hint}` |
| `STALE_THRESHOLD_MS`        | constant | `24 * 60 * 60 * 1000` (24h sin re-test)        |

## API

```js
computeGlobalStatus({proxyManager, proxyAssignment, identityManager}) → {
  status: 'green' | 'yellow' | 'red' | 'gray',
  counts: {
    total: N,
    ok: N,
    fail: N,
    disabled: N,
    untested: N,
    stale: N,
    unassigned: N,
    identities: N,
    identitiesWithProxy: N,
  },
  lastTestedAt: timestamp | null,
  hint: string,
}
```

`proxyAssignment` + `identityManager` opcionales — sin ellos solo se reporta el pool-level status.

## Decision tree

```
if !proxyManager OR pool vacío → gray
elif any proxy disabled → red                                  (leak risk for assigned identities)
elif any non-default identity sin proxy AND identities > 1 → red  (leak risk — using real IP)
elif any proxy with failures → yellow
elif any proxy untested OR stale (>24h) → yellow
elif at least 1 ok proxy → green
else → gray (unknown)
```

Edge case: si solo existe la `default` identity (sin custom identities), unassigned no triggea red — el modelo asume default usa `defaultSession` y eso es OK.

## Counters

| Field                 | Significa                                                                      |
| --------------------- | ------------------------------------------------------------------------------ |
| `total`               | Tamaño del pool (`proxyManager.list().length`)                                 |
| `ok`                  | Proxies con `lastTestedAt` reciente + `failureCount = 0` + no disabled         |
| `fail`                | Proxies con `failureCount > 0` (auto-disable kick-in en 3 fallos)              |
| `disabled`            | Proxies con `isDisabled = true` (manual o auto)                                |
| `untested`            | Proxies sin `lastTestedAt` (nunca testeados)                                   |
| `stale`               | Proxies con `lastTestedAt` viejo (>24h)                                        |
| `unassigned`          | Identidades non-default sin proxy resolved                                     |
| `identities`          | Total identidades en el sistema                                                |
| `identitiesWithProxy` | Identidades con proxy resolved (incluye default si tiene asignación explícita) |

## Side effects

NINGUNO. Función pura — solo lee del state, NO muta.

## Tests

`tests/proxy-health-status.smoketest.js` — 25 assertions cubriendo:

- Empty pool → gray
- Single healthy proxy → green
- Single disabled → red
- Untested / stale → yellow
- Failures → yellow
- Mixed: healthy proxy + 1 identity unassigned + 1 with proxy → red
- Single non-default identity unassigned does NOT trigger red (edge case)
- All-clear scenario → green
- `lastTestedAt` = max across pool
- Defensive: no proxyManager → gray

## Gotchas

1. **`unassigned` is calculated via `proxyAssignment.resolve(...)`** — eso significa que la cascade completa se evalúa (`byIdentity → byWorkspace → defaultStrategy`). Una identity con `defaultStrategy='auto-random'` no cuenta como unassigned aunque no tenga `byIdentity` entry.

2. **`isActive` del proxy no afecta el status global**. La heurística del badge se enfoca en `isDisabled` (que es la señal canonical de "no usar"). `isActive=false` es un legacy flag.

3. **Stale threshold = 24h** es hardcoded como `STALE_THRESHOLD_MS`. Si querés cambiar el threshold, modificar el constant + bump version + actualizar tests.

4. **`identitiesWithProxy` puede incluir la default** si `proxyAssignment.resolve({identityId: 'default'})` devuelve algo. Por default, default usa `defaultSession` + el hook de proxy resolution se aplica igual. Esto es by design.

## Referencias

- `browser/proxy-manager.js` — list() + flags
- `browser/proxy-assignment.js` — resolve() cascade
- `browser/identity-manager.js` — list()
- `browser/ipc-handlers-extra.js` — IPC `oz:proxyHealth:getGlobalStatus`
- `browser/ui/proxy-health-badge.js` — consumer (poll + render)
- `browser/proxy-dashboard-data.js` — incluye este status en su snapshot
- `docs/history/32-bloque-h2-resultado.md` — context H-2
