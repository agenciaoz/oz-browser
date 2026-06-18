// OZ Browser — Page-control handlers (v3-A, scraping/agent-control).
//
// Lets an agent (Claude/Cursor via MCP) drive a page inside a specific
// identity's tab: navigate + read DOM + eval. Resolves identity→tab→webContents
// and runs JS via executeJavaScript. Input-event tools (click/type/scroll with
// sendInputEvent) + waitFor/screenshot/extract land in later v3-A sub-blocks.
//
// Pure snippet builders live in page-utils.js. This module is the DOM/Electron
// boundary. MCP catalog: mcp-tools-page.js.
//
// ADR: 0036 (page-control layer) · 0012 (MCP server) · 0005 (modular 500 LOC)

'use strict'

const log = require('./logger')
const { normalizeOmniboxInput } = require('./url-normalize')
const PU = require('./page-utils')
const HM = require('./page-human')
const licenseManager = require('./license-manager')

function hostOf(url) {
  try {
    return new URL(url).host
  } catch (_e) {
    return ''
  }
}

function buildPageHandlers(browser) {
  // Find a tab by explicit id (any window), else the first tab of the identity.
  function resolveTab(identityId, tabId) {
    if (tabId) {
      for (const win of browser.windows) {
        const t = win.tabs.get(tabId)
        if (t) return t
      }
      return null
    }
    for (const win of browser.windows) {
      for (const t of win.tabs.tabList) {
        if (t.identityId === identityId) return t
      }
    }
    return null
  }

  function err(code, message) {
    return { __error: { code, message: message || code } }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Resolve a live webContents for the identity/tab (materializing lazy tabs).
  // Returns { wc, tab } or { __error }.
  function resolveWC(identityId, tabId) {
    const tab = resolveTab(identityId, tabId)
    if (!tab) return err('TAB_NOT_FOUND', 'No tab for the given identity/tabId')
    if (!tab.materialized) tab.materialize()
    const wc = tab.webContents
    if (!wc || wc.isDestroyed())
      return err('NO_WEBCONTENTS', 'Tab has no live webContents')
    return { wc, tab }
  }

  async function runJS(identityId, tabId, code) {
    const r = resolveWC(identityId, tabId)
    if (r.__error) return r
    try {
      const result = await r.wc.executeJavaScript(code, true)
      return { ok: true, result }
    } catch (e) {
      return err('EVAL_FAILED', e && e.message)
    }
  }

  return {
    /** Navigate the identity's tab to url (creates a tab if none + a focused window). */
    navigate({ identityId, tabId, url }) {
      const norm = url ? normalizeOmniboxInput(url) || url : null
      if (!norm) return err('BAD_URL', 'Missing or invalid url')
      licenseManager.reportEvent('scrape', { host: hostOf(norm) })
      const tab = resolveTab(identityId, tabId)
      if (!tab) {
        const win = browser.getFocusedWindow()
        if (!win || !identityId)
          return err('TAB_NOT_FOUND', 'No tab and no window to create one')
        const nt = win.tabs.create({ identityId, url: norm, source: 'page.navigate' })
        browser.broadcastToWebUI('oz:tabs:updated', {
          kind: 'created',
          tab: { ...nt.serialize(), windowId: win.id },
        })
        log.info('page-handlers', 'navigate created tab', { tabId: nt.id, identityId })
        return { ok: true, tabId: nt.id, url: norm, created: true }
      }
      if (!tab.materialized) tab.materialize()
      tab.loadURL(norm)
      log.info('page-handlers', 'navigate ok', { tabId: tab.id, url: norm })
      return { ok: true, tabId: tab.id, url: norm }
    },

    /** Current url + title of the tab. */
    getInfo({ identityId, tabId }) {
      const tab = resolveTab(identityId, tabId)
      if (!tab) return err('TAB_NOT_FOUND')
      const s = tab.serialize()
      return { ok: true, tabId: tab.id, url: s.url, title: s.title }
    },

    getText({ identityId, tabId, selector }) {
      if (!PU.isValidSelector(selector)) return err('BAD_SELECTOR')
      return runJS(identityId, tabId, PU.getTextScript(selector))
    },

    getAttr({ identityId, tabId, selector, attr }) {
      if (!PU.isValidSelector(selector)) return err('BAD_SELECTOR')
      if (!attr) return err('BAD_ATTR')
      return runJS(identityId, tabId, PU.getAttrScript(selector, attr))
    },

    queryAll({ identityId, tabId, selector, limit }) {
      if (!PU.isValidSelector(selector)) return err('BAD_SELECTOR')
      return runJS(identityId, tabId, PU.queryAllScript(selector, limit))
    },

    /** Run arbitrary JS in the page and return its value (agent escape hatch). */
    eval({ identityId, tabId, code }) {
      if (typeof code !== 'string' || !code.trim()) return err('BAD_CODE')
      return runJS(identityId, tabId, code)
    },

    /** Real mouse click on the first match (scrolls into view, sendInputEvent).
     *  `human:true` (v3-B) moves the cursor along a Bézier path with gaussian
     *  delays before pressing (default false = direct move, unchanged). */
    async click({ identityId, tabId, selector, button, human }) {
      if (!PU.isValidSelector(selector)) return err('BAD_SELECTOR')
      const r = resolveWC(identityId, tabId)
      if (r.__error) return r
      let pt
      try {
        pt = await r.wc.executeJavaScript(PU.clickCoordsScript(selector), true)
      } catch (e) {
        return err('EVAL_FAILED', e && e.message)
      }
      if (!pt) return err('NOT_FOUND', 'Selector matched no element')
      const btn = button === 'right' || button === 'middle' ? button : 'left'
      try {
        if (human) {
          const start = { x: Math.max(0, pt.x - 45), y: Math.max(0, pt.y - 35) }
          for (const p of HM.bezierPath(start, pt, { steps: 18, jitter: 0.2 })) {
            r.wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
            await sleep(HM.gaussian(12, 5, undefined, 2, 40))
          }
          await sleep(HM.gaussian(90, 30, undefined, 30, 250))
        } else {
          r.wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y })
        }
        r.wc.sendInputEvent({
          type: 'mouseDown',
          x: pt.x,
          y: pt.y,
          button: btn,
          clickCount: 1,
        })
        if (human) await sleep(HM.gaussian(60, 20, undefined, 20, 160))
        r.wc.sendInputEvent({
          type: 'mouseUp',
          x: pt.x,
          y: pt.y,
          button: btn,
          clickCount: 1,
        })
      } catch (e) {
        return err('INPUT_FAILED', e && e.message)
      }
      return { ok: true, x: pt.x, y: pt.y, button: btn, human: !!human }
    },

    /** Focus the first match and type text char-by-char via sendInputEvent.
     *  `human:true` (v3-B) uses gaussian per-char cadence; otherwise the
     *  optional uniform `delayVarianceMs` (default 0 = as fast as possible). */
    async type({ identityId, tabId, selector, text, delayVarianceMs, human }) {
      if (!PU.isValidSelector(selector)) return err('BAD_SELECTOR')
      if (typeof text !== 'string') return err('BAD_TEXT')
      const r = resolveWC(identityId, tabId)
      if (r.__error) return r
      let focused
      try {
        focused = await r.wc.executeJavaScript(PU.focusScript(selector), true)
      } catch (e) {
        return err('EVAL_FAILED', e && e.message)
      }
      if (!focused) return err('NOT_FOUND', 'Selector matched no element')
      // human: gaussian cadence + occasional typo→backspace→correct.
      if (human) {
        for (const step of HM.typoPlan(text, {})) {
          try {
            if (step.back) {
              r.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
              r.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
            } else {
              r.wc.sendInputEvent({ type: 'char', keyCode: step.key })
            }
          } catch (e) {
            return err('INPUT_FAILED', e && e.message)
          }
          await sleep(HM.gaussian(110, 30, undefined, 25, 380))
        }
        return { ok: true, typed: text.length, human: true }
      }
      const variance = Math.max(0, Math.min(Number(delayVarianceMs) || 0, 500))
      for (const ch of text) {
        try {
          r.wc.sendInputEvent({ type: 'char', keyCode: ch })
        } catch (e) {
          return err('INPUT_FAILED', e && e.message)
        }
        if (variance) await sleep(Math.floor(Math.random() * variance))
      }
      return { ok: true, typed: text.length, human: false }
    },

    /** Scroll the page: to = 'top' | 'bottom' | number of px.
     *  `human:true` with a numeric distance eases it into momentum steps. */
    async scroll({ identityId, tabId, to, human }) {
      if (human && typeof to === 'number') {
        const r = resolveWC(identityId, tabId)
        if (r.__error) return r
        try {
          for (const dy of HM.momentumSteps(to, { steps: 8 })) {
            await r.wc.executeJavaScript('window.scrollBy(0,' + dy + ')', true)
            await sleep(HM.gaussian(45, 15, undefined, 12, 130))
          }
          return {
            ok: true,
            human: true,
            result: await r.wc.executeJavaScript('window.scrollY', true),
          }
        } catch (e) {
          return err('EVAL_FAILED', e && e.message)
        }
      }
      return runJS(identityId, tabId, PU.scrollScript(to))
    },

    /** Poll until `selector` exists or `timeoutMs` elapses (default 5000). */
    async waitFor({ identityId, tabId, selector, timeoutMs }) {
      const r = resolveWC(identityId, tabId)
      if (r.__error) return r
      const budget = Math.max(0, Math.min(Number(timeoutMs) || 5000, 60000))
      if (!PU.isValidSelector(selector)) {
        await sleep(budget)
        return { ok: true, waited: budget }
      }
      const deadline = Date.now() + budget
      const script = PU.existsScript(selector)
      do {
        let found = false
        try {
          found = await r.wc.executeJavaScript(script, true)
        } catch (e) {
          return err('EVAL_FAILED', e && e.message)
        }
        if (found) return { ok: true, found: true }
        await sleep(150)
      } while (Date.now() < deadline)
      return err('TIMEOUT', `selector not found in ${budget}ms`)
    },

    /** Capture the tab viewport as a base64 PNG. */
    async screenshot({ identityId, tabId }) {
      const r = resolveWC(identityId, tabId)
      if (r.__error) return r
      try {
        const img = await r.wc.capturePage()
        return { ok: true, base64: img.toPNG().toString('base64'), mime: 'image/png' }
      } catch (e) {
        return err('CAPTURE_FAILED', e && e.message)
      }
    },

    /** Declarative extraction: schema {field: selector | {selector,attr}} → {field: value}. */
    extract({ identityId, tabId, schema }) {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return err('BAD_SCHEMA', 'schema must be an object of field→selector')
      }
      return runJS(identityId, tabId, PU.extractScript(schema))
    },
  }
}

module.exports = { buildPageHandlers }
