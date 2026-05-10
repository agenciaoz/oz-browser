# Bloque 1.6 — Time Machine · Resultado

**Fecha:** 2026-05-10 (3 sub-fases en una sesión continua)
**Estimación:** ~5h · **Real:** ~4h efectivas (1.6a 2h + 1.6b 1h + 1.6c 1h)
**Estado:** ✅ Cerrado. CI verde. **549/549 tests** al cierre. Cero deps nuevas.

## Por qué este bloque

Red de seguridad pre-OVERWRITE_TOTAL del Excel import (1.5e). Sin esto, un user que importa un Excel mal preparado puede destruir su vault entero sin recuperación. Con Time Machine, OVERWRITE_TOTAL crea un snapshot automático antes — el user puede revertir desde la lista del Time Machine.

Además: snapshots diarios + manuales + pre-quit como red de seguridad general (similar a Time Machine de macOS pero para el state interno de OZ).

Diferenciador adicional: Ghost Browser no tiene NADA de backup. Snapshot+restore en local es feature premium.

## Qué se entregó (sub-fase por sub-fase)

### 1.6a — Backup format + manager + tests

`browser/backup-manager.js` (~452 LOC). Clase `BackupManager` con createSnapshot/listSnapshots/restoreSnapshot/deleteSnapshot/applyRetention. Formato `.ozbackup` = `[u32 headerLen][headerJson][iv][authTag][AES-GCM(gzip(flatpack(payload)))]`. Header JSON visible (no cifrado) para listar metadatos sin descifrar. FlatPack format custom (cero deps tar) — `[u32 nameLen][name][u32 contentLen][content]` repetido + end marker `[0][0]`.

Reusa la master key del Vault via `Vault.getMasterKey()` (nuevo getter público agregado al Vault en este bloque). Sin Keychain → sin restore (single point of recovery, mismo trade-off que vault.enc).

Walk recursivo de `userData/Partitions/*` para incluir cookies/IndexedDB/localStorage/service-workers — backup completo bit-perfect.

`tests/backup-manager.smoketest.js`: **40/40** tests cubriendo flatpack round-trip, AES-GCM tamper detection, LOCKED gate, listSnapshots sin decrypt, restoreSnapshot bit-perfect (sha256 hash de cada file pre/post), retention policy keep-daily-30d + 1-weekly-forever, isoWeek UTC-safe.

Bug encontrado y arreglado en tests: `isoWeek()` usaba `getFullYear()` (local time) — en zonas horarias negativas (CRT) los días se desplazaban. Migrado a `getUTC*` consistente. Test directo del helper agregado para regression.

### 1.6b — Triggers + retention + IPC + MCP

`browser/backup-handlers.js` (~165 LOC). Handler map `timemachine.*` con vault gate uniforme + auto pre-restore safety net (restore SIEMPRE crea pre-restore snapshot antes; si falla aborta con `PRE_RESTORE_FAILED`).

5 triggers wireados:

- **manual** — `Cmd+Shift+B` (atajo en `menu.js`) + UI button
- **pre-quit** — `before-quit` hook en `main.js` (skip silently si vault locked)
- **pre-overwrite-total** — hook en `excel-handlers.OVERWRITE_TOTAL` antes de `setAccounts`. Devuelve `preDestructiveSnapshotId` en la response del import
- **pre-restore** — auto en `backup-handlers.restore` (CRÍTICO, no proceede sin él)
- **daily-3am** — `Browser._installBackupCron()` setInterval cada 60min checa hora local + duplicate-detection por día

5 IPC channels + 5 MCP tools `oz.timemachine.*`. Contract test extendido con regex incluyendo `timemachine`.

Restore post-éxito: `vault.lock()` automático (vault.enc en disco cambió), broadcast `oz:vault:changed` + `oz:timemachine:changed` + `oz:timemachine:restore-completed`. Devuelve `requiresRestart: true` para que la UI alert al user.

### 1.6c — UI Time Machine + visual smoke + cierre

`browser/ui/time-machine.js` (~310 LOC). Modal full-screen montado sobre WebUI con 2 vistas (locked / list). Botón `⏱ Time Machine (N)` arriba del sidebar con count realtime. Toolbar con `⏱ Take snapshot now` + `Run retention`. Lista cronológica con icon-por-reason (📌 manual, 🚪 pre-quit, ⚠️ pre-overwrite-total, ↩ pre-restore, 🌙 daily-3am) + reason badge color-coded + restore + delete.

Restore UX: `confirm()` con detalles + warning + nota del pre-restore automático. Post-success: alert grande "restart OZ now" con preRestoreId visible para rollback path.

Validación visual via Desktop Commander con OZ corriendo + MCP server:

- 46 MCP tools (incluyendo los 5 nuevos `timemachine.*`)
- BackupManager loaded en boot, snapshotsDir creado
- Vault unlock OK
- 2 snapshots creados via MCP (manual + pre-quit) — header JSON correcto, 196 files cada uno (configs + vault + Partitions completas), 29KB compressed cada uno
- listSnapshots devuelve newest-first con metadata
- Files en disco bajo `~/Library/Application Support/OZ Browser/data/snapshots/*.ozbackup`

## Tests al cierre

| Suite                            | Pass        |
| -------------------------------- | ----------- |
| `account-handlers.smoketest.js`  | 51/51       |
| `account-vault.smoketest.js`     | 30/30       |
| `anti-logout.smoketest.js`       | 38/38       |
| `backup-manager.smoketest.js` 🆕 | 40/40       |
| `excel-io.smoketest.js`          | 25/25       |
| `identity-manager.smoketest.js`  | 29/29       |
| `mcp-server.smoketest.js`        | 92/92       |
| `move-to-workspace.smoketest.js` | 29/29       |
| `site-templates.smoketest.js`    | 125/125     |
| `window-workspace.smoketest.js`  | 36/36       |
| `workspace-manager.smoketest.js` | 56/56       |
| **TOTAL**                        | **551/551** |

`check:loc` verde — máximo 452 LOC en `browser/backup-manager.js`. `npm run lint` clean.

## Cero deps nuevas

Todo con `crypto` + `zlib` + `fs` nativos de Node + DOM nativo del WebUI. Cumple el plan original "cero deps" del Bloque 1.6.

## Cloud backup futuro (C-19, post-Etapa 7-OFFICE)

**Idea estratégica de Jose anotada en este bloque:** subir los `.ozbackup` cifrados a Dropbox/Supabase como servicio premium. La base local del 1.6 ya queda compatible — `.ozbackup` es file-standalone + cifrado client-side, backend cloud nunca ve plaintext (zero-knowledge). Diferenciador masivo vs Ghost que no tiene ni backup local. Pricing target: ~$5-10/mes addon o incluido en plan Business.

Reusa el backend Dropbox de Etapa 7-OFFICE (cero infra cost adicional). Master key sigue local en Keychain — compromise de Dropbox no compromete data.

## Lo que quedó OUT del Bloque 1.6

- **Streaming snapshot** (in-memory para v1, suficiente para Partitions <500MB).
- **Diff view** entre snapshots (UX nice-to-have post-v1).
- **Atomic restore con staging dir** (overwrite directo + pre-restore snapshot como rollback).
- **Catch-up daily** si OZ estuvo cerrado (decisión: pre-quit cubre).
- **Cloud backup** (C-19 post-Etapa 7-OFFICE).
- **Custom retention policy UI** (Settings panel viene en bloque 1.10).

## Próximos pasos

Bloque 1.7 — Tab Context Menu (16 opciones replicando Ghost) o 1.8 Proxy Manager. Decidir según prioridad de Jose.

## Referencias

- Docs módulos: `backup-manager`, `backup-handlers`, `ui-time-machine`.
- ADRs: 0008 (vault crypto, key reuse), 0005 (modular 500 LOC).
- PLAN-MAESTRO §1 — Bloque 1.6.
