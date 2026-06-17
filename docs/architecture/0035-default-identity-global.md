# ADR 0035 — Default Identity global (paridad Ghost)

**Date:** 2026-06-17
**Status:** Accepted
**Supersede:** ADR 0023 §D2 ("Default identity vive solo en workspace 'general'")
**Predecesores:** ADR 0003 (Default usa `defaultSession`), ADR 0015 (1 ventana = 1 workspace), ADR 0023 (jerarquía identity-per-workspace), alpha.32 (sidebar muestra solo el workspace activo)

## Contexto

ADR 0023 D2 (2026-05-10) decidió que la Default Identity vive **solo** en el workspace `'general'` y no aparece en los demás. Tras alpha.32 (el sidebar muestra únicamente el workspace activo), la consecuencia práctica fue que la Default —"tu navegación normal"— desaparece de la vista en cuanto trabajás dentro de un proyecto.

En Ghost Browser la Default Identity es **global**: aparece arriba en **todos** los workspaces, siempre disponible, con un **único cookie jar** compartido. Jose pidió paridad real con Ghost (decisión 2026-06-17 vía AskUserQuestion: "Sí, global como Ghost").

## Decisión

La Default Identity pasa a ser **global en la UI**: se renderiza **fijada arriba de cada workspace**, no solo en `'general'`.

### D1 — Solo cambia la capa de vista, NO el modelo de datos

- `identity.workspaceId` de la Default sigue siendo `'general'` (sin migración, sin tocar el invariante D1 de ADR 0023 para identities custom: 1 identity = 1 workspace).
- La Default conserva su `defaultSession` y sus extensiones del Chrome Web Store (ADR 0003) — un solo jar global, igual que Ghost.
- El sidebar (`sidebar-view.js` + `sidebar.js`) la **inyecta fijada al tope** en cualquier workspace activo y la **excluye de la lista de miembros** para no duplicarla en `'general'`.

### D2 — Las tabs de la Default son por-ventana (no se globalizan)

El jar es global pero **cada ventana OZ está atada a un workspace** (ADR 0015). Mostrar todas las tabs de Default en todas las ventanas reintroduciría el leak que arregló alpha.32. Por eso las tabs bajo la fila Default se **filtran por la ventana actual** (`windowId`).

Para que el renderer conozca su propia ventana se agrega un IPC mínimo `oz:window:getId` (`browser/window-id-handlers.js`) que matchea `event.sender` contra `win.webContents`. El sidebar lo cachea en `this.windowId` al init.

**Fallback:** si `windowId` no se puede resolver (null), la fila Default cae a la lista sin scope (comportamiento previo) en vez de ocultar tabs.

### D3 — `active-changed` se filtra por ventana

`oz:workspaces:active-changed` se emite por broadcast a todas las webUI. Aprovechando `this.windowId`, el sidebar ahora ignora el evento si `payload.windowId` no es el suyo (cuando se conoce). Corrige de paso un bug latente multi-ventana donde un switch en otra ventana cambiaba el workspace activo de este sidebar.

## Alternativas consideradas

- **Inferir `windowId` desde las tabs de identities miembro** (sin IPC nuevo) — descartado: falla en `'general'` con solo tabs de Default y en workspaces de proyecto vacíos (la Default queda excluida de la inferencia).
- **Globalizar también las tabs de Default** (más fiel a "un jar") — descartado: reintroduce el leak cross-workspace de alpha.32; en Ghost las tabs igual son por-workspace aunque compartan cookies.
- **Migrar `Default.workspaceId` a un valor especial** — innecesario; el cambio es puramente de vista.

## Trade-offs aceptados

- La fila Default aparece en cada workspace incluso si no abriste tabs ahí (es el comportamiento de Ghost; intencional).
- Si `getWindowId` fallara, la Default mostraría tabs sin scope (degradación segura, no pérdida de datos).

## Tests

- `tests/sidebar-view.smoketest.js`: `globalDefaultIdentity` + `defaultTabsForWindow` (scope por ventana, fallbacks).
- Validación visual recomendada: 2 ventanas (general + proyecto), abrir tabs Default en cada una, confirmar que cada sidebar muestra solo las suyas.

## Referencias

- ADR 0023 §D2 (superseded), ADR 0003, ADR 0015
- `Sidebar-Ghost-vs-OZ-Analisis.md` §3 (Divergencia conceptual — Default global)
