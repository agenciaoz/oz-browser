# ADR 0044 — Bandwidth meter real por proxy + evidencia visual del worker (Fase 6b/7)

**Date:** 2026-07-16
**Status:** Accepted
**Contexto:** Dos deudas del plan de cierre: (7) `proxy-manager` tenía `bandwidthBytesUsed: 0` como placeholder — nunca se medía el consumo real, dato clave con proxies móviles que se cobran por GB; (6b) el worker real de scraping (`makeRecipeWorker`, V3-D) ya navegaba y corría recipes, pero no producía evidencia visual, así que el timeline del observer 6c quedaba vacío en jobs reales.

## Decisión

### Fase 7 — Bandwidth meter real

`proxy-bandwidth.js` (núcleo puro + glue Electron):

- `estimateBytesFromHeaders(details)` — estima bytes de una respuesta: `encodedDataLength` (on-wire, si Electron lo da) o `Content-Length` del header (case-insensitive, array-safe). 0 si no hay señal.
- `BandwidthAccumulator` — acumula bytes por `proxyId` en memoria y los vuelca a un sink en batch (`add`/`flush`). El sink y el reloj se inyectan → testeable.
- `attachBandwidthMeter({session, identityId, resolveProxyId, accumulator})` — hookea `session.webRequest.onCompleted`, estima bytes y los atribuye al proxy que la identity está usando. Glue Electron, guarded.

`proxy-manager.addBandwidth(id, bytes, {persist})` — acumula sobre `bandwidthBytesUsed` (deja de ser 0). El flush del acumulador llama con `persist:false` y hace un solo `_save()` por batch.

**Wiring (`proxy-boot-setup.js`):** un `BandwidthAccumulator` global cuyo sink escribe al proxy-manager; un `setInterval` de 30s que hace flush (`unref` para no bloquear el exit); y en el hook de resolución de proxy (que ya corre al crear cada sesión) se engancha el meter una sola vez por sesión (WeakSet anti-doble-attach).

### Fase 6b — Evidencia visual del worker

`makeRecipeWorker` acepta `captureEvidence`: cuando está on, añade un step `screenshot` (named `__ozEvidence`, `optional`) al recipe; tras correr, persiste el PNG (`userData/scrape-evidence/`) y devuelve `screenshot` (path) + strippea la evidencia del `data` real. También surfacea `bytes` (tamaño del payload extraído). Así el observer 6c llena su `timeline[]` y el agente puede ver qué scrapeó cada página. `writeEvidence` se inyecta en tests (sin tocar disco). Expuesto en `oz.scrape.run` como `captureEvidence`.

## Alternativas consideradas

- **Medir bytes con `webContents` metrics** — rechazada: es por-webContents, no por-proxy, y no distingue tráfico de distintas identities que comparten un proxy pool.
- **Persistir bandwidth en cada request** — rechazada: escritura a disco por cada respuesta es caro; el batch cada 30s es suficiente para un contador de consumo.
- **Screenshot siempre en scraping** — rechazada: capturar cada página es lento y pesa; `captureEvidence` es opt-in para auditar un crawl.

## Consecuencias

- `bandwidthBytesUsed` refleja consumo real aproximado (mejor señal que 0; exacto depende de que las respuestas traigan Content-Length).
- Jobs de scraping con `captureEvidence` dejan un rastro visual reconstruible desde `oz.scrape.lastReport`.
- Ambos requieren **smoke en Electron** (onCompleted real, capturePage real) — no corren en CI/sandbox. El núcleo (estimador, acumulador, worker) sí está testeado.
- Tests: `tests/proxy-bandwidth.smoketest.js` (24) + casos nuevos en `tests/scrape-worker.smoketest.js` (2).

Ver: `docs/modules/proxy-bandwidth.md`, ADR 0042 (scrape-observability), 0017 (proxy-model), 0036 (page-control).
