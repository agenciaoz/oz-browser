// OZ Browser — Bulk Actions Registry (v2 sub-bloque 1).
//
// Mapa global de actions registradas que `bulk-runner.js` puede ejecutar
// sobre N identities. Cada handler module se auto-registra en boot llamando
// `register(actionId, def)`.
//
// Forma de una action:
//   {
//     id: 'echo',                          // string único, snake_case
//     label: 'Echo (test action)',          // human-readable
//     description: '...',
//     paramsSchema: { /* JSON Schema */ },  // valida los params del run
//     run: async (identity, params, ctx) => result,
//   }
//
// El runner llama `run(identity, params, ctx)` por cada identity. ctx
// expone: { runId, identityIndex, totalIdentities, logger, signal }.
// `signal` es un AbortSignal — los handlers pueden chequearlo si el run
// fue cancelado mid-action.
//
// Doc: docs/modules/bulk-actions-registry.md
// ADR: docs/architecture/0030-bulk-runner.md

'use strict'

const _actions = new Map()

function register(action) {
  if (!action || typeof action !== 'object') {
    throw new Error('register: action must be an object')
  }
  const { id, label, run } = action
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(id)) {
    throw new Error(
      `register: action.id must match /^[a-z][a-z0-9_]{1,63}$/ (got: ${id})`,
    )
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error(`register: action.label required (id=${id})`)
  }
  if (typeof run !== 'function') {
    throw new Error(`register: action.run must be a function (id=${id})`)
  }
  if (_actions.has(id)) {
    throw new Error(`register: action '${id}' already registered`)
  }
  _actions.set(id, {
    id,
    label,
    description: action.description || '',
    paramsSchema: action.paramsSchema || {
      type: 'object',
      additionalProperties: true,
    },
    run,
  })
}

function unregister(id) {
  return _actions.delete(id)
}

function get(id) {
  return _actions.get(id) || null
}

function list() {
  return Array.from(_actions.values()).map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    paramsSchema: a.paramsSchema,
  }))
}

function clear() {
  // For tests only.
  _actions.clear()
}

module.exports = { register, unregister, get, list, clear }
