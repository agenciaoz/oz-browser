# Architecture Decision Records

Decisiones arquitectónicas del proyecto, numeradas. Cada cambio que afecta la arquitectura del producto se documenta aquí ANTES de escribir el código.

## Índice

| #    | Título                                                                                  | Estado                        | Fecha      |
| ---- | --------------------------------------------------------------------------------------- | ----------------------------- | ---------- |
| 0001 | [Electron como stack](0001-electron-stack.md)                                           | Aceptado                      | 2026-05-09 |
| 0002 | [Lazy tabs (no renderer hasta click)](0002-lazy-tabs.md)                                | Aceptado                      | 2026-05-09 |
| 0003 | [Default Identity usa defaultSession](0003-default-identity-uses-defaultsession.md)     | Aceptado                      | 2026-05-09 |
| 0004 | [HTTPS preferido sobre SOCKS5](0004-https-over-socks5.md)                               | Aceptado                      | 2026-05-09 |
| 0005 | [Regla 500 LOC máximo por archivo](0005-modular-500-loc-rule.md)                        | Aceptado                      | 2026-05-09 |
| 0006 | [Apple Silicon como target primario](0006-apple-silicon-target.md)                      | Aceptado                      | 2026-05-09 |
| 0007 | [Sync con backend pluggable](0007-sync-pluggable-backend.md)                            | Aceptado                      | 2026-05-09 |
| 0008 | [Account Vault — encryption con scrypt + AES-256-GCM](0008-account-vault-encryption.md) | Propuesto                     | 2026-05-09 |
| 0009 | [Logging exhaustivo en todo componente y flujo](0009-logging-everything.md)             | Aceptado                      | 2026-05-09 |
| 0010 | [Per-identity custom User-Agent](0010-per-identity-user-agent.md)                       | Aceptado                      | 2026-05-09 |
| 0011 | [Modals must hide WebContentsView](0011-modals-hide-content-view.md)                    | Aceptado                      | 2026-05-09 |
| 0012 | [OZ MCP server (automation + validation API)](0012-oz-mcp-server.md)                    | Aceptado (scope expandido v1) | 2026-05-09 |
| 0013 | [CI strategy (GitHub Actions)](0013-ci-strategy.md)                                     | Aceptado                      | 2026-05-09 |
| 0014 | [Linter mínimo + pre-commit hook](0014-lint-precommit.md)                               | Aceptado                      | 2026-05-09 |
| 0015 | [Workspace model + ventana 1-1 lock exclusivo](0015-workspace-model.md)                 | Aceptado                      | 2026-05-09 |
| 0016 | [Tab Context Menu (1.7) — native Menu.popup + handler split](0016-tab-context-menu.md)  | Aceptado                      | 2026-05-10 |

## Cómo agregar un ADR

1. Copia la plantilla de [`../DOCUMENTATION-RULES.md`](../DOCUMENTATION-RULES.md#plantilla-de-adr)
2. Numera secuencial (siguiente disponible: 0017)
3. Estado inicial: "Propuesto"
4. Cuando se acepta y se ejecuta: cambiar a "Aceptado"
5. Si después se reemplaza por otro ADR, marcar "Reemplazado por NNNN"
6. Agregar la fila a este índice
