// OZ Browser — electron-forge config.
//
// Etapa 3a (2026-05-10): packaging para macOS sin firmar.
// - appBundleId estable para que el OS recuerde permisos (Camera, Mic, etc.)
//   entre versiones, y para que update-electron-app pueda matchear la app.
// - appCategoryType "productivity" para que aparezca bien en Finder/Spotlight.
// - icon path apunta a build/icon.icns si existe (placeholder por ahora; el
//   .icns real lo agregamos en 3b-polish con el branding final).
// - osxSign: undefined → maker-dmg empaqueta SIN firmar para testing local.
//   Etapa 3b lo activará con cert "Developer ID Application: ...".
// - extraResource: 'browser/ui' (HTML/CSS/JS de la UI cargada en runtime via
//   getAppPath()) y 'preload-fingerprint.js' (cargado per-session via
//   registerPreloadScript desde main, NO bundleado por webpack).
// - asar: true reduce I/O al boot y oculta el source de curiosos casuales
//   (NO es seguridad real, pero es estándar Electron).
// - plugin-auto-unpack-natives: descomprime *.node bindings (@napi-rs/keyring,
//   exceljs xlsx parser) fuera del .asar para que dlopen funcione.
//
// Notas para 3b/3c (cuando Apple Dev esté activado):
// - osxSign: { identity: 'Developer ID Application: <Name> (<TeamID>)' }
// - osxNotarize: { tool: 'notarytool', appleId, appleIdPassword, teamId }
// - Ambos vienen de env vars (.env.local, NO commiteado — ver .gitignore).

const path = require('path')
const fs = require('fs')

// Icon es opcional en 3a — si no existe build/icon.icns, packager usa el
// default de Electron. 3b-polish agrega el .icns final.
const ICON_PATH = path.join(__dirname, 'build', 'icon')
const ICON_EXISTS =
  fs.existsSync(ICON_PATH + '.icns') || fs.existsSync(ICON_PATH + '.ico')

module.exports = {
  packagerConfig: {
    name: 'OZ Browser',
    appBundleId: 'com.agenciaoz.oz-browser',
    appCategoryType: 'public.app-category.productivity',
    ...(ICON_EXISTS ? { icon: ICON_PATH } : {}),
    asar: true,
    extraResource: [
      'browser/ui',
      'browser/preload-fingerprint.js',
      'browser/preload-hud.js',
    ],
    // afterCopy hook: el plugin-webpack de Forge bundlea index.js + sus deps
    // pero NO copia node_modules de los externals al bundle. webpack.main.config
    // marca @napi-rs/keyring como external (commonjs2 require) porque sus
    // native bindings (.node) rompen cuando webpack altera __filename. Sin
    // este hook, el require('@napi-rs/keyring') del runtime explota con
    // "Cannot find module".
    //
    // Copiamos:
    //  - @napi-rs/keyring (JS wrapper)
    //  - @napi-rs/keyring-darwin-arm64 (binding nativo, optionalDep que NO
    //    está en package.json deps por eso prune lo borra)
    //
    // exceljs lo dejamos bundleado por webpack (pure JS, sin .node).
    afterCopy: [require('./scripts/forge-copy-externals.js')],
    // Etapa 3b: descomentar cuando tengamos el cert de Apple instalado.
    // osxSign: {
    //   identity: process.env.OZ_APPLE_SIGN_IDENTITY,  // "Developer ID Application: Jose Coronel (TEAMID)"
    //   'hardened-runtime': true,
    //   'gatekeeper-assess': false,
    //   entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist'),
    //   'entitlements-inherit': path.join(__dirname, 'build', 'entitlements.mac.plist'),
    // },
    // Etapa 3c: descomentar cuando tengamos app-specific password de Apple ID.
    // osxNotarize: {
    //   tool: 'notarytool',
    //   appleId: process.env.OZ_APPLE_ID,
    //   appleIdPassword: process.env.OZ_APPLE_ID_PASSWORD,
    //   teamId: process.env.OZ_APPLE_TEAM_ID,
    // },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        // overwrite: re-genera el DMG si ya existe (útil en CI + dev iteration).
        overwrite: true,
        // background y icon del DMG window quedan placeholder por ahora;
        // 3b-polish los reemplazará con branding final.
      },
    },
    {
      // Windows está en Etapa 8, pero dejamos el maker config-ready.
      // En macOS el make ignora makers sin platform match — no falla.
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'OZBrowser', // sin espacios — Squirrel rompe con espacios en el name
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              name: 'browser',
              preload: {
                js: './preload.js',
              },
            },
          ],
        },
        devServer: {
          client: {
            overlay: false,
          },
        },
      },
    },
  ].filter(Boolean),
  // publishers: definidos en Etapa 3d (update-electron-app + GitHub Releases).
}
