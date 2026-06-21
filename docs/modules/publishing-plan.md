# Módulo `publishing-plan`

**Path:** `browser/ui/publishing-plan.js`
**Líneas:** ~261
**Bloque:** Publishing E5 (lógica pura, dual-export)

## Qué hace

Lógica PURA (sin DOM) para "cargar un mes de contenido de una": parsea una hoja de Excel a publicaciones, valida/normaliza, corre la máquina de estados de aprobación (`draft → review → approved → published`, con `reject` y `edit` que vuelven a draft), exporta de vuelta a matriz, y arma el spec del bulk runner para publicar. Dual-export: node (`module.exports`) y browser global (`window.OZ.PublishingPlan`).

## Exporta / API

| Función                          | Descripción                                                              |
| -------------------------------- | ------------------------------------------------------------------------ |
| `STATUSES`                       | `['draft','review','approved','published']`.                             |
| `TRANSITIONS`                    | Mapa acción → `{ estadoActual: estadoSiguiente }`.                       |
| `ACTION_BY_PLATFORM`             | plataforma → actionId del bulk runner (`instagram→ig_post`, `x→x_post`). |
| `canonicalHeader(h)`             | Mapea un header crudo (alias EN/ES) al campo canónico o `null`.          |
| `normalizePlatform(p)`           | Normaliza nombre de plataforma; `''` si no se reconoce.                  |
| `matrixToPlanRows(matrix)`       | Hoja (array de arrays, fila 0 = headers) → objetos de fila.              |
| `parsePlanRows(rows)`            | Valida/normaliza → `{ publications, errors }` (status `draft`).          |
| `canTransition(current, action)` | ¿La acción es válida desde el estado actual?                             |
| `nextStatus(current, action)`    | Próximo estado o el actual si no aplica.                                 |
| `planToMatrix(publications)`     | Publicaciones → matriz (headers + filas) para Excel/CSV.                 |
| `platformToActionId(platform)`   | actionId del bulk runner o `null`.                                       |
| `buildPublishParams(platform,p)` | Params exactos de la action (`ig_post`/`x_post`).                        |
| `buildBulkSpec(pub)`             | Valida + arma `{ spec:{actionId,identityIds,params} }` o `{ __error }`.  |

## IPC / MCP

No registra IPC directamente (lógica pura). La consume `publishing-plan-handlers.js` (main) y la UI del renderer vía `window.OZ.PublishingPlan`.

## Gotchas

- `buildBulkSpec` es la ÚNICA fuente de verdad para `publish()` y `schedule()`: valida plataforma soportada (`UNSUPPORTED_PLATFORM`), identities (`NO_TARGETS`) y media para IG (`NO_MEDIA`).
- `parsePlanRows` requiere platform reconocida y (caption o media); `date` es opcional (sin date = sin programar).
- `_splitList` separa media/identities por `;` o `,`.
- ADR 0038 · 0005.
