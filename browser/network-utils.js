// OZ Browser — Network-intercept pure helpers (v3-A, scraping/agent-control).
//
// URL pattern matching for oz.network.block / capture. Pure (no Electron) so it
// unit-tests deterministically (ADR 0005). The webRequest wiring lives in
// network-handlers.js; the MCP catalog in mcp-tools-network.js.
//
// Pattern semantics (intuitive for agents):
//   - a pattern containing '*' is a glob (e.g. '*.doubleclick.net/*', 'https://*/ads/*')
//   - a pattern with no '*' is a case-insensitive substring match (e.g. 'analytics')

'use strict'

/** Convert a glob (with `*` wildcards) into an anchored RegExp. */
function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const re = escaped.replace(/\*/g, '.*')
  return new RegExp('^' + re + '$', 'i')
}

/** Does `url` match a single pattern (glob if it has `*`, else substring)? */
function matchesPattern(url, pattern) {
  const u = String(url || '')
  const p = String(pattern || '')
  if (!p) return false
  if (p.includes('*')) return globToRegExp(p).test(u)
  return u.toLowerCase().includes(p.toLowerCase())
}

/** True if `url` matches ANY pattern in the list. */
function matchesAnyPattern(url, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  return patterns.some((p) => matchesPattern(url, p))
}

/** Coerce arbitrary input into a clean array of non-empty string patterns. */
function sanitizePatterns(patterns) {
  if (!Array.isArray(patterns)) return []
  return patterns.map((p) => String(p || '').trim()).filter((p) => p.length > 0)
}

module.exports = { globToRegExp, matchesPattern, matchesAnyPattern, sanitizePatterns }
