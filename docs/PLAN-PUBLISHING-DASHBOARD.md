# PLAN — Publishing Studio (módulo de publicaciones multi-red)

> Estado: **EN EJECUCIÓN.** Fecha: 2026-06-19. App base: `v2.0.0-alpha.56`.
> Reemplaza el borrador de 5 sub-bloques por un plan en **7 etapas**.
>
> **Progreso al alpha.85 (2026-06-20):** E1+E5 MCP-first (plan/publish/schedule/
> library). **E4 variación** → MCP (alpha.82 `oz.publishing.preview/resolve/variety`).
> **E2 dry-run** → MCP (alpha.83 `oz.publishing.dryRun`; falta prueba-de-posteo
> en vivo = screenshot, smoke Electron). **E6** arrancada: `fb_post` end-to-end
> (alpha.84); faltan tiktok/IG-video/Reels + media en fb. **E7 analytics** → MCP
> (alpha.85 `oz.publishing.stats`). Pendiente migrar a main: composer/targets/
> history del renderer. Smokes en vivo de todo = Mac de Jose.

## 0. Visión

No es un "botón de publicar". Es un **estudio de publicaciones de agencia**
nativo en OZ Browser, abierto como pestaña dedicada, que aprovecha lo único que
OZ hace mejor que nadie: **publicar desde N identities aisladas** (cada una con
su proxy, fingerprint y sesión). El diferencial no es postear — es postear desde
muchas cuentas **sin dejar huella**, con control de agencia (variación de
contenido, plantillas, calendario, aprobación, prueba-de-posteo).

Sin programa externo: el navegador es el host. Un cliente MCP externo (un "OZ
Media Engine") puede disparar lo mismo vía `oz_bulk_*` porque comparten motor.

## 1. Qué ya existe (verificado en código) y qué falta

### Se reusa (no se reimplementa)

| Capacidad                  | Dónde                                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| Motor de ejecución N ids   | `bulk-runner.js` — itera secuencial, delays anti-detect, cancelable   |
| Delays / stagger entre ids | `bulk-runner.js` — `[MIN,MAX]` randomizado, `options.delays` override |
| Rate-limit por acción/id   | `bulk-rate-limit.js` — `BulkRateLimit`, caps con overrides            |
| Disparar / estados         | IPC `oz:bulk:create/run/start/cancel` + `oz:bulk:progress/completed`  |
| Listar acciones + schema   | IPC `oz:bulk:listActions` (composer schema-driven)                    |
| Historial / reintento      | `bulk-history*.js`                                                    |
| Programar a futuro         | `scheduled-action-bulk.js` (`createBulkHandler`), tick 60s            |
| Health de cuentas          | `oz:health:get/list` + `oz:health:changed` (gating)                   |
| Vault de credenciales      | `oz:accounts:*` (auto-login en `needs_login`)                         |
| Excel I/O                  | `oz_excel_*` (import de plan de contenido)                            |
| Screenshot de página       | `oz_page_screenshot` (prueba-de-posteo)                               |
| Identities / workspaces    | `oz:ids:*`, `oz:ws:*`                                                 |

### Gaps reales (lo que hay que construir)

- **Actions de publicar:** solo `ig_post` (imagen+caption) y `x_post` (texto).
  **No existen** `fb_post`, `tiktok_post`, ni Threads/LinkedIn/YouTube.
- **Media:** `ig_post` es **solo imagen** (CDP `setFile`). Sin video/Reels/Stories.
- **Variación de contenido** entre identities: no existe. (Diferencial clave.)
- **Capa "Publicación"**: hoy todo es "bulk run". Falta el concepto de post con
  plantilla, draft, estado de aprobación y plan de contenido persistido.

## 2. Decisiones de arquitectura

- **ADR-A — Capa Publicación sobre Bulk Runner.** Etapas 1-3 tratan una
  publicación como un bulk run + metadata liviana (no store nuevo). Etapas 4-5
  (plantillas, drafts, plan de contenido) sí necesitan un store propio
  persistido (`publishing-store.js`), con su ADR.
- **ADR-B — Composer schema-driven.** El formulario se genera leyendo el
  `paramsSchema` de cada action vía `oz:bulk:listActions`. Consecuencia: cada
  action nueva (`fb_post`, etc.) **aparece sola** en el composer sin tocar UI.
- **ADR-C — Variación de contenido como capa de pre-procesamiento.** El motor
  recibe params **ya resueltos por identity**; la variación (spintax, rotación
  de media/hashtags) ocurre en el front-end/preprocesador antes de
  `oz:bulk:create`, no dentro del runner. Mantiene el motor simple.
- **Pestaña dedicada:** mismo patrón que `proxy-dashboard.html`
  (`tabs.create({ url: chrome-extension://…/publishing-studio.html })`).

## 3. Las 7 etapas

Cada etapa es **shippable** y aporta valor sola. Orden = valor primero, frágil
al final. App version sube un alpha por release.

### Etapa 1 — Núcleo: publicar ahora (IG/X) con rieles de seguridad

La espina dorsal. Pestaña + composer + ejecutar.

- `publishing-studio.html` como tab full-screen (patrón proxy-dashboard).
- Composer **schema-driven** (IG: imagen+caption; X: texto).
- Selector de identities (multi) filtrable por workspace.
- **Health gating:** saltear/avisar identities en rojo (`oz:health:list`).
- **Resumen de seguridad** antes de publicar ("vas a postear desde N cuentas")
  con `window.OZ.ui.confirm`.
- **Publicar ahora** → `oz:bulk:create` + `oz:bulk:run`; progreso en vivo.
- Entry points: sidebar + Command Palette + View menu.
- ADR-A/B, i18n EN/ES, tests de helpers puros, manifest bump, app `alpha.57`.
- **Riesgo: bajo.** Cero motor nuevo.
- **LOC:** se parte — `publishing-studio.js` (shell/wire) +
  `publishing-composer.js` (form) + `publishing-targets.js` (selección de ids).

### Etapa 2 — Confianza: cola, historial, dry-run y prueba-de-posteo

Que se pueda confiar en lo que pasó.

- Cola + historial embebido (reusa `bulk-history*`), filtro red/identity/estado.
- Reintento de fallidos (reusa `bulk-history-actions`).
- **Dry-run / simular:** valida login + media + selectores **sin publicar**.
- **Prueba-de-posteo:** `oz_page_screenshot` al terminar cada identity, guardado
  como evidencia y visible en el detalle del run.
- **Riesgo: bajo-medio.** Reuso + un hook de screenshot.

### Etapa 3 — Tiempo: programación, calendario y drip

- Vista calendario + **Publicar más tarde** (resolución 60s del scheduler).
- Wire a `scheduled-action-bulk.js` / `oz_sched_*`; lista con cancelar/editar.
- **Drip / escalonado:** repartir N identities en una ventana (jitter) — vía
  `options.delays` del runner (publicar-ahora-espaciado) o múltiples jobs
  programados a horas escalonadas.
- Presets de horario ("mejores horas").
- **Riesgo: medio-bajo.** Backend de scheduling ya existe; el grueso es UI.

### Etapa 4 — Diferencial de agencia: variación de contenido + plantillas + media library

La etapa que lo hace "del hp". Anti-huella para multi-cuenta.

- **Variación de contenido** por identity (ADR-C):
  - **Spintax** en captions: `{hola|hey|qué tal}` → texto distinto por cuenta.
  - **Rotación de media:** un set de imágenes/videos → cada identity toma una.
  - **Subsets de hashtags:** elige K de N hashtags por post, randomizado.
- **Overrides por plataforma / por identity** (copy distinto por red o persona).
- **Plantillas** guardadas con variables (`{{identity}}`, `{{fecha}}`) +
  **grupos de hashtags** + **hashtags en primer comentario** (best practice IG).
- **Media library:** carpeta gestionada de assets; el picker resuelve el path
  absoluto que `ig_post` necesita.
- Introduce `publishing-store.js` (store propio, ADR-A) + su ADR.
- **Riesgo: medio.** Lógica nueva pero pura/testeable; no toca selectores.

### Etapa 5 — Escala: import de plan de contenido (Excel) + drafts + aprobación

Para cargar un mes de contenido de una.

- **Import desde Excel** (`oz_excel_*`): filas = (fecha, red, caption, media,
  identities/workspace) → genera publicaciones programadas en lote.
- **Drafts:** componer → guardar borrador → editar después.
- **Workflow de aprobación:** draft → revisión → aprobado → publica (para VAs/
  equipo). Estados persistidos en `publishing-store`.
- Export del plan/resultados a Excel/CSV (reusa export existente).
- **Riesgo: medio.** Parsing + estados; reuso de Excel I/O.

### Etapa 6 — Cobertura de redes (motor, frágil)

Cada action es independiente y **auto-aparece** en el composer (ADR-B).

- `fb_post` — `bulk-actions-fb-post.js`, selectores FB + auto-login, `platform`.
- `tiktok_post` — upload de video; el más hostil/anti-bot. Reintentos robustos.
- **IG video / Reels** — extender `ig_post` o `ig_reel` nuevo (CDP file = video).
- (Opcional) Threads / LinkedIn / YouTube posts.
- **Riesgo: alto.** Selectores cambian seguido → apoyarse en dry-run (Etapa 2),
  screenshot (Etapa 2) y health (Etapa 1) para detectar roturas rápido.

### Etapa 7 — Pulido y operación

- Analytics básico de publicaciones (tasa de éxito por red/identity/horario).
- Notificaciones nativas al fin de cada lote (reusa `bulk-notifications`).
- Auditoría/logs por publicación con evidencia.
- **Riesgo: bajo.**

## 4. Dependencias entre etapas

```
E1 (núcleo IG/X) ─► E2 (confianza) ─► E3 (tiempo) ─► E5 (escala)
        └─────────► E4 (variación/plantillas/media) ─► E5
        └─────────► E6 (redes nuevas) ──► auto-aparecen en composer
E7 (pulido) depende de E2/E3 mínimos.
```

E1 es prerequisito de todo. **Recomendación de shipping:**
**E1 → E2 → E3 → E4** primero (todo IG/X, donde Jose ya opera, bajo/medio
riesgo, y E4 es el diferencial). Luego **E5** (escala) y **E6** (redes frágiles)
según prioridad de negocio.

## 5. Riesgos transversales y mitigaciones

- **Selectores IG/TikTok frágiles** → dry-run + screenshot + health gating
  detectan roturas antes de un lote masivo. Selectores centralizados por action.
- **Huella por contenido idéntico** → Etapa 4 (variación) es la mitigación; va
  temprano a propósito.
- **Posteo masivo accidental** → resumen + confirm (Etapa 1), dry-run (Etapa 2).
- **Cuentas flageadas** → health gating saltea identities en rojo.
- **Resolución del scheduler = 60s** → suficiente para social; documentarlo.
- **Rate-limit** → surfacear `BulkRateLimit` en el resumen pre-publicación.

## 6. Convenciones (checklist por etapa)

- [ ] `prettier --write` sobre todo lo new/modified (incl. `.md`) antes de `git add`.
- [ ] Budget 500 LOC/archivo — partir si se excede (ADR 0005).
- [ ] Bump `browser/ui/manifest.json` en el mismo commit que toque `browser/ui/`.
- [ ] i18n EN/ES en `browser/ui/locales`.
- [ ] Tests (helpers puros mínimo; variación/spintax 100% testeable).
- [ ] `npm install --include=dev` en el setup de Jose.
- [ ] Post-push: `gh run list --limit 3` para confirmar CI verde.
- [ ] ADR por etapa que introduzca arquitectura nueva (A, B, C + store).

## 7. Out of scope (de todo el módulo, por ahora)

- Generación de contenido con IA (captions/imágenes) — bloque aparte.
- Editor de imagen/video dentro del estudio.
- Inbox / responder DMs y comentarios — es otro módulo.
- Carrousel/álbum IG (single image primero).
