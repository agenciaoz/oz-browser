// OZ Browser — MCP tool catalog: alerts (E2-C-5).
//
// Doc: docs/modules/mcp-tools-alerts.md
//
// Exports: buildAlertTools({alerts}) — getter al handler map.

function buildAlertTools({ alerts }) {
  return [
    {
      name: 'oz.alerts.list',
      description:
        'C-5 — list in-app alerts (newest first). Optional filters: limit (number), type (string|string[] e.g. "anti-logout"|["anti-logout","proxy-disabled"]), unreadOnly (boolean), since (ms epoch). Each alert has {id, ts, type, severity:urgent|info|success, title, message, identityId?, action?, read}. Persisted to userData/alerts.json (cap 500 FIFO, urgent unread protected from eviction).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          type: { type: ['string', 'array'] },
          unreadOnly: { type: 'boolean' },
          since: { type: 'number' },
        },
        additionalProperties: false,
      },
      call: (opts) => alerts().list(opts || {}),
    },
    {
      name: 'oz.alerts.add',
      description:
        'C-5 — add a new alert programmatically (mostly used by the main process producers; exposed for MCP automation use cases like "alert me when X happens"). Required: type, title. Optional: severity (default info), message, identityId, action.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          severity: { type: 'string', enum: ['urgent', 'info', 'success'] },
          title: { type: 'string' },
          message: { type: 'string' },
          identityId: { type: 'string' },
          action: { type: 'object' },
        },
        required: ['type', 'title'],
        additionalProperties: false,
      },
      call: (opts) => alerts().add(opts || {}),
    },
    {
      name: 'oz.alerts.markRead',
      description: 'C-5 — mark a single alert as read. Returns boolean.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => alerts().markRead(id),
    },
    {
      name: 'oz.alerts.markAllRead',
      description: 'C-5 — mark all alerts as read. Returns the count of newly marked.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => alerts().markAllRead(),
    },
    {
      name: 'oz.alerts.remove',
      description: 'C-5 — remove a single alert by id. Returns boolean.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => alerts().remove(id),
    },
    {
      name: 'oz.alerts.clear',
      description:
        'C-5 — clear ALL alerts. Returns the count removed. Destructive — confirm before invoking from automation.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => alerts().clear(),
    },
    {
      name: 'oz.alerts.unreadCount',
      description: 'C-5 — get the unread alerts count. Cheap O(N).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => alerts().unreadCount(),
    },
  ]
}

module.exports = { buildAlertTools }
