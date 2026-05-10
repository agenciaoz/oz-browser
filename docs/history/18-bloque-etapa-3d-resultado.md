# Bloque Etapa 3d — Auto-update wiring (cierre)

**Fecha:** 2026-05-10
**HEAD pre-bloque:** `90ec174` (post cleanup stripe→paypal)
**Tiempo efectivo:** ~1.5h
**Tests:** 1242 → 1256 (+14)
**Commits:** 1
**Deps nuevas:** 0

## Resumen ejecutivo

Wireamos `update-electron-app` (lib oficial del Electron team encima de `electron-updater`) en el main process de OZ Browser para que cada instancia desplegada chequee y aplique updates automáticamente. Bloque code-only — runtime real bloqueado por Etapas 3b (firma) + 3c (notarización), pero el wiring queda completo y validado por tests offline (14/14).

**Decisión clave de canal de distribución:** el repo `agenciaoz/oz-browser` es privado, así que el default `update.electronjs.org` (que requiere repo público) no aplica. **Elegimos Cloudflare R2 + `UpdateSourceType.StaticStorage`** — free tier 10GB sobra para cualquier scale realista de OZ; sin lock-in (S3-compatible API). Setup operacional del bucket queda para Jose (~30 min) cuando llegue Etapa 3e o manualmente al primer release.

**UI del prompt:** native OS dialog (default `notifyUser: true` del lib) sobre custom topbar banner. ~5 LOC vs ~80 LOC, look estándar Electron, suficiente para v1. Branded banner anotado como C-XX upgrade post-launch.

## Lo que se hizo

1. **`browser/auto-update.js`** (~150 LOC) — wrapper sobre `updateElectronApp()` con:
   - 5 skip conditions explícitas (`!isPackaged`, `OZ_UPDATE_DISABLED=1`, `platform !== 'darwin'`, `!OZ_UPDATE_BASE_URL`, `!HTTPS`) — cada una con WARN/ERROR claro
   - Logger adapter `{ log: fn }` → `logger.info('auto-update', ...)` para que mensajes del updater queden en `~/Library/Logs/OZ Browser/oz-browser.log`
   - Try/catch interno — el browser nunca crashea por update-electron-app
   - Defaults per PLAN-MAESTRO: `updateInterval: '1 hour'`, `notifyUser: true`
   - `UpdateSourceType.StaticStorage` (numeric `1` hardcoded — tests verifican enum match en require real)
   - Retorna `{ configured, reason? }` para que el caller (main.js) o tests sepan qué pasó

2. **`tests/auto-update.smoketest.js`** (~250 LOC, 14/14):
   - **Skip cases (8):** throws if logger missing, not-packaged, OZ_UPDATE_DISABLED, win32, linux, no-base-url, http-only, precedence (not-packaged checked first)
   - **Happy path (3):** config esperada (StaticStorage type=1, notifyUser=true, updateInterval='1 hour'), updateInterval override, logger adapter forward (multi-arg → INFO joined)
   - **Error handling (2):** lib throwing → reason 'lib-error' sin crash; injected fn no genera require error
   - **Integration (1):** real require de `update-electron-app` → enum match esperado (StaticStorage=1, ElectronPublicUpdateService=0)

3. **Wire en `browser/main.js`:**
   - Import: `const { setupAutoUpdate } = require('./auto-update')`
   - Llamada en `Browser.init()` post-todos-los-managers, justo antes de `resolveReady()`. Comentario explicando blocked-by-3b/3c y que el WARN log siempre es útil.

4. **ADR 0021** (`docs/architecture/0021-auto-update-strategy.md`) — documentación de la decisión de canal R2, alternativas consideradas (público, GH privado con custom token, electron-updater directo, postpone, banner custom), trade-offs aceptados, validación, consequences.

5. **`docs/modules/auto-update.md`** — documentación del módulo per ADR 0005 + PROJECT-RULES A3 (cada módulo tiene su .md hermano). Incluye:
   - API completa con todos los params
   - **Setup operacional Cloudflare R2 paso a paso** (7 steps) que Jose puede seguir cuando llegue 3e
   - Estructura esperada del bucket (`darwin/{arm64,x64}/RELEASES.json + .zip`)
   - Skip conditions matrix
   - Runtime behavior (qué ve el user)
   - Logging examples
   - Gotchas (no probar en dev, HTTPS only, app cerrada no checa)

6. **CHANGELOG entry** — one-liner del bloque.

7. **PLAN-MAESTRO update** — Etapa 3 table actualizada: 3d ✅. Notas sobre channel R2, runtime blocked-by-3b/3c, 3e ahora opcionalmente requiere `publisher-s3` para R2.

8. **README.md** — Etapa 3 status row actualizada.

## Decisiones de scope

- **Cloudflare R2 sobre repo público** — el moat técnico (vault crypto, antidetect, MCP) vale más que el ahorro de 30 min de setup. Decisión confirmada por Jose vía AskUserQuestion.
- **Native dialog sobre custom banner** — speed-to-ship + UX standard. Branded banner queda como C-XX. Decisión confirmada por Jose vía AskUserQuestion.
- **Bucket setup queda para Jose post-Apple-Dev** — el wiring funciona sin la URL real (skip con WARN claro). Setear `OZ_UPDATE_BASE_URL` cuando el bucket esté listo.
- **No instalamos `@electron-forge/publisher-s3` ahora** — esa decisión es de Etapa 3e (CI release workflow). Para 3d solo wireamos el cliente.
- **Tests offline only** — sin Electron real, sin red. Mockean app/env/platform/lib. Runtime end-to-end espera 3b/3c.

## Bugs / gotchas encontrados

Ninguno. Bloque limpio — el lib es estable, su API es minimal, y los tests offline cubrieron todas las skip conditions sin sorpresas.

## Próximos pasos

**Bloqueados ~2d por Apple Dev account ($99):**

- **3b firma** — descomentar osxSign en forge.config.js, instalar Developer ID Application cert.
- **3c notarización** — descomentar osxNotarize, env vars OZ*APPLE*\*.

**Después de 3b/3c (no-bloqueado adicional):**

- **Setup R2 manual** (~30 min) — Jose sigue los 7 pasos en `docs/modules/auto-update.md`. Crear bucket, generar token, habilitar acceso público, custom domain opcional.
- **Setear `OZ_UPDATE_BASE_URL`** en `extraMetadata` de forge.config.js (para que quede en el packaged binary).
- **Primer release manual:** `npm run make` → upload del .dmg + RELEASES.json al bucket → tag git `v0.1.1` → instalar en una Mac → validar que actualiza desde 0.1.0.
- **3e CI release workflow** — `.github/workflows/release.yml` con tag-trigger v*, build firmado en macos-latest, secrets `OZ*APPLE\*\*`+`R2\_\*`, upload via `@electron-forge/publisher-s3`(con endpoint custom para R2) o`wrangler r2 object put` directo.

**Próximo bloque no-bloqueado:**

- **Etapa 4 Supabase auth** (~6h) — desbloquea entitlements del Pro tier antes de billing.

## Métricas

|                   |                                                        |
| ----------------- | ------------------------------------------------------ |
| Tests pre/post    | 1242 / 1256 (+14)                                      |
| LOC nuevos código | ~150 (auto-update.js)                                  |
| LOC tests         | ~250 (auto-update.smoketest.js)                        |
| Files nuevos      | 4 (auto-update.js + smoketest + ADR 0021 + module .md) |
| Files modificados | 4 (main.js + CHANGELOG + PLAN-MAESTRO + README)        |
| Deps npm nuevas   | 0 (`update-electron-app@^3.2.0` ya pre-instalada)      |

## Validation summary

| Check                                              | Resultado                   |
| -------------------------------------------------- | --------------------------- |
| 14 tests del nuevo smoke test                      | ✅                          |
| 1256 tests totales del proyecto                    | ✅                          |
| Lint clean (eslint + prettier)                     | ✅                          |
| check:loc verde (max 449/500)                      | ✅                          |
| `update-electron-app` real require carga           | ✅                          |
| Enum `StaticStorage = 1` match con hardcode        | ✅                          |
| Wire en main.js — boot del .app no crashea sin URL | ✅ esperado (skip con WARN) |
| Runtime end-to-end (download + restart + apply)    | ⏳ bloqueado por 3b/3c      |
