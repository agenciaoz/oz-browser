# Módulo `tabs`

**Path:** `browser/tabs.js`
**Líneas:** 334
**Bloque:** 1.2 ✅

## Qué hace

Gestiona Tabs con **lazy materialization** (ADR 0002). Cada Tab es un stub JS hasta primer click; el `WebContentsView` y el renderer process solo se crean entonces.

## Exports

| Símbolo | Tipo | Descripción |
|---|---|---|
| `Tab` | class | Pestaña individual con lifecycle lazy → materialized. |
| `Tabs` | class extends EventEmitter | Lista de tabs de una BrowserWindow. |

## Tab — propiedades

| Prop | Tipo | Descripción |
|---|---|---|
| `id` | string (UUID) | ID estable. NO cambia con materialización. |
| `identityId` | string | Bound a una Identity. |
| `pendingUrl` | string\|null | URL queued, se carga al materialize. |
| `title` | string | Título mostrado en sidebar/topbar. |
| `favicon` | string\|null | URL del favicon. |
| `materialized` | boolean | true si ya tiene WebContentsView vivo. |
| `view` | WebContentsView\|null | El view (null si lazy). |
| `webContents` | WebContents\|null | Idem. |
| `webContentsId` | number\|null | (getter) `webContents.id` para Chrome tabs API. |

## Tab — métodos

| Método | Descripción |
|---|---|
| `materialize()` | Crea WebContentsView con la session de su Identity, attach al window, load URL queued. Idempotente. |
| `loadURL(url)` | Si materialized → loadURL real. Si lazy → queue en `pendingUrl`. |
| `show()` | Materializa si no lo está, layout, setVisible(true). |
| `hide()` | setVisible(false). No-op si lazy. |
| `reload()` | webContents.reload(). No-op si lazy. |
| `destroy()` | Cleanup: removeChildView + webContents.destroy(). |
| `serialize()` | JSON-safe view para sidebar UI. |

## Tabs — eventos emitidos

| Evento | Payload | Cuándo |
|---|---|---|
| `tab-created` | `tab` | Tab agregado a tabList (lazy). |
| `tab-materialized` | `tab` | Tab materializado por primera vez. |
| `tab-updated` | `tab, info` | Title / favicon / URL cambió. |
| `tab-selected` | `tab` | `select(id)` ejecutado. |
| `tab-destroyed` | `tab` | Tab eliminado. |

## Tabs — métodos

| Método | Descripción |
|---|---|
| `get(tabId)` | Por OZ tab id. |
| `getByWebContentsId(wcId)` | Por chrome tab id (= webContents.id). Solo materialized. |
| `create({identityId, url, title, materialize?, webPreferences?, webContents?})` | Crea Tab. Por default lazy; `materialize: true` para eager. |
| `select(tabId)` | Materializa si necesario, hide del previous, show del nuevo. |
| `remove(tabId)` | Destroy + emit. |
| `serializeAll()` | Array JSON para `oz:tabs:list`. |

## Layout

- `TOOLBAR_HEIGHT = 64` (CSS topbar)
- `SIDEBAR_WIDTH = 220` (CSS sidebar)
- Tab WebContentsView se posiciona en `(SIDEBAR_WIDTH+4, TOOLBAR_HEIGHT)` con tamaño remanente. Si cambias el CSS, cambia las constantes acá también.

## Gotchas

- Stable id ≠ webContents.id. Para integrar con Chrome tabs API (que key por webContents.id), usar `getByWebContentsId()`.
- `tab-created` fires for lazy tabs. `tab-materialized` solo cuando se materializa. Si quieres registrar con `ElectronChromeExtensions.addTab()`, hacelo en `tab-materialized` (no antes — webContents no existe).
- `materialize()` es idempotente.
- Si caller pasa `webContents` pre-existente (window.open handler), se materializa eager con ese webContents (no se crea uno nuevo).

## Logs

- INFO en create con tabId + identityId + lazy/eager.
- INFO en materialize con tabId + URL + duration.
- DEBUG en select desde→hasta.

## Referencias

- ADR 0002: lazy tabs.
- Feature: [`../features/identities.md`](../features/identities.md) (tabs son parte de cómo se usan identities).
- Usado por: `window-manager.js`, `ipc-handlers.js`.
