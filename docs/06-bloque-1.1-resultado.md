# Bloque 1.1 — Resultado: ✅ Foundation lista

**Fecha:** 2026-05-09
**Repo:** https://github.com/agenciaoz/oz-browser (privado)
**Stack:** Electron 37.x + electron-forge + webpack + electron-chrome-extensions

---

## Lo que quedó funcionando

- ✅ **OZ Browser arranca con `npm start`** y abre una ventana con tabs, omnibox, back/forward/reload, content area.
- ✅ **Forkeado limpio de `samuelmaddock/electron-browser-shell` (MIT)** — heredamos años de bugfixes en gestión de tabs y soporte de extensiones de Chrome.
- ✅ **Renombrado y customizado**: `package.json` (oz-browser, OZ Browser), `forge.config.js` (productName), README con roadmap.
- ✅ **Paths arreglados** para proyecto standalone (ya no monorepo): `PROJECT_ROOT = path.join(__dirname, '../../')` desde `.webpack/main`.
- ✅ **Repo GitHub privado** creado bajo cuenta `agenciaoz`, primer commit pusheado.
- ✅ **`.gitignore` robusto** que excluye `node_modules`, `.webpack`, `data/`, `proxies.json`, `.env`, certificados, etc.

## Issues encontrados y resueltos

1. **`NODE_ENV=production`** seteado en el shell de Jose impedía instalar devDependencies. Solución: `NODE_ENV= npm install --include=dev`. Documentar para Etapa 3 (CI).
2. **Path resolution rota** al sacar el shell del monorepo. `__dirname` en runtime apunta a `.webpack/main/`, no a `browser/`. Ajustado.
3. **`packagerConfig.name`** seguía como "Shell" — actualizado a "OZ Browser".

## UI heredada (lo que ya tienes sin escribir nada)

- Tab bar con botón "+" para nueva tab
- Botones back/forward/reload
- Address bar (omnibox) editable
- Tab close button
- Frame-less window con titlebar overlay style
- New tab page con links de prueba
- Soporte de extensiones Chrome Web Store
- Context menu (right-click) con buildChromeContextMenu

## Lo que NO está todavía (siguientes bloques)

- Modelo de Identity (Bloque 1.2)
- Pool de proxies + import CSV (Bloque 1.3)
- Workspaces (Bloque 1.4)
- Antidetect Ghost+ (Bloque 1.5)
- Settings UI (Bloque 1.6)

## Comandos para retomar

```bash
cd "/Users/joserodrigocoronel/Documents/Claude/Projects/Ghost Browser Clone/oz-browser"
NODE_ENV= npm start              # arrancar en dev mode
SHELL_DEBUG=1 NODE_ENV= npm start # con DevTools abierto
git push                          # subir cambios
gh repo view --web                # abrir el repo en navegador
```

## Costo Bloque 1.1

- Tiempo: 1 sesión (~45 min)
- Apple Developer: $0 (no aún)
- GitHub: $0 (free tier privado)
- Total acumulado del proyecto: **$0**

---

## Próximo: Bloque 1.2 — Identity Manager

- Modelo de datos: Identity = `{id, name, color, partition, fingerprintSeed, createdAt}`
- Persistencia en `~/Library/Application Support/oz-browser/identities.json`
- UI: panel lateral con lista de Identities + botones crear/renombrar/borrar/colorear
- Integrar con tabs.js para que cada tab tenga `identityId`
- Cuando se abre nueva tab, preguntar Identity (o usar default)
- Cada `WebContentsView` se crea con `webPreferences.session = sessionForIdentity(id)` — exactamente como en el spike de Etapa 0

2-3 sesiones de trabajo.
