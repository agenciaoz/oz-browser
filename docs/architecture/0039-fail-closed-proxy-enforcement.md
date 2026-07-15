# ADR 0039 — Fail-closed proxy enforcement (blackhole en vez de direct://)

**Date:** 2026-07-14
**Status:** Accepted
**Contexto:** Con proxies por licencia (alpha.100), cada install del equipo navega con los proxies que le entrega el servidor de activación. Requisito de Jose: "que no pueda navegar sin proxies" — si por cualquier razón no hay proxy resoluble (bundle vacío temporal, proxy borrado, error de import), la app NO debe caer a la conexión directa y exponer la IP real del operador.

## Decisión

Cuando el enforcement está activo y `proxyAssignment.resolve()` no devuelve proxy, `buildRulesForIdentity()` en `proxy-sticky-rotation.js` retorna `BLACKHOLE_RULES = 'socks5://127.0.0.1:1'` en lugar de `direct://`. Toda request de esa sesión falla con `ERR_PROXY_CONNECTION_FAILED` — navegación bloqueada, cero fuga.

**Cuándo se activa:** `license-proxies.bootstrapForBoot()` setea `browser.enforceProxy = (bundle de licencia no vacío)` y lo propaga con `stickyRotation.setEnforce()`. Installs sin bundle (master/dev, `OZ_LICENSE_DISABLED=1`) siguen en `direct://` — sin fricción para desarrollo.

## Alternativas consideradas

1. **Fail-open (`direct://`)** — comportamiento previo. Rechazada: una identidad multi-cuenta navegando con la IP real de la oficina es exactamente el incidente que el producto existe para prevenir; un fallo silencioso de proxy quemaría cuentas.
2. **Bloquear en UI (interceptar navegación en renderer/tabs)** — rechazada: hay demasiadas superficies (tabs, bulk runner, page control, scraping); una regla a nivel de proxy de sesión las cubre todas en un solo punto.
3. **Kill-switch de red de Chromium (`--proxy-server` global)** — rechazada: es por-app, no por-identity; OZ necesita per-session porque identities distintas usan proxies distintos.
4. **Blackhole con host inexistente vs `127.0.0.1:1`** — se eligió `127.0.0.1:1` porque falla rápido (RST local inmediato, sin timeout de DNS) y no genera tráfico de red observable.

## Consecuencias

- Un install con proxies de licencia **no puede navegar sin proxy** — garantía estructural, no de UI.
- El síntoma para el usuario es `ERR_PROXY_CONNECTION_FAILED` en todas las páginas → documentado en troubleshooting del manual; el fix es cargar/activar proxies de la licencia.
- El auto-failover (alpha.101, `proxy-failover.js`) reduce la frecuencia con que se llega a este estado: rota a otro proxy sano antes de dejar al usuario bloqueado.
- Tests: sección enforce/blackhole en `tests/proxy-sticky-rotation.smoketest.js` + `tests/license-proxies.smoketest.js`.

Ver: `docs/modules/license-proxies.md`, `docs/modules/proxy-boot-setup.md`, `docs/ACTIVACION-EQUIPO.md`.
