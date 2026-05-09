# Módulo `window-manager`

**Path:** `browser/window-manager.js`
**Líneas:** 105
**Bloque:** 1.2 ✅

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
  webuiExtensionId,   // id de la WebUI extension (para cargar webui.html)
  urls,               // { newtab: 'url' }
  initialUrl?,        // primera tab eager URL
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

## Initial tab

```js
queueMicrotask(() => {
  const tab = this.tabs.create({ url, materialize: true })
  this.tabs.select(tab.id)
})
```

Primera tab siempre eager (debe ser visible inmediatamente). Tabs subsecuentes son lazy por default.

## API

| Método                           | Descripción                            |
| -------------------------------- | -------------------------------------- |
| `destroy()`                      | tabs.destroy() + window.destroy()      |
| `getFocusedTab()`                | tabs.selected                          |
| `_sendToWebUI(channel, payload)` | webContents.send con guard isDestroyed |

## Gotchas

- `tab.webContents.session !== this.session` para tabs en partition sessions. SIEMPRE chequear antes de llamar `extensions.addTab/selectTab` (la API valida que sea la session que recibió en su constructor — ADR 0003).
- `webuiExtensionId` debe estar disponible al construir (sino webui.html no carga). main.js asegura esto llamando `loadExtensions()` antes de `createInitialWindow()`.
- Tab events emit del Tabs class, NO del Tab — los handlers reciben `(tab, info?)`.

## Referencias

- ADR 0002 (lazy tabs), 0003 (default session).
- Módulos relacionados: [`tabs.md`](tabs.md), [`extensions-setup.md`](extensions-setup.md).
