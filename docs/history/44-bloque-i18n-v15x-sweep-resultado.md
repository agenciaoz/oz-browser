# Bloque i18n v1.5.x sweep — welcome/wizard/notifications/health/extensions/identity-clone

**Status:** ✅ 5 surfaces cubiertas 2026-05-16
**Commits:** `e718606` (1.5.0) + `b5c9717` (1.5.1) + `d050c27` (1.5.2) + `d342126` (1.5.3) + `066e510` (1.5.4)
**Versions:** 1.5.0 (minor) + 4 patches
**Tiempo efectivo:** ~3h total
**Deps nuevas:** 0
**Tests nuevos:** 0 (UI translations)

## Origen

Roadmap v1: "1.5.0 i18n cobertura completa (notifications + modales + onboarding + dashboard)". El catalog `browser/ui/i18n.js` + `locales/{en,es}.json` ya existía desde 1.1.0 con Settings panel + Migration cubiertos. Pending: modales + notifications + onboarding flow + dynamic strings.

## Decisión: incremental sweep + sentence-complete translations

Approach pragmático: un patch por surface mayor, sentence completos en EN+ES (no fragmentos sueltos para evitar problemas de orden en idiomas con sintaxis distinta). Helper local `t()` con fallback `to-key-if-i18n-not-loaded` en cada módulo dinámico — evita crashes si el catalog carga después que el módulo.

## v1.5.0 — welcome modal + onboarding wizard (minor bump)

**`welcome.*` namespace (24 keys EN+ES)** para los 3 screens del welcome (Identities/Workspaces/Antidetect): titles + taglines + list items (name + desc split para preservar el `<strong>` styling) + buttons (Skip/Back/Next/Get started).

**`wizard.*` namespace (50+ keys EN+ES)** con sub-namespaces `step1-5.*` per-step: titles, taglines, form labels, placeholders, error messages, success messages con interpolation `{{n}}/{{prefix}}/{{workspace}}/{{ok}}/{{fail}}/{{reason}}/{{done}}/{{total}}/{{message}}`. Helper `t()` en `browser/ui/onboarding-wizard.js` para template literal substitution. Render method actualiza buttons textContent (Skip/Back/Continue/Finish) on each render.

**Minor bump 1.4.7 → 1.5.0** — pre-approved en roadmap.

## v1.5.1 — notifications panel + dynamic strings

**`notifications.*` namespace (16 keys EN+ES)**: modal title + Mark all read + Clear all + clearAllConfirm + empty state + stats (`{{total}} total · {{unread}} unread` con interpolation) + `timeAgo.*` sub-namespace (4 keys: justNow/minutes/hours/days con `{{n}}`) + `actions.*` sub-namespace (8 keys para action labels: Open/Accounts/Time Machine/Proxies/Settings/Browsing Data/Identity/Tab).

Updates en `notifications.js`: helper local `t()`, `timeAgo(ts)` uses keys, `actionLabel(action)` switch usa modalLabelKeys lookup, `_render()` stats con interpolation.

## v1.5.2 — Anti-Detect Health modal

**`healthModal.*` namespace (18 keys EN+ES)**: title + buttons + `vectors.*` (4 keys: ipTimezone/fingerprintCoherence/cookieHealth/proxyReachability) + `status.*` (4 keys: OK/Warning/Critical/Unknown) + overall pill con `{{status}}` interpolation + error messages.

Updates en `health-modal.js`: `vectorLabel(key)` y `statusLabel(status)` helpers usan namespace lookups, overall pill via interpolation, working state button label, errorFixFailed con `{{reason}}`.

## v1.5.3 — Extensions per-identity modal

**`extensionsModal.*` namespace (11 keys EN+ES)**: title + buttons + identityLabel + defaultSuffix (interpolation `{{name}} (Default)` en option labels) + empty state + alwaysEnabled tag + enabled/disabled checkbox labels + errorNoIdentities + errorToggleFailed con `{{reason}}`.

Updates en `extensions-modal.js`: helper `t()`, identity select option labels, checkbox label toggling on user action.

## v1.5.4 — Identity Clone modal

**`identityClone.*` namespace (23 keys EN+ES)**: title + closeAria + cloningFrom + newNameLabel + namePlaceholder + legend + 3 checkbox titles (Same fingerprint/proxy/UA) + their descriptions + uaHintCurrent (`{{ua}}` interpolation) + uaHintNone + proxyHintDefault + cancel + clone + 6 error messages (NoSource/NotFound/EmptyName/NoSrcId/CapReached/CloneFailed con `{{reason}}`).

Updates en `identity-clone.js`: helper `t()`, UA hints dinámicos según fuente, error paths.

## Cobertura acumulada

- ✅ Settings panel + Migration (1.1.0)
- ✅ Sidebar parcial (1.1.0)
- ✅ Welcome modal 3 screens (1.5.0)
- ✅ Onboarding wizard 5 steps (1.5.0)
- ✅ Notifications panel + dynamic (1.5.1)
- ✅ Anti-Detect Health modal (1.5.2)
- ✅ Extensions per-identity modal (1.5.3)
- ✅ Identity Clone modal (1.5.4)

## Gaps remaining (sub-bloques v1.5.x futuros)

- account-manager (Vault) — ~50 strings, Jose's core feature
- time-machine — ~30 strings
- cloud-backup — ~25 strings
- team — ~25 strings
- proxy-dashboard.html — parcial (namespace existe, faltan attrs en algunos elements)
- error messages dinámicos en handlers (catch blocks)

## Patrón establecido

Para futuros surfaces, el patrón es:

1. Agregar namespace al final del catalog ES/EN (preserva orden alphabético opcional)
2. Si el modal es estático HTML → `data-i18n` attrs + `data-i18n-attr` para placeholders/aria
3. Si el módulo es JS dinámico → helper local `t()` al top + replace hardcoded strings con `t('namespace.key', params?)`
4. Sentence completo en cada string (no fragmentos)
5. Interpolation con `{{varName}}` en strings de format
