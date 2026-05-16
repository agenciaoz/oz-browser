# hud-widget — In-page identity HUD per-tab (K1-extras / v1.4.3)

## Qué hace

Inyecta un widget overlay arriba-derecha en cada tab que muestra:

- Identity name + color badge (inicial 2-char)
- Workspace name
- Proxy country flag (🇲🇽 🇺🇸 vía Regional Indicator Symbols)
- IP last octets ofuscados (·144.18 para IPv4 → privacidad)
- Session health pill (green / amber / red / gray)

Toggle entre estado expanded (default, ~220px wide) y collapsed pill mini (color + inicial + pill, ~50px). State persiste per-identity-per-site via `localStorage`.

## Archivos

| Archivo                           | LOC  | Rol                                                                                                                                                        |
| --------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/hud-handlers.js`         | ~200 | Backend IPC handlers (getContext, getCollapsed, setCollapsed) + state persistence en `userData/hud-state.json`                                             |
| `browser/hud-setup.js`            | ~245 | Wire-up: app.on('web-contents-created') listener + executeJavaScript injection + broadcast wrap                                                            |
| `browser/preload-hud-script.js`   | ~180 | Pure builders sin Electron (countryToFlag, ipLastOctets, escapeHtml, buildHudStyles, buildExpandedHtml, buildCollapsedHtml) — testeable directo desde node |
| `browser/preload-hud.js`          | ~20  | DEPRECATED placeholder. Pre-pivot artifact (initial design via session.registerPreloadScript)                                                              |
| `tests/hud-handlers.smoketest.js` | ~447 | 84 asserts: pure builders + context blob + collapsed state persistence                                                                                     |
| `tests/hud-setup.smoketest.js`    | ~290 | 38 asserts: shouldSkipUrl + buildInjectionScript + setupHud + broadcast wrap                                                                               |

## Arquitectura — executeJavaScript injection (post-pivot)

**Pre-pivot (descartado):** session.registerPreloadScript con preload-hud.js standalone. **Falló** en smoke visual — sandboxed preloads de Electron 42 en este build no soportan relative requires (mismo bug que afecta preload-content + preload-fingerprint).

**Post-pivot (production):** `webContents.executeJavaScript()` desde main process al `did-finish-load` + `did-navigate-in-page` events. Bypassa el sandbox totalmente. El HUD es 100% data-injection — la página recibe un IIFE con todo el data inlined como JSON literal.

## Flow

1. **Boot:** `main.js` llama `require('./hud-setup').setupHud(this)` post-FP preload setup
2. **setupHud:** registra `app.on('web-contents-created', wc => { wc.on('did-finish-load', refreshHudOnTab); wc.on('did-navigate-in-page', refreshHudOnTab) })` + envuelve `browser.broadcastToWebUI` para refresh automático en HUD_REFRESH_CHANNELS
3. **refreshHudOnTab(wc):** resuelve identity via 3 estrategias en cascada (tab.webContents reference / identityIdForSession / activeIdentityId) → llama `browser.handlers.hud.getContext(identityId)` → builds injection script via `buildInjectionScript(ctx)` → llama `wc.executeJavaScript(script)`
4. **In-page IIFE:** crea `<div id="oz-hud-root">` con shadow-DOM cerrado en `document.body`, inyecta `<style>` con CSS aislado, renderea expanded o collapsed según `localStorage[oz_hud_collapsed_{identityId}]`. Click handlers toggle el flag local + re-render. NO usa IPC desde la página (todo data-driven via re-execute desde main).

## Session status logic

| Vault state     | Accounts state   | → status              |
| --------------- | ---------------- | --------------------- |
| No accountVault | —                | `unknown` (gray)      |
| Locked          | —                | `locked` (gray)       |
| Unlocked        | No accounts      | `green`               |
| Unlocked        | ≥1 needs_relogin | `needs_relogin` (red) |
| Unlocked        | All active       | `green`               |

`amber` reservado pero no emitido todavía (cuando se agregue "cookie expira en <24h").

## Live updates

`HUD_REFRESH_CHANNELS` whitelist en hud-setup.js:

- `oz:identities:changed` (rename, color change, move workspace)
- `oz:workspaces:changed` (rename workspace)
- `oz:accounts:changed` (anti-logout flag flip)
- `oz:proxies:changed` (reassignment)
- `oz:proxyAssignment:changed`
- `oz:proxyHealth:changed`

Cuando `broadcastToWebUI` emite uno de estos, el wrap dispara `broadcastHudUpdate(browser)` que itera tabs materializados y re-ejecuta `refreshHudOnTab` con la data fresca. Sin reload del tab — el HUD actualiza pill verde/amber/rojo en tiempo real.

## IPC channels

- `oz:hud:getContext(identityIdArg?)` → context blob (resuelve identity via event.sender.session anti-spoof, identityIdArg como fallback para MCP/tests)
- `oz:hud:getCollapsed(identityId)` → boolean (legacy — el localStorage del page actualmente persiste el toggle)
- `oz:hud:setCollapsed(identityId, collapsed)` → boolean (legacy)

## Smoke visual

PASS 2026-05-15: HUD aparece en Instagram tab con IG 2 identity, badge rosa, Workspace 2, 🇺🇸 flag, us-pr IP, pill verde, click chevron collapsa a pill mini funcional.

Para validar manualmente: `npm start`, abrir cualquier tab non-chrome-extension, verificar HUD arriba-derecha con identity activa + click toggle.

## Trade-offs del pivot

| Pre-pivot (preload)                                              | Post-pivot (executeJavaScript)                 |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Collapse state en main process                                   | Collapse state en page localStorage (per-site) |
| IPC desde page world                                             | Re-execute desde main para updates             |
| Soft regression: state per-identity ya no se persiste cross-site | Aceptable para v1.4.x                          |
| Sandbox preload bug → no funciona                                | Bypassa sandbox completamente                  |
