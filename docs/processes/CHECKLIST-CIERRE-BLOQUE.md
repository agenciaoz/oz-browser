# Checklist canónica de cierre de bloque

> **Regla:** un bloque NO está cerrado hasta que TODOS los items aplicables están ✓.
> Esta checklist es vinculante. Si un item no aplica al bloque, anotar "N/A — razón" en el doc de history.

## Antes de declarar el bloque hecho

### Código

- [ ] `npm test` corre verde (todos los smoke tests).
- [ ] `npm run check:loc` pasa (ningún archivo > 500 LOC, ADR 0005).
- [ ] `npm run lint` corre limpio (cuando 1.3.6-DX esté listo).
- [ ] No hay `console.log` debug olvidado (excepto en tests).
- [ ] Cada archivo nuevo tiene header con `// Doc: docs/modules/<nombre>.md` (regla 6 de DOC-RULES).
- [ ] Cada IPC handler nuevo loggea entrada (DEBUG) + salida (INFO) + duration (regla ADR 0009).
- [ ] No hay TODO sin owner ni due date — convertir a issue de GitHub o eliminar.

### Docs

- [ ] `docs/modules/<nombre>.md` creado/actualizado para CADA archivo .js nuevo o tocado significativamente.
- [ ] `docs/architecture/NNNN-<titulo>.md` creado para CADA decisión arquitectónica no obvia.
- [ ] `docs/features/<nombre>.md` creado/actualizado si la feature cruza varios módulos.
- [ ] `docs/history/<bloque>-resultado.md` escrito con: qué se entregó, lo que está funcionando, issues resueltos, costos, próximo paso.
- [ ] `CHANGELOG.md` agregada la línea del bloque (1 línea máximo).
- [ ] `BENCHMARKS.md` agregada una fila si hubo medición (post-1.3-MCP).
- [ ] `docs/PLAN-MAESTRO.md` actualizado: bloque marcado ✅, próximo paso revisado, estimaciones ajustadas si overshot/undershot.
- [ ] `docs/OVERVIEW.md` actualizado si cambió el "estado del proyecto".
- [ ] `docs/DEPENDENCIES.md` actualizado si se agregaron deps npm nuevas.

### Tests

- [ ] Smoke test agregado para nuevas primitivas (CRUD, persistencia, edge cases).
- [ ] Smoke test mock-Electron cuando aplica (no requiere GUI).
- [ ] Smoke test visual ejecutado por Claude vía MCP (post-1.3-MCP) o computer-use (mientras tanto).
- [ ] Manual test guide actualizada en `docs/guides/manual-test-<bloque>.md` si la GUI cambió.

### Validación end-to-end

- [ ] `npm start` arranca limpio en M2 (Mac de Jose) sin errores en console.
- [ ] La feature nueva funciona end-to-end con datos reales (no solo mock).
- [ ] La persistencia round-trip (crear → restart → leer) confirmada.
- [ ] No hay regresiones obvias en features previas (sidebar, tabs, identidades).

### Memoria del proyecto (para Claude)

- [ ] `~/.../memory/project_ghost_browser_clone.md` actualizado con:
  - Estado del bloque (✅ closed)
  - Decisiones nuevas no obvias
  - Próximo paso concreto
  - Hechos técnicos confirmados nuevos (no re-investigar)

### Repo

- [ ] Commit messages siguen `docs/processes/commit-style.md` (porqué + qué).
- [ ] Branch mergeada a main (cuando haya CI corriendo, esperar verde).
- [ ] Tag `block-1.X-closed` (opcional, útil para rollback).

---

## Aplicabilidad por tipo de bloque

| Tipo                          | Code                  | Docs                  | Tests            | E2E    | Memoria | Repo |
| ----------------------------- | --------------------- | --------------------- | ---------------- | ------ | ------- | ---- |
| Feature nueva                 | ✅ todos              | ✅ todos              | ✅ todos         | ✅     | ✅      | ✅   |
| Refactor sin cambio funcional | ✅ todos              | módulos + ADR         | smoke regression | ✅     | resumen | ✅   |
| Tooling (CI, lint, scripts)   | scripts + paquetes    | DOC-RULES + processes | mínimo (sanity)  | manual | mention | ✅   |
| Solo docs                     | N/A                   | ✅ all                | N/A              | N/A    | mention | ✅   |
| Bug fix                       | fix + regression test | módulo del archivo    | regression       | ✅     | mention | ✅   |

---

## Para qué existe esta checklist

Antes de tener esto, en el cierre del 1.2 nos dimos cuenta tarde de:

- Que el bug de `safe` clash se podía haber atrapado con un eslint pre-commit (no había lint).
- Que el modal cubierto por WebContentsView se podía haber atrapado con un smoke test visual (lo agregamos al final).
- Que faltaban docs de `ui-webui.js` y `ui-oz-utils.js`.

Esta checklist hace explícito lo que era "ojalá nos acordemos". Todo item aquí es un caso real que ya nos pasó al menos una vez.

---

## Cómo correr esta checklist

Antes del último commit del bloque:

```bash
# Desde oz-browser/
npm test                 # smoke tests
npm run check:loc        # ADR 0005
npm run lint             # post-1.3.6-DX
ls docs/history/<bloque>-resultado.md  # debe existir
grep "<bloque>" CHANGELOG.md           # debe existir
```

Si algo falla, **se arregla antes del cierre, no después**.
