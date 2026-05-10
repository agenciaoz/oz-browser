# ADR 0020 — Packaging strategy (Etapa 3a — macOS unsigned)

**Fecha:** 2026-05-10
**Status:** Accepted
**Bloque:** Etapa 3a (post-Sub-Etapa 1A CORE)

## Contexto

OZ Browser cerró Sub-Etapa 1A CORE el 2026-05-10 (1242 tests, HEAD `cfbb4bc`). Necesitamos pasar de "se corre con `npm start` desde el repo" a "binary distribuible que el usuario abre desde Applications".

Etapa 3 completa tiene 5 sub-fases:

| Sub-bloque                     | Qué hace                                                      | Bloqueado por                        |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------ |
| **3a** Package + .dmg unsigned | Empaquetar .app + generar .dmg para drag-to-install local     | —                                    |
| **3b** Code sign               | Firmar .app con Developer ID Application cert                 | Apple Dev account ($99)              |
| **3c** Notarization            | Subir .app a Apple para notarización + stapler                | 3b                                   |
| **3d** Auto-update wiring      | `update-electron-app` + GitHub Releases como CDN              | 3c (sin notarizar falla en silencio) |
| **3e** CI release workflow     | `.github/workflows/release.yml` con tag-trigger build firmado | 3b/3c (secrets en GitHub)            |

Esta ADR cubre **3a** (lo que cierra hoy). 3b-3e quedan documentadas como TODO con notas claras de qué descomentar en cada lugar.

## Decisión

**Stack:** electron-forge (ya instalado, decidido en Bloque 1.3-DX). NO migrar a electron-builder.

**Makers en `forge.config.js`:**

- `@electron-forge/maker-dmg` (darwin) — genera `.dmg` con drag-to-Applications layout estándar.
- `@electron-forge/maker-zip` (darwin + win32) — genera `.zip` por si user prefiere extraer manual.
- `@electron-forge/maker-squirrel` (win32, ignored en mac) — placeholder para Etapa 8 Windows.

**Plugins:**

- `@electron-forge/plugin-webpack` — bundlea `index.js` + dependencias internas a `app.asar/.webpack/main`.
- `@electron-forge/plugin-auto-unpack-natives` — auto-extrae cualquier `.node` binding a `app.asar.unpacked/` para que `dlopen` funcione.

**Configuración crítica de packagerConfig:**

- `appBundleId: 'com.agenciaoz.oz-browser'` — identificador estable. macOS recuerda permisos (Camera, Mic, Notification) entre versiones por bundleId. **No cambiar** post-distribución sin migration plan.
- `appCategoryType: 'public.app-category.productivity'` — Finder/Spotlight categorization.
- `asar: true` — reduce I/O al boot, oculta source de curiosos casuales. NO es seguridad real.
- `extraResource: ['browser/ui', 'browser/preload-fingerprint.js']` — copiados a `Contents/Resources/` literal. `browser/ui/` es la HTML/CSS/JS del WebUI (cargado via `app.getAppPath()` en runtime). `preload-fingerprint.js` se registra per-session via `session.registerPreloadScript` desde main, NO bundleado por webpack.
- `afterCopy: [require('./scripts/forge-copy-externals.js')]` — hook custom que copia los webpack externals al packaged app/node_modules.

**Webpack externals (`webpack.main.config.js`):**

```js
externals: {
  '@napi-rs/keyring': 'commonjs2 @napi-rs/keyring',
}
```

`@napi-rs/keyring` queda external porque sus `.node` bindings se rompen cuando webpack altera `__filename` (su loader interno usa `createRequire(__filename)` que resuelve relativo al .node binding). Si lo bundleamos, en runtime explota con "Cannot find module".

`exceljs` SÍ se bundlea (es pure JS, evita copiar 30 transitive deps al packaged app).

**`scripts/forge-copy-externals.js` (afterCopy hook):** copia `@napi-rs/keyring` JS wrapper + `@napi-rs/keyring-darwin-arm64` (platform-specific binding, optionalDependency que `npm prune` borra) al packaged `app/node_modules/`. El JS wrapper queda dentro de `app.asar`, el binding se auto-unpacks via plugin-auto-unpack-natives a `app.asar.unpacked/`.

**Sin firmar:** `osxSign` y `osxNotarize` están **comentados** en forge.config.js con notas explícitas de qué descomentar para 3b/3c. Build sale unsigned → Gatekeeper bloqueará en macOS Catalina+ con "OZ Browser can't be opened because Apple cannot check it for malicious software". Workaround para testing local:

```sh
xattr -d com.apple.quarantine "/Applications/OZ Browser.app"
# o: System Settings → Privacy & Security → "Open anyway"
```

**Aceptamos esta UX rota** durante 3a porque (a) es solo para validación interna, (b) compra del Apple Dev account está pendiente, (c) el resto del pipeline (build + dmg layout + extra resources + native bindings + asar packing) lo validamos sin el blocker del cert.

## Alternativas consideradas

**electron-builder en vez de electron-forge** — más maduro, mejor docs de auto-update, pero requeriría re-aprender todo el build pipeline a esta altura del proyecto. Forge ya está wireado, los makers funcionan, no hay razón técnica para migrar.

**Bundleear `@napi-rs/keyring` con webpack** — descartado: probado, falla con "Cannot find module" porque createRequire resuelve relativo a un path inexistente post-bundle. La solución limpia es el external + afterCopy hook.

**No usar asar** — descartado: penaliza I/O al boot, expone source plana, no aporta nada en development workflow (start sigue corriendo desde el repo sin asar).

**Maker zip-only sin dmg** — descartado: el DMG con `Applications` symlink es la UX estándar de macOS para drag-to-install. Sin dmg, el user tendría que extraer manualmente el zip y mover la .app — fricción innecesaria.

## Trade-offs aceptados

- **3a sin firmar = Gatekeeper bloquea** — UX rota para usuarios externos. **Mitigación:** 3b/3c cierran este gap apenas llegue Apple Dev account (~2 días desde solicitud).
- **`npm rebuild` requerido pre-primer-make** — `appdmg` (dep transitiva del maker-dmg) trae `macos-alias` + `fs-xattr`, ambos con native bindings que necesitan compilarse contra el Node actual. Si `npm install` no compila por ABI mismatch o por `NODE_ENV=production` skipeando devDeps, el make explota con "Cannot find module './build/Release/volume.node'". **Mitigación:** documentado en docs/history/17 + feedback memory persistente.
- **Sin icon custom (`build/icon.icns` ausente)** — Forge usa el icon default de Electron (azul con átomo). 3b-polish reemplaza con el branding final OZ.
- **Sin DMG background custom** — el `.background/` que aparece en el DMG montado es el placeholder por defecto. 3b-polish lo reemplaza.

## Validación

- `npm run package` → `out/OZ Browser-darwin-arm64/OZ Browser.app` (289MB) ✅
- `npm rebuild` → reconstruye native bindings de macos-alias + fs-xattr ✅
- `npm run make` → `out/make/OZ Browser-0.1.0-arm64.dmg` (112MB) + `out/make/zip/darwin/arm64/OZ Browser-darwin-arm64-0.1.0.zip` (112MB) ✅
- `hdiutil verify` del DMG → CRC32 valid ✅
- DMG mount → contiene `OZ Browser.app` + `Applications` symlink + `.background/` + `.VolumeIcon.icns` ✅
- Boot del .app via `Contents/MacOS/OZ Browser` con `OZ_MCP_ENABLED=1`:
  - Logger: Electron 42.0.1, Node 24.15.0, darwin arm64
  - 8 identities cargadas, preload-content.js resolviendo desde `app.asar/browser/preload-content.js` (fix del 1.5f confirmado funcionando post-package)
  - 2 workspaces, AccountVault locked (lazy unlock), AntiLogout en 8 identities × 32 hosts
  - BackupManager (3 snapshots), SettingsManager v1, FingerprintEngine, BookmarkManager
  - TabDiscardDaemon + ProxyHealth daemon arrancados
  - MCP server en `127.0.0.1:9223` con **97 tools**, responde a `tools/list` y `tools/call`
  - Initial window con 2 tabs (new-tab + example.com)

## Consequences

**Positivas:**

- Pipeline reproducible local (`npm run package` + `npm run make` siempre producen el mismo output).
- Native bindings (`@napi-rs/keyring`, `macos-alias`, `fs-xattr`) cubiertos sin ajustes de código del producto.
- Path despejado para 3b/3c/3d/3e — los TODO están comentados en forge.config.js con env vars y comandos exactos.

**Negativas / TODO:**

- Sin firmar, los .dmg no son distribuibles a usuarios externos. Bloquea launch público hasta 3b/3c.
- `npm rebuild` es manual — si Jose hace `git clone` fresh en otra máquina, va a chocar el mismo error. Documentado en CONTRIBUTING + feedback memory.
- Icon + DMG background son placeholder. 3b-polish lo cubre.

## Referencias

- [`forge.config.js`](../../forge.config.js) — config principal, con TODOs de 3b/3c/3d/3e comentados.
- [`scripts/forge-copy-externals.js`](../../scripts/forge-copy-externals.js) — afterCopy hook.
- [`webpack.main.config.js`](../../webpack.main.config.js) — externals config.
- [`build/entitlements.mac.plist`](../../build/entitlements.mac.plist) — listo para 3b.
- ADR 0001 (electron-stack), ADR 0006 (apple-silicon-target), ADR 0008 (vault-encryption — afecta forge-copy-externals).
- [docs/history/17-bloque-etapa-3a-resultado.md](../history/17-bloque-etapa-3a-resultado.md) — cierre de bloque.
