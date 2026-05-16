# Bloque H-2-wire + H-2-extras — cierra el set H-2 completo

**Status:** ✅ H-2-wire + H-2-extras cerrados 2026-05-15
**Commit:** `e6d4f8f`
**Version:** 1.1.6
**Tiempo efectivo:** ~2h (H-2-wire ~30min + H-2-extras ~1.5h)
**Deps nuevas:** ninguna
**Tests nuevos:** +29 (proxy-bulk-backup 9 + proxy-diagnostic-export 20)

## Origen

Cerrar el set H-2 (Proxy Ops Dashboard) que arrancó en 1.1.1 con H-2a badge. Después de 1.1.5 ya teníamos a→k shipped — bulk ops, leak tests, coherence overlay, Oxylabs builder. Faltaban los 3 sub-bloques pequeños del roadmap:

1. **H-2-wire** — el modal proxy-manager existing (pre-dashboard) seguía siendo el único path para CRUD de proxies single, pero no acknowledge la existencia del dashboard. Los users que abrían el modal no sabían que el dashboard tab tenía bulk + builder + leak tests.
2. **H-2-extras (a) backup pre-bulk** — bulk delete/disable son destructivos. Sin snapshot pre-op, una mala selección puede borrar 50 proxies sin recovery.
3. **H-2-extras (b) export diagnostic** — cuando algo va mal con proxies (Contexto IG-like bugs), queremos un bundle exportable para troubleshooting sin tener que reproducir el state.

## v1.1.6 — H-2-wire + extras

### H-2-wire — proxy-manager modal ↔ dashboard tab

`browser/ui/webui.html` línea 4239: nuevo `<button id="oz-pm-dashboard-btn" class="pm-primary" title="...">📊 Open Dashboard</button>` agregado al pm-toolbar entre `Test all` y el spacer.

`browser/ui/proxy-manager.js`:

- En `constructor()`: `this.$btnDashboard = document.getElementById('oz-pm-dashboard-btn')`.
- En `_wire()`: `if (this.$btnDashboard) this.$btnDashboard.addEventListener('click', () => this.openDashboardTab())`.
- Nuevo método `openDashboardTab()`: defensive null check del bridge → `window.oz.proxyHealth.openDashboard()` → si `r.ok`, `this.close()`; si falla, `showError(r.reason)`.

El proxy-manager queda como vista compacta de CRUD single (add/edit/import-csv/export-csv/providers/test-all). Todo lo operativo (bulk, leak, coherence, builder, alerts, diagnostics) vive en el dashboard tab.

### H-2-extras (a) — pre-bulk-destructive backup

**Módulo nuevo `browser/proxy-bulk-backup.js`** (~135 LOC):

- Factory `buildProxyBulkBackup({proxyManager, userDataDir, now})` → `{snapshot, list, pruneOldBackups, _dir}`.
- `snapshot({reason, ids})`: ensure dir → `proxyManager.list()` → write JSON blob a `userData/proxy-bulk-backups/<isoTs>.json` con shape `{ts, reason, ids, proxies}` → call `pruneOldBackups()` → return `{ok, path, count, ts, reason}` o `{ok:false, reason:'...'}` (NUNCA throw — backup failures no bloquean la op real).
- `list()`: scan dir, parse each JSON, sort newest-first, return `[{ts, reason, count, idsCount, path}]`.
- `pruneOldBackups()`: trim al cap MAX_KEPT=20 (declared como const exported).
- ISO timestamp filename con `:` y `.` reemplazados por `-` para compatibility con FS.

**Wire en `proxy-actions-bulk.js`**: factory ahora acepta `bulkBackup` optional. Antes de `bulkDeleteProxies(ids)` (siempre) y `bulkSetDisabled(ids, true)` (solo cuando flag=true), llama `bulkBackup.snapshot({reason, ids})`. El backup result se attachea al bulk result como `r.backup = {ok, path, count, ...}`. Si bulkBackup no está wireado (tests), behavior unchanged.

**Wire en `ipc-handlers-extra.js`**: singleton `browser._proxyBulkBackup` build-once via `try { app.getPath('userData') }` con catch defensive para non-Electron contexts (tests). `bulk()` factory consume el singleton. Nuevo IPC `oz:proxyBulkBackup:list` para inspeccionar snapshots.

**Restore**: NO hay UI de restore en v1.1.6. El path se loguea, el user puede inspeccionar/restaurar manualmente. Auto-restore deferred a 1.1.7+ — merge logic con post-backup creates es delicada (proxy IDs pueden colisionar) y queremos pensarlo bien.

### H-2-extras (b) — export diagnostic bundle

**Módulo nuevo `browser/proxy-diagnostic-export.js`** (~140 LOC, pure):

- `buildDiagnosticBundle({proxyManager, proxyAssignment, identityManager, workspaceManager, alertManager, leakTestHandlers, appVersion, platform, now})` returns serializable object.
- **Sanitization dura**:
  - `proxy.username` → `<redacted>` (Oxylabs/SmartProxy embed customer-id; nunca se exporta)
  - `proxy.password` → `<redacted>`
  - Cookies + accountVault: NUNCA tocados (no se piden a los managers)
  - leakTests: solo `overall + webrtcStatus + dnsStatus + webrtcReason + dnsReason + proxyCountry` — NO `srflxIps/dnsServers` (per-IP privacy)
- Subsystems agregados: `meta` (ts/appVersion/platform/bundleVersion/note) + `proxies` + `assignments` (byIdentity/byWorkspace/defaultStrategy) + `identities` (id/name/workspaceId/isDefault/color) + `workspaces` (id/name/isArchived/isFrozen) + `alerts` (activeOnly via alertManager) + `leakTests`.

**IPC `oz:proxyHealth:exportDiagnostic`**: buildBundle → `dialog.showSaveDialog` (default name `oz-proxy-diagnostic-<YYYY-MM-DD>.json` en `~/Downloads`) → `fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2))` → return `{ok, path, bytes}` o `{ok:false, reason:'CANCELED'|'EXPORT_FAILED', message}`.

**UI**: nuevo botón `📋 Export diag` en proxy-dashboard header (después de `Test all now`). Wire via `browser/ui/proxy-dashboard-export.js` (~45 LOC IIFE) — extraído del proxy-dashboard.js para mantener LOC budget bajo 500. Expone `window.OZ_DashboardExport.wire(btn, t)`. Click → IPC → success alert con el path, cancel silent, failure alert con reason.

**Preload**: `window.oz.proxyHealth.exportDiagnostic()` + `window.oz.proxyBulkBackup.list()` en preload-proxy.js.

### Locales

`proxyDashboard.{exportDiag, exportDiagUnavailable, exportDiagOk, exportDiagFailed}` × EN + ES (4 keys × 2 idiomas).

### Version bumps

- `package.json` 1.1.5 → 1.1.6
- `browser/ui/manifest.json` 1.1.5 → 1.1.6

### LOC budget

- `proxy-dashboard.js`: 499 LOC (extraje export wire a sibling para no exceder 500).
- Resto bajo budget.

## Tests

+29 assertions across 2 archivos nuevos:

- `tests/proxy-bulk-backup.smoketest.js` (9 asserts): factory throws sin userDataDir + snapshot happy + JSON shape valid + defensive guards (no proxyManager, broken proxyManager) + list shape + pruneOldBackups respeta MAX_KEPT cap.
- `tests/proxy-diagnostic-export.smoketest.js` (20 asserts): empty deps defensive + full bundle meta shape + **sanitization dura** (password redacted, username redacted, `JSON.stringify(bundle)` no contiene raw "topsecret" ni raw "customer-mzewama-cc-ar-sessid-000001") + preserved fields (host/country/city/lastTestedIp) + subsystems aggregated (assignments/identities/workspaces/alerts/leakTests) + leakTests sin srflxIps (privacy).

Suite full verde. Lint clean.

## Cierra el set H-2 completo 🎉

Inventory final del Proxy Ops Dashboard (1.1.1 → 1.1.6):

| Sub-bloque                                | Versión | Commit    |
| ----------------------------------------- | ------- | --------- |
| H-2a Badge global toolbar                 | 1.1.1   | `bb0261c` |
| H-2b Dashboard tab read-only + paginación | 1.1.1   | `9baf774` |
| H-2c Acciones per-proxy                   | 1.1.2   | `041b1f9` |
| H-2d Acciones per-identity                | 1.1.2   | `041b1f9` |
| H-2e Diagnostics + alerts automáticos     | 1.1.3   | `4c130ee` |
| H-2f Bulk multi-select + bulk actions     | 1.1.3   | `405b948` |
| H-2g Bulk import CSV/TXT auto-detect      | 1.1.3   | `72086dc` |
| H-2h Bulk assign 1:1                      | 1.1.3   | `6bf758c` |
| H-2i Anti-detect coherence overlay        | 1.1.4   | `2966ed5` |
| H-2j WebRTC + DNS leak tests              | 1.1.4   | `2966ed5` |
| H-2k Oxylabs Proxy Builder modal          | 1.1.5   | `35e6292` |
| H-2-wire proxy-manager ↔ dashboard        | 1.1.6   | `e6d4f8f` |
| H-2-extras pre-bulk backup + diag export  | 1.1.6   | `e6d4f8f` |

13 sub-bloques, ~25h efectivos (vs ~23h estimados), ~470 tests nuevos, cero deps externas agregadas.

## Pendiente

- Smoke visual REAL con app corriendo:
  1. Click `📊 Open Dashboard` desde proxy-manager modal → modal cierra + dashboard tab abre
  2. Hacer bulk delete sobre 2-3 proxies → verificar `userData/proxy-bulk-backups/` contiene snapshot recién creado con shape correcta
  3. Click `📋 Export diag` → save dialog → guardar → abrir JSON, verificar: meta.appVersion=1.1.6, proxy.username=`<redacted>`, sin `topsecret` ni customer id raw

## Próximos sub-bloques (1.2.0+)

Per roadmap:

- `1.2.0` G-6 Ghost importer también importa proxies (~3h)
- `1.3.0` J Auto-login completo — auto-fill + auto-save + 2FA + auto-relogin (~6h) — el core feature que falta para que accountVault sea útil
- `1.4.0` K1-extras: bulk-open + session warmer + identity HUD + onboarding wizard + Mac sleep (~12h)
- `1.5.0` i18n cobertura completa (~4h)
- `1.6.0` Apple Dev signing (bloqueado) + I-2 auto-updater
