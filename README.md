# OZ Browser

Multi-session Chromium browser para **manejar 50+ cuentas de redes sociales al mismo tiempo** con vault de credenciales, anti-logout, Excel I/O, Time Machine, y admin dashboard para oficina. Optimizado para MacBook Apple Silicon (M1 8 GB target). Vendido como SaaS más barato que Ghost Browser.

**Empezar por aquí:**
- [`docs/OVERVIEW.md`](docs/OVERVIEW.md) — TL;DR de 2 minutos
- [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) — diagrama de dependencias entre bloques + reglas transversales
- [`docs/PLAN-MAESTRO.md`](docs/PLAN-MAESTRO.md) — plan completo

Built on Electron 37/42 + [`samuelmaddock/electron-browser-shell`](https://github.com/samuelmaddock/electron-browser-shell) (MIT) — heredamos la base, customizamos todo el resto.

---

## Estado

| Etapa / Bloque | Estado |
|---|---|
| **Etapa 0** — Validación técnica (Electron + partition isolation + proxy auth con Oxylabs) | ✅ |
| **Bloque 1.1** — Foundation (fork shell, repo privado) | ✅ |
| **Bloque 1.2** — Identity Manager + Lazy Tabs + Sidebar + Top tabstrip + Logger + Error popup | 🚧 ~70% |
| **Bloque 1.3** — Workspace Manager (multi-window real) | ⏳ |
| **Bloque 1.4** — Proxy Manager (bulk import, health checks, provider templates) | ⏳ |
| **Bloque 1.5** — FingerprintEngine "Ghost+" (pasa Pixelscan/CreepJS) | ⏳ |
| **Bloque 1.6** — Tab context menu (16 opciones Ghost parity) + cookies por identity | ⏳ |
| **Bloque 1.7** — Settings UI completa + Bookmarks/Downloads/History | ⏳ |
| **Bloque 1.8** — Backup / Restore (.ozbackup) | ⏳ |
| **Bloque 1.9** — Polish + Extensions en todas las identities | ⏳ |
| **Etapa 2** — UX competitiva | ⏳ |
| **Etapa 3** — Distribución firmada + auto-update | ⏳ ($99 Apple Dev) |
| **Etapa 4** — Backend SaaS: auth + entitlements | ⏳ |
| **Etapa 5** — Billing Stripe + self-service cancel | ⏳ |
| **Etapa 6** — Marketing site + signup | ⏳ ($12 dominio) |
| **Etapa 7** — Cloud Sync E2E | ⏳ |
| **Etapa 8** — Windows + Linux | ⏳ ($50-150 cert Win) |
| **Etapa 9** — Antidetect top-tier (fork Chromium) | 🔮 futuro |
| **Etapa 10** — Team & Enterprise | 🔮 futuro |

---

## Quick start

```bash
npm install
NODE_ENV= npm start              # dev (workaround: shell tiene NODE_ENV=production)
SHELL_DEBUG=1 NODE_ENV= npm start # con DevTools abiertos
npm run make                      # build .dmg para distribución
```

**Nota:** el shell del usuario exporta `NODE_ENV=production` lo cual bloquea la instalación de devDependencies. Por eso siempre prefijamos `NODE_ENV=` (con espacio) al correr `npm install` o `npm start` durante desarrollo.

## Estructura del código

```
oz-browser/
├─ index.js                  # entry point — instancia Browser
├─ preload.js                # bridge contextBridge → window.oz
├─ forge.config.js           # electron-forge build config
│
├─ browser/                  # MAIN PROCESS
│  ├─ main.js                # orquestador: app lifecycle, ventanas, IPC
│  ├─ menu.js                # app menu (mac top menubar)
│  ├─ identity-manager.js   ✅
│  ├─ tabs.js               ✅ (lazy materialization)
│  ├─ logger.js             ✅ (rotación, ~/Library/Logs/OZ Browser/)
│  ├─ error-handler.js      ✅ (popup con email a Jose)
│  ├─ workspace-manager.js  ⏳ Bloque 1.3
│  ├─ proxy-manager.js      ⏳ Bloque 1.4
│  ├─ fingerprint-engine.js ⏳ Bloque 1.5
│  ├─ tab-context-menu.js   ⏳ Bloque 1.6
│  ├─ extension-manager.js  ⏳ Bloque 1.9
│  ├─ backup-manager.js     ⏳ Bloque 1.8
│  ├─ auth-client.js        ⏳ Etapa 4
│  ├─ billing-client.js     ⏳ Etapa 5
│  ├─ sync-client.js        ⏳ Etapa 7
│  ├─ auto-update.js        ⏳ Etapa 3
│  └─ ui/                   # RENDERER (browser chrome cargado como Chrome ext.)
│     ├─ webui.html         ✅ (sidebar 220px + topbar + content placeholder)
│     ├─ webui.js           ✅ (TabStrip + IdentitySidebar)
│     ├─ new-tab.html
│     └─ ...
│
└─ docs/                    # documentación del proyecto
   ├─ PLAN-MAESTRO.md       ← fuente única de verdad
   ├─ 01-research-ghost-browser.md
   ├─ 02-research-stack.md
   ├─ 03-sintesis-pivot-saas.md
   ├─ 05-etapa-0-resultado.md
   └─ 06-bloque-1.1-resultado.md
```

## Decisiones técnicas clave (no re-debatir)

1. **Electron + WebContentsView + `session.fromPartition('persist:identity-X')`** valida en Etapa 0 — soporta cookie isolation real a nivel SQLite, proxy con auth via `app.on('login')`.
2. **Default identity usa `defaultSession`** — para que extensions del Chrome Web Store funcionen ahí. Otras identities usan partitions; soporte de extensions per-identity en Bloque 1.9.
3. **Tabs lazy** — `WebContentsView` y renderer process solo se crean en primer click. Soporta 100+ tabs sin pesar.
4. **HTTPS proxies preferidos sobre SOCKS5** en Electron — `app.on('login')` es más estable.
5. **Antidetect "Ghost+"** vía preload script con seed coherente per-identity. NO fork de Chromium en v1.
6. **Backup completo en .ozbackup** (ZIP + AES-256-GCM opcional) — incluye autofill+localStorage que Ghost excluye desde 2018.
7. **Sync cloud E2E** propio en Supabase (no folder Dropbox como Ghost).
8. **Pricing:** Free 3 ID → Basic ~$12-15/mo → Pro ~$29-35/mo → Team ~$15/seat. La mitad que Ghost.
9. **Cancel self-service real** — no la trampa de Ghost (Trustpilot 2.9).

## Diferenciadores reales vs Ghost (nuestro moat)

Ver [`docs/PLAN-MAESTRO.md` § 4](docs/PLAN-MAESTRO.md). Lo top:

1. Pasar Pixelscan/CreepJS por default (Ghost falla)
2. Sync E2E en la nube (Ghost solo escribe a folder Dropbox)
3. Multi-window workspaces de verdad (Ghost obliga a usar profiles separados)
4. Self-service cancel real
5. Per-identity timezone/locale/geo automático del proxy
6. Templates de proveedores de proxies (Bright Data, Oxylabs, etc.)
7. Health-check + auto-disable de proxies muertos
8. CDP automation API para Puppeteer/Playwright
9. Multi-extension SIN whitelist hardcodeada (Ghost solo permite ~7)
10. Bandwidth meter por proxy/identity

## Logs y errores

- Log file: `~/Library/Logs/OZ Browser/oz-browser.log` (rotación a 10 MB, mantiene 3 archivos viejos)
- Crashes en main, renderer y child processes capturados → popup con 4 botones: **Email Jose**, **Copy details**, **Open log file**, **Dismiss**
- Email a Jose pre-rellena con stack trace + system info para reportar errores

## Licencia

UNLICENSED — código privado, no redistribuir. Hereda partes con licencia MIT de [`electron-browser-shell`](https://github.com/samuelmaddock/electron-browser-shell).
