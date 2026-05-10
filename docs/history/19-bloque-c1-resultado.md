# Bloque E2-C-1 — Cmd+K Command Palette

**Cerrado:** 2026-05-10
**Tiempo efectivo:** ~2h vs ~3h estimadas
**Branch:** `feature/c1-cmd-k` (desde `main` post-merge de `hotfix/H1H2H3` 2d0863d)
**Tests acumulados:** ~1285 → ~1324 (+39 propios del bloque)
**Deps npm nuevas:** cero
**ADR nueva:** ninguna (sin decisiones arquitecturales — reusa patrones existentes)

---

## Objetivo

Buscador global (Cmd+K) que filtra identities, workspaces, tabs abiertas y un set de 14 acciones top con fuzzy matching. Primer feature del Bloque E2-C (Quick wins productividad).

## Decisiones tomadas vía AskUserQuestion antes de codear

1. **Branch strategy** — Merge `hotfix/H1H2H3` → main first (fast-forward 12 commits: H + E2-B), branch nueva `feature/c1-cmd-k` desde main. Main queda al día como single source of truth.
2. **Scope** — Identities + workspaces + tabs + 14 acciones top (no solo identities/workspaces/tabs; tampoco history+bookmarks que cortamos a C-1.5).
3. **Algoritmo de matching** — Fuzzy con score VS-Code-style (zero deps, ~100 LOC). No substring simple (UX inferior), no `fuse.js` (50KB bundle + dep nueva contra inventario).

## Entregables

### `browser/command-palette.js` (~330 LOC) — módulo puro

- `buildCommands(sources)` produce items con shape `{id, type, label, hint, subtitle, keywords, accent, emoji, payload}` agrupados en 4 categorías: `action` > `tab` > `identity` > `workspace`.
- 14 acciones estáticas: New Tab, New Identity, Duplicate Tab, Reopen Closed Tab, Pin/Unpin, Lock/Unlock, Move to New Window, Take Snapshot, Open Time Machine, Open Vault, Open Proxies, Open Browsing Data, Open Settings, Toggle DevTools.
- Action payloads bakean `activeIdentityId` (new-tab) y `focusedTabId` (duplicate/lock/pin/move-to-new-window) en build time — evita stale lookups en renderer cuando el palette ya está abierto y focus cambia.
- `fuzzyMatch(query, text)` greedy subsequence con fast-path substring. Bonuses calibrados:
  - `SCORE_EXACT = 100`, `SCORE_PREFIX = 60`, `BONUS_FIRST = 14`, `BONUS_WORD_START = 12`, `BONUS_CONSECUTIVE = 10`, `BONUS_CAMEL = 8`, `SCORE_PER_CHAR = 8`, `PENALTY_GAP = 1`.
  - Devuelve `{score, indices}` o `null`. Indices se usan para highlight.
- `scoreCommand` busca contra label (peso 1.0), keywords (0.8), subtitle (0.6). Mejor field gana.
- `matchAndRank(commands, query, opts)` con `limit = 50`. Empty query → default order (action first). Non-empty → score>0 ordenados desc + tiebreaker estable por type+label.
- Archived workspaces excluidos. Locked identity / locked tab / pinned tab → glyphs en label.

### `browser/command-palette-handlers.js` (~70 LOC)

- `buildCommandPaletteHandlers(browser).list({focusedWindowId})` recolecta identities/workspaces/tabs del focused window (o el window específico) y delega a `buildCommands`.
- `tabSummary(tab)` reduce Tab instance a shape `{id, title, url, pinned, locked}` (lazy-safe — lee `pendingUrl`/`pendingTitle` cuando no materializada).

### `browser/ui/command-palette.js` (~360 LOC IIFE)

- Modal overlay top-aligned 12vh, 560px width, z-index 11000 (por encima de todos los modals → Cmd+K funciona con settings/vault abiertos).
- Listener `oz.commands.onOpen` + backstop `document.addEventListener('keydown')` para Cmd+K cuando el accelerator del menú está suprimido.
- **MIRROR de fuzzyMatch + scoreCommand + matchAndRank** del módulo canónico, comentado como tal. Permite filtrado local on-keystroke sin IPC roundtrip. Tests del módulo canónico cubren la lógica; cualquier divergencia entre las dos copias es un bug detectable visualmente.
- Match highlight con `<mark>` por índice. Categorías agrupadas con header solo en empty query (Sublime/VS Code pattern — filtered results stay linear).
- Mouse hover sincroniza con keyboard nav (no salta el cursor del usuario).
- Executors dispatch por `payload.action`. Helpers `resolveTabId(payload)` y `findTab(tabId)` lookup vía `oz.tabs.list()`.
- `open-modal` probea ambos patrones de instanciación existentes:
  - `window.ozSettingsUI` / `ozProxyManagerUI` / `ozBrowsingDataUI` (creados en `webui.js`).
  - `window.OZ.AccountManager` / `window.OZ.TimeMachine` (singletons self-init en IIFE).
- Honest stub: `move-to-new-window` solo loggea info; el accelerator nativo ⌥S sigue funcionando desde el Tab menu. Followup: exponer `oz:tabs:moveToNewWindow` IPC.

### Wire

- **`browser/ipc-handlers.js`** — agrega `commands: buildCommandPaletteHandlers(browser)` a `browser.handlers`.
- **`browser/ipc-handlers-extra.js`** — registra `oz:commands:list` resolviendo `focusedWindowId` desde `BrowserWindow.fromWebContents(event.sender).id` (más seguro que confiar en `getFocusedWindow` cuando hay multi-window).
- **`preload.js`** — expone `oz.commands.list(opts)` + `oz.commands.onOpen(cb)`.
- **`browser/menu.js`** — nuevo menú top-level "Go" con item "Command Palette… ⌘K" → `browser.getFocusedWindow().webContents.send('oz:command-palette:open')`. **NO** usa `broadcastToWebUI` (que dispararía el palette en TODAS las windows abiertas — bug evitado de entrada).
- **`browser/ui/webui.html`** — markup `#oz-cmdk-modal` + ~120 LOC CSS Spotlight-style (input, list, mark highlight, swatch/emoji, hint, kbd footer).
- **`browser/ui/webui.js`** — instancia `CommandPaletteUI` y expone como `window.ozCommandPaletteUI`.

### Bonus fixes incidentales

- **Typo `browser/menu.js:102`** "Toggle Developer Tool asdf" → "Toggle Developer Tools" (residual del 1.10c).

## Tests — `tests/command-palette.smoketest.js` (39/39)

- **fuzzyMatch basic** (8): empty query, "newt" → "New Tab" matches + indices correctos, no-match, case-insensitive both ways, multiple labels.
- **fuzzyMatch scoring** (3): prefix > middle, consecutive > gapped, word-start > inside-word.
- **scoreCommand weighting** (4): label > keywords (same query), subtitle hit válido, no-match returns null.
- **buildCommands** (12): empty sources → actions only, stable id + payload.action, identity rows con locked glyph + accent + active hint, archived workspace excluded, frozen workspace marked, tab rows con pinned/locked glyphs + url fallback + focused hint.
- **matchAndRank empty query** (3): returns all commands, action first, limit respected.
- **matchAndRank ranking + determinism** (9): "newt" finds matches, surfaces New Tab when no name collision, identity-by-name found, same input → same output, "preferences" via keywords, subtitle URL match works, label > url ranking, garbage → empty.

## Tests omitidos consciously

- **No UI smoke test automatizado.** El renderer corre en chrome-extension protocol con context isolation; testear DOM events de forma headless requiere Playwright/Electron-test setup pesado. La validación visual queda para Jose con `npm start` + Cmd+K. La lógica de match (canónica) sí está testeada en el módulo puro.
- **No contract test IPC↔MCP.** No agregué MCP tools `oz.commands.*` — el palette es UI-only por diseño (no tiene sentido invocar un palette desde MCP, los agentes ya tienen acceso directo a identities/workspaces/tabs). Si en el futuro queremos `oz.commands.list` MCP-accesible, agregar al contract test entonces.

## Métricas

- **Lint:** clean.
- **check:loc:** max 495/500 (sin cambios — los archivos nuevos están bajo budget: command-palette.js 330, command-palette-handlers.js 70, ui/command-palette.js 360).
- **CI:** verde (validación pendiente del push).
- **Cero deps npm nuevas.**

## Validación visual pendiente

Cuando Jose arranque OZ desde source:

1. `OZ_MCP_ENABLED= NODE_ENV= npm start` (o reemplazar el .app empaquetado).
2. Cmd+K → modal aparece top-center con input enfocado.
3. Tipea "set" → highlights "Open Settings" arriba, fuzzy también encuentra otras matches.
4. ↑↓ navega, Enter ejecuta.
5. Esc cierra. Re-abrir mantiene el cursor en input, query vacía.
6. Con vault unlocked: "Open Vault" abre el AccountManager modal. "snapshot" crea un snapshot manual.
7. Con multi-window: Cmd+K dispara SOLO en el focused window.

Bug regression a vigilar: `setContentVisible(false/true)` puede romper si otro modal está abierto al mismo tiempo (z-index 11000 garantiza el orden visual, pero el toggle de WebContentsView visibility se va a alternar mal si dos modals lo modifican en paralelo).

## Followup tickets sugeridos

- **C-1.5: Bookmarks + History recientes en el palette.** Agregar 2 categorías más cap 50 c/u. Sub-bloque ~1.5h.
- **Move-to-new-window IPC.** Cerrar el stub honesto (~30 min) — agregar `oz:tabs:moveToNewWindow` que invoque `tab-handlers.moveToNewWindow`.
- **MCP tools `oz.commands.*`.** Si los agentes externos quieren introspeccionar el palette (~20 min).
- **`window.OZ.X` vs `window.ozX` unificación.** Los dos patrones de instanciación de UI modules generan confusion (probado en `open-modal` executor). Unificar a uno solo en C-2 o un mini-bloque dedicado.

## Estado del bloque E2-C

- ✅ **C-1 Cmd+K command palette** (este bloque)
- ⏳ C-2 crash recovery con state restore (~3h)
- ⏳ C-3 identity templates / clone (~2h)
- ⏳ C-4 bulk multi-account opener (~2-3h)
- ⏳ C-5 notification panel + alert log (~2h)
- ⏳ C-6 anti-detect health dashboard (~3h)
- ⏳ C-7 extension per-identity validation + fixes (~3h)

Total restante del bloque E2-C: ~15-16h.
