# Bloque K1 (onboarding wizard) — 5-step action wizard, cierra K1-extras 5/5

**Status:** ✅ K1-extras CERRADO 5/5 — 2026-05-15
**Commits:** `f648cc8` (v1.4.6) + `5639eef` (v1.4.7 smoke fix)
**Version:** 1.4.6 + 1.4.7 (patches)
**Tiempo efectivo:** ~3h
**Deps nuevas:** 0
**Tests nuevos:** 0 (UI wizard, smoke visual primario)

## Origen

Último K1-extra del roadmap v1: "Onboarding wizard 5-step (workspace → proxies → identities → asignar → test)". Diferente del welcome modal info-only del 1.10c — este wizard ES action-oriented (cada paso CREA recursos en OZ).

## Decisión: reusa primitives existentes, orchestration layer mínimo

Cada step llama IPC primitive existente:

1. **Workspace** → `oz:workspaces:create` con name + color
2. **Proxies** → `oz:proxyImporter:parse` + `oz:proxyImporter:import` (bulk paste host:port:user:pass)
3. **Identities** → loop `oz:identities:create` N veces dentro del workspace
4. **Asignar** → `oz:proxyBulkAssign:preview` + `oz:proxyBulkAssign:execute` (1:1 mapping)
5. **Test** → `oz:proxyHealth:testAllAndStatus` reporta ok/fail/total

## v1.4.6 — implementación

### `browser/ui/onboarding-wizard.js` (NEW, ~330 LOC)

Single class `OnboardingWizard` con render dispatch per step + state machine. State: `{workspaceId, workspaceName, proxyIds, identityIds, assignedPairs, testResults}`. Each step's `_doX()` async invoca el IPC correspondiente y retorna boolean (true = advance, false = stay). State carry-over entre steps (workspaceId → step 3 prefix suggestion, proxyIds + identityIds → step 4 pairing preview).

### HTML markup `oz-wiz-modal` en webui.html

Single modal container con `<div class="wiz-body"></div>`. JS renderea step content dinámicamente. 5 dots progress indicator (active + done classes). Skip/Back/Continue buttons reusan CSS classes existentes (`.onb-controls`, `.onb-dot`).

### CSS `.wiz-*` classes

~80 líneas para `.wiz-step`, `.wiz-field`, `.wiz-textarea`, `.wiz-status`, `.wiz-hint`, `.wiz-summary`. No overrida `.onb-*` existing classes — coexisten.

### Settings extension

`settings-manager.js` DEFAULTS adds `onboardingWizard: {completed, skippedAt, skippedAtStep}` section. validateKey new case `skippedAtStep` (small non-negative integer or null). **Flag independiente del `onboarding` (welcome 3-screen info-only del 1.10c)** — un user puede haber visto el welcome y re-launch el wizard desde Settings sin re-ver el welcome.

### Trigger

webui.js instancia OnboardingWizard. Al boot, si flag `onboardingWizard.completed === false`, llama `wizard.open()`.

## v1.4.7 — smoke fix: don't stack modals

Smoke visual reveló que el wizard auto-trigger en v1.4.6 podía abrir el wizard MIENTRAS el welcome modal estaba showing (modales superpuestos). Fix: `maybeOpen()` retorna boolean `welcomeShown`. Skip auto-open del wizard si `welcomeShown === true`. El wizard auto-opens en el NEXT boot una vez el welcome se dismiss. UX linear.

## Smoke visual 2026-05-16 PASS

Wizard auto-opens correctamente en step 1 "Create a workspace" con form input + 5 dots progress + Skip/Continue buttons. **K1-extras 5/5 CONFIRMED operational**.

## K1-extras 5/5 CERRADO

| K1-extra               | Version | Commit                |
| ---------------------- | ------- | --------------------- |
| Bulk-open              | v1.4.0  | `93b21cc`             |
| Session warmer         | v1.4.1  | `2599fe8`             |
| Mac sleep proxy rescan | v1.4.2  | `ef2e330`             |
| Identity HUD           | v1.4.3  | `b5dee97`             |
| Onboarding wizard      | v1.4.6  | `f648cc8` + `5639eef` |

## Pendiente v1.5.x

- Settings UI button para re-launch wizard manualmente
- Tests unit del wizard (state machine, \_doX paths)
- Smoke visual end-to-end de los 5 steps (no solo step 1)
