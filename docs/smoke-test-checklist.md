# OZ Browser — Smoke Test Checklist (Etapa 1.1)

Guía paso a paso para validar v2 en producción real. Usa **1 identity por plataforma** (no quemes tus cuentas principales para el primer test — usá secundarias).

**Antes de empezar:**

1. Tener OZ alpha.16+ instalada (Settings → About → debe decir `2.0.0-alpha.16` o superior)
2. Tener al menos 1 identity creada por plataforma que vas a testear (Cmd+Shift+I → New Identity)
3. Loguear manualmente cada identity en su plataforma una vez. Eso seedea la sesión en la cookie jar de OZ.

---

## ✅ Pre-flight: Verificar Bulk Runner abre

1. Cmd+Shift+B → debe abrir modal "⚡ Bulk Run"
2. Dropdown "Action" debe mostrar **11 actions**:
   - `echo` (test)
   - `navigate`
   - Instagram: Comment / Post / Like / Follow
   - X: Post / Like
   - TikTok: Like / Follow
   - Facebook: Like
3. La lista de identities debe mostrar todas las que tenés creadas

Si algún punto falla → me decís y miramos juntos. **No avances** hasta que esto esté OK.

---

## ✅ Test 1: echo (validar motor end-to-end)

**Por qué primero:** echo no toca ninguna plataforma. Si esto falla, el motor está roto antes de ir a plataformas reales.

1. Cmd+Shift+B → seleccioná `echo`
2. Params: `message` = "hola"
3. Identities: marcá 2-3
4. Delays: `min=0` `max=0` (rápido para el test)
5. Run

**Esperado:**

- Tabla muestra cada identity con `running ▶︎` → `done ✓`
- Result column dice algo tipo `{ "message": "hola", ... }`
- Stats line: `2 done · 0 failed`

Si esto falla → me decís. **No avances**.

---

## ✅ Test 2: navigate (validar BrowserWindow + per-identity partition)

1. Action: `navigate`
2. Params: `url` = `https://whatsmyip.com` (o algo único per identity con proxy)
3. Identities: 2
4. Run

**Esperado:**

- Cada identity abre una window oculta, navega, cierra.
- Result column: `{ "url": "...", "durationMs": ... }`

Si una identity tiene proxy asignado, el IP que reporta whatsmyip debería ser el del proxy. Eso lo validás abriendo la identity manualmente después y comparando.

---

## ✅ Test 3: IG Like (la más común)

1. Antes:
   - Tené **1 identity IG** logueada manualmente.
   - Andá a un post de IG cualquiera (NO post privado) y copiá la URL.
2. Bulk Runner → `Instagram: Like a post`
3. Params: `postUrl` = la URL del post
4. Identities: marcá SOLO esa 1 identity IG
5. Run

**Outcomes posibles:**

- ✅ `done` + `action: 'liked'` → **funciona perfecto**. Andá al post en IG manual y verificá el ♥ está prendido.
- ⚠️ `done` + `action: 'already-liked'` → ya tenía like. Tested OK, no clickeó.
- ❌ `failed` + `needs_login` → la identity NO está logueada. Logueala manual y reintentá.
- ❌ `failed` + `captcha` → IG mostró challenge. Manualmente resolvelo (probablemente desde la identity por separado) y reintentá.
- ❌ `failed` + `not-found` → **Esto es lo que necesito**. Significa que IG cambió los selectores. Me mandás el screenshot del reporter + me decís qué tipo de post probaste (reel, carousel, single photo, IGTV) y te mando un patch.
- ❌ `failed` + `click-failed` → IG rate-limit-eó la identity. Esperá 30 min y reintentá. Si vuelve a pasar = soft-ban temporario.

**Si funciona →** repetí con `unlike: true` para quitar el like. Debe responder `action: 'unliked'`.

---

## ✅ Test 4: IG Follow

Mismo pattern que Test 3 pero con `profileUrl` (perfil ajeno, NO el tuyo).

**Outcomes:**

- `followed` ✅ (público) o `requested` ✅ (privado) → andá a IG manual y confirmá
- `already-following` → ya seguías. Tested OK.
- Otros errors → mismo flujo que test 3

---

## ✅ Test 5: X Like

Mismo pattern. Necesitás 1 identity X logueada + URL de tweet.

**Outcomes:** `liked` / `already-liked` / errors. Reportar `not-found` si pasa.

---

## ✅ Test 6: X Post

1. Action: `X: Post a tweet`
2. Params: `text` = "test desde OZ Browser " + timestamp único
3. 1 identity X
4. Run

**Esperado:** `done` + tu tweet aparece en X timeline de esa identity.

Si falla con `submit-failed` → X bloqueó. Esperá. Si `not-found` → me lo decís.

---

## ✅ Test 7: TikTok Like

URL de video TikTok. Mismo pattern.

**Outcomes:** `liked` / `already-liked` / errors.

---

## ✅ Test 8: TikTok Follow

URL de perfil TikTok (o solo el username). Mismo pattern.

---

## ✅ Test 9: Facebook Like

⚠️ **FB es notoriamente difícil con anti-bot.** Es el más probable de fallar.

URL de un post FB público. 1 identity FB logueada.

**Si falla:**

- `not-found` muy probable — FB cambia DOM frecuente. Me mandás screenshot + URL del post.
- `captcha` también probable. Hacé scroll manual en la identity y aceptá cookies, etc, antes de retry.
- `click-failed` = FB action-block. Espera 1+ hora.

---

## ✅ Test 10: Auto-login (lo más importante)

**Setup:**

1. Account Manager (Cmd+Shift+A) → Unlock vault
2. New account:
   - identity = la que vas a usar
   - site = `instagram.com` (o `x.com` / `tiktok.com` / `facebook.com`)
   - username + password de esa cuenta
   - totpSecret = si tenés 2FA activado, el secret base32 del authenticator (NO el código de 6 dígitos — el secret)
3. **Deslogueate manualmente de esa cuenta en la identity** (para forzar `needs_login`)

**Test:**

1. Bulk Runner → IG Like + esa identity + un post URL
2. Run

**Esperado:**

- Item entra a `running`
- Internamente falla con `needs_login`
- OZ spawnea una window, va a `/accounts/login/`, llena user + pass, si pide 2FA llena el TOTP, vuelve, verifica login
- Item flippe a `done` con badge `🔐 re-logged` antes del result

**Si falla:**

- `vault-locked` → desbloqueá el vault
- `no-credentials` → revisá que el account esté guardado con el site correcto
- `totp-needed-no-secret` → la cuenta tiene 2FA y vos no guardaste el totpSecret
- `login-failed` → password incorrecto / IG capturó tu bot

---

## ✅ Test 11: Rate-limit registry

**Setup:** Bajá el cap temporal a 1 para testear sin gastar 200 likes.

No tenés UI para esto todavía. Manual:

1. Abrir DevTools de OZ (Cmd+Option+I en el bg de la app, no en un tab)
2. Console: `await window.oz.bulk.run({actionId:'echo', identityIds:[...], params:{message:'x'}, options:{minDelayMs:0,maxDelayMs:0}})`

Tampoco hay UI para ver counters todavía. Eso es Etapa 2.2 (MCP tool stats).

Lo importante: en un bulk run real, si una identity ya alcanzó el cap, el item aparece como `skipped` con `⏱️ rate-limit`.

---

## 📋 Cómo reportarme fallos

Para cada test que falle, copiame:

1. **Action + outcome:** `ig_like` falló con `not-found`
2. **Identity:** si es relevante (público vs privado, vieja vs nueva, etc)
3. **URL/target:** el post/profile/tweet que usaste
4. **Screenshot del reporter** del bulk runner mostrando el error
5. **Hora aproximada** (si fue por rate-limit puede tener time-relevance)

Con eso te mando un patch en <10 min para selectors stale, o explicación si fue platform-side block.

---

## 🎯 Cómo sabés que pasó el smoke test

Si los tests 1-9 pasan con al menos `done` o `already-*` (idempotent) en cada plataforma, y test 10 (auto-login) funciona en al menos 1 plataforma:

**v2 MVP queda validado en producción.** Podés empezar a correr bulk runs reales en tu agencia.

Cualquier `not-found` en plataformas reales = patch a selectores (Etapa 1.2 — yo te lo mando rápido).
