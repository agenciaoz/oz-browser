// OZ Browser — MCP tools: Publishing Studio content plan (E5). MCP-first:
// importar/listar/mover-estado/editar/exportar el plan, todo por MCP.
//
// Verbos cortos → oz_publishing_<verb> ≤ 21 chars (guard mcp-server).
// Exports: buildPublishingTools({ publishing }) — getter al handler map.
// ADR: 0038 · 0005 · 0012.

'use strict'

function buildPublishingTools({ publishing }) {
  return [
    {
      name: 'oz.publishing.import',
      description:
        'Import a content plan into the Publishing Studio. Pass `matrix` (a spreadsheet as array-of-arrays, row 0 = headers like date/platform/caption/media/identities) OR `rows` (already-mapped objects). Creates draft publications. Returns { added, errors }.',
      inputSchema: {
        type: 'object',
        properties: {
          matrix: { type: 'array', items: { type: 'array' } },
          rows: { type: 'array', items: { type: 'object' } },
        },
        additionalProperties: false,
      },
      call: (args) => publishing().import(args || {}),
    },
    {
      name: 'oz.publishing.list',
      description:
        'List content-plan publications. Optional `status` filter: draft|review|approved|published.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string' } },
        additionalProperties: false,
      },
      call: ({ status } = {}) => publishing().list(status),
    },
    {
      name: 'oz.publishing.get',
      description: 'Get one publication by id (with full fields).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => publishing().get(id),
    },
    {
      name: 'oz.publishing.status',
      description:
        'Advance a publication through the approval workflow. action: submit (draft→review), approve (review→approved), reject (review→draft), publish (approved→published), edit (→draft). Returns the updated publication or { __error }.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, action: { type: 'string' } },
        required: ['id', 'action'],
        additionalProperties: false,
      },
      call: ({ id, action }) => publishing().status(id, action),
    },
    {
      name: 'oz.publishing.update',
      description:
        'Edit a publication (caption/media/identities/platform/scheduledAt). Returns the updated publication.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, patch: { type: 'object' } },
        required: ['id', 'patch'],
        additionalProperties: false,
      },
      call: ({ id, patch }) => publishing().update(id, patch),
    },
    {
      name: 'oz.publishing.publish',
      description:
        'Publish a publication NOW via the bulk runner (instagram→ig_post, x→x_post) across its identities. Marks it published on dispatch. Returns { ok, runId } or { __error } (UNSUPPORTED_PLATFORM | NO_TARGETS | NO_MEDIA | NO_BULK). Use oz.bulk.get to poll the run.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => publishing().publish(id),
    },
    {
      name: 'oz.publishing.sched',
      description:
        'Schedule a publication to auto-publish on a recurring schedule via the bulk runner. `schedule` shape: {type:"daily",time:"HH:MM"} | {type:"weekly",day:"mon".."sun",time:"HH:MM"} | {type:"every-minutes",minutes:N}. Creates a Scheduled Action and stores its id on the publication. Returns { ok, action } or { __error } (UNSUPPORTED_PLATFORM | NO_TARGETS | NO_MEDIA | NO_SCHED). Cancel with oz.publishing.unsched.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, schedule: { type: 'object' } },
        required: ['id', 'schedule'],
        additionalProperties: false,
      },
      call: ({ id, schedule }) => publishing().schedule(id, schedule),
    },
    {
      name: 'oz.publishing.unsched',
      description:
        'Cancel a publication’s schedule (removes its Scheduled Action). Returns { ok, removed }.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => publishing().unschedule(id),
    },
    {
      name: 'oz.publishing.remove',
      description: 'Delete a publication by id. Returns true/false.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => publishing().remove(id),
    },
    {
      name: 'oz.publishing.stats',
      description:
        'Publishing analytics over the bulk-run history: success rate by network (instagram/x/facebook), by identity, and by hour of day (UTC). Optional `actions` filters which actionIds to include (default ig_post/x_post/fb_post). Returns { overall, byNetwork, byIdentity, byHour } — each bucket has {items,done,failed,skipped,cancelled,successRate}. Answers "how are my posts doing / when should I post?".',
      inputSchema: {
        type: 'object',
        properties: { actions: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
      call: (args) => publishing().analytics(args || {}),
    },
    {
      name: 'oz.publishing.dryRun',
      description:
        'Pre-flight a publication WITHOUT publishing (Etapa 2 dry-run). Statically validates: platform supported, media present AND exists on disk, identities resolve, and per-identity health gating (red identities are skipped). Does NOT touch the browser. Returns { ok, actionId, issues:[{code,message}], identities:[{identityId,name,exists,health,willPublish}] }. Run this before oz.publishing.publish to catch problems before a mass post.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => publishing().dryRun(id),
    },
    {
      name: 'oz.publishing.preview',
      description:
        'Preview anti-footprint content variation per identity WITHOUT publishing. `spec`: {caption (spintax {a|b} + {{vars}} allowed), hashtags[] (pool), hashtagCount (K of N), firstCommentHashtags (bool), mediaList[] (rotated), vars}. `identities`: [{id,name}]. Returns one row per identity {identityId,name,caption,mediaPath,firstComment}. Deterministic per identityId so the preview matches what would post.',
      inputSchema: {
        type: 'object',
        properties: {
          spec: { type: 'object' },
          identities: { type: 'array', items: { type: 'object' } },
        },
        required: ['spec', 'identities'],
        additionalProperties: false,
      },
      call: ({ spec, identities }) => publishing().preview(spec, identities),
    },
    {
      name: 'oz.publishing.resolve',
      description:
        'Resolve varied content for ONE identity (same engine as preview). `spec` as in oz.publishing.preview; `opts`: {index, identity:{id,name}, vars}. Returns {caption,hashtags,hashtagsText,mediaPath,firstComment}.',
      inputSchema: {
        type: 'object',
        properties: { spec: { type: 'object' }, opts: { type: 'object' } },
        required: ['spec'],
        additionalProperties: false,
      },
      call: ({ spec, opts }) => publishing().resolve(spec, opts),
    },
    {
      name: 'oz.publishing.variety',
      description:
        'Count how many distinct caption variants a spintax string can yield (rough upper bound). Use to warn about low variety before posting to many accounts. Returns { variants }.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      call: ({ text }) => publishing().variety(text),
    },
    {
      name: 'oz.publishing.libList',
      description:
        'List a publishing library collection. kind: templates | hashtags | media.',
      inputSchema: {
        type: 'object',
        properties: { kind: { type: 'string' } },
        required: ['kind'],
        additionalProperties: false,
      },
      call: ({ kind }) => publishing().libList(kind),
    },
    {
      name: 'oz.publishing.libSave',
      description:
        'Add an item to a library collection. kind=templates → item {name,caption,hashtags[]}; kind=hashtags → item {name,tags[]}; kind=media → item {path}.',
      inputSchema: {
        type: 'object',
        properties: { kind: { type: 'string' }, item: { type: 'object' } },
        required: ['kind', 'item'],
        additionalProperties: false,
      },
      call: ({ kind, item }) => publishing().libSave(kind, item),
    },
    {
      name: 'oz.publishing.libDel',
      description: 'Remove a library item by id. kind: templates | hashtags | media.',
      inputSchema: {
        type: 'object',
        properties: { kind: { type: 'string' }, id: { type: 'string' } },
        required: ['kind', 'id'],
        additionalProperties: false,
      },
      call: ({ kind, id }) => publishing().libDel(kind, id),
    },
    {
      name: 'oz.publishing.export',
      description:
        'Export the whole content plan as a matrix (array-of-arrays, row 0 = headers) for Excel/CSV.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => publishing().export(),
    },
  ]
}

module.exports = { buildPublishingTools }
