# Bloque Decodo + proxies por licencia + auto-failover (alpha.99–101)

**Status:** ✅ SHIPPED 2026-07-14 — alpha.101 = Latest firmado, CI verde
**Commits:** `7036d9e` (alpha.99) + `cd42831` (alpha.100) + `20aa66b` (alpha.101) + docs `76c65b7`/`b2a761a`
**Versions:** 2.0.0-alpha.99 → alpha.101 (3 patches)
**Deps nuevas:** 0
**Tests nuevos:** +11 (decodo/providers) +16 (license-proxies + enforce) +17 (failover)

## Origen

Migración de proveedor de proxies Oxylabs → **Decodo** (móvil, ex-Smartproxy) + idea de Jose: "la clave de activación pre-carga los proxies del usuario" — cada miembro del equipo activa la app y le entran SUS proxies ya asignados, sin configurar nada. Requisitos: no navegar sin proxy (fail-closed) y no quedar trabado si un proxy falla (failover).

## Qué se entregó

### alpha.99 — Decodo first-class

- `expandDecodo` en `proxy-providers.js`: expansión puerto-secuencial sticky (`gate.decodo.com:10001+`) + city targeting (`user-X-city-miami`; el país se infiere de la city). UI auto-surface del provider.
- Oxylabs queda deprecado como provider primario (sigue funcionando).

### alpha.100 — proxies por licencia + fail-closed (ADR 0039)

- Server: tabla D1 `proxies` por key; `/activate` y `/validate` devuelven `proxies:[...]`; endpoints `/admin/setproxies`/`getproxies`; dashboard con modal 🌐 + generador "10 Decodo Miami".
- App: `browser/license-proxies.js` (import dedup + auto-assign round-robin sin pisar bindings, idempotente) + `browser/proxy-boot-setup.js` (wiring de boot, extraído de main.js por ADR 0005) + enforcement **fail-closed** en `proxy-sticky-rotation.js` (`BLACKHOLE_RULES='socks5://127.0.0.1:1'` si no resuelve proxy).

### alpha.101 — auto-failover

- `browser/proxy-failover.js`: en `did-fail-load` por error de proxy/túnel (p.ej. `ERR_TUNNEL_CONNECTION_FAILED` transitorio del móvil Decodo), rota la identity a otro proxy sano (menor failureCount) y recarga el tab solo. Cooldown 12s/identity anti-loop. `rotateIdentityProxy()` reutilizable para acción manual futura.

## Issues resueltos

- 502 "no suitable exit node" de Decodo móvil dejaba la página en blanco → failover automático.
- main.js exacto en 500 LOC → split a `proxy-boot-setup.js`.

## Gotchas nuevos

- Username Decodo: `user-X-city-miami` (país se infiere; no requiere `-country-`).
- OZ cachea el proxy en la sesión de la identity → reiniciar para aplicar reasignación.
- El puerto NO separa sesiones en Decodo cuando se usan session tokens; separa el `-session-{id}`.

## Costos

- Trial Decodo 100 MB — uso real del equipo requiere plan pago.

## Próximo paso

- Seed de usuarios restantes (Ata/Marcela/Daniela) en el panel + limpiar claves de test.
- Opcional: botón UI "🔄 Reconnect" para el usuario final (el núcleo `rotateIdentityProxy` ya existe).
