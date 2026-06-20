// OZ Browser — Headless bootstrap (V3-D, scraping/agent-control).
//
// Glue Electron del modo headless: parsea argv, carga+valida el recipe, arma el
// driver real con page-handlers sobre la identity pedida, corre el recipe y
// escribe el resultado (a --out o stdout), luego sale con código 0 (ok) / 1
// (falla) / 2 (args o recipe inválidos).
//
// Se invoca SOLO cuando main detecta `--headless` (cero efecto en el arranque
// GUI normal). La lógica de ejecución/validación es pura y está cubierta por
// tests (headless-cli-runner.smoketest.js); este archivo es el cableado a
// Electron y requiere un smoke en vivo en la Mac de Jose.
//
// NOTA: el override de proxy por `--proxy` aún no se aplica acá (se respeta el
// proxy ya asignado a la identity). Pendiente menor.
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

const fs = require('fs')
const { app } = require('electron')
const log = require('./logger')
const { parseHeadlessArgs, headlessUsage } = require('./headless-cli')
const { runHeadlessRecipe } = require('./headless-runner')
const { buildPageHandlers } = require('./page-handlers')

/**
 * Corre el recipe headless. Nunca lanza: loguea, escribe el resultado y sale.
 *
 * @param {object} browser  AppController (expone .windows para page-handlers).
 * @param {string[]} argv
 * @returns {Promise<number>} exit code (también llama app.exit()).
 */
async function runHeadless(browser, argv) {
  const args = parseHeadlessArgs(argv)
  if (args.errors.length > 0) {
    log.error('headless', 'invalid args', { errors: args.errors })
    process.stderr.write(headlessUsage() + '\n')
    return _exit(2)
  }

  let recipe
  try {
    recipe = JSON.parse(fs.readFileSync(args.recipePath, 'utf8'))
  } catch (e) {
    log.error('headless', 'cannot read recipe', {
      path: args.recipePath,
      message: e.message,
    })
    return _exit(2)
  }

  if (args.proxyId) {
    log.warn('headless', 'proxy override not yet applied; using identity proxy', {
      proxyId: args.proxyId,
    })
  }

  log.info('headless', 'running recipe', {
    identityId: args.identityId,
    steps: Array.isArray(recipe.steps) ? recipe.steps.length : 0,
  })

  let res
  try {
    const driver = buildPageHandlers(browser)
    res = await runHeadlessRecipe({
      recipe,
      driver,
      identityId: args.identityId,
      tabId: args.tabId || null,
      retry: recipe.retry,
      logger: log,
      clock: _realClock(),
    })
  } catch (e) {
    log.error('headless', 'run crashed', { message: e.message })
    return _exit(1)
  }

  const payload = JSON.stringify(res, null, 2)
  if (args.outPath) {
    try {
      fs.writeFileSync(args.outPath, payload, 'utf8')
      log.info('headless', 'wrote result', { path: args.outPath, ok: res.ok })
    } catch (e) {
      log.error('headless', 'cannot write --out', {
        path: args.outPath,
        message: e.message,
      })
    }
  } else {
    process.stdout.write(payload + '\n')
  }
  return _exit(res.ok ? 0 : 1)
}

function _exit(code) {
  try {
    app.exit(code)
  } catch (_e) {
    process.exit(code)
  }
  return code
}

function _realClock() {
  return {
    sleep(ms, signal) {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, ms)
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => (clearTimeout(t), resolve()), {
            once: true,
          })
        }
      })
    },
  }
}

module.exports = { runHeadless }
