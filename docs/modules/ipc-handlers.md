# Módulo `ipc-handlers`

**Path:** `browser/ipc-handlers.js`
**Líneas:** 190
**Bloque:** 1.2 ✅

## Qué hace

Registra todos los `ipcMain.handle()` del proyecto, organizados por dominio. Recibe la instancia de Browser para acceder al estado (identityManager, windows, activeIdentityId, etc.).

## Exports

| Símbolo | Tipo | Descripción |
|---|---|---|
| `registerIpcHandlers(browser)` | function | Registra TODOS los IPC channels. |

## IPC channels registrados

### Logging / errors

| Channel | Args | Returns | Descripción |
|---|---|---|---|
| `oz:log` | level, source, message, args[] | true | Forward log desde renderer al logger. |
| `oz:report-error` | detail{message,stack,filename,lineno,colno,reason?} | true | Loggea + showErrorDialog. |

### Identities

| Channel | Returns | Descripción |
|---|---|---|
| `oz:identities:list` | Identity[] | Lista todas. |
| `oz:identities:get(id)` | Identity\|null | Por id. |
| `oz:identities:getActive` | string | Active identity id. |
| `oz:identities:setActive(id)` | bool | Cambia activa + broadcast `active-changed`. |
| `oz:identities:create({name, color?, userAgent?})` | Identity \| `{__error}` | Crea + broadcast `changed`. Si free-tier cap superado, devuelve `{__error: {code:'IDENTITY_CAP_REACHED', message, current, max}}` (no throw, UX más limpia). |
| `oz:identities:rename(id, name)` | Identity\|null | Rename + broadcast `changed`. |
| `oz:identities:setColor(id, color)` | Identity\|null | SetColor + broadcast `changed`. |
| `oz:identities:update(id, patch)` | Identity\|null | Patch genérico (whitelist `name`, `color`, `userAgent`) + broadcast `changed`. ADR 0010. |
| `oz:identities:remove(id)` | bool | Remove (excepto default) + broadcast. |

### Tabs

| Channel | Returns | Descripción |
|---|---|---|
| `oz:tabs:list` | Tab[] | Todas las tabs across windows. |
| `oz:tabs:getIdentity(tabId)` | string\|null | Identity de un tab. |
| `oz:tabs:openInIdentity(identityId, url)` | tabId | Crea tab lazy en identity. |
| `oz:tabs:select(tabId)` | bool | Activa (materializa si lazy). |
| `oz:tabs:close(tabId)` | bool | Remove. |
| `oz:tabs:bulkCreateLazy(count, identityId, urlTemplate?)` | count | Stress test / bulk import helper. |

### Navigation

| Channel | Returns | Descripción |
|---|---|---|
| `oz:nav:back` | bool | Tab focused: navigationHistory.goBack si canGoBack. |
| `oz:nav:forward` | bool | Idem forward. |
| `oz:nav:reload` | bool | tab.reload(). |
| `oz:nav:loadURL(url)` | bool | tab.loadURL(url). |

## Patrón de organización

Cada dominio tiene su propia función `register*Handlers(browser)`. La función exportada `registerIpcHandlers(browser)` solo las invoca en orden.

```js
function registerIpcHandlers(browser) {
  registerLogHandlers(browser)
  registerIdentityHandlers(browser)
  registerTabHandlers(browser)
  registerNavHandlers(browser)
}
```

Si un dominio crece, lo movemos a su propio archivo (`identity-ipc.js`, etc.) — manteniendo la regla 500 LOC.

## Logs (cumple ADR 0009 — pendiente reforzar)

Por implementar: cada handler debe loggear DEBUG al entrar (con args sanitizados) e INFO al salir (con outcome + duration). Ahora algunos lo hacen, otros no — uniformizar en Bloque 1.X "log enrichment".

## Gotchas

- Los handlers son CLOSURES sobre la instancia de browser pasada. Si reasignas `browser.identityManager`, los handlers ya registrados siguen apuntando al viejo via la closure. Esto NO pasa en flow normal (el manager se setea una vez), pero ojo en testing.
- `ipcMain.handle` es promise-returning. Si throws, el caller (renderer) recibe error. Siempre wrapear en try/catch o usar `wrapHandler` de error-handler.
- `broadcastToWebUI` (en main.js) envía a TODOS los WebUI webContents. Si tienes 5 windows, todas reciben el evento. La sidebar de cada window decide qué hacer.

## Referencias

- ADR 0009 (logging).
- Módulos relacionados: [`main.md`](main.md), [`identity-manager.md`](identity-manager.md), [`tabs.md`](tabs.md).
