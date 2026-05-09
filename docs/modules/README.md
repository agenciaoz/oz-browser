# Módulos de OZ Browser

Un `.md` por archivo de código. Cada doc tiene: qué hace, exports, IPC channels, dependencias, gotchas.

## Backend (browser/)

| Módulo | LOC | Doc |
|---|---|---|
| `main.js` | 155 | [main.md](main.md) |
| `paths.js` | 33 | [paths.md](paths.md) |
| `window-manager.js` | 105 | [window-manager.md](window-manager.md) |
| `ipc-handlers.js` | 190 | [ipc-handlers.md](ipc-handlers.md) |
| `extensions-setup.js` | 210 | [extensions-setup.md](extensions-setup.md) |
| `identity-manager.js` | 177 | [identity-manager.md](identity-manager.md) |
| `tabs.js` | 334 | [tabs.md](tabs.md) |
| `logger.js` | 111 | [logger.md](logger.md) |
| `error-handler.js` | 141 | [error-handler.md](error-handler.md) |
| `menu.js` | 51 | [menu.md](menu.md) |

## Renderer / WebUI (browser/ui/)

| Módulo | LOC | Doc |
|---|---|---|
| `webui.html` | 402 | [ui-webui-html.md](ui-webui-html.md) |
| `webui.js` | 22 | [ui-webui.md](ui-webui.md) |
| `oz-utils.js` | 32 | [ui-oz-utils.md](ui-oz-utils.md) |
| `tabstrip.js` | 158 | [ui-tabstrip.md](ui-tabstrip.md) |
| `sidebar.js` | 304 | [ui-sidebar.md](ui-sidebar.md) |

## Preload (preload.js — root)

| Módulo | LOC | Doc |
|---|---|---|
| `preload.js` | 93 | [preload.md](preload.md) |

## Pendientes (placeholders, se llenan al implementarse)

- `workspace-manager.js` (Bloque 1.3)
- `proxy-manager.js` (Bloque 1.4)
- `account-vault.js` ⭐ (Bloque 1.5)
- `excel-io.js` (Bloque 1.5)
- `site-templates.js` (Bloque 1.5)
- `backup-manager.js` (Bloque 1.6)
- `tab-context-menu.js` (Bloque 1.7)
- `fingerprint-engine.js` (Bloque 1.8)
- `extension-manager.js` (Bloque 1.10)
- `activity-tracker.js` (Etapa 7.5)
- `sync-client.js` (Etapa 7)
- `auth-client.js` (Etapa 4)
- `billing-client.js` (Etapa 5)
- `auto-update.js` (Etapa 3)

## Cómo agregar un módulo nuevo

Ver [`../guides/adding-a-feature.md`](../guides/adding-a-feature.md) y la regla 7 de [`../DOCUMENTATION-RULES.md`](../DOCUMENTATION-RULES.md): el `.md` se crea ANTES del código.
