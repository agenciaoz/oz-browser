# Bloque E2-C-7 — Extensions per-identity sharing (resultado)

**Status:** ✅ Cerrado 2026-05-10 noche bis (cierre del E2-C completo)
**Commit:** TBD (main directo)
**Tiempo:** ~2h efectivas vs ~3h estimadas (-33%)
**Deps nuevas:** 0 — `electron-chrome-extensions` ya pre-instalada (4.9.0) soporta multi-session via `fromSession` / `setSessionPartitionResolver`
**Tests:** 1745 → 1776 (+31)

## Origen

Único sub-bloque pendiente del E2-C. Las extensions de Chrome (uBlock Origin, 1Password, etc.) hoy se cargan via `electron-chrome-extensions` + `electron-chrome-web-store` en `defaultSession`. Las identities custom usan particiones aisladas (`session.fromPartition('persist:identity-X')`) que no tenían extension API registrada — al abrir Chrome Web Store en una tab de identity custom, "Add to Chrome" no funcionaba.

## Decisiones de scope (vía AskUserQuestion al inicio)

1. **Isolation level**: install-en-Default + share-to-identity (sobre multi-instance Web Store full o documentar limitación). Razón: una sola fuente de install (Web Store en Default), share simple a N identities reusando los archivos en disco. Cubre 95% del use case real (instalar uBlock una vez, activar en N cuentas con misma blocklist).
2. **Smoke test primero**: confirmar diagnóstico estático antes de codear. Resultado: `extensions-setup.js` instancia UN solo `ElectronChromeExtensions` bound a `defaultSession`, las identities custom no tenían extension API. Diagnóstico confirmado, share approach viable.

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│ browser/extensions-share.js  (~265 LOC)                          │
│   class ExtensionShareManager                                    │
│     - listInstalledInDefault() → from defaultSession.extensions  │
│     - reportForIdentity(id) → matriz default × enabled-for-id    │
│     - enableForIdentity(id, extId)  → loadExtension + persist    │
│     - disableForIdentity(id, extId) → removeExtension + persist  │
│     - hookSessionInit(id, ses)      → re-load enabled at boot    │
│   _ensureChromeExtensionsForSession(id, ses):                    │
│     lazy-creates 1 ElectronChromeExtensions per partition con    │
│     stub createTab/selectTab/createWindow handlers (extensions   │
│     usan storage/runtime/declarativeNetRequest mostly).          │
│   Storage: userData/extension-sharing.json                        │
└─────────────────────────────────────────────────────────────────┘
                       ▲
   ┌───────────────────┼───────────────────┐
   │                                       │
┌──────────────────────┐         ┌─────────────────────────┐
│ extensions-share-    │         │ mcp-tools-extensions.js │
│ handlers.js          │         │  oz.extensions.         │
│  IPC+MCP shared map  │         │   listInstalled         │
│                      │         │   listEnabled           │
│                      │         │   report                │
│                      │         │   enable                │
│                      │         │   disable               │
└──────────────────────┘         └─────────────────────────┘
   │                                       │
   ▼                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ ipc-handlers-extra.js                                            │
│  oz:extensions:listInstalled / listEnabled / report /            │
│  enable / disable                                                │
└─────────────────────────────────────────────────────────────────┘
                       ▲
                       │
┌─────────────────────────────────────────────────────────────────┐
│ UI (browser/ui)                                                  │
│   extensions-modal.js  singleton window.OZ.ExtensionsManager     │
│                        Identity dropdown + table of Default-     │
│                        installed extensions con checkbox per row │
│                        Default identity → "Always enabled" tag   │
│ Triggers: right-click identity → "Manage extensions…" / Cmd+K   │
│   palette → "Manage Extensions for Identity…" 🧩                │
└─────────────────────────────────────────────────────────────────┘

main.js: setupExtensionShare(this) (delegado a extensions-share-setup.js
per ADR 0005 — main.js de 511→496 post-extract)
```

## Comportamiento

- **Install flow**: usuario abre Chrome Web Store desde Default identity (UNICA forma de instalar — install flow nativo de Chrome). El extension folder queda en `userData/Extensions/<id>/<version>/`.
- **Share flow**: right-click identity custom → "Manage extensions…" → modal con tabla de extensions de Default + checkbox per row. Tick → `enableForIdentity(id, extId)` → load extension en `session.fromPartition('persist:identity-X')` + persiste en `extension-sharing.json`.
- **Boot flow**: cada vez que la session de una identity custom se resuelve (`identityManager.getSession(id)`), el `addSessionInitHook` registrado por `setupExtensionShare` invoca `hookSessionInit(id, ses)` que carga las extensions en `bindings.byIdentity[id]`.
- **Default identity**: en el modal se muestra como "Always enabled" — no se puede desactivar individualmente desde acá (Chrome native uninstall = `chrome://extensions` flow).

## Files añadidos / modificados

### Nuevos

- `browser/extensions-share.js` (manager + lifecycle, 265 LOC)
- `browser/extensions-share-handlers.js` (handler map, 45 LOC)
- `browser/extensions-share-setup.js` (setup glue extracted from main.js, 45 LOC)
- `browser/mcp-tools-extensions.js` (5 MCP tools, 75 LOC)
- `browser/ui/extensions-modal.js` (UI modal singleton, 210 LOC)
- `tests/extensions-share.smoketest.js` (31 tests con fakes Module intercept, 245 LOC)
- `docs/history/26-bloque-c7-resultado.md` (este archivo)

### Modificados

- `browser/main.js` — wire setupExtensionShare (ahora 496 LOC, post-extract de la inline implementation)
- `browser/ipc-handlers.js` — handlers map + import
- `browser/ipc-handlers-extra.js` — registerExtensionShareHandlersIPC
- `browser/mcp-tools.js` — buildExtensionTools spread
- `browser/identity-context-menu.js` — "Manage extensions…" entry
- `browser/command-palette.js` — entry "Manage Extensions for Identity…" 🧩
- `browser/ui/command-palette.js` — modalMap.extensionsManager
- `browser/ui/webui.html` — modal markup + ~95 LOC CSS + script tag
- `preload.js` — `window.oz.extensions.*` + `oz.sidebar.onRequestManageExt`
- `CHANGELOG.md` — entry del bloque

## Tests

31 tests en `tests/extensions-share.smoketest.js`:

- listInstalledInDefault: excluye WebUI, returns 2, carries path/version/manifestVersion
- listEnabledForIdentity: Default = all installed, custom = []
- reportForIdentity: Default rows enabledForIdentity=true + isDefault=true; custom = false/false
- enableForIdentity: ok + extension info, idempotent, Default reject (always-enabled), unknown ext reject, missing args reject
- persistence: cross-instance reload preserva bindings, JSON file existence
- disableForIdentity: ok, idempotent, Default reject (chrome-uninstall)
- hookSessionInit: loads both extensions en partition, no-op para Default

Total proyecto: 1745 → 1776 (+31). check:loc max 496 (post-extract main.js).

## Pendiente

**Validación visual end-to-end** (`npm start`):

1. Boot OZ con Default identity activa.
2. Abrir Chrome Web Store en una tab → install uBlock Origin → confirmar dialog "Add Extension" → confirmar instalación visible en chrome://extensions.
3. Right-click una identity custom → "Manage extensions…" → modal abre con uBlock listado + checkbox unchecked.
4. Click checkbox → label cambia a "Enabled" → log `extension enabled for identity {identityId,extensionId,name:uBlock Origin}`.
5. Abrir nueva tab en esa identity custom → navegar a un sitio con ads → verificar uBlock activo.
6. Re-abrir el modal en otra identity → checkbox unchecked (binding aislado).
7. Restart OZ → verificar que el binding persiste (la identity sigue teniendo uBlock activo).

## Cierre del E2-C

Con C-7 ✅ el bloque E2-C entero queda cerrado:

| Sub-bloque                                           | Estado                    |
| ---------------------------------------------------- | ------------------------- |
| C-1 Cmd+K palette                                    | ✅ + visualmente validado |
| C-2 Crash recovery                                   | ✅ + visualmente validado |
| C-3 Identity clone                                   | ✅ + visualmente validado |
| C-4 Bulk multi-account opener                        | ✅                        |
| C-5 Notification panel                               | ✅ + visualmente validado |
| C-6 Anti-detect health dashboard                     | ✅ (MCP validado)         |
| **C-7 Extensions per-identity**                      | **✅ (CERRADO HOY)**      |
| C-8 Sidebar redesign + tooltips + bidirectional sync | ✅                        |

**Próximo chunk**: Bloque E2-D Backup + Sync Dropbox (~13-15h):

- D-1 Time Machine backup remoto (~2-3h)
- D-2 ADR sync engine
- D-3 sync engine core
- D-4 polish edge cases multi-device
