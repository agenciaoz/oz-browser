# Módulo `logger`

**Path:** `browser/logger.js`
**Líneas:** 111
**Bloque:** 1.2

## Qué hace

Logger central del proyecto. Escribe líneas timestamped a `~/Library/Logs/OZ Browser/oz-browser.log` con rotación a 10 MB (mantiene 3 archivos viejos). Mirror a consola en dev. **Pilar arquitectónico** — política completa en ADR 0009.

## Exports

| Símbolo | Tipo | Descripción |
|---|---|---|
| `init()` | function | Inicializa el logger. Llamar una vez al inicio de la app. |
| `debug(source, msg, ...args)` | function | Log nivel DEBUG. |
| `info(source, msg, ...args)` | function | Log nivel INFO. |
| `warn(source, msg, ...args)` | function | Log nivel WARN. |
| `error(source, msg, ...args)` | function | Log nivel ERROR. |
| `getLogFilePath()` | function | Retorna path al archivo de log activo. |

## Dependencias

- `electron` (`app.getPath('logs')`)
- `fs` (write stream + stat + rename)
- `path`

## Eventos / efectos

- Crea directory `~/Library/Logs/OZ Browser/` si no existe.
- Mantiene `oz-browser.log` + `.log.1` + `.log.2` + `.log.3` con rotation.
- Logger NO crashea la app — todos los errores internos se ignoran (la app no debe fallar porque el logger falló).

## Formato

```
[ISO timestamp] LEVEL [source] message {arg1} {arg2}
```

Ejemplo:
```
[2026-05-09T19:42:48.927Z] INFO  [browser] IdentityManager loaded {"identitiesCount":2}
```

## Ejemplo de uso

```js
const log = require('./logger')
log.init()  // una vez al inicio
log.info('identity-manager', 'Identity created', { id: 'abc123', name: 'Cliente A' })
log.warn('proxy', 'Slow proxy detected', { id: 'p7', latency: 4500 })
log.error('vault', 'Decryption failed', { reason: err.message })
```

## Privacy filters (Bloque 1.X — pendiente)

A implementar: regex automáticos antes de escribir cualquier línea para reemplazar:
- `password=...` → `password=[REDACTED]`
- `Bearer xxx` → `Bearer [REDACTED]`
- `Cookie: ...` → `Cookie: [REDACTED]`
- `apikey=xxx` → `apikey=[REDACTED]`

Tests planeados en `tests/logger-privacy.test.js`.

## Gotchas

- `init()` requiere que `app` de Electron esté disponible — no llamar en top-level antes de `app.whenReady()`. (Excepción: en `main.js` lo llamamos justo antes del Browser constructor; funciona porque `app.getPath('logs')` está disponible pre-whenReady.)
- Si el logger no inicializa, las llamadas siguen funcionando — solo van a console, no a archivo. Robusto pero silencioso. Verificar `getLogFilePath()` retorna no-null para confirmar.

## Referencias

- ADR de política: [`../architecture/0009-logging-everything.md`](../architecture/0009-logging-everything.md)
- Feature: [`../features/logging.md`](../features/logging.md)
- Usado por todos los módulos del backend.
