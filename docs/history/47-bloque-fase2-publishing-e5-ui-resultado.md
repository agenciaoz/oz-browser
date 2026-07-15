# Bloque Fase 2 — Publishing E5 UI: import Excel + tablero de aprobación (alpha.104)

**Status:** ✅ Código listo 2026-07-15 — Fase 2 del `docs/PLAN-CIERRE-PENDIENTES.md`
**Version:** 2.0.0-alpha.104
**Deps nuevas:** 0 (exceljs ya estaba)
**Tests nuevos:** +8 (`publishing-plan-importfile.smoketest.js`)

## Origen

Auditoría 2026-07-15: E5 (import de plan + workflow de aprobación) tenía backend + store + lógica pura + IPC + MCP completos, pero **sin pantalla DOM** — la UI nunca se construyó. Era el hueco de mayor impacto operativo y el más barato de cerrar.

## Qué se entregó

### UI nueva

- `browser/ui/publishing-plan-ui.js`: `window.OZ.PublishingPlanUI` — botón "📥 Importar Excel" + tablero de 4 columnas (draft/review/approved/published) con botones de transición por tarjeta (submit/approve/reject/publish/edit/borrar). Reusa `window.oz.publishing.*` (preload) y `window.OZ.PublishingPlan` (lógica pura). Doc `docs/modules/publishing-plan-ui.md`.
- `publishing-studio.html`: sección "Content plan" (`#pub-plan`) + CSS del board + carga de `publishing-plan.js` (antes huérfano) y `publishing-plan-ui.js`. manifest 2.0.61 → 2.0.62.
- `publishing-studio.js`: instancia y monta `PublishingPlanUI`; `onChange` refresca programadas + historial.

### Import desde archivo

- `browser/excel-io.js`: `readSheetMatrix(filePath)` — lee la primera hoja de un `.xlsx` a matriz array-de-arrays (genérico, reusa exceljs).
- `browser/publishing-plan-handlers.js`: `importFile(filePath)` async (lee matriz → parse pura → `store.addMany`). `import({matrix,rows})` sigue síncrono (no rompe callers/MCP).
- IPC `oz:publishing:importFile` (`publishing-plan-ipc-setup.js`): abre file dialog si no hay path.
- Preload `importPlanFile` (`preload-publishing-api.js`).

## Decisiones

- **MCP sin `importFile`**: `oz_publishing_importFile` = 24 chars, excede el límite de 21 del guard MCP. El tool `oz.publishing.import` sigue tomando `matrix`/`rows` (un agente lee el Excel por su cuenta — más idiomático MCP). El import-desde-archivo es feature de UI.
- `import` se mantuvo **síncrono** para no romper `publishing-plan.smoketest.js` ni los callers MCP; el path async vive solo en `importFile`.

## Estado

- Tests: publishing-plan (17), publishing-mcp-tools (6), mcp-server naming (155), importfile (8) — todos verdes. `check:loc` verde. Lint clean.
- **Pendiente smoke visual (Jose):** abrir Publishing Studio → sección "Content plan" → Importar Excel (columnas date/platform/caption/media/identities) → mover tarjetas por el workflow → Publicar.

## Próximo

Fase 3 — Publishing E2+E7: cablear UI de dry-run + analytics + screenshot/evidencia de posteo.
