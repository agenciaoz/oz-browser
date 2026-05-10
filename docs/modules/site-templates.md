# Módulo `site-templates`

**Path:** `browser/site-templates.js`
**Líneas:** ~220
**Bloque/Etapa:** 1.5c (CORE)

## Qué hace

Cataloga 10 plataformas de redes sociales con los selectores CSS y patterns URL necesarios para detectar login pages y rellenar credentials. Es **pure data + funciones puras** — sin estado, sin side effects. Consumido por `preload-content.js` (auto-fill / auto-save).

## 10 plataformas v1

| id           | name                  | hosts                                                            | flow         |
| ------------ | --------------------- | ---------------------------------------------------------------- | ------------ |
| `x`          | X / Twitter           | x.com, twitter.com, mobile.twitter.com                           | two-step     |
| `instagram`  | Instagram             | instagram.com                                                    | one-step     |
| `facebook`   | Facebook              | facebook.com, m.facebook.com                                     | one-step     |
| `tiktok`     | TikTok                | tiktok.com                                                       | one-step     |
| `linkedin`   | LinkedIn              | linkedin.com                                                     | one-step     |
| `google`     | Google (YouTube)      | accounts.google.com                                              | two-step     |
| `reddit`     | Reddit                | reddit.com, old.reddit.com, new.reddit.com                       | one-step     |
| `threads`    | Threads               | threads.net                                                      | one-step     |
| `telegram`   | Telegram Web          | web.telegram.org                                                 | phone-only   |
| `discord`    | Discord               | discord.com, discordapp.com                                      | one-step     |

## Estructura de un template

```js
{
  id: 'x',                                  // canonical id (lowercase)
  name: 'X / Twitter',                      // display name para UI
  hosts: ['x.com', 'twitter.com', ...],     // hostnames matchables (primer = canonical)
  loginUrlPatterns: [/^https?.../i, ...],   // regex array para detectar login pages
  flow: 'one-step' | 'two-step' | 'phone-only',
  selectors: {
    usernameInput: 'CSS selector',
    passwordInput: 'CSS selector',
    submitButton: 'CSS selector',
    nextButton: 'CSS selector',             // solo two-step
    loggedInIndicator: 'CSS selector',      // detecta sesión activa (anti-logout 1.5d)
  },
}
```

## Flow types

- **`one-step`**: username + password en la misma página. Auto-fill llena ambos juntos.
- **`two-step`**: X y Google. Username primero, click Next, password en pantalla 2. Auto-fill solo llena username (1.5c v1) — el user clickea Next manualmente.
- **`phone-only`**: Telegram. Phone number + SMS code. Auto-fill no aplica el flujo standard — el user escribe el código manualmente.

## Exports

| Símbolo                 | Tipo     | Descripción                                                                              |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `TEMPLATES`             | array    | Los 10 templates v1.                                                                     |
| `matchByHost(hostname)` | function | Devuelve template para hostname (normaliza www. y case). null si no match.               |
| `matchByLoginUrl(url)`  | function | Devuelve template si la URL es login page de alguna plataforma. null si homepage/random. |
| `isLoginUrl(url)`       | function | bool. Wrapper de matchByLoginUrl.                                                        |
| `siteIdForUrl(url)`     | function | Devuelve canonical site id (primer host del template) o normalized host si sin template. |

## Convenciones para agregar plataformas nuevas

1. Verificar selectores manualmente abriendo la login page en DevTools y haciendo `document.querySelector(SELECTOR)` — algunos sitios cambian frecuente y requieren re-check periódico.
2. Usar `:has-text(...)` solo si Electron version soporta CSS4 (verificar — fallback a `[role="button"]` general).
3. Usar `[data-testid=...]` cuando exista (más estable que clases CSS generadas por React).
4. `hosts` debe incluir TODOS los aliases (mobile.twitter.com, m.facebook.com, etc.) — el primer entry es el canonical.
5. `loginUrlPatterns` flexible (regex `/i`) — pero NO demasiado loose (evitar matchear `/login-help`).
6. **El template es read-only en runtime.** Si hay que actualizarlo dinámicamente (template fetched from cloud), eso es C-XX futuro.

## Tests

- `tests/site-templates.smoketest.js` — 125 tests cubriendo:
  - Estructura completa de los 10 templates
  - matchByHost para todos los hosts canonical y aliases
  - Normalización (www., case)
  - matchByHost devuelve null para hosts desconocidos
  - isLoginUrl detecta login pages reales para cada plataforma
  - isLoginUrl rechaza homepages, perfiles, random
  - matchByLoginUrl devuelve template correcto
  - siteIdForUrl canonical (twitter.com → x.com)

## Mantenimiento futuro

Sub-bloque de mantenimiento sugerido cada ~6 meses: re-validar selectores corriendo OZ contra cada plataforma + corregir los que rompió update visual del sitio. Esto es trabajo conocido de password managers (1Password, Bitwarden tienen el mismo dolor).

## Referencias

- [`preload-content.md`](preload-content.md) — content script que consume estos templates.
- [`account-handlers.md`](account-handlers.md) — `getCredentialsForSite(site, identityId)` recibe el `site` canonical de `siteIdForUrl`.
- [ADR 0008](../architecture/0008-account-vault-encryption.md) — modelo Account.
