# Commit style

## Subject line (primera línea)

- Máximo 72 caracteres.
- Empieza con scope si aplica: `Bloque 1.2: ...`, `Docs: ...`, `Refactor: ...`, `Fix: ...`
- Imperativo: "Add feature" no "Added feature".
- Sin punto al final.

## Body (después de línea en blanco)

- Explicar el **porqué**, no solo el qué (el qué se ve en el diff).
- Si la decisión no es obvia, listar alternativas consideradas.
- Listar archivos clave si son muchos.
- Linkear a issues / ADRs / docs si aplican.

## Ejemplos buenos

```
Refactor modular — todos los archivos <500 LOC (Cowork-friendly)

main.js dividido (654 → 155 LOC):
- main.js (155) — Browser class orquestador
- window-manager.js (105) — TabbedBrowserWindow + tab event wiring
- ipc-handlers.js (190) — todos los ipcMain.handle organizados por dominio
- extensions-setup.js (210) — initSession + buildChromeExtensions
- paths.js (33) — PATHS + getParentWindowOfTab helper

Razón: ADR 0005 — facilitar Read sin offset con Claude Cowork.

Validado: arranca sin errores, logs muestran lifecycle completo.
```

```
Fix: app.on('login') no dispara en SOCKS5 con auth (Electron 37)

Cambiamos Etapa 0 spike a HTTPS (us-pr.oxylabs.io:10001 vs SOCKS5
us-pr.oxylabs.io:7777). El evento login dispara consistentemente
con HTTPS y el handler inyecta credenciales correctamente.

Decision documented en ADR 0004.
```

## Ejemplos malos

```
Updates                         ← qué updates? por qué?
Fixed bug                       ← cuál bug? por qué se rompía?
WIP                             ← no commit WIP a main; usa branch
asdf                            ← (no comment)
```

## Tags útiles en subject

| Tag | Cuándo |
|---|---|
| `Bloque X.Y:` | Trabajo del bloque X.Y |
| `Etapa N:` | Trabajo de etapa N |
| `Docs:` | Solo documentación |
| `Refactor:` | Refactor sin cambio de comportamiento |
| `Fix:` | Bug fix |
| `Perf:` | Optimización |
| `Chore:` | Maintenance (deps, ci, build) |
| `Revert:` | Revertir commit anterior |

## Reglas

- 1 commit = 1 cambio coherente. Si necesitas "y" en el subject, son 2 commits.
- No commitear secrets, credenciales, ni archivos de datos del user (`identities.json`, `vault.enc`, etc.). El `.gitignore` los bloquea pero verificar.
- Si pusheas a `main`, asegurar que la app arranca. No commits que rompen.
