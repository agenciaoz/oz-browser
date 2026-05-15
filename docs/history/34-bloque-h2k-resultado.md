# Bloque H-2k — Oxylabs Proxy Builder modal

**Status:** ✅ H-2k cerrado 2026-05-15
**Commit:** TBD
**Version:** 1.1.5
**Tiempo efectivo:** ~2.5h (más rápido que 4h estimado porque backend ya existía)
**Deps nuevas:** ninguna
**Tests nuevos:** +40 (proxy-providers 34 + oxylabs-builder 6)

## Origen

H-2k cierra el penúltimo eslabón del set H-2 (Proxy Ops Dashboard) — el **killer feature** que ahorra ~80% del setup tedioso de Oxylabs Residential. Hasta v1.1.4 los users tenían dos paths para agregar proxies Oxylabs:

1. **Manual**: pegarse a mano N usernames `customer-mzewama-cc-us-sessid-000001-sesstime-30` en el modal existente o via CSV import — error-prone, lento.
2. **Provider form preexistente**: existía un form básico dentro del proxy-manager modal (provider view) que aceptaba endpoint/customer/password/country/count/sesstime. **Pero faltaban**: city support, sticky toggle (off = rotación residential), preview before insert, accesible solo enterrado en una sub-vista del modal proxy-manager (no desde el dashboard tab que es el flow principal v1.1.x).

## Decisiones

1. **Builder modal nuevo accesible desde dashboard header** (vs ampliar el form interno de proxy-manager). El dashboard es el primary flow desde H-2b; surfacing desde el header alinea el ergonómica con `+ Import` y `Bulk assign` que ya viven ahí.
2. **City: slugify lowercase + underscore** ("New York" → `city-new_york`). Oxylabs convention. Preserve original casing en `item.city` field para display.
3. **Sticky toggle**: cuando `sticky=false`, todos los N items comparten el mismo username (la rotación la hace el upstream Oxylabs por request). Use case: scraping de alto volumen donde sticky session sería overkill. `name` suffix usa "rot N" para disambiguation visual en la pool.
4. **Preview client-side** (5 items) en vez de IPC roundtrip por keystroke. La función `previewGenerate` mirror la lógica backend de `expandOxylabs`. Cuando el user clickea Insert, ahí sí se llama el backend que persiste.
5. **30 countries en dropdown** priorizando LATAM (Jose y su equipo agencia operan en AR/BR/MX/CO/CL/PE) + presets globales US/ES/EU/Asia/Oceanía. Field `city` queda como text libre — Oxylabs validará en runtime.

## v1.1.5 — H-2k

### Backend (`browser/proxy-providers.js`)

`expandOxylabs(opts)` ampliado:

- Nuevo opt `city: string` (default null) — slugified como `city-<lowercase_underscore>` y se inserta entre `cc-XX` y `sessid-N` en el username. Si city sin country, se inserta entre `customer-X` y `sessid-N`.
- Nuevo opt `sticky: boolean` (default true). Cuando `false`, omite los segmentos `sessid-N` y `sesstime-M` del username — todos los items resultantes comparten el mismo username, y el `name` usa "rot N" suffix.
- `tags` ahora incluye city cuando provista.
- `item.city` field nuevo (preserva original casing).
- Backward-compatible: defaults preservan el comportamiento previo (sticky on, sin city, sin breaking changes en consumers existentes).

`PROVIDERS.oxylabs.fields` agrega `{id:'city', label:'City (optional)', placeholder:'new_york'}`.

### UI (`browser/ui/oxylabs-builder.js`)

Módulo nuevo (~310 LOC) IIFE expone `window.OZ_OxylabsBuilder`:

- `open(deps)` — lazy-injects modal al DOM. Idempotente. Inyecta CSS scoped (id `oxy-builder-styles`) on first open.
- `close()` — remueve del DOM, resetea state. Idempotente.
- `previewGenerate(maxItems)` — mirror client-side de `expandOxylabs` (defensive null-check si pre-open). Returns `[{username, host, port, sessId}, ...]` cap a `maxItems` (default 5).
- `COUNTRIES` — readonly array de 30 tuplas `[code, label]`.

Form fields:

| Field       | Type     | Default                  | Notes                          |
| ----------- | -------- | ------------------------ | ------------------------------ |
| endpoint    | text     | `us-pr.oxylabs.io:10001` | host:port                      |
| customer    | text     | —                        | required                       |
| password    | password | —                        | required                       |
| country     | dropdown | (empty = Any)            | 30 ISO codes priorizando LATAM |
| city        | text     | —                        | optional                       |
| sticky      | checkbox | ON                       | toggle hides/shows sesstime    |
| sesstime    | select   | 30 min                   | options: 10/30/60/120          |
| startSessId | number   | 1                        | sequential base                |
| count       | number   | 10                       | 1-1000 enforced                |

Live preview: tabla con primeros 5 generados (sessId + username + host:port en mono font, word-break). Si count > 5, footer row "… and N more".

Validation inline: endpoint debe matchear `host:port` regex, customer + password requeridos, count 1-1000. Insert button disabled hasta validation green.

`insert(deps)`: deshabilita button + texto "Inserting…" → `window.oz.proxies.expandProvider('oxylabs', opts)` → si `__error` muestra inline error, si ok `window.alert("Added N proxies")` + close + `deps.refreshDashboard()`.

CSS inline (scoped al backdrop id) — no toca el CSS del dashboard. Pattern matches proxy-dashboard-import.js / proxy-dashboard-bulk-assign.js.

### Wire

- `browser/ui/proxy-dashboard.html`: nuevo `<button id="btn-oxylabs">` entre `+ Import` y `Bulk assign` + nuevo `<script src="./oxylabs-builder.js">` antes de `proxy-dashboard.js`.
- `browser/ui/proxy-dashboard.js`: en `wire()`, btn-oxylabs click → `OZ_OxylabsBuilder.open({t, refreshDashboard})`.

### i18n

Nuevo top-level namespace `oxylabsBuilder.*` con 13 keys EN + ES: openBtn, title, endpoint, customer, password, country, city, sticky, sesstime, startSessId, count, preview, insert.

### Version bumps

- `package.json` 1.1.4 → 1.1.5
- `browser/ui/manifest.json` 1.1.4 → 1.1.5 (regla `feedback_webui_manifest_bump`)

## Tests

2 archivos, +40 assertions:

- `tests/proxy-providers.smoketest.js` (~230 LOC, **34 asserts**, **archivo nuevo**): cubre `expandOxylabs` end-to-end por primera vez. Validation guards (missing fields × 3, INVALID_COUNT × 4, INVALID_ENDPOINT) + happy path (3-item shape: host/port parse, protocol, username pattern, sequential sessid, tags) + country (lowercase cc, tags, name) + **city H-2k** (slugify "New York" → new_york, tags incluyen city, item.city preserva original, name muestra "US/New York", city sin country igual funciona) + **sticky H-2k** (sticky=false omite sessid+sesstime, items share username, name "rot N") + startSessId/sesstimeMin honored + listProviders shape (4 providers, oxylabs available, others coming-soon) + city field en `fields` registry + expandProvider dispatch (COMING_SOON / UNKNOWN_PROVIDER).
- `tests/oxylabs-builder.smoketest.js` (~205 LOC, **6 asserts**): vm-evaluated IIFE con fakeWindow + fakeDocument. Verifica exports + COUNTRIES shape (>20 entries, LATAM picks present, tuple shape) + previewGenerate null-state guard. `open() + full preview` validation requires real DOM (jsdom) — deferred a smoke visual end-to-end (regla `feedback_smoke_visual_bugs`).

Suite full verde. Lint clean. `check:loc` max 500 (proxy-dashboard.js tocó 500 LOC budget exactly tras agregar btn-oxylabs click handler — bajo el límite).

## Pendiente

- **Smoke visual REAL** con app corriendo:
  1. Click `+ Oxylabs` desde proxy-dashboard header → modal opens
  2. Llenar form: endpoint default, customer (Jose's: mzewama), password, country=AR, city=buenos_aires, sticky on, sesstime=30, startSessId=1, count=10
  3. Verificar preview: 5 rows con `customer-mzewama-cc-ar-city-buenos_aires-sessid-000001-sesstime-30` patrón
  4. Click Insert → alert "Added 10 proxies"
  5. Dashboard refresh muestra los 10 nuevos proxies en la table
  6. Test toggle sticky off → preview no muestra sessid+sesstime, todos los rows iguales, name "rot N"
- Si silent wire-up bug emerge, fix-up commit antes de cerrar 1.1.5 definitivamente.

## Próximos sub-bloques (v1.1.5.x → 1.1.6)

Per roadmap `project_v1_roadmap.md`:

- H-2-wire Modal proxy-manager existing integrado con dashboard (~1h) — proxy-manager modal queda como vista compacta del mismo subsystem
- H-2 extras opt-in (~2h) — backup automático pre-bulk-destructivo + export diagnostic

Cierran el set H-2 completo (Proxy Ops Dashboard) y el `1.1.x` line. Después `1.2.0` G-6 Ghost importer también importa proxies.
