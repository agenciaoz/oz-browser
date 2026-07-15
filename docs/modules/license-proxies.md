# license-proxies

Importa + auto-asigna el bundle de proxies que el servidor de activación entrega por cada clave, y decide el **enforcement fail-closed**. Introducido en v2.0.0-alpha.100.

## Flujo

1. El Worker `oz-activate` devuelve `proxies: [...]` en `/activate` y `/validate` (tabla D1 `proxies` por `key`).
2. `license-manager.js` guarda ese bundle en el record local (`oz-license.json`) y lo expone con `getStoredProxies()`.
3. En boot, `proxy-boot-setup.js#wireProxyBoot()` construye la `StickyRotation`, llama a `license-proxies.bootstrapForBoot(browser, licenseManager, log)` y engancha el resolution hook.
4. `applyManagedProxies()` importa cada proxy al `ProxyManager` (dedup por `host:port:username`, tag `managed`), pone `defaultStrategy = auto-round-robin`, y asigna un proxy a cada identidad **sin binding** (round-robin), respetando las asignaciones manuales del usuario.

## Fail-closed (no navega sin proxy)

`bootstrapForBoot` marca `browser.enforceProxy = (bundle no vacío)` y hace `stickyRotation.setEnforce(enforce)`. Con enforce ON, si `proxyAssignment.resolve()` no devuelve proxy, `buildRulesForIdentity()` retorna `BLACKHOLE_RULES = 'socks5://127.0.0.1:1'` en lugar de `direct://` → toda request falla (`ERR_PROXY_CONNECTION_FAILED`) y **nunca se fuga la IP real**. Installs sin bundle (master/dev) siguen en `direct://`.

## Idempotencia

Seguro de correr en cada boot: re-importar no duplica (dedup), no pisa bindings existentes, y las identidades ya asignadas se saltean.

## Archivos

- `browser/license-proxies.js` — `applyManagedProxies`, `bootstrapForBoot`, `keyOf`, `MANAGED_TAG`.
- `browser/proxy-boot-setup.js` — `wireProxyBoot` (extraído de `main.js` por ADR 0005).
- `browser/proxy-sticky-rotation.js` — flag `enforce` + `BLACKHOLE_RULES`.
- `browser/license-manager.js` — persiste `proxies` + `getStoredProxies()`.

## Tests

- `tests/license-proxies.smoketest.js` (import/dedup/auto-assign/idempotencia).
- `tests/proxy-sticky-rotation.smoketest.js` (sección enforce/blackhole).

Ver también: `docs/ACTIVACION-EQUIPO.md` (operación) y `docs/modules/proxy-sticky-rotation.md`.
