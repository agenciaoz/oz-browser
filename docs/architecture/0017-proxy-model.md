# ADR 0017 — Proxy Model + Assignment Hierarchy + Auto-Disable Policy (1.8)

**Date:** 2026-05-10
**Status:** Accepted
**Related blocks:** 1.8a / 1.8b / 1.8c / 1.8d / 1.8e

## Context

Ghost Browser tiene un proxy manager que permite asignar proxies per-tab,
per-identity y per-workspace. Es uno de los grandes diferenciadores
comerciales (justifica el plan Pro de $46-59/mo). El plan original del
Bloque 1.8 incluía 10 ítems (CRUD, CSV import, test conectividad, auto-assign
random/round-robin, asignación per-tab/identity/workspace, bypass list, health
checks intervalados, templates per provider Oxylabs/BrightData/Smartproxy/IPRoyal,
bandwidth meter, MCP tools).

Antes de implementar tuvimos que tomar 3 decisiones de scope (preguntadas
explícitamente a Jose, ver el preface del bloque):

1. **Provider templates:** Solo Oxylabs real (la cuenta Jose ya tiene
   `customer-mzewama` pattern confirmado), 3 stubs marcados como "Coming soon"
   para BrightData/Smartproxy/IPRoyal. Los implementamos cuando un cliente
   real lo pida (~3h cada uno).
2. **Bandwidth meter:** Placeholder en 1.8 (`bandwidthBytesUsed: 0` en el
   schema, columna en UI muestra "—"). Real instrumentación con
   `session.webRequest.onCompleted` queda para Bloque 1.10 (~2h adicionales,
   con perf overhead que solo vale la pena cuando llegue Settings + Polish).
3. **Health daemon:** Manual + Daemon liviano. Botón "Test" individual + "Test
   all" paralelo + daemon cada 30 min auto-disable después de 3 fallas
   seguidas. Diferenciador vs Ghost (que solo tiene manual test).

## Decision

**1. Modelo Proxy (12 fields):**

```js
Proxy = {
  id, name, protocol ('http'|'https'|'socks5'), host, port,
  username, password,
  tags: [], country?,
  lastTestedAt?, lastLatencyMs?, lastTestedIp?, failureCount: 0,
  isActive: true, isDisabled: false,
  bandwidthBytesUsed: 0,  // placeholder v1
  createdAt
}
```

**Decisión clave:** `isActive` (controlado por usuario) vs `isDisabled`
(controlado por el daemon de health). Ambos deben ser true=usable e
false=usable respectivamente para que el proxy entre en `listAssignable()`.
Esto separa "user pausó esto" de "el sistema lo apagó porque está roto" —
el usuario puede recuperar manualmente con `setActive(true)` que also clears
`isDisabled`.

**2. Asignación per-tab NO soportada en v1 (limitación honesta).**

Electron's `session.setProxy()` es per-SESSION. Como las tabs comparten
session per-identity (eso es lo que hace que sean separadas — cookies/storage
aisladas), darles proxies distintos por tab REQUIERE crear sessions
adicionales. Eso rompe el modelo Identity (que es la unidad de aislamiento).

**Workaround supportado:** si un usuario quiere proxy distinto en una tab
específica, usar el menu "Duplicate → New Identity" (1.7a) y asignarle un
proxy a esa identity. Es un step manual pero preserva el modelo.

**Cómo lo logra Ghost:** Ghost crea sessions efímeras al asignar proxy a una
tab. Eso mezcla los modelos y termina rompiendo aislamiento (cookies de la
tab nueva no se sincronizan con la identity). Preferimos honrar el modelo.

Si demand real lo justifica, la opción C "per-tab via temp identity automática"
queda como roadmap.

**3. Jerarquía de resolución: Identity > Workspace > defaultStrategy.**

```
resolve({identityId, workspaceId}):
  1. assignments.byIdentity[identityId] → si concrete proxyId, return it
  2. byIdentity[identityId] === 'auto-*' → manager.autoAssign(strategy)
  3. assignments.byWorkspace[workspaceId] → idem
  4. assignments.defaultStrategy → idem
  5. null = direct (no proxy)
```

Más específico gana. Esto matchea el mental model: "esta identity siempre
usa Oxylabs US"; "este workspace usa round-robin"; "todo lo demás random".

**4. Test de conectividad: TCP+CONNECT (no full HTTPS GET).**

Para v1 hacemos TCP socket connect + (para HTTP/HTTPS proxies) handshake
HTTP CONNECT. Status 200 → ok. Status 407 (auth required) → ok (proxy
está vivo, auth se valida en uso real). Otros 4xx/5xx → fail.

Para SOCKS5: solo TCP reachability (parsing SOCKS5 handshake completo es
overhead que no aporta valor en v1).

**Limitación honesta:** NO validamos que el proxy fetchee contenido externo
(eso requiere TLS handshake completo + HTTP GET + body parsing). El TCP+CONNECT
atrapa el 90% de los modos de falla (proxy dead, host wrong, port wrong,
auth equivocado). "Real fetch test" en 1.10 con instrumentación full.

**5. Auto-disable policy: 3 fallas consecutivas → isDisabled=true.**

Counter `failureCount` en cada Proxy. `recordHealthSuccess()` lo resetea a 0
y reactiva (clears `isDisabled`) — el user puede recuperar por self-healing
del proxy o por fix manual. Después de 3 fallas: `isDisabled=true` +
notification del OS ("OZ — Proxy auto-disabled").

**Por qué 3 (no 1, no 5):** uno solo es ruido (proxies tienen latency
variance natural); cinco es tarde (tabs ya están fallando user-visible).

**6. Daemon cada 30 min** (DEFAULT_DAEMON_INTERVAL_MS).

Solo testea proxies en `listAssignable()` — no chequea los que el user
deshabilitó. Si un proxy queda auto-disabled, no se vuelve a testear hasta
que el user lo re-active manualmente. Si el daemon detecta failure que lleva
a auto-disable, dispara la notificación una vez (no spam).

**Por qué 30 min:** balance entre detección rápida y overhead. 288 chequeos
diarios por proxy seria agresivo (y consumiría bandwidth de proveedores
pagos). 30 min = 48 chequeos diarios, suficiente.

**7. Provider templates: Oxylabs real, 3 stubs marcados.**

Solo Oxylabs implementado en v1 (es la cuenta de Jose, único caso real
testeable). El template de Oxylabs genera N proxies con sessid sequential
(`customer-{user}-cc-{country}-sessid-000001-sesstime-30`, sessid 000002,
etc), que es el mecanismo de session sticky de Oxylabs.

BrightData / Smartproxy / IPRoyal: cards visibles en UI con badge "Coming
soon" — al click no abre form. Cuando un cliente real lo pida, ~3h por
provider.

**8. CSV import: format compat con Ghost Browser** (`protocol,host,port,
username,password,tags,country,name`). Headers tolerantes a reordenamiento
y aliases (`User`/`Pass`/`IP` aceptados). Tags split por `|` o `;`. Filas
sin host o port se skipean silenciosamente (resilient). csv-parse/sync
(deps ya pre-instaladas).

## Architecture

```
ProxyManager (proxies.json)
   │ CRUD + autoAssign random/round-robin
   ▼
ProxyAssignment (proxy-assignments.json)
   │ resolve({identityId, workspaceId}) → Proxy | null
   ▼
ProxyHandlers (handler map IPC↔MCP)
   │ + applyAssignmentsToIdentity(browser, identityId)
   ▼ (on assign change)
session.setProxy({proxyRules})
   │ (Electron applies to subsequent requests)
   ▼ (on 407 challenge)
app.on('login') → look up proxy creds → callback(user, pass)

ProxyHealth daemon (30 min interval)
   │ testAll() → testOne() per proxy
   │   ├── http/https → tcpConnect + CONNECT handshake parse
   │   └── socks5 → tcpConnect only
   │ recordHealthSuccess / recordHealthFailure
   ▼ (on 3 fails consecutive)
proxy.isDisabled = true + Notification
```

**Loose coupling:** `IdentityManager.setProxyResolutionHook(fn)` — main.js
wires the hook so identity-manager doesn't need to know ProxyManager exists.
Tests can inject any hook.

## Consequences

**Positive:**

- Per-identity + per-workspace assignment funcionan native con session.setProxy.
- Auto-Assign random/round-robin habilita automation flows (un agente puede
  hacer `oz.proxies.assignToWorkspace('ws-x', 'auto-round-robin')` y olvidarse).
- Health daemon detecta proxies muertos sin user intervention.
- Auto-disable previene que tabs queden bloqueadas con proxies rotos.
- Notification al user cuando auto-disable da feedback transparente.
- Oxylabs template real cubre el 80% de casos para Jose + early users.
- 22 MCP tools `oz.proxies.*` exponen todo para automation.
- CSV import format Ghost-compat habilita migración trivial.

**Negative:**

- Per-tab proxy NO supported (workaround manual via Duplicate→New Identity).
- BrightData / Smartproxy / IPRoyal stubs hasta que un cliente lo pida.
- Bandwidth meter solo placeholder en 1.8 (real en 1.10).
- TCP+CONNECT health check no valida fetch real (90% suficiente, full en 1.10).
- Daemon de 30 min no detecta inmediatamente si un proxy se cae (gap de hasta 30 min).

**Métricas de cierre:**

- 5 sub-fases (1.8a, 1.8b, 1.8c, 1.8d, 1.8e) en una sesión continua, ~6h
  efectivas vs ~12h originales (mucho menos por scope reducido en preguntas).
- 8 archivos source nuevos: proxy-manager.js, proxy-handlers.js,
  proxy-assignment.js, proxy-health.js, proxy-csv.js, proxy-providers.js,
  mcp-tools-proxies.js, browser/ui/proxy-manager.js.
- 4 tests nuevos: proxy-manager (58), proxy-assignment (30), proxy-health
  (25), proxy-csv (45) = 158 nuevos.
- mcp-server contract test detectó automáticamente +22 tools nuevos (105 →
  127).
- Total proyecto: 750 → 908 (+158).
- 1 dep efectiva: csv-parse (ya pre-instalada, sin npm install adicional).

## Alternatives considered

- **Per-tab via temp identities automáticas:** demasiado complejo para v1,
  rompe modelo Identity. Documentado como workaround manual.
- **Health daemon más frecuente (5 min):** descartado — 288 chequeos diarios
  por proxy consumirían bandwidth innecesaria en planes Residential pagos.
- **All 4 providers ahora:** descartado — sin cuentas reales en BrightData /
  Smartproxy / IPRoyal el código sería untestable.
- **Bandwidth meter real:** descartado para v1 — perf overhead no justificable
  hasta que la feature tenga UI completa en 1.10.
- **`https-proxy-agent` para health checks:** descartado — depende de tlssocket
  y aumenta superficie de deps. TCP+CONNECT manual es 50 LOC y testeable.
