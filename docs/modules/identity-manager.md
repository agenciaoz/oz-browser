# Módulo `identity-manager`

**Path:** `browser/identity-manager.js`
**Líneas:** 270
**Bloque:** 1.2 ✅

## Qué hace

CRUD de Identities con persistencia en `~/Library/Application Support/OZ Browser/identities.json`. Caching de Electron Sessions per-Identity (lazy creation). Default Identity siempre existe y usa `defaultSession` (ver ADR 0003). Per-identity custom User-Agent vía `setUserAgent` aplicado en `getSession()` para identities no-default (ADR 0010). Free-tier cap de 3 identities, bypass con `OZ_TIER=paid` env.

## Exports

| Símbolo | Tipo | Descripción |
|---|---|---|
| `IdentityManager` | class | Manager principal. |
| `IdentityCapError` | Error class | Lanzado por `create()` cuando se supera el cap free. Tiene `code='IDENTITY_CAP_REACHED'`, `current`, `max`. |
| `MAX_IDENTITIES_FREE` | constant | 3 (incluye Default). |

## API de la clase

| Método | Descripción |
|---|---|
| `list()` | Array de identities (copia). |
| `get(id)` | Identity por id, o null. |
| `getDefault()` | Identity isDefault=true. |
| `create({name, color?, userAgent?})` | Crea + persiste + retorna nueva. **Lanza `IdentityCapError`** si free-tier cap superado. |
| `rename(id, name)` | Actualiza name + persiste. (Wrapper sobre `update`). |
| `setColor(id, color)` | Actualiza color + persiste. (Wrapper sobre `update`). |
| `update(id, patch)` | Patch genérico. Whitelist: `name`, `color`, `userAgent`. Si `userAgent` cambia y la session ya está cacheada, llama `setUserAgent` en vivo. Default identity rechaza patches de `userAgent` (warn). |
| `remove(id)` | Elimina (excepto default). NO borra storage en disk (manual cleanup). |
| `getSession(id)` | Devuelve `Session` electron, cacheada. Default → defaultSession. Otras → `persist:identity-<id>` con `setUserAgent(identity.userAgent)` si hay UA custom. |
| `resolve(id)` | `{ identity, session }` — resuelve null/undefined al default. |

## Modelo Identity

```js
{
  id: 'uuid-hex',           // 8 bytes hex (16 chars)
  name: 'string',
  color: '#hex',
  fingerprintSeed: 'uuid',  // para Bloque 1.5 (FingerprintEngine)
  createdAt: timestamp,
  isDefault: boolean,       // solo true en una
  userAgent: 'string'|null  // ADR 0010 — opcional, no aplica a Default
}
```

## Free-tier cap

- `MAX_IDENTITIES_FREE = 3` incluye Default. Free user real: Default + 2 custom.
- Bypass: `OZ_TIER=paid npm start` (dev/internal). En prod, reemplazar con entitlement check de `auth-client.js` (Etapa 5).
- `create()` lanza `IdentityCapError` cuando se supera. El IPC handler `oz:identities:create` lo captura y devuelve `{ __error: { code, message, current, max } }` al renderer en lugar de tirar (UX más limpia).

## Storage

- Path: `app.getPath('userData') + '/identities.json'`
- Formato: JSON pretty-printed
- Atómico: leer todo / escribir todo. Para 100+ identities está bien (file < 100 KB).
- Backup automático en Time Machine (Bloque 1.6).

## Sessions

- `getSession(id)` lazily crea via `session.fromPartition('persist:identity-X', { cache: true })`.
- Cache en `Map<id, Session>` para que todos los tabs de la misma identity compartan el mismo Session object.
- Default Identity → `session.defaultSession` (no partition). Razón: Chrome Web Store extensions necesitan estar en la misma session que `ElectronChromeExtensions` fue inicializado.
- **Custom User-Agent (ADR 0010):** si la identity tiene `userAgent: string`, se aplica con `ses.setUserAgent(ua)` durante la primera resolución de la session. NO se aplica a Default. Cuando `update(id, { userAgent })` se llama después, si la session ya está cacheada, el cambio se aplica en vivo (sin restart).

## Logs (cumple ADR 0009)

- INFO en `_load()` con quantity de identities cargadas.
- DEBUG en `getSession(id)` con cache hit/miss.
- INFO en `create/rename/setColor/remove` con id + outcome.

## Gotchas

- **No borra storage de identity en disk** al `remove()`. La partition queda en `~/Library/Application Support/OZ Browser/Partitions/identity-<id>/`. Hacer cleanup manual si lo borras a propósito (Bloque 1.10 polish).
- Si `identities.json` está corrupto al startup, se inicializa array vacío + se crea Default. Ningún panic.
- `fingerprintSeed` se genera al crear pero NO se usa hasta Bloque 1.5.

## Referencias

- ADR 0003: Default Identity usa defaultSession.
- ADR 0010: Per-identity custom User-Agent.
- Feature: [`../features/identities.md`](../features/identities.md)
- UI editor: [`ui-identity-editor.md`](ui-identity-editor.md)
- Usado por: `tabs.js`, `ipc-handlers.js`, `main.js`.
