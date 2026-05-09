# Módulo `main`

**Path:** `browser/main.js`
**Líneas:** 155
**Bloque:** 1.1-1.2 ✅

## Qué hace

Entry point del main process. Es el **orquestador** — instancia los demás módulos pero no contiene lógica de negocio. Toda la pesada vive en módulos hermanos (`window-manager`, `ipc-handlers`, `extensions-setup`).

## Exports

| Símbolo | Tipo | Descripción |
|---|---|---|
| `Browser` | class (default export) | Instancia del browser. |

## Lifecycle

```
constructor()
  → log.init()  (en module-load, antes del constructor)
  → setupErrorHandlers()  (idem)
  → setupWebContentsCreatedHandler(this)
  → app.whenReady().then(() => init())

init()
  → initSession(this)               (extensions-setup)
  → registerPreload(session)        (extensions-setup)
  → new IdentityManager()
  → registerIpcHandlers(this)       (ipc-handlers)
  → setupMenu(this)
  → buildChromeExtensions(this)     (extensions-setup)
  → loadExtensions(this)            (extensions-setup, async)
  → createInitialWindow()
  → resolveReady()
```

## Estado en la instancia

- `windows: TabbedBrowserWindow[]`
- `urls.newtab` (override por extensions)
- `activeIdentityId` — id que se asigna a tabs creados via chrome.tabs API
- `identityManager: IdentityManager`
- `webuiExtensionId` — id asignado al cargar la WebUI extension
- `extensions: ElectronChromeExtensions`
- `session` — defaultSession (asignada en initSession)

## Métodos públicos

| Método | Descripción |
|---|---|
| `broadcastToWebUI(channel, ...args)` | Envía IPC a todos los WebContents de browser chrome. |
| `getFocusedWindow()` | TabbedBrowserWindow con foco. |
| `getWindowFromBrowserWindow(window)` | Lookup en this.windows por id. |
| `getWindowFromWebContents(wc)` | Resuelve via `getParentWindowOfTab`. |
| `createWindow(options?)` | Crea nueva TabbedBrowserWindow. |
| `createInitialWindow()` | Llama createWindow(). |

## Eventos handled

| Evento | Acción |
|---|---|
| `app.whenReady` | init() |
| `app.window-all-closed` | quit() (excepto darwin) |
| `app.activate` | createInitialWindow si no hay windows |
| `app.web-contents-created` | wired via setupWebContentsCreatedHandler |

## Logs

- INFO al inicio de init: `Browser.init() starting`
- INFO con identitiesCount al cargar IdentityManager
- INFO con webuiExtensionId al cargar WebUI
- INFO al final: `Browser.init() done — initial window created`
- DEBUG por web-contents-created via extensions-setup

## Gotchas

- Logger se inicializa en module-load (top of file), antes del constructor de Browser. Esto es seguro porque `app.getPath('logs')` existe pre-whenReady.
- `webuiExtensionId` se setea durante `loadExtensions()`. Ventanas creadas ANTES no van a poder cargar webui.html. createInitialWindow() se llama DESPUÉS, por eso funciona.
- En macOS, `window-all-closed` no quitea (estándar mac UX).

## Referencias

- ADRs: [0001](../architecture/0001-electron-stack.md) (stack), [0009](../architecture/0009-logging-everything.md) (logging).
- Módulos relacionados:
  - [`window-manager.md`](window-manager.md) — TabbedBrowserWindow
  - [`ipc-handlers.md`](ipc-handlers.md) — IPC
  - [`extensions-setup.md`](extensions-setup.md) — Chrome extensions
  - [`paths.md`](paths.md) — PATHS
