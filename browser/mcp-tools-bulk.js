// OZ Browser — MCP tool catalog: bulk runner (v2 sub-bloque 1).
//
// Doc: docs/modules/mcp-tools-bulk.md
// ADR: docs/architecture/0030-bulk-runner.md
//
// Exports: buildBulkTools({bulk}) — getter al handler map.

'use strict'

function buildBulkTools({ bulk }) {
  return [
    {
      name: 'oz.bulk.actions',
      description:
        'List registered bulk actions: { id, label, description, paramsSchema }. Use this first to discover which actionIds are available before calling oz.bulk.run.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => bulk().listActions(),
    },
    {
      name: 'oz.bulk.run',
      description:
        'Create + start a bulk run in one call. Runs `actionId` against each identity in `identityIds` sequentially, with anti-detect delays between them (default 30-90s). Returns { ok, runId } or { __error }. Use oz.bulk.get to poll status, oz.bulk.cancel to stop.',
      inputSchema: {
        type: 'object',
        properties: {
          actionId: { type: 'string' },
          identityIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 200,
          },
          params: { type: 'object', additionalProperties: true },
          options: {
            type: 'object',
            properties: {
              minDelayMs: { type: 'number', minimum: 0 },
              maxDelayMs: { type: 'number', minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        required: ['actionId', 'identityIds'],
        additionalProperties: false,
      },
      call: (args = {}) => bulk().run(args),
    },
    {
      name: 'oz.bulk.create',
      description:
        'Create a bulk run WITHOUT starting it. Returns runId. Useful when you want to review the plan before dispatching. Call oz.bulk.start(runId) when ready.',
      inputSchema: {
        type: 'object',
        properties: {
          actionId: { type: 'string' },
          identityIds: { type: 'array', items: { type: 'string' } },
          params: { type: 'object', additionalProperties: true },
          options: { type: 'object', additionalProperties: true },
        },
        required: ['actionId', 'identityIds'],
        additionalProperties: false,
      },
      call: (args = {}) => bulk().create(args),
    },
    {
      name: 'oz.bulk.start',
      description: 'Start a previously-created bulk run by runId.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
        additionalProperties: false,
      },
      call: ({ runId }) => bulk().start(runId),
    },
    {
      name: 'oz.bulk.cancel',
      description:
        'Gentle cancel of a running bulk job. The in-flight identity gets the abort signal; remaining identities are marked cancelled. Returns { ok, cancelled: bool }.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
        additionalProperties: false,
      },
      call: ({ runId }) => bulk().cancel(runId),
    },
    {
      name: 'oz.bulk.get',
      description:
        'Get the current state of a run: { meta, items[] }. Each item has identityId, identityName, status (pending/running/done/failed/cancelled/skipped), result, error, startedAt, finishedAt. Returns null if runId not found.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
        additionalProperties: false,
      },
      call: ({ runId }) => bulk().get(runId),
    },
    {
      name: 'oz.bulk.list',
      description:
        'List all bulk runs (metadata only, newest first). Useful for the dashboard / history view.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => bulk().list(),
    },
    {
      name: 'oz.bulk.rlStats',
      description:
        'Get per-identity per-platform rate-limit stats for today (and any prior unpurged days). Returns { asOf, entries:[{identityId, platform, actionId, day, count, cap, remaining}] }. cap/remaining are null for platform-agnostic actions (echo, navigate). Filter to a single identity with { identityId }. Use this before launching big bulk runs to know how many actions an identity still has before hitting the daily safety cap.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
        },
        additionalProperties: false,
      },
      call: (args = {}) => bulk().rateLimitStats(args),
    },
  ]
}

module.exports = { buildBulkTools }
