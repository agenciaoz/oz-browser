// OZ Browser — electron-forge config.
//
// Etapa 3a (2026-05-10): packaging para macOS sin firmar.
// Etapa I (v1.6.0 2026-05-16): signing + notarize wired via env var guards.
// Etapa I-2 (v1.6.0 2026-05-16): publisher GitHub Releases wired para
// auto-updater (electron-updater).
// v2.0.0-alpha.23 (2026-05-23): notarytool keychain profile support
// (preferred over OZ_APPLE_ID_PASSWORD env var). See docs/keychain-profile.md.
//
// - appBundleId estable para que el OS recuerde permisos (Camera, Mic, etc.)
//   entre versiones, y para que electron-updater pueda matchear la app.
// - appCategoryType "productivity" para que aparezca bien en Finder/Spotlight.
// - icon path apunta a build/icon.icns si existe.
// - osxSign + osxNotarize: activos cuando hay identity + auth method válido.
//   Auth methods (probados en orden):
//     1. PREFERRED — Keychain profile: OZ_APPLE_SIGN_IDENTITY +
//        OZ_APPLE_KEYCHAIN_PROFILE (default 'oz-notarize'). Una sola vez se
//        guarda con `xcrun notarytool store-credentials oz-notarize`.
//     2. LEGACY — Env vars directas: OZ_APPLE_SIGN_IDENTITY + OZ_APPLE_ID +
//        OZ_APPLE_ID_PASSWORD + OZ_APPLE_TEAM_ID. Requiere exportar
//        app-specific password en cada publish.
//   Sin ninguno, build queda unsigned (dev workflow OK).
// - extraResource: 'browser/ui' (HTML/CSS/JS de la UI cargada en runtime via
//   getAppPath()) y los preloads bundled.
// - asar: true reduce I/O al boot y oculta el source de curiosos casuales.
// - plugin-auto-unpack-natives: descomprime *.node bindings fuera del .asar.
// - publishers: GitHub Releases provider para que electron-updater pueda
//   chequear updates desde agenciaoz/oz-browser. Requiere GH_TOKEN env var
//   con `repo` scope al correr `npm run publish`.

const path = require('path')
const fs = require('fs')

const ICON_PATH = path.join(__dirname, 'build', 'icon')
const ICON_EXISTS =
  fs.existsSync(ICON_PATH + '.icns') || fs.existsSync(ICON_PATH + '.ico')

// v2.0.0-alpha.23: two auth paths for notarytool, probed in order.
// Path 1 — Keychain profile (PREFERRED). `xcrun notarytool store-credentials`
// guarda Apple ID + app-specific password + team ID en Keychain bajo un
// profile name. forge.config solo necesita identity + profile name (no más
// app-specific password en env).
// Path 2 — Env vars directas (LEGACY). El comportamiento de v1.6.0–v2.0.0-alpha.22.
const HAS_SIGN_IDENTITY = Boolean(process.env.OZ_APPLE_SIGN_IDENTITY)
const NOTARIZE_VIA_PROFILE = Boolean(process.env.OZ_APPLE_KEYCHAIN_PROFILE)
const NOTARIZE_VIA_ENV = Boolean(
  process.env.OZ_APPLE_ID &&
  process.env.OZ_APPLE_ID_PASSWORD &&
  process.env.OZ_APPLE_TEAM_ID,
)
const APPLE_SIGN_READY = HAS_SIGN_IDENTITY && (NOTARIZE_VIA_PROFILE || NOTARIZE_VIA_ENV)

if (process.env.OZ_PACKAGING_VERBOSE === '1') {
  // forge.config.js corre en CLI context (electron-forge build pipeline),
  // console.log es legítimo para diagnostics aquí.
  // eslint-disable-next-line no-console
  console.log(
    `[forge.config] APPLE_SIGN_READY=${APPLE_SIGN_READY} ` +
      `(identity=${HAS_SIGN_IDENTITY}, ` +
      `profile=${NOTARIZE_VIA_PROFILE ? process.env.OZ_APPLE_KEYCHAIN_PROFILE : 'no'}, ` +
      `env=${NOTARIZE_VIA_ENV})`,
  )
}

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
      // v1.4.4: bundled preloads (with sibling deps inlined via webpack).
      // Sandboxed Electron preloads can't require() relative files, so we
      // bundle them in `scripts/bundle-preloads.js` (prestart + prepackage)
      // and ship the bundled output. Source files above are kept for
      // historical/test reasons but NOT used at runtime in v1.4.4+.
      'browser/.bundled',
      // v2.0.0-alpha.7: app-update.yml para electron-updater. Sin este file
      // el autoUpdater no sabe que provider usar (GitHub Releases) y
      // auto-updater-setup.js falla con "app-update.yml not found".
      // electron-forge NO lo genera automáticamente — lo curamos manual
      // en build/app-update.yml y lo copiamos a Resources/ via extraResource.
      'build/app-update.yml',
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
    // v1.6.0: signing + notarize activos cuando APPLE_SIGN_READY = true (todas
    // las 4 env vars seteadas). Sin las vars, build queda unsigned (dev OK).
    ...(APPLE_SIGN_READY
      ? {
          osxSign: {
            identity: process.env.OZ_APPLE_SIGN_IDENTITY, // "Developer ID Application: Jose Coronel (TEAMID)"
            'hardened-runtime': true,
            'gatekeeper-assess': false,
            entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist'),
            'entitlements-inherit': path.join(
              __dirname,
              'build',
              'entitlements.mac.plist',
            ),
          },
          // v2.0.0-alpha.23: keychain profile path (preferred) o env var path
          // (legacy). Profile evita pegar app-specific password en cada publish.
          osxNotarize: NOTARIZE_VIA_PROFILE
            ? {
                tool: 'notarytool',
                keychainProfile: process.env.OZ_APPLE_KEYCHAIN_PROFILE,
              }
            : {
                tool: 'notarytool',
                appleId: process.env.OZ_APPLE_ID,
                appleIdPassword: process.env.OZ_APPLE_ID_PASSWORD,
                teamId: process.env.OZ_APPLE_TEAM_ID,
              },
        }
      : {}),
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
  // v1.6.0: GitHub Releases publisher para electron-updater.
  // `npm run publish` sube los DMG/zip artifacts al release draft del tag
  // actual (ej. v1.6.0). Requiere `GH_TOKEN` env var con scope `repo` (o
  // `public_repo` si el repo fuera público). Para repos privados como
  // agenciaoz/oz-browser, scope `repo` es necesario.
  //
  // El client (electron-updater) lee desde la misma URL — `latest-mac.yml`
  // generado automáticamente por el publisher contiene hashes + URL al
  // .zip/.dmg para que el cliente valide signature antes de instalar.
  //
  // draft: true asegura que el release queda como draft en GitHub — Jose lo
  // promueve manualmente a "published" cuando esté listo. Esto evita que un
  // `npm run publish` accidental triggee updates a usuarios prematuramente.
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'agenciaoz',
          name: 'oz-browser',
        },
        prerelease: false,
        draft: true,
      },
    },
  ],
}
