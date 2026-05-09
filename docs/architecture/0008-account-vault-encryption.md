# ADR 0008 — Account Vault: encryption con scrypt + AES-256-GCM + Keychain

**Estado:** Propuesto (a aceptar al inicio de Bloque 1.5)
**Fecha:** 2026-05-09

## Contexto

El Account Vault guarda passwords de cuentas de redes sociales. Es el activo más sensible del producto. No puede leakearse aunque alguien tenga acceso físico al disco. Tampoco podemos pedirle al usuario master password cada vez que abre la app (UX mata).

## Decisión

- **Algoritmo:** AES-256-GCM (autenticado, resistente a tampering)
- **Derivación de key:** scrypt(master_password, salt_random, N=2^17, r=8, p=1) → 32 bytes
- **Storage del master key:** macOS Keychain via `keytar`. La key se carga al iniciar la app sin pedir password si Keychain ya la tiene.
- **First-time setup:** user crea master password al primer uso del vault → derivamos key → guardamos en Keychain. Master password también se acepta para "unlock" si Keychain falla (recovery).
- **Rotation:** user puede cambiar master password en Settings → Vault → Rotate. Re-encripta el blob con la nueva key.

## Alternativas consideradas

- **PBKDF2 en lugar de scrypt:** más viejo, peor resistencia a GPU. Descartado.
- **Argon2:** mejor que scrypt en teoría pero npm support menos maduro en arm64. scrypt es el sweet spot práctico.
- **Sin master password (solo Keychain):** riesgo si malware escala privilegios — sin master password no hay segunda barrera. Descartado.
- **Master password siempre prompt al inicio:** UX mata.
- **HSM / Touch ID:** nice-to-have post-MVP. Touch ID via `node-mac-prompt` o similar.

## Esquema del vault

```
data/vault.enc =
  version: 1
  salt: 32 bytes (random, stable)
  iv: 12 bytes (random per write)
  ciphertext: AES-256-GCM(serialize(accounts), key=scrypt(master, salt))
  tag: 16 bytes (GCM auth tag)
```

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

## Consecuencias

- ✅ Resistente a brute-force offline (scrypt cuesta ~1s por intento).
- ✅ Resistente a tampering del archivo (GCM tag).
- ✅ UX: master password 1 vez al setup; después Keychain.
- ⚠️ Si el user pierde el master password Y borra Keychain → vault perdido. Mitigación: snapshot diario en Time Machine (Bloque 1.6) permite restore.
- ⚠️ keytar requiere arm64 build (verificado).
- ⚠️ Vault completo en RAM cuando unlocked. Para 1000 accounts × 500 bytes ≈ 500 KB — OK.

## Referencias

- Bloque 1.5 (CORE) en `../PLAN-MAESTRO.md`
- Doc de feature: `../features/account-vault.md`
- npm: `keytar`, `node:crypto` para scrypt + AES-GCM
