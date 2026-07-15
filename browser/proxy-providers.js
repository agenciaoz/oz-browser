// OZ Browser — Proxy provider templates (1.8d + v2.0.0-alpha.22).
//
// Qué hace: expansión de proxies por provider. Oxylabs + Bright Data + Decodo
// son providers de primera clase (real expand). Smartproxy (legacy id, rebrand
// de Decodo) + IPRoyal siguen como stubs COMING_SOON.
//
// Por qué Oxylabs + Bright Data ahora:
//   - Jose YA usa Oxylabs (us-pr.oxylabs.io:10001 + `customer-X-sessid-Y-sesstime-Z`).
//   - Bright Data es el segundo proveedor más demandado en el agency space.
//     Patrón distinto al de Oxylabs: en lugar de `sessid-NNN-sesstime-MM`
//     usan `session-NNN` para sticky sin time-bound (la sesión vive hasta
//     que se rota explícitamente desde el dashboard del provider).
//   - Smartproxy/IPRoyal quedan como stubs hasta que un cliente lo pida.
//
// Doc: docs/modules/proxy-providers.md
// ADR: docs/architecture/0017-proxy-model.md
//
// Exports: PROVIDERS (registry), expandProvider(providerId, opts),
//          listProviders(), expandOxylabs(opts), expandBrightData(opts)

const log = require('./logger')

/**
 * Oxylabs Residential — sticky session pattern.
 * The user already has a tier (Datacenter / Residential / Mobile) with a
 * single endpoint host (e.g. `us-pr.oxylabs.io:10001`) and the session ID
 * rotates IPs on demand. We generate N proxy specs with sequential session
 * IDs so the user can spread them across identities.
 *
 * @param {object} opts
 * @param {string} opts.endpoint - host:port, e.g. "us-pr.oxylabs.io:10001"
 * @param {string} opts.customer - the customer username, e.g. "mzewama"
 * @param {string} opts.password - the account password
 * @param {number} opts.count - how many proxies to generate (1..1000)
 * @param {boolean} [opts.sticky] - whether to emit sessid+sesstime (default true).
 *   When false, omits both — Oxylabs returns a fresh exit IP per request
 *   (rotating residential). Useful for high-volume scraping.
 * @param {number} [opts.sesstimeMin] - sticky duration in minutes, default 30
 * @param {string} [opts.country] - 2-letter, e.g. "US"
 * @param {string} [opts.city] - lowercase city slug, e.g. "new_york". Oxylabs
 *   only accepts cities the country exposes; we don't validate (let the
 *   provider surface the error on first connection).
 * @param {number} [opts.startSessId] - first session id, default 1
 */
function expandOxylabs(opts = {}) {
  const {
    endpoint,
    customer,
    password,
    count,
    sticky = true,
    sesstimeMin = 30,
    country = null,
    city = null,
    startSessId = 1,
  } = opts
  if (!endpoint || !customer || !password) {
    return {
      __error: {
        code: 'MISSING_FIELDS',
        message: 'Oxylabs needs endpoint, customer, password.',
      },
    }
  }
  const n = Number(count)
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    return {
      __error: {
        code: 'INVALID_COUNT',
        message: `Count must be 1-1000, got: ${count}`,
      },
    }
  }
  const m = String(endpoint).match(/^([^:]+):(\d+)$/)
  if (!m) {
    return {
      __error: {
        code: 'INVALID_ENDPOINT',
        message: `Endpoint must be host:port. Got "${endpoint}".`,
      },
    }
  }
  const [, host, portStr] = m
  const port = parseInt(portStr, 10)
  // Normalize city: lowercase + underscores (Oxylabs convention).
  const citySlug = city ? String(city).trim().toLowerCase().replace(/\s+/g, '_') : null
  const items = []
  for (let i = 0; i < n; i++) {
    const sessId = String(startSessId + i).padStart(6, '0')
    const userParts = [`customer-${customer}`]
    if (country) userParts.push(`cc-${country.toLowerCase()}`)
    if (citySlug) userParts.push(`city-${citySlug}`)
    if (sticky) {
      userParts.push(`sessid-${sessId}`)
      userParts.push(`sesstime-${sesstimeMin}`)
    }
    const labelGeo = [country, city].filter(Boolean).join('/')
    items.push({
      protocol: 'https',
      host,
      port,
      username: userParts.join('-'),
      password,
      tags: ['oxylabs', country, city].filter(Boolean),
      country,
      city: city || null,
      // Rotating (non-sticky) proxies all share the same username — we still
      // emit N "slots" so the user can spread them across identities and get
      // per-identity rotation; the name suffix uses i+1 for disambiguation.
      name: sticky
        ? `Oxylabs ${labelGeo || ''} #${sessId}`.trim()
        : `Oxylabs ${labelGeo || ''} rot ${i + 1}`.trim(),
    })
  }
  log.info('proxy-providers', 'oxylabs expanded', {
    count: items.length,
    endpoint,
    country,
    city: citySlug,
    sticky,
  })
  return { ok: true, items }
}

const COMING_SOON = (label) => () => ({
  __error: {
    code: 'COMING_SOON',
    message: `${label} integration is planned but not implemented in v1. Use CSV import or manual entry for now.`,
  },
})

/**
 * Bright Data Residential — sticky session pattern (zone-based).
 * Bright Data exposes a single super-proxy endpoint (default
 * `brd.superproxy.io:22225`) and the username carries customer + zone +
 * optional geo + optional session id. Unlike Oxylabs, sessions are NOT
 * time-bounded — they persist until rotated from the BD dashboard or until
 * `-session-` is omitted (= rotating per request).
 *
 * Username pattern:
 *   brd-customer-{customer}-zone-{zone}[-country-{cc}][-city-{slug}][-session-{sessId}]
 *
 * @param {object} opts
 * @param {string} opts.endpoint - host:port, default "brd.superproxy.io:22225"
 * @param {string} opts.customer - BD customer id, e.g. "hl_xxxxxxxx"
 * @param {string} opts.password - zone password (from BD dashboard)
 * @param {string} opts.zone - zone name, e.g. "residential-1"
 * @param {number} opts.count - how many proxies to generate (1..1000)
 * @param {boolean} [opts.sticky] - emit -session-N (default true). When false,
 *   omits -session- so each request rotates exit IP.
 * @param {string} [opts.country] - 2-letter ISO, e.g. "US"
 * @param {string} [opts.city] - city slug, e.g. "new_york"
 * @param {number} [opts.startSessId] - first session id, default 1
 */
function expandBrightData(opts = {}) {
  const {
    endpoint = 'brd.superproxy.io:22225',
    customer,
    password,
    zone,
    count,
    sticky = true,
    country = null,
    city = null,
    startSessId = 1,
  } = opts
  if (!customer || !password || !zone) {
    return {
      __error: {
        code: 'MISSING_FIELDS',
        message: 'Bright Data needs customer, password, zone.',
      },
    }
  }
  const n = Number(count)
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    return {
      __error: {
        code: 'INVALID_COUNT',
        message: `Count must be 1-1000, got: ${count}`,
      },
    }
  }
  const m = String(endpoint).match(/^([^:]+):(\d+)$/)
  if (!m) {
    return {
      __error: {
        code: 'INVALID_ENDPOINT',
        message: `Endpoint must be host:port. Got "${endpoint}".`,
      },
    }
  }
  const [, host, portStr] = m
  const port = parseInt(portStr, 10)
  const citySlug = city ? String(city).trim().toLowerCase().replace(/\s+/g, '_') : null
  const items = []
  for (let i = 0; i < n; i++) {
    const sessId = String(startSessId + i).padStart(6, '0')
    const userParts = [`brd-customer-${customer}`, `zone-${zone}`]
    if (country) userParts.push(`country-${country.toLowerCase()}`)
    if (citySlug) userParts.push(`city-${citySlug}`)
    if (sticky) userParts.push(`session-${sessId}`)
    const labelGeo = [country, city].filter(Boolean).join('/')
    items.push({
      protocol: 'http',
      host,
      port,
      username: userParts.join('-'),
      password,
      tags: ['brightdata', zone, country, city].filter(Boolean),
      country,
      city: city || null,
      name: sticky
        ? `Bright Data ${zone} ${labelGeo || ''} #${sessId}`.replace(/\s+/g, ' ').trim()
        : `Bright Data ${zone} ${labelGeo || ''} rot ${i + 1}`
            .replace(/\s+/g, ' ')
            .trim(),
    })
  }
  log.info('proxy-providers', 'brightdata expanded', {
    count: items.length,
    endpoint,
    zone,
    country,
    city: citySlug,
    sticky,
  })
  return { ok: true, items }
}

/**
 * Decodo (ex-Smartproxy) — mobile/residential sticky via endpoint:port.
 * Decodo exposes a single gateway host (e.g. `gate.decodo.com`) with a range
 * of ports; each port is its own sticky session (~10 min), so we generate N
 * proxy specs over sequential ports (startPort..startPort+N-1) sharing one
 * username. City targeting rides in the username as
 * `user-{customer}-city-{slug}` (Decodo infers the country from the city);
 * country-only uses `country-{cc}`. City and ASN targeting are mutually
 * exclusive on Decodo's side — we only surface city here.
 *
 * Username pattern:
 *   user-{customer}[-country-{cc}][-city-{slug}]
 *
 * @param {object} opts
 * @param {string} opts.endpoint - host:startPort, e.g. "gate.decodo.com:10001"
 * @param {string} opts.customer - Decodo auth username, e.g. "sp2f1ft6in"
 * @param {string} opts.password - the account password
 * @param {number} opts.count - how many proxies/ports to generate (1..1000)
 * @param {string} [opts.country] - 2-letter ISO, e.g. "US"
 * @param {string} [opts.city] - city slug, e.g. "miami"
 */
function expandDecodo(opts = {}) {
  const {
    endpoint = 'gate.decodo.com:10001',
    customer,
    password,
    count,
    country = null,
    city = null,
  } = opts
  if (!customer || !password) {
    return {
      __error: {
        code: 'MISSING_FIELDS',
        message: 'Decodo needs endpoint, customer, password.',
      },
    }
  }
  const n = Number(count)
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    return {
      __error: {
        code: 'INVALID_COUNT',
        message: `Count must be 1-1000, got: ${count}`,
      },
    }
  }
  const m = String(endpoint).match(/^([^:]+):(\d+)$/)
  if (!m) {
    return {
      __error: {
        code: 'INVALID_ENDPOINT',
        message: `Endpoint must be host:port. Got "${endpoint}".`,
      },
    }
  }
  const [, host, portStr] = m
  const startPort = parseInt(portStr, 10)
  const citySlug = city ? String(city).trim().toLowerCase().replace(/\s+/g, '_') : null
  const userParts = [`user-${customer}`]
  if (country) userParts.push(`country-${country.toLowerCase()}`)
  if (citySlug) userParts.push(`city-${citySlug}`)
  const username = userParts.join('-')
  const labelGeo = [country, city].filter(Boolean).join('/')
  const items = []
  for (let i = 0; i < n; i++) {
    const port = startPort + i
    items.push({
      protocol: 'https',
      host,
      port,
      username,
      password,
      tags: ['decodo', country, city].filter(Boolean),
      country,
      city: city || null,
      // Each port is its own sticky session on Decodo's gateway, so N ports
      // give N independent sticky IPs while sharing one username.
      name: `Decodo ${labelGeo || ''} :${port}`.replace(/\s+/g, ' ').trim(),
    })
  }
  log.info('proxy-providers', 'decodo expanded', {
    count: items.length,
    endpoint,
    country,
    city: citySlug,
  })
  return { ok: true, items }
}

const PROVIDERS = {
  oxylabs: {
    id: 'oxylabs',
    label: 'Oxylabs',
    status: 'available',
    fields: [
      {
        id: 'endpoint',
        label: 'Endpoint (host:port)',
        placeholder: 'us-pr.oxylabs.io:10001',
      },
      { id: 'customer', label: 'Customer', placeholder: 'mzewama' },
      { id: 'password', label: 'Password', type: 'password' },
      { id: 'count', label: 'How many proxies?', type: 'number', placeholder: '10' },
      { id: 'country', label: 'Country code (optional)', placeholder: 'US' },
      { id: 'city', label: 'City (optional)', placeholder: 'new_york' },
      {
        id: 'sesstimeMin',
        label: 'Sticky session minutes',
        type: 'number',
        placeholder: '30',
      },
    ],
    expand: expandOxylabs,
  },
  brightdata: {
    id: 'brightdata',
    label: 'Bright Data',
    status: 'available',
    fields: [
      {
        id: 'endpoint',
        label: 'Endpoint (host:port)',
        placeholder: 'brd.superproxy.io:22225',
      },
      { id: 'customer', label: 'Customer ID', placeholder: 'hl_xxxxxxxx' },
      { id: 'password', label: 'Password', type: 'password' },
      { id: 'zone', label: 'Zone', placeholder: 'residential-1' },
      { id: 'count', label: 'How many proxies?', type: 'number', placeholder: '10' },
      { id: 'country', label: 'Country code (optional)', placeholder: 'US' },
      { id: 'city', label: 'City (optional)', placeholder: 'new_york' },
    ],
    expand: expandBrightData,
  },
  decodo: {
    id: 'decodo',
    label: 'Decodo',
    status: 'available',
    fields: [
      {
        id: 'endpoint',
        label: 'Endpoint (host:port)',
        placeholder: 'gate.decodo.com:10001',
      },
      { id: 'customer', label: 'Username', placeholder: 'sp2f1ft6in' },
      { id: 'password', label: 'Password', type: 'password' },
      { id: 'count', label: 'How many proxies?', type: 'number', placeholder: '10' },
      { id: 'country', label: 'Country code (optional)', placeholder: 'US' },
      { id: 'city', label: 'City (optional)', placeholder: 'miami' },
    ],
    expand: expandDecodo,
  },
  // Decodo is the rebrand of Smartproxy (gate.smartproxy.com → gate.decodo.com);
  // keep the legacy `smartproxy` id as a coming-soon stub so old references
  // don't crash. New setups should use the `decodo` provider above.
  smartproxy: {
    id: 'smartproxy',
    label: 'Smartproxy (legacy → use Decodo)',
    status: 'coming-soon',
    fields: [],
    expand: COMING_SOON('Smartproxy'),
  },
  iproyal: {
    id: 'iproyal',
    label: 'IPRoyal',
    status: 'coming-soon',
    fields: [],
    expand: COMING_SOON('IPRoyal'),
  },
}

function expandProvider(providerId, opts) {
  const provider = PROVIDERS[providerId]
  if (!provider) {
    return {
      __error: { code: 'UNKNOWN_PROVIDER', message: `Unknown provider: ${providerId}` },
    }
  }
  return provider.expand(opts)
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    status: p.status,
    fields: p.fields.slice(),
  }))
}

module.exports = {
  PROVIDERS,
  expandProvider,
  listProviders,
  expandOxylabs,
  expandBrightData,
  expandDecodo,
}
