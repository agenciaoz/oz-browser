# ADR 0043 — Módulo de diagnóstico total (oz.diag.\*)

**Date:** 2026-07-16
**Status:** Accepted
**Contexto:** Jose: "deberíamos tener un módulo para que [Claude] pueda siempre revisar todo... hasta con pantallazos y análisis de esas imágenes... que puedas en serio revisar todo... la idea es que puedas hasta analizar este mismo módulo tú mismo." Hasta ahora, para diagnosticar el navegador el agente tenía que encadenar muchas tools (`oz.ids.list`, `oz.proxies.list`, `oz.system.getMetrics`, `oz.health.list`, ...) y no tenía forma de VER la UI ni de leer los errores del log.

## Decisión

Un subsistema de diagnóstico MCP-first (`oz.diag.*`) que da al agente una vista completa del navegador en pocas llamadas, incluida captura visual.

**`system-diagnostics.js`** (lógica pura, guardada, nunca tira):

- `buildDiagnostics(browser, opts)` — snapshot único: runtime (versión/uptime/memoria/node/plataforma), `enforceProxy`, identidades (count + lista), salud de proxies (`summarizeProxies`: active/disabled/failing/avgLatency/worst), sesiones cacheadas, tabs por ventana, workspaces, estado de sync, toggles de settings, resumen del último scrape job, y un `selfCheck` embebido. Con `includeLog` (default on) adjunta la cola WARN/ERROR del log.
- `parseLogTail(text, {level, limit})` — filtra el log por nivel mínimo (puro).
- `readLogTail(path, opts)` — lee solo los últimos ~512KB del archivo y delega en `parseLogTail`.
- `selfCheck(browser)` — verifica que los managers/handlers de los que depende (y los propios exports del módulo) están presentes → el diagnóstico se diagnostica a sí mismo.

**`diagnostics-handlers.js`** (Electron): `snapshot`, `logs`, `selfCheck`, y **`screenshot`** — usa `webContents.capturePage()` sobre el chrome de la WebUI (`target:'chrome'`) o el contenido de un tab (`content`/`tab`/`identity`), guarda un PNG en `userData/diagnostics/` y **devuelve el path**. El módulo NO hace visión por computadora: produce una imagen robusta; el agente lee el archivo y lo analiza con su propia visión.

**MCP:** `oz.diag.snapshot`, `oz.diag.logs`, `oz.diag.selfCheck`, `oz.diag.screenshot` (registrados `oz_diag_*`, todos ≤21 chars). Wired en `mcp-tools-extra.js`; handler `diag` en el mapa de `ipc-handlers.js`.

## Alternativas consideradas

- **Dejar que el agente encadene las tools existentes** — rechazada: frágil, verboso, y no cubre ni la vista visual ni el log. Un snapshot único es más robusto y barato.
- **Screenshot vía computer-use / captura de SO** — rechazada para el módulo in-app: `capturePage()` es preciso (captura exactamente el webContents, sin depender del foco del SO ni de permisos de pantalla), funciona headless, y no requiere que Jose esté presente.
- **Análisis de imagen dentro del módulo (OCR/CV)** — rechazada: el agente ya tiene visión; el módulo solo debe entregar una imagen fiel y su path.

## Consecuencias

- El agente puede auditar el estado completo del navegador (incl. errores del log y captura visual) sin depender de que Jose pase datos.
- `selfCheck` permite verificar que "revisar todo" realmente puede revisar todo — y diagnosticar el propio diagnóstico.
- Los PNG se acumulan en `userData/diagnostics/` (limpieza futura si hace falta; hoy es aceptable).
- Solo main process; requiere reiniciar OZ para que las tools nuevas aparezcan en el server MCP en vivo. Screenshot requiere smoke en Electron (capturePage no corre en sandbox/CI).
- Tests: `tests/system-diagnostics.smoketest.js` (36, lógica pura). El screenshot se valida en smoke vivo.

Ver: `docs/modules/system-diagnostics.md`, `system-diagnostics.js`, `diagnostics-handlers.js`, ADR 0012 (oz-mcp-server), 0042 (scrape-observability).
