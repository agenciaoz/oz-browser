# OZ Browser — Overview (TL;DR)

> Para leer en 2 minutos. Para detalle completo: [`PLAN-MAESTRO.md`](PLAN-MAESTRO.md).

---

## Qué es

Navegador Chromium-based para **manejar 50+ cuentas de redes sociales al mismo tiempo** con vault de credenciales, anti-logout, Excel import/export, snapshots Time Machine y admin dashboard para oficina. Vendido como SaaS más barato que Ghost Browser ($46-59/mo) — target **$12-35/mo**.

**Plataforma primaria:** MacBook Apple Silicon (M1/M2/M3/M4). Universal binary también x86_64.

---

## Las 5 cosas que tienes que recordar

1. **Cliente Electron** corriendo nativo en arm64. Repo: https://github.com/agenciaoz/oz-browser (privado).
2. **Account Vault** es el corazón — credenciales encriptadas + auto-fill + anti-logout + Excel I/O.
3. **Lazy tabs** — 100 tabs en M1 Air 8 GB sin pesar. Materialize on click.
4. **Time Machine** — snapshot diario automático, rollback a cualquier versión.
5. **Office Edition** — Dropbox como sync backend gratis, admin dashboard mide bandwidth/tiempo/accounts por empleado.

## Pilares arquitectónicos (no negociables)

1. **Modularidad** — ningún archivo > 500 LOC ([ADR 0005](architecture/0005-modular-500-loc-rule.md))
2. **Documentación es código** — todo se documenta ([DOC-RULES](DOCUMENTATION-RULES.md))
3. **Logging exhaustivo** — cada componente loggea ([ADR 0009](architecture/0009-logging-everything.md))
4. **Apple Silicon target** — M1 Air 8 GB primer ciudadano ([ADR 0006](architecture/0006-apple-silicon-target.md))
5. **Lazy tabs**, **Default = defaultSession**, **HTTPS proxies**, **Sync pluggable**, **Vault crypto** — más ADRs en [`architecture/`](architecture/README.md).

---

## Hardware target y benchmarks

| Mac (RAM) | Lazy | Materialized | Memoria total |
|---|---|---|---|
| **MacBook Air M1 8 GB** ← target oficina | 100 | 10 | < 4 GB |
| MacBook Pro M1/M2 16 GB | 200 | 30 | < 8 GB |
| MacBook Pro M2/M3 32 GB+ | 500 | 100 | < 16 GB |

**SLOs:** cold start < 2s, switch tab < 50ms, materialize lazy < 800ms.

**Cómo lo logramos en M1 Air 8 GB:**
- Lazy tabs (1 KB cada uno hasta click)
- Tab discarding (materialized idle > 30 min → vuelve a lazy)
- Memory pressure handler (>80% RAM → auto-discard)
- Performance modes Light/Balanced/Power auto-detect según RAM
- Universal binary arm64 nativo (sin Rosetta)
- Metal GPU + VideoToolbox HW video decode
- Cache caps por partition (50 MB)

---

## Estado del proyecto (2026-05-09)

```
✅ Etapa 0 — Validación técnica (Electron + partition + proxy auth)
✅ Bloque 1.1 — Foundation (fork shell, repo, tabs+omnibox)
🚧 Bloque 1.2 — Identity Manager + Lazy + Sidebar + Logger + Top tabstrip ~70%

⏳ Bloque 1.3 — Workspace Manager
⏳ Bloque 1.4 — Proxy Manager
⏳ Bloque 1.5 — ⭐ Account Vault (CORE) — auto-fill, Excel I/O, anti-logout
⏳ Bloque 1.6 — Time Machine + Backup
⏳ Bloque 1.7 — Tab context menu
⏳ Bloque 1.8 — FingerprintEngine "Ghost+" (pasa Pixelscan/CreepJS)
⏳ Bloque 1.9 — Settings UI + Bookmarks/Downloads/History
⏳ Bloque 1.10 — Polish + Extensions multi-identity + M-series perf

⏳ Etapa 2  — UX competitiva
⏳ Etapa 3  — Distribución firmada + auto-update ($99 Apple Dev)
⏳ Etapa 4  — Backend SaaS auth + entitlements (Supabase)
⏳ Etapa 5  — Stripe billing + self-service cancel
⏳ Etapa 6  — Marketing site
⏳ Etapa 7  — Cloud Sync E2E (Supabase) — para SaaS público
⏳ Etapa 7-OFFICE — Dropbox como sync backend para tu oficina
⏳ Etapa 7.5 — Admin Dashboard
⏳ Etapa 8  — Windows + Linux
🔮 Etapa 9  — Antidetect top-tier (fork Chromium) — solo si MRR > $5K
🔮 Etapa 10 — Team Enterprise (RBAC, SSO)
```

---

## Tu moat real vs Ghost (16 cosas Ghost no tiene o hace mal)

1. ⭐ **Account Vault + auto-fill + Excel I/O + anti-logout**
2. **Pasar Pixelscan/CreepJS** por default (Ghost falla)
3. **Sync E2E** real en cloud (Ghost solo a folder Dropbox)
4. **Multi-window workspaces** de verdad (Ghost obliga profiles separados)
5. **Self-service cancel** (Ghost cobra después de "deactivate" → Trustpilot 2.9)
6. **Per-identity timezone/locale/geo** automático del proxy
7. **Templates de proxy providers** (Oxylabs/Bright Data/Smartproxy/IPRoyal)
8. **Health-check + auto-disable** de proxies muertos
9. **CDP automation API** para Puppeteer/Playwright
10. **Multi-extension SIN whitelist** (Ghost solo permite ~7 específicas)
11. **Bandwidth meter** por proxy/identity
12. **Modo Ephemeral Session** (abre desde Excel, cierra, Mac queda limpia)
13. **Cap de 25 identities REMOVIDO** (palette algorítmica + virtual scroll)
14. **Time Machine** (snapshot diario + rollback)
15. **Workflow colaborativo Excel** (export → corregir → OVERWRITE)
16. **Office Edition con admin dashboard** (Ghost no tiene team management)

---

## Arquitectura modular

```
oz-browser/
├─ browser/                   MAIN PROCESS
│  ├─ main.js                 orquestador
│  ├─ identity-manager.js  ✅ identities + sessions
│  ├─ workspace-manager.js    workspaces CRUD + freeze
│  ├─ proxy-manager.js        pool + bulk + health
│  ├─ account-vault.js  ⭐    credenciales + auto-fill + anti-logout
│  ├─ excel-io.js             SheetJS import/export 4 modes
│  ├─ site-templates.js       selectores X/IG/FB/TikTok/etc.
│  ├─ fingerprint-engine.js   per-identity coherent
│  ├─ tabs.js              ✅ lazy materialization
│  ├─ tab-context-menu.js     16 opciones Ghost parity
│  ├─ activity-tracker.js     bandwidth/tiempo/cuentas
│  ├─ backup-manager.js       .ozbackup + Time Machine
│  ├─ logger.js            ✅ rotación
│  ├─ error-handler.js     ✅ popup mailto:Jose
│  ├─ auth-client.js          Supabase auth
│  ├─ billing-client.js       Stripe
│  ├─ sync-client.js          backend pluggable: Cloud/Dropbox/S3
│  ├─ auto-update.js          electron-updater
│  └─ ui/                     RENDERER (browser chrome)
│     ├─ webui.html        ✅ sidebar 220px + topbar
│     └─ webui.js          ✅ TabStrip + IdentitySidebar
│
└─ docs/                      docs versionadas con código
```

---

## Próximo paso concreto

**Cerrar Bloque 1.2** (~1-2 sesiones):
- Default Identity como row siempre visible en sidebar
- Per-identity custom UA en modal
- Fix bug tab duplicada al arranque
- Drag-drop reorder

**Después arrancar Bloque 1.5 (CORE — Account Vault).**

---

## Costos hasta producto vendible (Etapas 0-6)

- ~135 horas mías de trabajo
- ~$110 en costos directos ($99 Apple Dev + $12 dominio)
- ~3 meses calendario a 1-2 sesiones por día
