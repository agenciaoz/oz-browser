# 0038 — Publishing Studio (módulo de publicaciones multi-red)

- Estado: Aceptado
- Fecha: 2026-06-19
- Etapa: v2 Etapa 1 (de 7). Plan: `docs/PLAN-PUBLISHING-DASHBOARD.md`.

## Contexto

OZ ya puede ejecutar acciones (`ig_post`, `x_post`, …) sobre N identities vía
el Bulk Runner, expuesto por MCP (`oz_bulk_*`) y por IPC del WebUI
(`oz:bulk:*`). Faltaba una superficie de **publicación** pensada para el caso
de agencia: componer un post y publicarlo desde muchas cuentas aisladas, sin un
programa externo. La Etapa 1 entrega el núcleo (publicar ahora en IG/X).

## Decisiones

### ADR-A — Capa "Publicación" sobre el Bulk Runner (no motor nuevo)

La Etapa 1 NO introduce un store ni un motor de publicaciones. Una publicación
es un **bulk run** disparado vía `oz:bulk:run` con `{ actionId, identityIds,
params }`. El Studio es un tercer front-end del mismo motor (junto al MCP y al
modal Bulk Runner). Consecuencias:

- Cero backend nuevo en Etapa 1: se reusa el runner, sus delays anti-detect,
  el rate-limit, el historial y los eventos `oz:bulk:progress/completed`.
- Un store propio (`publishing-store.js`) recién se justifica en Etapa 4-5
  (plantillas, drafts, plan de contenido). Se decidirá en su propio ADR.

### ADR-B — Composer schema-driven

El formulario se genera a partir del `paramsSchema` de cada acción publicable,
leído con `oz:bulk:listActions`. `publishing-helpers.fieldsFromSchema()` deriva
los campos (control, required, maxLength) sin código por-acción. Consecuencia:
cuando Etapa 6 registre `fb_post` / `tiktok_post`, **aparecen solos** en el
composer; sólo hay que sumarlos al allow-list `PUBLISHABLE_ACTION_IDS` y al
mapa de plataformas en `publishing-helpers.js`.

### ADR-C — Lógica pura separada del DOM

Toda la lógica testeable (filtrar acciones, derivar campos, validar, gating de
health, armar el spec, preflight) vive en `publishing-helpers.js`, DOM-free,
con export dual (window + CommonJS) igual que `bulk-history-helpers.js`. Los
módulos DOM (`publishing-composer.js`, `publishing-targets.js`,
`publishing-studio.js`) sólo orquestan. Esto deja la variación de contenido de
Etapa 4 (spintax, rotación) como pre-procesamiento puro, sin tocar el motor.

### Gating de health

Antes de publicar, las identities en estado `red` (anti-detect) se **excluyen**
y las `yellow` se **avisan**, vía `partitionTargetsByHealth()` sobre
`oz:health:list`. El resumen de confirmación reporta bloqueadas/avisadas.

### Apertura como pestaña dedicada

`publishing-studio.html` se abre como tab full-screen con el mismo patrón que
`proxy-dashboard.html`: IPC `oz:publishing:openTab` →
`tabs.create({ url: chrome-extension://<webuiId>/publishing-studio.html })`.
Hereda `window.oz` (bulk, identities, workspaces, health) y `window.OZ.ui` del
preload bundleado, como cualquier página de la extensión WebUI.

## Entry points

- Footer toolbar del WebUI: botón 📣 (`#oz-publish-button`).
- Command Palette: comando `action:open-publishing-studio`.
- Menú **Go → Publishing Studio…** (acelerador `Alt+Shift+P`).

Los tres terminan en `window.oz.publishing.openTab()`. El menú/atajo viajan por
`oz:publishing:open` al chrome enfocado (`webui.js` lo escucha).

## Archivos

Nuevos: `browser/ui/publishing-studio.html`, `publishing-helpers.js`,
`publishing-composer.js`, `publishing-targets.js`, `publishing-studio.js`;
`tests/publishing-helpers.smoketest.js`.
Tocados: `manifest.json` (2.0.35→2.0.36), `preload.js`, `ipc-handlers-extra.js`,
`command-palette.js` (main+renderer), `menu.js`, `webui.js`, `webui.html`,
`locales/en.json` + `es.json`.

## Etapa 2-A — Cola / historial embebido (manifest 2.0.37)

Panel `pub-history` dentro del Studio que lista los runs de publicación
(`oz:bulk:list` filtrado a `ig_post`/`x_post`), con drill-down por identity y
**retry de fallidos**. Reusa los helpers puros ya testeados de
`bulk-history-helpers.js` (`getFailedIdentityIds`, `buildRetrySpec`) más nuevos
helpers en `publishing-helpers.js` (`isPublishRun`, `filterPublishRuns`,
`runPlatformLabel`, `countItems`). Cero backend nuevo: misma decisión ADR-A. El
panel se refresca al terminar un run (`oz:bulk:completed`) y tras un retry.

Pendiente de Etapa 2 (slice B, toca el motor, requiere smoke en vivo): **dry-run**
(validar login/media/selectores sin publicar) y **prueba-de-posteo** (screenshot
por identity vía `oz_page_screenshot`).

## Etapa 3 — Programación recurrente + drip (manifest 2.0.38)

Control "Cuándo" en el composer: **Publicar ahora** vs **Programar** con los
schedules recurrentes que el motor ya soporta (`daily` / `weekly` /
`every-minutes`), creando un scheduled action `bulk` vía
`oz:scheduledActions.create` (`params.spec = { actionId, identityIds, params,
options }`). Cero backend nuevo. **Drip:** un espaciado opcional (segundos entre
cuentas) que setea `options.{minDelayMs,maxDelayMs}` del run (default del motor
30-90s). Panel **Publicaciones programadas** que lista/pausa/elimina (reusa
`scheduledActions.list/setEnabled/remove`). Helpers nuevos puros y testeados:
`dripOptions`, `buildSchedule`, `buildScheduleInput`, `isPublishScheduledAction`,
`scheduledPlatformLabel`.

**Limitación del motor (Etapa 3-B):** el scheduler cron-lite NO tiene tipo
"una sola vez en fecha X" (`once`). Un calendario de fecha puntual requiere
agregar ese tipo a `scheduled-actions.js` (`computeNextRunAt` one-shot +
auto-disable post-fire) — toca motor, va con smoke test.

## Etapa 4-A — Variación de contenido + plantillas + media library (manifest 2.0.39)

El diferencial anti-huella. `publishing-variation.js` (puro, testeado): spintax
`{a|b}`, interpolación `{{identity}}`, subset random de hashtags (K de N),
rotación de media, todo **determinístico por identity** (RNG sembrado del
`identityId`). `publishing-store.js` (localStorage, testeado): plantillas de
caption, grupos de hashtags y media library. UI `publishing-variation-ui.js`:
campo de hashtags + grupos, plantillas guardar/cargar, y **preview por-identity**
que muestra cómo variaría el caption en cada cuenta.

**Límite del motor (Etapa 4-B):** el bulk runner aplica los MISMOS params a
todas las identities, así que la variación hoy es **preview + autoría**; la
**ejecución** per-identity (publicar contenido distinto por cuenta) requiere
soporte de params por-identity en el runner (`paramsByIdentity` / resolver) +
que `ig_post`/`x_post` usen los params resueltos. Toca motor/acciones → va con
smoke. Las plantillas, grupos y media library SÍ funcionan hoy (autoría).

## Migración MCP-first (ADR-D, alpha.78-81)

**Contexto.** E1-E4A nacieron renderer-first: el estado (plan de contenido,
plantillas, grupos de hashtags, media library) vivía en `localStorage` del
WebUI. Eso rompe la directiva de Jose: _"el MCP debe poder hacer todo, que sea
súper robusto siempre"_. Un agente no puede tocar `localStorage` del renderer.

**Decisión.** Toda la capa de datos del Publishing Studio vive en el MAIN
process (JSON atómico en `userData`), con tools MCP `oz.publishing.*` Y la UI
leyendo de la misma fuente. Una sola fuente de verdad.

- **Plan de contenido** → `publishing-plan-store.js` (publications + workflow
  draft→review→approved→published + `addMany` para import). Lógica pura en
  `ui/publishing-plan.js` (matrix↔plan, state machine, export, `buildBulkSpec`).
  Tools: `oz.publishing.import/list/get/status/update/remove/export`.
- **Publicar** → `oz.publishing.publish(id)` mapea plataforma→actionId y dispara
  el post real vía el Bulk Runner; marca `published` al despachar.
- **Programar** → `oz.publishing.sched(id, schedule)` crea una Scheduled Action
  tipo `bulk` (reusa el scheduler de F-3, cero motor nuevo); `oz.publishing.unsched`
  la cancela. La publicación guarda `scheduledActionId`.
- **Autoría** → `publishing-library-store.js` (kinds templates|hashtags|media);
  tools `oz.publishing.libList/libSave/libDel`.

**Patrón de tools cortos.** `oz.publishing.<verbo>` debe quedar ≤21 chars
(guard `mcp-server.smoketest`). Por eso `sched`/`unsched`/`libDel` en vez de
`schedule`/`unschedule`/`libDelete`. El aggregator `mcp-tools-extra.js`
(projects + scrape + publishing) mantiene `mcp-tools.js` bajo 500 LOC.

**Pendiente de la migración.** El panel WebUI E5 (import Excel + tablero de
aprobación) aún debe pasar a leer de estos stores en vez de `localStorage`;
schedule `once`/fecha puntual (E3-B); plataformas `fb_post`/`tiktok_post`/Reels.

## Alternativas descartadas

- **Modal en vez de tab:** un composer + selección de identities + progreso
  necesita espacio; la tab dedicada (precedente proxy-dashboard) es mejor.
- **Motor de publicaciones nuevo:** redundante con el Bulk Runner; se reusa.

## Riesgos

- Selectores IG/X frágiles (heredado del motor) — se mitiga en Etapa 2 con
  dry-run + screenshot de prueba-de-posteo.
- `imagePath` requiere ruta absoluta; en página Electron se obtiene de
  `input[type=file].files[0].path`. Etapa 4 añade media library.
