// OZ Browser — Headless CLI parsing (V3-D, scraping/agent-control).
//
// Parsea los flags de invocación headless:
//   oz --headless --identity <id> --recipe <ruta.json> [--proxy <id>]
//                 [--tab <tabId>] [--out <ruta.json>]
//
// Pieza PURA (sin Electron/fs): solo interpreta argv. El bootstrap (main) usa
// `isHeadlessInvocation` para decidir si saltea la UI, y `parseHeadlessArgs`
// para sacar la config. La carga del recipe y la ejecución viven en
// headless-runner.js.
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

const FLAG = '--headless'

// flag → clave de salida. Flags con valor (toman el siguiente token o =valor).
const VALUE_FLAGS = {
  '--identity': 'identityId',
  '--recipe': 'recipePath',
  '--proxy': 'proxyId',
  '--tab': 'tabId',
  '--out': 'outPath',
}

/**
 * ¿Esta invocación pide modo headless? Busca `--headless` en argv.
 *
 * @param {string[]} argv  típicamente process.argv (o .slice(n)).
 * @returns {boolean}
 */
function isHeadlessInvocation(argv) {
  return Array.isArray(argv) && argv.indexOf(FLAG) >= 0
}

/**
 * Parsea los flags headless desde argv. Tolera `--flag valor` y `--flag=valor`.
 * Reporta requeridos faltantes en `errors` (no lanza).
 *
 * @param {string[]} argv
 * @returns {{headless:boolean, identityId:(string|null), recipePath:(string|null), proxyId:(string|null), tabId:(string|null), outPath:(string|null), errors:string[]}}
 */
function parseHeadlessArgs(argv) {
  const out = {
    headless: false,
    identityId: null,
    recipePath: null,
    proxyId: null,
    tabId: null,
    outPath: null,
    errors: [],
  }
  if (!Array.isArray(argv)) return out
  out.headless = argv.indexOf(FLAG) >= 0

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (typeof tok !== 'string') continue
    const eq = tok.indexOf('=')
    const name = eq >= 0 ? tok.slice(0, eq) : tok
    const key = VALUE_FLAGS[name]
    if (!key) continue
    let value
    if (eq >= 0) {
      value = tok.slice(eq + 1)
    } else {
      value = argv[i + 1]
      // El valor no puede ser otro flag.
      if (typeof value !== 'string' || value.startsWith('--')) value = undefined
      else i++
    }
    if (value == null || value === '') {
      out.errors.push(`flag ${name} requires a value`)
      continue
    }
    out[key] = value
  }

  if (out.headless) {
    if (!out.identityId) out.errors.push('--identity is required in headless mode')
    if (!out.recipePath) out.errors.push('--recipe is required in headless mode')
  }
  return out
}

/** Texto de uso para imprimir ante args inválidos. */
function headlessUsage() {
  return [
    'Usage: oz --headless --identity <id> --recipe <recipe.json> [options]',
    '',
    '  --identity <id>     Identity to run the recipe under (required)',
    '  --recipe <path>     Path to a recipe JSON file (required)',
    '  --proxy <id>        Override proxy for this run (optional)',
    '  --tab <tabId>       Reuse an existing tab id (optional)',
    '  --out <path>        Write run result JSON to this path (optional)',
  ].join('\n')
}

module.exports = { isHeadlessInvocation, parseHeadlessArgs, headlessUsage, FLAG }
