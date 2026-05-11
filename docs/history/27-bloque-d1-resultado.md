# Bloque D-1 — Time Machine backup remoto + cross-device restore (resultado)

**Status:** ✅ Cerrado 2026-05-10 noche
**Commits:** TBD (main directo, batch al cierre)
**Tiempo:** ~9-11h efectivas vs ~11-13h estimadas (Full scope)
**Deps nuevas:** 0 — `dropbox@10.34.0` ya pre-instalada
**Tests:** 1776 → 2008 (+232)
**Files added:** 6 source + 5 tests + 1 ADR + 1 history entry

## Origen

Próximo chunk natural del plan post-E2-C. Ghost Browser feature parity dice que el backup local no alcanza — el user real (Jose: 30+ cuentas IG) quiere DR completa si formatea o le roban la Mac. Dropbox decidido en inventario 2026-05-10 noche bis (vs Supabase storage por costo, vs cero-replica por riesgo).

E2-B (foundation infra: protocol handler `oz://` + dotenv + OAuth helper PKCE + Keychain) ya estaba cerrado de antes, así que D-1 entró con la pista lista.

## Decisiones de scope (vía AskUserQuestion al inicio)

1. **Scope D-1**: Full backup + multi-device picker (round-trip + device list + "Restore from device X"). Vs Tight upload-only o Round-trip. Razón: el headline feature de Ghost-vs-OZ es el cross-device, vale invertir el extra para no fragmentar el chunk.
2. **Upload trigger**: Auto + manual button (recommended). Hook en daily cron + pre-OVERWRITE_TOTAL + manual snapshot + botón "Upload now" + toggle ON/OFF.

## Arquitectura (resumen — detalle en ADR 0025)

```
┌───────────────────────────────────────────────────────────────────┐
│ Browser process                                                    │
│                                                                    │
│  ┌─ device-info.js ──┐  UUID v4 + hostname slug. Persistido en    │
│  │                    │  userData/device-info.json. shortId estable │
│  └────────────────────┘  cross-boot. Genera deviceFolder slug.     │
│                                                                    │
│  ┌─ dropbox-client.js ─┐  Wrapper sobre dropbox@10.34.0 SDK.       │
│  │                      │  OAuth via oauth-helper (PKCE + Keychain).│
│  │                      │  Auto-refresh on 401. upload/download/    │
│  │                      │  list/delete/ensureFolder.                │
│  └──────────────────────┘                                          │
│                                                                    │
│  ┌─ cloud-backup-manager.js ─┐  Orquesta el flujo. Estado en       │
│  │                            │  cloud-backup.json. Auto-upload     │
│  │                            │  listener sobre BackupManager       │
│  │                            │  'snapshot-created' event.          │
│  │                            │  uploadSnapshot, downloadSnapshot,  │
│  │                            │  restoreFromCloud, listDevices,     │
│  │                            │  listRemoteSnapshots, delete.       │
│  └────────────────────────────┘                                    │
│                                                                    │
│  ┌─ cloud-backup-handlers.js ─┐  IPC map (status, connect,         │
│  │                             │  disconnect, setAutoUpload,        │
│  │                             │  uploadNow, listDevices,           │
│  │                             │  listRemoteSnapshots,              │
│  │                             │  downloadAndRestore, deleteRemote).│
│  │                             │  Vault gate + pre-restore safety.  │
│  └─────────────────────────────┘                                   │
│                                                                    │
│  ┌─ cloud-backup-setup.js ──┐  main.js wire-up extraído (LOC).     │
│  │                           │  Instancia DeviceInfo + DropboxClient│
│  │                           │  + CloudBackupManager + registra el  │
│  │                           │  protocol dispatcher para            │
│  │                           │  oz://auth/dropbox/callback.         │
│  └───────────────────────────┘                                     │
│                                                                    │
│  ┌─ backup-manager.js ─┐  +EventEmitter (snapshot-created). Cambio  │
│  │  (modificado)        │  quirúrgico — cero impacto en callers.    │
│  └──────────────────────┘                                          │
└────────────────────────────────────────────────────────────────────┘
                                  ↑
                                  │ IPC oz:cloud-backup:*
                                  ↓
┌───────────────────────────────────────────────────────────────────┐
│ Renderer (browser/ui/cloud-backup.js + webui.html modal)           │
│   Disconnected view → Connect Dropbox button                       │
│   Connected view → account, deviceFolder, auto-upload toggle,      │
│                    last upload status, lista de devices con cards. │
│   Cada device card expande lista de snapshots → Restore + Delete.  │
└────────────────────────────────────────────────────────────────────┘
```

## Sub-bloques

| Sub   | Qué                                                       | Tests       | LOC del archivo principal |
| ----- | --------------------------------------------------------- | ----------- | ------------------------- |
| D-1.1 | device-info.js                                            | 49          | 219                       |
| D-1.2 | dropbox-client.js                                         | 71          | 339                       |
| D-1.3 | EventEmitter en BackupManager + cloud-backup-manager core | 52          | 282 (post D-1.4)          |
| D-1.4 | download + restoreFromCloud + listDevices                 | 27          | (mismo file)              |
| D-1.5 | cloud-backup-handlers.js + preload expose                 | 33          | 188                       |
| D-1.6 | UI panel cloud-backup.js + time-machine integration       | (UI manual) | 336                       |
| D-1.7 | main.js wire-up + protocol dispatcher + boot smoke        | (smoke)     | cloud-backup-setup.js: 90 |
| D-1.8 | ADR 0025 + module docs + history + memory update          | n/a         | n/a                       |

## Tests breakdown

- `device-info.smoketest.js` — 49 (slugify edge cases, UUID v4 RFC, idempotencia, corrupt JSON regen, factory validation).
- `dropbox-client.smoketest.js` — 71 (path normalization, OAuth wrappers, ensureFolder idempotency, upload/download/list/delete, 401→refresh→retry, NEEDS_REAUTH branches).
- `cloud-backup-manager.smoketest.js` — 52 (state I/O, connect, disconnect, autoUpload, uploadSnapshot, listRemote, delete, auto-upload hook con filter pre-restore, listener error swallowing).
- `cloud-backup-restore.smoketest.js` — 27 (download, restoreFromCloud cross-device, listDevices current-first + counts).
- `cloud-backup-handlers.smoketest.js` — 33 (IPC pass-through, vault gate, broadcast emission, pre-restore safety, error code propagation).

Total D-1: **232 tests nuevos**. Regression de `backup-manager.smoketest.js` post-EventEmitter: 40/40 verdes.

## Trade-offs aceptados

- Chunked upload diferido a D-2 (snapshots >140MB → `TOO_LARGE`). Real-world < 50MB.
- Cross-device restore requiere Keychain del device origen en device destino (zero-knowledge). Team mode con key-sharing Curve25519 viene en bloque E.
- Production tier Dropbox = Apply manual post-validación. Development tier (250 user cap) cubre todos los betas.

## Decisión arquitectural clave: per-device folder con UUID + hostname

Detalle completo en ADR 0025. TL;DR: MAC address inestable en macOS (Private Address Randomization), hostname solo colisiona en team con plantilla MDM, UUID local + hostname-slug combina estabilidad y legibilidad.

## Quirks operativos

- Apóstrofes y comillas droppados ANTES del replace genérico → "Jose's MacBook Pro" → "joses-macbook-pro" (no "jose-s-macbook-pro").
- `os.hostname()` real de Jose es "Jose's MacBook Pro (local)" → slug "joses-macbook-pro-local" (paréntesis tratados como separador). shortId garantiza unicidad incluso si otro device produce el mismo slug.
- Prettier reformateó archivos post-lint:fix (auto). Cero cambios semánticos. 12 files touched.

## Validación

- ✅ 232/232 D-1 tests verde + 40/40 backup-manager regression.
- ✅ Full suite: 2008 passed, 0 failed.
- ✅ `npm run check:loc` passa (max 498/500 main.js).
- ✅ `npm run lint` passa.
- ✅ Smoke visual: boot limpio, DeviceInfo loaded shortId `bff00ff9` deviceFolder `joses-macbook-pro-local-bff00ff9`, CloudBackupManager initialized, Time Machine modal abre (regression OK).
- ⏳ Pendiente: visual del Cloud Backup modal con vault desbloqueado (requiere Touch ID de Jose; se valida next session) + real OAuth round-trip con Dropbox.

## Próximo chunk

Bloque D-2: ADR sync engine + chunked upload + delta sync para identities/workspaces/cookies cross-device. ~5-8h estimadas.
