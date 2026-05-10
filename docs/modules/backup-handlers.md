# Módulo `backup-handlers`

**Path:** `browser/backup-handlers.js`
**Líneas:** ~165
**Bloque/Etapa:** 1.6b (Time Machine)

## Qué hace

Handler map para el dominio `timemachine`. Envuelve `BackupManager` con (a) vault gate, (b) auto pre-restore safety net, (c) broadcast events. Consumido por IPC (`ipc-handlers.js`) y MCP (`mcp-tools-vault.js`) — mismo patrón shared transports.

## Vault gate

Operaciones que requieren vault unlocked: `create`, `restore`. Devuelven `{__error:{code:'LOCKED'}}` si locked.

`list` y `applyRetention` NO requieren unlock — solo leen headers (no decrypt) o borran files.

## Pre-restore safety net (CRÍTICO)

`restore(id)` SIEMPRE crea un snapshot del estado actual con `reason='pre-restore'` antes de invocar `BackupManager.restoreSnapshot`. Si el snapshot pre-restore falla por cualquier motivo, el restore aborta con `PRE_RESTORE_FAILED` — no proceedeamos sin red de seguridad.

Si el restore real falla después del pre-restore, devolvemos `{__error}` con `preRestoreId` para que el user pueda revertir.

Post-restore exitoso:

1. `vault.lock()` — el `vault.enc` en disco cambió, la key in-memory ya no decifra el nuevo content.
2. Broadcast `oz:vault:changed`, `oz:timemachine:changed`, `oz:timemachine:restore-completed`.
3. Devuelve `{ok, requiresRestart: true, preRestoreId, restoredCount}`.

UI muestra alert "restart OZ now" porque `IdentityManager`/`WorkspaceManager` cargan al boot — su state in-memory queda stale hasta restart.

## Handlers

| Nombre                 | Args                                        | Returns                                                                                 |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `create(opts)`         | `{label?, reason?}` (default reason=manual) | `{ok, id, header, filePath}` o `{__error}`                                              |
| `list()`               | —                                           | array (sin decrypt) o `{__error}`                                                       |
| `restore(id)`          | `id`                                        | `{ok, preRestoreId, restoredCount, requiresRestart}` o `{__error{code, preRestoreId?}}` |
| `remove(id)`           | `id`                                        | `{ok, deleted: bool}` o `{__error}`                                                     |
| `applyRetention(opts)` | `{keepDailyDays?}`                          | `{ok, deletedCount, deletedIds}` o `{__error}`                                          |

## IPC channels

```
oz:timemachine:create
oz:timemachine:list
oz:timemachine:restore
oz:timemachine:remove
oz:timemachine:applyRetention
```

## MCP tools

```
oz.timemachine.create
oz.timemachine.list
oz.timemachine.restore
oz.timemachine.remove
oz.timemachine.applyRetention
```

Mismo handler map → contract test en `tests/mcp-server.smoketest.js` valida simetría.

## Broadcast events

| Channel                            | Cuándo                                                      |
| ---------------------------------- | ----------------------------------------------------------- |
| `oz:timemachine:changed`           | Tras create / restore / remove / applyRetention con cambios |
| `oz:vault:changed`                 | Tras restore (vault se locked auto)                         |
| `oz:timemachine:restore-completed` | Tras restore exitoso, payload `{id, preRestoreId}`          |

## Referencias

- [`backup-manager.md`](backup-manager.md) — backend.
- [`account-vault.md`](account-vault.md) — vault gate.
- [`ui-time-machine.md`](ui-time-machine.md) — frontend que consume estos handlers.
