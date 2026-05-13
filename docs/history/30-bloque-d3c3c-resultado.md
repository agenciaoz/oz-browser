# Bloque D-3c-3c — Sync wire-up final (resultado)

**Status:** ✅ Cerrado 2026-05-13
**Commit:** TBD (a poner en main directo)
**Tiempo:** ~3h efectivas
**Deps nuevas:** ninguna
**Tests:** ~2236 → ~2319 (+83)
**Files added:** 6 source + 2 tests + 1 history + 1 CHANGELOG entry

## Origen

El sync engine quedó feature-complete en D-3a→D-4 mini b (`d2b947e` →
`befc354`), pero NADIE lo instanciaba en `main.js`. Sin wire-up, los managers
emitían `'changed'` al vacío y los devices no convergían. Este sub-chunk
cierra el flow real: instanciar setupSync con los managers reales del browser,
exponer un toggle en Settings, y hookear el ciclo de vida (boot resume, before-quit
stop, alert on NEEDS_REAUTH).

## Decisiones de scope (vía AskUserQuestion al inicio)

1. **Default ON/OFF al boot** → **Opt-in en Settings** (recomendada). Sync
   arranca solo cuando el usuario tocó el toggle. Coherente con D-1 cloud
   backup que también es opt-in (connect explícito). Evita sorpresas en otros
   devices del team al primer boot post-update.

2. **Cold-start "push-all" al primer enable** → **Sí** (recomendada). Recorre
   `identityManager.list()` + `workspaceManager.list()` + bookmarks y los
   enqueue como upsert. Sin esto, el use case real (Mac 1 ya tiene 30
   identities, querés verlas en Mac 2) no se cubre. Persistido en
   `settings.sync.firstEnableAt` (ISO string) para que enable→disable→enable
   NO duplique el sweep.

3. **UI scope** → **Mínima: toggle + status + Sync Now** (recomendada).
   Settings tiene toggle Enable/Disable + status pill (Running/Stopped/Needs
   reauth/Vault locked/Starting) + botón "Sync Now" que llama `pullNow()`.
   Alerts urgentes al panel cuando NEEDS_REAUTH. Panel dedicado con stats
   avanzadas (last-N-pushed records, lista de devices del team) queda
   diferido a C-XX post-launch.

## Módulos entregados

```
browser/
  sync-bootstrap.js          — orchestrator (init/setEnabled/getStatus/pullNow/stop)
  sync-bootstrap-setup.js    — glue para main.js (try/catch + log adapters)
  sync-handlers.js           — handler map IPC + MCP (shared)
  mcp-tools-sync.js          — 3 MCP tools oz.sync.{getStatus,setEnabled,pullNow}
  mcp-server-setup.js        — split del boot MCP del main.js (ADR 0005)
ipc-handlers.js              — +buildSyncHandlers en browser.handlers map
ipc-handlers-extra.js        — +registerSyncHandlersIPC + 3 channels oz:sync:*
mcp-tools.js                 — +import + spread buildSyncTools
preload.js                   — +window.oz.sync.{getStatus,setEnabled,pullNow,onChanged}
settings-manager.js          — +sync section v1 + validateKey accepts enabled
                               boolean + firstEnableAt ISO string|null
ui/settings.js               — +syncSpecial binding + refreshSyncStatus +
                               handleSyncEnabledChange + handleSyncNow +
                               onChanged subscription
ui/webui.html                — +nav "Sync" + section markup +
                               .oz-sync-pill CSS (5 estados de color)
main.js                      — setupSyncBootstrap post-bookmarkManager +
                               startSyncBootstrap post-registerIpcHandlers +
                               stopSyncBootstrap FIRST en before-quit
ui/manifest.json             — version bump 1.0.1 → 1.0.2 (regla operativa
                               feedback_webui_manifest_bump)
tests/
  _helpers-sync-bootstrap.js          — fakes compartidos (LOC budget)
  sync-bootstrap.smoketest.js         — 18 run blocks / 59 tests
  sync-bootstrap-handlers.smoketest.js — 3 run blocks / 12 tests
docs/
  history/30-bloque-d3c3c-resultado.md
CHANGELOG.md                 — entry del bloque
```

## API pública del orchestrator

```js
const sync = createSyncBootstrap(browser, { setupSync? /* test inj */, now?, userDataDir? })

await sync.init()
  // → { ok: true, running: false }  si settings.sync.enabled = false
  // → { ok: false, reason: 'NEEDS_DROPBOX_APP' }    si dropboxClient = null
  // → { ok: false, reason: 'NEEDS_REAUTH' }         si dropboxClient.isAuthenticated() = false
  // → { ok: true, running: true }                   si resume OK

sync.setEnabled(true)
  // First-ever enable → cold-start enqueues all identities/workspaces/bookmarks
  // → { ok: true, enabled: true, coldStart: true, counts: {identities:N, workspaces:M, bookmarks:0|1} }
  // Resume after previous disable → no cold-start
  // → { ok: true, enabled: true, coldStart: false }

sync.setEnabled(false)
  // Stops engine + pull poll. Queue + sync-state.json preserved on disk.

await sync.pullNow()
  // → { ok: true, result: {identity, workspace, bookmark} }
  // → { ok: false, reason: 'NOT_RUNNING' | 'PULL_FAILED' | 'NEEDS_REAUTH' }

sync.getStatus()
  // {
  //   configured, dropboxConnected, enabled, running, queueDepth,
  //   vaultUnlocked, needsReauth, firstEnableAt,
  //   lastPullAt, lastPushAt, lastError
  // }

sync.stop()
  // Idempotent. Safe to call before _buildSync ran.
```

## Lifecycle en main.js

```
init()
  ...
  bookmarkManager = new BookmarkManager()
  syncBootstrapSetup.setupSyncBootstrap(this)    ← creates browser.syncBootstrap
  ...
  proxyManager / proxyHealth / etc
  registerIpcHandlers(this)                       ← handlers.sync builds against syncBootstrap
  setupMenu(this)
  syncBootstrapSetup.startSyncBootstrap(this)    ← calls init() — resume or no-op

before-quit:
  syncBootstrapSetup.stopSyncBootstrap(this)    ← FIRST flush (engine.stop + pull poll cancel)
  workspaceManager.flush()
  ...
  accountVault.lock()                            ← vault lock AFTER sync stop avoids race
```

**Por qué stop ANTES de los otros flushes**: la queue ya persiste per-enqueue
(sync-queue.save() en cada op), así que no se pierde estado. Lo que sí evita
es race entre el setInterval del pull poll (que llama vault.getMasterKey
durante decode) y vault.lock() que wipea la masterKey. Sin esto los logs se
llenan de "getMasterKey on locked vault" warnings durante teardown.

## Reuso del dropbox-client de D-1

`browser.dropboxClient` se crea en `setupCloudBackup` (D-1) con el `clientId`
de `OZ_DROPBOX_APP_KEY`. Mismo `oauth-helper` provider `'dropbox'`, mismo
Keychain key, mismo OAuth callback `oz://auth/dropbox/callback`.

Sync NO duplica nada: pasa `browser.dropboxClient` a `setupSync` y comparte
la sesión OAuth. Si el user reconecta Dropbox desde Cloud Backup, sync hereda
los nuevos tokens automáticamente (los `_loadTokens()` del SDK re-leen del
Keychain).

## Cold-start logic

Cuando `setEnabled(true)` se llama por primera vez, antes de `sync.start()`:

```js
for (const ident of browser.identityManager.list()) {
  sync.queue.enqueue({
    op: 'upsert',
    recordType: 'identity',
    recordId: ident.id,
    updatedAt: ident.updatedAt || now(),
  })
}
// Same for workspaceManager (if present) and bookmarkManager.getSyncRecord()
// (if non-empty array of bookmarks)
```

Se persiste `settings.sync.firstEnableAt = now()`. En enables subsiguientes
(post-disable), `firstEnableAt` ya está set y el cold-start NO corre.

## Settings UI

Nueva sección "Sync" en el Settings modal (entre Notifications y About).
Markup:

```
[Toggle]  Enable cross-device sync
          First enable runs an initial push of all your identities, workspaces,
          and bookmarks to Dropbox so the other device can pull them down.

[Status]  ●Running           ← pill verde/gris/amarillo/rojo
          Running. 3 changes pending push.

[Button]  Sync now           ← invoca oz.sync.pullNow() (disabled if !running)

Last activity: Last pull: 2m ago · Last push: 5m ago
```

Las 5 estados del pill mapean a:

| Condición                | Pill class           | Color    | Label                 |
| ------------------------ | -------------------- | -------- | --------------------- |
| !configured              | oz-sync-pill-warning | amarillo | Not configured        |
| !dropboxConnected        | oz-sync-pill-warning | amarillo | Dropbox not connected |
| needsReauth              | oz-sync-pill-error   | rojo     | Needs re-auth         |
| enabled + !vaultUnlocked | oz-sync-pill-warning | amarillo | Vault locked          |
| running                  | oz-sync-pill-running | verde    | Running               |
| enabled + !running       | oz-sync-pill-warning | amarillo | Starting…             |
| otherwise                | oz-sync-pill-stopped | gris     | Stopped               |

El toggle NO va por el save genérico de settings — usa `oz.sync.setEnabled`
(server-side state: cold-start + engine start). Si setEnabled retorna
`{ok:false, reason:NEEDS_DROPBOX_APP|NEEDS_REAUTH|...}`, el toggle se
revierte a !enabled y se muestra error friendly.

Modal subscribe a `oz.sync.onChanged` — engine push events refresh el pill
sin re-abrir el modal.

## Tests

**sync-bootstrap.smoketest.js** (59 tests):

- Constructor validation (browser, settingsManager, identityManager, accountVault required)
- init() — disabled in settings → ok:true running:false (no build)
- init() — enabled but no Dropbox app → ok:false NEEDS_DROPBOX_APP
- init() — enabled but Dropbox not authed → ok:false NEEDS_REAUTH (needsReauth flag set)
- init() — enabled + authed → builds + starts (resume, no cold-start, setupSync called once)
- setEnabled(true) first time → cold-start enqueues all + firstEnableAt set + queue size = N
- setEnabled(true) again after disable → no re-cold-start (queue empty)
- setEnabled(false) → stops + persists + sync.isRunning()=false
- setEnabled — Dropbox not configured / not authenticated cleanly
- getStatus shape + all keys + dynamic values
- pullNow — NOT_RUNNING when no build, success when running (lastPullAt set)
- engine 'pushed' updates lastPushAt + broadcasts oz:sync:changed
- engine 'push-failed' NEEDS_REAUTH sets needsReauth flag + alert urgent
- puller 'remote-apply' updates lastPullAt
- stop() idempotent + safe before \_buildSync
- Cold-start with empty bookmarks doesn't enqueue bookmark op

**sync-bootstrap-handlers.smoketest.js** (12 tests):

- Handler map setEnabled rejects non-boolean (BAD_ARG)
- Handler map NOT_CONFIGURED when bootstrap absent
- settings-manager validateKey accepts sync.enabled boolean + firstEnableAt ISO string
- settings-manager rejects sync.enabled non-boolean + firstEnableAt non-string

Total **71 tests propios** + asume +12 contract tests del mcp-server (los
3 tools nuevos suben el contract count). **Tests del repo: ~2236 → ~2319**.

## LOC budget (ADR 0005)

Durante development cruzamos el límite varias veces:

- `browser/main.js` cruzó 500 con mi wire-up → extraído boot MCP a
  `mcp-server-setup.js` + compactación del setEnabled check → final 495.
- `tests/sync-bootstrap.smoketest.js` cruzó 500 con todos los tests + fakes
  inline → fakes extraídos a `tests/_helpers-sync-bootstrap.js` shared
  helper + handlers tests movidos a sibling file → ambos files < 500.

## Diferido (followup)

- **D-3c-3d**: long-poll real via `dropboxClient.filesListFolderLongpoll`
  para reducir el lag remote→local de 30s a <10s. El setInterval default
  del sync-setup.js queda funcional pero subóptimo. ~2-3h.
- **Tombstone GC sweep**: 30d retention según ADR 0026 §9. Cada N días,
  borrar tombstones más viejos que threshold. ~1h.
- **Panel dedicado**: modal "Sync" con stats avanzadas — last 10 pushed
  records, list de devices del team (cross-reference con cloud-backup
  listDevices), queue depth chart. Útil para debug + diferenciador. ~3h.
- **Vault EventEmitter para resume auto on unlock**: hoy si el user
  unlockea vault con sync enabled, el engine resume al próximo tick del
  pull poll (≤30s) o al próximo emit de 'changed'. Si el vault emitiera
  `'unlocked'`, el bootstrap podría refrescar status + emitir broadcast
  para que la UI lo refleje inmediato. ~1h.

## Validación visual end-to-end pendiente

Pendiente para Jose con su Mac real:

1. `OZ_DROPBOX_APP_KEY=<key> npm start` (o el .app empaquetado con la key
   bakeada al build).
2. Cloud Backup → Connect Dropbox → OAuth flow completa.
3. Settings → Sync → toggle Enable. Verificar:
   - Logs `cold-start enqueued {identities: N, workspaces: M, bookmarks: 0|1}`.
   - Pill cambia a "Running" verde.
   - Queue depth decrease en tiempo real (cada upload sale).
4. Repetir en otra Mac con el mismo Dropbox conectado:
   - Settings → Sync → toggle Enable.
   - Verificar que las identities + workspaces de la Mac 1 aparecen vía
     pull en <60s (engine pull poll cada 30s).
5. Edit una identity en Mac 1 → confirmar que la edición aparece en Mac 2
   en <60s.

## Conclusión

D-3c-3c cierra el chunk pendiente del Bloque D Dropbox Sync. Toda la
infrastructure de sync construida en D-3a → D-4 mini b ya está operativa
en runtime real, con UI mínima funcional. Falta sólo la validación visual
end-to-end que requiere `npm start` + Dropbox conectado en una Mac real.

Próximos pasos lógicos: D-3c-3d (long-poll, lag↓), tombstone GC, panel
dedicado con stats. O saltar al Bloque F Automation (~4h) ahora que el
sync está cerrado.
