# Módulo `paths`

**Path:** `browser/paths.js`
**Líneas:** 33
**Bloque:** 1.2 ✅

## Qué hace

Centraliza paths del runtime + un helper. Pequeño porque el resto de módulos es chico.

## Exports

| Símbolo | Tipo | Descripción |
|---|---|---|
| `PROJECT_ROOT` | string | Path al proyecto (calculado relativo a `__dirname` que en runtime es `.webpack/main`). |
| `PATHS.WEBUI` | string | Path al folder de la WebUI extension. |
| `PATHS.PRELOAD` | string | Path al preload bundleado. |
| `PATHS.LOCAL_EXTENSIONS` | string | Path al folder de extensions locales (puede no existir). |
| `getParentWindowOfTab(tab)` | function | Resuelve BrowserWindow desde un webContents arbitrario. |

## Gotchas

- `__dirname` en runtime con electron-forge webpack es `.webpack/main/`, NO `browser/`. PROJECT_ROOT sube 2 niveles para llegar a la raíz del proyecto.
- En production (app.isPackaged), WEBUI vive en `process.resourcesPath/ui` (extraResource del forge.config.js).

## Referencias

- Usado por: `main.js`, `extensions-setup.js`.
