# Plan de cierre de pendientes (post-alpha.102)

> Estado validado en código 2026-07-15. Cada fase = release shippable (bump alpha, CI verde, firmado). Reglas: MCP-first, doc hermano + ADR si hay decisión, entrada en history al cerrar, prettier antes de commit, verificar CI, publish firmado.

## Fase 0 — Validación inmediata (Jose, sin código)

- Smoke visual del botón "🔄 Reconnect proxy" (clic derecho en identity).
- Repartir DMG (release Latest) + clave a Ata `OZ-V9B4-BHVH-BQXV`, Marcela `OZ-ZU4S-R7C5-GU2C`, Daniela `OZ-W2BU-89JK-WEB4`.

## Fase 1 — Cierres rápidos (alpha.103) ✅

- Botón "renombrar" en la sección Proyectos del sidebar (backend/IPC/MCP ya existían).
- Fix del stub `move-to-new-window` del command palette → acción real vía `oz:tabs:moveToNewWindow` (IPC ya existía, faltaba el bridge preload + wiring).

## Fase 2 — Publishing E5: import Excel + aprobación (alpha.104)

Cablear `browser/ui/publishing-plan.js` (escrito, hoy huérfano — no está en ningún `<script>`) al HTML del studio: pantalla de import de Excel + máquina de estados draft→review→approved. Backend (`publishing-plan-handlers.js`, `publishing-plan-store.js`) y MCP (`oz.publishing.import/list/status/export`) ya existen.

## Fase 3 — Publishing E2+E7: evidencia + analytics (alpha.105)

- Cablear UI de dry-run (parte de `publishing-plan.js`) y de analytics (`publishing-analytics.js`, huérfano; MCP `oz.publishing.stats/runs` existe).
- Implementar screenshot/evidencia de posteo (único faltante de cero en E2).

## Fase 4 — Publishing E6: más redes (alpha.106)

Actions nuevas en `bulk-runner-setup.js`: TikTok, Reels/video IG, LinkedIn, YouTube. `ig_post` con soporte de video. Cierra Publishing 7/7 etapas.

## Fase 5 — Sync production-ready (alpha.107)

- `OZ_DROPBOX_APP_KEY` build-time (hoy vacío en `.env.example`).
- Long-poll real de Dropbox (hoy poll `listFolderContinue` cada 30s).
- GC de tombstones.

## Fase 6 — V3 anti-detect remate (alpha.108-110)

- **6a** V3-B/C: scroll con momentum, typos+corrección, WebRTC leak prevention, audio FP randomization. Smoke stealth contra creepjs/pixelscan/bot.sannysoft al cierre.
- **6b** V3-D: adapter real del worker (identity + page-handlers) + smokes en Electron. Deja el scraping headless usable end-to-end.
- **6c** V3-E observabilidad (no existe): action log por job, timeline de screenshots, cost tracker.

## Fase 7 — Deuda técnica (junto a lo anterior)

- Bandwidth meter real de proxy (`proxy-manager.js:163` placeholder) + instrumentación.

## Ejecución

Claude hace Fases 1-7 (código, tests, docs, commit, CI, publish). Jose hace Fase 0 y los smokes visuales de cada release. Lo que requiere smoke en Electron (V3-D/E) se marca para validación de Jose (no corre en CI/sandbox).
