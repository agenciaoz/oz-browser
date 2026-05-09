# OZ Browser — Plan Maestro v5 (post-1.2 cierre + sub-bloques)

**Fecha:** 2026-05-09
**Estado:** Etapa 0 ✅ · Bloque 1.1 ✅ · Bloque 1.2 ✅ · Bloque 1.3-MCP ✅ · **Bloques 1.3.5-CI + 1.3.6-DX ✅** (GitHub Actions + ESLint v9 flat + Prettier + Husky pre-commit + lint-staged, format pass sobre 77 archivos, 85/85 tests verde) · **siguiente: Bloque 1.4-WS Workspace Manager**
**Plataforma target primaria:** macOS Apple Silicon (M1 / M2 / M3 / M4). Build universal binary también soporta Intel x86_64.

> **Nota de versión:** v5 reemplaza v4. Cambios: (a) 1.2 cerrado, (b) inserción de 1.3-MCP / 1.3.5-CI / 1.3.6-DX antes de Workspace Manager, (c) renumeración del resto: 1.4-WS Workspace, 1.5 ⭐Vault, 1.6 Time Machine, 1.7 Tab Context Menu, 1.8 FingerprintEngine, 1.9 Settings UI, 1.10 Polish, (d) candidatos #11-#15 (headless mode, Ghost-import, demo mode, recipes, health endpoint) anotados en Etapa 2 / pre-launch. Este documento es la fuente única de verdad — el `Projects/Ghost Browser Clone/07-PLAN-MAESTRO-V2.md` queda deprecado y redirige aquí.

---

## 0. Caso de uso primario (la razón por la que existe OZ Browser)

> **Manejar 50+ cuentas de redes sociales al mismo tiempo, todas logoneadas, todas persistidas, con sus claves seguras y exportables/importables a Excel.**

Ejemplo concreto: Jose tiene 50 cuentas de X (Twitter), las quiere abiertas TODAS al mismo tiempo en un Workspace, cada una con su proxy mobile dedicado, cada una **logoneada y que se quede logoneada sin desloguearse**, claves guardadas, listables/exportables a Excel para administrarlas.

Funcionalidad core derivada (Bloque 1.5 — la columna vertebral del producto):

1. **Account Vault** — credenciales (username + password + 2FA seed) cifradas con AES-256-GCM, encriptadas con master password (derivado con scrypt) o macOS Keychain.
2. **Auto-fill por Identity** — al cargar una página de login conocida (X, Instagram, FB, TikTok, LinkedIn, YouTube, Reddit, Threads, Telegram, Discord), se inyectan las credenciales de esa Identity.
3. **Auto-save** — al detectar form submission en login, popup "guardar credenciales para Identity X / Workspace Y?".
4. **Anti-logout robusto** — extender cookie expiry de session cookies a 1 año en dominios de redes sociales (Ghost no hace esto). Health check pasivo (visita el feed cada N días para mantener sesión warm). Detección + auto-relogin si una sesión muere.
5. **Excel Export** — `.xlsx` con: Workspace, Identity, Site, Username, Password, Last Login, Status, Notes, Cookies Count, Last IP del proxy. Usa SheetJS.
6. **Excel Import con 4 modos:**
   a) **PERMANENT MERGE** — agrega las identities y cuentas al estado actual.
   b) **EPHEMERAL SESSION** — sessions in-memory (no persist), abre tabs, al cerrar todo se descarta, Mac queda como estaba (modo "viaje").
   c) **NEW WORKSPACE** — agrega como workspace dedicado, sin tocar los existentes.
   d) **OVERWRITE TOTAL** — reemplaza TODO el estado actual con el contenido del Excel. Antes de aplicar, snapshot automático del estado anterior (Time Machine). Use case: exportas, alguien externo organiza/limpia, te lo devuelve, lo cargas en OVERWRITE y queda como él lo dejó. **Round-trip lossless:** import → merge → export = Excel UNIFICADO; o exportar → mandar → recibir corregido → OVERWRITE.
7. **Bulk identity creation desde Excel/CSV** — importas N filas y se crean N identities con auto-login. Onboarding de 50 cuentas en un click.
8. **Site templates** — selectores CSS conocidos por plataforma para form fields, login button, "logged in" detection.
9. **Cap de 25 identities por workspace de Ghost → REMOVIDO** (palette de colores generada algorítmicamente; sidebar con virtual scroll para soportar 50+).

Esto NO es una feature más. **Es el producto.** Todo lo demás (workspaces, proxies, antidetect, sync) existe para servir este flujo.

---

## 0.5. Plataforma & benchmarks objetivo (Apple Silicon-first)

**Target hardware primario:** Mac con chip M1/M2/M3/M4. Mucho usuario va a estar en MacBook Air M1 con 8 GB RAM (oficina de Jose). El producto debe correr fluido ahí.

**Arquitectura del binario:**

- `electron-builder` con `mac.target = 'universal'` → un solo `.dmg` que sirve x86_64 e arm64 nativo. Apple Silicon usa el slice arm64 directo (sin Rosetta).
- Sin C++ addons que no compilen arm64 → todo el stack es JS puro o cross-arch (sqlite3 sí soporta, sharp sí, keytar sí — verificado).

**Benchmarks objetivo (gates de aceptación de cada release — medidos automáticamente vía `oz.system.getMetrics` del MCP):**

| Mac (RAM)                         | Identities lazy | Identities materialized concurrentes | Memoria total | Notas                                      |
| --------------------------------- | --------------- | ------------------------------------ | ------------- | ------------------------------------------ |
| MacBook Air M1 8 GB               | 100             | 10                                   | < 4 GB        | Target principal — debe correr cómodo aquí |
| MacBook Pro M1 16 GB              | 200             | 30                                   | < 8 GB        | Sweet spot                                 |
| MacBook Pro M2/M3 32 GB+          | 500             | 100                                  | < 16 GB       | Power user                                 |
| Cold start (M1 Air)               | —               | —                                    | < 2 segundos  | hasta primer pixel de UI                   |
| Crear identity nueva              | —               | —                                    | < 100 ms      | todo en memoria                            |
| Switch entre tabs (materialized)  | —               | —                                    | < 50 ms       | percibido instantáneo                      |
| Materializar tab lazy desde click | —               | —                                    | < 800 ms      | hasta que la página empieza a cargar       |

Las mediciones por bloque se anotan en [`BENCHMARKS.md`](BENCHMARKS.md) — archivo vivo, una fila por release.

**Optimizaciones M-series específicas:**

1. **Lazy tabs por default** (ya implementado) — un tab lazy = ~1 KB JS, no renderer process. Es la diferencia entre 100 tabs viables vs imposibles en 8 GB.

2. **Tab discarding** — tabs materialized pero idle por más de 30 min → `webContents.destroy()`, view a `lazy=true`, recuperable al click. Configurable. Por default ON en M1 Air, OFF en 32 GB.

3. **Memory pressure handler** — escuchar `process.getMemoryInfo()`/`app.getAppMetrics()` cada 30 s. Si memory > 80% → empezar a discardear tabs idle más viejas. Si > 90% → notification al user "Liberé N tabs de RAM".

4. **Cache eviction policies** — `session.setCacheCapacity(50 MB)` por partition (configurable). Limite de cache TOTAL = 1 GB en M1 Air, escalable.

5. **Hardware acceleration:**
   - GPU: Metal renderer en Apple Silicon (default Chromium).
   - Video: VideoToolbox para H.264/H.265 hardware decode (default Chromium ≥ 130).
   - Verificar `chrome://gpu` muestra todos los flags green en builds de prueba.

6. **Disk I/O minimizado:**
   - SQLite WAL mode para cookies stores (Electron lo hace por default).
   - Lazy partition init — no crear SQLite de una identity hasta primera escritura de cookie.
   - Compresión zstd para snapshots y backups (3-5x mejor ratio que zlib en arm64).

7. **Background throttling** — Chromium ya hace freeze de tabs background. NO deshabilitar. Tabs con video/audio activo siguen vivas.

8. **Performance modes (Settings → Performance):**
   - **Light** (auto-on en 8 GB): tab discarding 15 min, max 5 materialized, fingerprint engine en lazy mode (solo on first nav).
   - **Balanced** (auto-on 16 GB): tab discarding 30 min, max 15 materialized, fingerprint normal.
   - **Power** (32 GB+): tab discarding 60 min, max 50 materialized, fingerprint full.

9. **Battery optimization** — al pasar a battery: cap CPU usage de tabs background, throttle health checks (passive logins) a una vez al día.

10. **Telemetría opt-in** (post-launch) — métricas de memoria/CPU/tabs/crashes, con consentimiento explícito. Permite detectar regresiones antes de que un usuario reporte.

**No-go zones:**

- ❌ NO usar Rosetta — Electron + addons todos arm64 nativos.
- ❌ NO C++ addons que no soporten arm64 (lista de checked: keytar ✅, sqlite3 ✅, sharp ✅, native-image-converter ❌ avoid).
- ❌ NO depender de Intel-only Homebrew packages en runtime.

---

## 0.7. Pilares arquitectónicos (no negociables)

Estas decisiones aplican a TODO bloque, etapa y commit. Documentadas como ADRs en `docs/architecture/`.

| #   | Pilar                                        | ADR                                                               | Resumen                                                                                                                                                                  |
| --- | -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Modularidad**                              | [0005](architecture/0005-modular-500-loc-rule.md)                 | Ningún archivo de código > 500 LOC. Si crece, se divide en submódulos. **Validado por `npm run check:loc`** (Bloque 1.3.6-DX).                                           |
| 2   | **Documentación es código de primera clase** | [DOC-RULES](DOCUMENTATION-RULES.md)                               | Todo se documenta. ADRs para decisiones, .md por módulo, .md por feature, history por bloque cerrado. Sin doc → no hecho.                                                |
| 3   | **Logging exhaustivo**                       | [0009](architecture/0009-logging-everything.md)                   | Cada componente y flujo loggea. IPC handlers con DEBUG entrada + INFO salida + duration. Métricas cada 30s. Privacy filters automáticos. Log Viewer in-app (Bloque 1.9). |
| 4   | **Apple Silicon target**                     | [0006](architecture/0006-apple-silicon-target.md)                 | Universal binary arm64 nativo. M1 8 GB Air = 100 lazy + 10 materialized < 4 GB. Performance modes Light/Balanced/Power.                                                  |
| 5   | **Sync pluggable**                           | [0007](architecture/0007-sync-pluggable-backend.md)               | Backend abstracto: Cloud OZ (Supabase) / Dropbox / S3 self-hosted / Off. E2E encryption client-side.                                                                     |
| 6   | **Lazy tabs**                                | [0002](architecture/0002-lazy-tabs.md)                            | Tab no crea WebContentsView ni renderer hasta primer click. 100+ tabs viables.                                                                                           |
| 7   | **Default Identity = defaultSession**        | [0003](architecture/0003-default-identity-uses-defaultsession.md) | Para que Chrome Web Store extensions funcionen. Otras identities tienen partitions. Per-Identity ext support en Bloque 1.10.                                             |
| 8   | **HTTPS sobre SOCKS5**                       | [0004](architecture/0004-https-over-socks5.md)                    | `app.on('login')` rock-solid en HTTPS. SOCKS5 disponible pero no default.                                                                                                |
| 9   | **Vault encryption**                         | [0008](architecture/0008-account-vault-encryption.md)             | scrypt(master) → AES-256-GCM. Master key en macOS Keychain.                                                                                                              |
| 10  | **Electron stack**                           | [0001](architecture/0001-electron-stack.md)                       | Electron + electron-browser-shell. Fork de Chromium reservado a Etapa 9 si MRR > $5K.                                                                                    |
| 11  | **Modales hide content view**                | [0011](architecture/0011-modals-hide-content-view.md)             | WebContentsView nativo siempre tapa HTML chrome. Modales/overlays usan `oz:ui:setContentVisible(false)` en open.                                                         |
| 12  | **Per-identity custom UA**                   | [0010](architecture/0010-per-identity-user-agent.md)              | UA configurable en Identity (no Default). Aplica via `session.setUserAgent` al crear/update. `navigator.userAgent` se override en 1.8 (FingerprintEngine).               |
| 13  | **MCP automation API**                       | [0012](architecture/0012-oz-mcp-server.md)                        | Server MCP embebido (HTTP localhost + stdio bridge). Reemplaza computer-use para validation y es la automation API user-facing.                                          |
| 14  | **CI obligatorio**                           | [0013](architecture/0013-ci-strategy.md)                          | GitHub Actions corre `npm test`, `npm run check:loc`, lint en cada push. Sin verde, no merge.                                                                            |
| 15  | **Lint pre-commit**                          | [0014](architecture/0014-lint-precommit.md)                       | ESLint mínimo (Node, no React) + Husky hook. Atrapa typos y `console.log` antes de commit.                                                                               |

**Sin estos pilares, el proyecto se desordena.** Si una decisión nueva contradice alguno, primero se actualiza el ADR (proceso documentado en DOCUMENTATION-RULES.md).

---

## 1. Resumen ejecutivo

OZ Browser es un clon-mejor de Ghost Browser, vendido como SaaS más barato, **enfocado en gestión masiva de cuentas de redes sociales en MacBooks Apple Silicon**. El stack es **Electron + electron-browser-shell + IdentityManager + WorkspaceManager + FingerprintEngine + AccountVault + Cloud Sync + MCP Server**. Todo el código vive en módulos chicos y bien separados. El plan tiene **10 etapas**, cada una útil por sí sola.

**Lo que vamos a hacer mejor que Ghost** (nuestros diferenciadores reales, no hype):

1. **Account Vault + auto-fill + anti-logout + Excel import/export** ← Ghost no tiene nada de esto, es nuestro #1 moat
2. Pasar Pixelscan/CreepJS por default (Ghost falla — Trustpilot 2.9)
3. Sync E2E real en la nube (Ghost solo sincroniza a una carpeta tipo Dropbox)
4. Multi-window workspaces de verdad (Ghost obliga a usar profiles separados)
5. Cancelación self-service real (Ghost cobra después de "deactivate")
6. Per-identity timezone/locale/geo automático del proxy (Ghost lo hace global)
7. Templates de proveedores de proxies (Bright Data, Smartproxy, Oxylabs, IPRoyal)
8. Health-check automático de proxies con auto-disable
9. **MCP automation API** para Claude/Cursor/Puppeteer/Playwright (Ghost no tiene automation API)
10. Multi-extension SIN whitelist hardcodeada (Ghost solo permite ~7 extensions)
11. Bandwidth meter por proxy/identity
12. **Modo Ephemeral Session** — abre 50 cuentas desde un Excel, las usas, cierras, Mac queda limpia (Ghost no tiene)
13. **Cap de 25 Temporary Identities por workspace REMOVIDO** (Ghost lo tiene hardcodeado a 25 colores)
14. **Time Machine** — snapshot diario automático del estado completo, retention configurable, restore a cualquier versión anterior con un click. Antes de cualquier operación destructiva (OVERWRITE, bulk delete, restore) snapshot forzado. Ghost no tiene nada parecido.
15. **Workflow colaborativo Excel** — exporta → manda a alguien para que organice/limpie/agregue → recibe corregido → OVERWRITE en OZ → queda exacto como te lo devolvió. Sin Ghost.
16. **Office Edition con Dropbox + Admin Dashboard** — sync backend Dropbox (cero infra cost para oficina), activity tracking opt-in (bandwidth/tiempo/accounts/productividad), dashboard con métricas por empleado. Ghost no tiene nada de admin/team.

---

## 2. Etapas reorganizadas

> **v5 reordering:** 1.2 cerrado. Insertados sub-bloques 1.3-MCP / 1.3.5-CI / 1.3.6-DX (tooling y automation API antes del Workspace Manager). Renumerado el resto. Account Vault sigue como Bloque 1.5 (CORE). Order optimizado por dependencias reales.

### Orden de ejecución recomendado

```
SUB-ETAPA 1A — NÚCLEO USABLE (MVP para Jose y oficina)
│
├─ 1.1 Foundation                              ✅ HECHO
├─ 1.2 Identity Manager + Lazy Tabs            ✅ HECHO (custom UA + free-tier cap + smoke test)
│
├─ 1.3-MCP   OZ MCP server (automation API)    ⏳ ← NUEVO, prio post-1.2 (ADR 0012)
├─ 1.3.5-CI  GitHub Actions + check-loc        ⏳ ← NUEVO, evita regresión
├─ 1.3.6-DX  ESLint + pre-commit + checklist   ⏳ ← NUEVO, calidad
│
├─ 1.4-WS Workspace Manager                    ⏳ ← era 1.3
├─ 1.5  ⭐ Account Vault (CORE)                ⏳ ← era 1.10, sube a 1.5
│       Excel I/O · auto-fill · anti-logout
├─ 1.6  Time Machine + Backup                  ⏳ ← era 1.8
└─ 1.7  Tab Context Menu + Cookies/Identity    ⏳ ← era 1.6

SUB-ETAPA 1B — CALIDAD Y DIFERENCIADORES
│
├─ 1.8  Proxy Manager                          ⏳ ← era 1.4 (sube de prio en 1B porque depende de Vault para anti-logout-with-proxy)
├─ 1.9  FingerprintEngine "Ghost+"             ⏳ ← era 1.5
└─ 1.10 Settings UI + Bookmarks/Downloads/History + Polish + Extensions multi-identity + M-series perf  ⏳

ETAPA 2+ — UX, distribución, comercial
```

> **Nota sobre 1.8 Proxy Manager:** se movió a 1B porque la integración con Anti-logout (1.5) y FingerprintEngine GeoIP (1.9) hace más natural construirlos juntos. Si Jose necesita proxies básicos antes (solo CRUD + per-tab), se puede traer a 1A como sub-bloque 1.5.5.

### ✅ ETAPA 0 — Validación técnica (HECHA, 2026-05-09)

- Electron + partition isolation + proxy auth con Oxylabs ✅

### ETAPA 1 — Cliente desktop funcional para Jose

#### ✅ Bloque 1.1 — Foundation (HECHO, 2026-05-09)

- Fork de electron-browser-shell, repo privado en GitHub
- Tabs + omnibox + back/forward/reload heredados
- Layout sidebar+content base

#### ✅ Bloque 1.2 — Identity Manager + Lazy Tabs + Logger + Custom UA (HECHO, 2026-05-09)

Detalles completos en [`history/07-bloque-1.2-resultado.md`](history/07-bloque-1.2-resultado.md).

Highlights: IdentityManager con persistencia atómica, Default usa defaultSession (ADR 0003), lazy tabs (ADR 0002), sidebar con CRUD + `(n)` count, top tabstrip con stripe, logger rotación, error popup, IPC handlers consolidados, per-identity custom UA via modal (ADR 0010), free-tier cap 3 con bypass `OZ_TIER=paid`, smoke test 28/28 + visual ejecutado, ADR 0011 (modales hide content view).

---

#### 🆕 Bloque 1.3-MCP — OZ MCP server (~12-16h)

**Por qué entra ahora (re-priorizado 2026-05-09):** los bugs encontrados en el smoke test visual del 1.2 (sidebar vacío por `safe` clash + modal cubierto por WebContentsView) un MCP los hubiera detectado en minutos vía tool call en vez de horas con clicks de pixel. Cada bloque siguiente paga el costo de no tenerlo.

**Por qué es producto, no solo dev tool:** cubre el diferenciador #9 vs Ghost (CDP automation API) en una capa más amigable. Un cliente puede integrar OZ Browser con su pipeline de scraping/login automatizado/multi-cuenta sin tocar Chromium DevTools. Es nuestro hook para usuarios técnicos.

**Scope v1 (esta sesión):**

- `browser/identity-handlers.js` y `browser/tab-handlers.js` — extraídos de `ipc-handlers.js`. Exportan mapas `{ name → fn }` consumibles por IPC y MCP.
- `browser/mcp-server.js` con `@modelcontextprotocol/sdk` oficial.
- Transports: HTTP localhost (`StreamableHTTPServerTransport`, default port 9223, off por default `OZ_MCP_ENABLED=1`) + stdio bridge (`tools/mcp-stdio-bridge.js` standalone Node script para Claude Code/Cursor).
- Tool catalog v1 (~13 tools):
  - `oz.identities.list/get/getActive/setActive/create/update/remove`
  - `oz.tabs.list/openInIdentity/select/close`
  - `oz.events.subscribe` — Server-Sent Events para tab-created/identity-changed (scope expandido del ADR — habilita smoke tests reactivos)
  - `oz.system.getMetrics` — memoria/CPU/# tabs lazy/materialized (embrión de BENCHMARKS.md)
- Auth: localhost-only por default. Bearer token opcional via `OZ_MCP_TOKEN` para conexiones non-loopback.
- Smoke test `tests/mcp-server.smoketest.js` Node-puro contra mocks.
- **Contract test IPC↔MCP:** garantiza que cada `ipcMain.handle('oz:X')` whitelisted tiene tool `oz.X` (o explicitly exempt) — previene drift.
- Doc usuario `docs/guides/mcp-automation.md` con quickstart curl + Claude Code config + Cursor config.
- Settings UI toggle "Enable MCP server (advanced)" — diferido a Bloque 1.10. Mientras tanto solo via env.
- Validation end-to-end: `npm start OZ_MCP_ENABLED=1`, curl al endpoint, crear identity vía MCP, verificar persistencia.

**Cierra cuando:** smoke test verde, contract test verde, doc de guía publicada, validation end-to-end documentada en history.

---

#### ✅ Bloque 1.3.5-CI — GitHub Actions (HECHO, 2026-05-09)

Detalles en [`history/09-bloque-1.3.5-1.3.6-resultado.md`](history/09-bloque-1.3.5-1.3.6-resultado.md).

#### Detalle del scope original (referencia histórica)

**Por qué:** sin CI los tests existen pero nadie los corre.

**Por qué:** sin CI los tests existen pero nadie los corre. A los 3 bloques tenemos 5 smoke tests y se rompe alguno en silencio. Costo ~30 min, beneficio durante todo el resto del proyecto.

**Scope:**

- `.github/workflows/ci.yml`:
  - Trigger: push a cualquier branch + PR a main
  - Jobs: `npm install`, `npm test`, `npm run check:loc`, `npm run lint`
  - macOS-latest runner (free 2000 min/mes en repo privado)
  - Caching de `~/.npm` para velocidad
- Status badge en `README.md`
- Branch protection rule: PR a main requiere CI verde (cuando haya equipo, por ahora orientativo)
- Nightly job (cron 03:00 UTC): corre todos los smoke tests + sube logs a Actions artifacts si fallan

**Cierra cuando:** primer push verde + el badge muestra ✅.

---

#### ✅ Bloque 1.3.6-DX — ESLint + pre-commit + checklists (HECHO, 2026-05-09)

Cerrado junto con 1.3.5-CI. Detalles en [`history/09-bloque-1.3.5-1.3.6-resultado.md`](history/09-bloque-1.3.5-1.3.6-resultado.md).

#### Detalle del scope original (referencia histórica)

**Por qué:** atrapar typos / `console.log` olvidados / archivos > 500 LOC ANTES de commit es 10x más barato que después.

**Scope:**

- `.eslintrc.json` mínimo (Node 18+, no React, regla custom de 500 LOC)
- Husky + lint-staged: pre-commit corre `eslint --fix` sobre archivos staged
- `scripts/check-loc.js` con npm script `check:loc` (regla 500 LOC automatizada)
- `docs/processes/CHECKLIST-CIERRE-BLOQUE.md` — checklist canónica que reemplaza al "smoke test ad-hoc" (incluye: corre tests? logger en cada handler nuevo? ADR si decisión arquitectónica? doc del módulo creada/actualizada? línea bajo 500 LOC? CHANGELOG actualizado?)
- `docs/processes/code-review-checklist.md` para futuro equipo

**Cierra cuando:** pre-commit corre limpio en un commit dummy + el checklist está en el doc.

---

#### 🆕 Bloque 1.4-WS — Workspace Manager (~10h)

**Modelo:**

```js
Workspace = {
  id, name, color?, isDefault, isArchived, isFrozen,
  createdAt, updatedAt,
  tabs: [{ identityId, url, title, pinned, ... }],
  identities: [identityId, ...]   // qué identities están "vivas" en este WS
}
```

- CRUD: create / rename / duplicate / archive / restore / delete
- Drag-and-drop reorder en sidebar
- Freeze / Unfreeze (snapshot read-only)
- "General Browsing" workspace default no eliminable
- Switch de workspace cierra tabs del anterior y abre las del nuevo (lazy)
- Multiple windows = multiple workspaces (1 ventana = 1 workspace) — **diferenciador vs Ghost**
- Persistence en `workspaces.json`
- Quick Tabs 4 modos (load all / one-by-one / on-click / on-click+confirm)
- **Drag-and-drop de tabs entre workspaces** (pedido por Jose 2026-05-09): arrastrar tab del sidebar/topbar a otro workspace lo mueve. HTML5 drag-drop API + IPC `oz:tabs:moveToWorkspace(tabId, workspaceId)`. Si el destino no está activo, la tab se persiste en su nueva pertenencia y aparece al cambiar a ese workspace.
- **Right-click menu en tab con "Move to workspace…"** (pedido por Jose 2026-05-09): submenu dinámico listando todos los workspaces activos (excepto el actual). Mismo IPC.
- **Tools MCP:** `oz.workspaces.*` se agregan al catálogo del MCP server al cerrar este bloque.

#### 🆕 Bloque 1.5 — Account Vault + Auto-fill + Excel I/O + Anti-logout (🌟 CORE) (~14h)

**Este es el bloque más importante del plan — es la razón por la que el producto existe.**

**Modelo:**

```js
Account = {
  id, identityId, workspaceId,
  site, // 'x.com', 'instagram.com', 'facebook.com', etc.
  username, passwordEncrypted, totpSecretEncrypted?,
  cookies?, lastLoginAt, lastIp, status, // active/inactive/needs_relogin
  notes, customFields
}
Vault = {
  master_key_derived_with_scrypt_from_password,
  encrypted_blob: AES-GCM(JSON.stringify(accounts), key)
}
```

**Componentes:**

1. **`account-vault.js`** — credenciales cifradas en disk (`data/vault.enc`). API: `getAccount(identityId, site)`, `saveAccount(...)`, `listAccounts(filter)`, `unlock(masterPassword)`, `lock()`. Master password se guarda en macOS Keychain (via `keytar`) — usuario solo lo escribe la primera vez.

2. **`site-templates.js`** — selectores CSS y URLs por plataforma (X, Instagram, Facebook, TikTok, LinkedIn, YouTube, Reddit, Threads, Telegram, Discord).

3. **Auto-fill** — content script inyectado en cada Identity. Cuando carga una página de login conocida, lee credentials del vault y rellena.

4. **Auto-save** — interceptar form submissions; popup "Save credentials para Identity X?".

5. **Anti-logout robusto:**
   - Hook a `webContents.session.cookies.onChanged` — cuando cambia una session cookie de redes sociales, EXTENDER expiry a 1 año.
   - Health check daemon: cada 6 días, navega passively al home de cada plataforma para refresh de session.
   - Detección de logout: si tab navega a `/login` o session cookie vacía → `status='needs_relogin'` + notification + opción de auto-relogin.

6. **Excel Export** — Settings → Accounts → Export. `.xlsx` columnas: Workspace, Identity, Site, Username, Password, 2FA Secret, Last Login, Status, Cookies Count, Last IP, Proxy, Notes. SheetJS hace el writeFile.

7. **Excel Import** — 4 modos: PERMANENT MERGE / EPHEMERAL SESSION / NEW WORKSPACE / OVERWRITE TOTAL.

8. **Bulk identity creation** — importar Excel = crear N identities + asignar proxies + auto-login.

9. **Identity cap remove** — Ghost tiene cap 25; nosotros generamos colores algorítmicamente (HSL espaciados), virtual scroll en sidebar para 100+.

10. **Account Manager UI** — sección dedicada en sidebar y página completa en Settings. Search, filter, bulk actions.

11. **Per-account proxy chip** — visual indicator del país de la IP por la que la cuenta está logoneada.

12. **Tools MCP:** `oz.vault.*` (con required auth) y `oz.accounts.*` se agregan al catálogo MCP.

#### 🆕 Bloque 1.6 — Time Machine + Backup/Restore (~5h)

- `backup-manager.js`: empaqueta a `.ozbackup` (zip cifrado AES-256-GCM):
  - identities.json + workspaces.json + proxies.json + settings.json + bookmarks + vault.enc
  - Todo `data/Partitions/*` (cookies, IndexedDB, localStorage, service workers, cache)
  - Metadata: version, timestamp, machine fingerprint, label

**Time Machine (snapshots automáticos):**

- **Daily snapshot:** cron interno cada día 3am en `data/snapshots/`. Configurable.
- **Pre-destructive snapshots:** snapshot forzado antes de OVERWRITE, bulk delete, factory reset, restore.
- **Retention policy:** keep last N días (default 30) / keep all / keep weekly forever / custom.
- **UI Settings → Time Machine:** lista cronológica con label + tamaño + descripción. Restore con snapshot del estado actual antes. Diff view opcional. Export individual.
- **Manual snapshot** + atajo de teclado.
- **Almacenamiento:** snapshots cifrados con master password del vault. Compresión zstd.
- **Cloud snapshots (Etapa 7):** push a Supabase encriptado.

#### 🆕 Bloque 1.7 — Tab Context Menu + Cookies por Identity (~6h)

- Menú nativo via Electron `Menu.buildFromTemplate`, replicando Ghost (16 opciones):
  - Create a New Tab: Current Identity / New Temporary / Default / New Identity / In Identity… (submenu dinámico)
  - Move Tab to New Window
  - Reload, Duplicate, Duplicate (New Temporary), Duplicate (New Identity), Duplicate into Identity… (submenu)
  - Refresh All in this Identity
  - Clear This Identity Browsing Data (Cookies / LocalStorage / Both)
  - Export Cookies (formato JSON + Netscape cookies.txt + AdsPower-compat + Multilogin-compat)
  - Import Cookies (mismos formatos)
  - Pin / Unpin
  - Mute / Unmute Site
  - Bookmark this Tab
  - Close, Close Other Tabs, Close Tabs to the Right
- Mismo menú accesible desde sidebar tab list y top tabstrip
- Atajos de teclado replicando Ghost (Cmd+T, Alt+N, Alt+G, Alt+D, Cmd+Shift+J, Alt+S, Alt+P)

#### 🆕 Bloque 1.8 — Proxy Manager (~12h)

**Modelo:**

```js
Proxy = {
  id, name, protocol, host, port, username, password,
  tags: [], country?, lastTestedAt, lastLatencyMs, isActive,
  bandwidthBytesUsed
}
```

- CRUD individual + UI dedicada (proxy-manager.html)
- Bulk import CSV con formato compat con Ghost
- Test de conectividad (paralelo)
- Auto-Assign: random / round-robin
- Asignación manual: per-tab, per-identity, per-workspace (jerarquía Tab>ID>WS)
- Bypass list (faltante en Ghost)
- Health checks intervalados con auto-disable (mejor que Ghost)
- Templates por provider: Oxylabs, Bright Data, Smartproxy, IPRoyal — pega API key, traemos lista (mejor que Ghost)
- Bandwidth meter per proxy
- Tools MCP: `oz.proxies.*`

#### 🆕 Bloque 1.9 — FingerprintEngine "Ghost+" (~14h)

**Pasar Pixelscan/CreepJS por default.**
Por cada Identity, generar y persistir un fingerprint coherente derivado de un seed UUID. Vectores spoofeados via preload script en cada partition session:

| Vector                             | Implementación                                                  |
| ---------------------------------- | --------------------------------------------------------------- |
| User-Agent + platform + appVersion | Override navigator.\*                                           |
| Hardware concurrency               | Override navigator.hardwareConcurrency                          |
| deviceMemory                       | Override navigator.deviceMemory                                 |
| Languages                          | Override navigator.languages, navigator.language                |
| Screen / dpr                       | Override window.screen.\* + devicePixelRatio                    |
| Timezone                           | Override Intl.DateTimeFormat + Date.prototype.getTimezoneOffset |
| WebGL vendor/renderer              | Hook getParameter(GL_VENDOR/GL_RENDERER)                        |
| Canvas                             | Add seeded noise to toDataURL/toBlob/getImageData               |
| AudioContext                       | Add seeded noise to OfflineAudioContext.startRendering          |
| Fonts                              | Filter Canvas measureText / document.fonts to subset            |
| Plugins / mimeTypes                | Override navigator.plugins to coherent list                     |
| WebRTC                             | Disable RTCPeerConnection or force proxy IP                     |
| Battery                            | Override deprecated battery API                                 |
| Speech / Voices                    | Filter speechSynthesis.getVoices                                |

**Coherencia automática vía proxy GeoIP (mejor que Ghost):** cuando asignas un proxy, OZ propone (con confirmación) timezone + languages + locale derivados del país.

**Suite de tests CI:** abre Pixelscan / iphey / browserleaks / CreepJS con N identities distintas, valida consistencia per-identity y diversidad cross-identity. Bloquea release si baja del threshold.

#### 🆕 Bloque 1.10 — Settings UI + Bookmarks/Downloads/History + Polish + Extensions multi-identity + M-series perf (~16h)

- Settings página completa con secciones: General, Appearance, Identities, Workspaces, Proxies, Privacy/Anti-Detection, Sync, Extensions, Backup, Updates, Account, About, Manage Shortcuts.
- **Settings → Automation → Enable MCP server (advanced)** (toggle del 1.3-MCP).
- Bookmarks page (Chromium-style, búsqueda, "open in identity X")
- Downloads page
- History page (filterable por identity)
- Per-identity browsing data clear
- Extensions de Chrome Web Store en TODAS las identities (múltiples instancias de ElectronChromeExtensions, una por session)
- Drag-and-drop reorder
- Loading states bonitos
- First-run onboarding (3 pantallas explicando Identities, Workspaces, Proxies, Vault)
- Hotkey panel customizable
- **Performance pass específico Apple Silicon:** tab discarding daemon, memory pressure handler, performance modes auto-detect, cache caps, verify chrome://gpu Metal/VideoToolbox green, battery optimization, universal binary verificado nativo arm64.
- Benchmarks objetivo cumplidos (ver §0.5).

### ETAPA 2 — UX competitiva y candidatos pre-launch

- Tab visual con stripe del color de identity (ya está)
- Animaciones suaves al cambiar de workspace
- Sidebar resizable + collapsable a thin rail
- Modular Sidebar opcional (post-MVP)
- App Dock para PWAs pinnables (post-MVP)
- Browser-action toolbar limpio (clean toolbar mode)

**Candidatos extra propuestos 2026-05-09 (decidir entrar a v1 o pre-launch según appetite):**

- **C-11 Modo headless** — `oz-browser --headless` arranca main process sin GUI, solo MCP escuchando. Use case: scraping en background, server de oficina con N OZ headless, automation pipelines. ~2h sobre el MCP existente. Ghost no tiene.
- **C-12 Importer desde Ghost Browser** — parser de `~/Library/Application Support/Ghost Browser` que migra config/identities/workspaces a OZ con un click. Hook masivo para los 90+ mil usuarios actuales. ~4h.
- **C-13 Demo Mode launcher** — botón "Open OZ in Demo Mode" → sessions in-memory, todo se borra al cerrar, ningún archivo escrito. Cliente lo prueba sin instalar permanente. ~1.5h sobre el sistema de Bloque 1.5 (EPHEMERAL).
- **C-14 Recipes (macros MCP)** — secuencia de tool MCP guardada como receta YAML/JSON. "Login en X con identity 5 → posteo → screenshot → cerrar". Diferenciador único vs Ghost. ~6h.
- **C-15 Health endpoint** (`/health` del HTTP server del MCP) — `{ status, identities, tabs, memoryMB, uptime }`. Útil para Admin Dashboard sin tocar Dropbox. ~30 min sobre 1.3-MCP.
- **C-16 Telemetría + remote config para soporte (idea de Jose 2026-05-09)** — sincroniza periódicamente la config de cada usuario (identities/workspaces metadata + last error log + version + flags + crash dumps) al Dropbox de la oficina (mismo backend que Etapa 7-OFFICE — un solo storage). Habilita: (a) cuando un user reporta un bug Jose ve la config exacta sin pedírsela, (b) Admin puede pushear un cambio de config remoto (`remote-config.json` lee al boot, override flags/feature switches/forced-update). Privacy: opt-in fuerte, banner claro, granular (config sí, contenido del vault NO). ~6-8h. Bloque sugerido: post-Etapa 7-OFFICE (depende del Dropbox sync ya implementado). Diferenciador para venta a oficinas/equipos.

### ETAPA 3 — Distribución firmada + auto-update

**Confirmación toolchain (decidido 2026-05-09 noche):** estamos en **electron-forge** (`@electron-forge/cli` + makers en package.json). NO en electron-builder. Esto define el path de auto-update:

- ✅ `update-electron-app` — wrapper oficial del Electron team encima de `electron-updater`. Compatible con Forge.
- ✅ `@electron-forge/publisher-github` — publisher para releases automatizados a GitHub Releases.
- ❌ NO usar `electron-updater` directo — eso es para electron-builder, otra toolchain. Cambiar de Forge a Builder a esta altura sería re-aprender el build pipeline.

**Orden CRÍTICO (sin esto el auto-update falla en silencio):** `update-electron-app` en macOS **solo funciona si la app está firmada Y notarizada**. Si pruebas auto-update en build no notarizada, no hay error visible al usuario — simplemente no actualiza nunca. Pasos en orden:

1. Apple Developer cert ($99/año) — comprar + descargar + agregar a Keychain.
2. Configurar `osxSign` + `osxNotarize` en `forge.config.js` con app-specific password de tu Apple ID (Keychain).
3. Build firmado y notarizado vía `npm run make` — verificar con `spctl -a -t exec -vvv out/.../*.app` antes de seguir.
4. `npm install --save update-electron-app` y wire en main.js.
5. `@electron-forge/publisher-github` para release pipeline.
6. CI/CD con GitHub Actions (release pipeline encima del 1.3.5-CI). Build job firmado SOLO en tag `v*.*.*` para no quemar minutos.
7. DMG con installer pulido + branding OZ (Forge maker `dmg` ya lo genera; pulir layout).

### ETAPA 4 — Backend SaaS: auth + entitlements

- Supabase project (free tier)
- Schema: users, subscriptions, entitlements, devices
- `auth-client.js` en cliente: login pantalla pre-browser
- **Deep link OAuth callback:** registrar protocol handler `oz://auth/callback` con `app.setAsDefaultProtocolClient('oz')`. Supabase OAuth redirect URI apunta a `oz://auth/callback?code=...`. Manejo en `app.on('open-url')` (mac) y `app.on('second-instance')` (Windows). Sin esto, los flows de OAuth no cierran el loop en Electron.
- Feature gating runtime: si plan = Free → cap 3 identities, sin GPC; Basic → ilimitado, sin GPC; Pro → ilimitado + GPC; Team → + sync admin
- Server-side validation + offline grace period

### ETAPA 5 — Billing con Stripe

- Stripe products: Free / Basic ($12-15) / Pro ($29-35) / Team ($15/seat)
- **Checkout abre con `shell.openExternal(url)`, NO BrowserWindow.** Stripe Checkout tiene CSP estricto que bloquea ser embebido en webview/BrowserWindow de Electron — sale error "refused to display in a frame". Patrón estándar:
  ```js
  const { url } = await stripe.checkout.sessions.create({ ... })
  shell.openExternal(url)   // abre en Safari/Chrome del usuario
  ```
  El loop se cierra con deep link `oz://billing/success?session_id=...` que rutea por path en el handler global de protocolo (mismo `setAsDefaultProtocolClient('oz')` registrado en Etapa 4 para Supabase OAuth — un solo handler, dispatch por path).
- Self-service portal: upgrade, downgrade, cancel, refund window — **diferenciador clave** vs Ghost (`stripe.billingPortal.sessions.create`, también con `shell.openExternal`).
- Webhooks → Supabase Edge Functions, validados con `stripe.webhooks.constructEvent` (no agregar deps extra de validación).
- Trial de 7 días para Pro.
- Promo codes para early adopters.

### ETAPA 6 — Marketing site + signup

- Landing en Vercel free
- Pricing comparativa vs Ghost
- Documentación
- Email transaccional (Resend)
- SEO básico
- **Featured: MCP automation API** (diferenciador #9 destacado en hero)

### ETAPA 7 — Cloud Sync E2E (backend pluggable)

- `sync-client.js` con backends pluggables: **Cloud OZ (Supabase)** / **Dropbox** / **S3 self-hosted** / **Off**.
- Encrypta client-side antes de subir.
- Schema unificado: `synced_identities`, `synced_workspaces`, `synced_proxies`, `synced_vault`, `activity` con `version`.
- Conflict resolution: last-write-wins → vector clocks v2.
- Multi-device login.
- Cloud backup automático.
- **Mejor que Ghost**: incluye autofill passwords + localStorage que Ghost excluye desde 2018.

### ETAPA 7-OFFICE — Dropbox backend para tu oficina

- Cliente con `dropbox` SDK oficial. OAuth flow con **PKCE** (Dropbox lo requiere para desktop apps).
- API real del SDK (verificar al implementar — la firma puede haber cambiado entre versiones del SDK):
  ```js
  const dbxAuth = new DropboxAuth({ clientId: '...' }) // SIN clientSecret en desktop
  // Argumento posicional: (redirectUri, state, responseType, tokenAccessType, scope, includeGrantedScopes, usePKCE)
  const url = dbxAuth.getAuthenticationUrl(
    'oz://dropbox/callback',
    crypto.randomBytes(16).toString('hex'),
    'code',
    'offline',
    undefined,
    undefined,
    true, // ← usePKCE
  )
  shell.openExternal(url)
  // Después del callback con code:
  const tokenResp = await dbxAuth.getAccessTokenFromCode('oz://dropbox/callback', code)
  ```
- Refresh token en macOS Keychain (via `@napi-rs/keyring`).
- Deep link `oz://dropbox/callback` registrado en el mismo handler de protocolo de Etapa 4 (dispatch por path).
- Per-user folder `/Apps/OZ Browser/<email>/` con vault.enc, identities/workspaces/proxies/settings JSON, snapshots/, activity/.
- Activity logs en plaintext (para admin dashboard) — vault sigue cifrado E2E.
- Cero infra cost. Backup nativo via Dropbox sync del SO.

### ETAPA 7.5 — Admin Dashboard (Office Edition)

- Web app Next.js (Vercel free) o Mac app Electron — lee folders del Dropbox de la oficina.
- Vistas: Overview por usuario, Drill-down, Por proxy provider, Alerts, Export CSV/Excel.
- Auth solo admin (Jose) — verifica con Dropbox OAuth scope `members.read`.
- Privacy: opt-in explícito en cliente.

### ETAPA 8 — Windows + Linux

- Cross-platform build pipeline
- Windows code signing (DigiCert OV/EV)
- Linux (Ubuntu/Debian) opcional

### ETAPA 9 — Antidetect top-tier (futuro lejano)

- Solo si MRR > $5K. Fork de Chromium real con patches a TLS fingerprint, V8 timing, graphics más profundo.

### ETAPA 10 — Team & Enterprise (futuro)

- Admin dashboard con seat management, audit log, RBAC, SSO (SAML/Okta), self-hosted opcional.

---

## 3. Roadmap de features prioritizado (qué nos falta vs Ghost)

### MUST-HAVE para v1 (parity Ghost Free)

1. ✅ Default Identity always-present
2. ✅ Tab list bajo cada identity en sidebar
3. 🆕 Workspaces CRUD con freeze/archive/restore/duplicate (1.4-WS)
4. 🆕 Tab right-click context menu (1.7)
5. 🆕 Keyboard shortcuts customizables (1.10)
6. 🆕 Settings UI shell completa (1.10)
7. 🆕 Extensions soporte en TODAS las identities (1.10)
8. 🆕 Bookmarks/Downloads/History pages (1.10)
9. 🆕 Per-identity cookie clear (1.7)
10. 🆕 Per-identity Reset (1.9)
11. ✅ Per-identity custom UA (1.2)
12. 🆕 Per-identity proxy (1.8)
13. 🆕 Bulk CSV proxy import (1.8)
14. 🆕 Tab-level proxy override (1.8)
15. 🆕 Pricing & gating UI (Etapa 5)
16. 🆕 Quick Tabs 4 modos (lazy ya hecho, exponer modos en 1.4-WS)
17. ✅ Dark mode (electron lo trae)
18. 🆕 Anti-detection toggles (1.9)

### SHOULD-HAVE para v1 (diferenciadores reales)

19. 🆕 Pasar Pixelscan/CreepJS por default — fingerprint coherente per-identity (1.9)
20. 🆕 Auto-align fingerprint con proxy GeoIP (1.9)
21. 🆕 Per-identity timezone/locale/language (1.9)
22. 🆕 **MCP automation API** para Claude/Cursor/Puppeteer (1.3-MCP)
23. 🆕 Cloud sync E2E (Etapa 7)
24. 🆕 Workspace templates (.ozworkspace JSON)
25. 🆕 Multi-window workspaces de verdad (1.4-WS)
26. 🆕 Self-service cancellation (Etapa 5)
27. 🆕 Proxy health checks + auto-disable (1.8)

### NICE-TO-HAVE post-v1 (candidatos Etapa 2 — ver propuesta C-11..C-15)

28. Modular sidebar + Tasks
29. App Dock
30. Multi-extension SIN whitelist
31. Recurring scheduled workspaces
32. Team admin dashboard
33. Native screenshot
34. Bandwidth meter per proxy/identity
35. Per-identity download folders
36. Per-identity bookmarks folders
37. Workspace marketplace
38. Headless mode (C-11)
39. Ghost importer (C-12)
40. Demo mode launcher (C-13)
41. MCP recipes (C-14)
42. Health endpoint (C-15)
43. Telemetría + remote config para soporte vía Dropbox (C-16, idea Jose 2026-05-09)

---

## 4. Lo que Ghost NO tiene y vamos a tener (moat real)

| #   | Feature                                                   | Por qué importa                                                                 |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Pixelscan/CreepJS pass por default                        | Ghost falla → quejas en reviews                                                 |
| 2   | Cloud sync E2E real                                       | Ghost solo escribe a folder Dropbox                                             |
| 3   | Multi-window workspaces de verdad                         | Ghost obliga a usar profiles separados                                          |
| 4   | Self-service cancel                                       | Ghost cobra después de "deactivate" → 1-star Trustpilot                         |
| 5   | Per-identity timezone/locale/geo automático               | Ghost lo hace global, no per-identity                                           |
| 6   | Provider templates (Oxylabs, Bright Data, etc.)           | Pegas API key, traemos proxies                                                  |
| 7   | Health check + auto-disable de proxies                    | Ghost no monitorea                                                              |
| 8   | **MCP automation API**                                    | Ghost no tiene automation API; nosotros conectamos a Claude/Cursor sin esfuerzo |
| 9   | Multi-extension SIN whitelist                             | Ghost solo permite ~7 extensions específicas                                    |
| 10  | Bandwidth meter                                           | Ghost no muestra uso                                                            |
| 11  | Backup .ozbackup completo (incluye autofill+localStorage) | Ghost los excluye desde 2018                                                    |
| 12  | Real-time conflict resolution en sync                     | Ghost confiesa "wonky" en concurrent edits                                      |
| 13  | Workspace templates marketplace                           | No existe en mercado                                                            |
| 14  | Live fingerprint preview en identity editor               | Ningún antidetect lo tiene                                                      |
| 15  | Bulk identity creation desde CSV                          | Ghost te obliga uno-por-uno                                                     |
| 16  | Account Vault + Excel I/O + anti-logout                   | Ghost no tiene nada equivalente                                                 |
| 17  | Time Machine snapshots                                    | Ghost no tiene                                                                  |
| 18  | Office Edition con admin dashboard                        | Ghost no tiene team management                                                  |

---

## 5. Estimado de esfuerzo

Con sólo Claude (yo) implementando + Jose dirigiendo:

| Etapa       | Bloques                                                                       | Horas mías estimadas | Sesiones              |
| ----------- | ----------------------------------------------------------------------------- | -------------------- | --------------------- |
| ✅ 0        | spike                                                                         | hecho                | 1                     |
| ✅ 1.1      | foundation                                                                    | hecho                | 1                     |
| ✅ 1.2      | identity + lazy + logger + custom UA + smoke test                             | ~6h hechas           | 4                     |
| 🆕 1.3-MCP  | OZ MCP server                                                                 | ~12-16h              | 6-8                   |
| 🆕 1.3.5-CI | GitHub Actions                                                                | ~3h                  | 1-2                   |
| 🆕 1.3.6-DX | ESLint + pre-commit + checklists                                              | ~2h                  | 1                     |
| 🆕 1.4-WS   | workspaces                                                                    | ~10h                 | 5-6                   |
| 🆕 1.5      | ⭐ Account Vault (CORE)                                                       | ~14h                 | 7-8                   |
| 🆕 1.6      | Time Machine + backup                                                         | ~5h                  | 3                     |
| 🆕 1.7      | tab context menu + cookies                                                    | ~6h                  | 3-4                   |
| 🆕 1.8      | proxies                                                                       | ~12h                 | 6-7                   |
| 🆕 1.9      | fingerprint engine                                                            | ~14h                 | 7-8                   |
| 🆕 1.10     | Settings + bookmarks/etc + polish + extensions multi-identity + M-series perf | ~16h                 | 8-10                  |
| 2           | UX competitiva + candidatos C-11..C-15 según appetite                         | ~8-15h               | 4-7                   |
| 3           | distribución                                                                  | ~5h                  | 3 (depende Apple Dev) |
| 4           | auth backend                                                                  | ~10h                 | 5-7                   |
| 5           | Stripe billing                                                                | ~6h                  | 3-5                   |
| 6           | marketing site                                                                | ~6h                  | 3-4                   |
| 7           | cloud sync E2E                                                                | ~12h                 | 6-8                   |
| 8           | Windows + Linux                                                               | ~8h                  | 4-6                   |

**Total realista a producto vendible (Etapas 0–6):** ~150 horas mías + ~$110 de costos directos.

> ⚠️ El estimado incluye tiempo dedicado a documentación, logging, CI, lint y benchmarks (regla viva, no opcional). Si lo recortáramos saldría ~25-30% más rápido pero la deuda técnica nos hundiría a las 3 meses. NO recortar.

A 1-2 sesiones por día = ~3-4 meses calendario.

---

## 6. Próximo paso concreto

**Bloque 1.3-MCP cerrado 2026-05-09.** 57/57 smoke verde, todo el scope v1 entregado, hand-rolled JSON-RPC sin deps nuevas. Detalles en [`history/08-bloque-1.3-mcp-resultado.md`](history/08-bloque-1.3-mcp-resultado.md).

**Próximo: Bloque 1.3.5-CI** (~3h, ADR 0013):

1. Crear `.github/workflows/ci.yml`:
   - Trigger: push a cualquier branch + PR a main.
   - Jobs: `npm install`, `npm run lint` (placeholder por ahora), `npm run check:loc`, `npm test`.
   - Runner: macos-latest.
   - Caching de `~/.npm` por hash de package-lock.json.
2. Cron nightly job (03:00 UTC) corre todos los smoke tests + sube logs si fallan.
3. Status badge en `README.md`.
4. Branch protection rule en GitHub Settings (orientativo hasta team > 1).
5. Push a branch de prueba para validar verde.

Después: **1.3.6-DX** (2h) → **1.4-WS Workspace Manager**.

---

## 7. Documentos relacionados

- [`OVERVIEW.md`](OVERVIEW.md) — TL;DR de 2 min
- [`DOCUMENTATION-RULES.md`](DOCUMENTATION-RULES.md) — las 7 reglas de doc
- [`DEPENDENCIES.md`](DEPENDENCIES.md) — stack + diagrama
- [`BENCHMARKS.md`](BENCHMARKS.md) — mediciones por release
- [`CHANGELOG.md`](CHANGELOG.md) — bitácora ejecutiva (1 línea por bloque)
- [`architecture/`](architecture/) — ADRs 0001-0014
- [`history/07-bloque-1.2-resultado.md`](history/07-bloque-1.2-resultado.md) — cierre del 1.2
- [`processes/CHECKLIST-CIERRE-BLOQUE.md`](processes/CHECKLIST-CIERRE-BLOQUE.md) — qué tiene que estar verde antes de cerrar bloque
- [`Projects/Ghost Browser Clone/07-PLAN-MAESTRO-V2.md`](../../07-PLAN-MAESTRO-V2.md) — DEPRECADO, redirige aquí
