# Módulo `onboarding-wizard`

**Path:** `browser/ui/onboarding-wizard.js`
**Líneas:** ~330
**Bloque/Etapa:** K1-extras (v1.4.6 + v1.4.7 smoke fix + v1.5.0 i18n)

## Qué hace

5-step action-oriented wizard que arma el setup core de OZ para un new user. Diferente del welcome modal info-only (`onboarding.js` del 1.10c) — este wizard CREA recursos reales en cada paso, no solo informa.

| Step | Acción                                      | IPC primitive                                               |
| ---- | ------------------------------------------- | ----------------------------------------------------------- |
| 1    | Crear workspace                             | `oz:workspaces:create`                                      |
| 2    | Bulk-import N proxies                       | `oz:proxyImporter:parse` + `oz:proxyImporter:import`        |
| 3    | Crear N identities en el workspace          | loop `oz:identities:create`                                 |
| 4    | Asignar proxies a identities 1:1            | `oz:proxyBulkAssign:preview` + `oz:proxyBulkAssign:execute` |
| 5    | Test health de los proxies recién agregados | `oz:proxyHealth:testAllAndStatus`                           |

## API

```js
const wizard = new OnboardingWizard()
wizard.open() // resets state + renders step 0
wizard.close() // hides modal + restores content visibility
window.OZ.OnboardingWizard = OnboardingWizard
```

Singleton-pattern — `webui.js` instancia uno y lo expone como `window.ozWizard` para Settings re-launch.

## Markup

`oz-wiz-modal` en `webui.html` con:

- `.wiz-body` (dynamic content per step)
- 5 `.wiz-dot` progress indicators con `active` + `done` classes
- 4 buttons: `.wiz-skip-x` (× close), `.wiz-skip`, `.wiz-back`, `.wiz-next`
- Reusa CSS classes `.onb-controls`, `.onb-dot`, `.onb-emoji` del welcome modal — coexisten sin override

CSS `.wiz-*` (~80 LOC en webui.html): `.wiz-step`, `.wiz-field`, `.wiz-textarea`, `.wiz-status`, `.wiz-hint`, `.wiz-summary`.

## State machine

```js
this.state = {
  workspaceId: null, // populated by step 0
  workspaceName: '', // populated by step 0 (used como prefix sugerido en step 2)
  proxyIds: [], // populated by step 1
  identityIds: [], // populated by step 2
  assignedPairs: [], // populated by step 3 (1:1 mapping)
  testResults: null, // populated by step 4 ({ok, fail, total})
}
```

`current` = índice del step actual (0-4). State carry-over entre steps — step 3 usa proxyIds + identityIds del state para pairing preview.

## Flow

```text
open() → render step 0
       → user clicks Next
       → onNext() → _doStepN() async → boolean
            true  → current++ → render next step
            false → stay (status message shown inline)
       → step 4 finish → setSettings('onboardingWizard.completed' = true) → close()

onBack() → current-- → render prev step (state preserved)
handleSkip() → setSettings('onboardingWizard.skippedAt' + skippedAtStep) → close()
```

Each `_doX()` method is async, retorna boolean (true = advance, false = stay). Errors are caught + displayed inline via `.wiz-status` element. No crash en IPC failure.

## i18n (v1.5.0)

Helper local `t(key, params)` con fallback al key si `window.OZ.t` no está cargado todavía (boot race-safe). Namespace `wizard.*` con sub-namespaces `step1-5.*` por step. Interpolation con `{{n}}/{{prefix}}/{{workspace}}/{{ok}}/{{fail}}/{{reason}}/{{done}}/{{total}}/{{message}}` — el helper local hace template-literal substitution si window.OZ.t no implementa interpolation.

Render method actualiza `Next/Back/Skip/Continue/Finish` button textContent on each render (no hardcoded en HTML).

## Trigger / auto-open

`webui.js` registra al boot:

```js
const wizard = new OnboardingWizard()
window.ozWizard = wizard
const flag = await window.oz.settings.get('onboardingWizard')
const welcomeShown = await maybeOpenWelcome()
if (!welcomeShown && flag && flag.completed === false) wizard.open()
```

**v1.4.7 fix:** auto-open del wizard skipped si el welcome modal está showing (modales superpuestos = UX bug). El wizard auto-opens en el NEXT boot una vez el welcome se dismiss → flow linear.

## Settings

`settings-manager.js` DEFAULTS añade:

```json
{
  "onboardingWizard": {
    "completed": false,
    "skippedAt": null,
    "skippedAtStep": null
  }
}
```

Flag independiente de `onboarding.*` (welcome 3-screen) — Jose puede haber visto welcome y re-launch wizard manualmente desde Settings.

## Re-launch manual (futuro v1.5.x)

Settings UI button "Re-run onboarding wizard" → `window.ozWizard.open()`. Resets state + abre desde step 0. Pendiente — comentado en code como TODO.

## Tests

`tests/onboarding-wizard.smoketest.js` — no existe todavía. Wizard es UI-heavy + state machine; smoke visual es el test primary (2026-05-16 PASS step 0 only — step 1-4 pending). Sub-bloque test v1.5.x: state machine unit + each `_doX()` con mock window.oz.\* IPC.

## Gotchas

- `window.OZ.utils.safe(promise, label)` swallows promise rejections en wire-up calls (best-effort). NO usar para llamadas que deben crash si fallan.
- Step 0 sin workspaceId → block step 1 hasta que workspaceId esté set (validación inline).
- Step 3 pairing: si `proxyIds.length !== identityIds.length`, se hace pair hasta `min(N, M)` y se loguea warning. Sin error fatal — Jose puede tener más identities que proxies (algunas usan IP cruda).
- Step 4 `testAllAndStatus` solo testea los proxies de `this.state.proxyIds`, no todos los proxies del system (`scope: 'ids'`).
- Helper `escapeHtml` local (no del módulo `oz-utils`) porque al boot el wizard se instancia ANTES de que oz-utils cargue completamente en algunos race orders.

## Consumers

- `browser/ui/webui.js` — instanciación + auto-open + `window.ozWizard` global
- `browser/ui/webui.html` — markup + CSS

## Smoke visual

- **2026-05-16 (v1.4.6):** wizard auto-opens, step 0 form input + 5 dots + buttons OK. K1-extras 5/5 confirmed operational.
- **2026-05-16 (v1.4.7):** modales no se apilan más — wizard espera al next boot post-welcome dismiss.
- **Pending:** smoke end-to-end de los 5 steps con datos reales (proxies + identities) → v1.5.x.
