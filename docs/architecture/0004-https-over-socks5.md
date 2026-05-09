# ADR 0004 — HTTPS preferido sobre SOCKS5 para proxies

**Estado:** Aceptado
**Fecha:** 2026-05-09

## Contexto

Oxylabs (proveedor que usa Jose) ofrece tanto HTTPS como SOCKS5 endpoints. Necesitamos elegir el default + el que validamos en el spike.

## Decisión

**HTTPS como default.** SOCKS5 queda como opción avanzada en el proxy editor pero no es la ruta principal.

## Alternativas consideradas

- **SOCKS5 default:** túnel TCP completo + DNS por el proxy. Más privacidad. PERO `app.on('login')` ha tenido bugs históricos con SOCKS5 auth en Electron, y el debug es 10× más difícil.
- **Sin preferencia, soportar ambos por igual:** verboseo de UI + más superficie de bugs.

## Consecuencias

- ✅ `app.on('login')` rock-solid para HTTPS proxy auth en Electron 37+.
- ✅ Stack de proxies de Chromium battle-tested con HTTPS.
- ✅ Debug mucho más fácil (network tab del DevTools muestra HTTPS proxy claramente).
- ⚠️ DNS leak risk si el HTTPS proxy no resuelve por su lado. Mitigación en Bloque 1.5: forzar DNS-over-HTTPS o validar que el proxy resuelve.
- ⚠️ SOCKS5 sigue disponible como string en `proxyRules` (`socks5://host:port`). Validar caso por caso en Bloque 1.4.

## Referencias

- Validado en spike Etapa 0 (Oxylabs HTTPS `us-pr.oxylabs.io:10001`)
- Implementado en `etapa-0-spike/main.js` (helper `buildProxyRules`)
- Doc de feature: `../features/proxies.md`
