// OZ Browser — Page-control pure helpers (v3-A, scraping/agent-control).
//
// Pure functions that BUILD the JS snippets injected via
// webContents.executeJavaScript, plus small arg validators. Kept DOM/Electron
// free so they unit-test deterministically (ADR 0005). The DOM execution lives
// in page-handlers.js; the MCP catalog in mcp-tools-page.js.
//
// Security note: selectors/attrs are embedded with JSON.stringify so a value
// like `a"]; doEvil()` becomes a harmless string literal, never code.

'use strict'

/** Clamp a numeric limit into [1, max], default when missing/invalid. */
function clampLimit(n, def, max) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return def
  return Math.min(Math.floor(v), max)
}

/** JS to read textContent of the first match (null when not found). */
function getTextScript(selector) {
  const sel = JSON.stringify(String(selector))
  return `(function(){var el=document.querySelector(${sel});return el?el.textContent:null;})()`
}

/** JS to read an attribute of the first match (null when not found). */
function getAttrScript(selector, attr) {
  const sel = JSON.stringify(String(selector))
  const at = JSON.stringify(String(attr))
  return `(function(){var el=document.querySelector(${sel});return el?el.getAttribute(${at}):null;})()`
}

/**
 * JS to collect up to `limit` matches as {text, href}. Capped to avoid huge
 * payloads back to the agent.
 */
function queryAllScript(selector, limit) {
  const sel = JSON.stringify(String(selector))
  const cap = clampLimit(limit, 50, 500)
  return (
    `(function(){var out=[];var els=document.querySelectorAll(${sel});` +
    `for(var i=0;i<els.length&&i<${cap};i++){var e=els[i];` +
    `out.push({text:(e.textContent||'').trim(),href:e.getAttribute&&e.getAttribute('href')||null});}` +
    `return {count:els.length,items:out};})()`
  )
}

/** Validate a CSS selector arg: non-empty string. */
function isValidSelector(selector) {
  return typeof selector === 'string' && selector.trim().length > 0
}

module.exports = {
  clampLimit,
  getTextScript,
  getAttrScript,
  queryAllScript,
  isValidSelector,
}
