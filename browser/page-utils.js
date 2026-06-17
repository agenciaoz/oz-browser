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

// --- slice 2: input-events / waitFor / extract ------------------------------

/**
 * JS that scrolls the first match into view and returns its viewport-center
 * coords {x,y} (CSS px), or null if not found. Coords feed sendInputEvent.
 */
function clickCoordsScript(selector) {
  const sel = JSON.stringify(String(selector))
  return (
    `(function(){var el=document.querySelector(${sel});if(!el)return null;` +
    `el.scrollIntoView({block:'center',inline:'center'});` +
    `var r=el.getBoundingClientRect();` +
    `return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`
  )
}

/** JS that focuses the first match; returns true if found+focused. */
function focusScript(selector) {
  const sel = JSON.stringify(String(selector))
  return `(function(){var el=document.querySelector(${sel});if(!el)return false;el.focus();return true;})()`
}

/** JS boolean: does the selector currently match anything? (waitFor polling). */
function existsScript(selector) {
  const sel = JSON.stringify(String(selector))
  return `(!!document.querySelector(${sel}))`
}

/**
 * JS to scroll the page. `to`: 'top' | 'bottom' | a number of px (scrollBy).
 * Returns the resulting scrollY.
 */
function scrollScript(to) {
  if (to === 'top') return `(function(){window.scrollTo(0,0);return window.scrollY;})()`
  if (to === 'bottom') {
    return `(function(){window.scrollTo(0,document.body.scrollHeight);return window.scrollY;})()`
  }
  const px = Number(to) || 0
  return `(function(){window.scrollBy(0,${px});return window.scrollY;})()`
}

/**
 * JS for declarative extraction. `schema` maps field → selector string OR
 * { selector, attr }. Returns { field: value|null }. The whole schema is
 * embedded JSON-encoded (injection-safe) and iterated in-page.
 */
function extractScript(schema) {
  const json = JSON.stringify(schema || {})
  return (
    `(function(){var s=${json};var out={};` +
    `for(var k in s){var spec=s[k];` +
    `var sel=typeof spec==='string'?spec:(spec&&spec.selector);` +
    `var attr=(spec&&typeof spec==='object')?spec.attr:null;` +
    `var el=sel?document.querySelector(sel):null;` +
    `out[k]=el?(attr?el.getAttribute(attr):(el.textContent||'').trim()):null;}` +
    `return out;})()`
  )
}

module.exports = {
  clampLimit,
  getTextScript,
  getAttrScript,
  queryAllScript,
  isValidSelector,
  clickCoordsScript,
  focusScript,
  existsScript,
  scrollScript,
  extractScript,
}
