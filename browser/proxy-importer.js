// OZ Browser — Proxy Importer (H-2g, v1.1.3).
//
// Doc: docs/modules/proxy-importer.md
//
// Parsea texto pegado/uploaded a proxies. Auto-detecta entre 3 formatos:
//
//   1. TXT host:port:user:pass  (Oxylabs / SmartProxy default flat list)
//   2. TXT user:pass@host:port  (URL-style sin scheme)
//   3. CSV con headers          (host,port,user,pass,country?,label?,type?)
//
// La auto-detect es la UX principal: el user pega cualquiera de los 3 y la
// preview muestra qué leyó. Cada row tiene `row: lineNumber` 1-indexed para
// que la UI marque errores con precisión. Importbatch llama
// `proxyManager.create()` por cada valid (NO bulkAdd — queremos fail-fast por
// row con razón propia).

const { parse: csvParseSync } = require('csv-parse/sync')
const log = require('./logger')

function _validPort(p) {
  const n = Number(p)
  return Number.isFinite(n) && n >= 1 && n <= 65535
}

function detectFormat(text) {
  if (!text || typeof text !== 'string') return 'unknown'
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return 'unknown'
  const first = lines[0]
  // CSV header heuristic: contains both host + port keywords and a comma.
  if (first.includes(',') && /host/i.test(first) && /port/i.test(first)) return 'csv'
  // url-style: any line matches user:pass@host:port (no header on first line).
  for (const line of lines) {
    if (/^[^:@\s]+:[^@\s]+@[^:@\s]+:\d+$/.test(line)) return 'url-style'
  }
  // host-port: first non-comment line matches host:port:user:pass (4 colon-separated parts).
  for (const line of lines) {
    if (/^[\w.-]+:\d+:[^:]+:[^:]+$/.test(line)) return 'host-port'
  }
  // Also accept host:port without creds (3 fields → host:port:_:_).
  for (const line of lines) {
    if (/^[\w.-]+:\d+$/.test(line)) return 'host-port'
  }
  return 'unknown'
}

function parseTxtHostPort(line) {
  // Accept "host:port", "host:port:user:pass", or "host:port:user:pass:country"
  const parts = line.split(':')
  if (parts.length < 2) {
    return { ok: false, reason: 'BAD_FORMAT', message: 'expected host:port[:user:pass]' }
  }
  const host = parts[0].trim()
  const port = parts[1].trim()
  if (!host) return { ok: false, reason: 'EMPTY_HOST' }
  if (!_validPort(port)) {
    return { ok: false, reason: 'INVALID_PORT', message: `port "${port}"` }
  }
  const username = parts[2] != null ? parts[2].trim() : null
  const password = parts[3] != null ? parts[3].trim() : null
  const country = parts[4] != null ? parts[4].trim() : null
  return {
    ok: true,
    proxy: {
      host,
      port: Number(port),
      username: username || null,
      password: password || null,
      country: country || null,
    },
  }
}

function parseTxtUrlStyle(line) {
  // user:pass@host:port
  const m = line.match(/^([^:@\s]+):([^@\s]+)@([^:@\s]+):(\d+)$/)
  if (!m)
    return { ok: false, reason: 'BAD_FORMAT', message: 'expected user:pass@host:port' }
  const [, username, password, host, port] = m
  if (!_validPort(port)) {
    return { ok: false, reason: 'INVALID_PORT', message: `port "${port}"` }
  }
  return {
    ok: true,
    proxy: {
      host: host.trim(),
      port: Number(port),
      username: username.trim() || null,
      password: password.trim() || null,
      country: null,
    },
  }
}

function parseCsvAll(text) {
  let records
  try {
    records = csvParseSync(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    })
  } catch (err) {
    return {
      ok: false,
      reason: 'CSV_PARSE_FAILED',
      message: err && err.message,
      rows: [],
    }
  }
  const rows = []
  for (let idx = 0; idx < records.length; idx++) {
    // CSV row N occurs at original line idx+2 (1-indexed + header).
    const rowNum = idx + 2
    const r = records[idx]
    const host = r.host || r.Host || r.HOST
    const port = r.port || r.Port || r.PORT
    const user = r.user || r.username || r.User || r.Username || null
    const pass = r.pass || r.password || r.Pass || r.Password || null
    const country = r.country || r.Country || null
    const label = r.label || r.Label || r.name || r.Name || null
    const protocol = r.type || r.protocol || r.Type || r.Protocol || null
    if (!host) {
      rows.push({ row: rowNum, ok: false, reason: 'EMPTY_HOST' })
      continue
    }
    if (!_validPort(port)) {
      rows.push({
        row: rowNum,
        ok: false,
        reason: 'INVALID_PORT',
        message: `port "${port}"`,
      })
      continue
    }
    rows.push({
      row: rowNum,
      ok: true,
      proxy: {
        host: String(host).trim(),
        port: Number(port),
        username: user ? String(user).trim() : null,
        password: pass ? String(pass).trim() : null,
        country: country ? String(country).trim() : null,
        label: label ? String(label).trim() : null,
        protocol: protocol ? String(protocol).trim().toLowerCase() : null,
      },
    })
  }
  return { ok: true, rows }
}

function _summarize(rows) {
  let valid = 0
  let invalid = 0
  for (const r of rows) {
    if (r.ok) valid++
    else invalid++
  }
  return { total: rows.length, valid, invalid }
}

function parseProxies(text) {
  const format = detectFormat(text)
  if (format === 'unknown') {
    return { format, rows: [], summary: { total: 0, valid: 0, invalid: 0 } }
  }
  if (format === 'csv') {
    const r = parseCsvAll(text || '')
    if (!r.ok) {
      return {
        format,
        rows: [{ row: 1, ok: false, reason: r.reason, message: r.message }],
        summary: { total: 1, valid: 0, invalid: 1 },
      }
    }
    return { format, rows: r.rows, summary: _summarize(r.rows) }
  }
  // line-based formats
  const rawLines = (text || '').split(/\r?\n/)
  const rows = []
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) continue // allow comments
    let r
    if (format === 'url-style') r = parseTxtUrlStyle(line)
    else r = parseTxtHostPort(line)
    rows.push({ row: i + 1, ...r })
  }
  return { format, rows, summary: _summarize(rows) }
}

function buildProxyImporter({ proxyManager }) {
  if (!proxyManager) throw new Error('proxyManager required')

  function _import(rows) {
    const added = []
    const failed = []
    const list = Array.isArray(rows) ? rows : []
    for (const r of list) {
      if (!r || !r.ok || !r.proxy) {
        failed.push({ row: r && r.row, reason: r && r.reason ? r.reason : 'INVALID_ROW' })
        continue
      }
      const p = r.proxy
      const created = proxyManager.create({
        host: p.host,
        port: p.port,
        username: p.username || null,
        password: p.password || null,
        country: p.country || null,
        protocol: p.protocol || 'https',
        name: p.label || `${p.host}:${p.port}`,
        isActive: true,
      })
      if (created && created.__error) {
        failed.push({ row: r.row, reason: created.__error.code })
      } else {
        added.push({ row: r.row, id: created.id })
      }
    }
    log.info('proxy-importer', 'importBatch done', {
      added: added.length,
      failed: failed.length,
    })
    return {
      ok: true,
      added: added.length,
      failed,
      addedIds: added,
      summary: { total: list.length, ok: added.length, failed: failed.length },
    }
  }

  return {
    detectFormat,
    parseProxies,
    parseTxtHostPort,
    parseTxtUrlStyle,
    parseCsvAll,
    importBatch: _import,
  }
}

module.exports = {
  buildProxyImporter,
  detectFormat,
  parseProxies,
  parseTxtHostPort,
  parseTxtUrlStyle,
  parseCsvAll,
}
