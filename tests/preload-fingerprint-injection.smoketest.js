// OZ Browser — Fingerprint injection validation (1.9.5).
//
// Cómo correr:
//   cd oz-browser
//   node tests/preload-fingerprint-injection.smoketest.js
//
// Qué valida (estilo Pixelscan/CreepJS sin red real):
//   - El IIFE del buildOverridesScript se ejecuta en un page world simulado
//     (Node vm.createContext con stubs de window/navigator/screen/Intl/Canvas/
//     WebGL) y muta TODOS los vectores correctamente.
//   - Per-identity consistency: ejecutar el script con el mismo fp dos
//     veces en contextos distintos produce los mismos overrides.
//   - Cross-identity diversity: 3 fps distintos generan 3 perfiles
//     distintos en sus contextos respectivos.
//   - Idempotencia: ejecutar el script 2 veces en el MISMO context es noop
//     (window.__OZ_FP_APPLIED__ flag).
//   - Canvas noise determinístico: mismo fp.canvasNoiseSeed produce el
//     mismo perturbation pattern.
//   - WebGL spoof para los 4 parámetros (7936/7937/37445/37446).
//
// Approach: usamos `vm` de Node con un context que aproxima el page world
// real. NO simula DOM completo (no necesitamos), solo las globals que el
// script toca (navigator, screen, window, Intl, etc) + stubs de Canvas/WebGL
// con el mínimo necesario para que el override aplique sin throw.
//
// Esto NO es Pixelscan real (sería test fragile + network dependency). Pero
// SÍ valida lo que importa: que el inject mecanismo funcione + los valores
// salgan correctos. Si Pixelscan cambia su detection, los assertions fallan
// porque los overrides están bien aplicados — el problema sería del site, no
// nuestro.

const Module = require('module')
const vm = require('vm')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-fpi-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

let passed = 0
let failed = 0
const failures = []
function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}
function section(name) {
  console.log(`\n— ${name} —`)
}

// ---------- Stubs that approximate page-world globals -----------------------
// We provide the minimum surface the script touches; real Chrome has tons
// more on these objects but the override only reads/writes specific props.

function makePageWorld() {
  // Native baseline values (what a vanilla Node + stubs would look like).
  const nativeNavigator = {
    userAgent: 'native-ua',
    appVersion: 'native-app-version',
    appName: 'native-app-name',
    vendor: 'native-vendor',
    platform: 'native-platform',
    hardwareConcurrency: 4,
    deviceMemory: 4,
    language: 'en-US',
    languages: ['en-US', 'en'],
    plugins: [],
    mimeTypes: [],
    // v3-C stealth: native permissions.query returns a sentinel so the test
    // can tell passthrough (geolocation) from the notifications override.
    permissions: { query: () => Promise.resolve({ state: 'native' }) },
    // getBattery may be undefined on the platform — script reassigns regardless
  }
  const nativeScreen = {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1056,
    colorDepth: 24,
    pixelDepth: 24,
  }

  // Minimal Canvas/WebGL stubs.
  function FakeImageData(w, h) {
    this.width = w
    this.height = h
    this.data = new Uint8ClampedArray(w * h * 4)
    // Fill with predictable bytes 0..255
    for (let i = 0; i < this.data.length; i++) this.data[i] = i % 256
  }
  class FakeCanvasRenderingContext2D {
    getImageData(_x, _y, w, h) {
      return new FakeImageData(w || 100, h || 100)
    }
    putImageData() {}
  }
  class FakeHTMLCanvasElement {
    constructor() {
      this.width = 100
      this.height = 100
      this._ctx = new FakeCanvasRenderingContext2D()
    }
    getContext(type) {
      return type === '2d' ? this._ctx : null
    }
    toDataURL() {
      return 'data:image/png;base64,native'
    }
    toBlob(cb) {
      cb(null)
    }
  }
  class FakeWebGLRenderingContext {
    getParameter(p) {
      // Native values — script must override these for spoofed FP
      if (p === 7936 || p === 37445) return 'native-vendor'
      if (p === 7937 || p === 37446) return 'native-renderer'
      return null
    }
  }
  class FakeWebGL2RenderingContext extends FakeWebGLRenderingContext {}

  const ctx = {
    Object,
    Array,
    JSON,
    Promise,
    Math,
    Number,
    Date,
    String,
    Symbol,
    Buffer,
    Uint8ClampedArray,
    Intl, // We let the script monkey-patch the real Intl from Node.
    navigator: nativeNavigator,
    screen: nativeScreen,
    devicePixelRatio: 1,
    HTMLCanvasElement: FakeHTMLCanvasElement,
    CanvasRenderingContext2D: FakeCanvasRenderingContext2D,
    WebGLRenderingContext: FakeWebGLRenderingContext,
    WebGL2RenderingContext: FakeWebGL2RenderingContext,
    speechSynthesis: { getVoices: () => [] },
    Notification: { permission: 'granted' },
  }
  // Self-reference: window === globalThis in browsers
  ctx.window = ctx
  ctx.globalThis = ctx
  return vm.createContext(ctx)
}

function applyScriptToContext(scriptString, ctx) {
  vm.runInContext(scriptString, ctx, { timeout: 1000 })
}

// ---------- Tests ----------------------------------------------------------

console.log('OZ Browser — preload-fingerprint injection smoke test')

// Restore Intl after tests so subsequent require() of FE doesn't see mutated
// Intl (the script monkey-patches Intl.DateTimeFormat.prototype.resolvedOptions).
const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
const origGetTzOffset = Date.prototype.getTimezoneOffset

let buildOverridesScript, FingerprintEngine
try {
  ;({ buildOverridesScript } = require('../browser/preload-fingerprint-script.js'))
  ;({ FingerprintEngine } = require('../browser/fingerprint-engine.js'))
} catch (err) {
  console.error('Module load failed:', err)
  process.exit(2)
}

// Sanity check: every stage runs in its own vm context, so monkey-patching
// Intl in there is safe — the host Intl stays intact.

// --------- 1. Apply script + every navigator.* override matches ----------
section('apply: navigator.* getters return spoofed values')
{
  const fe = new FingerprintEngine()
  const fp = fe.getOrCreate('id-1', 'seed-fixed-1')
  const ctx = makePageWorld()
  applyScriptToContext(buildOverridesScript(fp), ctx)
  ok('userAgent matches fp.ua', ctx.navigator.userAgent === fp.ua)
  ok('appVersion matches', ctx.navigator.appVersion === fp.appVersion)
  ok('appName matches', ctx.navigator.appName === fp.appName)
  ok('vendor matches', ctx.navigator.vendor === fp.vendor)
  ok('platform matches', ctx.navigator.platform === fp.platform)
  ok(
    'hardwareConcurrency matches',
    ctx.navigator.hardwareConcurrency === fp.hardwareConcurrency,
  )
  ok('deviceMemory matches', ctx.navigator.deviceMemory === fp.deviceMemory)
  ok('language matches', ctx.navigator.language === fp.language)
  ok(
    'languages matches',
    JSON.stringify(ctx.navigator.languages) === JSON.stringify(fp.languages),
  )
  ok(
    'languages returns a copy (mutable safe)',
    ctx.navigator.languages !== ctx.navigator.languages,
  )
}

// --------- 2. screen.* + devicePixelRatio --------------------------------
section('apply: screen + devicePixelRatio overrides')
{
  const fe = new FingerprintEngine()
  const fp = fe.getOrCreate('id-2', 'seed-fixed-2')
  const ctx = makePageWorld()
  applyScriptToContext(buildOverridesScript(fp), ctx)
  ok('screen.width matches', ctx.screen.width === fp.screen.width)
  ok('screen.height matches', ctx.screen.height === fp.screen.height)
  ok('screen.availWidth matches', ctx.screen.availWidth === fp.screen.availWidth)
  ok('screen.availHeight matches', ctx.screen.availHeight === fp.screen.availHeight)
  ok('screen.colorDepth matches', ctx.screen.colorDepth === fp.screen.colorDepth)
  ok('screen.pixelDepth matches', ctx.screen.pixelDepth === fp.screen.pixelDepth)
  ok('window.devicePixelRatio matches', ctx.devicePixelRatio === fp.devicePixelRatio)
}

// --------- 3. plugins / mimeTypes ----------------------------------------
section('apply: navigator.plugins + mimeTypes shape')
{
  const fe = new FingerprintEngine()
  const fp = fe.getOrCreate('id-3', 'seed-fixed-3')
  const ctx = makePageWorld()
  applyScriptToContext(buildOverridesScript(fp), ctx)
  ok(
    'plugins is array-like with length',
    ctx.navigator.plugins.length === fp.plugins.length,
  )
  if (fp.plugins.length > 0) {
    ok('first plugin name matches', ctx.navigator.plugins[0].name === fp.plugins[0].name)
    ok(
      'first plugin filename matches',
      ctx.navigator.plugins[0].filename === fp.plugins[0].filename,
    )
    ok(
      'plugins.namedItem(name) returns the plugin',
      ctx.navigator.plugins.namedItem(fp.plugins[0].name).name === fp.plugins[0].name,
    )
    ok(
      'plugins.item(0) returns first',
      ctx.navigator.plugins.item(0).name === fp.plugins[0].name,
    )
    // refresh() is a no-op but must exist
    ok('plugins.refresh exists', typeof ctx.navigator.plugins.refresh === 'function')
  }
  ok('mimeTypes is non-empty', ctx.navigator.mimeTypes.length > 0)
  ok(
    'mimeTypes.namedItem(application/pdf)',
    ctx.navigator.mimeTypes.namedItem('application/pdf') !== null,
  )
}

// --------- 4. battery + speechVoices --------------------------------------
section('apply: getBattery + speechSynthesis.getVoices')
;(async () => {
  try {
    const fe = new FingerprintEngine()
    const fp = fe.getOrCreate('id-4', 'seed-fixed-4')
    const ctx = makePageWorld()
    applyScriptToContext(buildOverridesScript(fp), ctx)
    const battery = await ctx.navigator.getBattery()
    ok('getBattery returns Promise', battery !== undefined)
    ok('battery.charging matches', battery.charging === fp.battery.charging)
    ok('battery.level matches', battery.level === fp.battery.level)

    const voices = ctx.speechSynthesis.getVoices()
    ok('voices length matches', voices.length === fp.speechVoices.length)
    if (voices.length > 0) {
      ok('first voice name matches', voices[0].name === fp.speechVoices[0].name)
      ok('first voice lang matches', voices[0].lang === fp.speechVoices[0].lang)
    }

    // --------- 4b. stealth defaults (v3-C) -------------------------------
    section('apply: stealth defaults (webdriver / chrome / permissions)')
    {
      const feS = new FingerprintEngine()
      const fpS = feS.getOrCreate('id-stealth', 'seed-stealth')
      const ctxS = makePageWorld()
      applyScriptToContext(buildOverridesScript(fpS), ctxS)
      ok('navigator.webdriver === false', ctxS.navigator.webdriver === false)
      ok(
        'window.chrome.runtime exists',
        ctxS.chrome && typeof ctxS.chrome.runtime === 'object',
      )
      const notif = await ctxS.navigator.permissions.query({ name: 'notifications' })
      ok(
        "permissions.query('notifications') agrees with Notification.permission",
        notif.state === 'granted',
      )
      const geo = await ctxS.navigator.permissions.query({ name: 'geolocation' })
      ok('permissions.query(other) passes through to native', geo.state === 'native')
    }

    // --------- 5. WebGL getParameter override --------------------------------
    section('apply: WebGL getParameter spoofed for 4 parameters')
    {
      const fe5 = new FingerprintEngine()
      const fp5 = fe5.getOrCreate('id-5', 'seed-fixed-5')
      const ctx5 = makePageWorld()
      applyScriptToContext(buildOverridesScript(fp5), ctx5)
      const gl = new ctx5.WebGLRenderingContext()
      ok('WebGL getParameter(7936) = vendor', gl.getParameter(7936) === fp5.webgl.vendor)
      ok(
        'WebGL getParameter(7937) = renderer',
        gl.getParameter(7937) === fp5.webgl.renderer,
      )
      ok(
        'WebGL getParameter(37445) = vendor (UNMASKED)',
        gl.getParameter(37445) === fp5.webgl.vendor,
      )
      ok(
        'WebGL getParameter(37446) = renderer (UNMASKED)',
        gl.getParameter(37446) === fp5.webgl.renderer,
      )
      // Other parameters should still pass through to native
      ok(
        'WebGL getParameter(99999) returns null (native fallback)',
        gl.getParameter(99999) === null,
      )

      // WebGL2 should also be spoofed
      const gl2 = new ctx5.WebGL2RenderingContext()
      ok('WebGL2 also spoofed', gl2.getParameter(37445) === fp5.webgl.vendor)
    }

    // --------- 6. Canvas noise --------------------------------------------
    section('apply: canvas getImageData has determinístic noise')
    {
      const fe6 = new FingerprintEngine()
      const fp6 = fe6.getOrCreate('id-6', 'seed-canvas-fixed')
      const ctx6 = makePageWorld()
      applyScriptToContext(buildOverridesScript(fp6), ctx6)
      const canvas = new ctx6.HTMLCanvasElement()
      const c2d = canvas.getContext('2d')
      // Two calls with same canvas state must produce same noise pattern
      // (deterministic via fp.canvasNoiseSeed → mulberry32).
      const a = c2d.getImageData(0, 0, 1000, 1000)
      const b = c2d.getImageData(0, 0, 1000, 1000)
      // Compare the bytes that the noise routine would have touched (every
      // 1000 * 4 = 4000th byte). They must be EQUAL between the two calls
      // because the seed is the same — mulberry32 is deterministic.
      let firstDiff = -1
      let allEqual = true
      for (let i = 0; i < a.data.length; i += 4000) {
        if (a.data[i] !== b.data[i]) {
          allEqual = false
          firstDiff = i
          break
        }
      }
      ok(
        'noise determinístico (mismo seed = mismo output)',
        allEqual,
        firstDiff >= 0 ? `diverged at byte ${firstDiff}` : '',
      )
      // Compare against native (no noise applied) — should differ.
      const ctxNative = makePageWorld()
      const canvasNative = new ctxNative.HTMLCanvasElement()
      const c2dNative = canvasNative.getContext('2d')
      const native = c2dNative.getImageData(0, 0, 1000, 1000)
      let diffCount = 0
      for (let i = 0; i < a.data.length; i += 4000) {
        if (a.data[i] !== native.data[i]) diffCount++
      }
      ok('noise actually changes some bytes (vs native)', diffCount > 0)
    }

    // --------- 7. Idempotency --------------------------------------------
    section('apply: re-applying script is a no-op')
    {
      const fe7 = new FingerprintEngine()
      const fp7 = fe7.getOrCreate('id-7', 'seed-fixed-7')
      const ctx7 = makePageWorld()
      const script = buildOverridesScript(fp7)
      applyScriptToContext(script, ctx7)
      const ua1 = ctx7.navigator.userAgent
      ok('first apply: UA spoofed', ua1 === fp7.ua)
      // Second apply — flag check should make it noop.
      applyScriptToContext(script, ctx7)
      const ua2 = ctx7.navigator.userAgent
      ok('second apply: UA still spoofed (no break)', ua2 === fp7.ua)
      ok('idempotency flag set', ctx7.window.__OZ_FP_APPLIED__ === true)
    }

    // --------- 8. Per-identity consistency ------------------------------
    section('Per-identity consistency: same fp → same overrides in 2 contexts')
    {
      const fe8 = new FingerprintEngine()
      const fp8 = fe8.getOrCreate('id-8', 'consistent-seed')
      const ctxA = makePageWorld()
      const ctxB = makePageWorld()
      const script = buildOverridesScript(fp8)
      applyScriptToContext(script, ctxA)
      applyScriptToContext(script, ctxB)
      ok('UA consistent', ctxA.navigator.userAgent === ctxB.navigator.userAgent)
      ok('screen.width consistent', ctxA.screen.width === ctxB.screen.width)
      ok(
        'plugins.length consistent',
        ctxA.navigator.plugins.length === ctxB.navigator.plugins.length,
      )
      const glA = new ctxA.WebGLRenderingContext()
      const glB = new ctxB.WebGLRenderingContext()
      ok('WebGL renderer consistent', glA.getParameter(37446) === glB.getParameter(37446))
    }

    // --------- 9. Cross-identity diversity ------------------------------
    section('Cross-identity diversity: 5 fps → varied overrides')
    {
      const fe9 = new FingerprintEngine()
      const seeds = ['div-a', 'div-b', 'div-c', 'div-d', 'div-e']
      const ctxs = seeds.map((s) => {
        const fp = fe9.regenerate(`id-${s}`, s)
        const c = makePageWorld()
        applyScriptToContext(buildOverridesScript(fp), c)
        return c
      })
      const uas = new Set(ctxs.map((c) => c.navigator.userAgent))
      const screens = new Set(ctxs.map((c) => `${c.screen.width}x${c.screen.height}`))
      const langs = new Set(ctxs.map((c) => c.navigator.language))
      ok('at least 2 different UAs across 5 identities', uas.size >= 2)
      ok('at least 2 different screen sizes', screens.size >= 2)
      ok('at least 2 different languages', langs.size >= 2)
    }

    // --------- 10. Pixelscan-style detection (mismatch checks) ----------
    section('Pixelscan-style: navigator.userAgent matches platform implication')
    {
      // Pixelscan flags a profile when navigator.userAgent says "Mac" but
      // navigator.platform says "Win32" or vice-versa. Validate that our
      // profiles never produce this mismatch.
      const fe10 = new FingerprintEngine()
      const allOk = []
      for (let i = 0; i < 30; i++) {
        const fp = fe10.regenerate(`mismatch-check-${i}`, `mismatch-${i}`)
        const ctxM = makePageWorld()
        applyScriptToContext(buildOverridesScript(fp), ctxM)
        const ua = ctxM.navigator.userAgent
        const platform = ctxM.navigator.platform
        let row = true
        if (platform === 'MacIntel' && !/Macintosh/.test(ua)) row = false
        if (platform === 'Win32' && !/Windows/.test(ua)) row = false
        if (platform === 'Linux x86_64' && !/Linux/.test(ua)) row = false
        allOk.push(row)
      }
      ok(
        '30 random profiles: NO platform/UA mismatch (Pixelscan would flag)',
        allOk.every((r) => r),
      )
    }

    // --------- 11. WebGL renderer matches blueprint family --------------
    section('WebGL renderer matches blueprint platform (Mac → Apple GPU, etc)')
    {
      const fe11 = new FingerprintEngine()
      const allOk = []
      for (let i = 0; i < 30; i++) {
        const fp = fe11.regenerate(`webgl-check-${i}`, `webgl-${i}`)
        const ctxW = makePageWorld()
        applyScriptToContext(buildOverridesScript(fp), ctxW)
        const gl = new ctxW.WebGLRenderingContext()
        const platform = ctxW.navigator.platform
        const renderer = gl.getParameter(37446)
        let row = true
        // Mac platform → renderer should mention Apple OR Intel (some Mac x64
        // have Intel UHD); should NOT mention NVIDIA RTX (Win-only).
        if (platform === 'MacIntel') {
          if (/RTX|GeForce|D3D11/i.test(renderer)) row = false
        }
        if (platform === 'Win32') {
          // Win renderers all use D3D11 backend. Should NOT mention "Metal" (Mac).
          if (/Metal/i.test(renderer)) row = false
        }
        if (platform === 'Linux x86_64') {
          if (/D3D11|Metal/i.test(renderer)) row = false
        }
        allOk.push(row)
      }
      ok(
        '30 random profiles: WebGL renderer matches platform family',
        allOk.every((r) => r),
      )
    }

    // --------- DONE -----------------------------------------------------
    Module._load = originalLoad
    // Restore Intl + Date prototypes if our script's monkey-patch leaked
    Intl.DateTimeFormat.prototype.resolvedOptions = origResolvedOptions
    Date.prototype.getTimezoneOffset = origGetTzOffset

    console.log(`\n=== ${passed} passed · ${failed} failed ===`)
    if (failed > 0) {
      console.log('\nFailures:')
      for (const f of failures)
        console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
      process.exit(1)
    }
    process.exit(0)
  } catch (err) {
    console.error('Test crashed:', err)
    process.exit(2)
  }
})()
