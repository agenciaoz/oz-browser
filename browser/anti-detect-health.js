// OZ Browser — Anti-Detect Health (E2-C-6).
//
// Qué hace: lógica pura que evalúa la salud anti-detect de UNA identity en
// 4 vectores: IP↔timezone, fingerprint coherence, cookie health, proxy
// reachability. Devuelve un health record con status por vector
// (red/yellow/green/unknown), summary humano, detalles auditables y un fix
// inline opcional.
//
// Por qué módulo PURO (sin Electron, sin fs):
//   - 100% testeable sync sin GUI/main process boot.
//   - Mismo handler usado por IPC + MCP + cualquier callsite futuro
//     (digest cron, automation, etc).
//   - El handler-wrapper (anti-detect-health-handlers.js) inyecta
//     identityManager/proxyAssignment/proxyManager/fingerprintEngine + lee
//     cookies vía session.cookies.get(), después llama acá.
//
// Doc: docs/modules/anti-detect-health.md
// ADRs: 0005 (modular 500 LOC), 0017 (proxy model), 0018 (fingerprint engine).
//
// Exports:
//   evaluateHealth(state) → health record (ver shape abajo)
//   STATUSES, FIX_KINDS, RANK
//   evaluateIpTimezone, evaluateFingerprintCoherence,
//   evaluateCookieHealth, evaluateProxyReachability   (per-vector, expuesto
//                                                      para tests granulares)
//
// Health record shape:
//   {
//     identityId,
//     evaluatedAt,
//     overall: 'red'|'yellow'|'green',     // peor de los 4 (unknown ≈ green)
//     vectors: {
//       ipTimezone:           { status, summary, details, fix },
//       fingerprintCoherence: { status, summary, details, fix },
//       cookieHealth:         { status, summary, details, fix },
//       proxyReachability:    { status, summary, details, fix },
//     },
//   }
//
// Status semantics:
//   green   → ok, nada que hacer
//   yellow  → revisar, no urgente (ej: proxy nunca testeado, cookies
//             empezando a expirar)
//   red     → riesgo anti-detect inmediato (ej: TZ Madrid + proxy en JP)
//   unknown → no hay datos suficientes para evaluar (ej: identity sin
//             proxy ⇒ proxyReachability=unknown ≠ red, porque "no proxy"
//             es una elección válida = direct connection).

const { resolveCountry } = require('./country-locale')

const STATUSES = Object.freeze({
  GREEN: 'green',
  YELLOW: 'yellow',
  RED: 'red',
  UNKNOWN: 'unknown',
})

// Worst status wins for `overall`. unknown counts as green (no signal).
const RANK = Object.freeze({
  green: 0,
  unknown: 0,
  yellow: 1,
  red: 2,
})

// Inline-action kinds the UI knows how to invoke. Each is wired by the
// handler module (anti-detect-health-handlers.js) to a real mutation.
const FIX_KINDS = Object.freeze({
  REROLL_FP: 'reroll-fingerprint',
  APPLY_GEO: 'apply-geo-suggestion',
  REASSIGN_PROXY: 'reassign-proxy',
  TEST_PROXY: 'test-proxy',
  MARK_RELOGIN: 'mark-cookies-for-relogin',
})

// Thresholds — kept here so they're tweakable without spreading magic
// numbers across the module + tests can lock them down.
const COOKIE_EXPIRED_RED_RATIO = 0.5 // >50% expired → red
const COOKIE_EXPIRED_YELLOW_RATIO = 0.2 // >20% expired → yellow
const PROXY_STALE_MS = 24 * 60 * 60 * 1000 // last test >24h → yellow

// ============================================================================
// Top-level entry — combines the 4 vectors.
// ============================================================================

/**
 * Evaluate anti-detect health for one identity.
 *
 * @param {object} state
 * @param {object} state.identity            Identity record (id, name, ...).
 * @param {object|null} state.fingerprint    FingerprintEngine.get(id) output, or null.
 * @param {object|null} state.proxy          ProxyAssignment.resolve({identityId}) result, or null.
 * @param {Array<object>|null} state.cookies session.cookies.get({}) for the identity, or null.
 * @param {number} [state.now]               Date.now() — injectable for tests.
 * @returns {object} Health record (see file header).
 */
function evaluateHealth(state) {
  const { identity, fingerprint, proxy, cookies } = state || {}
  const now = (state && state.now) || Date.now()
  if (!identity || !identity.id) {
    throw new Error('anti-detect-health.evaluateHealth: identity.id required')
  }

  const ipTimezone = evaluateIpTimezone({ fingerprint, proxy })
  const fingerprintCoherence = evaluateFingerprintCoherence({ fingerprint })
  const cookieHealth = evaluateCookieHealth({ cookies, now })
  const proxyReachability = evaluateProxyReachability({ proxy, now })

  const overall = worstOf([
    ipTimezone.status,
    fingerprintCoherence.status,
    cookieHealth.status,
    proxyReachability.status,
  ])

  return {
    identityId: identity.id,
    evaluatedAt: now,
    overall,
    vectors: {
      ipTimezone,
      fingerprintCoherence,
      cookieHealth,
      proxyReachability,
    },
  }
}

function worstOf(statuses) {
  let worst = STATUSES.GREEN
  for (const s of statuses) {
    if ((RANK[s] || 0) > (RANK[worst] || 0)) worst = s
  }
  // Normalize unknown → green for overall (no signal ≠ bad).
  if (worst === STATUSES.UNKNOWN) return STATUSES.GREEN
  return worst
}

// ============================================================================
// Vector 1 — IP ↔ timezone match
// ============================================================================
// Compara el country del proxy contra el timezone del fingerprint. Mismatch
// fuerte (continentes distintos) es la huella anti-bot más obvia que existe.
//
// Lógica:
//   - sin proxy → unknown (direct connection — el browser usa su TZ real,
//     no es "anti-detect risk" porque el sitio no tiene incoherencia entre
//     IP geo y JS-reported TZ).
//   - sin proxy.country o country no en COUNTRY_LOCALES → unknown (no
//     podemos juzgar — peor sería falso positivo).
//   - sin fingerprint → unknown (el FP engine genera al primer use; antes
//     de eso el browser usa el TZ del OS, ese estado raramente persiste).
//   - country resuelve a TZ X, fingerprint TZ === X → green.
//   - mismo continente (prefix antes del primer '/') → yellow ("close
//     enough" — Buenos Aires vs Sao Paulo no es bandera roja, los users
//     viajan).
//   - continente distinto → red.

function evaluateIpTimezone({ fingerprint, proxy }) {
  if (!proxy) {
    return mkVector(STATUSES.UNKNOWN, 'No proxy assigned (direct connection).', {
      reason: 'no-proxy',
    })
  }
  if (!proxy.country) {
    return mkVector(STATUSES.UNKNOWN, 'Proxy has no country tag.', {
      reason: 'no-country',
      proxyId: proxy.id,
    })
  }
  if (!fingerprint || !fingerprint.timezone) {
    return mkVector(STATUSES.UNKNOWN, 'Fingerprint not generated yet.', {
      reason: 'no-fingerprint',
    })
  }
  const expected = resolveCountry(proxy.country)
  if (!expected) {
    return mkVector(
      STATUSES.UNKNOWN,
      `Country code "${proxy.country}" not in lookup table.`,
      { reason: 'unknown-country', country: proxy.country },
    )
  }

  const fpTz = fingerprint.timezone
  const expectedTz = expected.timezone
  const details = {
    proxyCountry: proxy.country,
    expectedTimezone: expectedTz,
    actualTimezone: fpTz,
  }

  if (fpTz === expectedTz) {
    return mkVector(STATUSES.GREEN, `Timezone matches proxy country (${fpTz}).`, details)
  }

  // Same continent? (rough but cheap heuristic — IANA TZs always start
  // with continent/region.)
  const fpContinent = String(fpTz).split('/')[0]
  const expContinent = expectedTz.split('/')[0]
  if (fpContinent && fpContinent === expContinent) {
    return mkVector(
      STATUSES.YELLOW,
      `Timezone (${fpTz}) is in the same region as proxy (${expectedTz}) but not exact.`,
      details,
      mkFix(FIX_KINDS.APPLY_GEO, `Apply ${expectedTz} timezone to fingerprint`),
    )
  }

  return mkVector(
    STATUSES.RED,
    `Timezone (${fpTz}) is in a different continent than proxy ${proxy.country} (${expectedTz}).`,
    details,
    mkFix(FIX_KINDS.APPLY_GEO, `Apply ${expectedTz} timezone to fingerprint`),
  )
}

// ============================================================================
// Vector 2 — Fingerprint coherence (internal cross-check)
// ============================================================================
// El FingerprintEngine ya genera blueprints coherentes por construcción
// (un Mac M2 no obtiene WebGL de NVIDIA). Pero applyGeoSuggestion() o un
// mutate manual via MCP pueden romper la coherencia. Verificamos:
//   - Platform vs UA (MacIntel ⇒ UA debe contener "Mac"; Win32 ⇒ "Windows")
//   - Platform vs WebGL renderer (Win ⇒ no "Apple"/"Metal"; Mac ⇒ no
//     "NVIDIA"/"AMD" en general; Linux ⇒ permisivo)
//   - Languages vs locale (locale='es-AR' ⇒ languages[0] debe empezar con 'es')
//
// Devuelve red en mismatches duros (UA ≠ platform), yellow en blandos
// (locale + languages incoherentes pero no fatal).

function evaluateFingerprintCoherence({ fingerprint }) {
  if (!fingerprint) {
    return mkVector(STATUSES.UNKNOWN, 'Fingerprint not generated yet.', {
      reason: 'no-fingerprint',
    })
  }
  const issues = []
  const ua = String(fingerprint.ua || '')
  const platform = String(fingerprint.platform || '')
  const webglRenderer =
    fingerprint.webgl && fingerprint.webgl.renderer
      ? String(fingerprint.webgl.renderer)
      : ''
  const locale = String(fingerprint.locale || '')
  const languages = Array.isArray(fingerprint.languages) ? fingerprint.languages : []

  // Platform vs UA
  if (platform === 'MacIntel' && !/Mac OS X|Macintosh/i.test(ua)) {
    issues.push({
      severity: 'red',
      msg: 'Platform claims MacIntel but UA is not Mac.',
    })
  }
  if (platform === 'Win32' && !/Windows/i.test(ua)) {
    issues.push({
      severity: 'red',
      msg: 'Platform claims Win32 but UA is not Windows.',
    })
  }
  if (platform === 'Linux x86_64' && !/Linux/i.test(ua)) {
    issues.push({
      severity: 'red',
      msg: 'Platform claims Linux but UA is not Linux.',
    })
  }

  // Platform vs WebGL renderer
  if (webglRenderer) {
    if (platform === 'Win32' && /Apple|Metal/i.test(webglRenderer)) {
      issues.push({
        severity: 'red',
        msg: 'Windows platform but WebGL renderer claims Apple/Metal.',
      })
    }
    if (platform === 'MacIntel' && /NVIDIA|AMD Radeon|D3D11/i.test(webglRenderer)) {
      issues.push({
        severity: 'red',
        msg: 'Mac platform but WebGL renderer is non-Apple GPU/D3D11.',
      })
    }
  }

  // Locale vs languages (yellow — minor inconsistency)
  if (locale && languages.length > 0) {
    const localeLang = locale.split('-')[0]
    const firstLang = String(languages[0]).split('-')[0]
    if (localeLang && firstLang && localeLang !== firstLang) {
      issues.push({
        severity: 'yellow',
        msg: `Locale ${locale} but languages[0]=${languages[0]} (different language).`,
      })
    }
  }

  if (issues.length === 0) {
    return mkVector(STATUSES.GREEN, 'Fingerprint vectors are internally coherent.', {
      blueprintId: fingerprint.blueprintId,
    })
  }

  const hasRed = issues.some((i) => i.severity === 'red')
  const status = hasRed ? STATUSES.RED : STATUSES.YELLOW
  const summary = issues.map((i) => i.msg).join(' ')
  return mkVector(
    status,
    summary,
    { blueprintId: fingerprint.blueprintId, issues },
    mkFix(FIX_KINDS.REROLL_FP, 'Re-roll fingerprint (fresh blueprint)'),
  )
}

// ============================================================================
// Vector 3 — Cookie health
// ============================================================================
// Lee el set de cookies de la identity y mide ratio de cookies expiradas o
// próximas a expirar. Cookies "session" (sin expirationDate) se cuentan
// como vigentes — vencen al cerrar el browser, no al pasar tiempo.
//
//   - sin cookies → unknown (identity nueva, normal)
//   - 0 cookies → unknown (mismo)
//   - >50% expiradas → red ("muchas cuentas necesitan re-login")
//   - >20% expiradas → yellow
//   - else → green

function evaluateCookieHealth({ cookies, now }) {
  if (!Array.isArray(cookies)) {
    return mkVector(STATUSES.UNKNOWN, 'Cookies not yet inspected.', {
      reason: 'no-cookies-data',
    })
  }
  if (cookies.length === 0) {
    return mkVector(STATUSES.UNKNOWN, 'No cookies stored for this identity.', {
      total: 0,
    })
  }
  const nowSec = Math.floor((now || Date.now()) / 1000)
  let expired = 0
  let session = 0
  let active = 0
  for (const c of cookies) {
    if (!c) continue
    if (c.session || !c.expirationDate) {
      session += 1
      continue
    }
    if (Number(c.expirationDate) < nowSec) {
      expired += 1
    } else {
      active += 1
    }
  }
  const total = cookies.length
  const persistent = expired + active
  // Ratio is over PERSISTENT cookies — session cookies aren't "expirable",
  // they're the user's live login that vanishes on browser quit.
  const ratio = persistent > 0 ? expired / persistent : 0

  const details = { total, session, active, expired, ratio: round2(ratio) }

  if (persistent === 0) {
    // All session cookies — no expiry signal to read.
    return mkVector(STATUSES.GREEN, `${total} session cookies, none persistent.`, details)
  }
  if (ratio >= COOKIE_EXPIRED_RED_RATIO) {
    return mkVector(
      STATUSES.RED,
      `${expired}/${persistent} persistent cookies expired (${pct(ratio)}). Many accounts likely need re-login.`,
      details,
      mkFix(
        FIX_KINDS.MARK_RELOGIN,
        'Clear expired cookies + flag accounts needing re-login',
      ),
    )
  }
  if (ratio >= COOKIE_EXPIRED_YELLOW_RATIO) {
    return mkVector(
      STATUSES.YELLOW,
      `${expired}/${persistent} persistent cookies expired (${pct(ratio)}).`,
      details,
      mkFix(FIX_KINDS.MARK_RELOGIN, 'Clear expired cookies'),
    )
  }
  return mkVector(
    STATUSES.GREEN,
    `${active} active, ${session} session, ${expired} expired.`,
    details,
  )
}

// ============================================================================
// Vector 4 — Proxy reachability
// ============================================================================
// Usa el estado del ProxyManager (lastTestedAt, failureCount, isDisabled)
// que el ProxyHealth daemon ya mantiene. NO ejecuta probe — el daemon corre
// cada 30 min, alcanza para v1.
//
//   - sin proxy → unknown (direct connection, no es bug)
//   - proxy.isDisabled → red (3 fails consecutivos detectados por daemon)
//   - sin lastTestedAt → yellow ("never tested")
//   - lastTestedAt > 24h → yellow ("stale")
//   - failureCount > 0 → yellow ("recent failures")
//   - else → green

function evaluateProxyReachability({ proxy, now }) {
  if (!proxy) {
    return mkVector(STATUSES.UNKNOWN, 'No proxy assigned (direct connection).', {
      reason: 'no-proxy',
    })
  }
  const details = {
    proxyId: proxy.id,
    name: proxy.name,
    host: proxy.host,
    port: proxy.port,
    lastTestedAt: proxy.lastTestedAt || null,
    lastLatencyMs: proxy.lastLatencyMs || null,
    failureCount: proxy.failureCount || 0,
    isDisabled: !!proxy.isDisabled,
  }

  if (proxy.isDisabled) {
    return mkVector(
      STATUSES.RED,
      `Proxy "${proxy.name || proxy.host}" is auto-disabled (3+ failures).`,
      details,
      mkFix(FIX_KINDS.REASSIGN_PROXY, 'Pick a different proxy'),
    )
  }
  if (!proxy.lastTestedAt) {
    return mkVector(
      STATUSES.YELLOW,
      `Proxy "${proxy.name || proxy.host}" has never been tested.`,
      details,
      mkFix(FIX_KINDS.TEST_PROXY, 'Run connectivity test now'),
    )
  }
  const ageMs = (now || Date.now()) - proxy.lastTestedAt
  if (ageMs > PROXY_STALE_MS) {
    const hours = Math.round(ageMs / (60 * 60 * 1000))
    return mkVector(
      STATUSES.YELLOW,
      `Proxy last tested ${hours}h ago.`,
      details,
      mkFix(FIX_KINDS.TEST_PROXY, 'Re-test connectivity'),
    )
  }
  if ((proxy.failureCount || 0) > 0) {
    return mkVector(
      STATUSES.YELLOW,
      `Proxy has ${proxy.failureCount} recent failure(s) but is still active.`,
      details,
      mkFix(FIX_KINDS.TEST_PROXY, 'Re-test connectivity'),
    )
  }
  return mkVector(
    STATUSES.GREEN,
    `Proxy reachable${proxy.lastLatencyMs ? ` (${proxy.lastLatencyMs}ms last test)` : ''}.`,
    details,
  )
}

// ============================================================================
// Helpers
// ============================================================================

function mkVector(status, summary, details, fix) {
  return {
    status,
    summary,
    details: details || {},
    fix: fix || null,
  }
}

function mkFix(kind, label) {
  return { kind, label }
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function pct(ratio) {
  return `${Math.round(ratio * 100)}%`
}

module.exports = {
  evaluateHealth,
  evaluateIpTimezone,
  evaluateFingerprintCoherence,
  evaluateCookieHealth,
  evaluateProxyReachability,
  STATUSES,
  FIX_KINDS,
  RANK,
  // Thresholds exposed for test pinning.
  COOKIE_EXPIRED_RED_RATIO,
  COOKIE_EXPIRED_YELLOW_RATIO,
  PROXY_STALE_MS,
}
