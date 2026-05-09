# Guías how-to

| Guía                                        | Para                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- |
| [`dev-setup.md`](dev-setup.md)              | Levantar el proyecto en dev en 5 minutos                            |
| [`manual-test-1.2.md`](manual-test-1.2.md)  | Smoke test manual del Bloque 1.2 (Identity + lazy + UA)             |
| [`mcp-automation.md`](mcp-automation.md) ✨ | OZ MCP server: setup en Claude Code/Cursor, curl, Python, Node, SSE |
| `release-process.md` (Etapa 3)              | Hacer un release firmado + auto-update                              |
| `debugging.md` (pendiente)                  | Tips para debug — logs, DevTools, IPC tracing                       |
| `adding-a-feature.md` (pendiente)           | Workflow para agregar feature nueva siguiendo las reglas            |
| `code-review.md` (cuando team)              | Cómo se hace review                                                 |

✨ = creado en Bloque 1.3-MCP.

## Workflow estándar para cualquier cambio

```
1. ¿Decisión arquitectónica?  → ADR en architecture/
2. ¿Feature nueva?            → docs/features/<nueva>.md
3. ¿Módulo nuevo?             → docs/modules/<nuevo>.md
4. Implementar
5. ¿Cierro bloque?            → docs/history/<bloque>-resultado.md
6. Commit explica el porqué, no solo el qué
7. Push
```

Sin ese orden, el cambio no está terminado.
