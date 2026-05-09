# Módulo `extensions-setup`

**Path:** `browser/extensions-setup.js`
**Líneas:** 210
**Bloque:** 1.1-1.2 ✅

## Qué hace

Toda la integración con Chrome extensions: setup de sesión (UA scrub), instancia `ElectronChromeExtensions`, install Chrome Web Store, carga de extensions locales, y handlers para `web-contents-created` (window.open + context menu).

## Exports

| Símbolo                                   | Tipo             | Descripción                                      |
| ----------------------------------------- | ---------------- | ------------------------------------------------ |
| `initSession(browser)`                    | function         | Configura defaultSession (UA scrub, SW logging). |
| `registerPreload(session)`                | function         | Registra preload script en una session.          |
| `buildChromeExtensions(browser)`          | function         | Crea instancia de ElectronChromeExtensions.      |
| `loadExtensions(browser)`                 | function (async) | Carga WebUI ext + Chrome Web Store + locales.    |
| `setupWebContentsCreatedHandler(browser)` | function         | Wirea app.on('web-contents-created').            |

## Flow de setup (en main.js init)

```js
initSession(this) // 1. UA scrub
registerPreload(this.session) // 2. preload.js para todos los frames
this.extensions = buildChromeExtensions(this) // 3. instancia
await loadExtensions(this) // 4. carga extensions
```

## ChromeExtensions config (passed at construction)

| Key            | Descripción                                                   |
| -------------- | ------------------------------------------------------------- |
| `license`      | 'internal-license-do-not-use' (no requerido para uso interno) |
| `session`      | browser.session (defaultSession)                              |
| `createTab`    | callback async — usa `tabs.create({materialize: true})`       |
| `selectTab`    | maps webContents.id → OZ tab id, llama tabs.select            |
| `removeTab`    | idem para remove                                              |
| `createWindow` | crea nueva BrowserWindow                                      |
| `removeWindow` | destroy                                                       |

## WebContents handlers

Para cada `web-contents-created`:

1. **window.open handler** — intercepta target=\_blank / disposition=foreground-tab. Crea nueva tab con webContents pre-supplied (eager). URL del details.
2. **context-menu handler** — `buildChromeContextMenu` (de electron-chrome-context-menu) con extensionMenuItems del extensions API. `openLink` callback abre tabs lazy con activeIdentityId.

## Gotchas

- `loadAllExtensions(LOCAL_EXTENSIONS, ...)` falla si la carpeta no existe. Catcheado y logueado como WARN — no crashea la app.
- `installChromeWebStore` registra el handler `chrome.webstore.install`. Sin esto, instalar desde chrome.google.com/webstore tira error.
- WebUI extension ID se setea en `browser.webuiExtensionId` durante `loadExtensions()`. window-manager lo lee para construir la URL `chrome-extension://<id>/webui.html`.
- Service workers de extensions MV3 deben startear manualmente con `serviceWorkers.startWorkerForScope`. Sino algunas extensions no responden.
- ADR 0003: extensions API solo funciona con tabs cuya session === defaultSession. Para per-Identity extension support, hace falta una instancia de ElectronChromeExtensions por identity (Bloque 1.10).

## Referencias

- ADRs: [0001](../architecture/0001-electron-stack.md) (Electron stack), [0003](../architecture/0003-default-identity-uses-defaultsession.md) (default session).
- Módulos relacionados: [`window-manager.md`](window-manager.md), [`paths.md`](paths.md).
