# ADR 0016 — Tab Context Menu (1.7)

**Date:** 2026-05-10
**Status:** Accepted
**Related blocks:** 1.7a / 1.7b / 1.7c / 1.7d

## Context

Ghost Browser tiene un menú right-click sobre las tabs con 16 opciones que es uno de sus puntos fuertes (Open in Identity submenu, Move to Workspace, Duplicate variants, Clear browsing data, Export/Import cookies en múltiples formatos, Pin/Mute/Bookmark, Close variants). Replicar esto era el alcance del Bloque 1.7.

Antes de 1.7, OZ tenía un context menu HTML/CSS hand-rolled en `sidebar.js` (1.4d) con sólo 2 items: "Move to workspace…" y "Close tab". Ese approach tenía problemas:

1. **Apilamiento con WebContentsView** (ADR 0011) — el menú HTML vive en el DOM del WebUI; el WebContentsView nativo de la tab activa renderiza ARRIBA del DOM. Para que el menú HTML se vea, hay que hide el view (ya lo hacíamos para los modales), lo cual flickea la UI.
2. **Submenús profundos** ("Open in Identity… → 47 identidades") son frágiles en HTML — keyboard nav, posicionamiento contra borde de pantalla, escape on outside-click — todo es código a escribir y mantener.
3. **Inconsistencia con Chrome** — el usuario espera que right-click de una tab se vea como en Chrome (menú nativo del OS).

## Decision

**1. Native menu via `Menu.buildFromTemplate` + `Menu.popup()`** en main process.

El renderer dispara `oz:tabs:contextMenu(tabId, {x,y})` via IPC; main process arma el template (`browser/tab-context-menu.js`) y lo abre con `menu.popup({window})`. Los click handlers viven en main, llaman directo al handler map (`browser/tab-context-handlers.js`), sin round-trip por evento.

**Pros:**

- Apariencia idéntica a Chrome.
- Keyboard nav y dismiss-on-outside gratis (OS-level).
- No fight con WebContentsView (el menú nativo flota arriba de cualquier renderer).
- Submenus profundos funcionan sin código custom.
- Reuso 1:1 entre sidebar y top tabstrip — el mismo IPC.

**Cons:**

- Hard refresh del menú cada vez (no diff incremental). Aceptable: <50 ms para 16 items + 2 submenus dinámicos.
- No hay forma de hover-triggered tooltips dentro del menú nativo. Aceptable.

**2. Handler map split en dos archivos.**

`browser/tab-handlers.js` (217 LOC, 1.4) se queda con primitivas básicas (list/openInIdentity/select/close/moveToWorkspace).
`browser/tab-context-handlers.js` (1.7a) tiene los nuevos: reload/duplicate\*/refreshAllInIdentity/moveToNewWindow/pin/unpin/mute/unmute/closeOthers/closeToRight.

Spread'eados en `browser.handlers.tabs` en `ipc-handlers.js`:

```js
tabs: { ...buildTabHandlers(browser), ...buildTabContextHandlers(browser) }
```

**Pros:** Mantiene cada archivo bajo 500 LOC (ADR 0005). El consumer (IPC + MCP) ve un solo namespace `tabs`. Tests separados por archivo.

**3. `moveToNewWindow` auto-crea workspace "Window N"** (no permite compartir un WS entre 2 ventanas).

ADR 0015 estableció lock exclusivo 1 ventana = 1 workspace. Mover una tab a una nueva ventana NO podía simplemente abrir otra ventana en el mismo WS. Decisión: cada call a `moveToNewWindow` crea un workspace nuevo `Window 2`, `Window 3`, ... y abre la ventana ahí. La tab se mueve via la primitiva existente `appendTabSpec` + destroy en source.

**Trade-off:** acumulación de workspaces "Window N" si el user abre/cierra muchas. Mitigación: el user puede archive/delete desde el sidebar como cualquier otro WS. Si esto se vuelve molesto en uso real, agregar auto-cleanup de "Window N" vacíos al cierre (futuro).

**4. `duplicateInTemporary` crea identity nueva cada vez** (sin reuse).

Alternativa rechazada: una sola identity `Temporary` reusable. Problema: si el user borra esa identity para limpiar, pierde todas las tabs temporales que abrió. Decisión: cada duplicate crea `Temp YYYY-MM-DD HH:MM` color gris. El user puede borrarlas individualmente sin afectar otras temp tabs.

**Trade-off:** acumula identities en el sidebar. Aceptable porque (a) el cap está removido por defecto en 1.5f (paid tier), (b) las temp identities tienen color gris uniforme y se pueden distinguir visualmente.

**5. Bookmarks MVP — flat list no folders, page completa en 1.10.**

`browser/bookmark-manager.js` con storage `bookmarks.json` (array plano, JSON pretty). Modelo simple: `{id, identityId, url, title, favicon, addedAt}`. Dedup por `(identityId, url)` — re-bookmark del mismo URL en la misma identity es noop (`deduped:true` flag). El UI completo (search, edit, folders, drag-drop reorder) llega en Bloque 1.10 junto con History/Downloads page.

**Por qué no encriptar:** URLs y títulos NO son secretos comparable a passwords del Vault. El user los puede ver en address bar y history. Encriptar añade complejidad sin valor de privacidad real.

**6. Clear Browsing Data scopes: `cookies | storage | both`.**

Tres opciones explícitas en el submenu. La opción `storage` excluye cookies (útil para "limpiar caché sin perder login"), la opción `cookies` solo cookies (logout limpio), `both` todo. Implementación: `session.clearStorageData({storages:[...]})` con la lista correspondiente + `session.clearCache()` cuando scope incluye storage.

**No destruimos las tabs vivas** después de clear — el user verá la página vieja hasta que la recargue. Decisión consciente: refresh automático sería intrusivo si está en medio de algo. Si el flujo "clear + refresh" se vuelve común, agregar item separado "Clear and refresh".

**7. Cookies I/O en 4 formatos.**

Soportados: `oz` (JSON nativo lossless), `netscape` (cookies.txt curl/wget), `adspower`, `multilogin`. AdsPower y Multilogin son ESENCIALMENTE devtools-shape JSON con/sin `storeId`. Los implementamos en funciones separadas para que en el futuro puedan divergir si descubrimos diferencias de campo (sameSite enum casing, etc).

**Por qué los 4 ahora vs los 2 obvios (oz + netscape):** AdsPower y Multilogin son los competidores directos de Ghost. Soportar import desde sus formatos elimina fricción de migración para sus usuarios → hook comercial directo. El módulo `cookies-io.js` es 100% testeable sin Electron porque NO toca sessions — los tests cubren round-trip por formato sin GUI.

**`cookies-io.js` puro + `cookies-handlers.js` bridge** — separación intencional para (a) test sin Electron (b) futuro: usar el módulo desde scripts de migración Ghost→OZ (Etapa 2 candidato C-12).

## Architecture

```
Renderer (sidebar.js / tabstrip.js)
   │ right-click on tab
   ▼
preload.js  oz.tabs.contextMenu(tabId, {x,y})
   │ ipcRenderer.invoke
   ▼
ipc-handlers.js  oz:tabs:contextMenu
   │ event.sender → owning BrowserWindow
   ▼
tab-context-menu.js  buildTabContextMenu({browser, tabId})
   │ returns Array<MenuItem>
   ▼
Menu.buildFromTemplate(template).popup({window, x, y})
   │ user click
   ▼
tab-context-handlers.js  duplicate/pin/closeOthers/...
       (or)
identity-handlers.js  clearBrowsingData
       (or)
bookmark-handlers.js  addFromTab
       (or)
cookies-handlers.js  exportToFile / importFromFile
   │ direct fn call (no IPC round-trip)
   ▼
session.cookies.{get,set} / fs.writeFileSync / etc
```

## Consequences

**Positive:**

- Right-click UX consistente con Chrome (16 opciones replicando Ghost).
- Mismo menú reutilizado en sidebar + top tabstrip via un solo IPC.
- 23 MCP tools nuevos exponen las primitivas para automation (un agente puede `oz.tabs.duplicateInTemporary` + `oz.cookies.exportToFile` para flows de scraping).
- Handler maps puros + módulos puros (`cookies-io.js`, `bookmark-manager.js`) → testeables sin GUI.
- 16 opciones implementadas vs 2 antes.

**Negative:**

- Acumulación lenta de workspaces "Window N" y identities "Temp ..." si el user abusa de moveToNewWindow / duplicateInTemporary. Mitigación: archive/delete normal.
- Cookies set() loop síncrono en bulk — para jars muy grandes (>1000 cookies) podría ser lento. Si se reporta, paralelizar con Promise.all en batches.
- `clearBrowsingData` no destruye tabs vivas — el user puede confundirse si la página vieja sigue mostrando contenido cacheado hasta refresh.

**Métricas de cierre:**

- 4 sub-fases (1.7a / 1.7b / 1.7c / 1.7d) en una sesión continua, ~5h efectivas vs ~6h estimadas.
- 6 archivos nuevos: `tab-context-handlers.js`, `tab-context-menu.js`, `bookmark-manager.js`, `bookmark-handlers.js`, `cookies-io.js`, `cookies-handlers.js`, `mcp-tools-tab-context.js`.
- 3 tests nuevos: `tab-context-handlers.smoketest.js` (64), `bookmark-manager.smoketest.js` (50), `cookies-io.smoketest.js` (72) = 186 nuevos.
- mcp-server.smoketest.js: 90 → 105 (+15 contract tests auto-detectados).
- Total proyecto: 549 → 750 (+201 tests).
- check:loc max 447 (mcp-server.smoketest.js, no source file).
- Cero deps npm nuevas.

## Alternatives considered

- **HTML/CSS context menu (continuación de 1.4d):** rechazado por las razones del Context — submenu apilamiento con WebContentsView, falta de keyboard nav nativo, divergencia visual con Chrome.
- **Reusar `electron-chrome-context-menu`** (ya está en deps por electron-browser-shell): podría haber dado el menú nativo "free" pero su template es para webContents content (Open Link, Save Image), no para tabs. Habría sido un fork. Mejor template propio.
- **Bookmarks dentro del Vault (encriptados):** rechazado — overkill, los URLs no son secretos.
- **`moveToNewWindow` permitiendo compartir WS entre ventanas:** rompería ADR 0015 (lock exclusivo). El auto-create de "Window N" workspace es la solución limpia.
- **Cookies I/O solo OZ + Netscape:** rechazado — los 4 formatos son ~30 min más cada uno y el hook comercial de migración Ghost-competitors vale el costo.
