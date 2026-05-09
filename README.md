# OZ Browser

Multi-session Chromium browser with per-tab proxies and antidetect.

Inspired by Ghost Browser. Built on Electron + the excellent [`electron-browser-shell`](https://github.com/samuelmaddock/electron-browser-shell) by Samuel Maddock.

## Status

🚧 **Bloque 1.1 — Foundation.** Browser shell con tabs y omnibox funcionando. Identity Manager, proxy pool y antidetect vienen en bloques siguientes.

## Quick start

```bash
npm install
npm start
```

## Development

```bash
# debug mode (abre DevTools)
SHELL_DEBUG=1 npm start

# package para distribución
npm run make
```

## Estructura

- `browser/main.js` — main process (Browser class, gestión de ventanas y extensiones)
- `browser/tabs.js` — Tabs class (WebContentsView por pestaña)
- `browser/menu.js` — app menu
- `browser/ui/` — browser chrome UI (cargada como Chrome extension interna)

## Roadmap

- ✅ **Etapa 0** — Validación técnica (Electron + partition isolation + proxy auth)
- 🚧 **Bloque 1.1** — Foundation (este)
- ⏳ Bloque 1.2 — Identity Manager
- ⏳ Bloque 1.3 — Pool de proxies
- ⏳ Bloque 1.4 — Auto-assign + Workspaces
- ⏳ Bloque 1.5 — Antidetect Ghost+
- ⏳ Bloque 1.6 — Settings + pulir
- ⏳ Etapas 2-9 — UX, distribución, auth, billing, marketing, sync, Windows
