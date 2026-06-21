# Módulo `sidebar-projects`

**Path:** `browser/ui/sidebar-projects.js`
**Líneas:** ~166
**Bloque:** Ghost F2 (UI, save/restore)

## Qué hace

Sección colapsable "Proyectos" del sidebar: guardar el workspace activo o toda la sesión como proyecto con nombre, y listar/abrir/borrar. Los datos vienen del backend vía `window.oz.projects` (NO localStorage). Espeja el patrón de `sidebar-tasks.js`; la lógica pura vive en `sidebar-projects-utils.js`.

## Exporta / API

Clase `ProjectsModule` (instancia global en `window.OZ.projectsModule` vía `init()`):

| Método             | Descripción                                                           |
| ------------------ | --------------------------------------------------------------------- |
| `refresh()`        | Trae la lista de `window.oz.projects.list()`, ordena y re-render.     |
| `_save(type)`      | Pide nombre (`window.OZ.ui.prompt`) y guarda (`workspace`/`session`). |
| `_open(id)`        | Reabre un proyecto (`window.oz.projects.open`).                       |
| `_remove(id,name)` | Confirma (`window.OZ.ui.confirm`) y borra.                            |
| `_render()`        | Pinta la lista (nombre + resumen + botón borrar) o estado vacío.      |

## IPC / MCP

Consume el preload `window.oz.projects.*` (list/save/open/remove), que va contra IPC `oz:projects:*` → handlers `oz.projects.*`. Estado de colapso persiste en `localStorage` (`oz-projects-collapsed`).

## Gotchas

- Solo el estado de colapso usa localStorage; los proyectos viven en el backend (MCP-first).
- Usa los helpers puros `window.OZ.SidebarProjectsUtils` (`sortProjects`, `cleanName`, `projectSummary`) con fallbacks defensivos si no están cargados.
- Si no existe `#oz-projects` en el DOM, el constructor sale temprano (no-op).
- ADR 0005 (modular).
