# Módulo `workspace-manager`

**Path:** `browser/workspace-manager.js`
**Líneas:** ~340
**Bloque/Etapa:** 1.4-WS

## Qué hace

CRUD de Workspaces + persistencia en disk + freeze/archive/duplicate + management de `tabSpecs` (snapshot serializable de las tabs de cada workspace).

Modelo y rationale completos en [ADR 0015](../architecture/0015-workspace-model.md).

## Storage

`~/Library/Application Support/<appName>/workspaces.json`

Mismo patrón que `identities.json`. JSON puro pretty-printed (2 spaces). Cada workspace es un objeto plano serializable.

## Exports

| Símbolo                  | Tipo   | Descripción                                                                 |
| ------------------------ | ------ | --------------------------------------------------------------------------- |
| `WorkspaceManager`       | class  | Backend principal — instanciado una vez por `Browser` en `main.js`.         |
| `DEFAULT_WORKSPACE_ID`   | string | `"general"` — id fijo del workspace Default ("General Browsing").           |
| `QUICK_TAB_MODES`        | array  | `['load-all', 'one-by-one', 'on-click', 'on-click-confirm']` (whitelist).   |
| `DEFAULT_QUICK_TAB_MODE` | string | `"on-click"` — modo Quick Tabs por default (= lazy materialization actual). |

## API de `WorkspaceManager`

| Método                                    | Returns        | Descripción                                                                                                   |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `list()`                                  | array          | Todos los workspaces (incluyendo archived/frozen).                                                            |
| `listActive()`                            | array          | Workspaces no archivados (lo que muestra la UI por default).                                                  |
| `get(id)`                                 | object \| null | Snapshot inmutable (copy de tabSpecs).                                                                        |
| `getDefault()`                            | object         | Default WS — siempre presente.                                                                                |
| `create({name?, color?, quickTabsMode?})` | object         | Nuevo WS no-default, no-archived, no-frozen. Color auto-pickeado si no se pasa.                               |
| `update(id, patch)`                       | object \| null | Whitelisted: `name, color, quickTabsMode`. Rechaza si `isFrozen`. Modo inválido se ignora con log.            |
| `rename(id, name)`                        | object \| null | Wrapper de `update`.                                                                                          |
| `setColor(id, color)`                     | object \| null | Wrapper de `update`.                                                                                          |
| `duplicate(id)`                           | object \| null | Deep clone con id nuevo, `name + " (copy)"`, tabSpecs cloned con ids regenerados, no-default/frozen/archived. |
| `archive(id)`                             | bool           | Default no se puede archivar.                                                                                 |
| `restore(id)`                             | bool           | Unarchive.                                                                                                    |
| `freeze(id)`                              | bool           | Bloquea `update()` futuro. Runtime sigue funcionando.                                                         |
| `unfreeze(id)`                            | bool           | Desbloquea.                                                                                                   |
| `remove(id)`                              | bool           | Default protegido. Si era activo en alguna ventana, el caller (handler) hace switch a Default.                |
| `setTabSpecs(id, specs, activeTabId?)`    | bool           | Reemplaza la lista entera. Funciona aún en frozen (es snapshot path del switch logic).                        |
| `getTabSpecs(id)`                         | array          | Copia inmutable.                                                                                              |
| `appendTabSpec(id, spec)`                 | bool           | Agrega 1 spec al final.                                                                                       |
| `removeTabSpec(id, tabId)`                | bool           | Elimina por `id`.                                                                                             |
| `setActiveTabId(id, tabId)`               | bool           | Recuerda qué tab estaba seleccionada.                                                                         |
| `flush()`                                 | —              | Force-flush de cualquier save throttled pendiente. Llamar en `app.before-quit`.                               |

## Throttled save

`new WorkspaceManager({ saveDelayMs: 2000 })` debouncea writes. Default `0` = save sync (usado por tests).

El switch logic del Bloque 1.4b va a habilitar throttle 2s para coalescing de bursts de `tab-updated` events. Cualquier `setTabSpecs` durante un switch hace un sync `_saveNow` directo (no pasa por `_save`).

## Default workspace

- ID fijo: `"general"` (vs identities donde el default usa también `"default"` fijo).
- Auto-creado en `_load()` si no existe.
- `name = "General Browsing"`, `color = #8a8a8a`.
- No se puede archivar, freezar ni borrar.
- Cuando un WS se borra, fallback de las ventanas que lo tenían activo va a Default.

## Tests

- `tests/workspace-manager.smoketest.js` — 56 tests cubriendo: auto-create Default, CRUD, duplicate, archive/restore, freeze bloqueo, Default protected, tabSpecs management, persistencia round-trip, throttled save + flush, invalid quickTabsMode silenciado.

## Referencias

- [ADR 0015](../architecture/0015-workspace-model.md) — modelo + lock 1-1 + decisión de tabSpecs serializables.
- [ADR 0002](../architecture/0002-lazy-tabs.md) — lazy materialization que reusamos en switch.
- [`workspace-handlers.md`](workspace-handlers.md) — handler map que envuelve este backend.
- [`identity-manager.md`](identity-manager.md) — patrón análogo (CRUD + persistencia).
