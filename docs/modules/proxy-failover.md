# proxy-failover

Auto-failover de proxies: cuando la carga de un tab falla por el proxy (túnel caído / "no suitable exit node" del móvil Decodo → `ERR_TUNNEL_CONNECTION_FAILED`), rota la identidad a otro proxy sano y recarga el tab automáticamente. Introducido en v2.0.0-alpha.101.

## Problema que resuelve

Los proxies móviles devuelven fallos transitorios de túnel que dejan la página en blanco. En vez de que el usuario quede trabado, el browser se auto-recupera sin intervención.

## Flujo

1. `tabs.js` (clase `Tab`) escucha `did-fail-load` en el webContents del frame principal.
2. Llama a `proxy-failover.onNavFail(tab, code, desc)`.
3. `isProxyError(desc)` filtra: solo errores de proxy/túnel/conexión disparan failover (un 404 legítimo del sitio, no).
4. Con cooldown de 12s por identidad (anti-loop), invoca el handler registrado → `rotateIdentityProxy(browser, identityId)`.
5. `rotateIdentityProxy`: elige un proxy asignable sano distinto del actual (menor `failureCount`), lo asigna a la identidad (`proxyAssignment.assignToIdentity`) y lo aplica a la sesión (`stickyRotation.applyForIdentity`).
6. Al resolver, `onNavFail` recarga el tab (`tab.reload()`).

## Errores considerados "de proxy"

`ERR_TUNNEL_CONNECTION_FAILED`, `ERR_PROXY_CONNECTION_FAILED`, `ERR_PROXY_CERTIFICATE_INVALID`, `ERR_SOCKS_CONNECTION_FAILED`, `ERR_CONNECTION_TIMED_OUT`, `ERR_TIMED_OUT`, `ERR_CONNECTION_RESET/CLOSED/REFUSED`, `ERR_EMPTY_RESPONSE`.

## Manual

`rotateIdentityProxy(browser, identityId, reason)` es el núcleo reutilizable — compartido por el auto-failover y el **Reconnect manual (alpha.102)**:

- **UI:** clic derecho en la identity (sidebar) → "🔄 Reconnect proxy" (`identity-context-menu.js`). Rota + recarga los tabs de la identity; si no hay proxy sano muestra un dialog informativo.
- **MCP:** `oz.proxies.reconnect({identityId})` → `{ok, from, to, reloaded}` o `{ok:false, reason}`.
- **Handler:** `proxy-handlers.js#reconnect(identityId)` — rota, recarga tabs vía `tabs.refreshAllInIdentity` y emite `oz:proxies:changed`. Tests: `tests/proxy-reconnect.smoketest.js` (15).

La reasignación manual a un proxy específico sigue disponible vía `oz.proxies.assignId`.

## Registro

`proxy-boot-setup.js#wireProxyBoot()` llama a `registerFailoverHandler(...)` en boot, conectando el handler con el `browser` (proxyManager + proxyAssignment + stickyRotation).

## Archivos

- `browser/proxy-failover.js` — `onNavFail`, `rotateIdentityProxy`, `pickFailoverProxy`, `isProxyError`, `registerFailoverHandler`.
- `browser/tabs.js` — listener `did-fail-load` en `_materializeWith`.
- `browser/proxy-boot-setup.js` — registro del handler.

## Tests

`tests/proxy-failover.smoketest.js` (17 asserts): clasificación de errores, selección de proxy sano, rotación, debounce/cooldown, reload.

Relacionado: `docs/modules/proxy-sticky-rotation.md` (fail-closed enforcement) y `docs/modules/license-proxies.md`.
