// OZ Browser — System diagnostics (alpha.112).
//
// Idea de Jose (2026-07-16): "deberíamos tener un módulo para que [Claude]
// pueda siempre revisar todo". Un snapshot único del estado del navegador que
// yo (el agente MCP) puedo pedir de una sola llamada para diagnosticar sin
// depender de que Jose me pase datos a mano.
//
// Reúne, best-effort y guardado (nunca tira): versión + runtime, identidades,
// salud de proxies, sesiones cacheadas, tabs por ventana, estado de sync,
// toggles de settings, resumen del último scrape job, y la cola de errores/
// warnings recientes del log. Cada bloque es opcional: si un manager no está,
// ese bloque queda en null y el resto igual sale.
//
// `parseLogTail` es puro (opera sobre el texto del log) para test determinista
// (ADR 0005); `readLogTail` hace el fs.read y delega. `buildDiagnostics` toma
// el browser y lee de sus managers con guards.
//
// Expuesto MCP-first: oz.diag.snapshot / oz.diag.logs (handlers en
// diagnostics-handlers vía este módulo). MCP-first (regla Jose).
//
// Doc: docs/modules/system-diagnostics.md
// ADR: docs/architecture/0043-system-diagnostics.md

'use strict'

const fs = require('fs')

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']

function _safe(fn, fallback) {
  try {
    const v = fn()
    return v === undefined ? fallback : v
  } catch (_e) {
    return fallback
  }
}

/**
 * Resumen de salud de proxies desde proxyManager.list().
 * @returns {{total,active,disabled,failing,avgLatencyMs,worst}}
 */
function summarizeProxies(list) {
  const arr = Array.isArray(list) ? list : []
  let active = 0
  let disabled = 0
  let failing = 0
  let latSum = 0
  let latN = 0
  let worst = null
  for (const p of arr) {
    if (p.isDisabled) disabled++
    else if (p.isActive) active++
    if ((p.failureCount || 0) > 0) failing++
    if (Number.isFinite(p.lastLatencyMs)) {
      latSum += p.lastLatencyMs
      latN++
    }
    if (!worst || (p.failureCount || 0) > (worst.failureCount || 0)) {
      if ((p.failureCount || 0) > 0) {
        worst = { id: p.id, name: p.name, failureCount: p.failureCount }
      }
    }
  }
  return {
    total: arr.length,
    active,
    disabled,
    failing,
    avgLatencyMs: latN > 0 ? Math.round(latSum / latN) : null,
    worst,
  }
}

/**
 * Parsea el tail de un log de OZ. Filtra por nivel mínimo y devuelve las
 * últimas `limit` líneas que cumplen. Puro — opera sobre `text`.
 *
 * @param {string} text — contenido del log.
 * @param {object} [opts]
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} [opts.level='WARN'] — nivel mínimo.
 * @param {number} [opts.limit=50]
 * @returns {{lines:string[], counts:{DEBUG,INFO,WARN,ERROR}}}
 */
function parseLogTail(text, opts = {}) {
  const level = LEVELS.includes(opts.level) ? opts.level : 'WARN'
  const minIdx = LEVELS.indexOf(level)
  const limit =
    Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 50
  const counts = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 }
  const matched = []
  const src = typeof text === 'string' ? text : ''
  for (const line of src.split('\n')) {
    if (!line) continue
    // Formato del logger: "[ISO] LEVEL  [source] message ...".
    const m = line.match(/\]\s+(DEBUG|INFO|WARN|ERROR)\b/)
    if (!m) continue
    counts[m[1]]++
    if (LEVELS.indexOf(m[1]) >= minIdx) matched.push(line)
  }
  return { lines: matched.slice(-limit), counts }
}

/**
 * Lee el archivo de log y devuelve el tail parseado. Best-effort.
 */
function readLogTail(logPath, opts = {}) {
  if (!logPath)
    return { lines: [], counts: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 }, logPath: null }
  let text = ''
  try {
    // Solo la cola del archivo para no leer megas: leemos hasta ~512KB del final.
    const stat = fs.statSync(logPath)
    const start = Math.max(0, stat.size - 512 * 1024)
    const fd = fs.openSync(logPath, 'r')
    try {
      const len = stat.size - start
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      text = buf.toString('utf-8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (_e) {
    return { lines: [], counts: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 }, logPath }
  }
  return { ...parseLogTail(text, opts), logPath }
}

/**
 * Cruza cada identity contra su ruteo de proxy y devuelve las que navegarían
 * SIN proxy y sin opt-out 'direct' explícito (modo 'none'). Con enforce OFF eso
 * es una fuga de IP real; con enforce ON quedan blackholed (no navegan). Puro.
 *
 * @returns {{enforced:boolean, count:number, identities:Array<{id,name,workspaceId}>}}
 */
function leakRiskFor(browser, identities) {
  const b = browser || {}
  const pa = b.proxyAssignment
  const enforced = !!b.enforceProxy
  const list = Array.isArray(identities) ? identities : []
  const risky = []
  if (pa && typeof pa.resolveRouting === 'function') {
    for (const i of list) {
      if (!i || !i.id) continue
      let mode = 'none'
      try {
        mode = pa.resolveRouting({ identityId: i.id, workspaceId: i.workspaceId }).mode
      } catch (_e) {
        mode = 'none'
      }
      if (mode === 'none') {
        risky.push({ id: i.id, name: i.name, workspaceId: i.workspaceId })
      }
    }
  }
  return { enforced, count: risky.length, identities: risky }
}

/**
 * Snapshot completo del estado del navegador. Cada bloque es best-effort.
 *
 * @param {object} browser — instancia Browser.
 * @param {object} [opts]
 * @param {object} [opts.logger] — logger con getLogFilePath() (para el tail).
 * @param {boolean} [opts.includeLog=true]
 * @param {string} [opts.logLevel='WARN']
 * @param {number} [opts.logLimit=30]
 * @returns {object} snapshot estructurado.
 */
function buildDiagnostics(browser, opts = {}) {
  const b = browser || {}
  const h = b.handlers || {}
  const mem = _safe(() => process.memoryUsage(), {})

  // Identidades.
  const identities = _safe(
    () => (b.identityManager && b.identityManager.list ? b.identityManager.list() : []),
    [],
  )

  // Proxies + salud.
  const proxyList = _safe(
    () => (b.proxyManager && b.proxyManager.list ? b.proxyManager.list() : []),
    [],
  )

  // Tabs por ventana.
  const windows = _safe(() => b.windows || [], [])
  let tabsLazy = 0
  let tabsMaterialized = 0
  const perWindow = []
  for (const win of windows) {
    let lazy = 0
    let mat = 0
    const list = _safe(() => (win.tabs && win.tabs.tabList) || [], [])
    for (const t of list) {
      if (t.materialized) mat++
      else lazy++
    }
    tabsLazy += lazy
    tabsMaterialized += mat
    perWindow.push({
      id: _safe(() => win.id, null),
      workspaceId: _safe(() => win.workspaceId, null),
      tabs: list.length,
      materialized: mat,
      lazy,
    })
  }

  // Settings clave (toggles que afectan comportamiento).
  const settings = _safe(
    () =>
      b.settingsManager && b.settingsManager.getAll ? b.settingsManager.getAll() : {},
    {},
  )

  const diag = {
    generatedAt: new Date().toISOString(),
    runtime: {
      ozVersion: _safe(() => require('../package.json').version, 'unknown'),
      uptimeSec: _safe(() => Math.floor(process.uptime()), null),
      memoryMB: mem.rss ? Math.round(mem.rss / 1048576) : null,
      heapMB: mem.heapUsed ? Math.round(mem.heapUsed / 1048576) : null,
      node: _safe(() => process.version, null),
      platform: _safe(() => process.platform, null),
    },
    enforceProxy: !!b.enforceProxy,
    identities: {
      count: identities.length,
      list: identities.map((i) => ({
        id: i.id,
        name: i.name,
        workspaceId: i.workspaceId,
        isDefault: !!i.isDefault,
        locked: !!i.locked,
      })),
    },
    proxies: summarizeProxies(proxyList),
    // Red de seguridad "todo proxiado siempre" (regla Jose): cruza cada
    // identity contra su ruteo de proxy. Una identity en modo 'none' (sin
    // proxy y sin opt-out 'direct' explícito) navegaría por la IP real si el
    // install NO enforcea (blackhole). Si enforce está OFF, esto es fuga real.
    leakRisk: _safe(() => leakRiskFor(b, identities), null),
    sessionsCached: _safe(
      () =>
        b.identityManager && b.identityManager.sessionCache
          ? b.identityManager.sessionCache.size
          : null,
      null,
    ),
    tabs: {
      total: tabsLazy + tabsMaterialized,
      materialized: tabsMaterialized,
      lazy: tabsLazy,
      windows: perWindow,
    },
    workspaces: _safe(
      () =>
        b.workspaceManager && b.workspaceManager.list
          ? b.workspaceManager.list().length
          : null,
      null,
    ),
    sync: _safe(() => (h.sync && h.sync.getStatus ? h.sync.getStatus() : null), null),
    settings: {
      performance: settings.performance || null,
      privacy: settings.privacy || null,
      sync: settings.sync || null,
      notifications: settings.notifications || null,
    },
    lastScrape: _safe(() => {
      const r = b._lastScrapeReport
      if (!r) return null
      return { jobId: r.jobId, wallMs: r.wallMs, cost: r.cost }
    }, null),
    selfCheck: _safe(() => selfCheck(b), null),
  }

  if (opts.includeLog !== false) {
    const logPath = _safe(
      () =>
        opts.logger && opts.logger.getLogFilePath ? opts.logger.getLogFilePath() : null,
      null,
    )
    diag.log = readLogTail(logPath, {
      level: opts.logLevel || 'WARN',
      limit: opts.logLimit || 30,
    })
  }

  return diag
}

/**
 * Auto-verificación del subsistema: comprueba que los managers/handlers de los
 * que depende el diagnóstico (y el propio browser) están presentes y sanos.
 * Puro (guardado). Sirve para que el agente confirme que "revisar todo"
 * realmente puede revisar todo — y para diagnosticar el diagnóstico mismo.
 *
 * @returns {{ok:boolean, checks:Array<{name,ok,detail}>}}
 */
function selfCheck(browser) {
  const b = browser || {}
  const h = b.handlers || {}
  const checks = []
  const add = (name, ok, detail) =>
    checks.push({ name, ok: !!ok, detail: detail || null })

  add('browser instance', !!browser, browser ? null : 'no browser passed')
  add('identityManager', !!(b.identityManager && b.identityManager.list))
  add('proxyManager', !!(b.proxyManager && b.proxyManager.list))
  add('proxyAssignment', !!(b.proxyAssignment && b.proxyAssignment.resolveRouting))
  add('workspaceManager', !!(b.workspaceManager && b.workspaceManager.list))
  add('settingsManager', !!(b.settingsManager && b.settingsManager.getAll))
  add('windows array', Array.isArray(b.windows))
  add('handlers map', !!b.handlers)
  add('sync handler', !!(h.sync && h.sync.getStatus))
  add('diag handler wired', !!(h.diag && h.diag.snapshot))
  // Los propios exports del módulo (el agente puede analizar el módulo mismo).
  add(
    'diagnostics module exports',
    typeof buildDiagnostics === 'function' &&
      typeof parseLogTail === 'function' &&
      typeof readLogTail === 'function' &&
      typeof summarizeProxies === 'function',
  )

  const failed = checks.filter((c) => !c.ok)
  return { ok: failed.length === 0, failed: failed.length, checks }
}

module.exports = {
  buildDiagnostics,
  summarizeProxies,
  parseLogTail,
  readLogTail,
  selfCheck,
  leakRiskFor,
}
