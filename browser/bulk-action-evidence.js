// OZ Browser — post evidence capture (E2, v2.0.0-alpha.105).
// Doc: docs/modules/bulk-action-evidence.md
//
// Tras un posteo exitoso, captura un screenshot de la página como prueba y lo
// guarda en userData/publish-evidence/<ts>-<actionId>-<identity>.png. Devuelve
// el path (o null si falló — best-effort, NUNCA tira: la evidencia no debe
// romper un post ya exitoso). Reusa el helper screenshot() de
// bulk-action-browser-helpers.

'use strict'

const path = require('path')
const fs = require('fs')
const log = require('./logger')
const { screenshot } = require('./bulk-action-browser-helpers')

function _dir(electron) {
  const app = electron && electron.app
  const base = app && typeof app.getPath === 'function' ? app.getPath('userData') : '/tmp'
  const dir = path.join(base, 'publish-evidence')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (_e) {
    /* ignore */
  }
  return dir
}

function _slug(s) {
  return String(s || 'unknown')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .slice(0, 40)
}

/**
 * Captura evidencia del post. Best-effort: devuelve { evidencePath } o {}.
 * @param {object} win - identity window (con webContents)
 * @param {{identityId?, actionId?, electron?}} ctx
 */
async function captureEvidence(win, ctx = {}) {
  try {
    const dir = _dir(ctx.electron)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const file = `${ts}-${_slug(ctx.actionId)}-${_slug(ctx.identityId)}.png`
    const filePath = path.join(dir, file)
    await screenshot(win, { filePath })
    log.info('bulk-evidence', 'captured', { actionId: ctx.actionId, filePath })
    return { evidencePath: filePath }
  } catch (err) {
    log.warn('bulk-evidence', 'capture failed', { message: err && err.message })
    return {}
  }
}

module.exports = { captureEvidence }
