# Code review checklist (futuro equipo)

> Cuando contrate un dev, esta es la checklist que aplica al revisar un PR. Para Claude+Jose es informativa hoy; vinculante cuando haya equipo.

## Aprobar PR solo si TODOS estos están ✓

### Funcional

- [ ] La descripción del PR explica el **por qué** (no solo el qué).
- [ ] El cambio resuelve lo que dice resolver. Probado localmente o en CI.
- [ ] No introduce regresiones obvias en features previas.

### Estilo / convenciones

- [ ] CI verde (lint, smoke tests, check:loc).
- [ ] Cada archivo .js nuevo tiene header `// OZ Browser — <nombre>` con link al .md hermano.
- [ ] Ningún archivo > 500 LOC (validado por `check:loc`, pero revisar visualmente si está cerca).
- [ ] Naming consistente (camelCase JS, kebab-case files, prefijo `oz:` en IPC channels).

### Logging

- [ ] Cada IPC handler nuevo loggea (regla ADR 0009).
- [ ] No hay `console.log` debug olvidado.
- [ ] Logs no contienen secretos / passwords / cookies.

### Docs

- [ ] `docs/modules/<nombre>.md` creado o actualizado para cada archivo tocado.
- [ ] Si la decisión es arquitectónica, ADR creado (`docs/architecture/NNNN-...md`).
- [ ] CHANGELOG.md agregada la línea (si cierra bloque).

### Seguridad

- [ ] Sin secretos commited (verificar con `git diff --staged`).
- [ ] IPC handlers validan inputs antes de usar.
- [ ] MCP tools nuevas declaran auth requirements (vault sí, identities.list no).

### Performance

- [ ] No introduce loops sin paginación sobre listas potencialmente grandes (50+ identities).
- [ ] No bloquea el main thread > 100ms.
- [ ] No agrega event listeners sin `removeListener` correspondiente al destroy.

---

## Comentarios al revisar

- **Tono:** constructivo, sugerencias específicas. "Considerá X porque Y" en vez de "esto está mal".
- **Severidad:** marcar `nit` (cosmético, opcional), `q` (pregunta), `must` (bloqueante).
- **PRs grandes (>500 LOC tocadas):** pedir split en commits atómicos antes de revisar profundo.

## Ejemplos de comentarios buenos

> `must` Este IPC handler no loggea (rompe ADR 0009). Agregá `log.info('tabs', 'select', { tabId })` arriba del switch.

> `nit` `safe(name)` se llama 3 veces en este block — extraerlo a una const al principio para legibilidad.

> `q` ¿Por qué no usar `IdentityManager.update` en vez de `rename` aquí? El nuevo update es genérico y deprecaría rename.

## Ejemplos de comentarios a evitar

> "Esto no me gusta." → no es accionable.

> "Tendrías que reescribir todo este archivo." → bloquea sin guía. Mejor: abrir un issue separado de tech-debt y aprobar este PR si el alcance es otro.

> "ESLint no marcó esto pero…" → si no rompe regla, no es objeción de review. Proponer regla nueva en ADR si querés que aplique a futuro.
