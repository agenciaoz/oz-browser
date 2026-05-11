# Bloque E2-C-2 — Crash recovery con state restore

**Cerrado:** 2026-05-10 (sesión continua post-C-4)
**Tiempo efectivo:** ~2h vs ~3h estimadas (-33% por scope ajustado en 3 preguntas)
**Branch:** `main` directo (siguiendo el approach post-merge de C-1/C-4)
**Tests acumulados:** 1475 → 1584 (+109 propios del bloque)
**Deps npm nuevas:** cero
**ADR nueva:** 0024-crash-recovery.md

---

## Objetivo

Detectar crashes (force-quit, OS reboot, kernel panic, bug runtime, kill -9) y permitir al user recrear su topología de ventanas (cuántas + qué workspace + bounds) con una sola elección al boot. Segundo feature del Bloque E2-C (Quick wins productividad).

## Decisiones tomadas vía AskUserQuestion antes de codear

1. **Detección** — Lockfile + clean-shutdown flag (recomendado). Opciones rechazadas: solo crash reporter (no cubre force-quit ni OS reboot), ambos (overkill v1; crash reporter diferido a Etapa 3 telemetry).
2. **Granularidad** — Workspaces + tabs lazy (recomendado). Opciones rechazadas: + scroll/form drafts (privacy concern + RAM/disk overhead, diferido), + flushStorageData periódico (I/O constante).
3. **UX boot** — Native dialog "Restore previous session?" (recomendado). Opciones rechazadas: auto-restore silente (molesta si crasheaste con 50 tabs y querés empezar limpio), toast banner en sidebar (+UI surface, menos inmediato).

## Entregables

### `browser/crash-detector.js` (~165 LOC)

Lockfile lifecycle con PID liveness check.

- `init()` lee `userData/running.lock`. Clasifica: clean boot (no existe), crash (PID muerto / JSON corrupto / PID inválido), multi-instance (PID vivo distinto al actual). Escribe lockfile nuevo con `{pid, startedAt, ozVersion}` salvo si multi-instance (preserva el del sibling vivo).
- `markCleanShutdown()` borra el lockfile. Idempotente (ENOENT cuenta como ok).
- `wasCrashed()` / `isMultiInstance()` getters.
- Fail-safe: write fail → ERROR log + continúa (no crashea el browser por no poder detectar el próximo crash).
- Inyectables para tests: `procIsAlive(pid)`, `clock()`.

**Edge cases cubiertos:**

- PID equal al actual → stale fork (NOT crash, NOT multi-instance).
- PID inválido (NaN/0/negativo/string/null) → tratado como crash.
- JSON corrupto → tratado como crash.
- mkdir recursivo del userDataDir si no existe.

### `browser/window-snapshot.js` (~210 LOC)

Persiste topología de ventanas en `userData/windows.json`. Schema v1.

- `capture()` deriva `[{workspaceId, bounds, isMaximized, isFullScreen}]` desde `browser.windows`. Skipea zombies (`window.window.isDestroyed()`) y entries null/undefined.
- `read()` retorna payload o null (missing / corrupt JSON / wrong version / malformed).
- `flush()` capture + write con dedupe por JSON serializado excluyendo `capturedAt` (timestamp churn no triggerea writes).
- `startDaemon(intervalMs=2000)` polling cada 2s + `stopDaemon()`. Idempotentes.
- `clear()` borra el archivo (idempotente). Llamado después de "Start Fresh" para no re-restore en hipotético segundo crash inmediato.

**Por qué polling y no hooks:** los eventos relevantes (open, close, switch, move, resize, maximize, fullscreen) están dispersos en múltiples APIs. Hookear cada uno = invasivo + frágil ante cambios futuros. Polling cubre todo con cero acoplamiento. Trade-off: hasta 2s de pérdida si crashea entre ticks. Aceptable porque (a) tabSpecs ya persistidas en workspaces.json, (b) topología no cambia tan rápido como para justificar invasive hooking.

**Hooks complementarios** (sin override del polling):

- `app.before-quit`: `flush()` sync para garantizar último estado on-disk.
- `'closed'` listener de cada window (post-splice del HX2): `flush()` sync para captura inmediata sin esperar próximo tick.

### `browser/session-restore.js` (~205 LOC)

Native dialog + restore loop.

- `promptRestore(snapshot, {dialog?})` abre `dialog.showMessageBox` con buttons `['Restore', 'Start Fresh']`. defaultId=Restore, cancelId=Discard. Wording singular/plural según `windows.length`. Returns 'restore' | 'discard'. Defensive: returns 'discard' si no hay dialog disponible o si dialog throw.
- `restoreFromSnapshot(browser, snapshot)` itera entries → `browser.createWindow({workspaceId, window: bounds})`. Post-create aplica `maximize()` / `setFullScreen(true)` según el snapshot.
- **Lock 1-1 enforcement (ADR 0015):** dedupe defensivo por `workspaceId` dentro del loop.
- **Workspace gone fallback:** si el `workspaceId` ya no existe (borrado entre crash y restore), fallback al Default workspace.
- **Partial restore:** try/catch por entry, continúa con el resto si uno falla.
- **All-fail fallback:** si todos los entries fallaron, crea una window con Default workspace para garantizar que el browser arranca.

### `browser/crash-recovery-setup.js` (~85 LOC)

Glue extraído de main.js (mantener bajo 500 LOC per ADR 0005). `async function setupCrashRecovery(browser)` retorna `{restored: boolean}`. Side effects: `browser.crashDetector` + `browser.windowSnapshot` instanciados, prompt+restore ejecutado si aplicable.

### Wiring en `main.js`

- Imports + 2 fields nuevos en class Browser: `crashDetector`, `windowSnapshot`.
- En `init()` post-managers + post-extensions, antes de `createInitialWindow()`:
  ```js
  const { restored } = await setupCrashRecovery(this)
  if (!restored) this.createInitialWindow()
  this.windowSnapshot.startDaemon()
  ```
- En `before-quit` (LATE, después de todos los flushes existentes):
  ```js
  this.windowSnapshot.flush()
  this.windowSnapshot.stopDaemon()
  this.crashDetector.markCleanShutdown()
  ```
- En el `'closed'` listener post-HX2-splice: `this.windowSnapshot.flush()` para captura inmediata.
- `createWindow()` ahora hace merge de defaults con `options.window` (en lugar de hardcoded) — necesario para que session-restore pase bounds custom sin perder defaults de `frame/titleBar/webPreferences`.

## Tests

Total **109 tests propios del bloque** (1584/1584 verde end-to-end).

### `tests/crash-detector.smoketest.js` — 38 cases

- exports + constants
- clean boot (no lockfile previo)
- crash detection (PID muerto)
- multi-instance (PID vivo distinto al actual; lockfile preservado)
- corrupt JSON → crash
- invalid PID values (negative/zero/string/null) → crash
- markCleanShutdown idempotent
- wasCrashed / isMultiInstance getters
- init() idempotent
- constructor validation (throws sin userDataDir)
- userDataDir auto-created (mkdir recursive)
- prior PID equal current → stale (NOT crash)

### `tests/window-snapshot.smoketest.js` — 42 cases

- exports + constants
- constructor validation
- capture from browser.windows (workspaceId, bounds, isMaximized, isFullScreen)
- capture skipea zombies (isDestroyed=true)
- capture defensive contra null/undefined entries
- flush writes payload
- flush dedupes when state unchanged
- flush writes again after state change
- read missing file → null
- read corrupt JSON → null
- read wrong schema version → null
- read malformed windows field → null
- read returns parsed payload after write
- clear (removes file, idempotent)
- daemon lifecycle (start/stop idempotent)
- clear after daemon stop

### `tests/session-restore.smoketest.js` — 29 cases

- exports
- promptRestore → 'restore' on response 0
- promptRestore → 'discard' on response 1
- promptRestore → 'discard' on dialog throw
- promptRestore → 'discard' when dialog missing
- promptRestore copy singular/plural
- restoreFromSnapshot creates N windows
- restoreFromSnapshot dedupes lock 1-1
- restoreFromSnapshot fallback to Default for missing WS
- restoreFromSnapshot applies maximize/fullscreen post-create
- restoreFromSnapshot fallback when nothing created
- restoreFromSnapshot defensive (null browser/snapshot/non-array)
- restoreFromSnapshot survives createWindow throws (partial restore)

## Refactor incidental — ADR 0005

main.js creció a 526 LOC al inline-ar el wiring de crash recovery (límite 500). Extracción a `crash-recovery-setup.js` lo bajó a 471 LOC. Patrón consistente con extracciones previas (sidebar-ctx-menus.js, ipc-handlers-extra.js, identity-workspace-sync.js).

## Métricas

- Lint clean (ESLint + Prettier).
- check:loc max 495 (`tests/tab-context-handlers.smoketest.js`, sin cambios).
- 4 archivos browser/ nuevos: crash-detector.js (165 LOC), window-snapshot.js (210), session-restore.js (205), crash-recovery-setup.js (85). Total ~665 LOC nuevas en browser/.
- 3 tests/ nuevos: crash-detector.smoketest.js, window-snapshot.smoketest.js, session-restore.smoketest.js. Total ~700 LOC en tests/.
- Cero deps npm nuevas.

## Validación pendiente

Validación visual end-to-end vía Desktop Commander queda para próxima sesión:

1. `npm start` → verificar que no hay regresión en boot normal.
2. Force-quit del proceso (`kill -9` o force quit) mientras 2-3 windows con workspaces distintos están abiertos.
3. Re-launch → confirmar dialog "Restore previous session?" aparece.
4. Click "Restore" → verificar que las N windows se recrean con sus workspaceIds + bounds + tabs.
5. Repetir con click "Start Fresh" → verificar que arranca con una sola window Default.

## Próximo

E2-C-3 identity templates/clone (~2h) — duplicar identity preservando fingerprint + proxy + extensions. O C-5 notification panel (~2h), C-6 anti-detect health dashboard (~3h), C-7 extension per-identity validation (~3h). ~11h restantes en el Bloque E2-C.
