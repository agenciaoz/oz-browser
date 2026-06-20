// OZ Browser — Bulk Runner real clock (extraído por budget de LOC, ADR 0005).
//
// Provee el `clock` por defecto del BulkRunner: un sleep cancelable por
// AbortSignal. Los tests inyectan su propio clock fake, así que esto solo se
// usa en runtime real.
//
// ADR: 0030 (bulk-runner) · 0005 (modular).

'use strict'

function realClock() {
  return {
    sleep(ms, signal) {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, ms)
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true },
          )
        }
      })
    },
  }
}

module.exports = { realClock }
