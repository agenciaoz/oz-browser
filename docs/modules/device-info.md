# `browser/device-info.js`

**Bloque:** D-1.1
**ADR:** [0025 Cloud backup architecture](../architecture/0025-cloud-backup.md)
**Tests:** `tests/device-info.smoketest.js` (49 cases)

## Qué hace

Identifica unívocamente esta instalación de OZ Browser. Persistido en `userData/device-info.json`. Idempotente — primera llamada a `ensureDeviceInfo()` genera + escribe; sucesivas leen del disco. shortId estable cross-boot.

## API

```js
const { createDeviceInfo } = require('./device-info')
const di = createDeviceInfo({ userDataDir: app.getPath('userData') })
di.ensureDeviceInfo() // sync, idempotente
di.getDeviceInfo() // sync, cached
di.getDeviceFolder() // string: `${hostnameSlug}-${shortId}`
di.reload() // invalida cache + relee
```

## Schema persistido

```json
{
  "uuid": "a1b2c3d4-...",
  "shortId": "a1b2c3d4",
  "hostname": "Jose's MacBook Pro",
  "hostnameSlug": "joses-macbook-pro",
  "deviceFolder": "joses-macbook-pro-a1b2c3d4",
  "createdAt": "2026-05-10T...",
  "schemaVersion": 1
}
```

## Decisiones clave

- **UUID + hostname** (no MAC address, no hostname solo). Detalle en ADR 0025.
- **Apóstrofes y comillas droppados** antes del replace de no-alnum → "Jose's" → "joses" (no "jose-s").
- **Max slug length: 32 chars** (paths Dropbox legibles).
- **Empty hostname fallback** → "device".
- **JSON corrupto / schema inválido** → log WARN + regenera.

## Test injection

`injectHostname(fn)` para tests determinísticos. Llamar con `null` o `undefined` restaura `os.hostname()` real.
