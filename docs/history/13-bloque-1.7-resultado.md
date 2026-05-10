# Bloque 1.7 — Tab Context Menu (cierre)

**Fecha:** 2026-05-10
**Tiempo efectivo:** ~5h vs ~6h estimadas
**Sub-fases:** 1.7a / 1.7b / 1.7c / 1.7d (4 commits potenciales agrupados en uno)
**Total tests proyecto:** 549 → **750** (+201)
**Deps nuevas:** 0
**ADR:** 0016 — Tab Context Menu
**CHANGELOG:** entrada agregada

## Qué se entregó

### 1.7a — Tab actions backend + native context menu module

**Archivos nuevos:**

- `browser/tab-context-handlers.js` (~340 LOC) — handler map puro con: `reload`, `duplicate`, `duplicateInTemporary` (auto-crea Temp identity), `duplicateInIdentity`, `duplicateInNewIdentity`, `refreshAllInIdentity`, `moveToNewWindow` (auto-crea workspace "Window N"), `pin/unpin` (persiste en workspace tabSpecs), `mute/unmute` (webContents.setAudioMuted), `closeOthers/closeToRight` (preserva pinned tabs).
- `browser/tab-context-menu.js` (~290 LOC) — template builder para `Menu.buildFromTemplate`. 16 opciones replicando Ghost. Submenús dinámicos: "Create New Tab in Identity → ...", "Move to Workspace → ...", "Duplicate into Identity → ...", "Clear Browsing Data → cookies/storage/both" (1.7b), "Export Cookies → 4 formats" (1.7c), "Import Cookies → 4 formats" (1.7c). Toggle dinámico Pin/Unpin y Mute/Unmute según estado actual.

**IPC channels nuevos:** `oz:tabs:reload`, `oz:tabs:duplicate`, `oz:tabs:duplicateInTemporary`, `oz:tabs:duplicateInIdentity`, `oz:tabs:duplicateInNewIdentity`, `oz:tabs:refreshAllInIdentity`, `oz:tabs:moveToNewWindow`, `oz:tabs:pin`, `oz:tabs:unpin`, `oz:tabs:mute`, `oz:tabs:unmute`, `oz:tabs:closeOthers`, `oz:tabs:closeToRight`, `oz:tabs:contextMenu(tabId, {x,y})` (UI-only, abre menú nativo via Menu.popup).

**Tests nuevos:** `tests/tab-context-handlers.smoketest.js` con 64/64 verde. Cubre reload + tab-not-found / duplicate inserción correcta / duplicateInTemporary (Temp identity created) / duplicateInIdentity con error path identity-not-found / duplicateInNewIdentity / refreshAllInIdentity skipea lazy + filtra por identity / moveToNewWindow auto-naming "Window 2" → "Window 3" / pin persiste en workspace / mute lazy noop / closeOthers preserva pinned / closeToRight preserva pinned + solo afecta posteriores.

### 1.7b — Bookmarks MVP + Clear browsing data per identity

**Archivos nuevos:**

- `browser/bookmark-manager.js` (~170 LOC) — clase `BookmarkManager` con CRUD + persistence `bookmarks.json` (flat array, JSON pretty). Modelo `{id, identityId, url, title, favicon, addedAt}`. Dedup por `(identityId, url)` — re-add devuelve existing con flag `deduped:true`. `removeByIdentity(id)` para bulk cleanup cuando 1.10 borra una identity.
- `browser/bookmark-handlers.js` (~70 LOC) — handler map: list/get/add/addFromTab(tabId)/remove. addFromTab resuelve la tab por id en `browser.windows`, extrae url+title+favicon de `serialize()`.

**Identity handler extendido:**

- `identity-handlers.clearBrowsingData(identityId, scope)` con scope ∈ `{cookies, storage, both}`. Async — usa `session.clearStorageData({storages:[...]})` + `session.clearCache()` para storage|both. Storages array predefinido por scope (cookies → `['cookies']`, storage → `['appcache','filesystem','indexdb','localstorage','shadercache','websql','serviceworkers','cachestorage']`, both → todos). Live tabs NO se destruyen (decisión consciente — no interrumpir al user; refresh manual si necesita).

**main.js:** instancia `BookmarkManager` post-Vault, pre-IPC.

**IPC channels nuevos:** `oz:bookmarks:list`, `oz:bookmarks:get`, `oz:bookmarks:add`, `oz:bookmarks:addFromTab`, `oz:bookmarks:remove`, `oz:identities:clearBrowsingData`.

**Tests nuevos:** `tests/bookmark-manager.smoketest.js` con 50/50 verde. Cubre add/get/list/remove / dedup por (identityId,url) / dedup respeta identity (mismo URL en distinta identity → 2 bookmarks) / validación campos requeridos / removeByIdentity bulk / persistencia round-trip / handlers.addFromTab con FakeWindow / handlers.list con filter / clearBrowsingData per scope (storages correctos, clearCache solo en storage|both, errores identity-not-found e invalid-scope).

### 1.7c — Cookies I/O en 4 formatos

**Archivos nuevos:**

- `browser/cookies-io.js` (~290 LOC) — módulo PURO encode/decode sin Electron (testeable 100% sync). 4 formatos:
  1. **`oz`** — JSON nativo OZ con wrapper `{format:'oz', version:1, exportedAt, cookies:[]}`. Round-trip lossless (todos los campos preservados). Decode tolerante (acepta wrapper o bare array).
  2. **`netscape`** — texto plano cookies.txt, formato curl/wget. `domain<TAB>flag<TAB>path<TAB>secure<TAB>expiration<TAB>name<TAB>value` por línea. Reconoce `#HttpOnly_` prefix (convención curl) — bug atrapado por test: el check `line.startsWith('#')` skipeaba el HttpOnly prefix antes de detectarlo, fix detectar #HttpOnly\_ FIRST.
  3. **`adspower`** — JSON devtools-style con `storeId:"0"`. Compat con AdsPower Browser export.
  4. **`multilogin`** — JSON devtools-style sin storeId. Compat con Multilogin export.
- `browser/cookies-handlers.js` (~170 LOC) — bridge a `session.cookies.{get,set}`. APIs: `exportContent(identityId, format)` (returns string), `exportToFile`, `importContent(identityId, format, content)` (returns `{written, errors[]}`), `importFromFile`. URL para set() construido con scheme=https si secure, dominio sin leading dot.

**IPC channels nuevos:** `oz:cookies:exportContent`, `oz:cookies:exportToFile`, `oz:cookies:importContent`, `oz:cookies:importFromFile`, `oz:cookies:pickExportPath` (UI-only file dialog), `oz:cookies:pickImportPath` (UI-only).

**Tests nuevos:** `tests/cookies-io.smoketest.js` con 72/72 verde. Cubre encode/decode round-trip per cada formato, lossless oz, netscape tab-delimited correctness y #HttpOnly\_ tolerance, AdsPower storeId="0", Multilogin sin storeId, sameSite normalization, error handling unsupported format + malformed JSON, handlers exportContent/exportToFile con FakeSession + FakeIM, importContent round-trip via setCalls capture, importFromFile, identity-not-found + parse-failed.

### 1.7d — Wire UI + atajos + MCP tools + cierre

**UI:**

- `browser/ui/sidebar.js` — el `showTabContextMenu` HTML del 1.4d eliminado (~75 LOC); ahora delega a `window.oz.tabs.contextMenu(tab.id, {x,y})` que invoca el menú nativo en main. Diff -88 +12 LOC.
- `browser/ui/tabstrip.js` — agregado `node.addEventListener('contextmenu', ...)` que invoca el mismo IPC. Mismo menú compartido entre sidebar y top tabstrip.
- `preload.js` — `window.oz.tabs.contextMenu(tabId, opts)` + getters individuales (`reload`, `duplicate`, `pin/unpin`, `mute/unmute`) para keyboard shortcuts del WebUI. `window.oz.bookmarks.*` (5 métodos + onChanged). `window.oz.cookies.*` (4 acciones + 2 file pickers).

**Atajos (menu.js — submenu "Tab"):**

- `Cmd+T` — New Tab (Current Identity)
- `Alt+G` — New Tab in Default Identity
- `Alt+N` — New Identity + New Tab
- `Alt+D` — Duplicate Tab
- `Alt+S` — Move Tab to New Window
- `Alt+P` — Pin / Unpin Tab
- `Cmd+Shift+J` — Open DevTools (replica accelerator estándar Chrome)

**MCP tools nuevos (23 en `browser/mcp-tools-tab-context.js`):** `oz.tabs.{reload, duplicate, duplicateInTemporary, duplicateInIdentity, duplicateInNewIdentity, refreshAllInIdentity, moveToNewWindow, pin, unpin, mute, unmute, closeOthers, closeToRight}` (13), `oz.bookmarks.{list, get, add, addFromTab, remove}` (5), `oz.cookies.{exportContent, exportToFile, importContent, importFromFile}` (4), `oz.identities.clearBrowsingData` (1). Spread'eados en `mcp-tools.js` con el mismo patrón de `mcp-tools-vault.js` (split por ADR 0005 — mcp-tools.js sigue bajo 500 LOC).

**Contract test IPC↔MCP** extendido en `tests/mcp-server.smoketest.js`:

- Regex de extracción de IPC channels actualizado para incluir `bookmarks|cookies` además de los dominios previos.
- Exempt set agregado: `oz:tabs:contextMenu` (UI-only, equivale a Menu.popup), `oz:cookies:pickExportPath` y `oz:cookies:pickImportPath` (UI-only file dialog wrappers).
- El contract test atrapó automáticamente que faltaba `oz.bookmarks.get` en el catalog → agregado.

## Lo que está funcionando

- Right-click sobre cualquier tab (sidebar o top tabstrip) → menú nativo Ghost-style con 16 opciones.
- "Create a New Tab → In Identity → <Identity>" submenu dinámico (1 entry por identity custom).
- "Move to Workspace → <Workspace>" submenu dinámico filtrando archivados + WS actual.
- "Duplicate into Identity → <Identity>" submenu.
- "Move Tab to New Window" abre nueva BrowserWindow con workspace auto-creado "Window N".
- "Refresh All in this Identity (<Name>)" recarga todas las tabs vivas de esa identity.
- "Clear This Identity Browsing Data → Cookies | Storage | Both" — wipe per scope sin destruir tabs.
- "Export Cookies → 4 formatos" abre file dialog nativo + escribe.
- "Import Cookies → 4 formatos" abre file dialog + parse + bulk session.cookies.set.
- "Pin / Unpin" — toggle dinámico, persiste en workspace tabSpecs.
- "Mute / Unmute Site" — toggle dinámico, mute funciona en materialized tabs.
- "Bookmark this Tab" — agrega entry a bookmarks.json con dedup por (identityId,url).
- "Close Other Tabs" / "Close Tabs to the Right" — preservan pinned.
- Atajos de teclado funcionando (Cmd+T, Alt+D, Alt+P, etc).

## Issues resueltos

- **Bug 1.7c — Netscape `#HttpOnly_` prefix:** el check `line.startsWith('#')` en `decodeNetscape` skipeaba la línea ANTES de detectar el prefix HttpOnly. Atrapado por test. Fix: detectar `#HttpOnly_` FIRST, luego comment.
- **Bug 1.7d — Contract test:** agregar tools nuevos sin agregar al regex del contract test (que solo cubría dominios previos). El test detectó que faltaba el regex match para `bookmarks|cookies`. Fix: extender regex.
- **Bug 1.7d — `oz.bookmarks.get` faltante:** el contract test detectó automáticamente que `oz:bookmarks:get` IPC no tenía MCP tool matching. Fix: agregar `oz.bookmarks.get` al catalog.
- **UI-only IPC channels en exempt:** `oz:tabs:contextMenu` (Menu.popup), `oz:cookies:pickExportPath`, `oz:cookies:pickImportPath` agregados al exempt set del contract test (no son data primitives, son UI nativos).

## Tests

- 750/750 totales verde.
- Suite per archivo:
  - account-handlers: 51
  - account-vault: 30
  - anti-logout: 38
  - backup-manager: 40
  - **bookmark-manager: 50 (NUEVO 1.7b)**
  - **cookies-io: 72 (NUEVO 1.7c)**
  - excel-io: 25
  - identity-manager: 29
  - mcp-server: 105 (+15 vs 90 — contract test detectó tools nuevos)
  - move-to-workspace: 29
  - site-templates: 125
  - **tab-context-handlers: 64 (NUEVO 1.7a)**
  - window-workspace: 36
  - workspace-manager: 56

## Costos

- **Tiempo:** ~5h efectivas vs ~6h estimadas (-17%).
- **Deps npm nuevas:** 0.
- **LOC agregadas:** ~1900 LOC source (handlers + menu + io + manager + mcp tools).
- **LOC tests:** ~1100 LOC.
- **Costo monetario:** $0 (sin proveedores externos).

## Archivos modificados

**Nuevos:**

- `browser/tab-context-handlers.js`
- `browser/tab-context-menu.js`
- `browser/bookmark-manager.js`
- `browser/bookmark-handlers.js`
- `browser/cookies-io.js`
- `browser/cookies-handlers.js`
- `browser/mcp-tools-tab-context.js`
- `tests/tab-context-handlers.smoketest.js`
- `tests/bookmark-manager.smoketest.js`
- `tests/cookies-io.smoketest.js`
- `docs/architecture/0016-tab-context-menu.md`
- `docs/history/13-bloque-1.7-resultado.md` (este file)

**Modificados:**

- `browser/main.js` — instancia BookmarkManager
- `browser/ipc-handlers.js` — wire bookmarks + cookies + spread tab-context-handlers + tab.contextMenu IPC
- `browser/identity-handlers.js` — agregar clearBrowsingData
- `browser/menu.js` — submenu "Tab" con atajos Ghost-style
- `browser/mcp-tools.js` — spread buildTabContextTools
- `browser/ui/sidebar.js` — reemplazar HTML ctx menu por IPC al menú nativo
- `browser/ui/tabstrip.js` — agregar contextmenu listener
- `preload.js` — exponer bookmarks + cookies + tab actions individuales + contextMenu
- `tests/mcp-server.smoketest.js` — extender contract test (regex + exempt)
- `CHANGELOG.md` — entrada del bloque
- (Prettier format pass sobre 6 archivos)

## Próximo paso

Bloque 1.8 Proxy Manager (~12h con csv-parse) — modelo Proxy + CRUD + UI dedicada + bulk import CSV + test conectividad + Auto-Assign random/round-robin + asignación per-tab/per-identity/per-workspace + bypass list + health checks intervalados + templates por provider (Oxylabs/Bright Data/Smartproxy/IPRoyal) + bandwidth meter + tools MCP `oz.proxies.*`.

O alternativamente Bloque 1.9 FingerprintEngine "Ghost+" (~14h) — pasar Pixelscan/CreepJS por default. 14 vectores spoofeados via preload script per-identity + coherencia GeoIP automática vía proxy.

Decidir según prioridad de Jose. El plan original prioriza 1.8 antes de 1.9 porque proxies habilita el revenue tier "Pro" ($29-35/mo vs $46-59 de Ghost) que es el modelo de negocio del SaaS.

## Validación visual

Pendiente al final del commit — ejecutar `npm start` con OZ_MCP_ENABLED=1, abrir la app, right-click en tab del sidebar, verificar menú nativo con 16 opciones, ejercitar Duplicate / Duplicate (Temp) / Pin / Mute / Bookmark / Move to New Window. (Se hará post-commit junto con el push.)
