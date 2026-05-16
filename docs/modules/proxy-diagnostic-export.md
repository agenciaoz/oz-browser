# Módulo `proxy-diagnostic-export`

**Path:** `browser/proxy-diagnostic-export.js`
**Líneas:** ~140 (pure)
**Bloque/Etapa:** H-2 extras (v1.1.6)

## Qué hace

Builder de bundle JSON sanitizado con el state del subsystema proxies. Usado para troubleshooting cuando algo va mal (Contexto IG-like bugs) — el user exporta el bundle y lo manda a soporte/agrega a un issue sin reproducir el state.

## Sanitización dura

**NUNCA exporta:**

- `proxy.password` → `<redacted>`
- `proxy.username` → `<redacted>` (Oxylabs/SmartProxy embed customer-id; nunca se exporta)
- Cookies (no se piden a los managers)
- accountVault contents (no se pide)
- leakTests: solo `overall + webrtcStatus + dnsStatus + webrtcReason + dnsReason + proxyCountry` — NO `srflxIps` / `dnsServers` full (per-IP privacy)

**Sí exporta:**

- proxies: host/port/protocol/country/city/tags/status/lastTestedAt/lastLatencyMs/lastTestedIp/failureCount/isDisabled/usedByCount
- assignments: identityId → proxyId mapping
- identities: id/name/workspaceId/isDefault/color
- workspaces: id/name/isArchived/isFrozen
- alerts: activeOnly via alertManager.list
- leakTests: overview-only
- meta: appVersion, platform, ts, bundleVersion, note

## API

```js
const { buildDiagnosticBundle, REDACTED } = require('./proxy-diagnostic-export')

const bundle = buildDiagnosticBundle({
  proxyManager,
  proxyAssignment,
  identityManager,
  workspaceManager,
  alertManager,
  leakTestHandlers,
  appVersion, // string
  platform, // string (process.platform)
  now, // optional — () => Date
})
// → { meta, proxies, assignments, identities, workspaces, alerts, leakTests }
```

Pure — no Electron, no fs. El caller (IPC handler) hace `dialog.showSaveDialog` + `fs.writeFileSync`.

## IPC

`oz:proxyHealth:exportDiagnostic` en `ipc-handlers-extra.js`:

1. `buildDiagnosticBundle({...})`
2. `dialog.showSaveDialog({defaultPath: '~/Downloads/oz-proxy-diagnostic-<YYYY-MM-DD>.json'})`
3. `fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2))`
4. Returns `{ok, path, bytes}` o `{ok:false, reason:'CANCELED'|'EXPORT_FAILED', message}`.

## UI

Dashboard header → botón `📋 Export diag` wireado via `browser/ui/proxy-dashboard-export.js` (sibling separado para LOC budget).

## Tests

`tests/proxy-diagnostic-export.smoketest.js` — **20 asserts**:

- Empty deps defensive (1)
- Full bundle meta shape (4)
- **Sanitization DURA** (8) — `JSON.stringify(bundle)` NO contiene raw "topsecret" ni raw "customer-mzewama-cc-ar-sessid-000001"; password/username strings === REDACTED; host/country/city/lastTestedIp PRESERVED.
- Subsystems aggregated (6)
- `leakTests` NO incluye srflxIps (privacy) (1)

## Gotchas

- El test usa `JSON.stringify(bundle).includes('topsecret')` como assertion negativa — si en el futuro alguien expone otro field que pase el password por error, este test rompe.
- `alertManager.list({activeOnly: true})` filtra alerts. Si el caller cambia activeOnly default a false, el bundle exportaría TODO el history — chequear el contract si se reusa esta función.
