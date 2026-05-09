# ADR 0011 — Modals/overlays in WebUI must hide the active WebContentsView

**Estado:** Aceptado
**Fecha:** 2026-05-09
**Pedido por:** descubierto durante smoke test visual del Bloque 1.2
**Bloque:** 1.2 (closing)

## Contexto

El "browser chrome" (sidebar + topbar) vive en `webui.html` como una Chrome extension HTML page. El "content area" (lo que el usuario ve al navegar) es un `WebContentsView` nativo posicionado en `(SIDEBAR_WIDTH+4, TOOLBAR_HEIGHT)` con tamaño remanente.

WebContentsView es una primitive nativa de Electron que **se renderiza ENCIMA de cualquier DOM HTML del chrome**. El compositor lo coloca como una capa native sobre la BrowserWindow's webContents. No hay z-index HTML que pueda tapar un WebContentsView.

Cuando el modal `oz-identity-modal` (un overlay HTML en webui.html) intenta abrirse, el backdrop oscuro y el contenido del modal solo son visibles dentro del rect del browser chrome (sidebar 220px + topbar 64px). El área del content area (~1060×620 px) los tapa por completo.

Descubierto durante smoke test visual del Bloque 1.2: al hacer "Edit identity…", el sidebar/topbar se atenuaban (backdrop) pero el modal era invisible — la WebContentsView del tab activo lo cubría.

## Decisión

**Toda overlay del WebUI que necesite cubrir el área del content (modales, dialogs, command palettes, etc.) debe ocultar la WebContentsView del tab activo mientras está visible, y restaurarla al cerrar.**

Implementación canónica:
1. IPC `oz:ui:setContentVisible(visible: boolean)` registrado en `ipc-handlers.js → registerUiHandlers`.
2. Preload expone `window.oz.ui.setContentVisible(visible)`.
3. El componente del WebUI (`identity-editor.js`, futuras: settings, command palette, etc.) llama:
   - `setContentVisible(false)` al `open()`.
   - `setContentVisible(true)` al `close()`.
4. La operación es idempotente (`view.setVisible(...)` sin side effects).

## Alternativas consideradas

- **Modals en BrowserWindow separadas (sub-windows):** más nativo, evita el issue. Pero implementación pesada (creación/destrucción de window por cada open, IPC más complicado, manejo de focus, no integración con backdrop blur del WebUI). Reservado para casos donde el modal tenga workflow propio largo (ej: import wizard de Excel en Bloque 1.5).
- **Reposicionar el WebContentsView fuera de pantalla:** funciona pero se ve un flash. setVisible(false) es instantáneo y limpio.
- **Mover el modal a una capa "overlay browser-window-action":** Electron tiene `browser-action-list` que sí se renderiza encima de WebContentsView. Pero esa primitive es para popups de extensions, no para overlays de UI propia. Hack que rompe convenciones.
- **Renderizar el modal en una segunda WebContentsView con setContentBackgroundColor transparent que se pegue al window completo:** complejidad sin beneficio claro.

## Consecuencias

- ✅ Solución de 1 línea por modal (`window.oz.ui.setContentVisible(false/true)`).
- ✅ Backdrop blur + DOM HTML del modal funciona normalmente.
- ✅ Patrón replicable en futuras overlays del WebUI.
- ⚠️ Mientras el modal está abierto, la página real no progresa visualmente (videos en pausa visual aunque siguen reproduciendo). Aceptable para modales rápidos. Si el modal es largo (>30s), pausar también el audio explicitamente.
- ⚠️ **Multi-window correctness:** el handler resuelve el window destino desde `event.sender` (el webContents que envió el IPC), NO desde `getFocusedWindow()`. La OS focus puede diverger del window donde vive el modal — si usaras la focused, ocultarías el content del window EQUIVOCADO y dejarías el modal de la calling window cubierto por su propia WebContentsView. Bug encontrado durante el smoke test del Bloque 1.2 (Jose abrió accidentalmente una segunda ventana).
- ⚠️ Edge case: si hay 0 tabs (no debería pasar — siempre hay al menos la initial), `setContentVisible` no hace nada. Modal aún funciona porque el content area está vacío de todas formas.

## Casos donde aplica este patrón

- ✅ Identity editor modal (Bloque 1.2)
- 🔜 Workspace switcher / editor (Bloque 1.3)
- 🔜 Proxy editor / bulk import (Bloque 1.4)
- 🔜 Account vault unlock prompt (Bloque 1.5)
- 🔜 Settings overlay (Bloque 1.7)
- 🔜 Command palette (Etapa 2)
- 🔜 Onboarding (Bloque 1.10)

Cuando agregues uno nuevo: copiar el patrón de `identity-editor.js open()/close()`.

## Referencias

- Implementación: `browser/ipc-handlers.js → registerUiHandlers`, `preload.js → window.oz.ui`, `browser/ui/identity-editor.js`.
- Doc módulo: `../modules/ui-identity-editor.md`.
- Descubierto en smoke test del Bloque 1.2 — ver `../history/07-bloque-1.2-resultado.md`.
