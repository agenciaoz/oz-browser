# Módulo `ui/webui`

**Path:** `browser/ui/webui.js`
**Líneas:** ~27 (incluyendo comments)
**Bloque/Etapa:** 1.1 (creado), 1.2 (refactor a bootloader puro)

## Qué hace

Bootloader del browser chrome. Es el último script que carga `webui.html` después de `oz-utils.js`, `tabstrip.js`, `identity-editor.js` y `sidebar.js`. Instancia `TabStrip` + `IdentitySidebar` y los expone en `window.tabstrip` y `window.ozsidebar` (para acceso desde DevTools console). Llama a sus `init()` en serie.

Antes del 1.2 webui.js tenía 490 LOC con TabStrip + IdentitySidebar + utils inline. Refactor del 1.2 lo dejó como bootloader liviano (ADR 0005, regla 500 LOC).

## Exports

Ninguno explícito. Side effect:

- `window.tabstrip` — instancia de TabStrip
- `window.ozsidebar` — instancia de IdentitySidebar

## Dependencias

- `window.OZ.TabStrip` (de `tabstrip.js`)
- `window.OZ.IdentitySidebar` (de `sidebar.js`)
- `window.oz.log` (preload, para reportar boot errors)

## Gotchas

- **IIFE wrap obligatorio** — misma razón que `oz-utils.js` (classic scripts comparten el global lexical scope; ver bug A del 1.2).
- **Si `tabstrip.init()` o `sidebar.init()` rejecta**, el error se reporta vía `window.oz.log.reportError()` y se loggea a la console — pero la app no crashea (graceful degradation).

## Ejemplos de uso

No se invoca directamente. Es loaded via `<script>` tag en `webui.html`:

```html
<script src="oz-utils.js"></script>
<script src="tabstrip.js"></script>
<script src="identity-editor.js"></script>
<script src="sidebar.js"></script>
<script src="webui.js"></script>
```

## Referencias

- [ADR 0005](../architecture/0005-modular-500-loc-rule.md) — el refactor 490→27 LOC.
- [ADR 0011](../architecture/0011-modals-hide-content-view.md) — el modal de identity-editor depende del orden de carga.
