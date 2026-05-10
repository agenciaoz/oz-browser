# ADR 0021 — Auto-update strategy (Etapa 3d)

**Date:** 2026-05-10
**Status:** Accepted (wiring complete, runtime blocked by 3b/3c)
**Bloque:** Etapa 3d
**Predecesor:** ADR 0020 (Packaging strategy 3a)

## Context

Etapa 3a empaqueta el .app + genera el .dmg. Etapa 3d agrega la **otra mitad del lifecycle de distribución**: que la app instalada chequee periódicamente si hay una nueva versión y la instale automáticamente con consentimiento mínimo del usuario.

`update-electron-app` (lib oficial del Electron team encima de `electron-updater`) es el path canónico para Forge. Pero su default `update.electronjs.org` (servicio hosted gratuito) **requiere repo público** para pollear GitHub Releases con la API pública. **El repo `agenciaoz/oz-browser` es privado** (decisión de Jose — código competitivo: vault crypto, antidetect engine, MCP server interno, etc.). Necesitamos otra estrategia.

## Decision

**Update channel: Cloudflare R2 + `update-electron-app` con `UpdateSourceType.StaticStorage`.**

R2 es el object storage S3-compatible de Cloudflare. Free tier: 10 GB storage + 1M Class A operations/mes + 10M Class B operations/mes — sobra para cualquier scale realista de OZ (~12 MB por DMG release × 2 builds/mes × 1000 users haciendo download = ~24 GB de download por mes, cubierto por el egress gratis de R2). Setup ~30 min: crear cuenta Cloudflare, crear bucket, generar API token, exponer URL pública (custom domain o `<bucket>.r2.dev`). Sin lock-in (S3-compatible API → migrable a AWS S3, GCS, etc.).

**`browser/auto-update.js`** wrappea `updateElectronApp()` con guards explícitos:

| Skip condition                  | Reason                 | Acción                      |
| ------------------------------- | ---------------------- | --------------------------- |
| `!app.isPackaged` (dev mode)    | `not-packaged`         | WARN log, return            |
| `process.platform !== 'darwin'` | `unsupported-platform` | WARN log, return            |
| `OZ_UPDATE_DISABLED === '1'`    | `disabled-by-env`      | WARN log, return            |
| `OZ_UPDATE_BASE_URL` no set     | `no-base-url`          | WARN log con hint, return   |
| baseUrl no es HTTPS             | `invalid-base-url`     | ERROR log, return           |
| `updateElectronApp()` throw     | `lib-error`            | ERROR log con stack, return |

**Defaults** (per PLAN-MAESTRO §ETAPA 3 UX, decididos 2026-05-09 noche):

- `updateInterval: '1 hour'` — checa al startup + cada 1 hora. Mínimo del lib es 5 min.
- `notifyUser: true` — dialog **nativo del OS** al usuario cuando download está ready, opciones "Restart now" / "Later". Decidido sobre custom topbar banner (más LOC, branded) en favor de standard UX + speed-to-ship.
- `updateSource: { type: 1 (StaticStorage), baseUrl: process.env.OZ_UPDATE_BASE_URL }`.

**Logger adapter:** `update-electron-app` espera `{ log: function }`. Mapeamos a `logger.info('auto-update', ...)` para que los mensajes del updater queden en el mismo log file que el resto del browser (`~/Library/Logs/OZ Browser/oz-browser.log`).

**Wire point:** `Browser.init()` post-todos-los-managers, justo antes de `resolveReady()`. Llamado SIEMPRE — los WARN logs cuando se skipea son señal útil ("intenté pero faltó X"). Wrapped en try/catch interno del módulo (auto-update no debe nunca crashear el browser).

## Alternativas consideradas

**Hacer el repo público** — más simple (cero infra), pero expone código competitivo (vault crypto, antidetect, MCP, business logic de pricing/entitlements). **Rechazado** — el moat técnico vale más que el ahorro de 30 min de setup R2.

**GitHub Releases del repo privado + custom token-based downloader** — `update-electron-app` no soporta esto nativamente (la API pública de GH polling no acepta auth tokens). Hackearlo con un proxy intermedio o forking de la lib es deuda técnica innecesaria. **Rechazado.**

**Switch a `electron-updater` directo** (más madurez con repos privados) — requiere cambiar de toolchain (Forge → Builder), re-aprender el build pipeline. ADR 0020 ya descartó esta migración. **Rechazado.**

**Postpone 3d hasta tener data del primer release** — feasible pero requiere volver a este código después + el wiring estructural (logger adapter + skip guards + tests) ya tiene valor independiente de la URL real. **Rechazado** — mejor wireearlo ahora con `OZ_UPDATE_BASE_URL` env vacío (skip con WARN) y setear cuando llegue 3e.

**Custom topbar banner UI vs native dialog** — banner branded es más OZ-flavor pero requiere ~80 LOC adicionales (autoUpdater event handlers manuales + IPC + UI component + tests). Para v1, native dialog es suficiente. Branded banner anotado como C-XX upgrade post-launch.

**Channels beta/dev** — solo `stable` en v1. Beta channels son C-17 (anotado en PLAN-MAESTRO). Sin internal users hoy, no hay use case.

## Trade-offs aceptados

- **Runtime bloqueado por 3b/3c** — sin notarización Apple, `update-electron-app` falla en silencio en macOS Catalina+ (Squirrel.Mac no acepta el .app firmado-but-not-notarized). Aceptado: el wiring queda listo, runtime se valida apenas Jose pague Apple Dev. Documentado en código + módulo + ADR.
- **Jose tiene que crear el R2 bucket manualmente** — ~30 min one-time. Dejé las instrucciones en `docs/modules/auto-update.md` paso a paso. La env var `OZ_UPDATE_BASE_URL` debe setearse en `extraMetadata` de forge.config.js cuando el bucket esté listo (no en runtime, debe estar en el packaged binary).
- **Sin auto-rollback si una version rompe el boot** — anotado como C-18 en PLAN-MAESTRO (~4-6h sobre Etapa 3 ya cerrada). Para v1 aceptamos el riesgo.
- **Custom logger adapter es 1-way** — mensajes del updater siempre quedan como INFO en nuestro logger, sin distinción WARN/ERROR. update-electron-app no expone niveles, así que no hay forma cleaner.

## Validación

- 14/14 tests del nuevo `tests/auto-update.smoketest.js`:
  - skip cases: not-packaged, OZ_UPDATE_DISABLED, win32, linux, no-base-url, http-only, precedence order
  - happy path: config esperada, updateInterval override, logger adapter forward
  - error handling: lib throwing → return reason='lib-error' sin crash
  - integration: real require de `update-electron-app` carga + enum match esperado
- Boot del .app post-3d (sin OZ_UPDATE_BASE_URL set) → WARN log esperado: `auto-update skipped: OZ_UPDATE_BASE_URL not set`. NO crashea, NO regresiona ningún manager.
- Lint clean, check:loc verde.

## Consequences

**Positivas:**

- Pipeline de auto-update wireada y testeada. Apenas Jose: (1) pague Apple Dev → cierre 3b/3c → setear `OZ_UPDATE_BASE_URL` en build, los users reciben updates sin tocar más código.
- Skip guards son explícitos y loggeados — debugging futuro es trivial ("¿por qué no actualiza?" → grep WARN auto-update en log).
- Logger adapter unifica el output (todo va al mismo `oz-browser.log`).

**Negativas / TODO:**

- Etapa 3e (CI release workflow) tendrá que decidir entre `@electron-forge/publisher-s3` (S3 compatible, soporta R2 vía endpoint custom) vs subida manual con `wrangler` o AWS CLI. Pre-instalado: nada. Decisión al cierre de 3e.
- Sin Apple Dev, no podemos validar end-to-end. **El próximo "primer release" será el primer test runtime real.**
- Custom branded banner queda como C-XX upgrade futuro.

## Referencias

- [`browser/auto-update.js`](../../browser/auto-update.js) — el módulo.
- [`tests/auto-update.smoketest.js`](../../tests/auto-update.smoketest.js) — 14 tests.
- [`browser/main.js`](../../browser/main.js) — wire point en `Browser.init()`.
- [`docs/modules/auto-update.md`](../modules/auto-update.md) — uso + setup R2 paso a paso.
- ADR 0001 (electron-stack), ADR 0020 (packaging-strategy 3a).
- [docs/history/18-bloque-etapa-3d-resultado.md](../history/18-bloque-etapa-3d-resultado.md) — cierre de bloque.
