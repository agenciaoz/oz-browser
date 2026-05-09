# Módulo `error-handler`

**Path:** `browser/error-handler.js`
**Líneas:** 141
**Bloque:** 1.2 ✅

## Qué hace

Captura errores no manejados (main + renderer + workers) y muestra un popup con 4 botones: **Email Jose** (mailto: pre-rellenado con stack + system info), **Copy details**, **Open log file**, **Dismiss**.

## Exports

| Símbolo                               | Tipo     | Descripción                                            |
| ------------------------------------- | -------- | ------------------------------------------------------ |
| `setupErrorHandlers()`                | function | Registra handlers globales. Llamar al inicio.          |
| `showErrorDialog(title, errOrDetail)` | function | Muestra popup manualmente.                             |
| `wrapHandler(channel, fn)`            | function | Wrappea un IPC handler para auto-log+popup en errores. |

## Handlers registrados

| Evento                             | Origen               |
| ---------------------------------- | -------------------- |
| `process.on('uncaughtException')`  | main                 |
| `process.on('unhandledRejection')` | main                 |
| `app.on('render-process-gone')`    | renderer crashed     |
| `app.on('child-process-gone')`     | child (utility, GPU) |

## Email-Jose flow

```
1. Error capturado → log.error con stack + context
2. showErrorDialog mostrado en BrowserWindow focused
3. Usuario elige:
   a) Email Jose → shell.openExternal('mailto:joserodrigo@gmail.com?subject=...&body=...')
                   pre-fill: title, time, version, platform, electron version, log path, stack
   b) Copy details → clipboard.writeText(title+stack)
   c) Open log file → shell.showItemInFolder(logfilepath)
   d) Dismiss → close
```

## Anti-spam

- Variable `dialogShowing` → si ya hay uno, suprime el siguiente con WARN log. Evita spam de popups si N errores fire al mismo tiempo.

## Auto-attach logs (pendiente — Bloque 1.7)

- TODO: leer últimas N líneas de `~/Library/Logs/OZ Browser/oz-browser.log`
- Adjuntar al body del email automáticamente
- Configurable en Settings: cuántas líneas (default 200)

## Wrapper para IPC handlers

```js
const { wrapHandler } = require('./error-handler')
ipcMain.handle(
  'oz:foo',
  wrapHandler('oz:foo', async (e, args) => {
    // Si throws, se loggea + popup automático.
  }),
)
```

(No usado todavía — patrón disponible para futuro.)

## Privacy

- Stack traces NUNCA contienen passwords/tokens (filtrados en logger antes de write — por implementar).
- `mailto:` body URL-encoded.

## Gotchas

- Si error es en renderer, llega via IPC `oz:report-error` (registrado en ipc-handlers). El popup mostrado es el mismo.
- Errores en el propio popup (showMessageBox failed) → log.error pero no recursión infinita.

## Referencias

- ADR 0009 (logging) — error handler es parte del pilar.
- Usado por: `main.js` (setupErrorHandlers en boot), `ipc-handlers.js` (showErrorDialog en oz:report-error handler).
