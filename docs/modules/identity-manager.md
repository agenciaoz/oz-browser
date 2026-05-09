# Módulo `identity-manager`

**Path:** `browser/identity-manager.js`
**Líneas:** 177
**Bloque:** 1.2 ✅

## Qué hace

CRUD de Identities con persistencia en `~/Library/Application Support/OZ Browser/identities.json`. Caching de Electron Sessions per-Identity (lazy creation). Default Identity siempre existe y usa `defaultSession` (ver ADR 0003).

## Exports

| Símbolo | Tipo | Descripción |
|---|---|---|
| `IdentityManager` | class | Manager principal. |

## API de la clase

| Método | Descripción |
|---|---|
| `list()` | Array de identities (copia). |
| `get(id)` | Identity por id, o null. |
| `getDefault()` | Identity isDefault=true. |
| `create({name, color?})` | Crea + persiste + retorna nueva. |
| `rename(id, name)` | Actualiza name + persiste. |
| `setColor(id, color)` | Actualiza color + persiste. |
| `remove(id)` | Elimina (excepto default). NO borra storage en disk (manual cleanup). |
| `getSession(id)` | Devuelve `Session` electron, cacheada. Default → defaultSession. Otras → `persist:identity-<id>`. |
| `resolve(id)` | `{ identity, session }` — resuelve null/undefined al default. |

## Modelo Identity

```js
{
  id: 'uuid-hex',           // 8 bytes hex (16 chars)
  name: 'string',
  color: '#hex',
  fingerprintSeed: 'uuid',  // para Bloque 1.5 (FingerprintEngine)
  createdAt: timestamp,
  isDefault: boolean        // solo true en una
}
```

## Storage

- Path: `app.getPath('userData') + '/identities.json'`
- Formato: JSON pretty-printed
- Atómico: leer todo / escribir todo. Para 100+ identities está bien (file < 100 KB).
- Backup automático en Time Machine (Bloque 1.6).

## Sessions

- `getSession(id)` lazily crea via `session.fromPartition('persist:identity-X', { cache: true })`.
- Cache en `Map<id, Session>` para que todos los tabs de la misma identity compartan el mismo Session object.
- Default Identity → `session.defaultSession` (no partition). Razón: Chrome Web Store extensions necesitan estar en la misma session que `ElectronChromeExtensions` fue inicializado.

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
- Feature: [`../features/identities.md`](../features/identities.md)
- Usado por: `tabs.js`, `ipc-handlers.js`, `main.js`.
