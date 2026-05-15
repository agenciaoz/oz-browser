# Bloque H-2 (i/j) — Anti-detect coherence overlay + WebRTC/DNS leak tests

**Status:** ✅ H-2i + H-2j cerrados 2026-05-15
**Commit:** TBD (pendiente push)
**Version:** 1.1.4
**Tiempo efectivo:** ~3.5h
**Deps nuevas:** ninguna
**Tests nuevos:** +64 (leak-tests 34 + proxy-dashboard-health 18 + proxy-dashboard-leaks 12)

## Origen

Después de cerrar H-2a→H-2h (badge + dashboard + per-proxy/per-identity actions + diagnostics/alerts + bulk multi-select + bulk import + bulk assign 1:1) en `v1.1.1`→`v1.1.3`, el Proxy Health Dashboard ya era operativo pero medía solo **proxy reachability** (¿el proxy responde? ¿está disabled?). El core del producto OZ Browser es **anti-detect** — y nada en el dashboard verificaba si el fingerprint era coherente con el proxy, ni si WebRTC/DNS bypassaban el proxy. Sin H-2i/j el dashboard puede decir "todo verde" cuando en realidad el sitio destino ve la IP real del usuario o el timezone del browser delata otro country.

El backend de coherence anti-detect ya existía desde E2-C-6: `anti-detect-health.js` (501 LOC) con 4 vectores (ipTimezone, fingerprintCoherence, cookieHealth, proxyReachability) + handlers con `FIX_KINDS.APPLY_GEO` wireado a `fingerprintEngine.applyGeoSuggestion()` + IPC `oz:health:applyFix` + UI consumer en `health-modal.js` y `sidebar-health.js`. **Estaba todo backend pero el dashboard tab no lo consumía**. H-2i es essentially UI integration sobre ese backend.

H-2j es greenfield: nada de WebRTC/DNS leak existía antes. Decisión Jose 2026-05-15: full automated (no manual-assisted) — el dashboard tiene que correr los tests por sí mismo y dar un verdict objetivo.

## Decisiones (Jose 2026-05-15)

1. **H-2j full automated** (vs manual-assisted). Realidad ~2-2.5h vs estimación original 1.5h.
2. **No nueva columna en la tabla de identities** — el coherence status se mete en el existing Status pill, fix button inline en Actions cell. Ahorra cluttering y mantiene la layout. El badge de leak-test queda al lado del botón "🛡️ Leak test" en Actions.
3. **Sólo `APPLY_GEO` surface inline** — los demás FIX_KINDS (REROLL_FP, REASSIGN, MARK_RELOGIN) ya tienen UI dedicada en `health-modal.js` y la sidebar; surfacing todos inline clutearía el row.
4. **Dialog de leak result vía `window.alert` formatted multi-line** — modal full deferred a future polish. Lo importante para v1.1.4 es shippear el engine.
5. **Bumpear MANIFEST de UI** según regla `feedback_webui_manifest_bump` (sin esto el electron-chrome-extensions sirve cacheado y los cambios son invisibles).

## v1.1.4 — H-2i + H-2j

### H-2i — Anti-detect coherence overlay

**Backend (preexistente E2-C-6, no tocado):**

- `browser/anti-detect-health.js` (501 LOC, pure) — `evaluateHealth({identity, fingerprint, proxy, cookies}) → {overall, vectors: {ipTimezone, fingerprintCoherence, cookieHealth, proxyReachability}}`. `worstOf(...)` derives `overall` (unknown ≈ green). 4 vectores con per-vector `{status, summary, details, fix}`.
- `browser/anti-detect-health-handlers.js` — factory `buildHealthHandlers(browser) → {get, list, applyFix}`. `applyFix({identityId, kind, vector})` despacha por kind: APPLY_GEO calls `fingerprintEngine.applyGeoSuggestion(id, suggestion)`, broadcast `oz:health:changed`.
- IPC `oz:health:{get, list, applyFix}` ya registrados en `ipc-handlers-extra.js`.
- Preload `window.oz.health.{get, list, applyFix, onChanged}` ya expuesto.

**Nuevo UI:**

- `browser/ui/proxy-dashboard-health.js` (~135 LOC, IIFE expone `window.OZ_DashboardHealth`):
  - `fetchHealthMap()` → `Map<identityId, healthRecord>` (graceful empty on bridge missing).
  - `deriveStatus(identity, healthRecord)` — combines `leakRisk` + `healthRecord.overall`. Rule: leak risk wins porque "non-default identity sin proxy" es peor que cualquier coherence mismatch. Sin healthRecord falls back a legacy `proxy ? green : gray`.
  - `buildStatusSummary(healthRecord, t)` — finds the worst vector, builds `<label>: <summary>` for tooltip. Returns `null` si todos green (nada que surface).
  - `renderFixButton(identity, healthRecord, t, esc)` — returns HTML for `<button data-act="apply-geo-fix">` SOLO si `vectors.ipTimezone.fix.kind === 'apply-geo-suggestion'` AND non-default identity. Empty string otherwise.
  - `subscribeChanged(onChange)` — wraps `window.oz.health.onChanged()` con try/catch defensive.

**Wire en `proxy-dashboard.js`:**

- New state: `healthMap = new Map()` + `const healthApi = window.OZ_DashboardHealth`.
- `fetchHealth()` paralelo a `fetchData` + `fetchAlerts` + (nuevo) `fetchLeaks`.
- `renderIdentities`: por cada identity row, lookup `healthMap.get(i.id)`, pass a `healthApi.deriveStatus` para el status pill, `buildStatusSummary` para tooltip `title` attr, `renderFixButton` se inyecta al `row-actions div` antes del Reload button.
- `start()` wirea `healthApi.subscribeChanged(async () => { await fetchHealth(); renderIdentities() })` — applyFix from anywhere (sidebar, health-modal, MCP, inline button) re-fetches sin polling.
- Auto-refresh 30s tab-visible incluye fetchHealth.

**Wire en `proxy-dashboard-actions.js`:**

- New case `'apply-geo-fix'`: llama `window.oz.health.applyFix({identityId, kind: 'apply-geo-suggestion', vector: 'ipTimezone'})`, success → `window.alert` con TZ + locale aplicados.

### H-2j — WebRTC + DNS leak tests

**Nuevo backend:**

- `browser/leak-tests.js` (~310 LOC, **pure**, no Electron):
  - `STATUSES = {GREEN, YELLOW, RED}` frozen.
  - `LEAK_REASONS = {NO_STUN_RESPONSE, WEBRTC_LEAK, WEBRTC_PRIVATE_LEAK, NO_IPLEAK_RESPONSE, IP_MISMATCH, COUNTRY_MISMATCH, DNS_GEO_MISMATCH}` frozen.
  - `analyzeWebRtcCandidates({candidates, proxyPublicIp})`:
    - candidates vacíos → yellow / NO_STUN_RESPONSE
    - srflx que NO matchea proxyPublicIp → red / WEBRTC_LEAK
    - host candidates exposing public IPv4/IPv6 (not mDNS .local, not private range) → red / WEBRTC_PRIVATE_LEAK
    - sin proxyPublicIp + srflx detectado → yellow inconclusive (caller debe correr `proxyHealth.testOne` primero para populate `proxy.lastTestedIp`)
    - srflx === proxyPublicIp y sin host leaks → green
  - `analyzeDnsLeak({ipleakJson, proxyCountry, proxyPublicIp})`:
    - null/non-object json → yellow / NO_IPLEAK_RESPONSE
    - `ipleakJson.ip !== proxyPublicIp` → red / IP_MISMATCH
    - `ipleakJson.country_code !== proxyCountry` (case-insensitive) → red / COUNTRY_MISMATCH
    - `dns_servers[*].country_code !== proxyCountry` → yellow / DNS_GEO_MISMATCH
    - no issues → green
  - `combineLeakResults({webrtc, dns, identityId, evaluatedAt}) → {overall, webrtc, dns, identityId, evaluatedAt}` — worst-of overall, null inputs gracefully → green.
  - `parseRtcCandidate(input)` — acepta:
    1. Structured object con `{type, address, ...}` (modern RTCIceCandidate)
    2. Object con `{candidate: 'candidate:...'}` (SDP string field)
    3. Raw SDP string `'candidate:1 1 UDP 2122252543 192.168.1.5 56789 typ host generation 0'`

    Returns `{type, address, protocol, port}` o `null` si unparseable.

  - `isPrivateRange(ip)` cubre RFC 1918 (10/8, 192.168/16, 172.16-31/12) + 127/8 loopback + 169.254/16 link-local + IPv6 fe80/fc/fd unique-local.
  - `isMdnsLocal(ip)` — `.local` suffix (modernos browsers anonymize host candidates así por default).

- `browser/leak-tests-handlers.js` (~290 LOC):
  - Factory `buildLeakTestHandlers(browser) → {run, get, list, clear}` con cache `browser._leakTestCache: Map<identityId, record>`.
  - `run({identityId})`: resuelve identity + proxy via `proxyAssignment.resolve`, extrae `proxyPublicIp = proxy.lastTestedIp` + `proxyCountry = proxy.country`, ejecuta `Promise.all([runWebRtcTest, runDnsTest])` con catch → yellow gracefully, combina, cachea, broadcast `oz:leakTest:changed`. Decorates result con `identityName/identityColor/proxyId/proxyName/proxyCountry/proxyPublicIp` para UI.
  - `runWebRtcTest({identity, proxyPublicIp})`:
    1. `new BrowserWindow({show:false, width:1, height:1, webPreferences:{partition:'persist:identity-<id>', contextIsolation:true, sandbox:true, backgroundThrottling:false}})` — hereda proxy de la session de la identity automáticamente.
    2. `loadURL(data:text/html;base64,<HTML>)` con `<script>` inline que registra `new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]})`, `createDataChannel`, `onicecandidate → window.OZ_CANDIDATES.push({type, address, port, protocol, candidate})`, `createOffer().then(setLocalDescription)`.
    3. `collectCandidates`: poll cada 300ms via `win.webContents.executeJavaScript('window.OZ_CANDIDATES || []')`, early-exit cuando hay srflx y >1.5s elapsed (stable signal), hard timeout 4500ms.
    4. `win.close()` en finally (defensive try/catch).
    5. Map candidates via `parseRtcCandidate`, pass a `analyzeWebRtcCandidates`.
  - `runDnsTest({identity, proxyCountry, proxyPublicIp})`:
    1. `session.fromPartition('persist:identity-<id>', {cache: true})` — misma session que las tabs reales (mismo proxy + cookies).
    2. `net.request({url:'https://ipleak.net/json/', session, useSessionCookies:false})` con timeout 6000ms.
    3. Parse JSON, pass a `analyzeDnsLeak`.

- IPC `oz:leakTest:{run, get, list, clear}` registrados en `ipc-handlers-extra.js` con singleton `browser._leakTestHandlers`.
- Preload `window.oz.leakTest.{run, get, list, clear, onChanged}`.

**Nuevo UI:**

- `browser/ui/proxy-dashboard-leaks.js` (~135 LOC, IIFE expone `window.OZ_DashboardLeaks`):
  - `fetchLeakMap()` — hydrate cached records (no fresh runs on load — user triggers).
  - `renderLeakButton(identity, leakRecord, t, esc)` — botón `data-act="run-leak-test"` + pill badge con last-result overall + tooltip con `buildLeakSummary`.
  - `buildLeakSummary(record, t)` — concise multi-line para tooltip / dialog.
  - `runLeakTest(identityId)` — delega a `window.oz.leakTest.run({identityId})`.
  - `formatResultDialog(record, t)` — multi-line text para `window.alert`: overall + proxy + WebRTC verdict con srflx IPs + DNS verdict con detected IP/country.
  - `subscribeChanged(onChange)` — wraps `window.oz.leakTest.onChanged()`.

**Wire en `proxy-dashboard.js`:**

- New state `leakMap = new Map()` + `const leaksApi = window.OZ_DashboardLeaks`.
- `fetchLeaks()` paralelo en `start`, `setInterval 30s`, `btn-refresh`.
- `renderIdentities`: `leakBtn = leaksApi.renderLeakButton(i, leakMap.get(i.id), t, esc)` se inyecta al `row-actions div` después del Reload.
- `start()` wirea `leaksApi.subscribeChanged(...)` para live refresh.

**Wire en `proxy-dashboard-actions.js`:**

- New case `'run-leak-test'`: llama `OZ_DashboardLeaks.runLeakTest(id)`, después `window.alert(OZ_DashboardLeaks.formatResultDialog(r, t))`.

### Locales

Dos namespaces nuevos en `browser/ui/locales/{en,es}.json` (17 keys × 2 idiomas):

- `proxyDashboard.coherence.{vectorIpTz, vectorFp, vectorCookies, vectorProxy, applyFix, applyFixTitle, applyFixOk}`
- `proxyDashboard.leak.{run, runTooltip, title, overall, proxy, webrtc, dns, leaked, noResult, error}`

### Version bumps

- `package.json` 1.1.3 → 1.1.4
- `browser/ui/manifest.json` 1.1.3 → 1.1.4 (regla `feedback_webui_manifest_bump`)

## Tests

3 archivos nuevos, +64 assertions:

- `tests/leak-tests.smoketest.js` — 34: parseRtcCandidate 6 (null + structured + SDP host/srflx + object-with-candidate + malformed) + private/local helpers 8 (RFC 1918 ranges + IPv6 + non-private + mDNS) + analyzeWebRtcCandidates 6 (empty + match + mismatch + private-leak + mDNS-only + no-proxy-ip) + analyzeDnsLeak 7 (null + match + IP mismatch + country mismatch + DNS geo + no-proxy-info + case-insensitive) + combineLeakResults 5 (green+green / green+yellow / yellow+red / null+null / evaluatedAt default).
- `tests/proxy-dashboard-health.smoketest.js` — 18: vm-evaluated IIFE con fake window/document. Cubre `deriveStatus` (7 escenarios incluyendo non-default-no-proxy=red wins, isDefault=true fallback, overall mappings), `buildStatusSummary` (4 — null + all-green + worst-wins + red>yellow), `renderFixButton` (5 — null + default + APPLY_GEO present + other-kind + HTML-escape).
- `tests/proxy-dashboard-leaks.smoketest.js` — 12: idem vm-evaluated. `renderLeakButton` (5 — default + no-cache + green-badge + red-badge + escape), `buildLeakSummary` (2 — null + full), `formatResultDialog` (3 — null + \_\_error + full record).

Suite full 70 archivos verde con `TMPDIR=/tmp` (workaround disco `/sessions` full en sandbox).

Lint clean (eslint sin errores en mis archivos; 2 errores pre-existentes en `ghost-browser-importer.js` + `proxy-dashboard-import.js` no introducidos por este bloque).

Prettier: `--write` ran, todo formatted.

## Wire-up parity verificado

Smoke estático antes de commit:

- 9/9 IPC channels en `preload.js` tienen handler en `ipc-handlers-extra.js` / handler modules (verificado via diff de `'oz:(health|leakTest):*'` extracts).
- `broadcastToWebUI` existe en `main.js:232` — broadcast `oz:health:changed` y `oz:leakTest:changed` funcionarán.
- `identityManager.getSession` + `fingerprintEngine.applyGeoSuggestion` + `proxyManager.lastTestedIp` todos disponibles.
- Action delegation despacha `'apply-geo-fix'` + `'run-leak-test'`; los buttons emiten esos exactos `data-act`.
- HTML carga scripts en orden correcto (`-health.js`, `-leaks.js`, then `proxy-dashboard.js`).
- `require()` cleanly sin syntax errors.

## Pendiente

- **Smoke visual REAL** con app corriendo (regla `feedback_smoke_visual_bugs`) — Jose abre Proxy Health Dashboard, verifica:
  1. Identity rows muestran pill con overall health derivado del peor vector
  2. Tooltip del pill surface el worst-vector summary
  3. Botón "🔧 Apply geo" aparece cuando ipTimezone es yellow/red
  4. Click en "Apply geo" muta el fingerprint (verificable abriendo otra tab que muestre `Intl.DateTimeFormat().resolvedOptions().timeZone`)
  5. Botón "🛡️ Leak test" corre el test y muestra dialog multi-line con WebRTC + DNS verdict
  6. Pill badge al lado del botón "Leak test" persiste y muestra el último overall
- Si silent wire-up bug emerge, fix-up commit antes de cerrar 1.1.4 definitivamente.

## Próximos sub-bloques (v1.1.5)

Per roadmap `project_v1_roadmap.md`:

- H-2k Oxylabs Proxy Builder (~4h) — toggles país/ciudad/sticky + generate N secuencial + insert all
- H-2-wire Modal proxy-manager existing integrado con dashboard (~1h)
- H-2 extras opt-in (~2h) — backup automático pre-bulk-destructivo + export diagnostic

Total v1.1.5: ~7h. Cierra el set H-2 (Proxy Ops Dashboard completo) y el `1.1.x` line. Después `1.2.0` G-6 Ghost importer también importa proxies.
