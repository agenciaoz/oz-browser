#!/usr/bin/env node
// OZ Browser — 500 LOC rule checker (ADR 0005).
//
// Cómo correr:
//   node scripts/check-loc.js
//   npm run check:loc
//
// Sale con código 0 si todos los archivos respetan el límite.
// Sale con código 1 + lista si alguno lo supera.
//
// Reglas:
//   - Cuenta líneas no-vacías y no-comentarios.
//   - Aplica a browser/**/*.js, scripts/**/*.js, tests/**/*.js, preload.js, index.js.
//   - Excluye node_modules/, .webpack/, out/, build/.

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const LIMIT = 500

const INCLUDE_DIRS = ['browser', 'scripts', 'tests', 'tools']
const ROOT_FILES = ['preload.js', 'index.js', 'forge.config.js']
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  '.webpack',
  'out',
  'build',
  '.git',
  'dist',
])

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIR_NAMES.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full)
  }
  return acc
}

function countMeaningfulLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8')
  let inBlockComment = false
  let count = 0
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim()
    if (line === '') continue

    if (inBlockComment) {
      if (line.includes('*/')) {
        inBlockComment = false
        const after = line.split('*/')[1] || ''
        if (after.trim() && !after.trim().startsWith('//')) count++
      }
      continue
    }

    if (line.startsWith('//')) continue
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true
      continue
    }

    count++
  }
  return count
}

function main() {
  const files = []
  for (const d of INCLUDE_DIRS) {
    walk(path.join(REPO_ROOT, d), files)
  }
  for (const f of ROOT_FILES) {
    const full = path.join(REPO_ROOT, f)
    if (fs.existsSync(full)) files.push(full)
  }

  const violators = []
  const all = []
  for (const f of files) {
    const loc = countMeaningfulLines(f)
    const rel = path.relative(REPO_ROOT, f)
    all.push({ file: rel, loc })
    if (loc > LIMIT) violators.push({ file: rel, loc })
  }

  all.sort((a, b) => b.loc - a.loc)

  if (process.env.OZ_LOC_VERBOSE) {
    console.log('All files (top 20 by LOC):')
    for (const f of all.slice(0, 20)) {
      console.log(`  ${String(f.loc).padStart(4)}  ${f.file}`)
    }
    console.log('')
  }

  if (violators.length === 0) {
    const max = all[0]
    console.log(
      `✓ check:loc passed — ${all.length} files scanned, max LOC = ${max ? max.loc : 0} (${max ? max.file : '-'}), limit ${LIMIT}.`,
    )
    process.exit(0)
  }

  console.error(`✗ check:loc FAILED — ${violators.length} file(s) over ${LIMIT} LOC:`)
  for (const v of violators) {
    console.error(`    ${String(v.loc).padStart(5)}  ${v.file}`)
  }
  console.error('')
  console.error('Per ADR 0005 (docs/architecture/0005-modular-500-loc-rule.md):')
  console.error('  Split the file into coherent submodules.')
  console.error('  Conventions: <feature>-manager.js, <feature>-handlers.js,')
  console.error('               <feature>-setup.js, <feature>-utils.js')
  process.exit(1)
}

main()
