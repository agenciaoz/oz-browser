# Ghost Browser — Perfil técnico completo (mayo 2026)

## Resumen ejecutivo

Ghost Browser es un **fork cerrado de Chromium** mantenido por **Webatix** (activo desde 2015). Su propuesta de valor NO es antidetect — es **productividad por aislamiento de cookie jars**: loguear muchas cuentas en el mismo sitio en una sola ventana, con tabs de colores, y opcionalmente rutearlas por proxies distintos. Stack 2026: Chromium ~129 (desde v2.4, oct 2024; build actual 2.4.1.2 de ago 2025), corre en Windows 10+, macOS 11+, Ubuntu/Debian 64-bit. No mobile.

Tres primitivas dominan el producto:

- **Identities permanentes**: nombradas, color-coded, persistentes entre reinicios, con proxy y user-agent dedicados opcionales.
- **Temporary Identities** (antes "Sessions"): efímeras, scoped a un Workspace, destruidas al cerrar la última pestaña, **máx 25 por Workspace**.
- **Workspaces**: sets de pestañas guardados con estado, "freezable", archivables.

Los proxies se manejan con **Ghost Proxy Control (GPC)**, su extensión propia. Jerarquía estricta: **Tab > Identity > Workspace**. Auto-rotate opcional que cicla un pool importado por CSV cada vez que se abre Tab o Temporary Identity nueva.

**No es antidetect.** Tiene defensas opt-in (off por default) — Canvas noising, Font scale spoof, Disable WebRTC, Disable 3D APIs, custom UA por Identity, y desde v2.4.1.1: timezone spoof + hardware concurrency spoof. NO randomiza WebGL vendor, AudioContext, fonts, screen, language stack, deviceMemory. Pixelscan/IPFighter detectan inconsistencias.

## Pricing real (mayo 2026)

| Plan           | Anual                                    | Mensual equivalente     | Gating                                                                 |
| -------------- | ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| **Free**       | $0                                       | —                       | 3 Identities, GPC scope WS/Identity solo, no per-tab                   |
| **Basic**      | $21/mo facturado anual (≈$25/mo mensual) | ~$25                    | Identities/Workspaces ilimitadas. **NO incluye GPC**                   |
| **Pro**        | $46/mo anual                             | **~$55–$59/mo mensual** | Todo Basic + GPC completo (per-tab/Identity/Workspace), priority email |
| **Enterprise** | Custom                                   | —                       | Volumen de seats                                                       |

Lo que paga Jose ($59) = Pro mensual. Aceptan crypto.

## Features detalladas

### Tipos de Identity

| Tipo          | Cookies                               | Scope                | Color                             | Proxy                                                   |
| ------------- | ------------------------------------- | -------------------- | --------------------------------- | ------------------------------------------------------- |
| **Default**   | Permanente, jar global compartido     | Global               | Gris                              | Per-tab solo                                            |
| **Temporary** | Efímera                               | Workspace específico | 25 colores preset (cap 25 por WS) | Per-tab GPC, se pierde al cerrar. Auto-assign rota aquí |
| **Permanent** | Persistente entre reinicios y updates | Global               | Custom                            | Pinned + UA custom por Identity                         |

Cada Identity tiene su propio cookie jar, localStorage, IndexedDB, WebSQL, Service Workers, Notifications. **Reset Identity** limpia el jar pero conserva nombre/color/proxy/UA y "regenera fingerprint" (reroll de seeds, no reroll completo).

### Workspaces

- Storage local por Chrome profile
- Save/reopen tabs con auth state
- **Freeze**: WS frozen reabre siempre con los mismos N tabs
- Archive (recuperable) vs Delete (destructivo)
- "General Browsing" WS permanente
- 1 WS abierto a la vez por default; abrir múltiples requiere crear otro Chrome **Profile** (Premium)

### Ghost Proxy Control (GPC) — el corazón del Pro

- Tipos: HTTP, HTTPS, IPv6 HTTP(s), **SOCKS5** (`socks5://1.2.3.4`)
- Auth: usuario + pass
- **Bulk import**: exportas CSV pre-formateado, llenas, re-importas. Columnas: host, port, user, pass, custom name, tags. Bulk enable/disable por tag (desde ene 2025)
- **Auto-Assign**: "Assign Each [tab | Tmp. Identity] from list, [in order | random]" — rota el pool. Botón **Re-Assign Existing** rerolea identities abiertas
- **Jerarquía**: Tab > Identity > Workspace. "Override connection for" gana sobre Auto-Assign
- Bypass list, Test button por proxy
- Direct (no proxy) y System Proxy first-class
- **Time-zone override** (4/9/25): GPC setea TZ del SO al match del proxy
- NO trae proxies — bring your own provider

### Anti-detección (toggles opt-in)

- Enable Canvas Noising
- Enable Scale Spoof (font rendering)
- Disable WebRTC (mata la API)
- Disable 3D APIs (kill WebGL)
- Custom User-Agent per Identity
- Profile-wide UA (default/latest/custom)
- Hardware concurrency spoof
- Timezone spoof

**NO** spoofea: WebGL vendor/renderer, AudioContext, fonts, screen, navigator.plugins, languages, deviceMemory, battery, gamepad, voices.

### Private Data Sync

NO es sync server-side. Escribe bundle a un **folder que tú elijas** + **passcode**. Apuntas Dropbox/Drive/OneDrive/USB tú mismo. No E2E del lado de Ghost — sólo el passcode protege el bundle. Auto-fill passwords y localStorage NO se sincronizan. Compartir con equipo = un Chrome Profile por staff con un código común.

### Public API (extension-facing)

```js
chrome.ghostPublicAPI.openTab({ url, identity, index, active, pinned }, callback)
// constantes: NEW_TEMPORARY_IDENTITY, DEFAULT_IDENTITY
```

Desde v2.4.1.1, `chrome.cookies.{get,set,getAll,remove}` aceptan parámetro `identity`. Cada tab tiene `tab.ghostPublicAPI.{workspace_id, identity_id, is_temporary_identity}`.

### Otros

- Sidebar izquierda con WS list + Identity list (modular o classic), colapsable
- Ghost Menu (a la izquierda del omnibox) cuando sidebar oculta
- Multi-Extension (abr 2025): misma extensión instalable múltiples veces — multi-MetaMask wallets
- Quick Tabs, Tasks, Dark Mode (ene 2025), Incognito
- **Manifest V2 deliberadamente mantenido**
- AppleScript en mac
- Pago con cripto
- Bookmark → abre en Identity específica (abr 2025)

## Modelo técnico inferido

- **Codebase**: fork Chromium, no wrapper. Modificaciones nativas en C++ para per-Identity StoragePartition, `ghostPublicAPI`, retención MV2, kill-switch WebRTC en internals, canvas noising, scale spoof
- **Versión Chromium**: ~129 desde v2.4 (oct 2024). Verificable via `ghost://changelog` y `chrome://version`
- **Profile model**: Profile estándar Chromium → cada Profile es una instancia Ghost separada. Dentro de un Profile: muchos Workspaces, cada uno con sus Temporary Identities; Permanent Identities son globales al Profile
- **Storage isolation per Identity** está implementado a nivel browser (StoragePartition-style) — por eso extensiones Chrome estándar no ven cookies de otras Identities y por eso tuvieron que extender `chrome.cookies` con `identity`
- **Proxy plumbing**: GPC es extensión + casi seguro un hook interno (no puedes asignar per-tab proxy en Chromium estándar — sólo per-request via PAC). El binding per-tab/per-Identity sugiere que Webatix expuso un internal API o modificó el network stack
- **Sin repo público**. El "Ghost-Browser-Pro-For-Windows" en GitHub **NO es oficial** — es bait SEO/cracked-software, sin código real
- **Auto-update**: Omaha (estándar Chromium forks). Releases ~trimestrales en 2025

## UX / atajos

- New Temporary Identity tab: "+" en sidebar, o Ghost Menu
- New tab en Permanent Identity: "+" del Identity Manager
- Tab toma el color de la Identity (top stripe + sidebar)
- Sidebar toggle no documentado por shortcut — via Ghost Menu
- **No hay catálogo público de atajos custom** — usa los Chrome estándar (Cmd-T, Cmd-W, etc.)

## Limitaciones / quejas conocidas

- **Cancelación tramposa**: "deactivating license ≠ canceling subscription". Trustpilot ~2.9
- Soporte lento, templated (24-48h pagados; gratis casi sin soporte)
- **Inconsistencias fingerprint**: falla Pixelscan, iphey, IPFighter
- **No automation API** Selenium/Puppeteer-grade
- No mobile, no roadmap mobile
- No team-seat console real
- Cap duro 25 Temporary Identities por Workspace
- Tensión con MV3 — futura compatibilidad incierta
- Pricing percibido alto vs AdsPower/Dolphin para profundidad de fingerprint que ofrece

## Cosas que NO pude confirmar

1. Atajo de teclado para "new tab in new Temporary Identity"
2. Si GPC tunnea DNS por SOCKS5 (DNS leak protection)
3. Qué vectores cambia "Reset Identity" exactamente
4. Estabilidad real con 50+ Permanent Identities
5. Qué hace "Strict mode" en Identity edit
6. Si auto-assign persiste mapping Identity↔proxy entre reinicios para Permanent Identities
