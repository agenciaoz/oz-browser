# Módulo `window-manager`

**Path:** `browser/window-manager.js`
**Líneas:** ~165
**Bloque:** 1.2 ✅ · extendido en 1.4b (workspace switch + 1-1 lock)

## Qué hace

Define `TabbedBrowserWindow` — clase que combina una `BrowserWindow` con sus `Tabs` y wirea todos los eventos de tabs hacia (a) ChromeExtensions API y (b) IPC notifications a la sidebar UI.

## Exports

| Símbolo               | Tipo  | Descripción        |
| --------------------- | ----- | ------------------ |
| `TabbedBrowserWindow` | class | Window+Tabs combo. |

## Constructor options

```js
new TabbedBrowserWindow({
  session,            // Electron Session (default: defaultSession)
  extensions,         // ElectronChromeExtensions instance
  identityManager,    // IdentityManager instance
  browser,            // (1.4b) ref al Browser — para workspaceManager + lock
  workspaceId?,       // (1.4b) workspace inicial; default = workspaceManager.getDefault().id
  webuiExtensionId,   // id de la WebUI extension (para cargar webui.html)
  urls,               // { newtab: 'url' }
  initialUrl?,        // primera tab eager URL (solo si workspace recién creado / sin tabSpecs)
  window,             // BrowserWindow constructor opts
})
```

## Tab event wiring

Configurado en `_wireTabEvents()`:

| Evento de Tabs     | Acción                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `tab-created`      | Si no tiene URL, queue `urls.newtab`. Notify sidebar `oz:tabs:updated kind=created`.                        |
| `tab-materialized` | Si session === defaultSession, llamar `extensions.addTab()`. Notify sidebar `kind=materialized`.            |
| `tab-updated`      | Notify sidebar `kind=updated` con info nueva.                                                               |
| `tab-selected`     | Si webContents.session === defaultSession, llamar `extensions.selectTab()`. Notify sidebar `kind=selected`. |
| `tab-destroyed`    | Notify sidebar `kind=removed`.                                                                              |

## Initial tab (1.4b actualizado)

```js
queueMicrotask(() => {
  const ws = wm.get(this.workspaceId)
  if (ws && ws.tabSpecs.length > 0) {
    // Recreate from persisted state — lazy + select activeTabId
    hydrateWorkspace({ window: this, browser: this.browser })
    return
  }
  // No tabSpecs (first arrival) — create eager newtab
  const tab = this.tabs.create({ url, materialize: true })
  this.tabs.select(tab.id)
})
```

Primera tab eager solo si el workspace no tiene tabSpecs persistidas. Si las tiene, hidratamos lazy desde tabSpecs (todas excepto la activa quedan no-materialized hasta que el user las clickee).

## API

| Método                                 | Descripción                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `switchToWorkspace(targetWorkspaceId)` | (1.4b) Delega a `window-workspace.switchWorkspace`. Retorna `{ok, ...}` (lock check, snapshot, hydrate). |
| `destroy()`                            | (1.4b) Snapshot + release del workspace lock + tabs.destroy() + window.destroy()                         |
| `getFocusedTab()`                      | tabs.selected                                                                                            |
| `_sendToWebUI(channel, payload)`       | webContents.send con guard isDestroyed                                                                   |

## Gotchas

- `tab.webContents.session !== this.session` para tabs en partition sessions. SIEMPRE chequear antes de llamar `extensions.addTab/selectTab` (la API valida que sea la session que recibió en su constructor — ADR 0003).
- `webuiExtensionId` debe estar disponible al construir (sino webui.html no carga). main.js asegura esto llamando `loadExtensions()` antes de `createInitialWindow()`.
- Tab events emit del Tabs class, NO del Tab — los handlers reciben `(tab, info?)`.

## Workspace lifecycle (1.4b)

- Cada ventana tiene `workspaceId` único — lock exclusivo: 1 ventana = 1 WS, 1 WS = max 1 ventana (ADR 0015).
- `this.window.on('close', ...)` y `destroy()` ambos llaman `releaseOnDestroy(this, this.browser)` para snapshot + release del lock antes de morir. Idempotente.
- La lógica del switch vive en [`window-workspace.md`](window-workspace.md) (módulo extraído para testabilidad).

## Referencias

- ADR 0002 (lazy tabs), 0003 (default session), 0015 (workspace model + 1-1 lock).
- Módulos relacionados: [`tabs.md`](tabs.md), [`extensions-setup.md`](extensions-setup.md), [`window-workspace.md`](window-workspace.md), [`workspace-manager.md`](workspace-manager.md).
