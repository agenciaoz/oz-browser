# OZ Browser

[![CI](https://github.com/agenciaoz/oz-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/agenciaoz/oz-browser/actions/workflows/ci.yml)

Multi-session Chromium browser para **manejar 50+ cuentas de redes sociales al mismo tiempo** con vault de credenciales, anti-logout, Excel I/O, Time Machine, MCP automation API, y admin dashboard para oficina. Optimizado para MacBook Apple Silicon (M1 8 GB target). Vendido como SaaS más barato que Ghost Browser.

**Empezar por aquí:**

- [`docs/OVERVIEW.md`](docs/OVERVIEW.md) — TL;DR de 2 minutos
- [`docs/PLAN-MAESTRO.md`](docs/PLAN-MAESTRO.md) — plan completo (fuente única de verdad)
- [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) — diagrama de bloques + reglas
- [`docs/guides/dev-setup.md`](docs/guides/dev-setup.md) — levantar el proyecto en 5 min
- [`docs/guides/mcp-automation.md`](docs/guides/mcp-automation.md) — usar el MCP server con Claude Code/Cursor

Built on Electron 37 + [`samuelmaddock/electron-browser-shell`](https://github.com/samuelmaddock/electron-browser-shell) (MIT) — heredamos la base, customizamos todo el resto.

---

## Estado

| Etapa / Bloque                                                                                              | Estado                |
| ----------------------------------------------------------------------------------------------------------- | --------------------- |
| **Etapa 0** — Validación técnica (Electron + partition isolation + proxy auth con Oxylabs)                  | ✅                    |
| **Bloque 1.1** — Foundation (fork shell, repo privado)                                                      | ✅                    |
| **Bloque 1.2** — Identity Manager + Lazy Tabs + Sidebar + Custom UA + Free-tier cap                         | ✅                    |
| **Bloque 1.3-MCP** — OZ MCP server (HTTP :9223 + SSE + stdio bridge, 13 tools, hand-rolled)                 | ✅                    |
| **Bloque 1.3.5-CI** — GitHub Actions (lint + check:loc + smoke tests por push)                              | ✅                    |
| **Bloque 1.3.6-DX** — ESLint flat + Prettier + Husky pre-commit + lint-staged                               | ✅                    |
| **Bloque 1.4-WS** — Workspace Manager (multi-window real + drag-drop tabs)                                  | ⏳ ← NEXT             |
| **Bloque 1.5** — ⭐ Account Vault (CORE: auto-fill, anti-logout, Excel I/O)                                 | ⏳                    |
| **Bloque 1.6** — Time Machine + Backup                                                                      | ⏳                    |
| **Bloque 1.7** — Tab Context Menu (16 opciones Ghost parity) + cookies por identity                         | ⏳                    |
| **Bloque 1.8** — Proxy Manager (bulk import, health checks, provider templates)                             | ⏳                    |
| **Bloque 1.9** — FingerprintEngine "Ghost+" (pasa Pixelscan/CreepJS)                                        | ⏳                    |
| **Bloque 1.10** — Settings UI completa + Bookmarks/Downloads/History + Polish + Extensions multi-identity   | ⏳                    |
| **Etapa 2** — UX competitiva + candidatos C-11..C-15 (headless, Ghost importer, demo mode, recipes, health) | ⏳                    |
| **Etapa 3** — Distribución firmada (electron-forge + update-electron-app, REQUIERE notarización)            | ⏳ ($99 Apple Dev)    |
| **Etapa 4** — Backend SaaS: auth + entitlements (Supabase + deep link OAuth `oz://auth/callback`)           | ⏳                    |
| **Etapa 5** — Billing Stripe (`shell.openExternal` para Checkout) + self-service cancel                     | ⏳                    |
| **Etapa 6** — Marketing site + signup                                                                       | ⏳ ($12 dominio)      |
| **Etapa 7** — Cloud Sync E2E (Supabase / Dropbox PKCE / S3 self-hosted, pluggable)                          | ⏳                    |
| **Etapa 8** — Windows + Linux                                                                               | ⏳ ($50-150 cert Win) |
| **Etapa 9** — Antidetect top-tier (fork Chromium, solo si MRR > $5K)                                        | 🔮 futuro             |
| **Etapa 10** — Team & Enterprise (RBAC, SSO)                                                                | 🔮 futuro             |

---

## Quick start

```bash
NODE_ENV= npm install --include=dev
NODE_ENV= npm start                  # dev mode
SHELL_DEBUG=1 NODE_ENV= npm start    # con DevTools abiertos

# OZ Browser con MCP server activo (port 9223, off por default)
OZ_MCP_ENABLED=1 NODE_ENV= npm start

# Build .dmg para distribución (requiere config de Forge)
NODE_ENV= npm run make
```

**Nota:** el shell del usuario exporta `NODE_ENV=production` lo cual bloquea la instalación de devDependencies. Por eso siempre prefijamos `NODE_ENV=` (con espacio) al correr `npm install` o `npm start` durante desarrollo.

## Tooling local

```bash
npm test                  # smoke tests Node-puro (mock Electron)
npm run check:loc         # valida regla 500 LOC (ADR 0005)
npm run check:loc:verbose # muestra top 20 archivos por LOC
npm run lint              # ESLint flat config + Prettier check
npm run lint:fix          # auto-fix lint + format
npm run format            # solo Prettier --write
```

Pre-commit hook (Husky) corre `lint-staged` + `check:loc` automáticamente. Bypass de emergencia: `git commit --no-verify`.

## CI

GitHub Actions corre en cada push y PR a main, en `macos-latest`:

1. ESLint + Prettier check
2. `check:loc` (regla 500 LOC)
3. Smoke tests (28 + 57 = 85 assertions)

Cron nightly 03:00 UTC corre el mismo pipeline para detectar regresiones por dependencias upstream. Ver [`docs/architecture/0013-ci-strategy.md`](docs/architecture/0013-ci-strategy.md).

## OZ MCP server (automation API)

OZ Browser embebe un server MCP (Model Context Protocol) que expone identities/tabs/system como tools — accesible desde Claude Code, Cursor, curl, Python, Node.

```bash
OZ_MCP_ENABLED=1 NODE_ENV= npm start

# En otra terminal:
curl http://localhost:9223/health
curl -X POST http://localhost:9223/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Stream de eventos en vivo (tab-created, identity-changed, etc.)
curl -N http://localhost:9223/mcp/events
```

Setup en Claude Code y guía completa en [`docs/guides/mcp-automation.md`](docs/guides/mcp-automation.md).

## Estructura del código

```
oz-browser/
├─ index.js                  # entry point — instancia Browser
├─ preload.js                # bridge contextBridge → window.oz
├─ forge.config.js           # electron-forge build config
├─ eslint.config.js          # ESLint flat (ADR 0014)
├─ .prettierrc.json
├─ .husky/pre-commit
│
├─ browser/                  # MAIN PROCESS
│  ├─ main.js                ✅ orquestador: app lifecycle, ventanas, MCP server
│  ├─ menu.js                ✅
│  ├─ identity-manager.js    ✅ Identity CRUD + sessions per-identity
│  ├─ identity-handlers.js   ✅ handler map (consumido por IPC y MCP)
│  ├─ tabs.js                ✅ lazy materialization
│  ├─ tab-handlers.js        ✅ handler map (consumido por IPC y MCP)
│  ├─ ipc-handlers.js        ✅ adapter ipcMain → handler maps
│  ├─ mcp-server.js          ✅ JSON-RPC 2.0 + SSE + bearer auth
│  ├─ mcp-tools.js           ✅ catálogo de 13 tools v1
│  ├─ logger.js              ✅ rotación, ~/Library/Logs/OZ Browser/
│  ├─ error-handler.js       ✅ popup con email a Jose
│  ├─ extensions-setup.js    ✅ Chrome Web Store integration
│  ├─ workspace-manager.js   ⏳ Bloque 1.4-WS
│  ├─ account-vault.js       ⏳ Bloque 1.5 ⭐
│  ├─ excel-io.js            ⏳ Bloque 1.5
│  ├─ backup-manager.js      ⏳ Bloque 1.6
│  ├─ tab-context-menu.js    ⏳ Bloque 1.7
│  ├─ proxy-manager.js       ⏳ Bloque 1.8
│  ├─ fingerprint-engine.js  ⏳ Bloque 1.9
│  ├─ extension-manager.js   ⏳ Bloque 1.10
│  ├─ auth-client.js         ⏳ Etapa 4
│  ├─ billing-client.js      ⏳ Etapa 5
│  ├─ sync-client.js         ⏳ Etapa 7
│  ├─ auto-update.js         ⏳ Etapa 3
│  └─ ui/                    # RENDERER (browser chrome cargado como Chrome ext.)
│
├─ tools/
│  └─ mcp-stdio-bridge.js    ✅ stdio↔HTTP bridge para Claude Code/Cursor
│
├─ scripts/
│  ├─ check-loc.js           ✅ validador 500 LOC rule (ADR 0005)
│  └─ safe-test.sh           ✅ wrapper para correr tests con backup de data
│
├─ tests/
│  ├─ identity-manager.smoketest.js  ✅ 28/28
│  └─ mcp-server.smoketest.js         ✅ 57/57 (incluye contract IPC↔MCP)
│
├─ .github/workflows/
│  └─ ci.yml                 ✅ GitHub Actions (lint + check:loc + tests)
│
└─ docs/                     # documentación del proyecto
   ├─ OVERVIEW.md            ← TL;DR
   ├─ PLAN-MAESTRO.md        ← fuente única de verdad
   ├─ DOCUMENTATION-RULES.md ← las 7 reglas de doc
   ├─ DEPENDENCIES.md
   ├─ BENCHMARKS.md          ← mediciones por release
   ├─ architecture/          # ADRs 0001-0014
   ├─ modules/               # un .md por archivo de código
   ├─ features/
   ├─ guides/                # dev-setup, mcp-automation, manual-test
   ├─ processes/             # CHECKLIST-CIERRE-BLOQUE, code-review, commit-style
   └─ history/               # bitácora por bloque cerrado
```

## Decisiones técnicas clave (no re-debatir)

Ver [`docs/architecture/`](docs/architecture/) para los 14 ADRs aceptados. Lo top:

1. **Electron + WebContentsView + `session.fromPartition('persist:identity-X')`** validado en Etapa 0 — cookie isolation real a nivel SQLite + proxy con auth via `app.on('login')`.
2. **Default identity usa `defaultSession`** ([ADR 0003](docs/architecture/0003-default-identity-uses-defaultsession.md)) para que Chrome Web Store extensions funcionen.
3. **Tabs lazy** ([ADR 0002](docs/architecture/0002-lazy-tabs.md)) — WebContentsView solo en primer click. 100+ tabs viables.
4. **HTTPS proxies preferidos sobre SOCKS5** ([ADR 0004](docs/architecture/0004-https-over-socks5.md)) — `app.on('login')` es más estable.
5. **MCP server hand-rolled** ([ADR 0012](docs/architecture/0012-oz-mcp-server.md)) — JSON-RPC 2.0 + SSE, cero deps nuevas.
6. **Vault: scrypt + AES-256-GCM** ([ADR 0008](docs/architecture/0008-account-vault-encryption.md)) — `@napi-rs/keyring` + `exceljs` + `otplib` (audit de deps confirmó alternativas a keytar/xlsx/speakeasy).
7. **Antidetect "Ghost+"** vía preload script con seed coherente per-identity. NO fork de Chromium en v1.
8. **CI obligatorio** ([ADR 0013](docs/architecture/0013-ci-strategy.md)) en GitHub Actions, macOS-latest.
9. **Lint flat config + pre-commit** ([ADR 0014](docs/architecture/0014-lint-precommit.md)).
10. **Pricing:** Free 3 ID → Basic ~$12-15/mo → Pro ~$29-35/mo → Team ~$15/seat. La mitad que Ghost.

## Diferenciadores reales vs Ghost (moat)

Ver [`docs/PLAN-MAESTRO.md` § 4](docs/PLAN-MAESTRO.md). Top 10:

1. **Account Vault + auto-fill + Excel I/O + anti-logout** — Ghost no tiene
2. Pasar Pixelscan/CreepJS por default (Ghost falla → Trustpilot 2.9)
3. Sync E2E en la nube (Ghost solo escribe a folder Dropbox)
4. Multi-window workspaces de verdad
5. Self-service cancel real (Ghost cobra después de "deactivate")
6. Per-identity timezone/locale/geo automático del proxy
7. Templates de proveedores de proxies (Bright Data, Oxylabs, Smartproxy, IPRoyal)
8. Health-check + auto-disable de proxies muertos
9. **MCP automation API** para Claude/Cursor/Puppeteer
10. Multi-extension SIN whitelist hardcodeada

## Logs y errores

- Log file: `~/Library/Logs/OZ Browser/oz-browser.log` (rotación a 10 MB, mantiene 3 archivos viejos)
- Crashes en main, renderer y child processes capturados → popup con 4 botones: **Email Jose**, **Copy details**, **Open log file**, **Dismiss**
- Email a Jose pre-rellena con stack trace + system info para reportar errores

## Licencia

UNLICENSED — código privado, no redistribuir. Hereda partes con licencia MIT de [`electron-browser-shell`](https://github.com/samuelmaddock/electron-browser-shell).
