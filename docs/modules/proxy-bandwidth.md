# Module: Proxy Bandwidth Meter (proxy-bandwidth.js)

**Files:**

- `browser/proxy-bandwidth.js` — estimateBytesFromHeaders + BandwidthAccumulator (puro) + attachBandwidthMeter (Electron)
- `browser/proxy-manager.js` — `addBandwidth(id, bytes, {persist})`
- `browser/proxy-boot-setup.js` — wiring (acumulador global + flush 30s + attach por sesión)
- `tests/proxy-bandwidth.smoketest.js` — 24 assertions

**ADR:** [`0044-bandwidth-meter.md`](../architecture/0044-bandwidth-meter.md).

## Qué hace

Reemplaza el placeholder `bandwidthBytesUsed: 0` con una medición real del consumo por proxy — dato clave con proxies móviles que se cobran por GB.

## Flujo

1. Al crear la sesión de una identity (hook de proxy-boot), `attachBandwidthMeter` hookea `session.webRequest.onCompleted`.
2. Por cada respuesta, `estimateBytesFromHeaders` estima bytes (`encodedDataLength` o `Content-Length`).
3. Se atribuyen al proxy actual de la identity (`proxyAssignment.resolve`) vía `BandwidthAccumulator.add(proxyId, bytes)`.
4. Cada 30s, `flush()` vuelca el batch a `proxyManager.addBandwidth(pid, bytes, {persist:false})` + un `_save()`.

## API pura

- `estimateBytesFromHeaders(details)` → number (0 si no hay señal).
- `BandwidthAccumulator({sink})`: `.add(proxyId,bytes)`, `.flush()→Map`, `.totalBytes`, `.pendingSize()`.
- `proxyManager.addBandwidth(id, bytes, {persist=true})` → nuevo total o null.

## Limitaciones

Aproximado: respuestas chunked sin Content-Length y sin `encodedDataLength` cuentan 0. Requiere smoke en Electron (onCompleted real).
