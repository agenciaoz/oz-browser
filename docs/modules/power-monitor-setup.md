# Módulo `power-monitor-setup`

**Path:** `browser/power-monitor-setup.js`
**Líneas:** ~150
**Bloque/Etapa:** K1-extras (v1.4.2)

## Qué hace

Listens Electron `powerMonitor.on('resume')` — cuando la Mac wake from sleep — y triggers `proxyHealth.testAll()` para re-validar todos los proxies. Durante sleep, network state puede cambiar (WiFi/wired switch, VPN dropped, provider rotates exit IPs). Sin esto, el primer tab post-wake puede usar silently un proxy muerto.

## API

```js
const teardown = setupPowerMonitor({
  proxyHealth, // required — .testAll() method
  powerMonitor, // required — Electron's powerMonitor (or fake for tests)
  settingsManager, // optional — .get('notifications') checked for opt-out
  debounceMs, // optional — default DEFAULT_DEBOUNCE_MS = 3000
})
// → { stop, _trigger }

teardown.stop() // idempotent — removes listener + cancels pending timer
teardown._trigger('reason') // testing — fires testAll directly skipping debounce
```

Defensive: si no hay proxyHealth o powerMonitor, returns `{stop: ()=>{}}` (noop). Loguea warning pero no throws.

## Settings opt-out

```json
{
  "notifications": {
    "macSleepProxyRescan": false
  }
}
```

Default true. Toggle takes effect en runtime (el listener consulta settings en cada trigger, no en setup time).

## Debounce

`debounceMs=3000` por default. Listener clear+rescheduling — 3 rapid resume events (lid open/close cycle) coalescen a UNA `testAll()` call. 3s wait también deja que el network reconnect después del wake.

## One-call wire-up helpers

Para main.js compact:

```js
const {
  wirePowerMonitorOntoBrowser,
  teardownPowerMonitorFromBrowser,
} = require('./power-monitor-setup')

// setup (after proxyHealth.startDaemon):
wirePowerMonitorOntoBrowser(this)
// → resuelve electron.powerMonitor + browser.proxyHealth + browser.settingsManager
//   → calls setupPowerMonitor → attaches teardown a browser._powerMonitorTeardown

// teardown (in before-quit handler):
teardownPowerMonitorFromBrowser(this)
// → reads browser._powerMonitorTeardown.stop() + nulls
```

## Constants exposed

- `DEFAULT_DEBOUNCE_MS = 3000`
- `SETTING_KEY = 'macSleepProxyRescan'`

## Tests

`tests/power-monitor-setup.smoketest.js` — **11 asserts**:

- Defensive guards (2): no proxyHealth → noop, no powerMonitor → noop.
- Exports (2): SETTING_KEY + DEFAULT_DEBOUNCE_MS.
- Listener registration (2): on(resume) registered, stop() removes.
- \_trigger fires testAll (1).
- Settings opt-out (2): false → skip; null → defaults true.
- Debounce (1): 3 rapid emits → 1 testAll.
- Error handling (1): testAll throws → caught, `{ok:false, error}`.

Inyecta fakes — NO Electron real.

## Gotchas

- `powerMonitor` solo es accesible **DESPUÉS** de `app.ready`. Wire-up debe correr post-app-ready, no en module load top-level. Por eso main.js lo wirea en el ready-flow, no en require.
- `removeListener` vs `off`: Electron's powerMonitor inherits EventEmitter, both should work. El módulo checkea ambos (`removeListener` first, `off` fallback).
- Test puro: usa `makeFakePowerMonitor()` con map de listeners + emit() method — el módulo no hardcodea Electron, todo inyectable.

## Consumers

- `browser/main.js` — wire-up via helpers, único callsite.
