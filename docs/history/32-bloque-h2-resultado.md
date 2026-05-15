# Bloque H-2 (a/b/c/d) — Proxy Health Dashboard + Live Ops (resultado parcial)

**Status:** ✅ H-2a + H-2b + H-2c + H-2d cerrados 2026-05-14/15
**Commits:** `bb0261c` (H-2a) · `9baf774` (H-2b) · `041b1f9` (H-2c+d) · `6e0fb34` (tests)
**Versions:** 1.1.0 (i18n primera entrega) · 1.1.1 (H-2a badge + H-2b dashboard) · 1.1.2 (H-2c+d acciones)
**Tiempo efectivo:** ~12h (i18n + H-2 a→d)
**Deps nuevas:** ninguna
**Tests:** +103 (proxy-health-status 25 + proxy-dashboard-data 26 + proxy-actions 52)

## Origen

Jose descubrió 2026-05-14 que su identidad **Contexto IG** mostraba IP real (Ecuador) en `whatismyip.com` aunque "se suponía" usaba proxy Oxylabs US. Investigación reveló:

- `proxy-assignments.json` con `byIdentity={}, defaultStrategy='auto-random'` (config OK)
- 1 proxy Oxylabs healthy en el pool con auth
- Pero la session de Contexto IG se había creado en un boot anterior (pre-1.0.0) sin proxy aplicado → quedó cacheada con `direct://`
- **Sin visibilidad operativa**, el usuario no sabe que existe el leak — el producto miente silenciosamente

Surfaceó tres necesidades:

1. **Indicador global de salud de proxies** (badge en toolbar) que avise al usuario.
2. **Dashboard operativo** con visibilidad de qué identity usa qué proxy + status.
3. **Acciones operativas inline** (reload session, reassign, test, reset, etc.) — el dashboard no debe ser solo read-only.

Y en paralelo: **i18n EN/ES** porque el equipo agencia de Jose tiene Macs en español.

## Decisiones (Jose 2026-05-14)

1. **Roadmap v1 completo aprobado** (~63-66h pendiente) — documentado en memoria `project_v1_roadmap.md`. H-2 a-k + G-6 + J auto-login + extras + I/I-2.
2. **i18n liviano custom** — no i18next. 190 LOC infra. Glossary LATAM: Workspace→Espacio, Identity→Identidad, Vault→Bóveda, Backup→Respaldo, etc.
3. **App versioning v1=1.x.x, v2=2.x.x, v3=3.x.x.** Patch bump per release shippable. Minor bump (1.0→1.1) para features grandes dentro de v1 (pre-aprobado).
4. **H-2 scope completo:** badge + dashboard tab + acciones per-proxy + per-identity + bulk ops + leak tests + Oxylabs builder. Total ~23h iterativo en 5 releases.
5. **Integración:** dashboard tab full-screen como acción primaria, modal proxy-manager existing queda como vista compacta del mismo subsystem (ambos comparten backend).

## v1.1.0 — i18n primera entrega (commit `dae3d69`)

**Módulo nuevo `browser/ui/i18n.js`** (~190 LOC) clase `I18n` con `init()` async, `t(key, params)` con `{{var}}` interpolation + fallback a EN + fallback al key, `setLocale('auto'|'en'|'es')` persistente, `translatePage()` que pasa por `data-i18n` (textContent) y `data-i18n-attr="placeholder:key1,title:key2"` (attrs), `onChange()` listener. Auto-init en DOMContentLoaded.

**Catálogos** `browser/ui/locales/{en,es}.json` con ~70 strings iniciales: common (Save/Cancel/Loading/etc), sidebar headers, Settings nav (10 tabs), Settings General + About + Migration full, language dropdown labels.

**Boot flow:** settings.json `general.locale: 'auto'|'en'|'es'` (default `auto`). Auto → IPC `oz:app:getSystemLocale` → `app.getLocale()` → normalize 2-char prefix → load matching catalog.

**Cobertura parcial** (~30% del UI total): Settings panel completo + Migration + sidebar. Modales restantes y notifications quedan para v1.5.0 cobertura completa.

## v1.1.1 — H-2a Badge + H-2b Dashboard read-only (commits `bb0261c` + `9baf774`)

### H-2a Badge global

**`browser/proxy-health-status.js`** (~110 LOC) módulo puro `computeGlobalStatus({proxyManager, proxyAssignment, identityManager}) → {status, counts, lastTestedAt, hint}`. Decision tree:

- `red` → 1+ proxy disabled OR 1+ identity unassigned (leak risk)
- `yellow` → 1+ proxy con failures, untested, o stale (>24h)
- `green` → all-clear con al menos 1 proxy
- `gray` → pool vacío

Counters expuestos: total/ok/fail/disabled/untested/stale/unassigned/identities/identitiesWithProxy.

**UI** botón `#oz-proxy-health-badge` en `<div class="toolbar">` después de address-bar, CSS pulse animation amarillo/rojo. Poll cada 30s + visibility-aware. Click → abre dashboard tab (con fallback a modal proxy-manager existing).

**IPC:** `oz:proxyHealth:getGlobalStatus` + `oz:proxyHealth:testAllAndStatus`.

### H-2b Dashboard tab

**`browser/proxy-dashboard-data.js`** (~95 LOC) aggregator que cruza ProxyManager + ProxyAssignment + IdentityManager + WorkspaceManager → snapshot `{globalStatus, identities[], proxies[], capturedAt}`. Per-identity rows incluyen leakRisk flag. Per-proxy rows incluyen usedByCount + usedBy preview.

**`browser/ui/proxy-dashboard.html`** (~440 LOC con CSS inline) página standalone abierta vía new tab (`chrome-extension://<webui-id>/proxy-dashboard.html`). Hero status banner + section Identities (table) + section Proxies (table). Cada tabla con search + sort-by-column + paginación 25/page. Auto-refresh 30s mientras tab visible.

**`browser/ui/proxy-dashboard.js`** (~250 LOC) controller IIFE con state interno per-tabla.

**IPC nuevos:** `oz:proxyHealth:getDashboard` (snapshot) + `oz:proxyHealth:openDashboard` (abre tab usando `browser.windows[*].tabs.create`).

## v1.1.2 — H-2c + H-2d Live Ops (commit `041b1f9`)

El dashboard pasa de read-only a operacional. Click resuelve el bug de Contexto IG en 1 click via "Reload session".

**`browser/proxy-actions.js`** (~190 LOC) factory `buildProxyActions({proxyManager, proxyAssignment, proxyHealth, identityManager, toProxyRulesString}) → 7 actions`. Todas retornan `{ok, ...}` y NUNCA throw.

Per-proxy:

- **`testProxy(id)`** vía proxyHealth.testOne
- **`resetProxy(id)`** failureCount=0, isDisabled=false, lastTestedAt=null, re-test best-effort
- **`setDisabled(id, disabled)`** toggle manual independent del auto-disable del daemon
- **`rotateSticky(id)`** regex `-sessid-XXX-` en username → nuevo random base36. Returns `NOT_STICKY` si no hay sessid marker
- **`deleteProxy(id)`** clearByProxyId en assignments + proxyManager.remove

Per-identity:

- **`reloadSession(identityId)`** re-aplica proxy actual sobre la session cacheada vía `session.setProxy({proxyRules})`. **THE fix para el bug de Contexto IG** (session creada pre-1.0.0 sin proxy → quedó con `direct://`, este path la re-resuelve).
- **`reassignProxy(identityId, value)`** assignToIdentity + cascade reloadSession.

**`preload-proxy.js`** (~30 LOC) extracted para mantener preload.js < 500 LOC (ADR 0005). Spread `...require('./preload-proxy').buildProxyBindings(ipcRenderer)` mantiene `window.oz.proxyHealth.*` + `window.oz.proxyAction.*`.

**Dashboard UI columna Actions:**

- Identidades: botón primary **↻ Reload session** + dropdown **Reassign proxy** con (None / auto-random / auto-round-robin / lista completa con country). Identity 'default' muestra "default — n/a".
- Proxies: botones **Test** (primary), **Reset**, **Disable/Enable** (toggle), **Rotate** (solo si protocol≠socks5), **Delete** (danger + confirm dialog).

Delegated event handlers sobre body — escala con paginación.

**i18n catalog `proxyDashboard.actions.*`** con 16 keys EN + ES.

## Tests (commit `6e0fb34`)

3 smoketests nuevos cubriendo los 3 módulos backend nuevos:

| Test                                      | Assertions | Coverage                                                                                                                                                              |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/proxy-health-status.smoketest.js`  | 25         | Decision tree completo: gray/green/yellow/red + edge cases (single non-default unassigned no triggers red, lastTestedAt aggregation = max, defensive no proxyManager) |
| `tests/proxy-dashboard-data.smoketest.js` | 26         | Snapshot shape + per-identity leakRisk + per-proxy status + usedByCount + assignment throw caught + capturedAt recent                                                 |
| `tests/proxy-actions.smoketest.js`        | 52         | 7 acciones × happy + edge cases (NOT_FOUND, throws, no daemon, no assignment mgr) + `_normalizeSessidInUsername` 7 escenarios                                         |

**Bug defensivo arreglado:** `getDashboardData` ya no requiere identityManager para popular proxies (test path sin IM). Producción siempre pasa ambos así que no afecta DMG 1.1.2.

**Full test suite: 2546+ tests verde.**

## Verificación visual end-to-end (2026-05-15)

OZ 1.1.2 instalado en /Applications + lanzado. Screenshot verificó:

1. ✅ OZ booteó OK con sidebar mostrando **`Contextoec (1)` con `Contexto IG`** y **`El Informe (2)`** con sus 2 identidades — **el self-heal de G-5 sobrescribió la data anterior correctamente sin intervención manual** (pre-fix mostraba `(0) no identities`).
2. ✅ Badge global proxy health renderea en toolbar (esquina superior derecha entre URL bar y browser-action-list).
3. ✅ Disk state post-boot confirmado:
   ```
   Contextoec    identityIds=1
   El Informe    identityIds=2
   Contexto IG   workspaceId=fd9aa34b... (Contextoec)
   El Informe    workspaceId=973d22d7... (El Informe)
   Pedro         workspaceId=973d22d7... (El Informe)
   ```

## Pendiente del H-2 completo

- **H-2e** Diagnostics + alerts automáticos (~2h, v1.1.3)
- **H-2f** Bulk multi-select + bulk actions (~1.5h, v1.1.3)
- **H-2g** Bulk import CSV/TXT (~2h, v1.1.3)
- **H-2h** Bulk assign 1:1 / round-robin / random (~2h, v1.1.3)
- **H-2i** Anti-detect coherence check + Apply geo suggestion (~2h, v1.1.4)
- **H-2j** WebRTC + DNS leak tests (~1.5h, v1.1.4)
- **H-2k** Oxylabs Proxy Builder con toggles país/ciudad/sticky/sesstime + gen secuencial (~4h, v1.1.5)
- **H-2-wire** Modal proxy-manager existing integrado con dashboard (~1h, v1.1.5)
- **H-2 extras** backup pre-bulk-destructivo + export diagnostic (~2h, v1.1.5)

## Bugs en radar (post-H-2)

- **Contexto IG session cache** — resuelto en H-2d con acción "Reload session". Jose ejecuta 1 click en el dashboard → re-aplica proxy → IP USA reportada en próxima navegación.
- **Posible race condition** entre i18n init + boot reconcile (logs iniciales pueden salir en EN aunque user prefiere ES). Cosmético. v1.5.0 lo cubre.

## How to apply

- **Para arrancar H-2e/f/g/h (v1.1.3)** primero: incremental sobre el dashboard existing. Bulk-select multi → barra de acciones. Bulk import por paste CSV. Bulk assign con modal de strategy.
- **Para H-2k Oxylabs Builder:** modal con toggles país/ciudad/sticky + generate N. Extender `proxy-providers.js` existing.
- **Versionar:** patch bump per release. 1.1.3 cuando H-2e/f/g/h cierren.
