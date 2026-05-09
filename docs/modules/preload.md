# Módulo `preload`

**Path:** `preload.js` (raíz del repo, NO en `browser/`)
**Líneas:** 93
**Bloque:** 1.2 ✅

## Qué hace

Preload script que se inyecta en CADA WebContents. Su trabajo: exponer `window.oz` solo al browser chrome (`chrome-extension://<id>/webui.html`), y forwardear errores/logs del renderer al main via IPC.

## Exports al WebUI

`window.oz` con sub-namespaces:

### `window.oz.identities.*`

```js
;(list(),
  get(id),
  getActive(),
  setActive(id),
  create(opts),
  rename(id, name),
  setColor(id, color),
  remove(id),
  onChanged(cb),
  onActiveChanged(cb))
```

### `window.oz.tabs.*`

```js
;(list(),
  getIdentity(tabId),
  openInIdentity(identityId, url),
  select(tabId),
  close(tabId),
  bulkCreateLazy(count, identityId, urlTemplate),
  onUpdated(cb))
```

### `window.oz.nav.*`

```js
;(back(), forward(), reload(), loadURL(url))
```

### `window.oz.log.*`

```js
;(debug(source, msg, ...args),
  info(source, msg, ...args),
  warn(source, msg, ...args),
  error(source, msg, ...args),
  reportError(detail))
```

## Forward de errores del renderer

```js
window.addEventListener('error', (event) => {
  ipcRenderer.invoke('oz:report-error', {
    source: 'renderer/webui',
    message: event.message,
    filename, lineno, colno,
    stack: event.error?.stack,
  })
})
window.addEventListener('unhandledrejection', (event) => {
  ipcRenderer.invoke('oz:report-error', {
    source: 'renderer/webui',
    message: 'Unhandled promise rejection',
    reason: ...
  })
})
```

## Gotchas

- **El preload se carga en TODOS los webContents** (incluyendo páginas web normales). Por eso filtramos `if (isWebUI)` para exponer `window.oz` SOLO en webui.html. Sino una página maliciosa podría llamar `window.oz.identities.create()`.
- `injectBrowserAction()` también solo en webui.html.
- `contextBridge.exposeInMainWorld` requiere `contextIsolation: true` en webPreferences. Está en true.
- preload.js está en la RAÍZ del repo (no en browser/) porque webpack-renderer espera el path así por su config.

## Referencias

- IPC channels expuestos: ver [`ipc-handlers.md`](ipc-handlers.md).
