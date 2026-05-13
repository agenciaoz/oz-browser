# Módulo `sync-record-store`

**Path:** `browser/sync-record-store.js`
**Líneas:** ~220
**Bloque:** D-3a ✅
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §7 (encryption format)

## Qué hace

Encrypt/decrypt de sync records con AES-256-GCM usando la master key del vault (mismo patrón que `backup-manager` de D-1, formato idéntico para consistency).

## Formato on-disk

```
[headerLen u32 LE][headerJson UTF-8][iv 12B][authTag 16B][ciphertext]
```

- **Header plaintext visible** — Dropbox `listFolder`/`getMetadata` ve `schemaVersion`/`updatedAt`/`deviceFolder`/`recordType`/`recordId`/`deleted` sin descifrar (necesario para LWW + cursor scans cheap).
- **Body cifrado** — JSON del record (identity/workspace/bookmark) protegido con auth-tag → tampering detection garantizada por GCM.
- **Tombstones** — `header.deleted = true`, body cifrado es `{}` (decoder lo normaliza a `null`).

## Exports

| Símbolo                 | Tipo     | Descripción                                                    |
| ----------------------- | -------- | -------------------------------------------------------------- |
| `encodeRecord(k, h, b)` | function | Buffer → upload-ready. Throws en body invalido para el tipo.   |
| `decodeRecord(k, buf)`  | function | `{header, body}`. Throws en tampering / wrong key / malformed. |
| `SyncRecordStoreError`  | class    | Error con `.code` para casos específicos (ver tabla abajo).    |
| `IV_BYTES`              | const    | 12.                                                            |
| `AUTHTAG_BYTES`         | const    | 16.                                                            |
| `MAX_PAYLOAD_BYTES`     | const    | 5 MB (sanity cap).                                             |

## Códigos de error

| code                 | cuándo                                          |
| -------------------- | ----------------------------------------------- |
| `BAD_KEY`            | master key no es Buffer de 32 bytes.            |
| `BAD_INPUT`          | decodeRecord recibe algo que no es Buffer.      |
| `HEADER_INVALID`     | header faltan campos o son del tipo incorrecto. |
| `HEADER_CORRUPT`     | header bytes no parsean como JSON.              |
| `HEADER_TOO_LARGE`   | header JSON > 64KB (sanity).                    |
| `BAD_HEADER_LEN`     | headerLen ≤ 0 o > MAX_HEADER_BYTES.             |
| `BUFFER_TOO_SMALL`   | buffer < headerLen + IV + authTag.              |
| `TRUNCATED`          | headerLen indica más bytes que los disponibles. |
| `DECRYPT_FAILED`     | wrong key, tampered ciphertext, o authTag bad.  |
| `TOMBSTONE_HAS_BODY` | encode con deleted=true y body !== null.        |
| `MISSING_BODY`       | encode non-tombstone con body inválido.         |
| `PAYLOAD_TOO_LARGE`  | total > 5MB.                                    |

## Tests

39 assertions en `tests/sync-record-store.smoketest.js`. Round-trip happy path + tombstone + tampering (byte flip en ciphertext / authTag) + wrong key + bad inputs + truncation + IV uniqueness probabilística (32 trials, 0 colisiones).

## Gotchas

- IV es generado fresh cada encode (12 random bytes) — nunca reutilizar.
- El header timestamp **debe** estar en ISO 8601 — sync-merge depende de Date.parse comparisons.
