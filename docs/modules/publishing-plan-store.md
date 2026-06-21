# Módulo `publishing-plan-store`

**Path:** `browser/publishing-plan-store.js`
**Líneas:** ~129
**Bloque:** Publishing E5 (MCP-first, MAIN process)

## Qué hace

Store del content-plan del Publishing Studio (estilo Ghost): publicaciones con workflow de aprobación, persistidas en el MAIN (JSON atómico) para que tanto el MCP (`oz.publishing.*`) como la UI lean de una sola fuente de verdad — no localStorage del renderer. Shape de publicación: `{ id, status, platform, caption, media[], identities[], scheduledAt, scheduledActionId, createdAt, updatedAt }`. Estados: `draft → review → approved → published`.

## Exporta / API

| Export                | Descripción                                            |
| --------------------- | ------------------------------------------------------ |
| `PublishingPlanStore` | Clase store (constructor requiere `opts.userDataDir`). |
| `SCHEMA_VERSION`      | Versión del esquema en disco (1).                      |
| `STATUSES`            | `['draft','review','approved','published']`.           |

| Método                  | Descripción                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `list()`                | Todas las publicaciones (copias).                                 |
| `listByStatus(status)`  | Filtra por estado.                                                |
| `get(id)`               | Una publicación por id o `null`.                                  |
| `add(pub)`              | Crea (id `pub-<hex>`, status default `draft`); unshift al frente. |
| `addMany(pubs)`         | Bulk add (import Excel); devuelve count.                          |
| `update(id, patch)`     | Patch de campos permitidos; bumpea `updatedAt`.                   |
| `setStatus(id, status)` | Cambia estado si es válido.                                       |
| `remove(id)`            | Borra; devuelve bool.                                             |

## IPC / MCP

Consumido por `publishing-plan-handlers.js`, expuesto vía IPC `oz:publishing:*` y MCP `oz.publishing.*` (list/get/update/remove/status/import).

## Gotchas

- Persistencia atómica: escribe a `userData/publishing-plan.json.tmp-<pid>-<ts>` y hace `renameSync` (patrón `project-store`).
- `clock` inyectable (`opts.clock.now`) para tests deterministas.
- `update()` solo aplica claves de un allowlist (`status/platform/caption/media/identities/scheduledAt/scheduledActionId`).
- `_load()` ignora archivos corruptos o con `version` distinta → arranca vacío.
- ADR 0038 (publishing-studio) · 0005 (modular).
