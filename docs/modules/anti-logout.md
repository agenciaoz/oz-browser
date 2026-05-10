# Módulo `anti-logout`

**Path:** `browser/anti-logout.js`
**Líneas:** ~230
**Bloque/Etapa:** 1.5d (CORE)

## Qué hace

Mantiene logoneadas las cuentas de redes sociales **indefinidamente**, contra el comportamiento default de los browsers (Ghost incluido) que borra "session cookies" al cerrar la app. Diferenciador clave del producto.

Dos mecanismos:

1. **Extender expiry de session cookies** — al detectar que una cookie de un host de redes sociales se setea con `session=true` (sin expiración), la re-set con `expirationDate = now + 1 año`. Loop guard via `lastExtended` Map (no re-extender la misma cookie en menos de 1h — evita storms cuando el sitio reescribe cookies frecuentemente).

2. **Detección de logout + flag account** — si una cookie crítica se borra con `cause='explicit'` o `'overwrite'`, busca el account asociado en el vault, marca `status='needs_relogin'`, y dispara una system notification.

## Hosts whitelist

Viene del array `TEMPLATES` de `site-templates.js`. Cada template aporta sus `hosts` (canonical + aliases). Total v1: 32 entries en el set (10 plataformas × ~3 alias promedio).

```
x.com, twitter.com, mobile.twitter.com, instagram.com, facebook.com,
m.facebook.com, tiktok.com, linkedin.com, accounts.google.com, reddit.com,
old.reddit.com, new.reddit.com, threads.net, web.telegram.org, discord.com,
discordapp.com, ...
```

Cada entry está duplicada con prefix `.` para matchear el formato típico de `cookie.domain` (`.x.com` cubre `x.com`, `www.x.com`, `mobile.x.com` etc. via suffix match).

## Inyección de deps (testabilidad)

```js
new AntiLogout({
  identityManager,           // .list(), .getSession(id)
  accountVault,              // .isUnlocked, .getAccounts(), .setAccounts(arr)
  notificationFactory,       // () => Notification class. default: lazy require electron
})
```

El test mockea `FakeSession` con `cookies.on/.removeListener/.set/_emit/_setCalls`, `FakeIdentityManager`, `FakeVault`, `FakeNotification`. 38 tests con cero `electron` real.

## API

| Método                          | Descripción                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| `install()`                     | Instala hooks para todas las identities cacheadas. Idempotente.        |
| `installForIdentity(id)`        | Instala hook para 1 identity. Idempotente. Llamado desde `identity-handlers.create`. |
| `uninstall()`                   | Remueve todos los hooks + clear cooldown map.                          |

## Ciclo de vida

- **Boot (main.js)**: instancia `AntiLogout` post-IdentityManager + Vault → `antiLogout.install()`.
- **New identity (identity-handlers.create)**: llama `antiLogout.installForIdentity(newId)`.
- **App quit**: no requiere uninstall (app muere → listeners liberados).

## Comportamiento por escenario

| Escenario                                                | Acción                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| Cookie social + session + cooldown OK                    | Re-set con `expirationDate = now + 365d`                   |
| Cookie social + session + cooldown ACTIVO (<1h)          | Ignorada (loop guard)                                      |
| Cookie NO social                                         | Ignorada                                                   |
| Cookie social + ya tiene expirationDate (no es session)  | Ignorada (no hace falta extender)                          |
| Cookie social removida + cause='explicit' + vault unlocked + matching account | Account → status='needs_relogin' + notification |
| Cookie social removida + vault locked                    | Ignorada (no podemos leer accounts)                        |
| Cookie social removida + sin matching account            | Ignorada                                                   |
| Cookie social removida + cause='expired' o similar       | Ignorada (probablemente fue WE quien la re-setió)          |

## Constantes

| Constante                  | Valor              | Justificación                                          |
| -------------------------- | ------------------ | ------------------------------------------------------ |
| `ONE_YEAR_MS`              | 365 × 24 × 60 × 60 × 1000 | Período conservador para "indefinitely"          |
| `REEXTEND_COOLDOWN_MS`     | 1 hora             | Sites como X reescriben auth_token frecuente — sin esto, storm |

## Decisiones de seguridad

- **Heurística de "matching account"**: por ahora, cualquier account cuyo `site` matche el `cookie.domain` (suffix) y `identityId` matche el sender. Refinamiento futuro: per-template lista de "critical session cookies" (ej. X usa `auth_token`, FB usa `c_user`) para reducir false positives.
- **Auto-relogin NO en v1**: cuando el user navega manualmente al `/login` después de ver la notificación, el auto-fill de 1.5c lo rellena. Background auto-relogin requiere headless tab + manejo de challenges (CAPTCHA, 2FA) — sub-bloque dedicado futuro.
- **Health check daemon NO en v1**: cron passive navigation cada 6 días para refresh sesión. Plan original lo incluía, pero la detección via cookie absence ya cubre 80% de casos sin overhead. Health check es C-XX futuro si vemos que sesiones mueren sin trigger de cookie change.

## Tests

- `tests/anti-logout.smoketest.js` — 38 tests cubriendo:
  - Constants (SOCIAL_HOSTS, ONE_YEAR_MS, REEXTEND_COOLDOWN_MS)
  - isSocialCookie hits + misses + suffix match
  - isSessionCookie hits + misses
  - install() hookea por identity
  - install() es idempotente
  - uninstall() limpia
  - Cookie social + session → re-set con expiry +1 año
  - Cookie no-social → ignorada
  - Cookie no-session → ignorada
  - Cooldown 1h bloquea re-extensiones consecutivas
  - Logout detection con vault unlocked → flag + notify
  - Vault locked → no flag
  - Identity distinta → no flag

## Próximos pasos

- 1.5e Excel I/O — exporta accounts (incluyendo `status` para que el user vea cuáles necesitan re-login).
- 1.5f Account Manager UI — UI muestra badge "Needs re-login" en accounts flageadas.

## Referencias

- [`account-vault.md`](account-vault.md) — fuente de accounts.
- [`site-templates.md`](site-templates.md) — fuente de SOCIAL_HOSTS.
- [`identity-manager.md`](identity-manager.md) — sessions hookeadas.
- [ADR 0008](../architecture/0008-account-vault-encryption.md).
