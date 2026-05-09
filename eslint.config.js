// OZ Browser — ESLint flat config (ESLint v9+).
// ADR 0014: Linter mínimo + pre-commit hook.
//
// Por qué flat config: ESLint v9 deprecó .eslintrc. Flat es más simple
// (un array de configs sin extends mágico) y es lo que se mantiene.

const js = require('@eslint/js')
const prettier = require('eslint-config-prettier')

module.exports = [
  // Ignores van en su propio bloque para que apliquen globalmente.
  {
    ignores: [
      'node_modules/',
      '.webpack/',
      'out/',
      'dist/',
      'build/',
      'tests/', // smoke tests usan console.log para output legible
    ],
  },

  // Recomendados de ESLint core.
  js.configs.recommended,

  // Apaga reglas que chocarían con Prettier.
  prettier,

  // Regla del proyecto.
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node globals
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        console: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        // Browser globals (para classic scripts del WebUI extension)
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Promise: 'readonly',
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'smart'],
    },
  },

  // Scripts del WebUI son classic scripts cargados via <script>, no CommonJS.
  // Tienen acceso a window globals + chrome.* extension API + dialog APIs.
  {
    files: ['browser/ui/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        chrome: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
    rules: {
      // En classic scripts en navegadores está bien usar console para debug.
      'no-console': 'off',
    },
  },

  // preload.js corre en el contextBridge de Electron. Es CommonJS regular pero
  // tiene un setup específico — NO declarar contextBridge/ipcRenderer como
  // globals (vienen del require('electron')).
  {
    files: ['preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },

  // Scripts CLI standalone — pueden usar console libremente.
  {
    files: ['scripts/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },

  // Tests pueden usar console libremente.
  {
    files: ['tests/**/*.js'],
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
    },
  },
]
