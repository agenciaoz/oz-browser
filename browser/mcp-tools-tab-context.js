// OZ Browser — MCP tool catalog: tab context + bookmarks + cookies + clear-data (1.7).
//
// Qué hace: extrae los tools del 1.7 a un módulo aparte para mantener
// mcp-tools.js bajo 500 LOC (ADR 0005). Los tools se spread'ean en el array
// principal de buildToolCatalog(browser) en mcp-tools.js.
//
// Doc: docs/modules/mcp-tools-tab-context.md
// ADR: docs/architecture/0016-tab-context-menu.md
//
// Exports: buildTabContextTools({tabs, bookmarks, cookies, identities})
//   donde cada arg es una getter que devuelve el handler map ya construido
//   por ipc-handlers.js → registerIpcHandlers.

function buildTabContextTools({ tabs, bookmarks, cookies, identities }) {
  return [
    // -------------------- tabs (1.7a context-menu actions) -------------
    {
      name: 'oz.tabs.reload',
      description: 'Reload the materialized webContents of a tab. Lazy tabs are noop.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().reload(tabId),
    },
    {
      name: 'oz.tabs.duplicate',
      description: 'Clone a tab in the same identity, inserted right after the source.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().duplicate(tabId),
    },
    {
      name: 'oz.tabs.duplicateInTemporary',
      description:
        'Clone a tab into a freshly-created "Temp <timestamp>" identity (gray). Useful for sandboxed re-checking of a page without touching the original session.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().duplicateInTemporary(tabId),
    },
    {
      name: 'oz.tabs.duplicateInIdentity',
      description: 'Clone a tab into an existing identity by id.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          identityId: { type: 'string' },
        },
        required: ['tabId', 'identityId'],
        additionalProperties: false,
      },
      call: ({ tabId, identityId }) => tabs().duplicateInIdentity(tabId, identityId),
    },
    {
      name: 'oz.tabs.duplicateInNewIdentity',
      description:
        'Create a brand-new identity (with optional name) and clone the tab into it.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId, name }) => tabs().duplicateInNewIdentity(tabId, name),
    },
    {
      name: 'oz.tabs.refreshAllInIdentity',
      description:
        'Reload every materialized tab whose identity matches identityId, across all windows. Lazy tabs are skipped (they reload on materialize). Returns {ok, count}.',
      inputSchema: {
        type: 'object',
        properties: { identityId: { type: 'string' } },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId }) => tabs().refreshAllInIdentity(identityId),
    },
    {
      name: 'oz.tabs.moveToNewWindow',
      description:
        'Move a tab to a brand-new window. Auto-creates a workspace named "Window N" because of the 1-1 lock (ADR 0015). Returns {ok, newWindowId, newWorkspaceId}.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().moveToNewWindow(tabId),
    },
    {
      name: 'oz.tabs.pin',
      description: 'Pin a tab. Persists into the workspace tabSpecs.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().pin(tabId),
    },
    {
      name: 'oz.tabs.unpin',
      description: 'Unpin a tab.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().unpin(tabId),
    },
    {
      name: 'oz.tabs.mute',
      description:
        'Mute the audio of a tab (webContents.setAudioMuted(true)). Lazy tabs noop.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().mute(tabId),
    },
    {
      name: 'oz.tabs.unmute',
      description: 'Unmute the audio of a tab.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().unmute(tabId),
    },
    {
      name: 'oz.tabs.closeOthers',
      description:
        'Close every tab in the same window EXCEPT tabId. Pinned tabs are preserved.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().closeOthers(tabId),
    },
    {
      name: 'oz.tabs.closeToRight',
      description:
        "Close every tab to the right of tabId in the same window's tabList. Pinned tabs preserved.",
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => tabs().closeToRight(tabId),
    },

    // -------------------- bookmarks (1.7b MVP) -------------------------
    {
      name: 'oz.bookmarks.list',
      description:
        'List bookmarks. Optional filter {identityId} to scope to one identity.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            properties: { identityId: { type: 'string' } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      call: ({ filter } = {}) => bookmarks().list(filter),
    },
    {
      name: 'oz.bookmarks.get',
      description: 'Get a single bookmark by id. Returns the record or null.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => bookmarks().get(id),
    },
    {
      name: 'oz.bookmarks.add',
      description:
        'Add a bookmark. Required {identityId, url}; optional {title, favicon}. Dedupe by (identityId, url) — re-adding the same URL returns the existing bookmark with deduped:true.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          favicon: { type: 'string' },
        },
        required: ['identityId', 'url'],
        additionalProperties: false,
      },
      call: (args = {}) => bookmarks().add(args),
    },
    {
      name: 'oz.bookmarks.addFromTab',
      description:
        "Resolve a tab by id and bookmark its current url+title+favicon for the tab's identity.",
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      call: ({ tabId }) => bookmarks().addFromTab(tabId),
    },
    {
      name: 'oz.bookmarks.remove',
      description: 'Remove a bookmark by id. Returns true/false.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => bookmarks().remove(id),
    },

    // -------------------- identities — clear browsing data (1.7b) ------
    {
      name: 'oz.identities.clearBrowsingData',
      description:
        'Clear browsing data for an identity. scope is one of: cookies (cookie jar only), storage (localStorage/IndexedDB/cache, no cookies), both. Live tabs are not destroyed; refresh them after to see the clean state.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          scope: {
            type: 'string',
            enum: ['cookies', 'storage', 'both'],
          },
        },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId, scope }) => identities().clearBrowsingData(identityId, scope),
    },

    // -------------------- cookies I/O (1.7c) ---------------------------
    {
      name: 'oz.cookies.exportContent',
      description:
        "Export an identity's cookie jar as a string in the requested format. format ∈ {oz, netscape, adspower, multilogin}. Returns {ok, content, cookieCount}.",
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          format: {
            type: 'string',
            enum: ['oz', 'netscape', 'adspower', 'multilogin'],
          },
        },
        required: ['identityId', 'format'],
        additionalProperties: false,
      },
      call: ({ identityId, format }) => cookies().exportContent(identityId, format),
    },
    {
      name: 'oz.cookies.exportToFile',
      description: "Export an identity's cookie jar to disk in the requested format.",
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          format: {
            type: 'string',
            enum: ['oz', 'netscape', 'adspower', 'multilogin'],
          },
          filePath: { type: 'string' },
        },
        required: ['identityId', 'format', 'filePath'],
        additionalProperties: false,
      },
      call: ({ identityId, format, filePath }) =>
        cookies().exportToFile(identityId, format, filePath),
    },
    {
      name: 'oz.cookies.importContent',
      description:
        "Import cookies from a string content into an identity's session. Returns {ok, parsedCount, written, errors}.",
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          format: {
            type: 'string',
            enum: ['oz', 'netscape', 'adspower', 'multilogin'],
          },
          content: { type: 'string' },
        },
        required: ['identityId', 'format', 'content'],
        additionalProperties: false,
      },
      call: ({ identityId, format, content }) =>
        cookies().importContent(identityId, format, content),
    },
    {
      name: 'oz.cookies.importFromFile',
      description:
        "Read a cookies file from disk and import it into an identity's session.",
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          format: {
            type: 'string',
            enum: ['oz', 'netscape', 'adspower', 'multilogin'],
          },
          filePath: { type: 'string' },
        },
        required: ['identityId', 'format', 'filePath'],
        additionalProperties: false,
      },
      call: ({ identityId, format, filePath }) =>
        cookies().importFromFile(identityId, format, filePath),
    },
  ]
}

module.exports = { buildTabContextTools }
