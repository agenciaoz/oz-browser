# bulk-actions-linkedin-post

Action del bulk runner `linkedin_post` — postea un texto en LinkedIn desde cada identity. Introducida en v2.0.0-alpha.106 (Publishing E6). Clona el pattern de `bulk-actions-fb-post.js`.

## Qué hace

`buildLinkedinPostAction({ identityManager, electron })` → action `{ id:'linkedin_post', platform:'linkedin.com', paramsSchema, run }`.

Flujo (`run(identity, params, ctx)`):

1. `spawnIdentityWindow` para la identity → 2. navigate a `linkedin.com/feed/` → 3. early check needs_login/captcha → 4. click "Start a post" → 5. espera el editor Quill (`div.ql-editor[contenteditable]`) → 6. tipea vía `execCommand('insertText')` (fallback a type) → 7. click submit (`button.share-actions__primary-action`) → 8. verifica dialog cerrado → 9. `captureEvidence` (screenshot) + `safeClose`.

- **Params:** `{ text (1-3000, requerido), timeoutMs? (default 60000) }`.
- **Result:** `{ text, identityId, identityName, durationMs, evidencePath? }`.
- **Errores** (`err.code`): `needs_login | captcha | not-found | submit-failed`.

## Registro y publishing

- Registrada en `bulk-runner-setup.js` (guard `registry.get('linkedin_post')`).
- Mapeada en `ui/publishing-plan.js`: alias `linkedin`/`li`/`ln` → `linkedin`; `ACTION_BY_PLATFORM.linkedin = 'linkedin_post'`; `buildPublishParams` → `{ text }`. Así el Publishing Studio puede programar/publicar en LinkedIn como en las otras redes de texto.

## Gotchas

- LinkedIn cambia el DOM seguido; los selectores son best-effort con varios fallbacks. Apoyarse en **dry-run** + la **evidencia** (screenshot) para verificar.
- Media (imagen/video) NO soportada todavía.
- Requiere que la identity ya esté logueada en LinkedIn (auto-login retry si el vault está cableado).

## Tests

`tests/bulk-actions-linkedin-post.smoketest.js` (11 checks, harness de fake BrowserWindow — mismo estilo que fb_post) + assertion de mapeo en `tests/publishing-plan.smoketest.js`. El flujo real requiere smoke visual en vivo.
