// OZ Browser — MCP tool catalog (v1 — Bloque 1.3-MCP).
//
// Qué hace: lista de tools que el MCP server expone. Cada entry tiene:
//   - name: nombre completo del tool MCP (e.g. "oz.identities.list")
//   - description: prosa para que el cliente humano/LLM entienda qué hace
//   - inputSchema: JSON Schema del input args (lo más fiel posible a draft 2020-12)
//   - handler: ref a función en browser.handlers.<domain> que implementa
//
// Por qué no zod: el pivote del ADR 0012 (sandbox ENOSPC) eliminó deps nuevas.
// El JSON Schema inline es feo pero estándar y suficiente para tools sencillos.
//
// Doc: docs/modules/mcp-tools.md
// ADR: docs/architecture/0012-oz-mcp-server.md

/**
 * Build the v1 tool catalog. Returns array of tool descriptors that the MCP
 * server uses for both tools/list responses and tools/call dispatch.
 *
 * @param {Browser} browser - The Browser instance, used to access handler maps.
 * @returns {Array<Tool>}
 */
function buildToolCatalog(browser) {
  // identity-handlers.js and tab-handlers.js export pure maps wired into
  // browser.handlers in ipc-handlers.js → registerIpcHandlers.
  const identities = () => browser.handlers && browser.handlers.identities
  const tabs = () => browser.handlers && browser.handlers.tabs

  return [
    // -------------------- identities --------------------
    {
      name: 'oz.identities.list',
      description:
        'List all identities (Default + custom). Returns array of {id,name,color,fingerprintSeed,createdAt,userAgent,isDefault?}.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => identities().list(),
    },
    {
      name: 'oz.identities.get',
      description: 'Get a single identity by id. Returns the identity object or null.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Identity id (uuid hex string)' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => identities().get(id),
    },
    {
      name: 'oz.identities.getActive',
      description:
        'Get the id of the currently active identity (the one that new tabs default to).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => identities().getActive(),
    },
    {
      name: 'oz.identities.setActive',
      description:
        'Set the active identity by id. Returns true on success, false if id not found.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => identities().setActive(id),
    },
    {
      name: 'oz.identities.create',
      description:
        'Create a new identity. Free tier max is 3 (bypass with OZ_TIER=paid env). Returns identity object or {__error:{code:"IDENTITY_CAP_REACHED",...}} if cap hit.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name. Default "New Identity".' },
          color: {
            type: 'string',
            description: 'Hex color #RRGGBB. Auto-picked if omitted.',
          },
          userAgent: {
            type: 'string',
            description:
              'Custom UA. Default null. Rejected on Default identity (ADR 0010).',
          },
        },
        additionalProperties: false,
      },
      call: (args = {}) => identities().create(args),
    },
    {
      name: 'oz.identities.update',
      description:
        'Update identity fields. Whitelisted: name, color, userAgent. Default identity rejects userAgent (ADR 0010).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              color: { type: 'string' },
              userAgent: { type: ['string', 'null'] },
            },
            additionalProperties: false,
          },
        },
        required: ['id', 'patch'],
        additionalProperties: false,
      },
      call: ({ id, patch }) => identities().update(id, patch),
    },
    {
      name: 'oz.identities.remove',
      description:
        'Delete an identity by id. Default identity is protected — returns false if attempted.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => identities().remove(id),
    },

    // -------------------- tabs --------------------
    {
      name: 'oz.tabs.list',
      description:
        'List all tabs across all windows. Each tab includes id, identityId, url, title, isLoaded (materialized), windowId.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => tabs().list(),
    },
    {
      name: 'oz.tabs.openInIdentity',
      description:
        'Open a new tab bound to the given identity, navigating to url. Returns the new tab id (null if no focused window).',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          url: {
            type: 'string',
            description: 'URL to load. Defaults to about:blank if omitted.',
          },
        },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId, url }) => tabs().openInIdentity(identityId, url),
    },
    {
      name: 'oz.tabs.select',
      description:
        'Select (focus + materialize if lazy) a tab by id. Returns true/false.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().select(tabId),
    },
    {
      name: 'oz.tabs.close',
      description: 'Close a tab by id. Returns true/false.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().close(tabId),
    },

    // -------------------- system metrics --------------------
    {
      name: 'oz.system.getMetrics',
      description:
        'Snapshot of current OZ runtime metrics. Used by BENCHMARKS.md automation. Memory in MB, cpuPercent 0-100, uptimeSec since main process start.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => buildMetrics(browser),
    },

    // events.subscribe is special-cased — not a regular tool/call, instead it
    // triggers SSE response. The MCP server's HTTP layer handles it directly.
    // We expose it here so tools/list shows it as part of the catalog.
    {
      name: 'oz.events.subscribe',
      description:
        'Subscribe to live events from OZ via Server-Sent Events. Pass {channels:["tabs.*","identities.*"]} to filter. Streams JSON events: {channel,payload,ts}. Connection stays open until client disconnects. NOTE: this tool returns immediately with {streaming:true}; the actual event stream comes via the SSE endpoint at GET /mcp/events.',
      inputSchema: {
        type: 'object',
        properties: {
          channels: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Glob filters. Empty = all events. Examples: ["tabs.*"], ["identities.changed"].',
          },
        },
        additionalProperties: false,
      },
      call: () => ({
        streaming: true,
        sseEndpoint: '/mcp/events',
        note: 'Connect with curl -N http://localhost:9223/mcp/events to receive event stream.',
      }),
    },
  ]
}

function buildMetrics(browser) {
  const used = process.memoryUsage()
  const cpu = process.cpuUsage()
  const uptimeSec = Math.floor(process.uptime())

  // Tabs counted across all windows.
  let tabsLazy = 0
  let tabsMaterialized = 0
  for (const win of browser.windows || []) {
    for (const t of win.tabs.tabList) {
      if (t.materialized) tabsMaterialized++
      else tabsLazy++
    }
  }

  // Cumulative cpu since process start. Real-time % requires sampling delta;
  // we expose cumulative for now (caller can sample twice and diff).
  const cpuTotalMs = (cpu.user + cpu.system) / 1000
  const cpuPercent = uptimeSec > 0 ? Math.round(cpuTotalMs / 10 / uptimeSec) : 0

  return {
    ozVersion: process.env.npm_package_version || 'dev',
    memoryMB: Math.round(used.rss / 1024 / 1024),
    heapMB: Math.round(used.heapUsed / 1024 / 1024),
    cpuPercentCumulative: cpuPercent,
    identitiesCount: browser.identityManager ? browser.identityManager.list().length : 0,
    tabsLazy,
    tabsMaterialized,
    windowsCount: (browser.windows || []).length,
    uptimeSec,
  }
}

module.exports = { buildToolCatalog, buildMetrics }
