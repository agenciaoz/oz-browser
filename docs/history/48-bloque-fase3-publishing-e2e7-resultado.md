# Bloque Fase 3 — Publishing E2 (dry-run + evidencia) + E7 (analytics UI) (alpha.105)

**Status:** ✅ Código listo 2026-07-15 — Fase 3 del `docs/PLAN-CIERRE-PENDIENTES.md`
**Version:** 2.0.0-alpha.105
**Deps nuevas:** 0
**Tests nuevos:** +6 (`bulk-action-evidence.smoketest.js`)

## Origen

Auditoría 2026-07-15: E7 (analytics) tenía backend + MCP (`oz.publishing.stats`) pero UI huérfana; E2 tenía `dryRunReport` puro + handler `dryRun` pero sin botón en la UI, y le faltaba de cero la **evidencia de posteo** (screenshot).

## Qué se entregó

### E7 — Analytics UI

- `browser/ui/publishing-analytics-ui.js`: `window.OZ.PublishingAnalyticsUI` — KPIs (éxito/intentos/OK/fallos), tasa por red, mejor hora UTC. Lee `window.oz.publishing.stats()` (sin backend nuevo). Sección "Analytics" (`#pub-analytics`) en `publishing-studio.html` + CSS. Montado en `publishing-studio.js`.

### E2 — Dry-run UI

- `publishing-plan-ui.js`: botón "🔎 Dry-run" en cada tarjeta del plan → llama `window.oz.publishing.dryRun(id)` y muestra el reporte inline (issues + estado por identity con su health). Reusa `dryRunReport` puro + handler existentes.

### E2 — Evidencia de posteo (de cero)

- `browser/bulk-action-evidence.js`: `captureEvidence(win, {identityId, actionId, electron})` — screenshot post-éxito guardado en `userData/publish-evidence/`. **Best-effort, nunca tira**. Doc `docs/modules/bulk-action-evidence.md`.
- Cableado en las 4 actions de post (`ig_post`, `x_post`, `fb_post`, `threads_post`): agregan `evidencePath` al resultado del item → visible en historial + resultado MCP.
- manifest 2.0.62 → 2.0.63.

## Decisiones

- Evidencia se guarda a disco (path en el resultado), NO base64 en el run, para no inflar el historial.
- Capturar evidencia jamás rompe un post exitoso (try/catch → `{}`).

## Estado

- Tests: bulk-action-evidence (6), post-actions (ig/fb verdes), mcp-server naming (155). `check:loc` verde. Lint clean (limpié un warning preexistente `err`→`_err` en ig-post).
- **Pendiente smoke visual (Jose):** Publishing Studio → sección Analytics (métricas), botón Dry-run en tarjetas del plan, y verificar que un post real deja PNG en `userData/publish-evidence/`.

## Próximo

Fase 4 — Publishing E6: actions TikTok / Reels-video / LinkedIn / YouTube + ig_post con video.
