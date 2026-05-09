# Módulo `ui-identity-editor`

**Path:** `browser/ui/identity-editor.js`
**Líneas:** 156
**Bloque:** 1.2 ✅

## Qué hace

Modal overlay (en `webui.html`, no popup window) para editar una Identity: name, color, custom User-Agent. Triggered desde el context menu del sidebar (`Edit identity…`) via `window.OZ.IdentityEditor.open(identity)`.

## API

| Símbolo | Tipo | Descripción |
|---|---|---|
| `window.OZ.IdentityEditor` | singleton | Instancia única; el modal vive embebido en `webui.html` (id `oz-identity-modal`). |
| `IdentityEditor.open(identity)` | método | Muestra el modal seedado con la identity dada (snapshot — no mutado). |
| `IdentityEditor.close()` | método | Oculta el modal. También se cierra con backdrop click, botón `✕`, botón Cancel, tecla Escape. |

## Estructura HTML (en `webui.html`)

```
#oz-identity-modal[hidden]
  .oz-modal-backdrop[data-close]
  .oz-modal-window[role="dialog"]
    header
      h2#oz-identity-modal-title
      button.oz-modal-close[data-close]
    .oz-modal-error#oz-identity-modal-error[hidden]
    form#oz-identity-form
      label > input[name="name"]
      label > .color-swatches#oz-identity-swatches
      label
        .ua-row > span + button#oz-identity-ua-default
        textarea[name="userAgent"]
        small#oz-identity-ua-hint
      .oz-modal-actions
        button.oz-btn-cancel[data-close]
        button.oz-btn-save[type="submit"]
```

## Comportamiento

- **Default Identity:** el campo User-Agent se muestra deshabilitado y el hint cambia a "Default Identity uses the shared session — UA cannot be customized here." Razón: ADR 0010 / 0003.
- **Color swatches:** la paleta es la misma constante que `identity-manager.js DEFAULT_COLORS` (mantener sincronizada manualmente). Si el color actual no está en la paleta, selecciona la primera.
- **User-Agent vacío:** se envía como string vacío al backend, que lo traduce a `null` (default Chromium). El botón "Use default" simplemente vacía el textarea.
- **Submit:** llama `window.oz.identities.update(id, patch)`. Si el patch resulta en error (`__error`), muestra el message en la franja roja y NO cierra el modal.
- **Escape / backdrop click:** cierra sin guardar.

## IPC

Indirecto: usa `window.oz.identities.update(id, patch)` del preload. No registra IPC handlers propios.

## Dependencias

- `window.oz.identities.update` (preload)
- `window.OZ.utils.safe` (oz-utils.js)
- `window.oz.log` para warns / debugs si el modal markup falta (defensivo)

## Gotchas

- **Carga antes que sidebar.js:** en `webui.html`, el orden es `oz-utils.js` → `tabstrip.js` → `identity-editor.js` → `sidebar.js` → `webui.js`. Sidebar accede a `window.OZ.IdentityEditor` para abrir el modal; debe existir antes.
- **El modal NO desaparece automáticamente al cambiar de window:** vive en el DOM del WebUI, una instancia por window. Si abres la misma identity en 2 windows simultáneamente, ambas modals editan la misma data en disco — last-write-wins. Aceptable para v1; revisar en Bloque 1.3+ cuando haya multi-window real.
- **`document.addEventListener('keydown')` para Escape** está siempre activo y solo actúa si el modal está abierto. Pequeño costo, OK.

## Referencias

- ADR 0010 (per-identity UA).
- Módulo backend: [`identity-manager.md`](identity-manager.md).
- Sidebar (caller): [`ui-sidebar.md`](ui-sidebar.md).
