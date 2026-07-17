# Bloque anti-detect alpha.109 — WebRTC policy + warm-up de proxies — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.109 · **ADR:** 0041

## Qué se entregó

Dos pedidos de Jose en la misma sesión:

1. **WebRTC anti-leak por política** (refuerza "todo proxiado siempre"). `webContents.setWebRTCIPHandlingPolicy` al materializar cada tab: identity proxeada o install enforce → `disable_non_proxied_udp` (WebRTC también por el proxy, nunca UDP con la IP real); direct opt-out → `default_public_interface_only`. Decider puro `webrtc-policy.js`, resolver instalado en `proxy-boot-setup.js` (usa `resolveRouting` + `enforceProxy`). Prevención en la fuente; `leak-tests.js` solo detectaba.
2. **Warm-up de proxies al abrir workspace** (idea de Jose). `workspace-handlers.setActive` → `proxy-warmup.runWarmup`: por cada identity con tabs en el workspace, asegura sesión (aplica proxy) + `session.preconnect` al origin ya abierto. Saca el CONNECT+TLS de 600-900ms del primer click. Gated `performance.warmProxiesOnWorkspace` (default ON).

## Qué quedó funcionando

- Tests +24 (webrtc-policy 8/8, proxy-warmup 16/16). check:loc verde (475 files). Solo main process (WebUI manifest sigue 2.0.64).
- Nuevos módulos: `browser/webrtc-policy.js`, `browser/proxy-warmup.js`. Nueva setting `performance.warmProxiesOnWorkspace`.

## Pendiente

- **Smoke en vivo (Jose, Electron):** (a) reiniciar OZ, abrir un workspace con varias identities y sentir que el primer click de cada una es más rápido; (b) verificar en un leak-test que WebRTC ya no expone la IP real en identity proxeada.
- Fase 6a restante (audio FP noise, humanization scroll/typos) y 6b/6c siguen abiertas.
- Bandwidth meter real (Fase 7).
