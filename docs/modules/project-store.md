# Módulo `project-store`

**Path:** `browser/project-store.js`
**Líneas:** ~129
**Bloque:** Ghost F2 (save & restore)

## Qué hace

Store de "proyectos" estilo Ghost (save & restore): guarda sets de tabs con nombre que el usuario puede cerrar y reabrir idénticos. Dos alcances: `type 'workspace'` (las tabs del workspace activo) y `type 'session'` (snapshot de TODOS los workspaces). Cada tab guardada: `{ identityId, url, title, workspaceId }`. Solo persistencia; la captura del estado vivo y el reopen viven en `project-handlers.js`.

## Exporta / API

| Export           | Descripción                                            |
| ---------------- | ------------------------------------------------------ |
| `ProjectStore`   | Clase store (constructor requiere `opts.userDataDir`). |
| `SCHEMA_VERSION` | Versión del esquema (1).                               |
| `VALID_TYPES`    | `['workspace','session']`.                             |

| Método                   | Descripción                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `list()`                 | Metadata-only `{ id, name, type, createdAt, tabCount }`, más reciente primero. |
| `get(id)`                | Proyecto completo (con tabs, deep-cloned) o `null`.                            |
| `save({name,type,tabs})` | Guarda proyecto nuevo (id `prj-<hex>`); devuelve metadata.                     |
| `rename(id, name)`       | Renombra; devuelve bool.                                                       |
| `remove(id)`             | Borra; devuelve bool.                                                          |

## IPC / MCP

Consumido por `project-handlers.js`, expuesto vía IPC `oz:projects:*` (`project-ipc-setup.js`) y MCP `oz.projects.*` (list/get/save/open/rename/remove).

## Gotchas

- Persistencia atómica `userData/projects.json` (tmp + `renameSync`), mismo patrón que bulk-runs / crawl-frontier.
- `clock` inyectable para tests.
- `save` sanea: name vacío → `Untitled`, type inválido → `workspace`, tabs sin `url` se filtran.
- `_load()` solo acepta proyectos con `id` y `tabs` array; corrupto o de otra versión → arranca vacío.
- ADR 0005 (modular).
