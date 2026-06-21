# Módulo `headless-runner`

**Path:** `browser/headless-runner.js`
**Líneas:** ~202
**Bloque:** V3-D scraping / agent-control

## Qué hace

Ejecuta un "recipe" de pasos de página bajo una identity, en modo headless. El `driver` se inyecta (es el objeto de `page-handlers.js`: navigate/click/type/getText/getAttr/queryAll/extract/eval/scroll/waitFor/screenshot/captcha). Errores transitorios de un paso se reintentan con backoff exponencial (`scrape-retry`); captcha/needs_login/fatales NO. Un paso `optional:true` no aborta el recipe si falla.

## Exporta / API

| Export                    | Descripción                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `runHeadlessRecipe(args)` | Corre un recipe completo → `{ ok, steps, data }`.              |
| `validateRecipe(recipe)`  | Valida la forma del recipe → `{ valid, errors }` (no ejecuta). |
| `VALID_OPS`               | Ops válidos = métodos esperados en el driver.                  |

`args`: `{ recipe, driver, identityId, tabId?, retry?, clock?, signal?, logger? }`. Recipe: `{ steps: [{ op, ... }] }`.

## IPC / MCP

No registra IPC directamente (lógica pura). El bootstrap real (hidden window + page-handlers) vive en `headless-setup.js`; también lo reutiliza `scrape-worker.js`.

## Gotchas

- `driver` + `clock` inyectables → testeable sin Electron (fake driver en tests).
- Aborta en el primer paso NO-opcional que falla (`ok:false`, break); pasos `optional` solo se loguean.
- Resultados de step con `name` se guardan en `data[step.name]` (para extract/getText/etc).
- Un driver-op que devuelve `{ __error:{code,message} }` se convierte a Error y se clasifica; `BAD_OP` si el driver no tiene el método.
- ADR 0030 · 0005 · 0036.
