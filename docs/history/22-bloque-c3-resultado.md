# Bloque E2-C-3 — Identity templates / Clone

**Cerrado:** 2026-05-10 (sesión continua post-C-2)
**Tiempo efectivo:** ~1h vs ~2h estimadas (-50% por scope ajustado en 3 preguntas)
**Branch:** `main` directo
**Tests acumulados:** 1584 → 1649 (+65 propios del bloque)
**Deps npm nuevas:** cero
**ADR nueva:** ninguna (orquestación sobre primitivas existentes — IdentityManager + ProxyAssignment + FingerprintEngine)

---

## Objetivo

Duplicar una identity existente preservando opcionalmente fingerprint, proxy assignment y/o User-Agent. Use case real (Jose): "5 sub-cuentas IG con el mismo fingerprint" — diferenciador SaaS vs Ghost que NO tiene clone-with-options. Tercer feature del Bloque E2-C (Quick wins productividad).

## Decisiones tomadas vía AskUserQuestion antes de codear

1. **Scope del clone — User elige al clonar (recomendado)**. Modal con 3 checkboxes (sameFingerprint, sameProxy, sameUA). Defaults: fresh fingerprint (anti-detect safety: si una cuenta es flagged, las clones NO matchean fingerprint), proxy ON si existe assignment, UA OFF. Más flex que "same EVERYTHING" o "fresh EVERYTHING" — cubre los 2 use cases (sub-cuentas mismo dispositivo vs personas distintas).
2. **Templates predefinidos — Solo Clone v1 (recomendado)**. Templates curados ("Fresh US Desktop", etc) quedan como C-XX futuro. Más simple, suficiente para use case real.
3. **UX trigger — Right-click + Cmd+K palette (recomendado)**. Right-click identity en sidebar → "Clone identity…" en context menu (más natural). Plus entry en Cmd+K palette "Clone Identity…" (flujo rápido). Sin nueva UI surface dedicada.

## Entregables

### `browser/identity-clone.js` (~125 LOC, módulo puro testeable)

- `cloneIdentity({srcId, opts, identityManager, proxyAssignment?})` — orquesta create + heredades opcionales. Retorna `{ok, identity, inherited}` o `{ok:false, reason}`.
- `resolveCopyName(srcName, allIdentities)` — auto-genera nombre evitando colisiones. Strip de sufijo `(copy)` / `(copy N)` para que clonar un copy NO produzca anidamiento (`X (copy 2)`, no `X (copy) (copy)`). Defensive contra empty/undefined/null inputs.
- Color + workspaceId siempre se heredan (visual cue + ubicación). FingerprintSeed solo si `sameFingerprint:true`. UserAgent solo si `sameUA:true` Y el source tiene UA. Proxy assignment via `ProxyAssignment.assignToIdentity` solo si `sameProxy:true` Y el source tiene assignment.
- Best-effort: si `proxyAssignment.assignToIdentity` throws, el clone igual queda creado (`ok:true`) con `inherited.proxy=false`.
- Reasons posibles: `not-found`, `no-identity-manager`, `IDENTITY_CAP_REACHED`, `create-failed`.

### `browser/identity-handlers.js` (+~55 LOC)

- `clone(srcId, opts)` — wrapper que llama `cloneIdentity`, hookea anti-logout para la nueva identity (parity con `create()`), broadcastea `oz:identities:changed` + `oz:workspaces:changed`.
- `previewCloneName(srcName)` — preview sin clonar (usado por el modal UI para preset del input).

### `IdentityManager.create()` extendido

Acepta `opts.fingerprintSeed` opcional. Si se pasa, se usa verbatim; si no, `uuid()` fresh (backward-compat). Permite que `identity-clone` haga clone-with-same-fingerprint sin necesidad de tocar el whitelist de `update()`.

### IPC channels (`ipc-handlers.js`)

- `oz:identities:clone(srcId, opts)`
- `oz:identities:previewCloneName(srcName)`

### Preload bridge (`preload.js`)

- `oz.identities.clone(srcId, opts)`
- `oz.identities.previewCloneName(srcName)`
- `oz.sidebar.onRequestCloneIdentity(cb)` — back-channel para que el modal escuche el broadcast del context menu.

### Sidebar context menu (`identity-context-menu.js`)

Entry "Clone identity…" insertada después de "Edit identity…". Disponible para TODAS las identities incluyendo Default y locked (clone es non-destructive — H2 lock solo bloquea remove + clearBrowsingData).

### Modal UI — `browser/ui/identity-clone.js` (~205 LOC)

- IIFE singleton en `window.OZ.IdentityClone` (pattern idéntico a AccountManager + TimeMachine).
- Markup `oz-clone-*` ids en `webui.html` (~95 lines markup + ~95 lines CSS).
- Header con `📑 Clone identity` + close button.
- Source identity preview row con color dot + name.
- Input `New name` pre-poblado vía `previewCloneName()` (auto-suggest "X (copy)" / "X (copy N)").
- Fieldset con 3 checkboxes:
  - **Same fingerprint** (default OFF) — copy: "clone matches the source's blueprint (UA / screen / timezone). Use for sub-accounts of the same 'person'."
  - **Same proxy** (default ON) — copy: "inherit the proxy assignment of the source."
  - **Same custom User-Agent** (default OFF, disabled si source no tiene UA) — copy: "copy the UA override (only if source has one)."
- Cancel / Clone buttons. Esc para cerrar. Cmd+Enter para submit.
- Auto-hide del WebContentsView via `oz.ui.setContentVisible(false)` para que el modal no quede ocluido (ADR 0011).
- Error states: nombre vacío, IDENTITY_CAP_REACHED ("Free tier identity cap reached (max 3)"), reason genérico.

### Cmd+K palette entry (`command-palette.js`)

- `action:clone-identity` con label "Clone Identity…", emoji 📑, keywords "duplicate copy fingerprint sub-account variant", payload `{action:'open-modal', modal:'identityClone'}`.
- modalMap en `command-palette.js` UI extendido con `identityClone: window.OZ && window.OZ.IdentityClone`.
- Cuando se abre desde Cmd+K sin srcId explícito, el modal usa `oz.identities.getActive()` como fallback (clona la identity activa).

### MCP tools (`mcp-tools-identity-clone.js` — split per ADR 0005)

- `oz.identities.clone(srcId, opts)` con schema completo.
- `oz.identities.previewCloneName(srcName)`.
- Split a archivo separado porque `mcp-tools.js` superó 500 LOC al inline-arlas (501). Patrón consistente con `mcp-tools-fingerprint.js` / `mcp-tools-vault.js` / `mcp-tools-tab-context.js` / `mcp-tools-proxies.js`.

## Tests

Total **65 tests propios del bloque** (1649/1649 verde end-to-end).

`tests/identity-clone.smoketest.js` — 63 cases:

- `resolveCopyName`: basic, collision, strip suffix on clone-of-copy, multi-collision, empty/undefined/null defensive (8 tests).
- `cloneIdentity` defensive: no identityManager, not-found.
- `cloneIdentity` basic: fresh fingerprint by default, color/workspace/UA non-inherited.
- `cloneIdentity` explicit name: trim + override.
- `cloneIdentity` sameFingerprint: copies seed verbatim.
- `cloneIdentity` sameUA: copies UA when source has one, no-op when source has none.
- `cloneIdentity` sameProxy: inherits concrete proxyId, inherits auto-strategy strings, no-op without proxyAssignment dep, no-op when source has no assignment.
- `cloneIdentity` proxy save throws: still ok=true (best-effort).
- `cloneIdentity` ALL inheritance flags together.
- `cloneIdentity` locked source CAN be cloned.
- `cloneIdentity` default source CAN be cloned.
- `cloneIdentity` cap reached: returns ok=false with reason IDENTITY_CAP_REACHED + message.
- `cloneIdentity` create throws generic: reason=create-failed.
- `cloneIdentity` integration: clone twice → "X (copy)", "X (copy 2)", "X (copy 3)".

Plus +2 tools en mcp-server contract test (oz.identities.clone + previewCloneName ahora forman parte del catálogo MCP). Total 65 tests netos.

## Métricas

- Lint clean (ESLint + Prettier).
- check:loc max 495 (sin cambios — el split a `mcp-tools-identity-clone.js` evitó que `mcp-tools.js` superara el límite).
- 3 archivos browser/ nuevos: `identity-clone.js` (125 LOC), `mcp-tools-identity-clone.js` (~55 LOC), `ui/identity-clone.js` (205 LOC).
- Modificados: `identity-manager.js` (+1 field opcional en create), `identity-handlers.js` (+~55 LOC), `ipc-handlers.js` (+2 channels), `preload.js` (+~7 LOC), `mcp-tools.js` (+1 import + 1 spread), `identity-context-menu.js` (+1 entry), `command-palette.js` (+1 action), `ui/command-palette.js` (+1 modalMap entry), `webui.html` (+modal markup + CSS + script tag).
- Cero deps npm nuevas.

## Validación visual ✅ PASADA 2026-05-10 noche bis

Validación end-to-end vía Desktop Commander + computer-use sobre `.app` empaquetada (`/Applications/OZ Browser.app` reemplazada con commit `7e34d11`):

1. **MCP path:** `oz.identities.clone({srcId:"7c139faf1b2a1293", opts:{sameFingerprint:true}})` → `ok:true`, new id `08f29d3f97bc9a79`, name `"IG 1 (copy)"` (resolveCopyName generated), color `#e1306c` heredado, workspaceId `"general"` heredado, fpSeed `dccd43431a21ee8c` **idéntico al parent**, `inherited.fingerprint:true`.
2. **MCP fingerprint match verification:** `oz.fingerprint.get` para parent + clone retornan idénticos UA `Mozilla/5.0 (X11; Linux x86_64)…`, `hardwareConcurrency:4`, `timezone:"Europe/Berlin"`, `language:"de-DE"`. La integración con FingerprintEngine SHA256-stream RNG funciona end-to-end.
3. **UI path:** right-click "IG 1" en sidebar → context menu nativo aparece con orden correcto: Rename · Edit identity… · **Clone identity…** · Move to workspace… ▸ · Lock identity · Delete identity.
4. **Click "Clone identity…"** → modal `📑 Clone identity` abre con:
   - "Cloning from: ● IG 1" con color dot matching la identity (`#e1306c`).
   - **NEW NAME pre-poblado "IG 1 (copy 2)"** — `previewCloneName` correctamente detectó que `"IG 1 (copy)"` ya existía (creada vía MCP en step 1) y propone `(copy 2)`.
   - 3 checkboxes con copy descriptiva visible:
     - ☐ Same fingerprint (default OFF) — "clone matches the source's blueprint…"
     - ☑ Same proxy (default ON, marcado) — "inherit the proxy assignment of the source."
     - ☐ Same custom User-Agent (DISABLED + grey + label "source has no custom UA") — el defensive disabled state cuando source no tiene UA funciona.
   - Cancel + Clone buttons.
5. **Click Cancel** → modal cierra limpio sin side effects.

**Resultado:** Cero bugs runtime. Tanto el MCP path (programático) como el UI path (right-click + modal) funcionan en .app empaquetada exactamente como en los unit tests. La verificación de mismo fingerprint profile via MCP confirma que el feature ⭐ "sub-cuentas same person" funciona realmente — diferenciador clave vs Ghost Browser.

## Próximo

E2-C-5 notification panel + alert log (~2h) — historial in-app de alerts (cookie expiry, anti-logout, proxy down, snapshots, etc). O E2-C-6 anti-detect health dashboard (~3h), o E2-C-7 extension per-identity validation (~3h). ~8h restantes en el Bloque E2-C.
