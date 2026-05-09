# ADR 0013 — CI strategy (GitHub Actions)

**Estado:** Aceptado (2026-05-09 — propuesto por Claude durante pasada estructural pre-1.3-MCP, aprobado por Jose)
**Fecha:** 2026-05-09
**Autor:** Claude / Jose

## Contexto

El proyecto ya tiene un smoke test (`tests/identity-manager.smoketest.js`, 28 assertions, mock-Electron) que corre con `node tests/identity-manager.smoketest.js`. Hoy es manual: si Jose o Claude se olvidan de correrlo, no se corre.

A partir del Bloque 1.3-MCP vamos a tener al menos:

- `tests/identity-manager.smoketest.js`
- `tests/mcp-server.smoketest.js`
- Smoke test del IPC↔MCP contract

Y en bloques siguientes:

- Tests de WorkspaceManager, Vault, FingerprintEngine, Backup
- Validación de fingerprint en Pixelscan/CreepJS

Sin CI corriendo automáticamente, la primera vez que algo se rompa nadie lo nota hasta que un humano corra los tests, lo cual puede ser nunca.

Repo es privado en GitHub (https://github.com/agenciaoz/oz-browser). Las cuentas privadas tienen 2000 minutos/mes free de GitHub Actions, suficiente para nuestro volumen actual (10-50 pushes/semana × ~3 min por job = << 2000).

## Decisión

**Implementar GitHub Actions como CI obligatorio en el repo, con jobs ejecutándose en cada push y pull request a main.**

### Workflow `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main, '**']
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: macos-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: oz-browser/package-lock.json
      - name: Install
        working-directory: oz-browser
        run: npm ci
      - name: Lint
        working-directory: oz-browser
        run: npm run lint
      - name: Check LOC rule (ADR 0005)
        working-directory: oz-browser
        run: npm run check:loc
      - name: Smoke tests
        working-directory: oz-browser
        run: npm test

  nightly:
    if: github.event_name == 'schedule'
    runs-on: macos-latest
    steps:
      # Same setup, plus extended tests + upload artifacts on failure
```

### Cron nightly

Job adicional con cron `0 3 * * *` UTC (3 AM) que corre los smoke tests + futuros benchmarks + sube artifacts si fallan. Detecta regresiones por dependencias upstream incluso sin push.

### Branch protection

- PR a `main` no puede mergear si CI rojo (cuando haya equipo; orientativo por ahora con solo Jose+Claude).
- Status badge en `README.md` arriba: `![CI](https://github.com/agenciaoz/oz-browser/actions/workflows/ci.yml/badge.svg)`.

### Plataforma

**macos-latest only.** Apple Silicon es target primario. Windows/Linux entran en Etapa 8; ahí se agregan jobs `windows-latest` y `ubuntu-latest`.

### Caching

`actions/setup-node@v4` con `cache: "npm"` cachea `~/.npm` por hash de `package-lock.json`. Reduce install de ~60s a ~10s en runs subsecuentes.

## Alternativas consideradas

- **Sin CI** (status quo): cero overhead pero pierde el invariante "tests verdes". Inviable a partir de 3+ smoke tests.
- **CircleCI / Travis:** funcionan, pero GitHub Actions ya está integrado con el repo, sin OAuth extra. No hay razón para agregar otro proveedor.
- **Local hooks (Husky pre-push) en vez de CI:** complementario, no sustituto. Husky se desactiva con `--no-verify`; CI no.
- **Self-hosted runner en Mac de Jose:** gratis pero requiere que la Mac esté prendida y con Actions runner corriendo. Frágil.

## Consecuencias

- ✅ Cada push valida que no rompimos nada en ~3 min sin que nadie se acuerde de correr tests.
- ✅ Refactors grandes (como el extract de `identity-handlers.js`/`tab-handlers.js` del 1.3-MCP) se hacen con red de seguridad real.
- ✅ Cuando contrate un dev, el CI ya está. Onboarding más limpio.
- ✅ Status badge en README transmite "este proyecto se cuida" a colaboradores y compradores potenciales.
- ⚠️ Cada push consume ~3 min × Mac runner (10x el costo de Linux). Estimado 30 min/día × 30 días = 900 min/mes ≈ 45% del free tier. Aún cómodo.
- ⚠️ Si un test es flaky, va a haber rojos esporádicos. Mitigación: `retry` step para tests notoriously flaky (no aplica al smoke test actual).
- ⚠️ Tests que requieren GUI (Spectron/Playwright-electron) no corren en CI sin xvfb / `electron-test`. Por ahora: smoke tests son Node-puro mock-Electron, no GUI. Cuando llegue un test GUI (Bloque 1.10), ver `electron-mocha` o spectron-replacement.

## Plan de implementación (Bloque 1.3.5-CI)

1. Agregar `npm run lint` y `npm run check:loc` y `npm test` a `package.json` (parte del Bloque 1.3.6-DX).
2. Crear `.github/workflows/ci.yml` con el contenido del bloque "Workflow" arriba.
3. Push a una branch de prueba, validar que el job corre y pasa.
4. Agregar status badge a `README.md`.
5. Activar branch protection rule en GitHub (Settings → Branches → main): require CI status checks.
6. Documentar en `docs/processes/release-process.md` que un release necesita main verde.

## Referencias

- [ADR 0005](0005-modular-500-loc-rule.md) — la regla de 500 LOC se valida en CI vía `check:loc`.
- [ADR 0014](0014-lint-precommit.md) — lint local complementa al CI.
- GitHub Actions free tier privado: https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
