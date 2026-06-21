# Módulo `publishing-plan-handlers`

**Path:** `browser/publishing-plan-handlers.js`
**Líneas:** ~167
**Bloque:** Publishing E5 (MCP-first, MAIN process)

## Qué hace

Handler map del Publishing Studio, expuesto por IPC (`oz:publishing:*`) y MCP (`oz.publishing.*`) bajo `browser.handlers.publishing`. Una sola fuente de verdad en main (`PublishingPlanStore` + `PublishingLibraryStore`): el agente puede importar un plan, listar, mover de estado, editar, publicar/programar end-to-end vía el bulk runner y exportar. Reusa la lógica pura de `ui/publishing-plan.js` (parse + state machine + buildBulkSpec).

## Exporta / API

| Export                             | Descripción                          |
| ---------------------------------- | ------------------------------------ |
| `buildPublishingHandlers(browser)` | Construye y devuelve el handler map. |

| Handler                  | Descripción                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `import({matrix,rows})`  | Importa plan (matriz Excel o filas mapeadas). Devuelve `{ added, errors }`.           |
| `list(status)`           | Lista (filtrada por estado opcional).                                                 |
| `get(id)`                | Una publicación.                                                                      |
| `status(id, action)`     | Aplica acción del workflow (submit/approve/reject/publish/edit) validando transición. |
| `publish(id)`            | Publica AHORA vía bulk runner; marca `published` si despachó.                         |
| `schedule(id, schedule)` | Crea una Scheduled Action `bulk`; guarda `scheduledActionId`.                         |
| `unschedule(id)`         | Borra la Scheduled Action de la publicación.                                          |
| `update(id, patch)`      | Edita campos.                                                                         |
| `remove(id)`             | Borra.                                                                                |
| `export()`               | Devuelve el plan como matriz (Excel/CSV).                                             |
| `libList/libSave/libDel` | CRUD de la biblioteca (templates/hashtags/media).                                     |

## IPC / MCP

IPC `oz:publishing:*` (`publishing-plan-ipc-setup.js`) y MCP `oz.publishing.*` (`mcp-tools-publishing.js`). `publish`/`schedule` delegan en `browser.handlers.bulk` y `browser.handlers.scheduled`.

## Gotchas

- Errores se devuelven como `{ __error: { code, message } }` (NOT_FOUND, BAD_TRANSITION, UNSUPPORTED_PLATFORM, NO_TARGETS, NO_MEDIA, NO_BULK, NO_SCHED) — no se lanzan.
- `publish`/`schedule` solo soportan instagram (`ig_post`) y x (`x_post`); valida vía `P.buildBulkSpec`.
- Verbos cortos (`sched`/`unsched`/`libList`...) para que el tool MCP quepa en ≤21 chars.
- ADR 0038 · 0005 · 0012.
