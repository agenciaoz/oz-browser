# PLAN V3 — Scraping / Agent-control mode

**Estado:** Scoping (planificación, sin código). **Fecha:** 2026-06-17.
**Pedido origen:** Jose, 2026-05-13 — "un browser optimizado para que vos (Claude/Cursor) lo controles fácil para scrapeo, con anti-detección built-in, hecho súper bacán para eso".
**Gate previo:** v1 ✅ cerrado · v2 (Automation Engine + paridad Ghost del sidebar) ✅ cerrado al alpha.47. v3 ya está **desbloqueado** para arrancar.

> Este es el documento de planificación. El detalle de implementación por sub-bloque se irá expandiendo acá a medida que se ejecute, igual que `PLAN-AUTOMATION-F-K.md` hizo para v2.

---

## 1. Objetivo y diferenciador

Convertir OZ en un **browser agent-controlled para scraping** con anti-detección de serie y una API (MCP) que Claude/Cursor manejen sin fricción.

**Diferenciador real vs Puppeteer / Playwright / Browserless:** OZ ya tiene **persistencia a nivel sistema operativo** de identities + proxies + cookies + fingerprint, no efímero por-proceso. Es decir: cada "identidad" es un dispositivo creíble y estable en el tiempo (mismo canvas/WebGL/UA/proxy/cookies entre corridas), no un perfil limpio que se quema en cada run. Eso es exactamente lo que los anti-bots premium (Cloudflare BM, DataDome) miran: consistencia e historia, no solo el user-agent.

---

## 2. Cimientos ya construidos (NO rehacer) — verificado 2026-06-17

| Cimiento                                                                                                       | Estado | Sirve para v3                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| **MCP server interno** (HTTP/JSON-RPC, ~139 tools, port 9223, `OZ_MCP_ENABLED=1`)                              | ✅     | Solo agregar tools de página; cero rearquitectura                      |
| **FingerprintEngine** (canvas/WebGL/fonts/screen/timezone/UA determinístico por identity, RNG con seed)        | ✅     | Base del stealth; falta audio FP + algunos shims                       |
| **Per-identity StoragePartition + Cookies + Login Data**                                                       | ✅     | Aislamiento real por identidad                                         |
| **Per-identity proxy** (jerarquía Identity > Workspace > default; Oxylabs/Bright Data; sticky-sessid rotation) | ✅     | Proxy por identidad + rotación; falta WebRTC/timezone auto-match al IP |
| **Anti-logout + Anti-detect-health** (polling stealth + health checks)                                         | ✅     | Monitoreo de salud anti-detección                                      |
| **Bulk Runner + scheduling** (corre acciones en N identidades con delays)                                      | ✅     | Base de orquestación (bloque D se apoya acá)                           |
| **Cookies import en 5 formatos** (`oz.cookies.*`, `oz.sessions.importCookies`)                                 | ✅     | Onboarding rápido de cuentas sin re-loguear                            |

**Lo que NO existe hoy (greenfield):** tools de control de página (`oz.page.*`), intercept de red (`oz.network.*`), humanization layer (mouse/teclado/scroll realistas), stealth shims avanzados (webdriver/plugins/WebRTC/JA3), y observabilidad de jobs de scraping.

---

## 3. Sub-bloques

### V3-A — Page control tools (MCP) · ~25-35h

> **Estado: ✅ COMPLETO (alpha.48–50).** Slice 1 (`alpha.48`): `navigate/getInfo/getText/getAttr/queryAll/eval`. Slice 2 (`alpha.49`): `click` (sendInputEvent real), `type`, `scroll`, `waitFor`, `screenshot`, `extract`. Slice 3 (`alpha.50`): `oz.network.block/capture/captured/clear`. Total: 12 page tools + 4 network tools. (ADR 0036.) Próximo: V3-B humanization.

El core: que el agente pueda manejar la página. Tools nuevas en un módulo `mcp-tools-page.js` + handlers `page-handlers.js` (respetando budget 500 LOC, ADR 0005).

- `oz.page.navigate({identityId, tabId?, url})` + `goBack/goForward/reload`
- `oz.page.click({selector, button?, nth?})`
- `oz.page.type({selector, text, delayVarianceMs?})`
- `oz.page.scroll({direction|to: 'bottom'|'top'|px})`
- `oz.page.waitFor({selector | navigation | networkIdle | timeoutMs})`
- `oz.page.screenshot({fullPage?, selector?}) → base64 png`
- `oz.page.eval({code, timeoutMs}) → result` (sandboxeado)
- `oz.page.getText/getAttr/querySelectorAll({selector})`
- `oz.page.extract({schema}) → {campo: valor}` — extracción declarativa CSS-based (el gran ahorro de tokens para el agente)

Implementación: vía `webContents.executeJavaScript` + `sendInputEvent` para clicks/teclas reales (no synthetic events, que son detectables). Cada tool resuelve la identity→tab→webContents.

**Tests:** unit de los helpers de selector/schema + smoke con una página local servida.

### V3-B — Humanization layer · ~20-30h

La diferencia entre "se nota bot" y "pasa Cloudflare". Capa que envuelve A.

- Mouse con curvas Bézier (no teleports) — candidato `ghost-cursor` (MIT) adaptado a `sendInputEvent`
- Teclas con delay por-carácter gaussiano (80-150ms ± 30) + typos ocasionales con corrección
- Scroll con momentum/easing
- Delay de click 80-300ms post-hover
- Idle entre acciones con distribución lognormal

Flag por-tool `human: true|false` (off para velocidad, on para targets duros).

> **Estado: EN CURSO.** Slice 1 ✅ `v2.0.0-alpha.51`: `click` (Bézier + gaussian) y `type` (cadencia gaussiana) detrás de `human:true` (default off). Pure `page-human.js` (bezier/gaussian/keystrokeDelays). Pendiente: scroll con momentum, idle lognormal entre acciones, typos+corrección.

### V3-C — Stealth defaults always-on · ~15-20h

> **Estado: ✅ COMPLETO (alpha.55 + alpha.58).** Shims always-on en alpha.55
> (`navigator.webdriver`=false, `chrome.runtime` shape, `permissions.query`
> coherente). **alpha.58 cierra el timezone/Accept-Language auto-match:** al
> asignar un proxy con país conocido a una identity, se aplica automáticamente
> su timezone + languages + locale al fingerprint y se refresca el
> Accept-Language de la sesión viva (header q-weighted estilo Chrome, derivado
> de `fp.languages` — antes mandábamos un solo idioma = mismatch). Respeta
> override manual (`geoSource:'manual'`) y el switch `privacy.autoMatchGeo`
> (default ON). Helpers puros en `geo-match.js` + tests. Pendientes opcionales:
> WebRTC leak prevention (STUN por proxy, mDNS off), audio FP randomization,
> y lookup ip-api real (hoy se usa el país del proxy, que cubre el caso real
> de Oxylabs/Bright Data sin red extra).

- `navigator.webdriver` = undefined forzado ✅
- `navigator.plugins` realista por OS+UA ✅ (vía blueprints)
- WebRTC leak prevention (STUN por el proxy, mDNS off) — pendiente
- **Timezone + Accept-Language auto-match a la geo del proxy** ✅ (alpha.58)
- Audio fingerprint randomization — pendiente
- `chrome.runtime` con shape correcto ✅

### V3-D — Orquestación · ~10-15h (se apoya en Bulk Runner v2)

> **Estado: EN CURSO.** Slice 1 ✅ `v2.0.0-alpha.59`: **detección de captcha**
> (`oz.page.captcha`) — sentinels reCAPTCHA/hCaptcha/Turnstile/Cloudflare
> challenge/DataDome/PerimeterX + fallback de texto → alerta urgente, **NO**
> resuelve. Pure `scrape-captcha.js` + tests. Slice 2 ✅ `v2.0.0-alpha.60`:
> **retry con backoff exponencial por clase de error** — `scrape-retry.js`
> (puro: `classifyError` clasifica network/timeout/navigation como retryables;
> captcha/needs_login/rate-limit/aborted/fatal NO; `backoffDelay` exponencial
> con equal-jitter; `buildRetryPolicy`/`shouldRetry`) + `bulk-runner-retry.js`
> (glue `runWithRetry`/`executeItemWithRetry`). Opt-in por run vía
> `options.retry`; respeta AbortSignal y el `clock` inyectable. `_realClock`
> extraído a `bulk-runner-clock.js` por budget LOC. 13 tests con fake clock.
> Slice 3 ✅ `v2.0.0-alpha.61`: **rate-limit por dominio** (`DomainRateLimiter`).
> Slice 4 ✅ `v2.0.0-alpha.62`: **crawl frontier persistente** (`CrawlFrontier`).
> Slice 5 ✅ `v2.0.0-alpha.63`: **modo headless** (CLI + runner, código completo;
> smoke en vivo pendiente). Pendiente del bloque: orquestador de ejecución
> paralela que ate `DomainRateLimiter` + `CrawlFrontier` + page-tools.

- Correr N identidades en paralelo (`runScrapeJob`, orquestador) ✅ (alpha.64) — ata `CrawlFrontier` + `DomainRateLimiter` + retry, `worker` inyectable, concurrency/maxPages/follow-links/AbortSignal. Falta: adapter del `worker` real (identity + page-handlers) + smoke en vivo.
- Rate-limit por dominio (`DomainRateLimiter`, espaciado next-available) ✅ (alpha.61).
- **Detección** de captcha (heurística + sentinels reCAPTCHA/hCaptcha) → alerta, **NO** resolver ✅ (alpha.59)
- Retry con backoff exponencial por clase de error ✅ (alpha.60)
- Crawl frontier persistente (JSON) ✅ (alpha.62) — `CrawlFrontier` dedupe + visited + depth + reintentos + persistencia atómica.
- **Headless** (`--headless --identity --recipe`) ✅ código (alpha.63): parser CLI + `runHeadlessRecipe` (driver=page-handlers inyectable, retry por paso, recipe JSON validado) + bootstrap `headless-setup.js` wireado en `main.js` detrás del flag. **Falta smoke en vivo** (toca Electron) + override de `--proxy` + ventana oculta (hoy reusa la ventana inicial).

> **Resumen V3-D:** lógica del bloque COMPLETA y testeada (captcha, retry/backoff,
> rate-limit por dominio, crawl frontier, headless CLI+runner, orquestador
> paralelo `runScrapeJob`). Lo único que resta son los **glues a Electron + sus
> smokes en vivo** (no smokeables en sandbox): (a) smoke del modo headless en la
> Mac de Jose (+ override `--proxy` + ventana oculta), y (b) adapter del `worker`
> real del orquestador (asigna identity + corre page-handlers) + su smoke. El
> motor de scraping ya es usable vía MCP `oz.page.*` hoy; el orquestador y el
> headless agregan automatización masiva por encima.

### V3-E — Observabilidad · ~10h

- Action log por job (cada call con timestamp + result)
- Timeline de screenshots
- Cost tracker (bytes de proxy vía API Oxylabs, tiempo, eventos captcha)

### V3-F — Cookie/storage import general-purpose · ~4-6h

> **Estado: ✅ CORE COMPLETO.** Los tools `oz.cookies.importStr` / `oz.cookies.importFile` (en `mcp-tools-tab-context.js`, sobre `cookies-handlers`+`cookies-io`) ya hacen import general per-identity en 5 formatos (oz/netscape/adspower/multilogin/header) — onboarding instantáneo de cuentas logueadas por MCP. **Pendiente (opcional):** UI "Import cookies…" en el menú de identidad + soporte localStorage. Lo único que resta es renderer/UX (smoke Electron).

---

## 4. Lo trickiest (evaluación honesta)

- **TLS/JA3 fingerprint:** Chromium controla el handshake TLS; cambiar JA3 sin recompilar Chromium con patches custom es casi imposible en Electron stock. Si el target usa detección por JA3 (Cloudflare Bot Management, DataDome, PerimeterX) no hay bypass limpio a este nivel. **Workaround:** proxies residenciales premium que hacen TLS-spoof de su lado (Oxylabs Premium Residential lo ofrece). En v3 SaaS sería un **tier premium**: solo clientes pagos acceden a esos proxies.
- **Captcha:** v3 ofrece **detección + alerta, NO solve** (gris legal). Si el cliente quiere resolver, integra 2captcha/anti-captcha por su cuenta y lo paga él; envolverlo en un MCP tool está ok, el servicio externo es responsabilidad del usuario.
- **Cat-and-mouse:** los anti-bot cambian rápido (modelos ML behaviorales). La "garantía" de no-detección no existe — el pricing/marketing de v3 debe decir **"best effort"**, no "indetectable".

---

## 5. Secuencia recomendada + MVP

**MVP de scraping (lo mínimo para que sea útil para vos/agencia): V3-A + V3-D-básico + V3-F ≈ 35-50h.** Con eso el agente ya navega, clickea, extrae y corre en N identidades con retry — suficiente para scrapeos propios donde el target no es Cloudflare-duro.

Orden sugerido:

1. **V3-A** (page tools) — desbloquea todo lo demás.
2. **V3-F** (cookie import) — barato, alto valor de onboarding.
3. **V3-C** (stealth defaults, sobre todo timezone/lang auto-match) — barato y sube mucho la tasa de éxito.
4. **V3-D** (orquestación + headless).
5. **V3-B** (humanization) — cuando enfrentes targets duros.
6. **V3-E** (observabilidad) — cuando haya volumen que medir.

**Estimado total v3 completo: ~80-115h.**

---

## 6. Decisiones pendientes para Jose

1. **¿v3 para uso propio/agencia primero, o directo SaaS público?** Cambia prioridades (SaaS necesita E + tiers de proxy desde temprano; uso propio puede ir con el MVP A+D+F).
2. **¿Arrancamos por el MVP (A+F+C, ~45-60h) o el set completo?**
3. **JA3/proxies premium:** ¿activamos el camino "proxy con TLS-spoof" como dependencia desde el inicio, o lo dejamos como tier posterior?
4. **Captcha:** confirmar política "solo detección" (recomendado) vs envolver solvers externos.

> Cuando Jose elija, arrancamos por **V3-A** como primer alpha de la línea v3 (`3.0.0-alpha.1`), mismo método que v2: sub-bloques chicos, cada uno shippeable con CI verde + tests.
