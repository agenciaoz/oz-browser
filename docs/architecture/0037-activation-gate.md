# ADR 0037 — Activation gate (pre-SaaS test builds)

**Date:** 2026-06-18
**Status:** Accepted
**Contexto:** Jose quiere repartir una build de prueba al equipo con activación online y un panel para manejar accesos + ver uso. Es el puente "v2.5 / pre-SaaS".

## Decisión

Gate de activación que bloquea el boot hasta que el install esté activado contra un servidor propio.

### Backend — Cloudflare Worker + D1 (`activation-server/`)

- D1 `oz-admin`: `licenses` (key/email/name/status/plan/created/expires), `activations` (key+machine_id, app_version, first/last seen), `events` (telemetría de uso).
- Worker `oz-activate` (`https://oz-activate.joserodrigo-413.workers.dev`): `/activate`, `/validate`, `/event`, y `/admin/*` (Bearer `ADMIN_TOKEN`) + dashboard HTML en `/`. Secrets: `ADMIN_TOKEN`, `HMAC_SECRET`. Deploy: `cd activation-server && npx wrangler deploy`.
- Datos manejables vía MCP de Cloudflare (D1 query) o el dashboard.

### App — `license-manager.js` + gate en `main.js init()`

- `init()` arranca con `if (await licenseManager.gate()) return`: si no activado, abre **solo** la ventana de activación y no bootea el resto. Al activar OK → `app.relaunch()`.
- **Re-validación online cada launch** (`/validate`) + **gracia offline** (default 7 días) atada al `machineId` (hash de hostname+platform+arch+uuid persistido). Revocar/expirar del lado server bloquea en el próximo chequeo online.
- Store local firmado-por-server (token opaco) en `userData/oz-license.json`.
- Telemetría: evento `app-open` en cada validación; hooks por-feature (bulk/scrape) en slice siguiente.

### Decisiones de robustez (no brickear)

- Bypass dev: `OZ_LICENSE_DISABLED=1`. Override server: `OZ_LICENSE_SERVER`.
- `ensureActivated` y `gate` nunca lanzan; si abrir la ventana falla → **fail-open** (bootea) en vez de dejar la app inusable.
- Cerrar la ventana de activación = `app.quit()` (evita bypass por el handler 'activate' del dock).

### Seguridad (alcance test)

Modelo de amenaza = evitar reparto casual + permitir revocar, NO anti-tamper fuerte. Un usuario offline determinado puede falsificar el store local; aceptable para un test interno. El HMAC del token + re-validación online hacen que la falsificación falle en el próximo chequeo online. Para SaaS real: cuentas+login, device cap estricto, y posiblemente verificación asimétrica.

## Alternativas

- Supabase (ya dependencia) — descartado para esto: el Worker+D1 es más liviano y el dashboard se sirve del mismo Worker.
- Gatear solo features v3 — descartado: Jose quiere test controlado de toda la app.

## Tests / verificación

Backend probado por curl (create/activate/invalid/admin-auth). El gate de la app requiere smoke real con la build (parte del "build de prueba"). `license-manager` es Electron-bound (sin unit test puro).
