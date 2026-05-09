# ADR 0014 — Linter mínimo + pre-commit hook

**Estado:** Aceptado (2026-05-09 — propuesto por Claude durante pasada estructural pre-1.3-MCP, aprobado por Jose)
**Fecha:** 2026-05-09
**Autor:** Claude / Jose

## Contexto

A medida que el proyecto crece (1.2 cerrado con ~2.4K LOC, 1.10 estimado en ~10K), se vuelven más probables los errores baratos:

- `console.log()` olvidados que se cuelan a producción.
- Variables sin uso, imports sin uso.
- Typos en strings de IPC channels (e.g., `'oz:identites:list'` en vez de `'oz:identities:list'`).
- Archivos que crecen > 500 LOC sin que nadie note (rompe ADR 0005).

Hoy nada de esto se chequea automáticamente. El smoke test atrapa lo que rompe runtime, pero no lo que es feo / olvidado / inconsistente.

Atrapar esto **antes de commit** es 10x más barato que en CI o en code review:

- Pre-commit es instantáneo (sin push).
- CI tarda 3 min y consume runner minutes.
- Code review tarda días.

## Decisión

**ESLint mínimo + Prettier + Husky pre-commit hook.** Nada más, nada menos.

### Stack

```json
"devDependencies": {
  "eslint": "^9.0.0",
  "@eslint/js": "^9.0.0",
  "eslint-config-prettier": "^10.0.0",
  "prettier": "^3.0.0",
  "husky": "^9.0.0",
  "lint-staged": "^15.0.0"
}
```

### Config `eslint.config.js` (flat config — ESLint v9+)

ESLint v9 (release septiembre 2024) hace de la flat config la fuente única. La legacy `.eslintrc.json` sigue funcionando con compat plugin pero está deprecada. Arrancamos directo en flat:

```js
// eslint.config.js (Node ESM o CommonJS — soportadas ambas)
const js = require('@eslint/js')
const prettier = require('eslint-config-prettier')

module.exports = [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node globals + browser globals (para los WebUI classic scripts)
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'readonly',
        window: 'readonly',
        document: 'readonly',
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'smart'],
    },
    ignores: ['node_modules/', '.webpack/', 'out/', 'tests/', 'dist/'],
  },
]
```

Notas:

- No agregamos React rules (proyecto es Node + classic JS scripts en webui).
- `no-console` en `warn` — tests usan `console.log`, no queremos romper. Production code prefiere `log.info` (logger).
- `tests/` ignored por ahora (smoke tests usan `console.log` para output legible).
- Globals declarados explícitamente en flat config (legacy `env: { node: true }` ya no aplica directamente — `globals` package lo sustituye si querés ergonómico, pero declarando los 6-7 que usamos a mano es suficiente).

### Prettier `.prettierrc`

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 90,
  "arrowParens": "always"
}
```

Match al estilo existente (revisar `identity-manager.js`: no semis, single quotes, trailing commas).

### Husky pre-commit hook

`.husky/pre-commit`:

```sh
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

cd oz-browser
npx lint-staged
npm run check:loc
```

`lint-staged` config en `package.json`:

```json
"lint-staged": {
  "*.{js,json}": ["eslint --fix", "prettier --write"]
}
```

Lo que hace:

1. Stagged JS/JSON files → eslint con auto-fix → prettier format.
2. `check:loc` valida 500 LOC rule (ADR 0005) global.
3. Si algo falla, commit aborta.

### Bypass

`git commit --no-verify` para emergencias. Documentado en `docs/processes/commit-style.md`. Uso esperado: 0-2 veces al mes en situaciones tipo "necesito commitear este WIP antes de cambiar de máquina".

## Alternativas consideradas

- **Solo Prettier sin ESLint:** Prettier formatea pero no atrapa bugs (`no-unused-vars`, `eqeqeq`). Insuficiente.
- **Solo CI lint, sin pre-commit:** queda atrapado pero después de push. Pre-commit es instantáneo.
- **Biome (linter + formatter en uno):** más rápido y moderno, pero requiere migrar config + el ecosistema Electron sigue mayoritariamente en ESLint. Considerar en 2027.
- **standard.js (zero-config):** opinionado y agresivo. Romperíamos estilo existente del repo. No vale la fricción.
- **No linter:** status quo. Falla en archivos > 500 LOC sin alerta y typos en strings IPC.

## Consecuencias

- ✅ Antes de cada commit: typos atrapados, formato consistente, archivos > 500 LOC bloqueados.
- ✅ Onboarding cuando contrate un dev: clona repo, `npm install`, husky se autoinstala. Mismas reglas para todos.
- ✅ Refactors masivos del 1.3-MCP no introducen `console.log` debug olvidado.
- ⚠️ Primera corrida va a tener `eslint --fix` aplicando trailing commas / quotes a archivos que no las tenían. Commit grande de cosmética para limpiar antes del primer hook real. Lo hacemos como primer commit del Bloque 1.3.6-DX.
- ⚠️ Husky requiere `prepare` script en `package.json` (`"prepare": "husky"`). Corre solo en `npm install` desde repo raíz, no en producción.
- ⚠️ Si Jose alguna vez quiere editar manualmente sin pasar por Claude, va a tener que tener Node instalado en la Mac (ya lo tiene v26).

## Plan de implementación (Bloque 1.3.6-DX)

1. `npm install --save-dev eslint @eslint/js eslint-config-prettier prettier husky lint-staged`
2. Crear `.eslintrc.json`, `.prettierrc`, `.eslintignore`
3. `npx husky init`
4. `.husky/pre-commit` con el contenido de arriba
5. `npm run prepare` para activar
6. Primer pasada `npx eslint . --fix && npx prettier --write .` para limpiar cosmética. Commit separado etiquetado "chore: format codebase per ADR 0014".
7. `scripts/check-loc.js` con npm script `check:loc`.
8. Documentar en `docs/processes/dev-setup.md` cómo funciona.
9. Hacer un commit dummy para validar que el hook bloquea correctamente cuando rompemos una regla.

## Referencias

- [ADR 0005](0005-modular-500-loc-rule.md) — la regla de 500 LOC se valida con `check:loc`.
- [ADR 0013](0013-ci-strategy.md) — CI corre el mismo `npm run lint` y `check:loc` como gate post-push.
- ESLint flat config: https://eslint.org/docs/latest/use/configure/configuration-files-new
- Husky v9: https://typicode.github.io/husky/
