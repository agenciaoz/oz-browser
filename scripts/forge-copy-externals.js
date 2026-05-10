// OZ Browser — afterCopy hook for electron-forge.
//
// Copies node_modules listed as externals in webpack.main.config.js into the
// packaged app, since the webpack plugin doesn't auto-copy externals.
//
// Triggered by `forge.config.js → packagerConfig.afterCopy`. Runs once per
// platform during `npm run package` / `npm run make`.
//
// Signature: (buildPath, electronVersion, platform, arch, callback) => void
// `buildPath` is the staged app/ directory inside electron-packager's tmp dir.

const fs = require('fs')
const path = require('path')

// External package names (must match webpack.main.config.js externals).
const EXTERNAL_PACKAGES = [
  '@napi-rs/keyring',
  // Platform-specific native binding for keyring. NOT a direct dep of OZ —
  // installed as optionalDependency by @napi-rs/keyring per-arch. We only
  // ship the one matching the current build target.
  // (mac arm64 build → keyring-darwin-arm64; mac x64 → keyring-darwin-x64;
  //  linux x64 → keyring-linux-x64-gnu; etc.)
]

function platformBindingName(platform, arch) {
  // Mapping convention used by @napi-rs/keyring v1.x.
  // See node_modules/@napi-rs/keyring/index.js → readNapiBinding() loader.
  if (platform === 'darwin' && arch === 'arm64') return '@napi-rs/keyring-darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return '@napi-rs/keyring-darwin-x64'
  if (platform === 'linux' && arch === 'x64') return '@napi-rs/keyring-linux-x64-gnu'
  if (platform === 'linux' && arch === 'arm64') return '@napi-rs/keyring-linux-arm64-gnu'
  if (platform === 'win32' && arch === 'x64') return '@napi-rs/keyring-win32-x64-msvc'
  return null
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d)
    else fs.copyFileSync(s, d)
  }
}

module.exports = function copyExternals(
  buildPath,
  electronVersion,
  platform,
  arch,
  callback,
) {
  try {
    // Resolve project root from this script's location.
    const projectRoot = path.resolve(__dirname, '..')
    const projectModules = path.join(projectRoot, 'node_modules')
    const targetModules = path.join(buildPath, 'node_modules')

    const toCopy = [...EXTERNAL_PACKAGES]
    const platformBinding = platformBindingName(platform, arch)
    if (platformBinding) toCopy.push(platformBinding)
    else {
      console.warn(
        `[forge-copy-externals] No native binding mapping for ${platform}/${arch}. ` +
          `@napi-rs/keyring will fail at runtime.`,
      )
    }

    fs.mkdirSync(targetModules, { recursive: true })

    for (const pkgName of toCopy) {
      const src = path.join(projectModules, pkgName)
      const dest = path.join(targetModules, pkgName)
      if (!fs.existsSync(src)) {
        console.warn(
          `[forge-copy-externals] Missing ${pkgName} in node_modules — skipping`,
        )
        continue
      }
      // Ensure parent dir exists for scoped packages (@napi-rs/...).
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      // Skip if already present (idempotent).
      if (fs.existsSync(dest)) continue
      copyDir(src, dest)

      console.log(`[forge-copy-externals] copied ${pkgName} → app/node_modules/`)
    }

    callback()
  } catch (err) {
    callback(err)
  }
}
