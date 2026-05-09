# ADR 0015 — Workspace model + ventana 1-1 lock exclusivo

**Estado:** Aceptado (2026-05-09 — Bloque 1.4-WS Workspace Manager)
**Fecha:** 2026-05-09
**Autor:** Claude / Jose
**Bloque:** 1.4-WS

## Contexto

El Bloque 1.4-WS introduce Workspaces — colecciones de tabs persistidas que el usuario puede crear, switchear, archivar, congelar y duplicar. Antes de codear hay tres decisiones de modelo que afectan toda la arquitectura del bloque y bloques siguientes (sync, vault per-WS, time machine):

1. **¿Cómo se relacionan ventanas y workspaces?** — ¿1 ventana puede mostrar varios WS (tabs mezcladas)? ¿1 WS puede estar abierto en varias ventanas simultáneamente?
2. **¿Cómo se persisten las tabs de cada workspace?** — ¿como WebContentsView vivos en RAM siempre, o como specs serializables que se materializan on-demand?
3. **¿Qué pasa con un workspace congelado (freeze)?** — ¿es read-only total o solo bloquea CRUD del usuario?

## Decisión

### 1. Lock exclusivo: 1 ventana = 1 workspace, 1 workspace = máx 1 ventana

- Cada `TabbedBrowserWindow` tiene un `workspaceId` que apunta a 1 workspace.
- Un workspace solo puede estar abierto en una ventana a la vez. Si el usuario intenta abrir un WS ya abierto en otra ventana, OZ rechaza con error `WORKSPACE_ALREADY_OPEN` y se le ofrece focus a la ventana existente.
- Cada workspace es como un "contenedor de tabs" — la ventana solo es la lente.

**Por qué:**

- Es el modelo de Ghost (nuestro benchmark). Los usuarios actuales lo entienden.
- Sync de tabs cross-window con el mismo WS sería un dolor: necesitaríamos broadcast IPC de cada tab create/destroy/select entre ventanas, y manejar conflictos cuando dos ventanas intentan modificar la misma tab simultáneamente.
- Multi-window con WS distintos cubre el use case real (tener 2 monitores con 2 contextos diferentes). Mismo WS en 2 ventanas no agrega valor — el usuario quiere ventanas de WS distintos.
- Bloque 1.6 (Time Machine) y Etapa 7 (Sync) asumen este modelo: 1 WS = 1 owner activo en cada momento.

### 2. tabSpecs serializables + materialización lazy on switch

- El workspace persiste sus tabs como `tabSpecs: [{ id, identityId, url, title, favicon?, pinned? }]` (objetos planos serializables a JSON).
- Solo el workspace **activo en una ventana** tiene tabs vivas (instancias de `Tab` con `WebContentsView`).
- Al cambiar de workspace en una ventana:
  1. `tabs.tabList.serializeAll()` → `workspaceManager.setTabSpecs(currentWsId, ...)`
  2. `tabs.destroy()` libera todas las `WebContentsView` (evict de memoria).
  3. Cargar `tabSpecs` del nuevo WS, crear `Tab` instances **sin materializar** (lazy — ADR 0002).
  4. Materializar la tab que era la activa (o la primera).

**Por qué:**

- **Memoria:** Ghost free-tier permite 5 workspaces. Si los 5 estuvieran vivos en RAM, con 10 tabs cada uno son 50 procesos renderer = ~3 GB. Inaceptable. Lazy = solo el WS activo paga el costo.
- **La sesión per-Identity persiste en disk** (`persist:identity-X` SQLite, ADR 0003). Cuando se reabre la tab, las cookies y storage siguen logueados — la pérdida es solo el state in-memory de la página (scroll, form data NO submitted, video reproduciendo).
- **Trade-off aceptado:** scroll position y form data en progreso se pierden al switch. Documentado en UI con tooltip "Switching workspaces will reload tabs". Para usuarios que necesiten preservar scroll, recomendamos pin de la tab (Bloque 1.7) o quedarse en el WS.

**Consecuencia:** debe haber persist confiable de tabSpecs ANTES de destruir las tabs vivas. Si crash entre snapshot y destroy, no se pierde nada (snapshot ya escrito a disk). Si crash durante destroy, OK — la próxima vez que se abra el WS, las tabSpecs en disk están bien.

**Persistence cadence (anti-data-loss):**

- Snapshot inmediato + sync write `_saveNow()` antes de destruir tabs en el switch.
- Throttled save (`saveDelayMs=2000` recomendado en runtime; default 0 = sync para tests) durante navegación normal — coalesces bursts de `tab-updated` events.
- `flush()` en `app.before-quit` para asegurar el último estado escrito.

### 3. Freeze = read-only para usuario, transparente para runtime

- `freeze(id)` setea `isFrozen=true`. La UI bloquea CRUD: rename, delete, move, drag-drop.
- **Pero:** `setTabSpecs(id, ...)` y `setActiveTabId(id, ...)` siguen funcionando — son el snapshot path del switch logic. Si bloqueáramos esto, no se podría visitar un WS frozen.
- `update(id, patch)` en frozen retorna `null` (rechaza patches del usuario).
- `unfreeze(id)` desbloquea sin perder datos.
- Default WS NO se puede freeze (sería absurdo: el contenedor que recibe todo cuando un WS se borra).

**Por qué:**

- Use case primario de freeze: snapshot de configuración estable para no toquetear por accidente. Ej.: WS "Producción" donde están las cuentas críticas — frozen evita borrar una identity por accidente.
- Pero el usuario necesita poder VISITAR el WS frozen (ver las tabs, navegar, leer). Por eso runtime sigue libre.
- Distinción clara entre **CRUD del modelo** (frozen rechaza) y **runtime navigation** (frozen acepta).

## Modelo final

```js
Workspace = {
  id,            // uuid (8 bytes hex) — Default fijo "general"
  name,          // string libre
  color,         // hex #RRGGBB (auto-pickeado del pool DEFAULT_COLORS)
  isDefault,     // boolean — solo "general" lo es
  isArchived,    // boolean — oculto de listActive(), pero datos preservados
  isFrozen,      // boolean — bloquea update() pero permite setTabSpecs runtime
  quickTabsMode, // 'load-all' | 'one-by-one' | 'on-click' | 'on-click-confirm'
  createdAt,
  updatedAt,
  tabSpecs: [{
    id,          // uuid stable — sobrevive switch/reload
    identityId,  // qué identity owns esta tab
    url,
    title,
    favicon?,    // base64 / data URL
    pinned?,
  }],
  activeTabId,   // last selected tab id mientras este WS estaba activo
}
```

## Alternativas consideradas

### A. Multi-ventana shared WS (rechazado)

Permitir 2+ ventanas mostrando el mismo workspace, sincronizando tabs entre ellas.

- ❌ Complejidad: cross-window IPC para cada evento de tab.
- ❌ Conflictos: dos ventanas modificando la misma tab → race conditions.
- ❌ Use case real débil: usuarios que abren mismo WS en 2 ventanas suelen querer "ver lo mismo de fondo" (cubrible con read-only mirror, no edit).
- ✅ Beneficio: drag entre ventanas. Pero esto se cubre mejor con drag-drop de tab a otro WS (1.4d).

### B. WebContentsViews vivas siempre (hot swap visibility)

Mantener todas las tabs de todos los WS en memoria, solo `setVisible(false)` al switchear.

- ❌ RAM crece linealmente con N workspaces × tabs/WS. Para 5 WS × 10 tabs = 50 renderers, ~3 GB.
- ❌ CPU background: tabs invisibles siguen ejecutando JS / timers / WebSockets.
- ✅ Switch instantáneo y preserva todo (scroll, form data, video).
- ⚠️ Trade-off rechazado por costo de memoria. Para usuarios que necesitan switch rápido entre 2 WS, podemos agregar **hybrid LRU** (mantener vivos los últimos 2 visitados) en bloque futuro si la demanda lo justifica.

### C. Freeze = read-only total

Bloquear también `setTabSpecs` en frozen.

- ❌ Imposible visitar un WS frozen sin "tocarlo" (cualquier navegación cambia tabs).
- ✅ Más estricto conceptualmente.
- ⚠️ Rechazado: la finalidad de freeze es proteger del usuario, no del runtime.

## Consecuencias

- ✅ RAM de OZ se mantiene comparable a Ghost — 1 WS activo por ventana.
- ✅ Persistencia robusta: tabSpecs son JSON puro, fácil de migrar/exportar/sincronizar.
- ✅ Switch logic queda contenido en `TabbedBrowserWindow.switchToWorkspace` (1.4b) — un único lugar que serializa, destruye, recarga.
- ✅ Modelo compatible con sync futuro (Etapa 7): tabSpecs son lo que se sube a Supabase/Dropbox; vivían serializados desde el día 1.
- ✅ Compatible con Time Machine (Bloque 1.6): los snapshots de workspaces.json son determinísticos.
- ⚠️ Form data y scroll se pierden al switchear (documentado en UI con tooltip).
- ⚠️ Cuando un usuario tiene 2 ventanas con WS distintos y cierra una, el WS de la cerrada queda "libre" para reabrirse en otra ventana. Necesitamos liberar el lock al destroy.
- ⚠️ Default WS siempre presente — borra protegido. Si el usuario remueve el WS activo, fallback automático a Default.

## Plan de implementación (Bloque 1.4-WS)

Sub-fases con commit + CI verde por fase (decisión de Jose 2026-05-09):

- **1.4a** Backend: `workspace-manager.js` + `workspace-handlers.js` + IPC + tests + ADR (este doc). ✅
- **1.4b** Switch logic + ventana 1-1 lock + persistencia throttled + tests extendidos.
- **1.4c** Sidebar UI: pills horizontales arriba, CRUD inline.
- **1.4d** Drag-drop tabs cross-WS + right-click "Move to workspace…".
- **1.4e** MCP tools `oz.workspaces.*` + Quick Tabs 4 modos + cierre + docs/history.

## Referencias

- [ADR 0002](0002-lazy-tabs.md) — lazy materialization base que reusamos.
- [ADR 0003](0003-default-identity-uses-defaultsession.md) — sessions per-identity persisten en disk independientemente del runtime.
- [ADR 0011](0011-modals-hide-content-view.md) — patrón de hide WebContentsView reusado en switch (todas las views se destruyen, no solo se ocultan).
- [ADR 0012](0012-oz-mcp-server.md) — handlers shared entre IPC y MCP — `workspace-handlers.js` sigue el patrón de `identity-handlers.js`.
- Ghost Browser docs sobre workspaces: https://ghostbrowser.com/docs/workspaces (referencia del modelo lock-exclusivo que adoptamos).
