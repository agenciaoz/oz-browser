# Bloque Fase 6a alpha.110 — Audio fingerprint noise — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.110 · **ADR:** 0018 (fingerprint engine)

## Qué se entregó

12º vector de fingerprint: ruido determinista en el AudioContext, cerrando el vector de audio que estaba explícitamente diferido en `fingerprint-engine.js` ("AudioContext noise — perf overhead complicado de balancear").

- `audioNoiseSeed` (32-bit derivado del seed de la identity) agregado a `buildProfile`.
- El preload (`preload-fingerprint-script.js`) hookea `AudioBuffer.prototype.getChannelData` y `AnalyserNode.prototype.getFloatFrequencyData`, perturbando 1 de cada 100 muestras con ±1e-5 vía `mulberry32(audioNoiseSeed)` **re-sembrado por llamada** (determinismo: dos lecturas del mismo buffer dan idéntico ruido; imperceptible al oído). Mismo patrón que el canvas noise.
- Resultado: el audio FP es estable por identity y distinto entre identities.

## Qué quedó funcionando

- Tests +5: `fingerprint-engine.smoketest.js` (determinismo + presencia de `audioNoiseSeed`) y `preload-fingerprint-injection.smoketest.js` (determinismo, cambia-vs-native, cross-identity). Suite fp: 98/98 + 58/58.
- check:loc verde. Solo main process (WebUI manifest sigue 2.0.64).

## Nota sobre humanización (V3-B)

Al abrir 6a se verificó que la humanización de input (mouse Bézier, typos con corrección, scroll con momentum) **ya estaba escrita** (`page-human.js`) **y wireada** (`page-handlers.js` click/type/scroll con flag `human`). No requería trabajo — solo faltaba el audio FP.

## Pendiente de Fase 6

- **6b** — worker real de scraping headless end-to-end + smokes Electron.
- **6c** — observabilidad (action log por job, timeline de screenshots, cost tracker) — no existe.
- **Fase 7** — bandwidth meter real del proxy.
- Smoke en vivo Jose: correr un audio-fingerprint test (ej. audiofingerprint.openwpm o coveryourtracks) en dos identities y ver hashes distintos + estables.
