# Bloque alpha.117 — Instagram Reels (ig_post acepta video) — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.117

## Contexto

Video posts era el pendiente de features más grande. En vez de escribir 3 plataformas con selectores 100% especulativos, se atacó la de MENOR riesgo y MAYOR reuso: **IG Reels**, extendiendo el `ig_post` ya probado (que sube imagen con el flujo completo spawn→CDP→Next×2→caption→Share).

## Qué se entregó

`ig_post` ahora acepta `videoPath` (mp4/mov) además de `imagePath` (mutuamente excluyentes). Con video:

- IG lo trata como Reel.
- Se agrega un paso best-effort: clickear el diálogo "compartir como reel" (OK/Aceptar/Got it) si aparece; si no, sigue el flujo normal (no rompe).
- Timeout mayor por defecto (180s vs 120s) — el procesamiento de video es más lento.
- El selector de file input prioriza `accept*="video"`.
- Result: `{ videoPath, mediaType:'video', ... }`.

El resto del flujo (login/captcha detect, Next×2, caption, Share, confirmación, evidencia) es el MISMO código probado del ig_post imagen → riesgo casi nulo para el path de imagen (el de video solo se activa con `videoPath`).

## Qué quedó funcionando

- Tests: `bulk-actions-ig-post.smoketest.js` 28/28 (agregados: happy path video, skip del diálogo cuando no aparece, video-missing, imagePath+videoPath juntos→error). check:loc verde. Solo main.

## Pendiente

- **Smoke en vivo (Jose):** postear un Reel real con una identity logueada; si falla con `not-found`, ajustar selectores con DevTools (norma de las post actions — IG rota el DOM).
- **TikTok, YouTube, IG-Reels-nativo (studio):** DOMs completamente distintos, siguen pendientes de sesión en vivo. Este bloque estableció el patrón (video = imagen + diálogo best-effort + timeout) para clonarlos.
