// OZ Browser — Publishing MCP tools smoke test (variation MCP-first).
//
// Verifies the variation tools (oz.publishing.preview/resolve/variety) are
// registered, fit the ≤21-char sanitized budget, and delegate to the handler.
// Also exercises the real variation engine end-to-end through a thin handler
// that reuses ui/publishing-variation (the same module the main handler uses).
//
// Runs under `node tests/publishing-mcp-tools.smoketest.js` (no framework,
// no electron — uses a fake `publishing()` getter).

'use strict'

const assert = require('node:assert')
const { buildPublishingTools } = require('../browser/mcp-tools-publishing')
const V = require('../browser/ui/publishing-variation')

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n       ${err.message}`)
  }
}

// A fake handler map that mirrors the real one's variation methods by
// delegating to the same pure engine the main handler uses.
const calls = []
const fakeHandler = {
  preview: (spec, identities) => {
    calls.push(['preview', spec, identities])
    return V.previewVariations(spec || {}, identities || [])
  },
  resolve: (spec, opts) => {
    calls.push(['resolve', spec, opts])
    return V.resolveForIdentity(spec || {}, opts || {})
  },
  variety: (text) => {
    calls.push(['variety', text])
    return { variants: V.spintaxVariety(text) }
  },
}
const tools = buildPublishingTools({ publishing: () => fakeHandler })
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

ok('variation tools are registered', () => {
  for (const n of [
    'oz.publishing.preview',
    'oz.publishing.resolve',
    'oz.publishing.variety',
  ]) {
    assert(byName[n], `missing tool ${n}`)
  }
})

ok('sanitized names fit the ≤21-char budget', () => {
  for (const t of tools) {
    const sanitized = t.name.replace(/\./g, '_')
    assert(
      sanitized.length <= 21,
      `${t.name} → ${sanitized} is ${sanitized.length} chars (>21)`,
    )
  }
})

ok('every tool has a schema and a call fn', () => {
  for (const n of [
    'oz.publishing.preview',
    'oz.publishing.resolve',
    'oz.publishing.variety',
  ]) {
    assert(byName[n].inputSchema && byName[n].inputSchema.type === 'object')
    assert(typeof byName[n].call === 'function')
  }
})

ok('preview delegates and varies caption per identity', () => {
  const spec = {
    caption: '{hola|hey|qué tal} {{identity}}',
    hashtags: ['a', 'b', 'c'],
    hashtagCount: 2,
  }
  const ids = [
    { id: 'id-1', name: 'Pedro' },
    { id: 'id-2', name: 'Contexto' },
  ]
  const rows = byName['oz.publishing.preview'].call({ spec, identities: ids })
  assert.equal(calls[calls.length - 1][0], 'preview')
  assert.equal(rows.length, 2)
  assert(rows[0].caption.includes('Pedro'), 'caption interpolates {{identity}}')
  assert(rows[1].caption.includes('Contexto'))
  // Deterministic: re-running yields the same captions.
  const rows2 = byName['oz.publishing.preview'].call({ spec, identities: ids })
  assert.equal(rows[0].caption, rows2[0].caption)
})

ok('resolve returns a single varied result for one identity', () => {
  const out = byName['oz.publishing.resolve'].call({
    spec: { caption: 'hi', hashtags: ['x', 'y'], hashtagCount: 1 },
    opts: { index: 0, identity: { id: 'id-9', name: 'Z' } },
  })
  assert(typeof out.caption === 'string')
  assert(Array.isArray(out.hashtags) && out.hashtags.length === 1)
})

ok('variety counts spintax variants', () => {
  const out = byName['oz.publishing.variety'].call({ text: '{a|b|c} {d|e}' })
  assert.equal(out.variants, 6)
})

console.log(`\npublishing-mcp-tools: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
