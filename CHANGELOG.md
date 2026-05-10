# OZ Browser — Changelog

> Bitácora ejecutiva. Una línea (max ~150 chars) por cierre de bloque. Para detalle completo de cada bloque, ver `docs/history/`.

Formato: [`YYYY-MM-DD`] [`bloque`] resumen.

---

## Sin liberar (próximo)

- ⏳ `1.4-WS` — Workspace Manager (sub-fases 1.4d drag-drop + 1.4e MCP tools + cierre).

## Histórico

- [`2026-05-09`] [`1.4c`] Workspace switcher UI: pills horizontales arriba del sidebar, CRUD inline (rename via dblclick o ctx menu, duplicate, archive/restore con toggle "Show archived (N)" oculto si vacío, freeze/unfreeze con 🔒 visual + name muted, delete con confirm). `+ New Workspace` inline editor (mismo patrón que `+ New Identity`). Lock UX: alert "already open in another window" cuando setActive rechaza. `preload.js` expone `window.oz.workspaces.*` (15 métodos + onChanged + onActiveChanged). `browser/ui/workspace-switcher.js` IIFE con `OZ.WorkspaceSwitcher` class. CSS pills + ctx-menu reusado. Boot wireado en `webui.js`. 177/177 tests verde, lint clean.
- [`2026-05-09`] [`1.4b`] Workspace switch logic + ventana 1-1 lock exclusivo: `browser/window-workspace.js` (módulo puro testeable, ~210 LOC) con `switchWorkspace` (snapshot → destroy WebContentsViews → hydrate lazy desde tabSpecs → select activeTabId), `hydrateWorkspace`, `snapshotWindowToWorkspace` (sync flush para no perder en crash), `releaseOnDestroy`, `findWindowOwning`. `TabbedBrowserWindow` extendido con `workspaceId` + `switchToWorkspace()` + snapshot+release on `close`/`destroy`. `WorkspaceManager` activado con throttled save 2s. `Tab.toSpec()` + `Tabs.toSpecs()` + `tab.pinned` propagado. 36/36 tests con FakeTabs mock. **177/177 totales verde.** Cero deps nuevas.
- [`2026-05-09`] [`1.4a`] Workspace Manager backend: `workspace-manager.js` (CRUD + persistencia + freeze/archive/duplicate + tabSpecs management + throttled save), `workspace-handlers.js` (handler map IPC↔MCP), 15 IPC channels `oz:workspaces:*`, smoke test 56/56. Default WS auto-creado ("General Browsing"). Cero deps nuevas. (ADR 0015 — workspace model + ventana 1-1 lock exclusivo + lazy tabSpecs).
- [`2026-05-09`] [`1.3.5-CI + 1.3.6-DX`] GitHub Actions (lint + check:loc + smoke tests en macos-latest, cron nightly, status badge). ESLint v9 flat config + Prettier + Husky pre-commit + lint-staged. Format pass sobre 77 archivos. Bug fixes menores (no-prototype-builtins, unused imports, catch \_e). 85/85 tests verde post-format. Cero deps de prod nuevas. (ADRs 0013, 0014).
- [`2026-05-09`] [`1.3-MCP`] OZ MCP server (HTTP localhost :9223 + SSE + stdio bridge). 13 tools v1 (identities CRUD + tabs + system.getMetrics + events.subscribe). Hand-rolled JSON-RPC, cero deps nuevas. Refactor identity-handlers/tab-handlers como maps puros consumidos por IPC y MCP. 57/57 smoke + contract test IPC↔MCP. Pasada estructural completa (PLAN v5, scripts/check-loc.js, BENCHMARKS, CHANGELOG, CHECKLIST). ADR 0008 actualizado con audit de deps + Etapa 3 corregida (Forge → update-electron-app). (ADR 0012).
- [`2026-05-09`] [`1.2`] Identity Manager + lazy tabs + sidebar (n) count + custom UA per-identity (ADR 0010) + free-tier cap 3 + tab-create logging + smoke test 28/28 + bugs detectados en visual test (IIFE wrap por classic scripts compartiendo lexical scope, modal cubierto por WebContentsView nativa → ADR 0011).
- [`2026-05-09`] [`1.1`] Foundation: fork de electron-browser-shell, repo privado en GitHub, tabs+omnibox+back/forward base, layout sidebar+content.
- [`2026-05-09`] [`Etapa 0`] Validación técnica spike: Electron + partition isolation + proxy auth con Oxylabs HTTPS confirmado funcional.

---

## Reglas para mantener este archivo

- **Cierre de bloque = un commit con el cambio aquí.** Sin esa línea el bloque no está cerrado (regla del CHECKLIST-CIERRE-BLOQUE).
- La línea va arriba del histórico (más reciente primero).
- Si un bloque introduce una breaking change pública (afecta CLI args, env vars, config files, MCP tools shapes), **prefijar con `[BREAKING]`**.
- Si un bloque introduce un ADR nuevo, mencionarlo entre paréntesis (e.g., "ADR 0012").
- No copiar el detalle del history acá. Esto es 1-liner; el doc de history es el cierre completo.

## Convenciones de etiquetas

- `1.2`, `1.3-MCP`, `1.4-WS`, etc. — Bloque del Plan Maestro.
- `Etapa N` — para etapas (Etapa 0 spike, Etapa 3 distribución, etc.).
- `chore` — limpieza interna sin cambio de feature (e.g., format pass del 1.3.6-DX).
- `[BREAKING]` — incompatible con versiones anteriores.
