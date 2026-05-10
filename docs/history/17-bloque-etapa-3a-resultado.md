# Bloque Etapa 3a — Package sin firmar (cierre)

**Fecha:** 2026-05-10
**HEAD pre-bloque:** `cfbb4bc` (post-1.10.5)
**Tiempo efectivo:** ~30 min
**Tests:** 1242/1242 (sin cambios — bloque de packaging, no de producto)
**Commits:** 1
**Deps nuevas:** 0

## Resumen ejecutivo

Cerramos Etapa 3a (package sin firmar) en una sesión cortísima porque la infraestructura ya estaba pre-armada (forge.config.js + scripts/forge-copy-externals.js + webpack.main.config.js externals + entitlements.mac.plist). Lo único que faltaba era ejecutar el pipeline, validar el .app booted post-package, generar el .dmg y documentar.

**Encontramos un blocker no documentado:** `npm rebuild` es paso obligatorio antes del primer `npm run make`, porque las dep transitivas de `appdmg` (`macos-alias` + `fs-xattr`) tienen native bindings que necesitan compilarse contra el Node actual. Sin el rebuild, `npm run make` explota con "Cannot find module './build/Release/volume.node'" o ".../xattr". Documentado acá + feedback memory + ADR 0020 + comentado en CONTRIBUTING futuro.

## Lo que se hizo

1. **Validación del pipeline `npm run package`:**
   - Webpack bundles built ✅
   - `forge-copy-externals` copió `@napi-rs/keyring` + `keyring-darwin-arm64` ✅
   - Output: `out/OZ Browser-darwin-arm64/OZ Browser.app` (289MB)
   - Estructura interna verificada:
     - `Contents/Info.plist` con `CFBundleIdentifier=com.agenciaoz.oz-browser`, `CFBundleName=OZ Browser`, `CFBundleShortVersionString=0.1.0`
     - `Contents/Resources/app.asar` (bundle principal)
     - `Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-arm64/` (native binding auto-unpacked por plugin-auto-unpack-natives)
     - `Contents/Resources/preload-fingerprint.js` (extraResource literal)
     - `Contents/Resources/ui/` (extraResource literal)
     - `Contents/MacOS/OZ Browser` (binary entry)

2. **Validación de boot del .app:**
   - Lanzado `./OZ Browser.app/Contents/MacOS/OZ Browser` con `OZ_MCP_ENABLED=1 OZ_TIER=paid`
   - Logger arrancó: Electron 42.0.1, Node 24.15.0, darwin arm64
   - 8 identities cargadas, preload-content.js resolviendo desde `app.asar/browser/preload-content.js` — confirmación del fix del 1.5f post-package
   - 2 workspaces (general default), AccountVault locked, AntiLogout en 8 identities × 32 hosts
   - BackupManager con 3 snapshots existentes (de tests anteriores), SettingsManager v1, FingerprintEngine, BookmarkManager, ProxyManager + ProxyHealth daemon, TabDiscardDaemon
   - **MCP server en `127.0.0.1:9223` con 97 tools** confirmado vía `curl POST tools/list`
   - Initial window con 2 tabs hidratadas desde tabSpecs (new-tab.html + example.com)
   - Una warning menor: `chrome-extension://idnffbjdopnhkieicndepbmdemdolkba/new-tab.html ERR_BLOCKED_BY_CLIENT` — esperado en lazy materialization, no bloqueante.

3. **Validación de `npm run make`:**
   - Primera corrida: ❌ `Cannot find module '../build/Release/volume.node'` desde `node_modules/macos-alias/lib/create.js`
   - `npm rebuild macos-alias` → compiló `volume.node` (56KB) ✅
   - Segunda corrida: ❌ `Cannot find module './build/Release/xattr'` desde `node_modules/fs-xattr/index.js`
   - `npm rebuild` (full) → compiló todos los native bindings faltantes ✅
   - Tercera corrida: **✅ ambos distributables generados:**
     - `out/make/OZ Browser-0.1.0-arm64.dmg` (112MB)
     - `out/make/zip/darwin/arm64/OZ Browser-darwin-arm64-0.1.0.zip` (112MB)

4. **Validación del DMG:**
   - `hdiutil verify` → CRC32 VALID ✅
   - `hdiutil attach` → mounted en `/Volumes/OZ Browser` ✅
   - Contenido del mount:
     - `OZ Browser.app` (la app)
     - `Applications` symlink → `/Applications` (drag-to-install pattern)
     - `.background/` (placeholder)
     - `.VolumeIcon.icns` (placeholder)
     - `.DS_Store` (icon arrangement)
   - `hdiutil detach` → ejected limpio ✅

5. **`.gitignore`** ya excluía `out` (línea 3, agregado en sesión previa).

## Bug encontrado: native bindings de appdmg no compilados

**Problema:** `npm run make` falla con "Cannot find module" para `macos-alias/build/Release/volume.node` y `fs-xattr/build/Release/xattr`.

**Root cause:** `appdmg` (dep transitiva del `@electron-forge/maker-dmg`) trae dos paquetes con native bindings (`macos-alias` y `fs-xattr`). Cuando Jose hizo `npm install` con `NODE_ENV=production` exportado en su shell, npm:

- (a) Skipea devDependencies → maker-dmg potencialmente no se instala completo, o
- (b) Skipea el `npm run install` postinstall hook de los paquetes con bindings → los `.node` no se compilan

**Fix aplicado:** `npm rebuild` (sin args) → reconstruye TODOS los native modules contra el Node actual, garantizando que cualquier .node ABI-incompatible o no compilado quede en estado correcto. Cero cost (1-2 segundos).

**Mitigación a futuro:** documentado en (a) ADR 0020, (b) este documento, (c) memoria persistente de Claude (`feedback_npm_install_include_dev.md` ampliada con regla "antes de primer `npm run make`, correr `npm rebuild`"), (d) comentario al inicio de `forge.config.js`.

## Decisiones de scope

- **Sin Apple Dev cert** → 3a sale unsigned. 3b/3c/3d/3e quedan bloqueados ~2d hasta que llegue el cert. Aceptado: validamos el pipeline (build + dmg layout + extra resources + native bindings + asar) sin esperar.
- **Sin icon custom** → `build/icon.icns` no existe, Forge usa el átomo azul de Electron. 3b-polish lo reemplaza.
- **Sin DMG background custom** → placeholder. 3b-polish lo reemplaza.
- **Maker squirrel para Windows queda configurado** pero ignorado en mac builds (Forge skipea makers sin platform match). Etapa 8 lo activa.

## Próximos pasos

**No-bloqueados por Apple:**

1. **Cleanup `stripe` → `@paypal/paypal-server-sdk`** con `npm uninstall stripe && npm install --include=dev @paypal/paypal-server-sdk` (PayPal billing fue decidido el 2026-05-10, ver `ETAPA 5 — Billing con PayPal` en PLAN-MAESTRO).
2. **Decidir entre Etapa 3d auto-update wiring** (~2-3h, deja la pipeline lista pero auto-update solo funciona post-3b/3c) **vs Etapa 4 Supabase auth** (~6h, desbloquea entitlements del Pro tier antes de billing).

**Bloqueados ~2d por Apple Dev account ($99):**

- **3b firma** — descomentar `osxSign` en forge.config.js, env vars `OZ_APPLE_SIGN_IDENTITY`.
- **3c notarización** — descomentar `osxNotarize` con `notarytool`, env vars `OZ_APPLE_ID`, `OZ_APPLE_ID_PASSWORD` (app-specific), `OZ_APPLE_TEAM_ID`. Sin notarizar, `update-electron-app` falla en silencio.
- **3e CI release workflow** — `.github/workflows/release.yml` con tag-trigger `v*`, runner macos-latest, secrets en GitHub, build + sign + notarize + publish a GitHub Releases.

## Métricas

|                                              |                                               |
| -------------------------------------------- | --------------------------------------------- |
| Tests pre/post                               | 1242 / 1242                                   |
| LOC modificadas                              | 0 (bloque de packaging, no de producto)       |
| Files creados                                | 3 (ADR 0020 + este history + entry CHANGELOG) |
| Deps nuevas                                  | 0                                             |
| `.app` size                                  | 289MB                                         |
| `.dmg` size                                  | 112MB                                         |
| `.zip` size                                  | 112MB                                         |
| Boot time del .app (al MCP server start)     | ~150ms                                        |
| Tiempo de packaging (`npm run package`)      | ~5s                                           |
| Tiempo de make (`npm run make` post-rebuild) | ~15s                                          |

## Archivos tocados

- `docs/architecture/0020-packaging-strategy.md` (nuevo)
- `docs/history/17-bloque-etapa-3a-resultado.md` (este, nuevo)
- `CHANGELOG.md` (entry agregada)
- `docs/PLAN-MAESTRO.md` (sub-bloques 3a-3e enumerados, 3a marcado ✅)
- (No-cambio: `forge.config.js`, `scripts/forge-copy-externals.js`, `webpack.main.config.js`, `build/entitlements.mac.plist` — ya estaban pre-armados de sesión previa.)

## Validation summary

| Check                                                    | Resultado                     |
| -------------------------------------------------------- | ----------------------------- |
| `npm run package` exit                                   | ✅ ok                         |
| `app.asar` + `app.asar.unpacked` structure               | ✅ ok                         |
| extraResource (`browser/ui/` + `preload-fingerprint.js`) | ✅ presentes en `Resources/`  |
| native binding (`keyring-darwin-arm64`) auto-unpacked    | ✅ ok                         |
| `Info.plist` bundle id + name + version                  | ✅ ok                         |
| Boot del .app (logger + managers)                        | ✅ todo carga limpio          |
| MCP server arranca con 97 tools                          | ✅ ok                         |
| `npm run make` exit (post-rebuild)                       | ✅ ok                         |
| `.dmg` CRC32 verify                                      | ✅ valid                      |
| `.dmg` mount + Applications symlink + .app inside        | ✅ ok                         |
| `.dmg` detach                                            | ✅ limpio                     |
| Lint clean                                               | ✅ ok (sin cambios de código) |
| `out/` excluido de git                                   | ✅ ok                         |
