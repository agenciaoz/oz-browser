# Módulo `ui-time-machine`

**Path:** `browser/ui/time-machine.js` (~310 LOC)
**Bloque/Etapa:** 1.6c

## Qué hace

Modal montado sobre la WebUI para gestionar snapshots Time Machine. Mismo patrón que `account-manager.js` (1.5f). Botón `⏱ Time Machine (N)` arriba del sidebar (debajo del 🔐 Accounts) con count de snapshots actuales.

Dos vistas conmutables:

1. **locked** — vault bloqueado, botón Unlock vault (mismo flow que Account Manager).
2. **list** — toolbar con `⏱ Take snapshot now` (manual) + `Run retention`. Lista cronológica de snapshots con icon-por-reason / label / reason badge / when / size / restore + delete por row.

## Reasons icons

| Reason                | Icon | Badge color |
| --------------------- | ---- | ----------- |
| `manual`              | 📌   | gris        |
| `pre-quit`            | 🚪   | gris        |
| `pre-overwrite-total` | ⚠️   | amarillo    |
| `pre-restore`         | ↩    | amarillo    |
| `daily-3am`           | 🌙   | azul accent |

## Restore UX

Click `↩` por row → `confirm()` con detalles del snapshot + warning de reemplazo + nota del pre-restore automático. Si user OK:

1. `window.oz.timemachine.restore(id)` (handler hace el pre-restore + restore + lock + broadcast).
2. Si OK: viene el evento `oz:timemachine:restore-completed` con `{id, preRestoreId}` → modal muestra alert grande "restart OZ now" + ID del pre-restore para rollback.
3. Si error: muestra `__error.message` + `preRestoreId` (si existe) en el banner — el user sabe que su data está intacta.

## Eventos consumidos

| Evento                             | Reacción                                              |
| ---------------------------------- | ----------------------------------------------------- |
| `oz:timemachine:changed`           | Refresca count del badge + re-render lista si abierto |
| `oz:vault:changed`                 | Re-evalua locked/unlocked view si modal abierto       |
| `oz:timemachine:restore-completed` | Alert "restart OZ now" + pre-restore id               |

## Snapshot now flow

Click `⏱ Take snapshot now` → `window.oz.timemachine.create({reason: 'manual'})` → broadcast → re-render. Botón disabled mientras la operación corre (snapshots de userData grandes pueden tardar segundos).

## Run retention

Click `Run retention` → `window.oz.timemachine.applyRetention()` (defaults a 30d) → alert con `deletedCount` → re-render.

## Helpers de display

- `fmtDate(iso)` → local date-time corto.
- `fmtSize(bytes)` → human-readable B/KB/MB/GB.

## Gotchas

- **Restart después de restore**: identidades/workspaces se cargan al boot. Si el user no reinicia post-restore, la UI muestra estado in-memory stale (snapshots, accounts vienen del nuevo `vault.enc` post-unlock; identities/workspaces siguen del JSON viejo). El alert de restart-completed cubre esto.
- **Daily badge stale**: `_refreshCountBadge` llama `vault.status` + `timemachine.list` al boot y en `timemachine:changed`. No hay polling — si el daily-3am corre y el modal nunca se abrió, el badge se actualiza por el broadcast del cron (`oz:timemachine:changed`).

## Referencias

- [`backup-handlers.md`](backup-handlers.md) — handlers consumidos.
- [`backup-manager.md`](backup-manager.md) — backend.
- [`ui-account-manager.md`](ui-account-manager.md) — patrón análogo de modal full-screen.
