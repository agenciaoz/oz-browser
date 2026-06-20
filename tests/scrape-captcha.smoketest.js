// OZ Browser — scrape-captcha helpers smoke test (V3-D).
//
// Run:
//   cd oz-browser
//   node tests/scrape-captcha.smoketest.js
//
// Covers the static scanner string + the pure result classifier (no DOM).

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/scrape-captcha.js')]
const SC = require(path.join('..', 'browser', 'scrape-captcha.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('scrape-captcha smoke test')

// ---- detectCaptchaScript: it's a static, injection-free snippet -----------

ok('detectCaptchaScript: returns a non-empty IIFE string', () => {
  const s = SC.detectCaptchaScript()
  assert.strictEqual(typeof s, 'string')
  assert.ok(s.startsWith('(function(){'), 'is an IIFE')
  assert.ok(s.trim().endsWith('})()'), 'closes the IIFE')
})

ok('detectCaptchaScript: covers the major sentinels', () => {
  const s = SC.detectCaptchaScript()
  for (const needle of [
    'recaptcha',
    'hcaptcha',
    'cf-turnstile',
    'challenges.cloudflare.com',
    'captcha-delivery.com',
    'px-captcha',
  ]) {
    assert.ok(s.includes(needle), 'mentions ' + needle)
  }
})

ok(
  'detectCaptchaScript: is evaluable JS (parses) and detects nothing on empty DOM',
  () => {
    // Provide a tiny DOM-less shim so the snippet runs in plain node.
    const sandbox = {
      document: {
        querySelector: () => null,
        title: '',
        body: { innerText: '' },
        documentElement: { innerHTML: '' },
      },
      window: {},
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'window', 'return ' + SC.detectCaptchaScript())
    const r = fn(sandbox.document, sandbox.window)
    assert.strictEqual(r.detected, false)
    assert.deepStrictEqual(r.types, [])
  },
)

ok('detectCaptchaScript: flags a reCAPTCHA-like DOM', () => {
  const sandbox = {
    document: {
      querySelector: (sel) => (sel === '.g-recaptcha' ? {} : null),
      title: '',
      body: { innerText: '' },
      documentElement: { innerHTML: '' },
    },
    window: {},
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'return ' + SC.detectCaptchaScript())
  const r = fn(sandbox.document, sandbox.window)
  assert.strictEqual(r.detected, true)
  assert.ok(r.types.includes('recaptcha'))
})

ok('detectCaptchaScript: flags Cloudflare "Just a moment..." title', () => {
  const sandbox = {
    document: {
      querySelector: () => null,
      title: 'Just a moment...',
      body: { innerText: '' },
      documentElement: { innerHTML: '' },
    },
    window: {},
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'return ' + SC.detectCaptchaScript())
  const r = fn(sandbox.document, sandbox.window)
  assert.strictEqual(r.detected, true)
  assert.ok(r.types.includes('cloudflare'))
})

// ---- classifyCaptchaResult: pure normalizer -------------------------------

ok('classify: null/garbage → not detected', () => {
  for (const bad of [null, undefined, 42, 'x', {}]) {
    const r = SC.classifyCaptchaResult(bad)
    assert.strictEqual(r.detected, false)
    assert.strictEqual(r.primaryType, null)
  }
})

ok('classify: dedupes types + picks priority primaryType', () => {
  const r = SC.classifyCaptchaResult({
    types: ['recaptcha', 'recaptcha', 'cloudflare'],
    signals: ['recaptcha', 'cf-challenge'],
  })
  assert.strictEqual(r.detected, true)
  assert.deepStrictEqual(r.types, ['recaptcha', 'cloudflare'])
  // cloudflare outranks recaptcha in TYPE_PRIORITY
  assert.strictEqual(r.primaryType, 'cloudflare')
})

ok('classify: unknown type still yields a primaryType (first)', () => {
  const r = SC.classifyCaptchaResult({ types: ['weirdbot'], signals: [] })
  assert.strictEqual(r.detected, true)
  assert.strictEqual(r.primaryType, 'weirdbot')
})

ok('classify: filters junk entries from arrays', () => {
  const r = SC.classifyCaptchaResult({
    types: ['hcaptcha', '', null, 3, '  '],
    signals: ['hcaptcha', null, 7],
  })
  assert.deepStrictEqual(r.types, ['hcaptcha'])
  assert.deepStrictEqual(r.signals, ['hcaptcha'])
  assert.strictEqual(r.primaryType, 'hcaptcha')
})

console.log(`\n✓ scrape-captcha: ${passed} checks passed`)
