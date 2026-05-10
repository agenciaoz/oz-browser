# Módulo `account-vault`

**Path:** `browser/account-vault.js`
**Líneas:** ~290
**Bloque/Etapa:** 1.5a (CORE)

## Qué hace

Vault cifrado para credenciales de cuentas de redes sociales (passwords + 2FA secrets + cookies + metadata). Blob JSON serializado y cifrado con AES-256-GCM. Master key auto-generada al primer uso (32 bytes random) y guardada en macOS Keychain via `@napi-rs/keyring`.

Modelo, decisiones crypto y rationale completos en [ADR 0008](../architecture/0008-account-vault-encryption.md).

## Storage

- **Vault file:** `~/Library/Application Support/OZ Browser/data/vault.enc`
- **Master key:** macOS Keychain con `service="oz-browser-vault"`, `account="master-key-v1"`

## Header del vault.enc

```json
{
  "version": 1,
  "mode": "auto",
  "cipher": {
    "algo": "aes-256-gcm",
    "iv": "<base64 12 bytes>",
    "authTag": "<base64 16 bytes>"
  },
  "ciphertext": "<base64 — JSON.stringify(accounts) cifrado>"
}
```

`mode: 'auto'` (key auto-generada en Keychain, sin scrypt) es el único modo soportado en v1. El modo `passphrase` (scrypt + master password humano del ADR original) está reservado en el header para implementación futura si un user pide portabilidad cross-Mac sin Keychain.

## Exports

| Símbolo            | Tipo     | Descripción                                                                       |
| ------------------ | -------- | --------------------------------------------------------------------------------- |
| `Vault`            | class    | Backend principal — instanciado una vez por `Browser` en `main.js` (Bloque 1.5b). |
| `VaultError`       | class    | Error con `.code` para discriminar (LOCKED / VAULT_TAMPERED / etc).               |
| `VAULT_VERSION`    | const    | `1` — incrementar en cambios de header schema.                                    |
| `KEYCHAIN_SERVICE` | const    | `"oz-browser-vault"`                                                              |
| `KEYCHAIN_ACCOUNT` | const    | `"master-key-v1"` — incrementar el sufijo si rotamos la key globalmente.          |
| `_encrypt`         | function | (test only) AES-GCM encrypt → `{iv, ciphertext, authTag}`.                        |
| `_decrypt`         | function | (test only) inverso.                                                              |

## API de `Vault`

| Método             | Returns | Descripción                                                                                            |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------ |
| `await unlock()`   | void    | Lee key del Keychain, descifra blob. Primer uso ever: auto-genera key + crea vault vacío. Idempotente. |
| `lock()`           | void    | Wipea key y accounts en RAM. Próximo `getAccounts()` lanza `LOCKED`.                                   |
| `isUnlocked`       | boolean | (getter) true si la key está cargada.                                                                  |
| `getAccounts()`    | array   | Devuelve copia profunda. Throws `LOCKED` si el vault no está unlocked.                                 |
| `setAccounts(arr)` | void    | Reemplaza la lista entera, re-cifra con IV nuevo, persiste a disk.                                     |
| `destroy()`        | void    | Borra vault file + Keychain key. Próximo `unlock()` = first-time setup again.                          |

## VaultError codes

| Code                     | Cuándo                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| `LOCKED`                 | Operación que requiere unlock antes (getAccounts/setAccounts).              |
| `KEYCHAIN_FAILURE`       | `getPassword`/`setPassword` del Keychain throws (acceso denegado, no init). |
| `KEYCHAIN_BAD_KEY`       | Key existe en Keychain pero no es 32 bytes hex.                             |
| `VAULT_IO_ERROR`         | Read/write de vault.enc falla.                                              |
| `VAULT_CORRUPT`          | Header no parsea o plaintext post-decrypt no es JSON-array.                 |
| `VAULT_TAMPERED`         | AES-GCM authTag verification falla (key incorrecta / archivo modificado).   |
| `VAULT_VERSION_MISMATCH` | Header con `version`/`mode` no soportado.                                   |
| `KEYRING_MODULE_MISSING` | `@napi-rs/keyring` no se puede cargar (instalación rota).                   |
| `BAD_ARG`                | `setAccounts` con argumento que no es array.                                |

## Inyección de Keychain (testabilidad)

```js
const v = new Vault({ keychain: mockKeychainPort, dataDir: '/tmp/...' })
```

`opts.keychain` debe exponer:

- `getPassword(service, account)` → `string | null`
- `setPassword(service, account, password)` → `void`
- `deletePassword(service, account)` → `boolean`

Los tests usan un Map in-memory; el wrapper real default usa `@napi-rs/keyring.Entry`.

## Sensitive data handling

- Accounts viven en RAM **solo mientras unlocked**.
- `lock()` pone `_accounts = null` y hace `_key.fill(0)` antes de release.
- **Nota:** V8 GC no garantiza borrar bytes inmediatamente; para protección contra heap dump real necesitaríamos SecureBuffer (fuera del scope v1).
- Key buffer NO se loggea ni se serializa nunca fuera del Keychain.
- `getAccounts()` devuelve **copia profunda** — mutaciones externas no afectan el state interno hasta `setAccounts()`.

## IV uniqueness (CRÍTICO)

AES-GCM rompe seguridad si el mismo `(key, IV)` se usa con distintos plaintexts. Por eso `_save()` genera **iv nuevo en cada llamada** con `crypto.randomBytes(12)`. Test #6 valida que dos saves consecutivos producen IVs distintos.

## Tests

- `tests/account-vault.smoketest.js` — 30 tests cubriendo:
  - first-time setup (key + vault vacío)
  - round-trip persistence (instance1 set → instance2 get)
  - unlock idempotente
  - lock + getAccounts throws LOCKED
  - getAccounts copia profunda (no shared state)
  - IV cambia en cada save (anti-nonce-reuse)
  - destroy borra file + Keychain
  - Detect tampering → VAULT_TAMPERED
  - Header version mismatch → VAULT_VERSION_MISMATCH
  - Crypto primitives `_encrypt`/`_decrypt` round-trip

## Próximos pasos (1.5b)

- `account-handlers.js` con CRUD que envuelve `vault.setAccounts/getAccounts` + IPC + MCP tools `oz.vault.*` y `oz.accounts.*`.
- Modelo Account final: `{id, identityId, workspaceId, site, username, password, totpSecret?, cookies?, lastLoginAt, lastIp, status, notes, customFields}`.

## Referencias

- [ADR 0008](../architecture/0008-account-vault-encryption.md) — modelo crypto + decisión auto-gen vs passphrase.
- [`identity-manager.md`](identity-manager.md) — patrón análogo (clase con persistencia).
- [`workspace-manager.md`](workspace-manager.md) — idem.
- npm: `@napi-rs/keyring` (Keychain), built-in `crypto` (AES-GCM).
