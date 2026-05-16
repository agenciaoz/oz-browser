# Módulos de OZ Browser

Un `.md` por archivo de código. Cada doc tiene: qué hace, exports, IPC channels, dependencias, gotchas.

> LOC mostrado es el conteo bruto. Para el conteo "meaningful" (excluye blanks/comments) que valida ADR 0005, correr `npm run check:loc:verbose`.

## Backend (browser/)

| Módulo                     | LOC  | Doc                                            |
| -------------------------- | ---- | ---------------------------------------------- |
| `main.js`                  | ~175 | [main.md](main.md)                             |
| `paths.js`                 | 33   | [paths.md](paths.md)                           |
| `window-manager.js`        | ~165 | [window-manager.md](window-manager.md)         |
| `window-workspace.js` 🆕   | ~210 | [window-workspace.md](window-workspace.md)     |
| `ipc-handlers.js`          | ~250 | [ipc-handlers.md](ipc-handlers.md)             |
| `identity-handlers.js` ✨  | ~95  | [identity-handlers.md](identity-handlers.md)   |
| `tab-handlers.js` ✨       | ~85  | [tab-handlers.md](tab-handlers.md)             |
| `workspace-handlers.js` 🆕 | ~165 | [workspace-handlers.md](workspace-handlers.md) |
| `mcp-server.js` ✨         | ~250 | [mcp-server.md](mcp-server.md)                 |
| `mcp-tools.js` ✨          | ~184 | [mcp-tools.md](mcp-tools.md)                   |
| `extensions-setup.js`      | 226  | [extensions-setup.md](extensions-setup.md)     |
| `identity-manager.js`      | 270  | [identity-manager.md](identity-manager.md)     |
| `workspace-manager.js` 🆕  | ~340 | [workspace-manager.md](workspace-manager.md)   |
| `account-vault.js` 🆕      | ~290 | [account-vault.md](account-vault.md)           |
| `account-handlers.js` 🆕   | ~310 | [account-handlers.md](account-handlers.md)     |
| `mcp-tools-vault.js` 🆕    | ~180 | (split de mcp-tools.js, mismo doc)             |
| `site-templates.js` 🆕     | ~220 | [site-templates.md](site-templates.md)         |
| `preload-content.js` 🆕    | ~190 | [preload-content.md](preload-content.md)       |
| `anti-logout.js` 🆕        | ~230 | [anti-logout.md](anti-logout.md)               |
| `excel-io.js` 🆕           | ~200 | [excel-io.md](excel-io.md)                     |
| `excel-handlers.js` 🆕     | ~258 | [excel-handlers.md](excel-handlers.md)         |
| `backup-manager.js` 🆕     | ~452 | [backup-manager.md](backup-manager.md)         |
| `backup-handlers.js` 🆕    | ~165 | [backup-handlers.md](backup-handlers.md)       |
| `tabs.js`                  | 344  | [tabs.md](tabs.md)                             |
| `logger.js`                | 111  | [logger.md](logger.md)                         |
| `error-handler.js`         | 141  | [error-handler.md](error-handler.md)           |
| `menu.js`                  | 51   | [menu.md](menu.md)                             |

✨ = creado en Bloque 1.3-MCP.

## Renderer / WebUI (browser/ui/)

| Módulo                         | LOC  | Doc                                                  |
| ------------------------------ | ---- | ---------------------------------------------------- |
| `webui.html`                   | ~402 | (markup, sin .md hermano dedicado)                   |
| `webui.js`                     | 27   | [ui-webui.md](ui-webui.md)                           |
| `oz-utils.js`                  | 41   | [ui-oz-utils.md](ui-oz-utils.md)                     |
| `tabstrip.js`                  | 165  | [ui-tabstrip.md](ui-tabstrip.md)                     |
| `sidebar.js`                   | 352  | [ui-sidebar.md](ui-sidebar.md)                       |
| `identity-editor.js`           | 183  | [ui-identity-editor.md](ui-identity-editor.md)       |
| `workspace-switcher.js` 🆕     | ~290 | [ui-workspace-switcher.md](ui-workspace-switcher.md) |
| `account-manager.js` 🆕        | ~440 | [ui-account-manager.md](ui-account-manager.md)       |
| `account-manager-render.js` 🆕 | ~125 | (split helper, mismo doc)                            |
| `time-machine.js` 🆕           | ~310 | [ui-time-machine.md](ui-time-machine.md)             |

## Preload (preload.js — root)

| Módulo       | LOC | Doc                      |
| ------------ | --- | ------------------------ |
| `preload.js` | 102 | [preload.md](preload.md) |

## Tooling (scripts/, tests/, tools/)

| Archivo                                   | LOC  | Doc                                                          |
| ----------------------------------------- | ---- | ------------------------------------------------------------ |
| `scripts/check-loc.js`                    | ~115 | header inline (script standalone)                            |
| `scripts/safe-test.sh`                    | ~46  | header inline                                                |
| `tools/mcp-stdio-bridge.js` ✨            | ~85  | [`../guides/mcp-automation.md`](../guides/mcp-automation.md) |
| `tests/identity-manager.smoketest.js`     | 331  | header inline                                                |
| `tests/mcp-server.smoketest.js` ✨        | ~330 | header inline                                                |
| `tests/workspace-manager.smoketest.js` 🆕 | ~270 | header inline                                                |
| `tests/window-workspace.smoketest.js` 🆕  | ~330 | header inline                                                |
| `tests/move-to-workspace.smoketest.js` 🆕 | ~250 | header inline                                                |
| `tests/account-vault.smoketest.js` 🆕     | ~350 | header inline                                                |
| `tests/account-handlers.smoketest.js` 🆕  | ~430 | header inline                                                |
| `tests/site-templates.smoketest.js` 🆕    | ~210 | header inline                                                |
| `tests/anti-logout.smoketest.js` 🆕       | ~430 | header inline                                                |
| `tests/excel-io.smoketest.js` 🆕          | ~290 | header inline                                                |
| `tests/backup-manager.smoketest.js` 🆕    | ~280 | header inline                                                |

## H-2 + J + K1 (v1.1.4 → v1.4.2, 2026-05-15)

| Módulo                                    | LOC  | Doc                                                      |
| ----------------------------------------- | ---- | -------------------------------------------------------- |
| `browser/leak-tests.js` 🆕                | ~310 | [leak-tests.md](leak-tests.md)                           |
| `browser/leak-tests-handlers.js` 🆕       | ~290 | [leak-tests-handlers.md](leak-tests-handlers.md)         |
| `browser/proxy-bulk-backup.js` 🆕         | ~135 | [proxy-bulk-backup.md](proxy-bulk-backup.md)             |
| `browser/proxy-diagnostic-export.js` 🆕   | ~140 | [proxy-diagnostic-export.md](proxy-diagnostic-export.md) |
| `browser/totp.js` 🆕                      | ~120 | [totp.md](totp.md) — RFC 6238 from scratch, see ADR 0028 |
| `browser/power-monitor-setup.js` 🆕       | ~150 | [power-monitor-setup.md](power-monitor-setup.md)         |
| `browser/ui/oxylabs-builder.js` 🆕        | ~310 | [oxylabs-builder.md](oxylabs-builder.md)                 |
| `browser/ui/proxy-dashboard-health.js` 🆕 | ~135 | [proxy-dashboard-health.md](proxy-dashboard-health.md)   |
| `browser/ui/proxy-dashboard-leaks.js` 🆕  | ~135 | [proxy-dashboard-leaks.md](proxy-dashboard-leaks.md)     |
| `browser/ui/proxy-dashboard-export.js` 🆕 | ~45  | [proxy-dashboard-export.md](proxy-dashboard-export.md)   |
| `browser/ui/proxy-dashboard-utils.js` 🆕  | ~50  | [proxy-dashboard-utils.md](proxy-dashboard-utils.md)     |

## K1-extras cierre (v1.4.3 → v1.4.7, 2026-05-15/16)

| Módulo                                    | LOC  | Doc                                                          |
| ----------------------------------------- | ---- | ------------------------------------------------------------ |
| `browser/hud-handlers.js` 🆕              | ~200 | [hud-widget.md](hud-widget.md) — Identity HUD (v1.4.3)       |
| `browser/hud-setup.js` 🆕                 | ~245 | [hud-widget.md](hud-widget.md) — wire-up + injection         |
| `browser/preload-hud-script.js` 🆕        | ~180 | [hud-widget.md](hud-widget.md) — pure builders               |
| `browser/preload-hud.js` 🆕               | ~20  | [hud-widget.md](hud-widget.md) — DEPRECATED placeholder      |
| `browser/fingerprint-preload-setup.js` 🆕 | ~60  | [fingerprint-preload-setup.md](fingerprint-preload-setup.md) |
| `scripts/bundle-preloads.js` 🆕           | ~115 | [bundle-preloads.md](bundle-preloads.md) — v1.4.4 fix        |
| `browser/ui/onboarding-wizard.js` 🆕      | ~330 | [onboarding-wizard.md](onboarding-wizard.md) — v1.4.6        |

## Pendientes (placeholders, se llenan al implementarse)

### Bloque 1.3.5-CI (próximo)

- `.github/workflows/ci.yml`

### Bloque 1.3.6-DX

- `.eslintrc.json`, `.prettierrc`, `.husky/pre-commit`

### Bloques siguientes

- ~~`workspace-manager.js` (Bloque 1.4-WS)~~ ✅ creado en 1.4a
- ~~`account-vault.js` ⭐ (Bloque 1.5)~~ ✅ creado en 1.5a
- `excel-io.js` (Bloque 1.5)
- `site-templates.js` (Bloque 1.5)
- ~~`backup-manager.js` (Bloque 1.6)~~ ✅ creado en 1.6a
- `tab-context-menu.js` (Bloque 1.7)
- `proxy-manager.js` (Bloque 1.8)
- `fingerprint-engine.js` (Bloque 1.9)
- `extension-manager.js` (Bloque 1.10)
- `activity-tracker.js` (Etapa 7.5)
- `sync-client.js` (Etapa 7)
- `auth-client.js` (Etapa 4)
- `billing-client.js` (Etapa 5)
- `auto-update.js` (Etapa 3)

## Cómo agregar un módulo nuevo

Ver [`../guides/adding-a-feature.md`](../guides/adding-a-feature.md) y la regla 7 de [`../DOCUMENTATION-RULES.md`](../DOCUMENTATION-RULES.md): el `.md` se crea ANTES del código.

Antes del cierre del bloque que lo introduce, el módulo debe pasar la [`CHECKLIST-CIERRE-BLOQUE`](../processes/CHECKLIST-CIERRE-BLOQUE.md).
