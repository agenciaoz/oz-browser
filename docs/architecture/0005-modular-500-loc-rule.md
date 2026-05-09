# ADR 0005 — Regla 500 LOC máximo por archivo

**Estado:** Aceptado
**Fecha:** 2026-05-09
**Pedido por:** Jose

## Contexto

Trabajamos con Claude Cowork — Read es eficiente con archivos chicos, requiere offset/limit con archivos grandes. Más allá de Cowork, archivos chicos son más fáciles de razonar para humanos.

## Decisión

**Regla dura: ningún archivo de código > 500 LOC.** Si crece, dividir en submódulos coherentes.

## Alternativas consideradas

- **Sin límite:** main.js llegó a 654 LOC y empezó a ser difícil de leer/mantener.
- **Soft target 1000 LOC:** demasiado tolerante, deja crecer.
- **300 LOC strict:** demasiado agresivo, fuerza fragmentación artificial.

## Consecuencias

- ✅ Read sin offset funciona para todo archivo.
- ✅ Cada módulo tiene una responsabilidad clara.
- ✅ Refactor de main.js (654 → 155) ya validó la práctica: 5 archivos < 250 LOC cada uno, mismo comportamiento.
- ⚠️ Más archivos en el árbol — mitigado con docs/modules/ index.
- ⚠️ Cuando un módulo concept-único debe dividirse, hay que decidir cuál es el split natural. Convención: `<feature>-manager.js` (CRUD) + `<feature>-handlers.js` (IPC) + `<feature>-setup.js` (wiring) + `<feature>-utils.js` (helpers).

## Referencias

- Aplicado en commit `<refactor 654→155>` para main.js
- Aplicado en webui.js (490 → 22 LOC boot + tabstrip.js + sidebar.js + oz-utils.js)
- Detalles en `../DOCUMENTATION-RULES.md`
