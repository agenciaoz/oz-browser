# preload-tabs-api

Bridge del dominio **Tabs** para el renderer, extraído de `preload.js` por el budget de 500 LOC (ADR 0005). Mismo patrón que `preload-projects-api.js` / `preload-bulk-api.js`.

## Qué hace

`buildTabsApi(ipcRenderer)` devuelve el objeto que se expone como `window.oz.tabs`: cada método envuelve un `ipcRenderer.invoke('oz:tabs:*', ...)`. Se ensambla en `preload.js` con `tabs: require('./browser/preload-tabs-api').buildTabsApi(ipcRenderer)`.

## Métodos

`list`, `getIdentity`, `openInIdentity`, `select`, `reorder`, `close`, `reopenClosed`, `bulkCreateLazy`, `moveToWorkspace`, **`moveToNewWindow`** (alpha.103), `contextMenu`, `reload`, `duplicate`, `pin`/`unpin`, `lock`/`unlock`, `mute`/`unmute`, y `onUpdated(cb)` (suscripción a `oz:tabs:updated`, devuelve unsubscribe).

## Notas

- `moveToNewWindow(tabId)` → `oz:tabs:moveToNewWindow` (IPC en `tab-ipc-setup.js`, handler `tab-context-handlers.moveToNewWindow`). Agregado en alpha.103 para que el command palette (⌥S) dispare la acción real; antes era un stub renderer.
- Cada canal IPC lo registra `tab-ipc-setup.js`; los handlers viven en `tab-handlers.js` / `tab-context-handlers.js`.

## Tests

Cubierto indirectamente por `tests/command-palette.smoketest.js` y el smoke visual de tabs. El builder es un passthrough puro sin lógica.
