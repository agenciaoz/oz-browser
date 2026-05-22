// OZ Browser — MCP tool catalog: proxies (1.8).
//
// Qué hace: 16 tools `oz.proxies.*` para que un agente externo pueda
// gestionar el ProxyManager + ProxyAssignment + Health daemon.
//
// Doc: docs/modules/mcp-tools-proxies.md
// ADR: docs/architecture/0017-proxy-model.md
//
// Exports: buildProxyTools({proxies}) — getter al handler map ya construido.

function buildProxyTools({ proxies }) {
  return [
    // -------------------- ProxyManager CRUD --------------------------------
    {
      name: 'oz.proxies.list',
      description:
        'List every proxy (active + disabled). Each entry has id, name, protocol, host, port, username, isActive, isDisabled, failureCount, lastTestedAt, lastLatencyMs, tags.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => proxies().list(),
    },
    {
      name: 'oz.proxies.assignable',
      description:
        'List only proxies usable for assignment (isActive AND NOT isDisabled).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => proxies().listAssignable(),
    },
    {
      name: 'oz.proxies.get',
      description: 'Get a single proxy by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => proxies().get(id),
    },
    {
      name: 'oz.proxies.create',
      description:
        'Create a proxy. Required: host, port. Optional: protocol (https/http/socks5, default https), username, password, name, country, tags. Returns proxy or {__error:{code,message}}.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          protocol: { type: 'string', enum: ['http', 'https', 'socks5'] },
          host: { type: 'string' },
          port: { type: 'number' },
          username: { type: 'string' },
          password: { type: 'string' },
          country: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          isActive: { type: 'boolean' },
        },
        required: ['host', 'port'],
        additionalProperties: false,
      },
      call: (args = {}) => proxies().create(args),
    },
    {
      name: 'oz.proxies.update',
      description:
        'Update a proxy. Whitelisted fields: name, protocol, host, port, username, password, tags, country, isActive, isDisabled.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: { type: 'object', additionalProperties: true },
        },
        required: ['id', 'patch'],
        additionalProperties: false,
      },
      call: ({ id, patch }) => proxies().update(id, patch),
    },
    {
      name: 'oz.proxies.remove',
      description:
        'Delete a proxy by id. Cascade-clears any identity / workspace assignment.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => proxies().remove(id),
    },
    {
      name: 'oz.proxies.setActive',
      description:
        'Toggle isActive flag. Setting true also clears isDisabled (manual recovery from auto-disable).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          isActive: { type: 'boolean' },
        },
        required: ['id', 'isActive'],
        additionalProperties: false,
      },
      call: ({ id, isActive }) => proxies().setActive(id, isActive),
    },
    {
      name: 'oz.proxies.autoAssign',
      description:
        'Pick one assignable proxy via the requested strategy (random | round-robin). Returns the proxy or null. Does NOT mutate state.',
      inputSchema: {
        type: 'object',
        properties: {
          strategy: { type: 'string', enum: ['random', 'round-robin'] },
        },
        additionalProperties: false,
      },
      call: ({ strategy = 'random' } = {}) => proxies().autoAssign(strategy),
    },
    {
      name: 'oz.proxies.bulkAdd',
      description: 'Bulk-add multiple proxies. Skips invalid items.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      call: ({ items }) => proxies().bulkAdd(items),
    },

    // -------------------- Assignment ---------------------------------------
    {
      name: 'oz.proxies.assignId',
      description:
        'Bind a proxy to an identity. value can be a proxyId, "auto-random", "auto-round-robin", or null (clears the binding).',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          value: { type: ['string', 'null'] },
        },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId, value }) => proxies().assignToIdentity(identityId, value),
    },
    {
      name: 'oz.proxies.assignWs',
      description:
        'Bind a proxy to a workspace (same value semantics as assignToIdentity).',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          value: { type: ['string', 'null'] },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      call: ({ workspaceId, value }) => proxies().assignToWorkspace(workspaceId, value),
    },
    {
      name: 'oz.proxies.setDefault',
      description:
        'Set the global fallback strategy when neither identity nor workspace has a binding. Pass "auto-random", "auto-round-robin", or null.',
      inputSchema: {
        type: 'object',
        properties: {
          strategy: {
            type: ['string', 'null'],
            enum: ['auto-random', 'auto-round-robin', null],
          },
        },
        additionalProperties: false,
      },
      call: ({ strategy }) => proxies().setDefaultStrategy(strategy),
    },
    {
      name: 'oz.proxies.assigns',
      description: 'Snapshot of all current proxy bindings.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => proxies().listAssignments(),
    },
    {
      name: 'oz.proxies.resolveId',
      description:
        'Resolve which proxy an identity (and optionally workspace) would use right now. Returns the proxy object or null.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId, workspaceId }) =>
        proxies().resolveForIdentity(identityId, workspaceId),
    },

    // -------------------- Health -------------------------------------------
    {
      name: 'oz.proxies.testConn',
      description:
        'Run a single TCP/CONNECT health check. Returns {ok, latencyMs, reason?, autoDisabled?}.',
      inputSchema: {
        type: 'object',
        properties: { proxyId: { type: 'string' } },
        required: ['proxyId'],
        additionalProperties: false,
      },
      call: ({ proxyId }) => proxies().testConnectivity(proxyId),
    },
    {
      name: 'oz.proxies.testAll',
      description:
        'Test every assignable proxy in parallel. Returns array of per-proxy results.',
      inputSchema: {
        type: 'object',
        properties: {
          includeDisabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      call: (args = {}) => proxies().testAll(args),
    },

    // -------------------- CSV + Providers ----------------------------------
    {
      name: 'oz.proxies.importStr',
      description:
        'Bulk-import proxies from CSV string content. Format: protocol,host,port,username,password,tags,country,name (header tolerant; tags split by | or ;).',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
      call: ({ content }) => proxies().importCsvContent(content),
    },
    {
      name: 'oz.proxies.importFile',
      description: 'Read a CSV file from disk and bulk-import proxies.',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
        additionalProperties: false,
      },
      call: ({ filePath }) => proxies().importCsvFromFile(filePath),
    },
    {
      name: 'oz.proxies.exportStr',
      description: 'Serialize all proxies to a CSV string.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => proxies().exportCsvContent(),
    },
    {
      name: 'oz.proxies.exportFile',
      description: 'Write all proxies to a CSV file on disk.',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
        additionalProperties: false,
      },
      call: ({ filePath }) => proxies().exportCsvToFile(filePath),
    },
    {
      name: 'oz.proxies.providers',
      description:
        'List provider templates (id, label, status, fields). v1: oxylabs available, brightdata/smartproxy/iproyal coming-soon.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => proxies().listProviders(),
    },
    {
      name: 'oz.proxies.expand',
      description:
        'Expand a provider template into N proxies and add them. Oxylabs example: {endpoint:"us-pr.oxylabs.io:10001",customer:"mzewama",password:"...",count:10,country:"US",sesstimeMin:30}. The 3 stubs return {__error:{code:"COMING_SOON"}}.',
      inputSchema: {
        type: 'object',
        properties: {
          providerId: { type: 'string' },
          opts: { type: 'object', additionalProperties: true },
        },
        required: ['providerId'],
        additionalProperties: false,
      },
      call: ({ providerId, opts }) => proxies().expandProvider(providerId, opts),
    },
  ]
}

module.exports = { buildProxyTools }
