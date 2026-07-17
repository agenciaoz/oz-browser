# Bloque alpha.114 — Mejoras post-smoke: leak-risk + fix auto-updater — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.114

## Contexto

Salió de que Claude corrió los smokes visuales EN VIVO (alpha.112) usando el módulo `oz.diag.*` — llamando al servidor MCP local directamente y leyendo los PNG. Dos hallazgos accionables:

1. El snapshot mostró **`enforceProxy: false`** en el install de Jose → si una identity no tiene proxy resoluble, navega por la IP real (no blackhole). Riesgo directo contra "todo proxiado siempre".
2. El log tenía un **ERROR `blockmap 404`** del auto-updater: intenta descarga diferencial, no encuentra el `.blockmap` (electron-forge no lo genera), y recién ahí cae a descarga completa.

## Qué se entregó

1. **leak-risk en el diagnóstico.** `leakRiskFor(browser, identities)` (puro) cruza cada identity contra `proxyAssignment.resolveRouting`; las que dan modo `'none'` (sin proxy y sin opt-out `'direct'`) se listan como fuga. Va en `oz.diag.snapshot.leakRisk = { enforced, count, identities[] }`. Ahora Claude/Jose ven de un vistazo qué identity navegaría sin proxy.
2. **Auto-updater:** `autoUpdater.disableDifferentialDownload = true` — sin intento de `.blockmap`, sin el ERROR 404; descarga completa directa (que ya andaba). Generar blockmaps reales (app-builder-bin) queda como mejora futura.

## Qué quedó funcionando

- Tests +8 (leakRiskFor + leakRisk en buildDiagnostics). system-diagnostics 44/44. check:loc verde. Solo main (manifest 2.0.64).
- Este release incluye también lo de alpha.113 (bandwidth meter + evidencia del worker) que aún no se había publicado.

## Observación no implementada (follow-up)

- En el smoke del chrome se vieron tabs con identidad **"Unknown · ip-api"**. `oz-utils.identityName` cae a 'Unknown' cuando el `identityId` del tab no está en la lista cacheada del tabstrip. Puede ser staleness de cache del tabstrip o tabs huérfanos de una identity borrada. Requiere debug en vivo para decidir el fix (refrescar cache vs. limpiar tabs huérfanos). Anotado, no bloqueante.

## Pendiente

- Publicar alpha.114 firmado (trae 113 + 114 a Jose vía auto-update).
- Smoke vivo del bandwidth (ver bytes subir) + scrape con evidencia.
