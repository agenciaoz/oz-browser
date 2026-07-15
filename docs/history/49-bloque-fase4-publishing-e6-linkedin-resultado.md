# Bloque Fase 4 — Publishing E6: LinkedIn post + evidencia (alpha.106)

**Status:** ✅ Código listo 2026-07-15 — Fase 4 (parcial) del `docs/PLAN-CIERRE-PENDIENTES.md`
**Version:** 2.0.0-alpha.106
**Deps nuevas:** 0
**Tests nuevos:** +11 (`bulk-actions-linkedin-post.smoketest.js`) + 1 assertion en publishing-plan

## Origen

E6 de Publishing pedía cubrir más redes: TikTok, Reels/video, LinkedIn, YouTube. De esas, **LinkedIn (texto)** sigue exactamente el pattern de las actions de texto existentes (fb_post/threads_post) — escribible y testeable con seguridad. Las de **video** requieren inyección de archivo + procesamiento largo + selectores frágiles que hay que iterar EN VIVO.

## Qué se entregó

- `browser/bulk-actions-linkedin-post.js`: action `linkedin_post` (14ª del runner). Clon del pattern fb_post con el flujo "Start a post" de LinkedIn (editor Quill `.ql-editor`). Captura evidencia (alpha.105). Doc `docs/modules/bulk-actions-linkedin-post.md`.
- Registrada en `bulk-runner-setup.js`.
- Cableada en `ui/publishing-plan.js`: alias `linkedin`/`li`/`ln`, `ACTION_BY_PLATFORM.linkedin='linkedin_post'`, `buildPublishParams` → `{text}`. El Publishing Studio ya la programa/publica.
- `MANUAL-OZ-BROWSER.md`: actions 13 → 14.

## Decisión honesta (scope)

Fase 4 entrega **LinkedIn** (la red de texto que faltaba, limpia y testeable). Las de **video — TikTok video, IG Reels, YouTube — quedan pendientes de una sesión en vivo** en la Mac de Jose: escribir esos selectores a ciegas produciría automatización rota. `ig_post` sigue siendo solo imagen por la misma razón.

## Estado

- Tests: linkedin action (11), publishing-plan (18), threads/fb post verdes. `check:loc` verde. Lint clean.
- **Pendiente smoke visual (Jose):** publicar en LinkedIn desde una identity logueada.
- **Pendiente (requiere sesión en vivo):** actions de video (TikTok/Reels/YouTube) + ig_post con video.

## Próximo

Fase 5 — Sync production-ready: `OZ_DROPBOX_APP_KEY` + long-poll real + GC tombstones.
