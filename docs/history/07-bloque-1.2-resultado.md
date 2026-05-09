# Bloque 1.2 — Resultado: ✅ Identity Manager + Lazy Tabs + Sidebar + Custom UA

**Fecha de cierre:** 2026-05-09
**Sesiones acumuladas:** 4 (3 anteriores + esta sesión de cierre)
**Estado anterior:** ~70% (sidebar + lazy tabs + identity manager + logger + error popup + refactor modular + estructura docs)

---

## Lo que entregamos en esta sesión de cierre

### 1. Default Identity siempre visible con `(n)` count

- `sidebar.js renderIdentityRow` agrega `.identity-count` con número de tabs (lazy + materialized) de esa identity al lado del nombre.
- Default identity recibe class CSS `.default` que pinta un `·` muted al final del nombre — diferenciador visual sutil sin agregar otra columna.
- CSS en `webui.html`: estilo `.identity-count` (tabular-nums, `--text-muted`) + opacity 0.45 cuando `(0)`.

### 2. Per-identity custom User-Agent (ADR 0010)

- **ADR nuevo**: `docs/architecture/0010-per-identity-user-agent.md` — explica decisión, alternativas (per-tab, preload override, diferir a Bloque 1.5) y deuda asumida (UA del HTTP header consistente, `navigator.userAgent` no override hasta Bloque 1.5).
- **Modelo**: campo `userAgent: string|null` en Identity. `IdentityManager.create({...userAgent})` lo acepta. Default rechaza con warn (compartiría defaultSession con extensions, riesgo).
- **Método nuevo**: `IdentityManager.update(id, patch)` — whitelist de keys (`name`, `color`, `userAgent`). `rename`/`setColor` ahora son wrappers. Si `userAgent` cambia y la session ya está cacheada, llama `setUserAgent` en vivo (no requiere restart).
- **Aplicación**: en `getSession(id)`, cuando se crea la partition session de una identity no-default con `userAgent` setteado, se llama `ses.setUserAgent(ua)` antes de cachear.
- **IPC**: nuevo channel `oz:identities:update`. Preload expone `window.oz.identities.update(id, patch)`.
- **UI — modal nuevo**: `browser/ui/identity-editor.js` (156 LOC, módulo aparte) + markup en `webui.html` + CSS. Form con name, color swatches (paleta sincronizada con `DEFAULT_COLORS` del backend), User-Agent textarea, botón "Use default" para limpiar. Hint con disclaimer de ADR 0010 (no engaña, dice que `navigator.userAgent` se override en Bloque 1.5). Default identity tiene UA disabled con mensaje claro.
- **Trigger**: context menu del sidebar agrega "Edit identity…" entre Rename y Delete.
- **Doc módulo**: `docs/modules/ui-identity-editor.md` nuevo + `identity-manager.md` actualizado.

### 3. Free-tier cap placeholder (3 identities)

- `MAX_IDENTITIES_FREE = 3` en `identity-manager.js` (Default + 2 custom).
- `process.env.OZ_TIER === 'paid'` bypassa el cap (uso dev / internal builds; reemplazado por entitlement check de `auth-client.js` cuando llegue Etapa 5).
- `IdentityCapError` exportado. `create()` lanza si supera. IPC handler captura y devuelve `{ __error: { code, message, current, max } }` al renderer (mejor UX que throw → generic error popup).
- Sidebar `handleNewIdentity` muestra `alert(message)` cuando recibe `__error`.

### 4. Bug "tab duplicada al arranque" — diagnóstico observable

- No se encontró duplicación reproducible por inspección estática (sidebar y tabstrip ya dedupean por id correctamente).
- **Logging fino agregado** en cada punto donde nace una tab: `tabs.create()` ahora acepta `source` opcional y loggea INFO con `tabId, identityId, url, source, eager, total, windowId`. Cada caller pasa `source` identificable:
  - `window-manager._createInitialTab`
  - `chromeExtensionsAPI.createTab` (extensions API)
  - `windowOpen[disposition]`
  - `contextMenu.openLink`
  - `ipc.openInIdentity`
  - `ipc.bulkCreateLazy`
- Si el bug aparece de nuevo, los logs apuntan al culpable inmediatamente — instrucciones en `docs/guides/manual-test-1.2.md` paso A.
- En sidebar.js, `handleTabEvent` ahora distingue eventos `created` (push) vs `updated`/`materialized` con tab desconocido (push + log debug "tab event without prior create cached") — útil para detectar inconsistencias futuras.

### 5. Smoke test manual reproducible

- `docs/guides/manual-test-1.2.md` con checklist de 7 secciones (arranque, Default visible, CRUD identity, lazy tab materializa, custom UA, free-tier cap, persistencia). Tiempo estimado 5 min.
- En Bloque 1.10 polish se convierte en Playwright-electron / Spectron.

### 6. Smoke test visual ejecutado y 2 bugs encontrados + arreglados

Durante la ejecución del smoke test visual (Claude controlando la app via computer-use), se encontraron 2 bugs que el code review estático no detectó:

**Bug A: `Identifier 'safe' has already been declared` — sidebar vacío al arrancar.**

- Síntoma: el sidebar mostraba botón "+ New Identity" y header "IDENTITIES" pero NO renderizaba las identities ni tabs. Console del DevTools tenía 4 SyntaxErrors idénticos.
- Causa: `oz-utils.js` declaraba `function safe()` al top-level (entra en global object), y luego `tabstrip.js`, `sidebar.js`, `identity-editor.js`, `webui.js` cada uno hacía `const { safe } = window.OZ.utils` al top-level. Hay regla en JS: NO puedes declarar `const X` en global lexical scope si `X` ya existe en el global object via `function`. Y como classic scripts comparten el global lexical scope entre archivos del mismo documento, los `const safe` también chocaban entre ellos.
- Bug pre-existente desde el fork de electron-browser-shell. Solo se manifestó visiblemente cuando agregamos `identity-editor.js` (cuarto archivo declarando lo mismo) — antes con 3 archivos también ocurría pero el booteo de webui.js fallaba más silenciosamente.
- Fix: IIFE wrap en los 5 archivos UI (`oz-utils.js`, `tabstrip.js`, `sidebar.js`, `identity-editor.js`, `webui.js`). Cada `const safe` queda local al IIFE, no choca con nadie. Comentario en `oz-utils.js` explica el porqué.

**Bug B: Modal cubierto por WebContentsView nativa.**

- Síntoma: al abrir el modal "Edit identity…", el sidebar/topbar se atenuaban (backdrop visible) pero el modal era invisible — el área del content (~1060×620 px) lo cubría por completo.
- Causa: `WebContentsView` es una primitive nativa de Electron que se renderiza ENCIMA de cualquier DOM HTML del browser chrome. No hay z-index HTML que la pueda tapar.
- Fix: nuevo IPC `oz:ui:setContentVisible(visible)` registrado en `ipc-handlers.js → registerUiHandlers`. Hace `tab.view.setVisible(visible)` sobre el tab activo del window focused. `identity-editor.js` lo invoca con `false` en `open()` y `true` en `close()`. Documentado como pattern en **ADR 0011** para reutilizar en futuras overlays (workspace switcher, settings, command palette, etc.).

Ambos bugs caen en categoría "arquitectónicos heredados/no obvios". Sin smoke test visual nunca habrían aparecido — los unit tests con mock-Electron (28/28 passed) no podían detectar ni el classic-scripts-share-lexical-scope ni el WebContentsView-overlay. Lección: smoke test visual ejecutado por agente sigue siendo necesario incluso con cobertura unitaria sólida.

---

## Lo que ya estaba (sesiones previas)

- ✅ IdentityManager con persistencia atómica en `identities.json`.
- ✅ Default identity garantizada al `_load()` (auto-creada si falta).
- ✅ Sessions per-identity cacheadas en `Map`. Default → defaultSession (ADR 0003).
- ✅ Lazy tabs: stub JS hasta primer click; materialize idempotente; pendingUrl queue (ADR 0002).
- ✅ TabbedBrowserWindow wirea Tabs events → ChromeExtensions API + IPC notifications a sidebar.
- ✅ Sidebar con CRUD inline (rename con dblclick, delete via context menu, `+` hover en row).
- ✅ Top tabstrip con stripe de color por identity.
- ✅ Logger con rotación + file path en `~/Library/Logs/OZ Browser/`.
- ✅ Error popup con email a Jose.
- ✅ IPC handlers consolidados en `ipc-handlers.js` por dominio.
- ✅ Refactor modular respetando regla 500 LOC (ADR 0005).
- ✅ Estructura docs completa (DOCUMENTATION-RULES, ADRs, modules/, features/, history/).

---

## Pendientes que se reasignan a otros bloques

- **Drag-and-drop reorder de identities y tabs** → Etapa 2 (UX competitiva). No bloquea el caso de uso primario.
- **Tag system para identities filterables** → Bloque 1.7 (Settings UI) o Bloque 1.5 cuando haya 50+ identities.
- **Reset Identity** (regenera fingerprint, mantiene cookies opt) → Bloque 1.5 cuando llegue FingerprintEngine completo.

---

## Costos del bloque

- **Tiempo total Bloque 1.2:** ~6 horas (3 sesiones previas + esta sesión de cierre).
- **Apple Developer:** $0 (todavía no aplica).
- **GitHub:** $0 (free tier privado).
- **Total acumulado del proyecto:** **$0** (Etapa 0 + 1.1 + 1.2).

---

## Comandos para retomar

```bash
cd "/Users/joserodrigocoronel/Documents/Claude/Projects/Ghost Browser Clone/oz-browser"

# Dev mode normal (free tier cap activo)
NODE_ENV= npm start

# Dev mode con DevTools + bypass de cap free
SHELL_DEBUG=1 OZ_TIER=paid NODE_ENV= npm start

# Smoke test del Bloque 1.2
open docs/guides/manual-test-1.2.md
```

---

## Próximo paso concreto

**Arrancar Bloque 1.3 — Workspace Manager** (estimado 5-6 sesiones, ~10 horas):

- Modelo `Workspace { id, name, color?, isDefault, isArchived, isFrozen, tabs[], identities[] }`.
- CRUD: create / rename / duplicate / archive / restore / delete.
- "General Browsing" workspace default no eliminable.
- Switch de workspace cierra tabs anteriores y abre las nuevas (lazy).
- Multi-window = multi-workspace (1 ventana = 1 workspace) — diferenciador vs Ghost.
- Persistencia en `workspaces.json`.
- Quick Tabs 4 modos (load all / one-by-one / on-click / on-click+confirm).

Después de 1.3 viene **Bloque 1.5 — Account Vault (CORE)** que es el corazón del producto.

---

## Referencias

- ADRs creados en este bloque: [0010](../architecture/0010-per-identity-user-agent.md), [0011](../architecture/0011-modals-hide-content-view.md).
- ADRs aplicables: 0002 (lazy tabs), 0003 (Default = defaultSession), 0005 (500 LOC), 0009 (logging).
- Módulos tocados / creados: `identity-manager.js`, `ipc-handlers.js` (+ `registerUiHandlers`), `tabs.js`, `window-manager.js`, `extensions-setup.js`, `preload.js` (+ `window.oz.ui`), `ui/oz-utils.js`, `ui/tabstrip.js`, `ui/sidebar.js`, `ui/identity-editor.js` (nuevo), `ui/webui.js`, `ui/webui.html`, `.gitignore` (fix preload.js path bug).
- Smoke test: [`../guides/manual-test-1.2.md`](../guides/manual-test-1.2.md) + `tests/identity-manager.smoketest.js` (28/28 passed con mock-Electron).
