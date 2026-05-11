# Bloque E2-C-6 — Anti-Detect Health Dashboard (resultado)

**Status:** ✅ Cerrado 2026-05-10 noche bis
**Commit:** TBD (feature/c6-health-dashboard)
**Tiempo:** ~2h efectivas vs ~3h estimadas (-33%)
**Deps nuevas:** 0
**Tests:** 1702 → 1745 (+43)

## Decisiones de scope (vía AskUserQuestion al inicio)

1. **UX entry**: badge inline en sidebar + modal detail al click (sobre panel global o ambos). Razón: el caso de uso real es "veo cuál identity tiene problema mientras trabajo", no "auditoría agregada de 30 cuentas" (eso ya lo cubre el MCP `oz.health.list` para automation futura).

2. **Vectores en v1**: los 4 (IP↔TZ, fingerprint coherence, cookie health, proxy reachability). Razón: cubren el 95% de las banderas anti-detect que un sitio de social media puede leer.

3. **Acciones**: inline fix buttons (sobre solo informativo). Razón: cuando alguien ve un dot rojo lo que quiere es FIX, no leer un postmortem. ~30 min extra de código pero UX mucho más útil.

## Arquitectura

```
┌──────────────────────────────────────────────────────────────────┐
│ browser/anti-detect-health.js  (~380 LOC, módulo PURO)            │
│   evaluateHealth({identity, fingerprint, proxy, cookies})         │
│   → { overall, vectors: { ipTimezone, fingerprintCoherence,       │
│                            cookieHealth, proxyReachability } }    │
│                                                                    │
│   Cada vector: { status, summary, details, fix? }                  │
│   status: green | yellow | red | unknown                           │
│   fix: { kind, label } or null                                     │
└──────────────────────────────────────────────────────────────────┘
                              ▲ pure
                              │
┌──────────────────────────────────────────────────────────────────┐
│ browser/anti-detect-health-handlers.js  (~220 LOC)                │
│   Inyecta IdentityManager + FingerprintEngine + ProxyAssignment   │
│   + ProxyManager + ProxyHealth + AntiLogout + AlertManager        │
│   + lee cookies via session.cookies.get() (async + 2s timeout)    │
│   + applyFix dispatcher → reusa managers existentes               │
└──────────────────────────────────────────────────────────────────┘
                       ▲ shared by IPC+MCP
                       │
   ┌───────────────────┼───────────────────┐
   │                                       │
┌──────────────────┐                  ┌──────────────────┐
│ ipc-handlers     │                  │ mcp-tools-health │
│ -extra.js        │                  │ .js              │
│  oz:health:get   │                  │  oz.health.get   │
│  oz:health:list  │                  │  oz.health.list  │
│  oz:health:      │                  │  oz.health.      │
│   applyFix       │                  │   applyFix       │
└──────────────────┘                  └──────────────────┘
   │                                       │
   ▼                                       ▼
┌──────────────────────────────────────────────────────────────────┐
│ UI (browser/ui)                                                   │
│   health-modal.js     singleton window.OZ.HealthCheck             │
│                       4 vector rows con inline fix buttons        │
│   sidebar-health.js   cache + listeners + dot render helper       │
│                       (extraído per ADR 0005, sidebar.js 528→<500)│
│   sidebar.js          renderDotInto(row, identity) en cada row    │
│                                                                   │
│ Triggers: right-click identity, Cmd+K, sidebar dot click          │
└──────────────────────────────────────────────────────────────────┘
```

## Vectores: lógica de scoring

### 1. IP ↔ Timezone

| Estado  | Condición                                                                                  |
| ------- | ------------------------------------------------------------------------------------------ |
| unknown | no hay proxy / proxy.country missing / fp.timezone missing / country no en COUNTRY_LOCALES |
| green   | `fp.timezone === resolveCountry(proxy.country).timezone`                                   |
| yellow  | mismo continente prefix (ej: BA vs Sao Paulo, ambos en `America/`)                         |
| red     | continente distinto (ej: TZ Madrid + proxy Tokio)                                          |

**Fix**: `apply-geo-suggestion` → llama a `FingerprintEngine.applyGeoSuggestion(id, resolveCountry(proxy.country))` que muta solo timezone+languages+locale, preserva UA+screen+blueprint.

### 2. Fingerprint coherence

Cross-checks internos del FP:

- Platform vs UA (MacIntel ⇒ UA contains "Mac")
- Platform vs WebGL renderer (Win32 + Apple/Metal renderer = sospechoso)
- Locale vs languages[0] (locale `es-ES` con languages `[en-US,...]` es señal blanda)

| Estado  | Condición                         |
| ------- | --------------------------------- |
| unknown | no fingerprint                    |
| green   | sin issues                        |
| yellow  | solo issues blandos (locale/lang) |
| red     | algún hard mismatch (UA o WebGL)  |

**Fix**: `reroll-fingerprint` → `FingerprintEngine.regenerate(id)` con seed nuevo.

### 3. Cookie health

Ratio `expired / persistent` (cookies "session" no entran al cómputo: vencen en quit, no por tiempo).

| Estado  | Condición                                      |
| ------- | ---------------------------------------------- |
| unknown | cookies array null o length 0                  |
| green   | persistent === 0 (todas session) o ratio < 20% |
| yellow  | ratio entre 20% y 50%                          |
| red     | ratio ≥ 50%                                    |

**Fix**: `mark-cookies-for-relogin` → `AntiLogout.flagAllForRelogin(id)` si existe + alert log entry. La eliminación real de cookies expiradas queda como follow-up (decisión delicada — preferimos mostrar y delegar).

### 4. Proxy reachability

Reusa el state del 1.8c daemon — no hace probes propios.

| Estado  | Condición                                              |
| ------- | ------------------------------------------------------ |
| unknown | no proxy assigned (direct connection es válido)        |
| green   | lastTestedAt < 24h y failureCount === 0                |
| yellow  | nunca testeado / lastTestedAt > 24h / failureCount > 0 |
| red     | proxy.isDisabled (3 fails consecutivos)                |

**Fix**: `test-proxy` → `ProxyHealth.testOne(proxy.id)` (yellow) o `reassign-proxy` → `ProxyAssignment.assignToIdentity(id, 'auto-random')` (red).

## Overall

`overall = worstOf([...4 statuses])`, donde RANK = `{green:0, unknown:0, yellow:1, red:2}` y `unknown → green` para overall (no signal ≠ bad).

## UX decisions

- **Sidebar dot**: solo se renderiza para yellow/red. Green/unknown stay invisible — la sidebar ya está cargada visualmente, no hay valor en agregar 30 dots verdes "todo OK".
- **Click en dot** abre el modal directo para esa identity (atajo del right-click).
- **Modal**: cada vector como una row con icon (🌍🧬🍪🌐) + nombre + status pill + summary + botón inline `Re-roll fingerprint` / `Apply timezone X` / `Re-test connectivity` / etc.
- **Re-check button** en footer: refetch del record sin cerrar el modal.
- **`oz:health:changed` broadcast** después de cada applyFix → sidebar dots y modal abierto se refrescan automáticamente.

## Files añadidos / modificados

### Nuevos

- `browser/anti-detect-health.js` (lógica pura, 380 LOC)
- `browser/anti-detect-health-handlers.js` (handler map, 220 LOC)
- `browser/mcp-tools-health.js` (3 MCP tools, 60 LOC)
- `browser/ui/health-modal.js` (modal UI, 210 LOC)
- `browser/ui/sidebar-health.js` (sidebar bridge, 85 LOC)
- `tests/anti-detect-health.smoketest.js` (43 tests, 350 LOC)
- `docs/history/24-bloque-c6-resultado.md` (este archivo)

### Modificados

- `browser/ipc-handlers.js` — handlers map + import
- `browser/ipc-handlers-extra.js` — registerHealthHandlersIPC
- `browser/mcp-tools.js` — buildHealthTools spread
- `browser/identity-context-menu.js` — "Health check…" menu item
- `browser/command-palette.js` — entry "Anti-Detect Health Check…"
- `browser/ui/command-palette.js` — modalMap.healthCheck
- `browser/ui/sidebar.js` — usa SidebarHealth.attach + renderDotInto (extracted)
- `browser/ui/webui.html` — modal markup + CSS + script tag + dot CSS
- `preload.js` — `window.oz.health.*` + `oz.sidebar.onRequestHealthCheck`
- `CHANGELOG.md` — entry del bloque

## Tests

43 nuevos en `tests/anti-detect-health.smoketest.js` (ver archivo). Cobertura:

- Cada vector: 4-9 casos cubriendo unknown/green/yellow/red + fix kinds presentes en results.
- Composición top-level: throws on missing identity.id, all-green → green, all-unknown → green, mixed (one red wins), record carries identityId + evaluatedAt.

Total proyecto: 1702 → 1745 (+43).

## Lint / LOC / Prettier

- ESLint: clean.
- check:loc: max 495 (post-extract de sidebar-health.js de sidebar.js, que había llegado a 528).
- Prettier --check . : clean (los 5 archivos nuevos formateados pre-commit con `npx prettier --write`).

## Pendiente

- **Validación visual end-to-end** (`npm start`): trigger el modal por los 3 caminos (right-click, Cmd+K, sidebar dot), aplicar cada uno de los 5 fix kinds y confirmar que el state cambia en disco + UI refresca.
- Bloque C-7 (extension per-identity validation) cierra el E2-C.
