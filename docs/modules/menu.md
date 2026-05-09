# Módulo `menu`

**Path:** `browser/menu.js`
**Líneas:** 51
**Bloque:** 1.1 (heredado del shell)

## Qué hace

Configura el app menu (top menubar de macOS). Heredado de electron-browser-shell sin cambios significativos.

## Exports

| Símbolo | Tipo | Descripción |
|---|---|---|
| `setupMenu(browser)` | function | Aplica el menú a la app. Recibe instancia de Browser. |

## Pendiente (Bloque 1.7)

- Customizar entradas relevantes para OZ Browser:
  - `View → Show Log Viewer` (Cmd+Opt+L)
  - `Identity → Manage Identities`
  - `Identity → New Identity` (Alt+I)
  - `Workspace → New Workspace` (Alt+W)
  - `Workspace → Switch Workspace`
  - `Tab → New Tab in Current Identity` (Cmd+T)
  - `Tab → New Tab in Default` (Alt+G)
  - `Tab → New Temporary Identity Tab` (Alt+N)
  - `File → Export to Excel`
  - `File → Import from Excel`
  - `File → Backup` / `Restore`
  - `OZ Browser → About` con versión + log path
- Manage Shortcuts editor (Bloque 1.7).

## Referencias

- Bloque 1.7 — Settings + custom shortcuts.
