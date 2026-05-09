# Módulo `ui/oz-utils`

**Path:** `browser/ui/oz-utils.js`
**Líneas:** ~41 (incluyendo comments)
**Bloque/Etapa:** 1.2

## Qué hace

Helpers compartidos entre los scripts del browser chrome (WebUI extension): `safe()` para wrappear promesas con error reporting al logger central, `identityColor()` y `identityName()` para lookup en la lista de identities. Se carga ANTES que `tabstrip.js`, `identity-editor.js`, `sidebar.js` y `webui.js`.

## Exports

Inyecta `window.OZ.utils = { safe, identityColor, identityName }`.

| Símbolo                   | Tipo     | Descripción                                                                                                           |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `safe(promise, source)`   | function | Catch + report al logger central, no rethrow. Usado en cada `oz.X.Y()` call para que un fallo IPC no rompa el render. |
| `identityColor(list, id)` | function | Devuelve el `color` de la identity con `id` en `list`, o `'#666'` fallback.                                           |
| `identityName(list, id)`  | function | Devuelve el `name`, o `'Unknown'` fallback.                                                                           |

## Dependencias

- `window.oz.log` (preload bridge, ADR 0009).
- Ninguna dependencia npm.

## Gotchas / decisiones no obvias

- **IIFE wrap obligatorio.** Sin IIFE, `function safe()` declarado al top-level entra al global object (`window.safe`). En classic scripts compartiendo el mismo documento, las siguientes scripts haciendo `const { safe } = window.OZ.utils` chocan con esa binding y lanzan `SyntaxError: Identifier 'safe' has already been declared`. Bug real encontrado en cierre del Bloque 1.2 (smoke test visual). Misma razón se aplica a `tabstrip.js`, `identity-editor.js`, `sidebar.js`, `webui.js`.

- **Por qué no ESM:** electron-browser-shell carga el WebUI chrome como Chrome extension classic content scripts, no como módulos ESM. Migración a ESM = otro bloque (no priorizado).

## Ejemplos de uso

```js
// En sidebar.js
const { safe, identityName } = window.OZ.utils

async function renderRow(ident) {
  const tabs = await safe(window.oz.tabs.list(), 'sidebar/render')
  // …
}
```

## Referencias

- [ADR 0005](../architecture/0005-modular-500-loc-rule.md) — modularización.
- [ADR 0009](../architecture/0009-logging-everything.md) — el `safe()` reportea al logger central.
- Bug history: ver `docs/history/07-bloque-1.2-resultado.md` sección "Bug A".
