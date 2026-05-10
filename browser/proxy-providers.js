// OZ Browser — Proxy provider templates (1.8d).
//
// Qué hace: expansión de proxies por provider. v1 implementa SÓLO Oxylabs
// con su patrón de session ID rotativo (el caso de uso real de Jose). Los
// otros 3 (Bright Data, Smartproxy, IPRoyal) son stubs que retornan
// __error.code='COMING_SOON' — la UI los muestra deshabilitados con un
// tooltip "Coming soon".
//
// Por qué solo Oxylabs en v1:
//   - El usuario YA tiene cuenta Oxylabs (us-pr.oxylabs.io:10001 con
//     `customer-mzewama-sessid-XXX-sesstime-30` username pattern).
//   - Implementar las 4 APIs reales son ~3h cada una y no se pueden testear
//     sin cuentas premium en cada provider.
//   - Cuando un cliente real pida Bright Data / Smartproxy / IPRoyal, lo
//     implementamos en C-11 / C-12 (post-launch).
//
// Doc: docs/modules/proxy-providers.md
// ADR: docs/architecture/0017-proxy-model.md
//
// Exports: PROVIDERS (registry), expandProvider(providerId, opts)

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
 * @param {number} [opts.sesstimeMin] - sticky duration in minutes, default 30
 * @param {string} [opts.country] - 2-letter, e.g. "US"
 * @param {number} [opts.startSessId] - first session id, default 1
 */
function expandOxylabs(opts = {}) {
  const {
    endpoint,
    customer,
    password,
    count,
    sesstimeMin = 30,
    country = null,
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
  const items = []
  for (let i = 0; i < n; i++) {
    const sessId = String(startSessId + i).padStart(6, '0')
    const userParts = [`customer-${customer}`]
    if (country) userParts.push(`cc-${country.toLowerCase()}`)
    userParts.push(`sessid-${sessId}`)
    userParts.push(`sesstime-${sesstimeMin}`)
    items.push({
      protocol: 'https',
      host,
      port,
      username: userParts.join('-'),
      password,
      tags: ['oxylabs', country].filter(Boolean),
      country,
      name: `Oxylabs ${country || ''} #${sessId}`.trim(),
    })
  }
  log.info('proxy-providers', 'oxylabs expanded', {
    count: items.length,
    endpoint,
    country,
  })
  return { ok: true, items }
}

const COMING_SOON = (label) => () => ({
  __error: {
    code: 'COMING_SOON',
    message: `${label} integration is planned but not implemented in v1. Use CSV import or manual entry for now.`,
  },
})

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
    status: 'coming-soon',
    fields: [],
    expand: COMING_SOON('Bright Data'),
  },
  smartproxy: {
    id: 'smartproxy',
    label: 'Smartproxy',
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

module.exports = { PROVIDERS, expandProvider, listProviders, expandOxylabs }
