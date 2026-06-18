// OZ Browser — License / activation gate (pre-SaaS test builds).
//
// Blocks boot until the install is activated against the OZ activation server
// (Cloudflare Worker + D1). Flow: on init() main calls gate(); if not activated
// it opens ONLY a small activation window and returns (the rest of the app does
// not boot). On a successful key activation the app relaunches and passes the
// gate. Online re-validation each launch, with an offline grace window.
//
// Dev bypass: OZ_LICENSE_DISABLED=1. Server override: OZ_LICENSE_SERVER.
//
// Self-contained (own IPC + window) so it never touches the 500-LOC files.
// ADR: 0037 (activation gate). Server: activation-server/worker.js.

'use strict'

const { app, ipcMain, BrowserWindow } = require('electron')
const https = require('https')
const os = require('os')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const log = require('./logger')

const SERVER =
  process.env.OZ_LICENSE_SERVER || 'https://oz-activate.joserodrigo-413.workers.dev'
const DEFAULT_GRACE_DAYS = 7

function storePath() {
  return path.join(app.getPath('userData'), 'oz-license.json')
}

function loadLocal() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'))
  } catch (_e) {
    return null
  }
}

function saveLocal(rec) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(rec, null, 2))
  } catch (e) {
    log.warn('license', 'saveLocal failed', { message: e && e.message })
  }
}

function getMachineId() {
  const file = path.join(app.getPath('userData'), 'oz-machine-id')
  let uuid = ''
  try {
    uuid = fs.readFileSync(file, 'utf8').trim()
  } catch (_e) {
    /* first run */
  }
  if (!uuid) {
    uuid = crypto.randomUUID()
    try {
      fs.writeFileSync(file, uuid)
    } catch (_e) {
      /* ignore */
    }
  }
  const raw = `${os.hostname()}|${process.platform}|${process.arch}|${uuid}`
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

// POST JSON; resolves the parsed body or null on any network/parse error.
function post(pathname, body, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const data = Buffer.from(JSON.stringify(body))
      const u = new URL(SERVER + pathname)
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': data.length },
        },
        (res) => {
          let raw = ''
          res.on('data', (c) => (raw += c))
          res.on('end', () => {
            try {
              finish(JSON.parse(raw))
            } catch (_e) {
              finish(null)
            }
          })
        },
      )
      req.on('error', () => finish(null))
      req.setTimeout(timeoutMs || 6000, () => {
        req.destroy()
        finish(null)
      })
      req.write(data)
      req.end()
    } catch (_e) {
      finish(null)
    }
  })
}

function withinGrace(rec, machineId) {
  if (!rec || rec.machineId !== machineId) return false
  if (rec.expiresAt && rec.expiresAt < Date.now()) return false
  const grace = (rec.graceDays || DEFAULT_GRACE_DAYS) * 86400000
  return rec.lastValidatedAt && Date.now() - rec.lastValidatedAt < grace
}

function fireEvent(type, rec, machineId) {
  post(
    '/event',
    { key: rec && rec.key, machineId, type, meta: { v: app.getVersion() } },
    4000,
  )
}

/**
 * Public usage-telemetry reporter (fire-and-forget, never throws). No-op if not
 * activated. Used by feature hooks (bulk runs, scrapes) to feed the admin
 * dashboard "what they worked on". Operational events only — no page content.
 */
function reportEvent(type, meta) {
  try {
    const rec = loadLocal()
    if (!rec || !rec.key || !type) return
    post(
      '/event',
      { key: rec.key, machineId: getMachineId(), type: String(type), meta: meta || {} },
      4000,
    )
  } catch (_e) {
    /* never throw */
  }
}

async function ensureActivated() {
  const machineId = getMachineId()
  const rec = loadLocal()
  if (!rec || !rec.key) return { activated: false, reason: 'not_activated' }

  const online = await post('/validate', {
    key: rec.key,
    machineId,
    token: rec.token,
    appVersion: app.getVersion(),
  })
  if (online && online.ok) {
    saveLocal({
      key: rec.key,
      machineId,
      plan: online.plan,
      email: online.email,
      name: online.name,
      expiresAt: online.expiresAt || null,
      token: online.token || rec.token,
      graceDays: online.offlineGraceDays || DEFAULT_GRACE_DAYS,
      lastValidatedAt: Date.now(),
    })
    fireEvent('app-open', rec, machineId)
    return { activated: true, online: true }
  }
  if (online && online.ok === false) {
    return { activated: false, reason: online.reason || 'rejected' }
  }
  // network error → offline grace
  if (withinGrace(rec, machineId)) return { activated: true, offline: true }
  return { activated: false, reason: 'offline_no_grace' }
}

async function activateWithKey(key) {
  const machineId = getMachineId()
  const r = await post('/activate', {
    key: String(key || '')
      .trim()
      .toUpperCase(),
    machineId,
    appVersion: app.getVersion(),
  })
  if (r && r.ok) {
    saveLocal({
      key: String(key).trim().toUpperCase(),
      machineId,
      plan: r.plan,
      email: r.email,
      name: r.name,
      expiresAt: r.expiresAt || null,
      token: r.token,
      graceDays: r.offlineGraceDays || DEFAULT_GRACE_DAYS,
      lastValidatedAt: Date.now(),
    })
    return { ok: true }
  }
  if (r && r.ok === false) return { ok: false, reason: r.reason }
  return { ok: false, reason: 'network' }
}

let ipcWired = false
let relaunching = false
function wireIpc() {
  if (ipcWired) return
  ipcWired = true
  ipcMain.handle('oz:license:activate', async (_e, key) => {
    const r = await activateWithKey(key)
    if (r.ok) {
      relaunching = true
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 500)
    }
    return r
  })
  ipcMain.handle('oz:license:quit', () => app.quit())
}

function activationHtml(reason) {
  const msg =
    reason === 'revoked'
      ? 'Tu acceso fue revocado. Contactá al administrador.'
      : reason === 'expired'
        ? 'Tu acceso venció. Pedí una clave nueva.'
        : reason === 'offline_no_grace'
          ? 'No se pudo validar online y venció la gracia offline. Conectate a internet.'
          : 'Ingresá tu clave de activación para usar OZ Browser.'
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<style>
html,body{margin:0;height:100%;background:#0f1117;color:#e5e7eb;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.box{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;text-align:center}
h1{font-size:20px;margin:0}.mut{color:#9aa0ab;max-width:340px}
input{width:280px;text-align:center;letter-spacing:2px;text-transform:uppercase;font-size:16px;padding:11px;border-radius:8px;border:1px solid #2a2e3a;background:#0d0f15;color:#e5e7eb}
button{width:280px;padding:11px;border:0;border-radius:8px;background:#6488ff;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
button:disabled{opacity:.5}.err{color:#f87171;min-height:18px}.lnk{color:#9aa0ab;font-size:12px;background:none;border:0;cursor:pointer;width:auto;text-decoration:underline}
</style></head><body><div class="box">
<h1>🦉 OZ Browser</h1>
<div class="mut">${msg}</div>
<input id="k" placeholder="OZ-XXXX-XXXX-XXXX" autofocus/>
<button id="go">Activar</button>
<div class="err" id="err"></div>
<button class="lnk" id="quit">Salir</button>
</div>
<script>
const { ipcRenderer } = require('electron')
const k=document.getElementById('k'),go=document.getElementById('go'),err=document.getElementById('err')
async function activate(){const key=k.value.trim();if(!key){err.textContent='Ingresá una clave';return}
 go.disabled=true;go.textContent='Validando…';err.textContent=''
 const r=await ipcRenderer.invoke('oz:license:activate',key)
 if(r&&r.ok){go.textContent='✓ Activado — reiniciando…'}
 else{go.disabled=false;go.textContent='Activar';
  err.textContent=r&&r.reason==='invalid_key'?'Clave inválida':r&&r.reason==='revoked'?'Clave revocada':r&&r.reason==='expired'?'Clave vencida':r&&r.reason==='device_limit'?'Límite de dispositivos alcanzado — pedile al admin que libere uno':'No se pudo validar (revisá tu internet)'}}
go.onclick=activate
k.addEventListener('keydown',e=>{if(e.key==='Enter')activate()})
document.getElementById('quit').onclick=()=>ipcRenderer.invoke('oz:license:quit')
</script></body></html>`
}

function openActivationWindow(res) {
  wireIpc()
  const file = path.join(app.getPath('userData'), 'oz-activation.html')
  try {
    fs.writeFileSync(file, activationHtml(res && res.reason))
  } catch (e) {
    log.error('license', 'write activation html failed', { message: e && e.message })
  }
  const win = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    title: 'OZ Browser — Activación',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  win.loadFile(file)
  // Closing the activation window quits the app — prevents bypassing the gate
  // via the dock 'activate' handler (which would otherwise create a window).
  win.on('closed', () => {
    if (!relaunching) app.quit()
  })
  return win
}

/**
 * Boot gate. Returns true if boot should HALT (activation window shown), false
 * if the app may continue. Never throws.
 */
async function gate() {
  if (process.env.OZ_LICENSE_DISABLED === '1') {
    log.info('license', 'gate bypassed (OZ_LICENSE_DISABLED=1)')
    return false
  }
  let res
  try {
    res = await ensureActivated()
  } catch (e) {
    log.error('license', 'ensureActivated threw', { message: e && e.message })
    res = { activated: false, reason: 'error' }
  }
  if (res.activated) {
    log.info('license', 'activated', { online: !!res.online, offline: !!res.offline })
    return false
  }
  log.warn('license', 'not activated — showing activation window', { reason: res.reason })
  try {
    openActivationWindow(res)
    return true
  } catch (e) {
    // Fail-open: never brick the app if the activation window can't open.
    log.error('license', 'openActivationWindow failed — booting ungated', {
      message: e && e.message,
    })
    return false
  }
}

module.exports = { gate, ensureActivated, activateWithKey, getMachineId, reportEvent }
