# Bloque Fase 1 — rename Proyectos + stub move-to-new-window (alpha.103)

**Status:** ✅ Código listo 2026-07-15 — Fase 1 del `docs/PLAN-CIERRE-PENDIENTES.md`
**Version:** 2.0.0-alpha.103
**Deps nuevas:** 0
**Tests nuevos:** 0 (wiring UI→backend existente; requiere smoke visual)

## Origen

Auditoría 2026-07-15 (validada en código): dos huecos chicos que incumplían "feature completa" — Proyectos sin botón renombrar en UI, y el command palette con `move-to-new-window` como stub silencioso.

## Qué se entregó

### Rename en Proyectos (sidebar)

- `browser/ui/sidebar-projects.js`: método `_rename(id, currentName)` (prompt con `defaultValue`) + botón ✎ "Renombrar" en cada fila. Llama `window.oz.projects.rename` (ya existía end-to-end: preload → IPC `oz:projects:rename` → `project-handlers.rename` → `project-store.rename`).
- CSS `.oz-projects-rename` en `webui.html` (comparte estilo con `.oz-projects-del`).
- manifest WebUI bump 2.0.60 → 2.0.61 (edits en `browser/ui/`).

### move-to-new-window: stub → acción real

- `preload.js`: nuevo bridge `tabs.moveToNewWindow(tabId)` → `oz:tabs:moveToNewWindow` (el IPC y el handler `tab-context-handlers.moveToNewWindow` ya existían; solo faltaba exponerlo al renderer).
- `browser/ui/command-palette.js`: el executor `move-to-new-window` ahora resuelve el tab (`resolveTabId`) y llama la acción real, en vez de loggear "es un stub".

### Refactor incidental (ADR 0005)

Exponer el bridge dejó `preload.js` en 501 LOC (límite 500). Extraído el objeto `tabs` completo a `browser/preload-tabs-api.js` (`buildTabsApi(ipcRenderer)`, patrón de `preload-projects-api.js`). `preload.js` vuelve bajo budget. Doc hermano `docs/modules/preload-tabs-api.md`.

## Estado

- `check:loc` verde (max 500 en ipc-handlers-extra.js). Lint clean. Tests de command-palette (39) + handlers (11) + projects (7+4) verdes.
- **Pendiente smoke visual (Jose):** botón ✎ renombra un proyecto; ⌥S / command palette "Move to new window" mueve el tab a ventana nueva.

## Próximo

Fase 2 — Publishing E5 (import Excel + aprobación): cablear `publishing-plan.js` (huérfano) al HTML del studio.
