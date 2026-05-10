// OZ Browser — Proxy CSV import / export (1.8d).
//
// Qué hace: parsing y serialización CSV de proxies, con headers tolerantes a
// reordenamiento + columnas opcionales. Formato compat con Ghost Browser:
//
//   protocol,host,port,username,password,tags,country,name
//
// Cualquier columna se acepta en cualquier orden mientras esté el header.
// `tags` viene separado por "|" (Ghost convention) o ";".
//
// Doc: docs/modules/proxy-csv.md
// ADR: docs/architecture/0017-proxy-model.md
//
// Exports: parseCsv(content) → Array<ProxySpec>, encodeCsv(proxies) → string

const { parse } = require('csv-parse/sync')
const log = require('./logger')

const HEADERS = [
  'protocol',
  'host',
  'port',
  'username',
  'password',
  'tags',
  'country',
  'name',
]
const TAG_SEPARATORS = /[|;]/

/**
 * Parse CSV content into an array of ProxyManager.create() specs.
 * Tolerant: ignores rows missing host or port, returns the rest.
 *
 * Returns { ok: true, items: [...] } or { ok: false, reason, message }.
 */
function parseCsv(content) {
  let records
  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    })
  } catch (err) {
    return { ok: false, reason: 'parse-failed', message: err.message }
  }
  const items = []
  for (const row of records) {
    // Normalize keys to lowercase for tolerance.
    const norm = {}
    for (const k of Object.keys(row)) {
      norm[String(k).trim().toLowerCase()] = row[k]
    }
    const host = norm.host || norm.ip
    const port = norm.port
    if (!host || !port) {
      log.debug('proxy-csv', 'row skipped — missing host/port', { row })
      continue
    }
    const item = {
      protocol: (norm.protocol || 'https').toLowerCase(),
      host: String(host).trim(),
      port: Number(port),
      username: norm.username || norm.user || null,
      password: norm.password || norm.pass || null,
      country: norm.country || null,
      name: norm.name || null,
    }
    if (norm.tags) {
      item.tags = String(norm.tags)
        .split(TAG_SEPARATORS)
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      item.tags = []
    }
    items.push(item)
  }
  log.info('proxy-csv', 'parsed', { rows: records.length, items: items.length })
  return { ok: true, items }
}

/**
 * Serialize an array of proxies back to CSV. Always emits the canonical
 * header row + every column (empty for missing fields).
 */
function encodeCsv(proxies) {
  const lines = [HEADERS.join(',')]
  for (const p of proxies || []) {
    const tagsStr = (p.tags || []).join('|')
    const row = [
      csvEscape(p.protocol || ''),
      csvEscape(p.host || ''),
      csvEscape(p.port || ''),
      csvEscape(p.username || ''),
      csvEscape(p.password || ''),
      csvEscape(tagsStr),
      csvEscape(p.country || ''),
      csvEscape(p.name || ''),
    ].join(',')
    lines.push(row)
  }
  return lines.join('\n') + '\n'
}

/**
 * RFC4180-ish escape — wrap in quotes if the value contains , " or newline,
 * and double internal quotes.
 */
function csvEscape(val) {
  const s = String(val)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

module.exports = { parseCsv, encodeCsv, HEADERS }
