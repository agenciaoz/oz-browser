# ADR 0040 — Routing directo explícito por identity + preconnect de omnibox

**Date:** 2026-07-16
**Status:** Accepted
**Contexto:** Jose reportó que OZ navega notablemente más lento que Chrome ("quiero que vuele"). Medición en su Mac (curl, 2 runs por caso): directo `total 0.35-0.65s`, vía proxy Decodo móvil `total 1.0-1.8s` por request — el CONNECT+TLS al gateway cuesta 600-900ms por conexión nueva, y una página abre docenas. La causa no era la app (los flags GPU de v1.9.0, cache y webRequest lazy están bien): es que **el boot managed (alpha.100) auto-asigna proxy a TODAS las identities, incluida Default**, así que el browsing diario de Jose pagaba peaje de proxy móvil sin necesitarlo.

## Decisión

Dos piezas, ambas en alpha.108:

### 1. Assignment `'direct'` — opt-out explícito de proxy

Nuevo valor de assignment `'direct'` (además de proxyId / `'auto-*'` / null):

- `proxy-assignment.js`: `resolveRouting(ctx)` devuelve `{mode: 'proxy'|'direct'|'none', proxy}`. `'direct'` **corta la resolución** (no cae a workspace/defaultStrategy). `resolve()` queda como wrapper compatible (`routing.proxy`).
- `proxy-sticky-rotation.js`: mode `'direct'` → `direct://` **incluso con enforce (fail-closed) activo**. Racional: el blackhole del ADR 0039 protege contra el "sin proxy por accidente" (bundle vacío, proxy borrado); `'direct'` es una elección deliberada del operador y se loggea como tal.
- UI proxy dashboard: opción "Direct (no proxy — fast)" en el select de reasignación; la fila Default ahora también es reasignable (el boot managed le asigna proxy, así que "default — n/a" era mentira); celda muestra "Direct (no proxy)" sin flag de leak (`leakRisk=false` — es elección, no fuga).
- MCP: `oz.proxies.assignId/assignWs` aceptan `'direct'` (pass-through, solo cambió la description).

Distinción semántica clave: **null = "sin elección"** (fallthrough a workspace/default → en managed termina en proxy o blackhole); **`'direct'` = "elegí navegar sin proxy"** (gana siempre).

### 2. Preconnect de omnibox (warm-up del túnel)

`oz:nav:preconnect` (IPC) → `session.preconnect({url: origin, numSockets: 2})` sobre la sesión de la tab enfocada. El omnibox (`tabstrip.js`) lo dispara con debounce de 250ms mientras el usuario escribe, solo si el texto ya parece dominio navegable. Para identities proxeadas esto saca el CONNECT+TLS de 600-900ms del camino crítico del Enter; para directas, warm-up TCP+TLS normal. Dedupe por origin en main para no spamear el socket pool por keystroke.

## Alternativas consideradas

1. **Quitar el proxy de Default en el boot managed** — rechazada: installs del equipo (Ata/Marcela/Daniela) deben seguir fail-closed en TODO por defecto; que navegar directo sea decisión explícita del operador, no default de código.
2. **proxyBypassRules para CDNs/assets** — rechazada: partir el tráfico de una identity entre proxy y directo filtra la IP real a los CDNs de las plataformas = anti-detect roto.
3. **Cambiar de proxy móvil a datacenter para browsing** — fuera de alcance de código; `'direct'` cubre el caso "browsing personal rápido" sin costo.

## Consecuencias

- Browsing diario (Default→direct) vuelve a velocidad Chrome; identities sociales siguen 100% proxeadas y fail-closed.
- Un operador PUEDE ahora navegar una identity social sin proxy si lo elige explícitamente — mitigado: la UI lo marca claro, se loggea `explicit direct opt-out`, y el default del sistema sigue siendo proxy.
- Tests: sección direct en `tests/proxy-assignment.smoketest.js` (+5) y `tests/proxy-sticky-rotation.smoketest.js` (+4).

Ver: ADR 0039 (fail-closed), `docs/modules/proxy-sticky-rotation.md`, `docs/modules/proxy-boot-setup.md`.
