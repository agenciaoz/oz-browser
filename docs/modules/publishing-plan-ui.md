# publishing-plan-ui

Pantalla DOM de la etapa **E5** del Publishing Studio: import de un plan de contenido desde Excel + tablero de aprobación (draft → review → approved → published). Introducida en v2.0.0-alpha.104. Es la UI que faltaba: el backend (`publishing-plan-handlers.js`), el store, la lógica pura (`ui/publishing-plan.js`), el IPC y los tools MCP ya existían desde antes.

## Qué hace

`window.OZ.PublishingPlanUI` — clase con `mount()` + `load()`:

- **Import**: botón "📥 Importar Excel" → `window.oz.publishing.importPlanFile()` (abre file dialog en main, lee el .xlsx, crea las publicaciones en estado `draft`). Muestra `{added, errors}`.
- **Tablero**: 4 columnas por estado (`PublishingPlan.STATUSES`). Cada tarjeta muestra plataforma, caption, fecha, #identities, #media, y botones de transición según el estado:
  - draft → **Enviar a revisión** (`submit`)
  - review → **Aprobar** (`approve`) / **Rechazar** (`reject`)
  - approved → **Publicar** (`publish`, corre el bulk runner) / **Volver a borrador** (`edit`)
  - cualquier no-publicado → **✕** borrar.

Se monta desde `publishing-studio.js` en el contenedor `#pub-plan` (sección "Content plan" del `publishing-studio.html`). `onChange` refresca la lista de programadas + historial.

## Dependencias (todo preexistente)

- Preload `window.oz.publishing`: `importPlanFile`, `listPlan`, `setPlanStatus`, `publishPlan`, `removePlan` (`preload-publishing-api.js`).
- Lógica pura `window.OZ.PublishingPlan` (`ui/publishing-plan.js`) — solo `STATUSES` para el orden de columnas.
- Handlers main `publishing-plan-handlers.js`: `importFile` (alpha.104, lee `.xlsx` vía `excel-io.readSheetMatrix`), `import`, `list`, `status`, `publish`, `remove`.

## Import de archivos

`excel-io.readSheetMatrix(filePath)` (nuevo en alpha.104) lee la primera hoja de un `.xlsx` a matriz array-de-arrays (fila 0 = headers). `publishing-plan-handlers.importFile` la parsea con la lógica pura y guarda drafts. IPC `oz:publishing:importFile` abre el file dialog si no se pasa path. El tool MCP `oz.publishing.import` sigue tomando `matrix`/`rows` (un agente lee el Excel por su cuenta; el nombre `importFile` excedía el límite de 21 chars de MCP).

## Tests

- `tests/publishing-plan-importfile.smoketest.js` — round-trip real `.xlsx` → `readSheetMatrix` → parse → drafts (8 checks).
- `tests/publishing-plan.smoketest.js` — lógica pura + store (sin cambios).
- La UI DOM requiere smoke visual (no corre en CI).

Ver: `docs/modules/publishing-plan.md`, `publishing-plan-handlers.md`, ADR 0038.
