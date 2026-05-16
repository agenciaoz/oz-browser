# Bloque K1 (identity HUD) — in-page widget arriba-derecha per-tab

**Status:** ✅ K1 identity HUD cerrado 2026-05-15
**Commit:** `b5dee97`
**Version:** 1.4.3 (patch)
**Tiempo efectivo:** ~3-4h (incluyendo pivot de arquitectura)
**Deps nuevas:** ninguna
**Tests nuevos:** +122 (84 hud-handlers + 38 hud-setup)

## Origen

Per roadmap K1-extras: "In-page identity HUD (widget arriba-derecha en cada tab)". Para Jose's use case (50+ social media accounts), cuando alternás entre tabs es difícil saber de un vistazo qué identity/proxy/workspace sirve cada tab — el sidebar muestra la lista pero el ojo está en el contenido.

## Decisión: shadow-DOM + executeJavaScript (post-pivot)

**Approach inicial (descartado):** `session.registerPreloadScript` con preload-hud.js standalone, mismo pattern que preload-fingerprint.

**Bug descubierto durante smoke visual:** los sandboxed preloads de Electron 42 en este build fallan silenciosamente cuando hacen `require()` de archivos siblings (afecta también a preload-content.js auto-fill + preload-fingerprint.js FP). Visible como `Unable to load preload script ... module not found: ./site-templates` en page console.

**Pivot:** mover la inyección a `webContents.executeJavaScript()` desde main process al `did-finish-load` + `did-navigate-in-page`. Bypassa el sandbox totalmente, NO requiere preload registration, y el HUD es 100% data-injection (sin IPC desde la página).

## v1.4.3 — implementación

### `browser/hud-handlers.js` (NEW, ~200 LOC)

Factory `buildHudHandlers(browser, {dataDir|app}) → {getContextForSession, getContext, getCollapsed, setCollapsed}`. Combina IdentityManager.get + WorkspaceManager.get + ProxyAssignment.resolve + AccountVault session status en un blob `{identity, workspace, proxy, session}`. Session status logic: vault locked → 'locked' gray / sin accounts → 'green' / ≥1 account.status==='needs_relogin' → 'needs_relogin' red.

### `browser/preload-hud-script.js` (NEW, ~180 LOC pure builders)

Funciones puras testeables sin Electron: countryToFlag (Regional Indicator Symbols "MX"→🇲🇽), ipLastOctets (privacidad: /24 IPv4 ofuscado, hostname clamped a 12), escapeHtml (XSS defense), badgeInitials, sessionPill/pillTitle, buildHudStyles (CSS shadow scope con 4 pill colors), buildExpandedHtml/buildCollapsedHtml.

### `browser/hud-setup.js` (NEW, ~245 LOC)

`setupHud(browser)` wirea end-to-end via `app.on('web-contents-created')` listener. `refreshHudOnTab(wc)` resuelve identity via 3 estrategias en cascada (tab.webContents reference / identityIdForSession / activeIdentityId), builds injection script, executeJavaScript. `buildInjectionScript(ctx)` IIFE con data inlined como JSON literal. Click handlers in-page usan localStorage[oz_hud_collapsed_{identityId}] para toggle persistente. `broadcastHudUpdate(browser)` re-ejecuta en todos los tabs materializados. Wrap de `browser.broadcastToWebUI` para refresh automático en HUD_REFRESH_CHANNELS (identities/workspaces/accounts/proxies/proxyAssignment/proxyHealth :changed).

### `browser/preload-hud.js` (DEPRECATED placeholder)

Pre-pivot artifact. Documentado como noop placeholder.

### `browser/fingerprint-preload-setup.js` (REFACTOR extracted from main.js)

ADR 0005 LOC budget — main.js exactly 500 LOC tras K1-mac-sleep. Mi adición de HUD setup pushed a 501 LOC. Extraje el FP preload hook block a su propio module sin cambios de lógica. main.js drop a ~485 LOC.

### `browser/main.js` — wire

Una línea: `require('./hud-setup').setupHud(this)` post-FP preload setup.

## UX result

Cada tab muestra arriba-derecha:

- Badge color identity + inicial (28×28 expanded, 22×22 collapsed)
- Identity name (truncado con ellipsis)
- Workspace name · 🇲🇽 country flag · ·XX.YY IP last octets (sub-line)
- Pill verde/amber/red/gray según session status
- Chevron › para collapse a pill mini

Smoke visual 2026-05-15 PASS: HUD aparece en Instagram tab con IG 2 identity (badge rosa) + Workspace 2 + 🇺🇸 + us-pr. Click collapse funcional.

## Tests

- `tests/hud-handlers.smoketest.js` (84 asserts): preload-hud-script puros (60+), hud-handlers context/session-status (15), collapsed state persistence (9)
- `tests/hud-setup.smoketest.js` (38 asserts): HUD_REFRESH_CHANNELS, shouldSkipUrl 8, buildInjectionScript 10, setupHud + refreshHudOnTab + broadcast wrap end-to-end

Fakes inyectables — NO toca Electron real.

## Pendiente (NO en v1.4.3)

- Onboarding wizard (último K1-extra) — pasa a v1.4.6
- Sub-bloque sandbox-preload-fix (afecta FP + auto-fill) — pasa a v1.4.4
