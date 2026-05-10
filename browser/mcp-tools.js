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
//
// Domain split (1.5b): vault + accounts tools live in mcp-tools-vault.js to
// keep this file <500 LOC (ADR 0005). They get spread into the array below.

const { buildVaultAccountsTools } = require('./mcp-tools-vault')
const { buildTabContextTools } = require('./mcp-tools-tab-context')
const { buildProxyTools } = require('./mcp-tools-proxies')
const { buildFingerprintTools } = require('./mcp-tools-fingerprint')

/**
 * Build the v1 tool catalog. Returns array of tool descriptors that the MCP
 * server uses for both tools/list responses and tools/call dispatch.
 *
 * @param {Browser} browser - The Browser instance, used to access handler maps.
 * @returns {Array<Tool>}
 */
function buildToolCatalog(browser) {
  // identity-handlers.js, tab-handlers.js, workspace-handlers.js,
  // account-handlers.js export pure maps wired into browser.handlers in
  // ipc-handlers.js → registerIpcHandlers.
  const identities = () => browser.handlers && browser.handlers.identities
  const tabs = () => browser.handlers && browser.handlers.tabs
  const workspaces = () => browser.handlers && browser.handlers.workspaces
  const vault = () => browser.handlers && browser.handlers.vault
  const accounts = () => browser.handlers && browser.handlers.accounts
  const excel = () => browser.handlers && browser.handlers.excel
  const timemachine = () => browser.handlers && browser.handlers.timemachine
  const bookmarks = () => browser.handlers && browser.handlers.bookmarks
  const cookies = () => browser.handlers && browser.handlers.cookies
  const proxies = () => browser.handlers && browser.handlers.proxies
  const fingerprint = () => browser.handlers && browser.handlers.fingerprint

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
        'Delete an identity by id. Default identity is protected — returns false if attempted. H2: locked identities are also protected; unlock first via oz.identities.setLocked.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => identities().remove(id),
    },
    {
      name: 'oz.identities.setLocked',
      description:
        'H2: toggle Identity.locked. Locked identities reject remove + clearBrowsingData but still accept rename, color and userAgent edits. Returns the updated identity, or null if id not found.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          locked: { type: 'boolean' },
        },
        required: ['id', 'locked'],
        additionalProperties: false,
      },
      call: ({ id, locked }) => identities().setLocked(id, locked),
    },
    {
      name: 'oz.identities.listByWorkspace',
      description:
        'H3a — list identities scoped to a workspace. Returns array of identities whose workspaceId === provided workspaceId. Default identity only appears under workspaceId="general".',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      call: ({ workspaceId }) => identities().listByWorkspace(workspaceId),
    },
    {
      name: 'oz.identities.moveToWorkspace',
      description:
        "H3a — move an identity from its current workspace to another. Default identity rejects (pinned to 'general' per ADR 0023 D2). Locked identities reject. Returns { ok, id, from, to } or { ok: false, reason } where reason can be: identity-not-found, default-pinned-to-general, identity-locked.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          targetWorkspaceId: { type: 'string' },
        },
        required: ['id', 'targetWorkspaceId'],
        additionalProperties: false,
      },
      call: ({ id, targetWorkspaceId }) =>
        identities().moveToWorkspace(id, targetWorkspaceId),
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
      name: 'oz.tabs.reopenClosed',
      description:
        'H1 — reopen the most recently closed tab in the focused window. Stack is per-window, capped at 25 entries (FIFO eviction). Returns the new tab id, or null if the stack is empty / no focused window. Locked + pinned state is NOT restored — only identityId + url + title + favicon. Closes triggered by workspace switch (the snapshot path) do NOT populate the stack — only user-initiated closes via oz.tabs.close.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => tabs().reopenClosed(),
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
    {
      name: 'oz.tabs.moveToWorkspace',
      description:
        'Move a tab to another workspace (1.4d). If the target workspace is currently active in some window, the tab is recreated lazy there. Otherwise the tab spec is appended to the target workspace storage and the live tab is destroyed in the source. Returns {ok, tabId, from, to} or {ok:false, reason} where reason is one of: target-not-found, target-archived, tab-not-found, no-workspace-manager, cannot-serialize-tab.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          targetWorkspaceId: { type: 'string' },
        },
        required: ['tabId', 'targetWorkspaceId'],
        additionalProperties: false,
      },
      call: ({ tabId, targetWorkspaceId }) =>
        tabs().moveToWorkspace(tabId, targetWorkspaceId),
    },

    // -------------------- workspaces (1.4-WS) --------------------
    {
      name: 'oz.workspaces.list',
      description:
        'List all workspaces (including archived and frozen). Each workspace includes id, name, color, isDefault, isArchived, isFrozen, quickTabsMode, createdAt, updatedAt, tabSpecs, activeTabId.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => workspaces().list(),
    },
    {
      name: 'oz.workspaces.listActive',
      description:
        'List only non-archived workspaces. This is what the UI shows by default.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => workspaces().listActive(),
    },
    {
      name: 'oz.workspaces.get',
      description: 'Get a single workspace by id. Returns workspace object or null.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => workspaces().get(id),
    },
    {
      name: 'oz.workspaces.getActive',
      description:
        'Get the workspace id active in the focused window (or in the window referenced by windowId if provided). Returns workspaceId string or null.',
      inputSchema: {
        type: 'object',
        properties: { windowId: { type: 'number' } },
        additionalProperties: false,
      },
      call: ({ windowId } = {}) => workspaces().getActive(windowId),
    },
    {
      name: 'oz.workspaces.setActive',
      description:
        'Switch the focused window (or referenced window) to the given workspace. Returns {ok, workspaceId, ...} where ok=false carries reason: not-found / already-open / no-window. ADR 0015 lock exclusivo: 1 ventana = 1 workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          windowId: { type: 'number' },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      call: ({ workspaceId, windowId }) => workspaces().setActive(workspaceId, windowId),
    },
    {
      name: 'oz.workspaces.create',
      description:
        'Create a new workspace. Color auto-picked if omitted. quickTabsMode is one of load-all, one-by-one, on-click (default), on-click-confirm.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string' },
          quickTabsMode: {
            type: 'string',
            enum: ['load-all', 'one-by-one', 'on-click', 'on-click-confirm'],
          },
        },
        additionalProperties: false,
      },
      call: (args = {}) => workspaces().create(args),
    },
    {
      name: 'oz.workspaces.update',
      description:
        'Update workspace fields. Whitelisted: name, color, quickTabsMode. Frozen workspaces reject updates (returns null).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              color: { type: 'string' },
              quickTabsMode: {
                type: 'string',
                enum: ['load-all', 'one-by-one', 'on-click', 'on-click-confirm'],
              },
            },
            additionalProperties: false,
          },
        },
        required: ['id', 'patch'],
        additionalProperties: false,
      },
      call: ({ id, patch }) => workspaces().update(id, patch),
    },
    {
      name: 'oz.workspaces.duplicate',
      description:
        'Deep clone a workspace with fresh tab spec ids. The duplicate is never default/archived/frozen and gets name suffixed " (copy)".',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => workspaces().duplicate(id),
    },
    {
      name: 'oz.workspaces.archive',
      description:
        'Archive a workspace (hides from listActive but preserves data). Default workspace is protected — returns false if attempted.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => workspaces().archive(id),
    },
    {
      name: 'oz.workspaces.restore',
      description: 'Unarchive a workspace.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => workspaces().restore(id),
    },
    {
      name: 'oz.workspaces.freeze',
      description:
        'Freeze a workspace — blocks user CRUD (update returns null) but runtime navigation still works. Snapshot path (setTabSpecs) also bypasses freeze.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => workspaces().freeze(id),
    },
    {
      name: 'oz.workspaces.unfreeze',
      description: 'Unfreeze a workspace — restores CRUD permissions.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => workspaces().unfreeze(id),
    },
    {
      name: 'oz.workspaces.remove',
      description:
        "Delete a workspace by id. Default workspace ('general') is protected — returns false if attempted. H3a: if the workspace has identities, the default behavior rejects with { ok: false, reason: 'has-identities', count, lockedCount }. Pass options.cascade=true to move all unlocked identities to 'general' before removing the workspace; if any identity is locked, rejects with { ok: false, reason: 'has-locked-identities' } and aborts the cascade.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          options: {
            type: 'object',
            properties: { cascade: { type: 'boolean' } },
            additionalProperties: false,
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id, options }) => workspaces().remove(id, options),
    },

    // -------------------- vault + accounts + excel + timemachine (1.5b/e + 1.6, extracted) --------------------
    ...buildVaultAccountsTools({ vault, accounts, excel, timemachine }),

    // -------------------- tab context + bookmarks + cookies + clear-data (1.7, extracted) --------------------
    ...buildTabContextTools({ tabs, bookmarks, cookies, identities }),

    // -------------------- proxies (1.8, extracted) --------------------
    ...buildProxyTools({ proxies }),

    // -------------------- fingerprint (1.9, extracted) --------------------
    ...buildFingerprintTools({ fingerprint }),

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
