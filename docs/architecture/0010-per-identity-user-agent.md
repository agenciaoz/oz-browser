# ADR 0010 — Per-identity custom User-Agent

**Estado:** Aceptado
**Fecha:** 2026-05-09
**Pedido por:** Jose
**Bloque:** 1.2 (closing)

## Contexto

Ghost Browser permite configurar el User-Agent global pero NO por-identity. Para nuestro caso de uso (50+ cuentas de redes sociales, cada una con su perfil persistente), es útil poder asignar un UA distinto a cada Identity — por ejemplo, simular que una cuenta es Safari macOS y otra Chrome Windows. Esto es la primera capa del FingerprintEngine completo de Bloque 1.5; queremos exponerlo desde ya porque es un mecanismo aislable, útil sin el resto del FE, y permite a Jose probar fingerprint behavior antes de que el FE complete esté listo.

## Decisión

**Cada Identity puede tener un campo opcional `userAgent: string|null`.** Cuando una Identity con `userAgent` se resuelve via `IdentityManager.getSession(id)`, el manager llama `ses.setUserAgent(userAgent)` antes de devolver la session.

- Si `userAgent === null` o ausente, no se toca la session — queda con el UA scrubbed que `extensions-setup.initSession` aplica al defaultSession y los UAs default que Chromium da a partition sessions.
- **La Default Identity NO acepta `userAgent` custom** desde la UI. Razón: la Default usa `defaultSession`, y esa session es compartida con `ElectronChromeExtensions`, que en algunos paths inspecciona el UA. Sobrescribirlo podría romper Chrome Web Store install. Quien quiera UA custom para "todo Default" usa una Identity custom.
- El UA se aplica en `getSession()` (lazy en primer uso). Si después se cambia via `update(id, { userAgent: ... })`, el cambio se aplica inmediatamente sobre la session cacheada.

## Alternativas consideradas

- **UA per-tab:** demasiado granular para v1, complica la UI. Tab-level overrides los dejamos para Bloque 1.6 (context menu).
- **Aplicar UA via preload script (override navigator.userAgent):** hace que `document.userAgent` mienta pero el `User-Agent` HTTP header sigue siendo el real → fingerprint inconsistente, peor que no hacer nada. El FE de Bloque 1.5 va a hacer override de navigator.* coordinado con `setUserAgent` del transport — coherencia es lo que diferencia "Ghost+". Por ahora `setUserAgent` solo (header consistente, navigator no necesariamente).
- **No exponerlo hasta Bloque 1.5:** lo que originalmente plan v3 decía. Pero Jose lo pidió porque el modal de Identity ya existe y este es el campo más útil para empezar a fingerprinting per-identity sin esperar 7 bloques.

## Consecuencias

- ✅ Mecanismo simple y aislable. Aplicar UA = una llamada de Electron API (`ses.setUserAgent`).
- ✅ Setup para Bloque 1.5 — el FE va a override navigator.userAgent y otros vectores; el campo `userAgent` queda como single source of truth desde ya.
- ⚠️ UA inconsistente con `navigator.userAgent` en runtime hasta que llegue Bloque 1.5. Pixelscan/CreepJS lo van a detectar. **No anunciar como "antidetect" hasta Bloque 1.5.** En la UI, el campo se llama "User-Agent (HTTP)" para no engañar.
- ⚠️ Si Identity tiene UA `"foo"` y luego se borra, la session ya cacheada conserva ese UA hasta restart. Mitigación: en `update()`, si `userAgent` cambia (incluyendo a null), llamar `setUserAgent('')` para resetear (Electron acepta string vacío como "use default") + log. Verificar comportamiento de `setUserAgent('')` en Electron 42.
- ⚠️ Persiste en `identities.json` en plaintext. UAs no son secrets, OK.

## Plan de implementación

1. `IdentityManager`: agregar `userAgent` a model (campo opcional, null por default), método `update(id, patch)` con whitelisted keys (`name`, `color`, `userAgent`), aplicar UA en `getSession(id)` para identities no-default, y al `update()` aplicar inmediatamente sobre session cacheada si existe.
2. IPC: `oz:identities:update` channel.
3. Preload: `window.oz.identities.update(id, patch)`.
4. UI: modal `identity-editor.html` overlay (no popup window — más simple). Form con: name, color picker (presets), User-Agent textarea + botón "Use default". Open vía context menu "Edit identity…" en sidebar.
5. Docs: `modules/identity-manager.md` + `modules/ui-identity-editor.md` + actualizar `ipc-handlers.md`.

## Referencias

- ADR 0003 (Default usa defaultSession — razón para no permitir UA custom ahí).
- Bloque 1.5: FingerprintEngine "Ghost+" — este ADR es el primer ladrillo.
- Electron API: `Session.setUserAgent(userAgent[, acceptLanguages])` — https://www.electronjs.org/docs/latest/api/session
