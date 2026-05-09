# OZ Browser — Plan Maestro v2.1 (reestructurado)

**Fecha:** 2026-05-09
**Estado:** Etapa 0 ✅ · Bloque 1.1 ✅ · Bloque 1.2 ~70% (sidebar + lazy tabs + identity manager + logger + error popup hechos; falta integración con todo lo nuevo descubierto)

Este documento reemplaza `04-Plan-en-Etapas.md` como fuente única de verdad. Lo de antes queda como referencia histórica.

---

## 0. Caso de uso primario (la razón por la que existe OZ Browser)

> **Manejar 50+ cuentas de redes sociales al mismo tiempo, todas logoneadas, todas persistidas, con sus claves seguras y exportables/importables a Excel.**

Ejemplo concreto: Jose tiene 50 cuentas de X (Twitter), las quiere abiertas TODAS al mismo tiempo en un Workspace, cada una con su proxy mobile dedicado, cada una **logoneada y que se quede logoneada sin desloguearse**, claves guardadas, listables/exportables a Excel para administrarlas.

Funcionalidad core derivada (Bloque 1.10 — la columna vertebral del producto):
1. **Account Vault** — credenciales (username + password + 2FA seed) cifradas con AES-256-GCM, encriptadas con master password (derivado con scrypt) o macOS Keychain.
2. **Auto-fill por Identity** — al cargar una página de login conocida (X, Instagram, FB, TikTok, LinkedIn, YouTube, Reddit, Threads, Telegram, Discord), se inyectan las credenciales de esa Identity.
3. **Auto-save** — al detectar form submission en login, popup "guardar credenciales para Identity X / Workspace Y?".
4. **Anti-logout robusto** — extender cookie expiry de session cookies a 1 año en dominios de redes sociales (Ghost no hace esto). Health check pasivo (visita el feed cada N días para mantener sesión warm). Detección + auto-relogin si una sesión muere.
5. **Excel Export** — `.xlsx` con: Workspace, Identity, Site, Username, Password, Last Login, Status, Notes, Cookies Count, Last IP del proxy. Usa SheetJS.
6. **Excel Import con 3 modos:**
   a) **PERMANENT MERGE** — agrega las identities y cuentas al estado actual.
   b) **EPHEMERAL SESSION** — sessions in-memory (no persist), abre tabs, al cerrar todo se descarta, Mac queda como estaba (modo "viaje").
   c) **NEW WORKSPACE** — agrega como workspace dedicado, sin tocar los existentes.
   d) **OVERWRITE TOTAL** — reemplaza TODO el estado actual con el contenido del Excel. Antes de aplicar, snapshot automático del estado anterior (Time Machine). Use case: exportas, alguien externo organiza/limpia, te lo devuelve, lo cargas en OVERWRITE y queda como él lo dejó. **Round-trip lossless:** import → merge → export = Excel UNIFICADO; o exportar → mandar → recibir corregido → OVERWRITE.
7. **Bulk identity creation desde Excel/CSV** — importas N filas y se crean N identities con auto-login. Onboarding de 50 cuentas en un click.
8. **Site templates** — selectores CSS conocidos por plataforma para form fields, login button, "logged in" detection.
9. **Cap de 25 identities por workspace de Ghost → REMOVIDO** (palette de colores generada algorítmicamente; sidebar con virtual scroll para soportar 50+).

Esto NO es una feature más. **Es el producto.** Todo lo demás (workspaces, proxies, antidetect, sync) existe para servir este flujo.

---

## 1. Resumen ejecutivo

OZ Browser es un clon-mejor de Ghost Browser, vendido como SaaS más barato, **enfocado en gestión masiva de cuentas de redes sociales**. El stack es **Electron 37/42 + electron-browser-shell + IdentityManager + WorkspaceManager + FingerprintEngine + AccountVault + Cloud Sync**. Todo el código vive en módulos chicos y bien separados. El plan tiene **10 etapas**, cada una útil por sí sola.

**Lo que vamos a hacer mejor que Ghost** (nuestros diferenciadores reales, no hype):
1. **Account Vault + auto-fill + anti-logout + Excel import/export** ← Ghost no tiene nada de esto, es nuestro #1 moat
2. Pasar Pixelscan/CreepJS por default (Ghost falla — Trustpilot 2.9)
3. Sync E2E real en la nube (Ghost solo sincroniza a una carpeta tipo Dropbox)
4. Multi-window workspaces de verdad (Ghost obliga a usar profiles separados)
5. Cancelación self-service real (Ghost cobra después de "deactivate")
6. Per-identity timezone/locale/geo automático del proxy (Ghost lo hace global)
7. Templates de proveedores de proxies (Bright Data, Smartproxy, Oxylabs, IPRoyal)
8. Health-check automático de proxies con auto-disable
9. CDP endpoint para Puppeteer/Playwright (Ghost no tiene automation API)
10. Multi-extension SIN whitelist hardcodeada (Ghost solo permite ~7 extensions)
11. Bandwidth meter por proxy/identity
12. **Modo Ephemeral Session** — abre 50 cuentas desde un Excel, las usas, cierras, Mac queda limpia (Ghost no tiene)
13. **Cap de 25 Temporary Identities por workspace REMOVIDO** (Ghost lo tiene hardcodeado a 25 colores)
14. **Time Machine** — snapshot diario automático del estado completo, retention configurable, restore a cualquier versión anterior con un click. Antes de cualquier operación destructiva (OVERWRITE, bulk delete, restore) snapshot forzado. Ghost no tiene nada parecido.
15. **Workflow colaborativo Excel** — exporta → manda a alguien para que organice/limpie/agregue → recibe corregido → OVERWRITE en OZ → queda exacto como te lo devolvió. Sin Ghost.

---

## 1. Arquitectura modular (para que sea limpio desde el día 1)

### 1.1 Estructura de archivos del cliente desktop

```
oz-browser/
├─ index.js                          # entry point — instancia Browser
├─ preload.js                        # bridge contextBridge → window.oz
├─ forge.config.js                   # electron-forge build config
├─ webpack.main.config.js
├─ webpack.renderer.config.js
├─ package.json
│
├─ browser/                          # MAIN PROCESS (lógica core)
│  ├─ main.js                        # orquestador: app lifecycle, ventanas
│  ├─ menu.js                        # app menu (mac top menubar)
│  │
│  ├─ identity-manager.js     ✅      # Identity CRUD + sessions
│  ├─ workspace-manager.js    🚧      # Workspace CRUD + freeze/archive
│  ├─ proxy-manager.js        🚧      # Pool, bulk import, auto-assign, health
│  ├─ fingerprint-engine.js   🚧      # Per-identity coherent fingerprint
│  ├─ account-vault.js        🆕      # 🌟 CORE: cred storage + auto-fill + anti-logout
│  ├─ site-templates.js       🆕      # CSS selectors para X/IG/FB/TikTok/LinkedIn/YT/Reddit
│  ├─ excel-io.js             🆕      # Import/export Excel (.xlsx) con SheetJS
│  ├─ extension-manager.js    🚧      # Multi-extension per identity
│  │
│  ├─ tabs.js                 ✅      # Tab + Tabs (lazy materialization)
│  ├─ tab-context-menu.js     🆕      # Right-click menu (Ghost parity + más)
│  │
│  ├─ logger.js               ✅      # Unified file logger con rotación
│  ├─ error-handler.js        ✅      # Popup con email a Jose
│  │
│  ├─ backup-manager.js       🆕      # Export/Import .ozbackup completo
│  ├─ sync-client.js          🆕      # Cloud sync (Etapa 7)
│  ├─ auth-client.js          🆕      # Login + entitlements (Etapa 4)
│  ├─ billing-client.js       🆕      # Stripe (Etapa 5)
│  ├─ auto-update.js          🆕      # electron-updater wrapper (Etapa 3)
│  ├─ telemetry.js            🆕      # Crash & metric reporting opt-in
│  │
│  └─ ui/                            # RENDERER (browser chrome — chrome ext.)
│     ├─ manifest.json
│     ├─ webui.html                  # browser shell (sidebar + topbar)
│     ├─ webui.js
│     ├─ new-tab.html
│     ├─ settings/
│     │   ├─ settings.html           # tabs: General, Privacy, Identities,
│     │   ├─ settings.js             #       Workspaces, Proxies, Sync,
│     │   └─ settings.css            #       Extensions, Account, About
│     ├─ identity-editor.html        # modal de edición de Identity
│     ├─ workspace-manager.html      # vista grande de workspaces
│     ├─ proxy-manager.html          # vista grande de proxies
│     ├─ bookmarks.html
│     ├─ downloads.html
│     ├─ history.html
│     └─ assets/
│        ├─ icons/                   # SVG icons per módulo
│        └─ themes/                  # Light + dark
│
├─ shared/                           # Tipos / constantes compartidos
│  ├─ schema.json                    # Esquema de identity, workspace, proxy
│  └─ events.js                      # Nombres de IPC channels
│
└─ data/ (gitignored)                # Datos locales runtime
   ├─ identities.json
   ├─ workspaces.json
   ├─ proxies.json
   ├─ settings.json
   └─ Partitions/<identity-id>/      # storage Electron por identity
```

✅ existe · 🚧 parcial · 🆕 por construir

### 1.2 Backend SaaS

```
oz-saas-backend/                     # Repo separado (Etapas 4–7)
├─ supabase/
│  ├─ migrations/                    # SQL schema migrations
│  └─ functions/                     # Edge functions (auth, billing webhook)
│
├─ schema/
│  ├─ users
│  ├─ subscriptions
│  ├─ entitlements
│  ├─ devices
│  ├─ synced_identities              # encrypted blob + version
│  ├─ synced_workspaces
│  ├─ synced_proxies
│  ├─ synced_bookmarks
│  └─ team_memberships
│
├─ stripe/
│  └─ webhook-handler/
│
└─ updates/                           # Servidor de updates electron-updater
   └─ release-feeds/
```

### 1.3 Marketing site (Etapa 6)

```
oz-marketing/                        # Repo separado (Vercel)
├─ pages/
│  ├─ index.tsx                      # Landing
│  ├─ pricing.tsx
│  ├─ docs/                          # Knowledge base
│  └─ download.tsx
└─ ...
```

---

## 2. Etapas reorganizadas

> **Cambio importante respecto al plan v1:** divido la Etapa 1 en bloques más finos y reordenados según dependencias reales descubiertas con la implementación. Cada bloque entrega valor por sí solo.

### ✅ ETAPA 0 — Validación técnica (HECHA, 2026-05-09)
- Electron + partition isolation + proxy auth con Oxylabs ✅

### ETAPA 1 — Cliente desktop funcional para Jose

#### ✅ Bloque 1.1 — Foundation (HECHO, 2026-05-09)
- Fork de electron-browser-shell, repo privado en GitHub
- Tabs + omnibox + back/forward/reload heredados
- Layout sidebar+content base

#### 🚧 Bloque 1.2 — Identity Manager + Lazy Tabs + Logger (~70%)
**Hecho:**
- IdentityManager backend con persistencia
- Default identity always-on (usa defaultSession para extensions Chrome)
- Tabs lazy (no renderer process hasta primer click)
- Sidebar UI con CRUD de Identities
- Top tabstrip OZ-based (mostrando todas las tabs con stripe del color de identity)
- Logger con archivo + rotación
- Error popup con email a Jose
- IPC handlers consolidados

**Falta:**
- Default Identity siempre presente como row visible en sidebar (con `(n)` count y `+` button)
- Tab list AGRUPADA debajo de cada identity en sidebar (ya está, validar)
- Drag-and-drop para reordenar identities y tabs
- Fix del bug de tab duplicada al arranque
- Per-identity custom UA (UI en identity-editor.html)
- Tag system para identities (filterable)
- Reset Identity (regenera fingerprint, mantiene cookies opt.)
- Cap de identities por tier (3 free, ilimitado paid — placeholder mientras no hay billing)

#### 🆕 Bloque 1.3 — Workspace Manager
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

#### 🆕 Bloque 1.4 — Proxy Manager
**Modelo:**
```js
Proxy = {
  id, name, protocol, host, port, username, password,
  tags: [], country?, lastTestedAt, lastLatencyMs, isActive,
  bandwidthBytesUsed
}
```
- CRUD individual + UI dedicada (proxy-manager.html)
- Bulk import CSV con formato compat con Ghost (mismo CSV que importas en Ghost se importa aquí)
- Test de conectividad (paralelo, todos a la vez)
- Auto-Assign: random / round-robin al crear nueva tab/identity
- Asignación manual: per-tab, per-identity, per-workspace (jerarquía Tab>ID>WS)
- Bypass list (faltante en Ghost)
- Health checks intervalados con auto-disable de proxies muertos (mejor que Ghost)
- Templates por provider: Oxylabs, Bright Data, Smartproxy, IPRoyal — pega API key, traemos lista (mejor que Ghost)
- Bandwidth meter per proxy

#### 🆕 Bloque 1.5 — FingerprintEngine "Ghost+"
**Pasar Pixelscan/CreepJS por default.**
Por cada Identity, generar y persistir un fingerprint coherente derivado de un seed UUID. Vectores spoofeados via preload script en cada partition session:

| Vector | Implementación |
|---|---|
| User-Agent + platform + appVersion | Override navigator.* |
| Hardware concurrency | Override navigator.hardwareConcurrency |
| deviceMemory | Override navigator.deviceMemory |
| Languages | Override navigator.languages, navigator.language |
| Screen / dpr | Override window.screen.* + devicePixelRatio |
| Timezone | Override Intl.DateTimeFormat + Date.prototype.getTimezoneOffset |
| WebGL vendor/renderer | Hook getParameter(GL_VENDOR/GL_RENDERER) |
| Canvas | Add seeded noise to toDataURL/toBlob/getImageData |
| AudioContext | Add seeded noise to OfflineAudioContext.startRendering |
| Fonts | Filter Canvas measureText / document.fonts to subset |
| Plugins / mimeTypes | Override navigator.plugins to coherent list |
| WebRTC | Disable RTCPeerConnection or force proxy IP |
| Battery | Override deprecated battery API |
| Speech / Voices | Filter speechSynthesis.getVoices |

**Coherencia automática vía proxy GeoIP (mejor que Ghost):**
- Cuando asignas un proxy a una Identity, OZ propone (con confirmación):
  - Timezone derivado de IP geolocation
  - Languages derivados del país
  - Locale + UA region
- Toggleable: "Auto-align fingerprint with proxy"

**Suite de tests CI:**
- Abrir Pixelscan / iphey / browserleaks / CreepJS con N identities distintas
- Validar consistencia per-identity y diversidad cross-identity
- Bloquea release si baja del threshold

#### 🆕 Bloque 1.6 — Tab Context Menu + Cookies por Identity
- Menú nativo via Electron `Menu.buildFromTemplate`, replicando Ghost:
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

#### 🆕 Bloque 1.7 — Settings UI + Bookmarks/Downloads/History
- Settings página completa con secciones:
  - **General**: startup mode, default search engine, default browser, downloads folder
  - **Appearance**: theme (light/dark/auto/oled), accent color, font size
  - **Identities**: list + edit + reset, per-identity download folder (mejor que Ghost)
  - **Workspaces**: defaults
  - **Proxies**: shortcut a proxy-manager.html
  - **Privacy / Anti-Detection**: per-identity overrides para todos los toggles del FingerprintEngine
  - **Sync**: enable, choose backend (cloud OZ / local folder / disabled), Private Sync Code
  - **Extensions**: link to manage, multi-extension toggle
  - **Backup**: Export / Import .ozbackup
  - **Updates**: channel (stable/beta/dev), check now
  - **Account**: cuando llegue billing
  - **About**: versión, log file location, "Email Jose"
  - **Manage Shortcuts**: editor de keyboard shortcuts (per-shortcut: In OZ / Global)
- Bookmarks page (Chromium-style, búsqueda, "open in identity X" dropdown como Ghost)
- Downloads page
- History page (filterable por identity)
- Per-identity browsing data clear (URL bar shield + identity dropdown)

#### 🆕 Bloque 1.8 — Backup / Restore + Time Machine (snapshots automáticos)
- `backup-manager.js`: empaqueta a `.ozbackup` (zip cifrado AES-256-GCM):
  - identities.json + workspaces.json + proxies.json + settings.json + bookmarks + vault.enc
  - Todo `data/Partitions/*` (cookies, IndexedDB, localStorage, service workers, cache)
  - Metadata: version, timestamp, machine fingerprint, label (auto-snapshot/manual/pre-overwrite)
- Export manual desde Settings → Backup
- Import flow: pick .ozbackup → passcode → confirm → reinicia con datos restaurados

**Time Machine (snapshots automáticos):**
- **Daily snapshot:** cron interno cada día a las 3am en `data/snapshots/YYYY-MM-DD-HHMMSS.ozbackup`. Configurable: daily / weekly / on-change-only.
- **Pre-destructive snapshots:** snapshot forzado antes de OVERWRITE de Excel, bulk delete, factory reset, restore de otro backup. Siempre se puede revertir.
- **Retention policy** (Settings → Time Machine): keep last N días (default 30) / keep all / keep weekly forever / custom.
- **UI Settings → Time Machine:** lista cronológica de snapshots con label + tamaño + descripción. Botón "Restore this version" (con snapshot automático del estado actual antes de revertir). Diff view opcional (qué cambió entre 2 snapshots). Export individual snapshot a archivo.
- **Manual snapshot button** + atajo de teclado para crear snapshot etiquetable.
- **Almacenamiento:** snapshots cifrados con master password del vault. Compresión zstd. ~50 MB/snapshot con 100 identities + 1000 cookies. ~1.5 GB/mes peor caso.
- **Cloud snapshots (Etapa 7):** push a Supabase encriptado, restore desde otra Mac.

#### 🆕 Bloque 1.10 — Account Vault + Auto-fill + Excel I/O + Anti-logout (🌟 CORE)

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

2. **`site-templates.js`** — selectores CSS y URLs por plataforma:
   ```js
   {
     'x.com': {
       loginUrl: 'https://x.com/i/flow/login',
       usernameSelector: 'input[autocomplete="username"]',
       passwordSelector: 'input[name="password"]',
       submitSelector: '[data-testid="LoginForm_Login_Button"]',
       loggedInIndicator: '[data-testid="SideNav_AccountSwitcher_Button"]',
       sessionCookies: ['auth_token', 'ct0', 'twid'],
     },
     'instagram.com': {...},
     'facebook.com': {...},
     // X, Instagram, Facebook, TikTok, LinkedIn, YouTube, Reddit, Threads, Telegram, Discord
   }
   ```

3. **Auto-fill** — content script inyectado en cada Identity. Cuando carga una página de login conocida, lee credentials del vault y rellena.

4. **Auto-save** — interceptar form submissions; popup "Save credentials para Identity X?".

5. **Anti-logout robusto:**
   - Hook a `webContents.session.cookies.onChanged` — cuando cambia una session cookie de redes sociales, EXTENDER expiry a 1 año.
   - Health check daemon: cada 6 días, navega passively al home de cada plataforma para refresh de session.
   - Detección de logout: si tab navega a `/login` o session cookie vacía → `status='needs_relogin'` + notification + opción de auto-relogin.

6. **Excel Export** — Settings → Accounts → Export. `.xlsx` columnas: Workspace, Identity, Site, Username, Password, 2FA Secret, Last Login, Status, Cookies Count, Last IP, Proxy, Notes. SheetJS hace el writeFile.

7. **Excel Import** — Drag-drop .xlsx o file picker. Pre-visualiza N identities + cuentas. Pregunta modo:
   - **PERMANENT MERGE** — agrega al estado actual (persist).
   - **EPHEMERAL SESSION** — sessions in-memory (`session.fromPartition('memory:...')` o no-persist), al cerrar la app desaparece todo, Mac queda igual.
   - **NEW WORKSPACE** — crea workspace dedicado.

8. **Bulk identity creation** — importar Excel = crear N identities + asignar proxies + auto-login.

9. **Identity cap remove** — Ghost tiene cap 25; nosotros generamos colores algorítmicamente (HSL espaciados), virtual scroll en sidebar para 100+.

10. **Account Manager UI** — sección dedicada en sidebar y página completa en Settings. Search por username/site/identity. Filter por workspace/identity/site/status. Bulk actions: re-login all, export selected, delete.

11. **Per-account proxy chip** — visual indicator del país de la IP por la que la cuenta está logoneada. Si proxy cambia y geo no match → warning.

#### 🆕 Bloque 1.9 — Polish + bug fixes + extensions support en partitions
- Extensions de Chrome Web Store funcionando en TODAS las identities (no solo Default)
  - Múltiples instancias de ElectronChromeExtensions, una por session
  - O un único service worker que se inyecta en todas
- Fix del bug de tab duplicada al arranque
- Drag-and-drop reorder
- Loading states bonitos
- First-run onboarding (3 pantallas explicando Identities, Workspaces, Proxies)
- Hotkey panel customizable

### ETAPA 2 — UX competitiva
- Tab visual con stripe del color de identity (ya está)
- Animaciones suaves al cambiar de workspace
- Sidebar resizable (con drag handle)
- Sidebar collapsable a thin rail
- Modular Sidebar opcional (post-MVP)
- App Dock para PWAs pinnables (post-MVP)
- Browser-action toolbar limpio (clean toolbar mode)

### ETAPA 3 — Distribución firmada + auto-update
- Apple Developer ($99) + signing + notarización
- electron-updater apuntando a GitHub Releases o S3 propio
- CI/CD con GitHub Actions
- DMG con installer pulido + branding OZ

### ETAPA 4 — Backend SaaS: auth + entitlements
- Supabase project (free tier)
- Schema: users, subscriptions, entitlements, devices
- `auth-client.js` en cliente: login pantalla pre-browser
- Feature gating runtime: si plan = Free → cap 3 identities, sin GPC; Basic → ilimitado, sin GPC; Pro → ilimitado + GPC; Team → + sync admin
- Server-side validation + offline grace period

### ETAPA 5 — Billing con Stripe
- Stripe products: Free / Basic ($12-15) / Pro ($29-35) / Team ($15/seat)
- Checkout in-app (window externa) y desde marketing site
- Self-service portal: upgrade, downgrade, cancel, refund window — **diferenciador clave** vs Ghost
- Webhooks → Supabase Edge Functions
- Trial de 7 días para Pro
- Promo codes para early adopters

### ETAPA 6 — Marketing site + signup
- Landing en Vercel free
- Pricing comparativa vs Ghost
- Documentación
- Email transaccional (Resend)
- SEO básico

### ETAPA 7 — Cloud Sync E2E
- `sync-client.js`: encripta antes de subir (passcode-derived AES-GCM key)
- Schema en Supabase: `synced_identities`, `synced_workspaces`, `synced_proxies` con `version` para conflict resolution
- Vector clocks o last-write-wins
- Multi-device login
- Cloud backup automático (snapshot diario)
- **Mejor que Ghost**: incluye autofill passwords + localStorage

### ETAPA 8 — Windows + Linux
- Cross-platform build pipeline
- Windows code signing (DigiCert OV/EV)
- Captura el 70% del mercado antidetect
- Linux (Ubuntu/Debian) opcional

### ETAPA 9 — Antidetect top-tier (futuro lejano)
- Solo si MRR > $5K. Fork de Chromium real con patches a TLS fingerprint, V8 timing, graphics más profundo. Requiere dev C++ contratado.

### ETAPA 10 — Team & Enterprise (futuro)
- Admin dashboard con seat management
- Audit log
- Roles RBAC (admin / member / read-only) sobre workspaces/identities
- SSO (SAML/Okta)
- Self-hosted opcional

---

## 3. Roadmap de features prioritizado (qué nos falta vs Ghost)

### MUST-HAVE para v1 (parity Ghost Free)
1. ✅ Default Identity always-present
2. 🚧 Tab list bajo cada identity en sidebar
3. 🆕 Workspaces CRUD con freeze/archive/restore/duplicate
4. 🆕 Tab right-click context menu (16 opciones)
5. 🆕 Keyboard shortcuts customizables
6. 🆕 Settings UI shell completa
7. 🆕 Extensions soporte en TODAS las identities
8. 🆕 Bookmarks/Downloads/History pages
9. 🆕 Per-identity cookie clear
10. 🆕 Per-identity Reset
11. 🆕 Per-identity custom UA
12. 🆕 Per-identity proxy
13. 🆕 Bulk CSV proxy import
14. 🆕 Tab-level proxy override
15. 🆕 Pricing & gating UI
16. 🆕 Quick Tabs 4 modos (lazy ya hecho, exponer modos)
17. ✅ Dark mode (electron lo trae)
18. 🆕 Anti-detection toggles (WebRTC, Canvas noise, etc.)

### SHOULD-HAVE para v1 (diferenciadores reales)
19. 🆕 **Pasar Pixelscan/CreepJS por default** — fingerprint coherente per-identity
20. 🆕 **Auto-align fingerprint con proxy GeoIP**
21. 🆕 **Per-identity timezone/locale/language**
22. 🆕 **CDP automation API** para Puppeteer/Playwright
23. 🆕 **Cloud sync E2E** (Etapa 7)
24. 🆕 **Workspace templates** (.ozworkspace JSON)
25. 🆕 **Multi-window workspaces de verdad**
26. 🆕 **Self-service cancellation**
27. 🆕 **Proxy health checks + auto-disable**

### NICE-TO-HAVE post-v1
28. Modular sidebar + Tasks
29. App Dock
30. Multi-extension SIN whitelist (cualquier extension, no solo 7)
31. Recurring scheduled workspaces
32. Team admin dashboard
33. Native screenshot
34. Bandwidth meter per proxy/identity
35. Per-identity download folders
36. Per-identity bookmarks folders
37. Workspace marketplace

---

## 4. Lo que Ghost NO tiene y vamos a tener (moat real)

| # | Feature | Por qué importa |
|---|---|---|
| 1 | Pixelscan/CreepJS pass por default | Ghost falla → quejas en reviews |
| 2 | Cloud sync E2E real | Ghost solo escribe a folder Dropbox |
| 3 | Multi-window workspaces de verdad | Ghost obliga a usar profiles separados |
| 4 | Self-service cancel | Ghost cobra después de "deactivate" → 1-star Trustpilot |
| 5 | Per-identity timezone/locale/geo automático | Ghost lo hace global, no per-identity |
| 6 | Provider templates (Oxylabs, Bright Data, etc.) | Pegas API key, traemos proxies — Ghost te hace pegar CSV manual |
| 7 | Health check + auto-disable de proxies | Ghost no monitorea |
| 8 | CDP / Puppeteer endpoint | Ghost no tiene automation API |
| 9 | Multi-extension SIN whitelist | Ghost solo permite ~7 extensions específicas |
| 10 | Bandwidth meter | Ghost no muestra uso |
| 11 | Backup .ozbackup completo (incluye autofill+localStorage) | Ghost los excluye desde 2018 |
| 12 | Real-time conflict resolution en sync | Ghost confiesa "wonky" en concurrent edits |
| 13 | Workspace templates marketplace | No existe en mercado |
| 14 | Live fingerprint preview en identity editor | Ningún antidetect lo tiene |
| 15 | Bulk identity creation desde CSV | Ghost te obliga uno-por-uno |

---

## 5. Estimado de esfuerzo

Con sólo Claude (yo) implementando + Jose dirigiendo:

| Etapa | Bloques | Horas mías estimadas | Sesiones |
|---|---|---|---|
| ✅ 0 | spike | hecho | 1 |
| ✅ 1.1 | foundation | hecho | 1 |
| 🚧 1.2 | identity + lazy + logger | ~6h | 4 (3 hechas, 1 falta polish) |
| 🆕 1.3 | workspaces | ~10h | 5-6 |
| 🆕 1.4 | proxies | ~12h | 6-7 |
| 🆕 1.5 | fingerprint | ~14h | 7-8 |
| 🆕 1.6 | context menu + cookies | ~6h | 3-4 |
| 🆕 1.7 | settings + bookmarks/etc | ~10h | 5-6 |
| 🆕 1.8 | backup/restore | ~5h | 3 |
| 🆕 1.9 | polish + extensions | ~6h | 3-4 |
| 2 | UX competitiva | ~8h | 4-5 |
| 3 | distribución | ~5h | 3 (depende Apple Dev) |
| 4 | auth backend | ~10h | 5-7 |
| 5 | Stripe billing | ~6h | 3-5 |
| 6 | marketing site | ~6h | 3-4 |
| 7 | cloud sync E2E | ~12h | 6-8 |
| 8 | Windows + Linux | ~8h | 4-6 |

**Total realista a producto vendible (Etapas 0–6):** ~120 horas mías + ~$110 de costos directos.

A 1-2 sesiones por día = ~3 meses calendario.

---

## 6. Próximo paso concreto

**Cerrar Bloque 1.2:**
- Fix bug tab duplicada al arranque (investigar cuál chrome.tabs.create dispara la 2da)
- Default Identity siempre visible en sidebar como row con `(n)` count
- Per-identity custom UA en identity editor (modal HTML)
- Bug si lo hay: validar que click en lazy tab dentro de Cliente A SÍ materializa

**Después seguir con Bloque 1.3 — Workspace Manager.**

---

## 7. Documentos relacionados

- `01-Research-Ghost-Browser-Profundo.md` — perfil técnico de Ghost
- `02-Research-Stack-Tecnico.md` — comparativa de stacks
- `03-Sintesis-Pivot-SaaS.md` — implicaciones del pivot a SaaS
- `04-Plan-en-Etapas.md` — **DEPRECADO**, este v2 lo reemplaza
- `05-Resultado-Etapa-0.md` — validación spike
- `06-Resultado-Bloque-1.1.md` — foundation
- `07-PLAN-MAESTRO-V2.md` ← **estás aquí**
