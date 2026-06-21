# Módulo `publishing-library-store`

**Path:** `browser/publishing-library-store.js`
**Líneas:** ~108
**Bloque:** Publishing E1-E4 → migración MCP-first (MAIN process)

## Qué hace

Store de las colecciones de autoría del Publishing Studio (plantillas de caption, grupos de hashtags, media library). Antes vivían en localStorage del renderer → el MCP no las podía tocar; esto las mueve al MAIN (JSON atómico) para que el agente las maneje vía `oz.publishing.lib*` y la UI lea de la misma fuente. Persistencia: `userData/publishing-library.json` con `{ version, templates[], hashtags[], media[] }`.

## Exporta / API

| Export                   | Descripción                                            |
| ------------------------ | ------------------------------------------------------ |
| `PublishingLibraryStore` | Clase store (constructor requiere `opts.userDataDir`). |
| `SCHEMA_VERSION`         | Versión del esquema (1).                               |
| `KINDS`                  | `['templates','hashtags','media']`.                    |

| Método             | Descripción                                                                        |
| ------------------ | ---------------------------------------------------------------------------------- |
| `list(kind)`       | Items de una colección (copias); `[]` si el kind es inválido.                      |
| `save(kind, item)` | Crea item normalizado por kind (id `lib-<hex>`); unshift. `null` si kind inválido. |
| `remove(kind, id)` | Borra item por id; devuelve bool.                                                  |

## IPC / MCP

Consumido por `publishing-plan-handlers.js` (`libList`/`libSave`/`libDel`), expuesto vía MCP `oz.publishing.libList|libSave|libDel` e IPC `oz:publishing:libList|libSave|libDel`.

## Gotchas

- Normalización por kind: `templates` → `{id,name,caption,hashtags[]}` (name truncado a 80); `hashtags` → `{id,name,tags[]}` (tags trimmed, sin `#` inicial); `media` → `{id,path}` (acepta string crudo, dedupe por path).
- Persistencia atómica (tmp + `renameSync`).
- `_load()` descarta archivos corruptos o de otra versión → arranca con colecciones vacías.
- ADR 0038 · 0005.
