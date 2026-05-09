# Feature: Logging exhaustivo

**Bloque:** 1.2 (base ya implementado) + 1.7 (Log Viewer UI in-app)
**Estado:** 🚧 base implementado · UI in-app pendiente

> Política completa: ADR [`0009-logging-everything`](../architecture/0009-logging-everything.md). La regla es **todo se loggea**.

## Caso de uso

- Jose hace pruebas y necesita ver en tiempo real qué hace OZ Browser
- Un empleado reporta "se quedó pegado" — Jose pide logs y reproduce
- Algo raro (cuenta deslogoneada inexplicablemente) — los logs muestran qué cookie se borró cuándo y por qué
- Auto-attach a emails de error popup

## Niveles

| Nivel   | Cuándo                                                            |
| ------- | ----------------------------------------------------------------- |
| `DEBUG` | parámetros, IDs internos, latencias detalladas                    |
| `INFO`  | eventos del lifecycle (app start, identity created, sync started) |
| `WARN`  | anomalías recuperables (proxy lento, retry, fallback)             |
| `ERROR` | fallas reales (excepciones, IPC errors, render-process-gone)      |

## Storage

- **Archivo:** `~/Library/Logs/OZ Browser/oz-browser.log`
- **Rotation:** 10 MB → rotate, mantener 3 archivos previos (`.log.1`, `.log.2`, `.log.3`)
- **Consola:** mirror en dev mode (process.env.NODE_ENV !== 'production')

## API del logger

```js
const log = require('./logger')
log.init()                           // call once at app start
log.debug('source', 'msg', { ... })  // structured args
log.info('source', 'msg', { ... })
log.warn('source', 'msg', { ... })
log.error('source', 'msg', { ... })
log.getLogFilePath()                 // for email-Jose popup
```

## Qué loggea cada módulo

### `main.js` (Browser orchestrator)

- App start / quit
- Init lifecycle: session ready, IdentityManager loaded, IPC registered, WebUI loaded, initial window
- `window-all-closed`, `activate`

### `identity-manager.js`

- `_load()` — quantity loaded
- `create/rename/setColor/remove` — identity id + outcome
- `getSession(id)` — cache hit/miss

### `tabs.js`

- `create()` — tab id + identityId + lazy/eager
- `materialize()` — tab id + URL + duration
- `select()` — from id → to id
- `remove()` — tab id + reason
- `loadURL()` — URL + status code (success/fail)

### `proxy-manager.js` (Bloque 1.4)

- Bulk import — count + duration
- Test connectivity per proxy — host + latency + ok/fail
- Health check daemon tick — counts
- Auto-disable due to N failures — proxy id + reason

### `account-vault.js` (Bloque 1.5)

- Vault unlock — success/fail (NEVER log password)
- Save account — site + identityId (NEVER log password)
- Auto-fill — site + identityId + outcome
- Anti-logout cookie extension — site + extension applied

### `sync-client.js` (Etapa 7)

- Push/pull cycle — bytes + duration + outcome
- Conflict detected — entity + resolution

### `ipc-handlers.js`

- Cada handler: `[DEBUG] entered oz:foo:bar args=...` al entrar, `[INFO] oz:foo:bar ok duration=N` al salir.
- Errores capturados → `[ERROR] oz:foo:bar threw stack=...`

### Renderer (UI)

- Errors via `window.addEventListener('error')` y `unhandledrejection` → `oz:report-error` IPC → ERROR en main log.

## Métricas periódicas

Cada 30 segundos:

```js
log.debug('metrics', 'snapshot', {
  ramRSS: process.getProcessMemoryInfo().private,
  ramTotal: app.getAppMetrics().reduce(...),
  cpuUsage: process.getCPUUsage(),
  tabsTotal: count,
  tabsLazy: count,
  tabsMaterialized: count,
  identitiesLoaded: count,
  windowsOpen: count,
})
```

## Privacy filters

`logger.js` aplica regex automáticos antes de escribir:

| Patrón                | Reemplazo            |
| --------------------- | -------------------- | ----------- | --------------------- |
| `(password            | passwd               | pwd)\W+\S+` | `password=[REDACTED]` |
| `Bearer\s+[\w.\-]+`   | `Bearer [REDACTED]`  |
| `Cookie:\s*[^\s;]+`   | `Cookie: [REDACTED]` |
| `(api[_-]?key)\W+\S+` | `apikey=[REDACTED]`  |

Tests del filtro en `tests/logger-privacy.test.js` (cuando lleguemos a tests).

## UI in-app — Log Viewer (Bloque 1.7)

Acceso: `View → Show Log Viewer` (Cmd+Opt+L).

Layout:

```
┌─────────────────────────────────────────────────────────────┐
│ [Filters] Level: [DEBUG INFO WARN ERROR]                     │
│           Source: [▼ all]    Search: [        ]              │
│           Time: [last 1h ▼]    [☑ auto-scroll]               │
├─────────────────────────────────────────────────────────────┤
│ [timestamp] LEVEL [source] message {args...}                 │
│ [timestamp] LEVEL [source] message {args...}                 │
│ ...                                                          │
├─────────────────────────────────────────────────────────────┤
│ [Clear] [Copy all] [Export] [Email Jose] [Open log file]    │
└─────────────────────────────────────────────────────────────┘
```

Streaming live: el viewer se subscribe a un IPC `oz:log:tail` que envía cada línea conforme se escribe.

## Cómo ayuda esto durante pruebas

- Jose abre OZ Browser
- Cmd+Opt+L → Log Viewer en una ventana flotante
- Hace lo que quiere probar
- Si algo se rompe o se ve raro, los logs ya tienen todo
- Email Jose con un click → ya tiene los logs adjuntos en el body

## Módulos involucrados

- `browser/logger.js` ✅
- `browser/error-handler.js` ✅
- `browser/ui/log-viewer.html` (Bloque 1.7)
- `browser/ui/log-viewer.js` (Bloque 1.7)
- `preload.js` con `window.oz.log` ✅
