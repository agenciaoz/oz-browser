# Bloque perf alpha.108 — Routing directo explícito + preconnect omnibox — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.108 · **ADR:** 0040

## Qué se entregó

- **Diagnóstico con datos** (Mac de Jose, curl): directo 0.35-0.65s vs proxy Decodo móvil 1.0-1.8s por request. Causa raíz de "OZ lento vs Chrome": el boot managed (alpha.100) auto-asignó proxy a la identity **Default** → todo el browsing diario pagaba 600-900ms de CONNECT+TLS al gateway por conexión.
- **Assignment `'direct'`**: opt-out explícito por identity/workspace. `resolveRouting()` en `proxy-assignment.js` ({mode, proxy}), corta fallthrough, gana sobre enforce/fail-closed (elección deliberada ≠ accidente — ADR 0039 intacto para el caso accidental). Sticky-rotation, dashboard UI (fila Default ahora reasignable, celda "Direct", sin leak-flag), MCP descriptions.
- **Preconnect de omnibox**: IPC `oz:nav:preconnect` → `session.preconnect(origin, 2 sockets)`, disparado con debounce 250ms mientras se tipea. Saca el handshake del proxy del camino crítico del Enter.

## Qué quedó funcionando

- Default→direct (aplicado en el install de Jose) = browsing diario a velocidad Chrome.
- Identities sociales sin cambios: proxy + fail-closed + sticky rotation.
- Tests: +9 (proxy-assignment 36/36, sticky-rotation con secciones direct). WebUI manifest 2.0.64.

## Pendiente

- Smoke visual de Jose: dashboard → fila Default → select "Direct" + navegar y sentir la diferencia.
- Fase 7 (bandwidth meter real) sigue abierta.
