# Guía: Levantar OZ Browser en dev

## Pre-requisitos

- macOS Apple Silicon (M1/M2/M3/M4) — target primario
- Node.js v18+ (testeado en v26)
- npm v9+
- Git

```bash
node --version  # v26+
npm --version   # 11+
git --version
```

Si falta alguno: `brew install node` (Homebrew ya viene con git).

## Clone

```bash
gh auth login    # si no estás logueado
gh repo clone agenciaoz/oz-browser
cd oz-browser
```

## Install

⚠️ Si tienes `NODE_ENV=production` exportado en tu shell (algunos setups lo tienen), npm omite devDependencies. Solución:

```bash
NODE_ENV= npm install --include=dev
```

(El espacio entre `NODE_ENV=` y `npm` no es typo — limpia la variable solo para esta invocación.)

## Run

```bash
NODE_ENV= npm start            # dev mode
SHELL_DEBUG=1 NODE_ENV= npm start  # con DevTools abierto
```

Primera ejecución descarga el binario de Electron (~250 MB). Después es instantáneo.

## Build (DMG distribuible)

```bash
NODE_ENV= npm run make
# DMG queda en out/make/
```

(Para builds firmados/notarizados ver [`release-process.md`](release-process.md) — Etapa 3.)

## Logs durante dev

- File: `~/Library/Logs/OZ Browser/oz-browser.log`
- Tail mientras pruebas: `tail -f ~/Library/Logs/OZ\ Browser/oz-browser.log`
- O usa el Log Viewer in-app (Cmd+Opt+L) cuando esté listo (Bloque 1.7).

## Datos del usuario (donde se guarda todo)

- `~/Library/Application Support/OZ Browser/`
  - `identities.json` — identities config
  - `Partitions/identity-<id>/` — cookies, storage, cache de cada identity
  - (futuro) `vault.enc`, `workspaces.json`, `proxies.json`, `settings.json`, `snapshots/`

Para reset total durante dev: `rm -rf ~/Library/Application\ Support/OZ\ Browser/`.

## Estructura del repo

```
oz-browser/
├─ index.js                  entry → instancia Browser
├─ preload.js                bridge contextBridge → window.oz
├─ forge.config.js           electron-forge build config
├─ webpack.main.config.js
├─ webpack.renderer.config.js
├─ package.json
├─ browser/                  MAIN PROCESS modular (regla 500 LOC)
│  ├─ main.js                orquestador
│  ├─ paths.js               PATHS + helpers
│  ├─ window-manager.js      TabbedBrowserWindow
│  ├─ ipc-handlers.js        ipcMain.handle por dominio
│  ├─ extensions-setup.js    Chrome extensions integration
│  ├─ identity-manager.js    Identity CRUD + sessions
│  ├─ tabs.js                Tab + Tabs (lazy)
│  ├─ logger.js              file logger con rotación
│  ├─ error-handler.js       email-Jose popup
│  ├─ menu.js                app menu
│  └─ ui/                    RENDERER (browser chrome — Chrome extension)
│     ├─ webui.html
│     ├─ webui.js            boot
│     ├─ oz-utils.js         helpers compartidos
│     ├─ tabstrip.js         top tabstrip
│     ├─ sidebar.js          identity sidebar
│     └─ new-tab.html
└─ docs/                     docs (esta carpeta)
```

## Comandos útiles

```bash
# Ver tamaño de archivos (verificar regla 500 LOC)
wc -l browser/*.js browser/ui/*.js | sort -rn

# Tail logs
tail -f ~/Library/Logs/OZ\ Browser/oz-browser.log

# Reset state
rm -rf ~/Library/Application\ Support/OZ\ Browser/

# Kill stuck processes
pkill -9 -f oz-browser
lsof -i :9000 -t | xargs -r kill -9

# Push docs + code
git add -A && git commit -m "..." && git push
```

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `electron-forge: command not found` | NODE_ENV=production bloqueó devDeps | `NODE_ENV= npm install --include=dev` |
| Port 9000 in use | run anterior no cerró bien | `lsof -i :9000 -t \| xargs -r kill -9` |
| App "damaged and can't be opened" | macOS quarantine de unsigned app | `xattr -cr node_modules/electron/dist/Electron.app` |
| Logs vacíos | logger no inicializó (raro) | Buscar "Logger started" — si no aparece, revisar consola en main process |

## Próximos pasos

- Lee [`../OVERVIEW.md`](../OVERVIEW.md) para entender el producto.
- Lee [`../DEPENDENCIES.md`](../DEPENDENCIES.md) para el diagrama de bloques.
- Lee [`../DOCUMENTATION-RULES.md`](../DOCUMENTATION-RULES.md) antes de tocar código.
