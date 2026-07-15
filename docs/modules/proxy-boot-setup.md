# proxy-boot-setup

Wiring de proxies en el boot de la app. Extraído de `main.js` por ADR 0005 (main estaba exacto en 500 LOC). Introducido en v2.0.0-alpha.100; failover agregado en alpha.101.

## Qué hace

`wireProxyBoot(browser, licenseManager, log)` — llamado una vez desde `main.js init()`:

1. Construye `browser.stickyRotation = new StickyRotation({...})` con `proxyAssignment`, `toProxyRulesString` e `identityManager`.
2. **alpha.100:** llama a `license-proxies.bootstrapForBoot(browser, licenseManager, log)` — importa + auto-asigna el bundle de proxies de la licencia y decide el enforcement **fail-closed** (ver ADR 0039 y `docs/modules/license-proxies.md`).
3. **alpha.101:** registra el handler de auto-failover: `proxy-failover.registerFailoverHandler()` → `rotateIdentityProxy(browser, identityId, reason)`. Ver `docs/modules/proxy-failover.md`.
4. Instala el **proxy resolution hook** en `identityManager`: cada sesión nueva de una identity pasa por `stickyRotation.applyForIdentity(identityId, session)` (rota sessid si está stale + `setProxy` en un solo paso). Errores se loggean, no tiran.

## Exporta

- `wireProxyBoot(browser, licenseManager, log)` — única export. Setea `browser.stickyRotation` y (vía bootstrap) `browser.enforceProxy`.

## Dependencias

- `./proxy-assignment` (`toProxyRulesString`)
- `./proxy-sticky-rotation` (`StickyRotation`)
- `./license-proxies` (`bootstrapForBoot`)
- `./proxy-failover` (require lazy dentro de la función, para evitar ciclo en load)

## Gotchas

- Debe correr **antes** de que se materialice cualquier tab: el resolution hook solo aplica a sesiones creadas después del wiring.
- `proxy-failover` se requiere lazy (inline) — si se mueve a require top-level, verificar que no se arme ciclo con `logger`/managers.
- Idempotencia la garantiza `license-proxies` (dedup, no pisa bindings); `wireProxyBoot` en sí asume ser llamado **una sola vez** (no des-registra handlers previos).

## Tests

Cubierto indirectamente por `tests/license-proxies.smoketest.js` (bootstrap) y `tests/proxy-failover.smoketest.js` (handler + rotación). No tiene smoketest propio (42 LOC de glue).

Ver también: `docs/modules/license-proxies.md`, `docs/modules/proxy-failover.md`, `docs/modules/proxy-sticky-rotation.md`, ADR 0039.
