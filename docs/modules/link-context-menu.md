# Módulo `link-context-menu`

**Path:** `browser/link-context-menu.js`
**Líneas:** ~41
**Bloque:** Ghost F1 (open link in identity)

## Qué hace

Pieza PURA que, dada la lista de identidades, devuelve los descriptores de los items del submenú "Abrir link en…" que aparece al hacer click derecho sobre un link dentro de una página. El wiring a Electron (construir los `MenuItem` con sus handlers y abrir el link en la identity elegida) vive en `extensions-setup.js`.

## Exporta / API

| Export                      | Descripción                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `openInIdentityItems(args)` | Devuelve un array de descriptores `{ label, action, identityId? }`. |

`args`: `{ identities, activeIdentityId? }`. Acciones posibles:

| `action`    | Significado                                    |
| ----------- | ---------------------------------------------- |
| `open`      | Abrir el link en la identity `identityId`.     |
| `open-temp` | Crear identity temporal y abrir ahí.           |
| `open-new`  | Crear identity nueva (con nombre) y abrir ahí. |

## IPC / MCP

No registra IPC directamente (lógica pura). Se consume desde el wiring de Electron del context menu (`extensions-setup.js`).

## Gotchas

- Marca la identity activa con sufijo ` (actual)` y la default con ` (default)`.
- Las acciones de creación (`open-temp`, `open-new`) van siempre al final, separadas conceptualmente de las identidades existentes.
- Filtra entradas sin `id` string válido.
- ADR 0016 (tab-context-menu) · 0005 (modular).
