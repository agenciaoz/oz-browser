// OZ Browser — MCP tool catalog: scheduled actions (v2 Etapa 2.1).
//
// Until now `browser.handlers.scheduled` existed but had no MCP surface
// — Claude could not create or list scheduled actions from chat. v2
// Etapa 2.1 wires the v2 Bulk Runner into the F-1 scheduler (action
// type 'bulk'), so it's now natural for Claude to also create those
// scheduled bulk runs directly. This catalog exposes the minimum set
// that makes that flow possible end-to-end.
//
// Tool names ≤21 chars after dot→underscore sanitization (Claude
// Desktop budget). Domain is `sched` (not `scheduled`) to stay short:
//   oz.sched.list    → oz_sched_list    (13)
//   oz.sched.get     → oz_sched_get     (12)
//   oz.sched.create  → oz_sched_create  (15)
//   oz.sched.remove  → oz_sched_remove  (15)
//   oz.sched.setEn   → oz_sched_setEn   (14) (was: setEnabled)
//   oz.sched.tickNow → oz_sched_tickNow (16)
//   oz.sched.status  → oz_sched_status  (15)
//
// Doc: docs/modules/mcp-tools-scheduled.md (TBD)
// Related: scheduled-handlers.js (handler map), scheduled-action-bulk.js
//   (v2 bulk handler), bulk-handlers.js (the bulk runner itself).

'use strict'

function buildScheduledTools({ scheduled }) {
  const SCHEDULE_SCHEMA = {
    description:
      'Schedule object. type=every-minutes {minutes:1..1440}, type=daily {time:"HH:MM"}, type=weekly {day:"mon..sun", time:"HH:MM"}',
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['every-minutes', 'daily', 'weekly'] },
      minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      time: { type: 'string', pattern: '^[0-2][0-9]:[0-5][0-9]$' },
      day: {
        type: 'string',
        enum: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
      },
    },
    required: ['type'],
    additionalProperties: false,
  }

  return [
    {
      name: 'oz.sched.list',
      description:
        'List all scheduled actions: { ok, actions: [{ id, name, action, params, schedule, enabled, createdAt, lastRunAt, lastResult }] }. Returns { ok:false, reason:"NOT_CONFIGURED" } before scheduler boots.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => scheduled().list(),
    },
    {
      name: 'oz.sched.get',
      description: 'Get a single scheduled action by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => scheduled().get(id),
    },
    {
      name: 'oz.sched.create',
      description:
        'Create a new scheduled action. action types: "open-workspace" (params.workspaceId), "sync-push", "backup-snapshot" (params.label), "session-warmer" (params.workspaceId or params.identityIds[]), "bulk" (v2 Etapa 2.1 — params.spec={actionId,identityIds[],params,options}). For bulk: actionId must be a registered bulk action (oz.bulk.actions to discover). Returns { ok, action }.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          action: { type: 'string', minLength: 1, maxLength: 64 },
          params: { type: 'object', additionalProperties: true },
          schedule: SCHEDULE_SCHEMA,
          enabled: { type: 'boolean' },
        },
        required: ['name', 'action', 'schedule'],
        additionalProperties: false,
      },
      call: (args) => scheduled().create(args),
    },
    {
      name: 'oz.sched.remove',
      description: 'Delete a scheduled action by id. Returns { ok, removed: bool }.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => scheduled().remove(id),
    },
    {
      name: 'oz.sched.setEn',
      description:
        'Enable / disable a scheduled action without deleting it (pause). Returns { ok, action }.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['id', 'enabled'],
        additionalProperties: false,
      },
      call: ({ id, enabled }) => scheduled().setEnabled(id, enabled),
    },
    {
      name: 'oz.sched.status',
      description:
        'Scheduler status: { configured, running, actionCount }. Used by UIs to render the status pill.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => scheduled().getStatus(),
    },
    {
      name: 'oz.sched.tickNow',
      description:
        'Force-fire any actions whose nextRunAt is ≤ now. Useful for "Run now" in Settings or testing a freshly created scheduled action without waiting for the next tick.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => scheduled().tickNow(),
    },
  ]
}

module.exports = { buildScheduledTools }
