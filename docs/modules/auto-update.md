# auto-update.js

**Bloque:** Etapa 3d
**Source:** [`browser/auto-update.js`](../../browser/auto-update.js)
**Tests:** [`tests/auto-update.smoketest.js`](../../tests/auto-update.smoketest.js) (14/14)
**ADR:** [0021 — Auto-update strategy](../architecture/0021-auto-update-strategy.md)

## Qué hace

Wrappea `update-electron-app` para que OZ Browser se actualice solo desde un bucket Cloudflare R2 (sin tocar GitHub Releases — el repo es privado). Llamado una vez en `Browser.init()` post-managers. NO crashea el browser bajo ninguna circunstancia.

## Exports

```js
const { setupAutoUpdate } = require('./auto-update')

// En main.js, post-init:
setupAutoUpdate({ logger: log })
```

API completa:

| Param               | Type         | Default                                            | Description                                                                |
| ------------------- | ------------ | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `logger`            | object       | **required**                                       | OZ logger module. Debe exponer `info/warn/error/debug(src, msg, ...meta)`. |
| `app`               | Electron.App | `require('electron').app`                          | Inyectable para tests. Solo se lee `app.isPackaged`.                       |
| `env`               | object       | `process.env`                                      | Inyectable. Lee `OZ_UPDATE_BASE_URL` y `OZ_UPDATE_DISABLED`.               |
| `platform`          | string       | `process.platform`                                 | Inyectable. Solo `'darwin'` está soportado v1.                             |
| `updateElectronApp` | function     | `require('update-electron-app').updateElectronApp` | Inyectable para tests.                                                     |
| `updateInterval`    | string       | `'1 hour'`                                         | Human-readable interval del lib `ms`. Mín 5 min.                           |

Returns `{ configured: boolean, reason?: string }`. Reasons: `not-packaged`, `disabled-by-env`, `unsupported-platform`, `no-base-url`, `invalid-base-url`, `lib-error`.

## IPC channels

Ninguno. `update-electron-app` maneja todo internamente (background polling, download, dialog nativo del OS). No exponemos UI custom.

## Dependencias

- `update-electron-app@^3.2.0` — wrapper oficial Electron team encima de `electron-updater`.
- `browser/logger.js` — para forwardear los mensajes del updater al log file de OZ.

## Setup operacional (Cloudflare R2)

**Pendiente — Jose lo hace cuando llegue Etapa 3b/3c y vayamos a hacer el primer release.** Pasos:

1. **Crear cuenta Cloudflare** (free): https://dash.cloudflare.com/sign-up
2. **Activar R2** en el sidebar: Account Home → R2 → "Enable R2" (pide tarjeta pero no cobra hasta exceder free tier).
3. **Crear bucket:**
   - Name: `oz-browser-updates`
   - Location hint: `wnam` (Western North America) o el más cercano a la mayoría de users
4. **Crear API token:**
   - R2 → Manage R2 API Tokens → "Create API token"
   - Permissions: "Object Read & Write" (write para uploads de release; read para downloads)
   - Specify bucket: `oz-browser-updates` (least-privilege)
   - Copiar `Access Key ID`, `Secret Access Key`, `Endpoint URL` (formato `https://<account-id>.r2.cloudflarestorage.com`)
   - Guardar en `.env.local` (NO commitear): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET=oz-browser-updates`
5. **Habilitar acceso público al bucket:**
   - Bucket → Settings → "Public access" → enable
   - Custom domain (recomendado): `updates.ozbrowser.app` → Settings → Custom Domains → Add
   - O usar el default `pub-<hash>.r2.dev/oz-browser-updates` si no querés custom domain todavía
6. **Setear `OZ_UPDATE_BASE_URL` en el packaged build:**
   - Editar `forge.config.js` → `packagerConfig.extraMetadata`:
     ```js
     extraMetadata: {
       env: {
         OZ_UPDATE_BASE_URL: 'https://updates.ozbrowser.app/darwin/arm64',
       },
     }
     ```
   - O via env de signing (preferred — distintos channels podrían apuntar a distintas URLs).
   - **CRÍTICO:** la URL DEBE ser HTTPS. El módulo rechaza HTTP con ERROR.
7. **Estructura del bucket** (lo que `update-electron-app` polls):
   ```
   updates.ozbrowser.app/
     darwin/
       arm64/
         RELEASES.json   ← manifest con latest version + URL del .zip
         OZ-Browser-0.1.0-arm64.zip
         OZ-Browser-0.1.1-arm64.zip
       x64/
         RELEASES.json
         ...
   ```
   Esto lo arma `@electron-forge/publisher-s3` automáticamente en Etapa 3e (CI release workflow), o subida manual con `wrangler r2 object put` desde el CLI.

## Skip conditions

El módulo skipea en cualquiera de estos casos. **Nunca crashea**, siempre WARN/ERROR log con reason específico:

| Condición                    | Reason                 | Por qué                                                                                                |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `!app.isPackaged`            | `not-packaged`         | Estamos en `npm start`, dev mode. update-electron-app explícitamente refusa correr en unpackaged apps. |
| `OZ_UPDATE_DISABLED === '1'` | `disabled-by-env`      | Escape hatch para QA/debugging sin que el updater interfiera.                                          |
| `platform !== 'darwin'`      | `unsupported-platform` | Windows está en Etapa 8. Linux nunca planeado v1.                                                      |
| `OZ_UPDATE_BASE_URL` no set  | `no-base-url`          | Bucket no armado todavía. WARN incluye hint de R2 setup.                                               |
| `baseUrl` no es HTTPS        | `invalid-base-url`     | Security — el lib lo asserts también pero adelantamos check para ERROR loud.                           |
| `updateElectronApp()` throw  | `lib-error`            | Try/catch interno. Browser sigue funcionando.                                                          |

Order matters: `not-packaged` se checkea PRIMERO para no gastar cycles en el resto en dev mode.

## Runtime behavior (cuando todo funciona)

1. App boot → `setupAutoUpdate()` → `updateElectronApp()` arranca el polling.
2. **Inmediatamente** chequea el bucket por una RELEASES.json más nueva.
3. **Cada 1 hora** repite el check. Si encuentra update → download en background (transparent al user).
4. Cuando download está completo → **dialog nativo del OS** aparece: "OZ Browser update v1.2.3 ready · Restart now / Later".
5. User clickea "Restart now" → app graceful shutdown → install → re-open con la nueva version. Tabs/workspaces/vault preservados (todo en disk).
6. User clickea "Later" → no nag, próximo restart aplica el update silently.

**Bloqueado por:**

- Etapa 3b (firma) — sin Developer ID Application cert, Squirrel.Mac no acepta el binary descargado.
- Etapa 3c (notarización) — sin notary ticket stapled, macOS Catalina+ rechaza la app post-update.
- Bucket R2 con `RELEASES.json` válido — Etapa 3e o subida manual.

## Logging

Todos los mensajes del updater van como INFO al log de OZ:

```
[2026-05-10T12:00:00Z] INFO  [auto-update] configured {"baseUrl":"https://updates.ozbrowser.app/darwin/arm64","updateInterval":"1 hour","notifyUser":true}
[2026-05-10T12:00:01Z] INFO  [auto-update] Checking for update
[2026-05-10T12:00:02Z] INFO  [auto-update] Update not available
[2026-05-10T13:00:01Z] INFO  [auto-update] Checking for update
[2026-05-10T13:00:03Z] INFO  [auto-update] Update available
[2026-05-10T13:00:03Z] INFO  [auto-update] Downloading update from <URL>
[2026-05-10T13:00:15Z] INFO  [auto-update] Update downloaded; will install in 5 seconds
```

WARN/ERROR aparecen solo en skip cases o lib failures (raros).

## Tests

14 tests offline (sin Electron real, sin red). Mockean `app`, `env`, `platform`, y la `updateElectronApp` function. Cubren skip cases, happy path, logger adapter, y el integration check (real require de `update-electron-app` para validar peer deps).

```sh
node tests/auto-update.smoketest.js
```

## Gotchas

- **No probar en dev mode** — `npm start` no es packaged, así que el módulo skipea inmediatamente. Para validar runtime real, hay que hacer `npm run make` + abrir el .dmg en una Mac CON el binary firmado y notarizado, en una version más vieja que la latest del bucket.
- **HTTPS only** — http URLs son rechazadas con ERROR loud. El lib también lo assertea pero adelantamos para fail-fast.
- **No exposer la URL del bucket en código public** — debe estar en env, no committed. Pero el packaged binary SÍ la contendrá (eso es OK, es URL pública igualmente).
- **Mac users con app cerrada no chequean** — update-electron-app solo polls cuando OZ está abierto. Para forced critical updates (security patches), considerar push notification fuera de banda o newsletter.
