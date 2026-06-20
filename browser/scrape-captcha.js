// OZ Browser — Captcha detection helpers (V3-D, scraping/agent-control).
//
// Política: DETECTAR + ALERTAR, NUNCA resolver (zona gris legal — ver
// docs/PLAN-V3-SCRAPING.md §4). El agente llama oz.page.captcha tras navegar;
// si hay captcha/challenge, OZ levanta una alerta urgente y el agente decide
// (pausar, rotar identity, avisar a Jose). Resolver queda fuera de scope.
//
// Dos piezas PURAS (sin Electron/DOM en este archivo):
//   - detectCaptchaScript(): devuelve un snippet ESTÁTICO (cero input del
//     usuario → injection-free) que se inyecta vía executeJavaScript y escanea
//     el DOM en busca de sentinels de los anti-bot más comunes.
//   - classifyCaptchaResult(raw): normaliza/saneal el objeto que devuelve el
//     snippet a una forma estable {detected, types, signals, primaryType}.
//
// La ejecución DOM vive en page-handlers.js; el catálogo MCP en mcp-tools-page.js.
// ADR: 0036 (page-control) · 0005 (modular).

'use strict'

// Orden de prioridad para elegir el primaryType cuando hay varios sentinels.
const TYPE_PRIORITY = [
  'cloudflare',
  'datadome',
  'perimeterx',
  'recaptcha',
  'hcaptcha',
  'turnstile',
  'generic',
]

/**
 * Build the static in-page scanner. No interpolation of caller data → safe to
 * inject verbatim. Returns an object literal { detected, types, signals }.
 *
 * Sentinels cover: Cloudflare challenge/Turnstile, DataDome, PerimeterX/HUMAN,
 * Google reCAPTCHA, hCaptcha, and a generic human-verification text fallback.
 */
function detectCaptchaScript() {
  return (
    '(function(){' +
    'try{' +
    'var types=[];var signals=[];' +
    'function has(sel){try{return !!document.querySelector(sel);}catch(e){return false;}}' +
    'function mark(t,s){if(types.indexOf(t)<0)types.push(t);signals.push(s);}' +
    // reCAPTCHA
    "if(has('.g-recaptcha')||has('iframe[src*=\"recaptcha\"]')||has('iframe[src*=\"google.com/recaptcha\"]')||(typeof window.grecaptcha!=='undefined'))mark('recaptcha','recaptcha');" +
    // hCaptcha
    "if(has('.h-captcha')||has('iframe[src*=\"hcaptcha.com\"]')||(typeof window.hcaptcha!=='undefined'))mark('hcaptcha','hcaptcha');" +
    // Cloudflare Turnstile
    "if(has('.cf-turnstile')||has('iframe[src*=\"challenges.cloudflare.com\"]'))mark('turnstile','turnstile');" +
    // Cloudflare interstitial challenge ("Just a moment...")
    "if(has('#challenge-running')||has('#cf-challenge-running')||has('#challenge-form')||/just a moment/i.test(document.title))mark('cloudflare','cf-challenge');" +
    // DataDome
    "if(has('iframe[src*=\"captcha-delivery.com\"]')||has('#datadome')||has('[id^=\"datadome\"]'))mark('datadome','datadome');" +
    // PerimeterX / HUMAN
    "if(has('#px-captcha')||has('[id^=\"px-\"]')&&/perimeterx|human-challenge/i.test(document.documentElement.innerHTML.slice(0,4000)))mark('perimeterx','perimeterx');" +
    // Generic human-verification text (last resort, body-scoped + bounded)
    'var bt=((document.body&&document.body.innerText)||"").slice(0,4000);' +
    "if(/verify (you are|you're) (a )?human|are you a robot|unusual traffic|complete the security check|enable javascript and cookies to continue/i.test(bt))mark('generic','text');" +
    'return {detected:types.length>0,types:types,signals:signals};' +
    '}catch(e){return {detected:false,types:[],signals:[],error:String(e&&e.message||e)};}' +
    '})()'
  )
}

/**
 * Normalize the raw scanner result into a stable shape. Defensive: tolerates
 * null/garbage (returns a not-detected result) and dedupes types.
 *
 * @param {any} raw
 * @returns {{detected:boolean, types:string[], signals:string[], primaryType:string|null}}
 */
function classifyCaptchaResult(raw) {
  const empty = { detected: false, types: [], signals: [], primaryType: null }
  if (!raw || typeof raw !== 'object') return empty

  const types = Array.isArray(raw.types)
    ? raw.types.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : []
  const uniqueTypes = []
  for (const t of types) if (uniqueTypes.indexOf(t) < 0) uniqueTypes.push(t)

  const signals = Array.isArray(raw.signals)
    ? raw.signals.filter((s) => typeof s === 'string' && s.trim())
    : []

  const detected = uniqueTypes.length > 0
  if (!detected) return empty

  let primaryType = null
  for (const t of TYPE_PRIORITY) {
    if (uniqueTypes.indexOf(t) >= 0) {
      primaryType = t
      break
    }
  }
  if (!primaryType) primaryType = uniqueTypes[0]

  return { detected: true, types: uniqueTypes, signals, primaryType }
}

module.exports = { detectCaptchaScript, classifyCaptchaResult, TYPE_PRIORITY }
