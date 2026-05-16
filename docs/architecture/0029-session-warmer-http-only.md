# ADR 0029 — Session warmer: HTTP-only, no BrowserWindows

**Date:** 2026-05-15
**Status:** Accepted (implementación en K1 / v1.4.1)
**Bloque:** K1-extras — session warmer
**Predecesores:** ADR 0017 (proxy model), Bloque F-1 (Scheduled Actions runner)

## Context

El use case core de OZ Browser es "50 cuentas IG/X logueadas que se queden logueadas". Anti-logout (1.5d) extiende cookie expiry localmente — pero IG/X/FB/etc rotan session cookies server-side en cada request. Sin tráfico real, las cookies vencen aunque el browser nunca las haya borrado.

Solución: triggear tráfico real periódico contra los sites donde las identities tienen accounts. Pero "tráfico real" tiene dos formas:

1. **Full BrowserWindow**: spawn `BrowserWindow({show:false})` con la partition de la identity, navegar a la URL, esperar JS load, cerrar. Pros: comportamiento idéntico a un tab real — el server ve un browser completo con todos sus headers, fetch API, JS-set cookies. Contras: ~50-100MB por window × N identities = 5GB para 50 identities. Slow boot (~500ms-1s per window). Memory pressure si corre cron daily.

2. **HTTP-only via `net.request`**: usa la session de la identity (con su proxy + cookies) para hacer un GET a la URL. Sin JS, sin window. Pros: lightweight (<1MB per request), fast (~200-500ms), runs on cron daily sin problema. Contras: no ejecuta JS, no dispara event handlers que el server pueda esperar.

## Decision

**HTTP-only via `net.request`** en K1 v1.4.1.

Razones:

1. **Cookies se refrescan via Set-Cookie en response headers**: la mayoría de plataformas (IG, X, FB confirmed) reemiten session cookies en respuesta a cualquier GET autenticado a su homepage. JS execution no es necesario para refresh.
2. **Scale-friendly**: 50 identities × 1 request × throttle 1s = 50s de daemon work, ~0 memory overhead. Vs Full BrowserWindow: 50 × 50MB = 2.5GB peak, ~25s solo bootando.
3. **Resilient**: cuando proxy del identity está caído, el request falla rápido (timeout 8s) sin spawning ni teardown de window.
4. **MVP suficiente**: si en producción se descubre que algún provider exige JS execution para refresh (Cloudflare, advanced bot-detection), se puede upgradear a Full BrowserWindow caso por caso (`actionType: 'session-warmer-full'`) sin romper el HTTP-only existing.

## Consequences

✅ **Daemon run viable en cron daily** (or hourly si el user quiere). Resource cost negligible.

✅ **Fácil de testar**: pure logic (`createSessionWarmerHandler` factory) con fakes inyectados. 16 asserts sin Electron real.

⚠️ **Si algún provider exige JS para refresh** (e.g. Cloudflare-protected sites): el handler no logra warm para esos. Workaround: marcar manualmente como `inactive` para skip + abrir manualmente periódicamente. Mitigación futura: handler-2 `session-warmer-full` con BrowserWindow opcional, run cuando un account.status flagea como "needs-js-warm".

⚠️ **No detecta logout server-side**: el handler asume que si el GET devuelve 2xx, todo OK. Si IG devuelve 200 con un body que dice "you need to log in", el warmer no se entera. Anti-logout's cookie watcher es la red de seguridad — detecta cookie removal post-warm y flagea needs_relogin.

## Throttle + cap rationale

- `WARMER_THROTTLE_MS = 1000` (1s entre requests): para no saturar (a) el proxy upstream, (b) la rate limit del platform si pidiéramos a 50 IG accounts at once. 1s es conservador — IG's anti-abuse threshold típico es ~10 req/s before challenge.
- `WARMER_PER_REQ_TIMEOUT_MS = 8000` (8s): suficiente para que proxies lentos en LATAM respondan. Más alto pondría todo el daemon run lento.
- `WARMER_MAX_IDENTITIES = 50` (cap por run): si user tiene 200 identities y cron daily, no queremos un single run que tome 200 × (1s throttle + ~500ms request) = ~5min. Cap a 50 = ~75s. Para users con >50 identities, sugerir dividir en 4 workspaces y crear 4 scheduled actions con horarios escalonados.

## Code location

- `browser/scheduled-action-handlers.js createSessionWarmerHandler` (~190 LOC, pure)
- `tests/session-warmer.smoketest.js` (16 asserts)
- `browser/scheduled-setup.js _buildDeps` — wire-up con identityManager + workspaceManager + accountVault
