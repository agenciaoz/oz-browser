// OZ Browser — Bulk Action: echo (v2 sub-bloque 1 test action).
//
// Action de prueba para validar el motor sin tocar plataformas reales.
// Acepta `{message, delayMs?, failRate?}` y por cada identity:
//   - Espera `delayMs` (default 0)
//   - Con probabilidad `failRate` (default 0) lanza un error
//   - Si no, retorna `{identityId, identityName, message, echoedAt}`
//
// Útil para testear: orden de ejecución, jitter, cancelación, failure-report.
//
// Doc: docs/modules/bulk-actions-echo.md

'use strict'

const echoAction = {
  id: 'echo',
  label: 'Echo (test action)',
  description:
    'Test action that echoes a message per identity. Used to validate the bulk runner without touching real platforms. Optional delayMs to simulate work; optional failRate (0..1) to inject failures.',
  paramsSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      delayMs: { type: 'number', minimum: 0, maximum: 60_000 },
      failRate: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['message'],
    additionalProperties: false,
  },
  async run(identity, params, ctx) {
    const { message, delayMs = 0, failRate = 0 } = params || {}
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs)
        if (ctx && ctx.signal) {
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }
      })
    }
    if (failRate > 0 && Math.random() < failRate) {
      throw new Error(`echo: injected failure (failRate=${failRate})`)
    }
    return {
      identityId: identity.id,
      identityName: identity.name,
      message,
      echoedAt: new Date().toISOString(),
    }
  },
}

module.exports = { echoAction }
