# ADR 0008 — Account Vault: encryption con scrypt + AES-256-GCM + Keychain

**Estado:** Propuesto (a aceptar al inicio de Bloque 1.5) · **Update 2026-05-09 noche** — keytar reemplazado por `@napi-rs/keyring` (mantenido) y xlsx reemplazado por `exceljs` (CVEs sin parchar en xlsx público)
**Fecha:** 2026-05-09

## Contexto

El Account Vault guarda passwords de cuentas de redes sociales. Es el activo más sensible del producto. No puede leakearse aunque alguien tenga acceso físico al disco. Tampoco podemos pedirle al usuario master password cada vez que abre la app (UX mata).

## Decisión

- **Algoritmo:** AES-256-GCM (autenticado, resistente a tampering)
- **Derivación de key:** scrypt(master_password, salt_random, N=2^17, r=8, p=1) → 32 bytes
- **KDF versionado:** el header del vault incluye `kdf: "scrypt-N=2^17,r=8,p=1"` para poder migrar a argon2id en v2 sin romper vaults viejos. Migration path: al siguiente unlock con kdf v1, OZ re-deriva con argon2id y reescribe el blob. Cero downtime.
- **Storage del master key:** macOS Keychain via **`@napi-rs/keyring`** (NO keytar — ver §"Por qué no keytar"). La key se carga al iniciar la app sin pedir password si Keychain ya la tiene.
- **First-time setup:** user crea master password al primer uso del vault → derivamos key → guardamos en Keychain. Master password también se acepta para "unlock" si Keychain falla (recovery).
- **Rotation:** user puede cambiar master password en Settings → Vault → Rotate. Re-encripta el blob con la nueva key.

### Por qué scrypt (no argon2id en v1)

OWASP recomienda argon2id como gold standard hoy (2026). Scrypt sigue siendo aceptable y es lo que usamos en v1 por:

- **Cero dependencias** — `crypto.scryptSync` es built-in Node, no hay que compilar `argon2` (que requiere node-gyp y prebuilt en arm64).
- **Performance bien parametrizada es comparable** — N=2^17, r=8, p=1 es OWASP minimum-acceptable para 2026 y nos da ~1.5s por intento en M2, suficiente para deter brute-force offline.
- **Migration path libre** — al versionar el KDF en el header podemos migrar a argon2id en v2 si los attack costs cambian o aparece motivación regulatoria. Cada vault se migra en su próximo unlock.

Si en el futuro queremos migrar: agregamos `@node-rs/argon2` (NAPI prebuilt arm64), nuevo KDF `argon2id-m=64MiB,t=3,p=4`, dispatch en el unlock por field `kdf` del header. Sub-bloque de ~3h, no bloqueante.

## Por qué no keytar

`keytar` (mantenido por Atom team) está **archivado desde 2023**. Sin commits, sin parches de seguridad. Sigue funcionando hoy pero es deuda técnica que va a tronar cuando Electron 50+ rompa el ABI de NAPI.

Reemplazo: **`@napi-rs/keyring`** (de napi-rs, activo en 2026, NAPI v8) — misma API conceptual (`getPassword/setPassword/deletePassword`), build arm64 nativo verificado, compatible con macOS Keychain + Windows Credential Manager + Linux libsecret. Para nuestra Etapa 8 (Windows) ya viene cubierto.

Alternativa "zero-deps" considerada: shellear a `/usr/bin/security add-generic-password ...` en macOS. Funciona pero **no portable** a Windows/Linux y rompe la regla de no Intel-only Homebrew (Apple Silicon ya viene con `security`, OK; Intel también, OK; Linux no tiene). Descartado por portabilidad.

## Por qué no xlsx (SheetJS community)

Para el Excel I/O del Bloque 1.5 — descubrimos durante la pasada estructural que **`xlsx` en npm tiene CVEs públicos sin parchar**:

- CVE-2023-30533 (Prototype Pollution)
- CVE-2024-22363 (ReDoS)

SheetJS los parchó pero solo en su registro privado/CDN (`https://cdn.sheetjs.com/`, requiere setup adicional). **Como el vault maneja credentials reales del usuario y el Excel lleva esas credentials, NO podemos usar la versión vulnerable.**

Reemplazo: **`exceljs`** — MIT, mantenido, sin CVEs abiertas, API más limpia para read/write con styles. ~3x más pesado en bundle pero corre en main process Electron, no afecta startup ni page load.

## Por qué no speakeasy (TOTP)

`speakeasy` último commit 2018 — abandonado. Para los 2FA seeds del vault usamos **`otplib`** — activo, TS-first, drop-in replacement.

## Alternativas consideradas

- **PBKDF2 en lugar de scrypt:** más viejo, peor resistencia a GPU. Descartado.
- **Argon2:** mejor que scrypt en teoría pero npm support menos maduro en arm64. scrypt es el sweet spot práctico.
- **Sin master password (solo Keychain):** riesgo si malware escala privilegios — sin master password no hay segunda barrera. Descartado.
- **Master password siempre prompt al inicio:** UX mata.
- **HSM / Touch ID:** nice-to-have post-MVP. Touch ID via `node-mac-prompt` o similar.

## Esquema del vault

Decisión: **header JSON estructurado con bytes en base64**. Más limpio para versionar y evolucionar el KDF, debugeable con `cat`+`jq`. El ~33% extra de tamaño por base64 vs binary append es despreciable (vault entero ~500 KB peor caso).

```json
{
  "version": 1,
  "kdf": {
    "algo": "scrypt",
    "N": 131072,
    "r": 8,
    "p": 1,
    "salt": "<base64>"
  },
  "cipher": {
    "algo": "aes-256-gcm",
    "iv": "<base64>",
    "authTag": "<base64>"
  },
  "ciphertext": "<base64>"
}
```

Migration v1→v2 (cuando llegue el día):

1. Unlock con `kdf.algo === "scrypt"` → derive con scrypt → decrypt → obtenemos plaintext.
2. Re-derive con argon2id usando params nuevos (`{algo:"argon2id", m:67108864, t:3, p:4, salt}`).
3. Re-encrypt con la nueva key (mismo AES-256-GCM, nuevo iv).
4. Reescribir el archivo con `version: 2` y el nuevo header.

El dispatch en el unlock es por `kdf.algo`, no por `version`. Eso permite que en v3+ podamos seguir aceptando vaults v1/v2 si nunca hicieron unlock.

`accounts` es un JSON array:

```json
[
  {
    "id": "...",
    "identityId": "...",
    "workspaceId": "...",
    "site": "x.com",
    "username": "@joe",
    "password": "<plaintext>",
    "totpSecret": "<plaintext base32>",
    "lastLogin": 1715000000,
    "notes": ""
  }
]
```

## Snippet de referencia para AES-256-GCM (Node crypto)

GCM en Node `crypto.createCipheriv` / `createDecipheriv` no es plug-and-play — el `authTag` se maneja manualmente. Olvidarlo silenciosamente corrompe el vault. Snippet canónico que vamos a usar:

```js
const crypto = require('crypto')

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag() // ← OBLIGATORIO, sino no hay verificación
  return { iv, ciphertext: ct, tag }
}

function decrypt({ iv, ciphertext, tag }, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag) // ← OBLIGATORIO antes de update/final
  const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return pt.toString('utf-8')
}
```

Si `setAuthTag` falla → `decipher.final()` tira `Unsupported state or unable to authenticate data` → significa: clave incorrecta, salt mal leído, archivo corrupto, o tampering. Tratar como vault inválido y ofrecer restore desde Time Machine.

## Consecuencias

- ✅ Resistente a brute-force offline (scrypt cuesta ~1s por intento).
- ✅ Resistente a tampering del archivo (GCM tag).
- ✅ UX: master password 1 vez al setup; después Keychain.
- ✅ `@napi-rs/keyring` mantenido + portable a Windows/Linux para Etapa 8.
- ✅ `exceljs` y `otplib` libres de CVEs y mantenidos.
- ⚠️ Si el user pierde el master password Y borra Keychain → vault perdido. Mitigación: snapshot diario en Time Machine (Bloque 1.6) permite restore.
- ⚠️ Vault completo en RAM cuando unlocked. Para 1000 accounts × 500 bytes ≈ 500 KB — OK.

## Referencias

- Bloque 1.5 (CORE) en `../PLAN-MAESTRO.md`
- Doc de feature: `../features/account-vault.md`
- npm: `@napi-rs/keyring`, `exceljs`, `otplib`, `node:crypto` (built-in) para scrypt + AES-GCM
- CVEs xlsx: https://github.com/SheetJS/sheetjs/issues/2667 (público, sin patch en npm community version)
