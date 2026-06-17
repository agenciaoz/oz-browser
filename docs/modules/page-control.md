# Page control & network intercept (v3-A / v3-B)

MCP tools que dejan a un agente (Claude/Cursor) manejar una página dentro de la
tab de una **identity** — con su fingerprint + proxy + cookies persistentes.

- **Código:** `page-handlers.js` (DOM boundary), `page-utils.js` + `page-human.js`
  (helpers puros), `network-handlers.js` + `network-utils.js`, catálogos
  `mcp-tools-page.js` + `mcp-tools-network.js`.
- **ADR:** [0036](../architecture/0036-page-control-layer.md). **Plan:** [PLAN-V3-SCRAPING](../PLAN-V3-SCRAPING.md).
- **Activar el MCP:** `OZ_MCP_ENABLED=1` (Settings → Automation, o env var).

Todas las tools reciben `identityId` (obligatorio) y `tabId` opcional (si se
omite, usan la primera tab de la identity; `navigate` crea una si no hay).
Todas devuelven `{ ok, ... }` o `{ __error: { code, message } }`.

## Page tools (`oz.page.*`)

| Tool         | Qué hace                                                  | Args clave                                       |
| ------------ | --------------------------------------------------------- | ------------------------------------------------ |
| `navigate`   | Va a una URL (crea tab si la identity no tiene)           | `url`                                            |
| `getInfo`    | `{url, title}` actuales                                   | —                                                |
| `getText`    | textContent del primer match                              | `selector`                                       |
| `getAttr`    | atributo del primer match                                 | `selector`, `attr`                               |
| `queryAll`   | hasta `limit` matches → `{count, items:[{text,href}]}`    | `selector`, `limit?` (def 50, máx 500)           |
| `eval`       | corre JS arbitrario y devuelve el valor (escape hatch)    | `code`                                           |
| `click`      | click de mouse **real** (scrollIntoView + sendInputEvent) | `selector`, `button?`, `human?`                  |
| `type`       | focus + tipeo char-by-char (key events nativos)           | `selector`, `text`, `delayVarianceMs?`, `human?` |
| `scroll`     | `top` / `bottom` / N px                                   | `to`                                             |
| `waitFor`    | espera a que aparezca un selector (poll) o `timeoutMs`    | `selector?`, `timeoutMs?` (def 5000, máx 60000)  |
| `screenshot` | viewport → PNG base64                                     | —                                                |
| `extract`    | extracción declarativa por schema                         | `schema`                                         |

### `extract` schema

```json
{
  "identityId": "ab12…",
  "schema": {
    "titulo": "h1.product-title",
    "precio": ".price",
    "imagen": { "selector": "img.hero", "attr": "src" }
  }
}
```

→ `{ ok: true, result: { titulo: "...", precio: "...", imagen: "https://..." } }`
(campo `null` si el selector no matchea). Es el gran ahorro de tokens vs traer
el HTML completo.

### Humanization (`human: true`) — v3-B

`click` y `type` aceptan `human: true` (default `false` = comportamiento directo,
sin cambios). Con `human`:

- `click` mueve el cursor por una **curva Bézier** con delays gaussianos antes de
  presionar (en vez de teleport), con pausa down→up.
- `type` usa **cadencia gaussiana** por carácter (~110ms ± 30) en vez de uniforme.

Esto es lo que miran los anti-bot conductuales. Usalo en targets duros; dejalo
off para velocidad en scrapeos benignos.

## Network tools (`oz.network.*`)

Interceptan los requests de la **sesión de la identity**. Default = passthrough.

| Tool       | Qué hace                                                        | Args                             |
| ---------- | --------------------------------------------------------------- | -------------------------------- |
| `block`    | cancela requests cuyo URL matchea patrones                      | `patterns: []` (vacío desactiva) |
| `capture`  | toggle: loguea requests que matchean                            | `on`, `patterns?` (def todos)    |
| `captured` | devuelve el log `{count, items:[{url,method,resourceType,ts}]}` | `limit?` (def 100, máx 500)      |
| `clear`    | resetea block + capture + log                                   | —                                |

**Patrones:** con `*` = glob (`*.doubleclick.net/*`, `https://*/ads/*`); sin `*` =
substring case-insensitive (`analytics`, `doubleclick`).

Ejemplo — acelerar un scrape tirando ads/trackers/imágenes:

```json
{
  "identityId": "ab12…",
  "patterns": ["*doubleclick*", "*googlesyndication*", "*.png", "*.jpg"]
}
```

## Flujo típico de scraping

```
oz.ids.create / oz.ids.list        → elegir/crear identity (fingerprint+proxy)
oz.network.block(ads/trackers)     → opcional, acelera
oz.page.navigate(url)
oz.page.waitFor(selector)
oz.page.scroll('bottom')           → cargar contenido lazy
oz.page.extract(schema)            → datos estructurados
oz.page.screenshot()               → evidencia/debug
```

Para acciones que requieren interacción humana creíble (login, formularios en
sitios con anti-bot): `oz.page.click(..., human:true)` + `oz.page.type(..., human:true)`.

## Notas / pendientes

- `eval` corre JS arbitrario: aceptable en MCP local/confiable; se reevalúa para
  la superficie SaaS pública (v3-real).
- `screenshot` es del viewport (no full-page todavía).
- Pendiente: V3-B (scroll con momentum, idle lognormal, typos), V3-C (stealth
  defaults: webdriver/plugins/WebRTC/timezone-auto-match-al-proxy), V3-D
  (orquestación + headless), V3-E (observabilidad), V3-F (cookie import general).
