// OZ Browser — MCP tool catalog: cross-device sync (D-3c-3c).
//
// Doc: docs/modules/sync-bootstrap.md
//
// Exports: buildSyncTools({sync}) — sync es un getter al handler map.

'use strict'

function buildSyncTools({ sync }) {
  return [
    {
      name: 'oz.sync.getStatus',
      description:
        'D-3c-3c — get cross-device sync status. Returns { configured, dropboxConnected, enabled, running, queueDepth, vaultUnlocked, needsReauth, firstEnableAt, lastPullAt, lastPushAt, lastError }. `enabled` = user intent; `running` = engine actually drainning. UI uses this to render the Settings → Sync pill.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => sync().getStatus(),
    },
    {
      name: 'oz.sync.setEnabled',
      description:
        'D-3c-3c — enable/disable cross-device sync. First enable triggers a cold-start: enqueue every identity/workspace/bookmarks-record as upsert so the other device hydrates. Disable preserves the queue + cursor on disk so re-enable resumes seamlessly. Returns { ok, enabled, coldStart, counts? } or { ok:false, reason }. Possible reasons: NEEDS_DROPBOX_APP, NEEDS_REAUTH, BUILD_FAILED.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
        additionalProperties: false,
      },
      call: ({ enabled }) => sync().setEnabled(enabled),
    },
    {
      name: 'oz.sync.pullNow',
      description:
        'D-3c-3c — manual "Sync Now" trigger. Runs pullOnce for identities + workspaces + bookmarks immediately. Useful right after another device pushed changes you want to see. Returns { ok, result } or { ok:false, reason }. Reasons: NOT_RUNNING (sync disabled), PULL_FAILED, NEEDS_REAUTH.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: async () => sync().pullNow(),
    },
  ]
}

module.exports = { buildSyncTools }
