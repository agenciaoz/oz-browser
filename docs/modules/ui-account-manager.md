# Módulo `ui-account-manager`

**Path:** `browser/ui/account-manager.js` (~498 LOC) + `browser/ui/account-manager-render.js` (~125 LOC)
**Bloque/Etapa:** 1.5f (CORE — cierre del Bloque 1.5 ⭐)

## Qué hace

Modal full-screen montado sobre la WebUI para gestionar el vault de accounts end-to-end. Es la **interfaz humana** que sienta arriba de los handlers `vault.*` / `accounts.*` / `excel.*` (sub-fases 1.5a/b/e). Cuatro vistas conmutables:

1. **Lock** — vault bloqueado o sin inicializar. Botón `Unlock vault` (Keychain prompt vía `@napi-rs/keyring`) + `Reset vault…` (destructive, double-confirm vía `confirm()`).
2. **List** — toolbar con search por site/username + filtros por identity/workspace/status, lista tabular con chips de identity/workspace y badge de status, botones Edit/Delete por row, Export/Import/New en la toolbar.
3. **Editor** — form para create/update account (site, username, password, identityId, workspaceId, totpSecret, status, notes). Validación: site/username/password/identityId required.
4. **Import** — picker de modo PERMANENT_MERGE / EPHEMERAL_SESSION / NEW_WORKSPACE / OVERWRITE_TOTAL con descripción inline + double-confirm para OVERWRITE_TOTAL.

## Apertura

Botón `🔐 Accounts` arriba del sidebar (entre Workspaces e Identities). Tiene un dot que refleja vault status en tiempo real (verde = unlocked, amarillo = locked, gris = unknown). Click → `AccountManager.open()`.

Hide WebContentsView via `oz:ui:setContentVisible(false)` al abrir (ADR 0011) — sin esto el modal se queda detrás de la tab activa.

## Split por ADR 0005 (<500 LOC)

`account-manager.js` reached 510 meaningful LOC en el primer pass. Extraído `account-manager-render.js` con helpers puros:

- `renderRow(account, idMap, wsMap, callbacks)` → `<div class="am-row">` con cells site/username/identity-chip/workspace-chip/status-badge/actions.
- `applyFilters(accounts, {query, identityId, workspaceId, status})` → array filtrado.
- `populateSelect(selectEl, items, currentValue, placeholder?)` → re-render `<option>`s preservando valor actual.

El módulo principal queda en ~440 LOC meaningful.

## Eventos consumidos (preload bridge)

| Evento                  | Reacción                                            |
| ----------------------- | --------------------------------------------------- |
| `oz:vault:changed`      | Refresca dot del botón opener.                      |
| `oz:accounts:changed`   | Re-render lista si modal abierto.                   |
| `oz:identities:changed` | Re-render lista (chip names pueden haber cambiado). |
| `oz:workspaces:changed` | Re-render lista (chip names pueden haber cambiado). |

## Auto-save dialog (1.5f-C)

Cuando un content script (1.5c) detecta login submit y llama `oz.accounts.proposeAutoSave`, el handler del IPC en main:

1. Consulta `accounts.proposeAutoSave` (handler 1.5b) que devuelve `{action:'create'|'update', existingAccountId?}` y broadcast `oz:autofill:propose-save`.
2. Muestra `dialog.showMessageBox` nativo del OS encima del browser ("Save password for X on Y?" con buttons `Save password` / `Not now`).
3. Si user confirma: invoca `accounts.update` (action='update') o `accounts.create` (action='create') con el password capturado.
4. Devuelve `{userChoice: 'created'|'updated'|'declined', accountId?}` al renderer que lo invocó (content script).

Este flow vive en `browser/ipc-handlers.js` `oz:accounts:proposeAutoSave` (NO en `account-manager.js` — es independiente del modal del Account Manager).

## Identity cap remove (1.5f-D)

Decisión de Jose: el use case real son 50+ accounts. El cap de 3 (free tier) era apropiado para hook de adquisición pero molesta en uso interno. Cambio en `browser/identity-manager.js`:

```js
const IS_FREE_TIER = process.env.OZ_TIER === 'free' // OPT-IN
const IS_PAID_TIER = !IS_FREE_TIER // default
```

Default sin OZ_TIER set → sin cap (paid). Free-tier (cap 3) ahora es opt-in vía `OZ_TIER=free` — útil pa screenshots de marketing del upgrade prompt o builds free-tier dedicados. Cuando llegue billing real (Etapa 5), `IS_PAID_TIER` se reemplaza por entitlement check de auth-client.js.

Tests `identity-manager.smoketest.js` ajustados: el test del cap ahora hace `freshIM({OZ_TIER: 'free'})` explícito + agregado test del default behavior sin cap.

## Estado interno

```js
this.state = {
  accounts: [], // snapshot del vault
  identities: [], // pa renderizar chips + populating selects
  workspaces: [], // idem
  editingId: null, // null = new account, string = update existing
  importPendingPath: null, // file path entre pickImport y confirm import
}
```

`_reloadAndRender()` hace los 3 fetches en paralelo y triggerea re-render.

## File dialogs nativos

`oz.excel.pickExportPath()` y `oz.excel.pickImportPath()` son IPC wrappers que invocan `dialog.showSaveDialog` / `dialog.showOpenDialog` desde main. El renderer NO puede invocar `dialog` directamente (security). Devuelven `{filePath}` o `{canceled: true}`.

Estos dos channels están en el contract test `mcp-server.smoketest.js` exempt list — son UI-only, no tienen sentido vía MCP.

## Gotchas

- **Re-render infinito durante crear:** `accounts.onChanged` re-render → si el modal está abierto. NO causa loop porque no muta el state intermedio.
- **Password en plaintext en el form:** input type=text para que el user pueda copiar/verificar. Trade-off consciente — el modal está detrás del Keychain unlock, los passwords ya están en RAM cuando el user lo ve. Si necesitamos hide-by-default + show button, agregarlo en 1.5g.
- **Identity cap interaction con import:** si el Excel trae 200 identities nuevas y `OZ_TIER=free` está set, el import explota a mitad con `IDENTITY_CAP_REACHED`. La UI muestra el `__error.message` en el banner. Las identities ya creadas se quedan creadas — el state queda consistente pero no idempotente. En la práctica con default behavior (sin cap), no es un problema.
- **Editor reset on new:** después de submit successful, `_showView('list')` deja el form intacto. La próxima vez que se abre un editor con `_openEditor(null)` corre `this.$form.reset()` antes de poblar — no hay leak.

## Cobertura de tests

Sin tests unit dedicados (UI clase-DOM, dependencia 100% del DOM real). Cubierto end-to-end en la validación visual del cierre 1.5 — se verificó:

- Vault first-time setup (Keychain prompt + auto-gen 32-byte master key).
- Create account vía editor → persiste → re-render lo muestra.
- Edit account → password update reflejado.
- Delete account con confirm → row desaparece.
- Filtros search + identity + workspace + status combinables.
- Export → `.xlsx` válido en disk con 11 columnas.
- Import → 4 modos funcionan, identities/workspaces auto-creadas.
- Auto-save dialog nativo cuando un form es submited en un sitio del whitelist (1.5c).

## Referencias

- [`account-vault.md`](account-vault.md) — backend del vault.
- [`account-handlers.md`](account-handlers.md) — handlers consumidos via preload.
- [`excel-io.md`](excel-io.md), [`excel-handlers.md`](excel-handlers.md) — Excel I/O.
- [`preload-content.md`](preload-content.md) — auto-save trigger.
- [ADR 0011](../architecture/0011-modal-content-visibility.md) — patrón hide WebContentsView.
- [ADR 0005](../architecture/0005-modular-500-loc-rule.md) — split en 2 archivos.
