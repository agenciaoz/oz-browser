# ADR 0024 — Crash recovery (E2-C-2)

**Date:** 2026-05-10
**Status:** Accepted (implemented + tests verde, validación visual pendiente)
**Bloque:** E2-C-2 — Crash recovery con state restore
**Predecesor:** ADR 0015 (workspace model: 1-1 lock + tabSpecs)

## Context

OZ corre como app de productividad de uso intensivo: el user típico tiene varias windows abiertas, cada una con un workspace distinto + N tabs por identity (use case real Jose: 30 cuentas IG abiertas en bulk). Si OZ crashea (kernel panic, OOM, force-quit, power loss, bug runtime), el user pierde la topología de ventanas + tabs.

ADR 0015 ya cubre el contenido — `workspaces.json` persiste tabSpecs por workspace. Pero NO cubre la topología: cuántas ventanas estaban abiertas, qué workspace tenía cada una, dónde estaban posicionadas. Sin esa info, al re-bootear OZ después de un crash el user obtiene una sola ventana con el Default workspace y tiene que reabrir todo manualmente.

## Decision

Tres componentes desacoplados, todos pure JS sin deps nuevas, glue minimal en `main.js`:

### 1. Lockfile + clean-shutdown flag (`browser/crash-detector.js`)

Crea `userData/running.lock` con `{pid, startedAt, ozVersion}` al boot. Borra el archivo en `app.before-quit` LATE (después de todos los flushes, justo antes de `app.quit()`). Si al próximo boot el lockfile existe + el PID está muerto (chequeo via `process.kill(pid, 0)` que throw ESRCH), inferimos crash.

**Edge cases cubiertos:**

- **PID vivo + distinto al actual** → multi-instance, NO crash, NO sobrescribir el lockfile (la instancia hermana lo posee).
- **PID igual al actual** → stale del fork del propio proceso, NO crash.
- **JSON corrupto** → tratamos como crash (algo terminó mal).
- **PID inválido (NaN, 0, negativo, string)** → crash.
- **Lockfile en directorio que no existe** → mkdir recursive, escribir.
- **Write falla (FS read-only, disco lleno)** → ERROR log, browser continúa (perdemos detección del próximo crash, no crasheamos por eso).

**Por qué lockfile y no solo `crashReporter` de Electron:** crashReporter detecta crashes del renderer process y/o nativo del .app, pero NO cubre force-quit del usuario, OS reboot, kernel panic, ni `kill -9`. Lockfile + PID liveness los cubre todos: si el proceso no llegó a `markCleanShutdown()`, hay crash sin importar la causa. Trade-off: zero coverage de telemetría de qué causó el crash — diferimos eso a Etapa 3 (`crashReporter` agregado como complemento, no reemplazo).

### 2. Window topology snapshot (`browser/window-snapshot.js`)

Persiste `userData/windows.json`:

```json
{
  "version": 1,
  "capturedAt": "2026-05-10T23:45:12Z",
  "windows": [
    {
      "workspaceId": "general",
      "bounds": { "x": 100, "y": 200, "width": 1280, "height": 720 },
      "isMaximized": false,
      "isFullScreen": false
    }
  ]
}
```

**Daemon polling cada 2s** (default, override via `intervalMs`). Llama `capture()` + escribe a disco SOLO si cambió (dedupe por JSON serializado excluyendo `capturedAt`). Plus hooks explícitos:

- `flush()` sincrónico en `app.before-quit` (último write antes de markCleanShutdown).
- `flush()` sincrónico en el `'closed'` listener de cada window (post-splice del HX2): captura inmediata cuando el user cierra una window (sin esperar al próximo tick del daemon).

**Por qué polling y no hooks puros:** los eventos relevantes (open window, close window, switch workspace, move/resize, maximize, fullscreen) están dispersos en múltiples APIs (Electron `BrowserWindow`, `TabbedBrowserWindow.switchToWorkspace`, etc). Hookear cada uno es invasivo + frágil ante futuros cambios. Polling cubre todo automáticamente con cero acoplamiento. Trade-off: hasta 2s de pérdida si crashea entre ticks. Aceptable porque (a) `tabSpecs` ya están persistidas a `workspaces.json` con su propio throttle, (b) la topología no cambia tan rápido como para justificar el invasive hooking.

**Capture skipea zombies** (window.window.isDestroyed()) — el HX2 splice tiene un tick de delay, y queremos capturar SOLO ventanas vivas.

### 3. Restore prompt + loop (`browser/session-restore.js`)

Native dialog en boot via `dialog.showMessageBox` con buttons `['Restore', 'Start Fresh']`. UX inspirada en Chrome/Firefox — familiar para usuarios. defaultId=Restore, cancelId=Start Fresh. Wording singular/plural según `windows.length`.

Restore loop: por cada entry, `browser.createWindow({workspaceId, window: {x,y,width,height}})`. Post-create aplica `window.maximize()` y/o `window.setFullScreen(true)` según el snapshot.

**Lock 1-1 enforcement (ADR 0015):** dedupe defensivo por `workspaceId` dentro del loop. Si el snapshot tiene el mismo workspace dos veces (no debería, pero edge case posible si el snapshot se escribió durante un swap), skipeamos el segundo.

**Workspace gone** (borrado entre crash y restore): fallback al Default workspace + WARN log.

**createWindow throw**: try/catch por entry, partial restore beats no restore. Si TODOS los entries fallaron, fallback final: `browser.createWindow({workspaceId: defaultWorkspaceId})` para garantizar que el browser arranca con al menos una window.

### Wiring en `main.js`

Extraído a `browser/crash-recovery-setup.js` (mantener main.js bajo 500 LOC per ADR 0005). Flow:

```
init() {
  // ... managers ...
  const { restored } = await setupCrashRecovery(this)  // crashDetector + windowSnapshot + prompt+restore
  if (!restored) this.createInitialWindow()
  this.windowSnapshot.startDaemon()                    // post-windows para no churn empty snapshots
  // ... rest ...
}

before-quit {
  // ... flushes ...
  this.windowSnapshot.flush()
  this.windowSnapshot.stopDaemon()
  this.crashDetector.markCleanShutdown()  // LAST so any crash entre flush y markCleanShutdown queda detectado
  app.quit()
}
```

`createWindow()` ahora hace merge de defaults con `options.window` (en lugar de hardcoded) — necesario para que session-restore pase bounds custom sin perder los `frame/titleBar/webPreferences` defaults.

## Alternativas consideradas

**Auto-restore silente (sin prompt)** — UX más rápida pero molesta si el user crasheó con 50 tabs y quiere empezar limpio. Decisión por user (Jose) via AskUserQuestion: dialog explícito.

**Toast banner no-bloqueante en sidebar** — sutil pero +UI surface. Decisión: dialog nativo es más inmediato + zero-LOC en webui.

**Granularidad: scroll position + form drafts per tab** — más útil pero invasivo (privacy concern: capturás drafts del usuario en cada tick), +RAM, +disk. Decisión: workspaces+tabs lazy es suficiente para v1 (igual que el approach de Chrome/Firefox session restore basic). Scroll/form drafts diferidos a un C-XX post-launch si la demanda aparece.

**Crash reporter de Electron como única señal** — no detecta force-quit, OS reboot, kernel panic. Lockfile cubre todo.

**Flush windowSnapshot en cada switchToWorkspace** — más fresco pero acopla `window-workspace.js` con el snapshot. El polling daemon de 2s lo cubre con cero acoplamiento.

**Single-instance lock global** — impide multi-instance pero contradice el approach actual donde packaged builds tienen single-instance via `protocol-handler.js` y dev permite multiple. Lockfile multi-instance-aware preserva ambos paths.

## Consequences

**Positive:**

- Zero pérdida de topología en el caso común (graceful quit).
- Pérdida bounded a `intervalMs` (2s default) en el caso de crash sin tiempo para flush.
- Native UX familiar (Chrome/Firefox-style prompt).
- Cero deps nuevas, cero costo, cero infra externa.
- Componentes desacoplados — testeable en aislamiento (109 tests nuevos pasan offline sin Electron).

**Negative / trade-offs:**

- Restore NO incluye scroll position ni form drafts (diferido).
- `multi-instance` detection es heurística — un PID reciclado por el OS post-crash + within-millisecond podría falsos-positiveizar como "alive". En la práctica improbabilísimo (Linux/macOS no reciclan PID en el rango bajo de 1ms).
- El snapshot daemon corre cada 2s incluso cuando nada cambió — overhead negligible (1 capture + JSON.stringify de N windows + dedupe check).

## Test coverage

- `tests/crash-detector.smoketest.js` — 38 cases: clean boot, crash detection (PID dead), multi-instance (PID alive), corrupt JSON, invalid PID, markCleanShutdown idempotent, init idempotent, mkdir recursive, same-PID stale.
- `tests/window-snapshot.smoketest.js` — 42 cases: capture from windows, skip zombies, defensive nulls, flush dedupe, flush write on change, read missing/corrupt/wrong-version/malformed, clear idempotent, daemon lifecycle.
- `tests/session-restore.smoketest.js` — 29 cases: prompt restore/discard, dialog crash/missing, singular/plural copy, restore N windows, dedupe lock 1-1, fallback to Default for missing WS, apply maximize/fullscreen, fallback createWindow on all-fail, defensive args, partial restore on createWindow throw.

Total: **109 tests propios del bloque** (sumados a los 1475 existentes = 1584 verde end-to-end).
