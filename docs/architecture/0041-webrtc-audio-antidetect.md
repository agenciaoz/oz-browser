# ADR 0041 — WebRTC anti-leak por política + warm-up de proxies al abrir workspace

**Date:** 2026-07-16
**Status:** Accepted
**Contexto:** Dos requisitos de Jose en la misma sesión: (1) "todo proxiado siempre" — cerrar cualquier fuga de la IP real, incluida la clásica de WebRTC por UDP; (2) "cuando se le da click al workspace, todos los identities hagan el handshake con su proxy" — para que el primer click en cada identity no pague el CONNECT+TLS de 600-900ms del proxy móvil.

## Decisión

### 1. Política WebRTC por webContents (prevención, no solo detección)

`leak-tests.js` ya DETECTA el leak de WebRTC analizando los ICE candidates. Esto lo PREVIENE en la fuente aplicando `webContents.setWebRTCIPHandlingPolicy(policy)` al materializar cada tab (`tabs.js` → `_materializeWith`).

El decider es puro (`webrtc-policy.js`, `decideWebRtcPolicy`) y el resolver por-identity se instala en `proxy-boot-setup.js` (tiene `proxyAssignment` + `enforceProxy`). Precedencia:

1. `override` explícito del user (`settings.privacy.webrtcPolicy`) — gana sobre todo.
2. `routingMode === 'direct'` (opt-out de alpha.108) → `default_public_interface_only`: el tráfico ya va directo (la IP real se expone por HTTP), forzar proxy-only rompería WebRTC sin ganar privacidad; solo ocultamos IPs privadas/host. Coherente con sticky-rotation (direct gana sobre enforce).
3. `routingMode === 'proxy'` o `enforce` → `disable_non_proxied_udp`: WebRTC solo por el proxy; si el proxy no hace UDP, cae a TCP/TURN. Cero leak de IP real. Es el caso central de "todo proxiado siempre".
4. Sin proxy y sin enforce (dev/master) → `default`.

### 2. Warm-up de proxies al activar workspace

`workspace-handlers.setActive`, al cambiar de workspace, llama `proxy-warmup.runWarmup` (best-effort, gated por `settings.performance.warmProxiesOnWorkspace`, default ON). Por cada identity con tabs en ese workspace: asegura su sesión (`getSession` aplica el proxy vía el hook de boot) y hace `session.preconnect({url})` hacia **el origin que esa identity ya tiene abierto** — así se calienta el túnel del proxy sin abrir destinos nuevos (importante para anti-detect). `planWarmup` es pura (dedupe por identity, prefiere la tab más reciente con origin http válido).

## Alternativas consideradas

- **Deshabilitar WebRTC del todo** — rechazada: rompe video calls / Meet / Discord embebidos; `disable_non_proxied_udp` mantiene WebRTC funcional a través del proxy.
- **Warm-up hacia un origin neutral fijo (p.ej. google.com) para todas las identities** — rechazada: genera N requests simultáneos al mismo host desde N IPs de proxy al abrir el workspace = patrón sintético detectable. Calentar hacia el origin que la identity ya visita es indistinguible de uso normal.
- **Warm-up de TODAS las identities (no solo las del workspace)** — rechazada: gasto de ancho de banda del proxy móvil (caro) sin beneficio; el user solo va a clickear las del workspace activo.

## Consecuencias

- WebRTC deja de poder filtrar la IP real en identities proxeadas — garantía a nivel de webContents, no de UI.
- El primer click en una identity del workspace recién abierto es notablemente más rápido (túnel ya caliente).
- Costo: preconnect consume un poco de ancho de banda del proxy por identity al cambiar de workspace. Aceptable y gateable (`warmProxiesOnWorkspace=false`).
- Tests: `tests/webrtc-policy.smoketest.js` (8) + `tests/proxy-warmup.smoketest.js` (16).

Ver: ADR 0039 (fail-closed), 0040 (direct opt-out + preconnect omnibox), `docs/modules/webrtc-policy.md`, `docs/modules/proxy-warmup.md`, `browser/leak-tests.js`.
