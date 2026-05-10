const CopyWebpackPlugin = require('copy-webpack-plugin')
const webpack = require('webpack')
const path = require('path')

// B-2: load .env BEFORE webpack reads process.env. Both `npm start` (dev via
// electron-forge) and `npm run package/make` (prod build) hit this config at
// build time, so dotenv loads in both flows. In dev the values come from
// `oz-browser/.env` (gitignored); in CI they come from GitHub Actions
// secrets exported as env vars.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true })

// Allow-list of env keys that are SAFE to embed into the .app bundle as
// build-time constants via DefinePlugin. Anything not on this list (e.g.
// SUPABASE_SECRET_KEY, OZ_DROPBOX_APP_SECRET, OZ_APPLE_*) NEVER appears in
// the compiled output — not in source maps, not in asar, nowhere.
const PUBLIC_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'OZ_DROPBOX_APP_KEY',
  'OZ_UPDATE_BASE_URL',
]
const defineEntries = {}
for (const key of PUBLIC_ENV_KEYS) {
  defineEntries[`process.env.${key}`] = JSON.stringify(process.env[key] || '')
}

module.exports = {
  entry: './index.js',
  module: {
    rules: [],
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
  // 1.5f fix: native modules with platform-specific .node bindings (loaded via
  // createRequire(__filename)) break when webpack bundles them — __filename
  // becomes .webpack/main/index.js and the relative resolver can't find the
  // native binding under node_modules/@napi-rs/<scope>-<platform>-<arch>/.
  // Marking them external keeps a regular require() in the bundle, which
  // resolves against node_modules at runtime as expected.
  //
  // Etapa 3a (2026-05-10): exceljs SÍ se bundlea (es pure JS, sin .node).
  // Removerlo de externals nos saca el require() del bundle y evita tener que
  // copiar exceljs+sus 30 transitive deps al packaged app/node_modules.
  // Solo @napi-rs/keyring queda external (tiene .node binding nativo) y se
  // copia explícitamente vía scripts/forge-copy-externals.js.
  externals: {
    '@napi-rs/keyring': 'commonjs2 @napi-rs/keyring',
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        require.resolve('electron-chrome-extensions/preload'),
        require.resolve('electron-chrome-web-store/preload'),
      ],
    }),
    // B-2: inject the publishable env vars as compile-time constants. Secret
    // keys (SECRET_KEY, APP_SECRET, APPLE_*) intentionally stay out of this
    // list and remain process.env reads at runtime (so they only resolve
    // when scripts/admin tools explicitly run with .env loaded).
    new webpack.DefinePlugin(defineEntries),
  ],
}
