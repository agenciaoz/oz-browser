# OZ Browser — Reglas de documentación

> **La documentación es código de primera clase.** No es opcional, no se hace al final, no se "deja para después". Si un cambio no está documentado, el cambio no está terminado.

Estas reglas son obligatorias para todo el proyecto.

---

## Las 7 reglas

### 1. Toda decisión arquitectónica tiene un ADR

Si tomamos una decisión que afecta cómo funciona el sistema (qué stack, qué patrón, qué library, qué trade-off), creamos un Architecture Decision Record (ADR) numerado en `docs/architecture/NNNN-titulo.md`. Formato corto: contexto, decisión, alternativas consideradas, consecuencias.

### 2. Todo módulo de código tiene un .md hermano

Cada archivo `browser/X.js` o `browser/ui/X.js` tiene su par en `docs/modules/X.md` con: qué hace, qué exporta, IPC channels que registra, dependencias, ejemplos de uso, gotchas conocidos. El archivo de código tiene un header con un link al .md.

### 3. Toda feature transversal tiene un doc en features/

Una feature que cruza múltiples módulos (Identity, Workspace, Vault, Time Machine) tiene un `.md` en `docs/features/X.md` que describe la feature end-to-end: caso de uso, UI, modelo de datos, IPC, persistence, security, performance.

### 4. Cada Bloque/Etapa que se cierra deja un resultado en history/

Al cerrar un bloque, escribir `docs/history/<etapa-bloque>-resultado.md` con: qué se entregó, qué quedó funcionando, issues resueltos, costos, próximo paso.

### 5. Ningún archivo de código > 500 LOC

Si un módulo crece más de eso, dividir en submódulos. La excusa "es un módulo conceptualmente unitario" no aplica — se divide igual, en submódulos coherentes. Esto facilita Read sin offset y comprensión rápida con Cowork.

### 6. Headers consistentes en cada archivo .js

Todo módulo de código empieza con un comment header así:

```js
// OZ Browser — <nombre del módulo>
//
// Qué hace: <una frase>
// Doc: docs/modules/<nombre>.md
//
// Exports: <list>
// IPC: <list o "none">
```

### 7. Commits explican el porqué, no solo el qué

El subject line dice qué cambió. El body explica por qué fue necesario y qué considera. Si la decisión es no obvia, anotar las alternativas.

---

## Estructura de la documentación

```
docs/
├─ README.md                # índice maestro
├─ OVERVIEW.md              # TL;DR de 2 min
├─ PLAN-MAESTRO.md          # plan de etapas y bloques
├─ DEPENDENCIES.md          # diagrama mermaid + reglas transversales
├─ DOCUMENTATION-RULES.md   # ← este doc
│
├─ architecture/            # ADRs (Architecture Decision Records)
│   ├─ README.md            # índice de ADRs
│   ├─ 0001-electron-stack.md
│   ├─ 0002-lazy-tabs.md
│   ├─ 0003-default-identity-uses-defaultsession.md
│   ├─ 0004-https-over-socks5.md
│   ├─ 0005-modular-500-loc-rule.md
│   ├─ 0006-apple-silicon-target.md
│   ├─ 0007-sync-pluggable-backend.md
│   └─ ...
│
├─ modules/                 # un .md por archivo de código
│   ├─ README.md            # índice de módulos
│   ├─ logger.md
│   ├─ error-handler.md
│   ├─ identity-manager.md
│   ├─ tabs.md
│   ├─ window-manager.md
│   ├─ ipc-handlers.md
│   ├─ extensions-setup.md
│   ├─ paths.md
│   ├─ menu.md
│   ├─ ui-oz-utils.md
│   ├─ ui-tabstrip.md
│   ├─ ui-sidebar.md
│   ├─ ui-webui.md
│   └─ preload.md
│
├─ features/                # 1 .md por feature transversal
│   ├─ README.md            # índice de features
│   ├─ identities.md
│   ├─ workspaces.md
│   ├─ proxies.md
│   ├─ account-vault.md
│   ├─ excel-io.md
│   ├─ time-machine.md
│   ├─ fingerprint-engine.md
│   ├─ tab-context-menu.md
│   ├─ extensions-multi-identity.md
│   ├─ activity-tracking.md
│   ├─ admin-dashboard.md
│   └─ apple-silicon-perf.md
│
├─ guides/                  # how-to guides
│   ├─ README.md
│   ├─ dev-setup.md
│   ├─ release-process.md
│   ├─ debugging.md
│   └─ adding-a-feature.md
│
├─ processes/               # procesos de equipo
│   ├─ commit-style.md
│   └─ code-review.md
│
└─ history/                 # bitácora por bloque/etapa
    ├─ 05-etapa-0-resultado.md
    ├─ 06-bloque-1.1-resultado.md
    └─ ...
```

---

## Plantilla de ADR (`docs/architecture/NNNN-titulo.md`)

```markdown
# ADR NNNN — <Título corto>

**Estado:** Propuesto / Aceptado / Reemplazado por NNNN / Deprecado
**Fecha:** YYYY-MM-DD
**Autor:** Jose / Claude

## Contexto

Por qué estamos tomando una decisión, qué problema queremos resolver,
qué constraints hay.

## Decisión

Lo que decidimos hacer.

## Alternativas consideradas

- Opción A: pros / cons
- Opción B: pros / cons
- Opción C: pros / cons

## Consecuencias

- Lo que mejora con esta decisión
- Lo que empeora
- Lo que queda como deuda técnica
- Cómo se mitiga

## Referencias

Links a issues, PRs, conversaciones que llevaron aquí.
```

---

## Plantilla de doc de módulo (`docs/modules/<nombre>.md`)

````markdown
# Módulo `<nombre>`

**Path:** `browser/<nombre>.js` (o `browser/ui/<nombre>.js`)
**Líneas:** <count>
**Bloque/Etapa:** <ref>

## Qué hace

Una a tres frases.

## Exports

| Símbolo | Tipo     | Descripción |
| ------- | -------- | ----------- |
| `Foo`   | class    | …           |
| `bar`   | function | …           |

## Dependencias

Qué requiere de Electron / npm / otros módulos del proyecto.

## IPC channels que registra (si aplica)

| Channel | Args | Returns | Descripción |
| ------- | ---- | ------- | ----------- |

## Eventos que emite (si aplica)

| Evento | Payload | Disparado cuando |
| ------ | ------- | ---------------- |

## Ejemplos de uso

```js
// código
```
````

## Gotchas / decisiones no obvias

- …
- …

## Referencias

Links a ADRs relacionados, otros módulos.

````

---

## Plantilla de doc de feature (`docs/features/<nombre>.md`)

```markdown
# Feature: <nombre>

**Bloque:** <ref>
**Estado:** ✅ implementada / 🚧 en progreso / ⏳ pendiente

## Caso de uso
Qué problema resuelve para el usuario, ejemplo concreto.

## UI
Cómo el usuario interactúa con esto. Screenshots o ASCII art si aplica.

## Modelo de datos
```js
{ /* schema */ }
````

## Persistence

Dónde se guarda, formato, encryption.

## IPC

Qué channels se exponen al renderer.

## Performance / Apple Silicon

Implicaciones específicas para M1/M2 8 GB.

## Security

Qué precauciones de seguridad aplican.

## Tests

Qué se testea, dónde están los tests.

## Módulos involucrados

Lista de archivos en `browser/` que implementan esto.

```

---

## Cómo aplicarlo

- Cuando agregues un módulo nuevo, **crea su `.md` ANTES de escribir código** (mejor: stub con qué va a hacer + plantilla rellena conforme construyes).
- Cuando tomes una decisión arquitectónica, **escribe el ADR PRIMERO** y luego ejecutas. El ADR previene re-debate al mes siguiente.
- Cuando cierres un bloque, **el último commit del bloque incluye el `docs/history/<bloque>-resultado.md`**. Sin eso, el bloque no está cerrado.

Ningún PR/commit sin documentación pasa review (cuando estemos en team).
```
