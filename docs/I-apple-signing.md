# Apple Code Signing + Notarization — Activation Checklist

Esta guía documenta el workflow exacto para shippear el primer DMG firmado
de OZ Browser una vez que Apple Developer apruebe la cuenta.

Estado actual (v1.6.0, 2026-05-16): toda la infraestructura está armada —
`forge.config.js` activa `osxSign` + `osxNotarize` automáticamente cuando
las 4 env vars están seteadas, `build/entitlements.mac.plist` ya existe
con todos los entitlements que OZ necesita (hardened runtime + JIT +
WebRTC + filesystem + network), y el publisher GitHub Releases está
configurado apuntando a `agenciaoz/oz-browser`.

Lo que falta es el "go-live" — descargar el certificado de Apple, setear
las env vars, correr `npm run make` y verificar.

---

## Pre-requisitos (verificar antes de empezar)

- [ ] Apple Developer account aprobada en
      https://developer.apple.com/account/ (puede tomar 24–48h post-pago)
- [ ] Xcode Command Line Tools instalado:
      `xcode-select --install` (ya debería estar — Electron lo requiere)
- [ ] `security` CLI funcionando: `security find-identity -v -p codesigning`
      lista lo que hay actualmente.

---

## Paso 1 — Crear el "Developer ID Application" certificate

1. Login en https://developer.apple.com/account/resources/certificates
2. Click "Certificates" → "+" para crear uno nuevo.
3. Elegí **"Developer ID Application"** (NO "Developer ID Installer",
   NO "Mac App Distribution" — esos son para Mac App Store distribution).
4. Generar un CSR (Certificate Signing Request) desde Keychain Access:
   - Open Keychain Access → menu Keychain Access → Certificate Assistant →
     "Request a Certificate from a Certificate Authority…"
   - User email: tu Apple ID email.
   - Common name: "Jose Coronel" (o el nombre legal asociado a la cuenta).
   - CA email: dejar vacío.
   - "Saved to disk" → guardar el .certSigningRequest a Desktop.
5. Upload el .certSigningRequest al portal Apple.
6. Download el `.cer` generado y double-click — se instala en Keychain
   automáticamente.

Verificar:

```bash
security find-identity -v -p codesigning
```

Debe listar algo como:

```
1) ABC123... "Developer ID Application: Jose Coronel (TEAMID)"
```

Anotar el string completo entre comillas (incluyendo el `(TEAMID)`).
Ese es tu `OZ_APPLE_SIGN_IDENTITY`.

---

## Paso 2 — App-specific password para notarytool

1. Login en https://appleid.apple.com/account/manage
2. Sign-In Section → "App-Specific Passwords" → "+".
3. Label: "oz-browser-notarytool".
4. Apple muestra un password de formato `xxxx-xxxx-xxxx-xxxx`. Copialo —
   solo se muestra una vez.

Ese es tu `OZ_APPLE_ID_PASSWORD`.

---

## Paso 3 — Obtener Team ID

1. https://developer.apple.com/account → click tu nombre arriba a la
   derecha → "Membership Details".
2. Copia "Team ID" (10 caracteres alfanuméricos).

Ese es tu `OZ_APPLE_TEAM_ID`.

---

## Paso 4 — Setear env vars

Crear `.env.local` en la raíz del repo (NO commitear — ya está en
`.gitignore`):

```bash
cat > .env.local <<'EOF'
OZ_APPLE_SIGN_IDENTITY="Developer ID Application: Jose Coronel (TEAMID)"
OZ_APPLE_ID="tu-apple-id@example.com"
OZ_APPLE_ID_PASSWORD="xxxx-xxxx-xxxx-xxxx"
OZ_APPLE_TEAM_ID="ABCDEFGHIJ"
EOF
```

Cargar antes de cada `npm run make`:

```bash
set -a; source .env.local; set +a
```

(El `set -a` exporta automáticamente todas las vars del archivo al
environment del shell. Mac zsh lo soporta.)

Verificar:

```bash
echo $OZ_APPLE_SIGN_IDENTITY
echo $OZ_APPLE_ID
echo $OZ_APPLE_ID_PASSWORD
echo $OZ_APPLE_TEAM_ID
```

Las 4 tienen que estar pobladas. Si falta alguna, el forge config skip-ea
signing silently y el build queda unsigned (el comportamiento pre-v1.6.0).

---

## Paso 5 — Build firmado

```bash
OZ_PACKAGING_VERBOSE=1 npm run make
```

Va a tardar 5–15 minutos. El flow:

1. `electron-forge package` → ensambla el .app
2. `osxSign` firma cada binary + framework con hardened runtime
3. `osxNotarize` sube el .app zip a Apple via `notarytool submit`
   (esto es lo más lento — Apple procesa el bundle, típicamente 2–10min)
4. `notarytool wait` espera el ticket
5. Staple del notarization ticket al .app
6. `maker-dmg` envuelve el .app firmado + notarizado en un DMG

Output: `out/make/OZ Browser-1.6.0-arm64.dmg` (en arm64) o
`out/make/OZ Browser-1.6.0-x64.dmg` (en x64).

---

## Paso 6 — Verificar la firma

```bash
spctl -a -vvv "out/Make/OZ Browser-darwin-arm64/OZ Browser.app"
```

Debe decir:

```
out/...: accepted
source=Notarized Developer ID
origin=Developer ID Application: Jose Coronel (TEAMID)
```

Si dice `source=Developer ID` sin "Notarized", la firma pasó pero la
notarización falló. Re-mirar el log de notarytool en `~/Library/Logs/`.

---

## Paso 7 — Publish a GitHub Releases

Requiere `GH_TOKEN` con scope `repo`:

```bash
export GH_TOKEN="ghp_..."
npm run publish
```

(Si `npm run publish` no existe todavía, correr directamente
`npx electron-forge publish`.)

Esto:

1. Sube el .dmg + el .zip al draft release del tag actual en GitHub.
2. Sube `latest-mac.yml` (manifest que el client electron-updater lee).
3. Crea el release como **draft** — Jose lo promueve manualmente
   a "Published" desde la UI de GitHub Releases cuando quiera triggear
   updates a los usuarios.

---

## Paso 8 — Verificar auto-update end-to-end

1. Install la `1.6.0.dmg` firmada manualmente en una Mac.
2. Abrir OZ → Settings → About → debe mostrar versión 1.6.0 + "Up to date."
3. Bumpear app version a `1.6.1` en `package.json` + manifest WebUI.
4. Re-correr Paso 5 y 7 para shippear v1.6.1.
5. En la Mac con v1.6.0 instalada: Settings → About → "Check for updates
   now". Debe detectar v1.6.1 + descargar en background + mostrar
   "Restart and install".
6. Click → app se cierra, instala v1.6.1, re-abre con la nueva versión.

---

## Troubleshooting

**"could not find signing identity"** — el shell que ejecuta `npm run
make` no ve `OZ_APPLE_SIGN_IDENTITY`. Re-correr `set -a; source
.env.local; set +a` en el mismo shell tab.

**"failed to staple"** — la notarización todavía no terminó. Re-correr
`xcrun stapler staple "out/.../OZ Browser.app"` después de unos minutos.

**"App is damaged"** al instalar en otra Mac\*\* — el DMG no está firmado o
la notarización falló. Verificar con `spctl -a -vvv` (Paso 6).

**`electron-updater` no detecta el update** — chequear que el release en
GitHub esté como **Published** (no Draft). Y que `latest-mac.yml` esté
entre los assets.

**Auto-update funciona pero el DMG instalado no se firma diferente** —
electron-updater valida la firma del DMG nuevo contra la firma del DMG
actual usando el bundle ID. Como ambos usan `com.agenciaoz.oz-browser`
firmados con la misma identity, valida OK.

---

## Time-to-ship estimate (post-approval Apple)

- Setup primera vez (Pasos 1–4): ~30 min
- Primer `npm run make` firmado (Paso 5): ~10 min
- Verify (Pasos 6–7): ~5 min
- Smoke test auto-update (Paso 8): ~15 min

**Total ~1h** desde "approved" hasta "primer DMG firmado + auto-update
funcional en producción".

---

## Costos recurrentes

- Apple Developer membership: $99/año (renovación anual obligatoria; si
  expira, los DMG existentes siguen funcionando pero no se pueden
  notarizar releases nuevos).
- GitHub Releases: gratis hasta 2GB por asset, sin límite de releases.
  El DMG de OZ pesa ~150 MB → no problema.
