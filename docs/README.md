# OZ Browser — Documentación interna

> Bienvenido. Esta es la fuente única de verdad del proyecto. Si trabajas aquí, lee primero esto.

## Empieza por aquí (lectura recomendada en orden)

1. **[OVERVIEW.md](OVERVIEW.md)** — TL;DR de 2 minutos. Qué es el producto, hardware target, estado, próximo paso.
2. **[PLAN-MAESTRO.md](PLAN-MAESTRO.md)** — plan completo en etapas y bloques.
3. **[DEPENDENCIES.md](DEPENDENCIES.md)** — diagrama mermaid de dependencias entre bloques + reglas transversales.
4. **[DOCUMENTATION-RULES.md](DOCUMENTATION-RULES.md)** — cómo se documenta el proyecto (regla viva: si no está documentado, no está hecho).

## Estructura

| Carpeta                                   | Para qué                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| [`architecture/`](architecture/README.md) | Architecture Decision Records (ADRs). Cada decisión grande tiene su número y su razón. |
| [`modules/`](modules/README.md)           | Un `.md` por archivo de código en `browser/`. Qué hace, qué exporta, IPC, gotchas.     |
| [`features/`](features/README.md)         | Features transversales (Identity, Workspace, Vault, Time Machine, etc.) end-to-end.    |
| [`guides/`](guides/README.md)             | How-to: levantar dev, hacer release, debug, agregar feature.                           |
| [`processes/`](processes/)                | Procesos de equipo: commit style, code review.                                         |
| [`history/`](history/)                    | Bitácora por bloque/etapa cerrado.                                                     |

## Reglas duras (no negociables)

- **Ningún archivo de código > 500 LOC** — si crece, divides.
- **Toda decisión arquitectónica tiene un ADR** en `architecture/`.
- **Todo módulo `.js` tiene su `.md` hermano** en `modules/`.
- **Todo bloque cerrado deja un `.md` en `history/`** con qué se entregó.
- **Headers consistentes en cada `.js`** (link al doc, exports, IPC).
- **Commits explican el porqué**, no solo el qué.

Detalles en [DOCUMENTATION-RULES.md](DOCUMENTATION-RULES.md).

## Para agregar una feature nueva

1. Lee la guía: [`guides/adding-a-feature.md`](guides/adding-a-feature.md)
2. Si requiere decisión arquitectónica → ADR primero en `architecture/`
3. Crea `modules/<nuevo>.md` antes de escribir código
4. Crea `features/<feature>.md` con caso de uso + UI + datos
5. Implementa
6. Cierra con `history/<bloque>-resultado.md`
