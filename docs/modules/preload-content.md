# Módulo `preload-content`

**Path:** `browser/preload-content.js`
**Líneas:** ~190
**Bloque/Etapa:** 1.5c (CORE)

## Qué hace

Content script preload que se inyecta en CADA renderer process de tabs de identities (NO en el WebUI chrome — eso usa `preload.js` de la raíz). Implementa:

1. **Auto-fill** — al cargar una login page conocida (matched contra `site-templates.js`), pide credentials al main via IPC y rellena los inputs CSS-detectados.
2. **Auto-save** — al detectar form submit en una login page, captura username+password y propone al main via IPC. Main muestra dialog "Save credentials para Identity X?".

Wireado via `session.setPreloads([CONTENT_PRELOAD_PATH])` en `identity-manager.getSession()`.

## Identity resolution

El preload **NO sabe ni necesita saber** qué identity es. Para cada IPC call, el handler del main resuelve el `identityId` desde `event.sender.session` via `IdentityManager.identityIdForSession()`.

**Razón de seguridad:** un renderer comprometido NO puede impersonar otra identity pasando un `identityId` arbitrario — el main side ignora cualquier identityId arg que venga del renderer y usa el del session real del sender.

## Auto-fill UX

**Silent** (sin confirmación inline). Decisión Jose 2026-05-09 noche. Defensa anti-phishing depende de:

- Solo se inyecta en hosts EXACTOS de la whitelist (no soporta "smart" matching que un atacante pueda spoofear).
- TLS handshake del browser ya valida el dominio (PKI estándar del sistema, sin SSL pinning custom).
- Vault solo se descifra cuando el user explícitamente abre Account Manager (UX choice 1.5b) — primer cold boot no hay credentials en RAM.

Para usuarios que quieran confirmación inline (banner "Filled credentials for Identity X. OK / Disable here"), está como mejora futura — agregable en una pasada de UX sin tocar el resto del flow.

## Auto-save UX

**Always with popup** — el main muestra `dialog.showMessageBox` (Electron native, no HTML alert) preguntando "Save credentials for Identity X / Site Y?". User aprueba → llama `accounts.create()` o `accounts.update()` (depende si ya existe entry para `(identityId, site, username)`).

## Two-step flows

X y Google separan username (pantalla 1) y password (pantalla 2). Auto-fill v1 solo llena el username automáticamente — el user clickea Next/siguiente manualmente. Cuando aparece la pantalla del password, el preload se re-dispara via interval polling (SPA detection — chequea `location.href` cada 1.5s) y rellena el password.

**Mejora futura** (no en 1.5c): auto-click del Next button.

## SPA detection

X, Instagram, Facebook son SPAs — la URL cambia sin navegación full-page. El preload registra:

1. `DOMContentLoaded` → primer try de auto-fill.
2. `setInterval(1500ms)` que chequea si `location.href` cambió → re-trigger.

(Alternativa más eficiente: hookear `history.pushState/replaceState`, pero requiere monkey-patch que algunos sitios detectan y no quieren provocar fricción de detección.)

## React-compatible setInputValue

React tracks input values via descriptor setter — solo `el.value = x` no triggers React state update. Usamos el native HTMLInputElement setter + dispatch `input` + `change` events:

```js
const proto = Object.getPrototypeOf(el)
const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
if (setter) setter.call(el, value)
el.dispatchEvent(new Event('input', { bubbles: true }))
el.dispatchEvent(new Event('change', { bubbles: true }))
```

## waitForSelector helper

Algunos sitios (TikTok, X) renderizan los inputs después de un tick de React. Para robusto: `waitForSelector(selector, timeoutMs)` espera con `MutationObserver` hasta encontrar el elemento o timeout.

## Skip en chrome-extension

Si `location.protocol === 'chrome-extension:'` (WebUI chrome), el preload no hace nada — el WebUI tiene su propio bridge en `preload.js`.

## IPC channels usados

| Canal                               | Dirección      | Descripción                                                                    |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `oz:accounts:getCredentialsForSite` | preload → main | Pedir credentials para auto-fill. main resuelve identityId del sender.session. |
| `oz:accounts:proposeAutoSave`       | preload → main | Proponer save al user via dialog. main resuelve identityId del sender.session. |

## Tests

- No tests unit del preload — corre en renderer real con DOM, lo testea visualmente al cierre del 1.5f con OZ corriendo y una login page real.
- Site templates (`tests/site-templates.smoketest.js`) cubre matching de URLs.
- Account handlers (`tests/account-handlers.smoketest.js`) cubre `getCredentialsForSite` y `proposeAutoSave`.

## Próximos pasos

- 1.5d: anti-logout — extiende session.cookies.onChanged hook + health check daemon para mantener sesión warm. Usa `loggedInIndicator` selector de los templates para detectar que la session sigue válida.
- 1.5f: Account Manager UI dedicada para CRUD manual de accounts + el dialog que aparece al `oz:autofill:propose-save` broadcast.

## Referencias

- [`site-templates.md`](site-templates.md) — los selectores que consume.
- [`account-handlers.md`](account-handlers.md) — handlers `getCredentialsForSite` y `proposeAutoSave`.
- [`identity-manager.md`](identity-manager.md) — `setPreloads()` + `identityIdForSession()`.
- [ADR 0008](../architecture/0008-account-vault-encryption.md).
