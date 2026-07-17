# Bloque Fase 6b/7 alpha.113 — Bandwidth meter + evidencia del worker — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.113 · **ADR:** 0044

## Qué se entregó

Dos deudas del plan de cierre, en paralelo:

**Fase 7 — Bandwidth meter real.** `proxy-bandwidth.js`: `estimateBytesFromHeaders` (encodedDataLength o Content-Length), `BandwidthAccumulator` (batch en memoria + flush a sink), `attachBandwidthMeter` (hookea `session.webRequest.onCompleted` y atribuye bytes al proxy de la identity). `proxyManager.addBandwidth` acumula sobre `bandwidthBytesUsed` (deja de ser 0). Wiring en `proxy-boot-setup`: acumulador global + flush cada 30s (unref) + attach una vez por sesión (WeakSet).

**Fase 6b — Evidencia visual del worker.** `makeRecipeWorker` gana `captureEvidence`: añade un step screenshot (`__ozEvidence`, optional), persiste el PNG en `userData/scrape-evidence/`, devuelve `screenshot` (path) + strippea la evidencia del data real + surfacea `bytes`. Alimenta el `timeline[]` del observer 6c. Expuesto en `oz.scrape.run` como `captureEvidence`. `writeEvidence` inyectable en tests.

## Qué quedó funcionando

- Tests +26 (`proxy-bandwidth.smoketest.js` 24 + 2 casos nuevos en scrape-worker). scrape-observer 23/23, proxy-manager 60/60. check:loc verde (483 files). Solo main (manifest 2.0.64).

## Pendiente

- **Smoke en Electron (Jose):** (a) navegar con una identity proxeada y ver `bandwidthBytesUsed` subir en `oz.proxies.list`; (b) `oz.scrape.run` con `captureEvidence:true` y revisar `oz.scrape.lastReport.timeline` + los PNG.
- El worker adapter V3-D ya estaba escrito; 6b agregó la evidencia. Queda el smoke end-to-end del scraping real (Cloudflare, etc.).
- Cierra Fase 7 (a nivel código). Fase 6 queda solo con el smoke en vivo del scraping headless.
