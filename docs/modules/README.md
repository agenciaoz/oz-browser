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
| `tabs.js`                  | 344  | [tabs.md](tabs.md)                             |
| `logger.js`                | 111  | [logger.md](logger.md)                         |
| `error-handler.js`         | 141  | [error-handler.md](error-handler.md)           |
| `menu.js`                  | 51   | [menu.md](menu.md)                             |

✨ = creado en Bloque 1.3-MCP.

## Renderer / WebUI (browser/ui/)

| Módulo                     | LOC  | Doc                                                  |
| -------------------------- | ---- | ---------------------------------------------------- |
| `webui.html`               | ~402 | (markup, sin .md hermano dedicado)                   |
| `webui.js`                 | 27   | [ui-webui.md](ui-webui.md)                           |
| `oz-utils.js`              | 41   | [ui-oz-utils.md](ui-oz-utils.md)                     |
| `tabstrip.js`              | 165  | [ui-tabstrip.md](ui-tabstrip.md)                     |
| `sidebar.js`               | 352  | [ui-sidebar.md](ui-sidebar.md)                       |
| `identity-editor.js`       | 183  | [ui-identity-editor.md](ui-identity-editor.md)       |
| `workspace-switcher.js` 🆕 | ~290 | [ui-workspace-switcher.md](ui-workspace-switcher.md) |

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

## Pendientes (placeholders, se llenan al implementarse)

### Bloque 1.3.5-CI (próximo)

- `.github/workflows/ci.yml`

### Bloque 1.3.6-DX

- `.eslintrc.json`, `.prettierrc`, `.husky/pre-commit`

### Bloques siguientes

- ~~`workspace-manager.js` (Bloque 1.4-WS)~~ ✅ creado en 1.4a
- `account-vault.js` ⭐ (Bloque 1.5)
- `excel-io.js` (Bloque 1.5)
- `site-templates.js` (Bloque 1.5)
- `backup-manager.js` (Bloque 1.6)
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
