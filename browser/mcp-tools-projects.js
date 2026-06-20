// OZ Browser — MCP tool catalog: projects (F2, Ghost-style save/restore).
//
// Exports: buildProjectTools({ projects }) — getter al handler map.
// ADR: 0005 (modular) · 0012 (oz-mcp-server).

'use strict'

function buildProjectTools({ projects }) {
  return [
    {
      name: 'oz.projects.list',
      description:
        'List saved projects (named tab sets): { id, name, type, createdAt, tabCount }. type is "workspace" (active workspace tabs) or "session" (all workspaces).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => projects().list(),
    },
    {
      name: 'oz.projects.get',
      description: 'Get one project with its full tab list.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => projects().get(id),
    },
    {
      name: 'oz.projects.save',
      description:
        'Save the current tabs as a named project. type "workspace" saves the focused window/workspace; "session" saves every window. Returns { id, name, type, tabCount }.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['workspace', 'session'] },
        },
        required: ['name'],
        additionalProperties: false,
      },
      call: ({ name, type }) => projects().save({ name, type }),
    },
    {
      name: 'oz.projects.open',
      description:
        'Reopen a saved project: recreates its tabs (lazy) under their identities. Returns { ok, opened, total }.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => projects().open(id),
    },
    {
      name: 'oz.projects.rename',
      description: 'Rename a saved project. Returns true/false.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name'],
        additionalProperties: false,
      },
      call: ({ id, name }) => projects().rename(id, name),
    },
    {
      name: 'oz.projects.remove',
      description: 'Delete a saved project. Returns true/false.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => projects().remove(id),
    },
  ]
}

module.exports = { buildProjectTools }
