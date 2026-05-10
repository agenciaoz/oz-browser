const CopyWebpackPlugin = require('copy-webpack-plugin')

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
  externals: {
    '@napi-rs/keyring': 'commonjs2 @napi-rs/keyring',
    exceljs: 'commonjs2 exceljs',
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        require.resolve('electron-chrome-extensions/preload'),
        require.resolve('electron-chrome-web-store/preload'),
      ],
    }),
  ],
}
