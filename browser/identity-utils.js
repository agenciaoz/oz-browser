// OZ Browser — Identity pure helpers (alpha.40).
//
// Extracted from identity-manager.js to keep it under the 500-LOC budget
// (ADR 0005). Pure, no Electron — safe to unit-test directly.

const crypto = require('crypto')

// Short, URL-safe id. crypto.randomUUID() works but is too long for partition names.
function uuid() {
  return crypto.randomBytes(8).toString('hex')
}

function now() {
  return Date.now()
}

// ISO 8601 timestamp for the sync layer (LWW comparisons use this).
function nowIso() {
  return new Date().toISOString()
}

// alpha.40: normalize identity tags. Accepts an array or a comma/newline
// separated string. Trims, drops empties, dedupes (case-insensitive, keeps
// first casing), caps tag length (32) and count (20). Always returns an array.
function normalizeTags(input) {
  let raw = []
  if (Array.isArray(input)) raw = input
  else if (typeof input === 'string') raw = input.split(/[,\n]/)
  const out = []
  const seen = new Set()
  for (const t of raw) {
    const tag = String(t || '')
      .trim()
      .slice(0, 32)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= 20) break
  }
  return out
}

const DEFAULT_COLORS = [
  '#5b8def',
  '#ff7a45',
  '#36b37e',
  '#ffab00',
  '#9c5cf2',
  '#e85a8c',
  '#00b8d9',
  '#f15a5a',
  '#36b37e',
  '#ff5630',
]

module.exports = { uuid, now, nowIso, normalizeTags, DEFAULT_COLORS }
