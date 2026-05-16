# Bloque K1 (mac-sleep) — powerMonitor re-test proxies on Mac wake from sleep

**Status:** ✅ K1 Mac sleep cerrado 2026-05-15
**Commit:** `ef2e330`
**Version:** 1.4.2 (patch)
**Tiempo efectivo:** ~1.5h
**Deps nuevas:** ninguna (Electron's `powerMonitor` ya viene built-in)
**Tests nuevos:** +11 (power-monitor-setup.smoketest.js)

## Origen

Durante sleep, network state cambia: WiFi switch a wired, VPN dropped, ISP rotates DHCP lease, provider rotates exit IPs. Sin re-test post-wake, el primer tab que abrís puede silently usar un proxy muerto y vés "page not loading" sin contexto. Anti-logout no detecta esto porque es proxy reachability, no cookie expiry.

Per roadmap K1-extras: "Mac sleep/wake proxy re-scan".

## Decisión: listener + debounce, settings opt-out

Considerado:

1. **Stop daemon during sleep, restart on resume**: complicado, daemon ya tiene su propio `setInterval` lifecycle, mezclar con powerMonitor add boilerplate.
2. **Just call testAll on resume**: ELEGIDO. Simple, leverage existing primitives, debounce coalesces lid open/close cycles.
3. **Probe nuevas reachability metrics**: overkill. testAll() ya existe y hace exactamente lo necesario.

## v1.4.2 — implementación

### `browser/power-monitor-setup.js` (NEW, ~150 LOC)

**Factory `setupPowerMonitor({proxyHealth, powerMonitor, settingsManager, debounceMs})`:**

Validates deps (no proxyHealth → noop, no powerMonitor → noop, log warn). Registers `powerMonitor.on('resume', onResume)`. `onResume` clears any pending timer + schedules `setTimeout(_trigger, debounceMs)`.

**`_trigger(reason)` flow:**

1. Check settings: `settingsManager.get('notifications').macSleepProxyRescan === false` → skip (`{skipped:true, reason:'disabled'}`).
2. `await proxyHealth.testAll()`.
3. Return `{ok:true, result}` or `{ok:false, error}` (catched — never throws from event handler).

**`stop()`**: cancel pending timer + `powerMonitor.removeListener('resume', onResume)`. Idempotent.

**Constants exposed:**

- `DEFAULT_DEBOUNCE_MS = 3000` (let network reconnect after wake before testing)
- `SETTING_KEY = 'macSleepProxyRescan'` (under `settings.notifications.*`, default true)

### Helpers para mantener main.js bajo 500 LOC

Inicialmente hardcodee el wire-up + teardown en `main.js`. Eso me pasó de 498→517 LOC, violando ADR 0005. Solución:

```js
// power-monitor-setup.js
function wirePowerMonitorOntoBrowser(browser) {
  try {
    const { powerMonitor } = require('electron')
    const teardown = setupPowerMonitor({
      proxyHealth: browser.proxyHealth,
      powerMonitor,
      settingsManager: browser.settingsManager,
    })
    browser._powerMonitorTeardown = teardown
    return teardown
  } catch (err) {
    log.warn('power-monitor-setup', 'wire-up failed', { message: err && err.message })
    return { stop: () => {} }
  }
}

function teardownPowerMonitorFromBrowser(browser) {
  const t = browser && browser._powerMonitorTeardown
  if (t && typeof t.stop === 'function') {
    try {
      t.stop()
    } catch (err) {
      /* log */
    }
    browser._powerMonitorTeardown = null
  }
}
```

`main.js` queda con solo 2 líneas:

```js
// after proxyHealth.startDaemon():
require('./power-monitor-setup').wirePowerMonitorOntoBrowser(this)

// in before-quit:
require('./power-monitor-setup').teardownPowerMonitorFromBrowser(this)
```

main.js final: 500 LOC exactos.

## Tests

`tests/power-monitor-setup.smoketest.js` (~190 LOC, **11 asserts**):

- **Defensive guards** (2): no proxyHealth → noop stop(), no powerMonitor → noop stop().
- **Exports** (2): SETTING_KEY = 'macSleepProxyRescan', DEFAULT_DEBOUNCE_MS = 3000.
- **Listener registration** (2): powerMonitor.on(resume) registered, stop() removes listener.
- **\_trigger fires testAll** (1): happy path → testAll called once + result.ok=true.
- **Settings opt-out** (2): `macSleepProxyRescan:false` → skip + testAll NOT called; `null` settings → defaults true → testAll fires.
- **Debounce** (1): 3 rapid resume events within window → testAll called only ONCE (coalesced).
- **Error handling** (1): testAll throws → result.ok=false + error captured, NO rethrow.

Fakes inyectados — NO Electron real.

## Settings UX

Default true (no UI necesario para activarlo — funciona out-of-the-box).

User puede opt-out via `~/Library/Application Support/OZ Browser/settings.json`:

```json
{
  "notifications": {
    "macSleepProxyRescan": false
  }
}
```

Toggle en runtime (no requiere reboot — el listener consulta el setting en cada `_trigger`).

## Version bumps

- `package.json` 1.4.1 → 1.4.2 (patch)
- `browser/ui/manifest.json` 1.4.1 → 1.4.2

Lint clean. `check:loc` max 500 (main.js exactly 500).

## Pendiente

Smoke visual REAL pendiente — para validar Mac sleep manually:

1. Lanzar OZ Browser, abrir DevTools Console
2. Cerrar lid 30 segundos
3. Abrir lid, esperar 3-4s
4. En logs `browser/ui` debería aparecer:
   ```
   power-monitor-setup: installed resume listener {debounceMs: 3000}
   power-monitor-setup: resume — re-testing all proxies {reason: 'resume'}
   power-monitor-setup: resume re-test done {result: {...}}
   ```

Alternative: usar `pmset sleepnow` desde terminal y luego activar Mac.

## Próximos K1-extras restantes

- `1.4.3` Identity HUD widget arriba-derecha en cada tab (~3h)
- `1.4.4` Onboarding wizard 5-step (~3h)

Después K1 completo → `1.5.0` i18n full → `1.6.0` Apple signing.
