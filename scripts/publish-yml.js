#!/usr/bin/env node
// OZ Browser — postpublish step that generates latest-mac.yml from the
// zip that electron-forge just uploaded and attaches it to the GitHub
// release.
//
// Why this exists:
//   electron-forge's publisher-github (a.k.a. forge's flavor of
//   electron-builder's publish step) uploads DMG + ZIP artifacts to a
//   GitHub release but does NOT generate the `latest-mac.yml` manifest
//   that electron-updater needs to detect updates. Without that file,
//   the client gets a 404 from `releases/latest/download/latest-mac.yml`
//   and the auto-updater never fires.
//
// What it does:
//   1. Read version from package.json.
//   2. Locate the arm64 ZIP in out/make/zip/darwin/arm64/.
//   3. Compute SHA-512 (base64) + size — same format electron-updater
//      expects (matches what electron-builder normally writes).
//   4. Generate latest-mac.yml at out/latest-mac.yml.
//   5. Upload it to release tag `v<version>` via gh CLI (--clobber so
//      re-runs replace existing yml).
//
// Wired to `postpublish` in package.json so `npm run publish` runs it
// automatically after electron-forge uploads the zip/dmg.
//
// Requirements:
//   - `gh` CLI logged in (gh auth status — `repo` scope minimum)
//   - The release must already exist (forge publisher creates it as
//     draft before this script runs — postpublish ordering guarantees
//     this)
//
// Skips quietly if no zip found for the current version — covers
// scenarios where someone ran `npm run package` instead of publish.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const PKG = require(path.join(ROOT, 'package.json'))
const VERSION = PKG.version
const TAG = `v${VERSION}`

const ZIP_DIR = path.join(ROOT, 'out', 'make', 'zip', 'darwin', 'arm64')
const ZIP_NAME = `OZ Browser-darwin-arm64-${VERSION}.zip`
const ZIP_PATH = path.join(ZIP_DIR, ZIP_NAME)

const OUT_YML = path.join(ROOT, 'out', 'latest-mac.yml')

function log(msg) {
  console.log(`[publish-yml] ${msg}`)
}

function fatal(msg) {
  console.error(`[publish-yml] ERROR: ${msg}`)
  process.exit(1)
}

function main() {
  log(`version=${VERSION} tag=${TAG}`)

  if (!fs.existsSync(ZIP_PATH)) {
    log(`zip not found at ${ZIP_PATH} — skipping (postpackage only?)`)
    return
  }

  // SHA-512 base64 — electron-updater format.
  const buf = fs.readFileSync(ZIP_PATH)
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64')
  const size = buf.byteLength
  const releaseDate = new Date().toISOString()

  const yml =
    `version: ${VERSION}\n` +
    `files:\n` +
    `  - url: ${ZIP_NAME.replace(/ /g, '.')}\n` +
    `    sha512: ${sha512}\n` +
    `    size: ${size}\n` +
    `path: ${ZIP_NAME.replace(/ /g, '.')}\n` +
    `sha512: ${sha512}\n` +
    `releaseDate: '${releaseDate}'\n`

  fs.writeFileSync(OUT_YML, yml, 'utf8')
  log(`wrote ${OUT_YML} (size=${size}, sha512=${sha512.slice(0, 16)}…)`)

  // Sanity: confirm the release exists. Forge publisher creates it as
  // draft pre-postpublish; if missing, surface it instead of cryptic
  // 'gh release upload' error.
  try {
    execSync(`gh release view ${TAG} --json tagName -q .tagName`, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    fatal(
      `release ${TAG} not found on GitHub. ` +
        `Run \`npm run publish\` first (this script runs as postpublish).`,
    )
  }

  // Upload. --clobber replaces existing yml from prior re-runs.
  log(`uploading to release ${TAG}…`)
  try {
    execSync(`gh release upload ${TAG} "${OUT_YML}" --clobber`, {
      cwd: ROOT,
      stdio: 'inherit',
    })
  } catch (err) {
    fatal(`gh release upload failed: ${err.message}`)
  }

  log(`✅ latest-mac.yml attached to ${TAG}`)
  log(
    `   verify: https://github.com/agenciaoz/oz-browser/releases/download/${TAG}/latest-mac.yml`,
  )
}

main()
