# Architecture Decision Records

Decisiones arquitectónicas del proyecto, numeradas. Cada cambio que afecta la arquitectura del producto se documenta aquí ANTES de escribir el código.

## Índice

| #    | Título                                                                                                          | Estado                        | Fecha      |
| ---- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------- |
| 0001 | [Electron como stack](0001-electron-stack.md)                                                                   | Aceptado                      | 2026-05-09 |
| 0002 | [Lazy tabs (no renderer hasta click)](0002-lazy-tabs.md)                                                        | Aceptado                      | 2026-05-09 |
| 0003 | [Default Identity usa defaultSession](0003-default-identity-uses-defaultsession.md)                             | Aceptado                      | 2026-05-09 |
| 0004 | [HTTPS preferido sobre SOCKS5](0004-https-over-socks5.md)                                                       | Aceptado                      | 2026-05-09 |
| 0005 | [Regla 500 LOC máximo por archivo](0005-modular-500-loc-rule.md)                                                | Aceptado                      | 2026-05-09 |
| 0006 | [Apple Silicon como target primario](0006-apple-silicon-target.md)                                              | Aceptado                      | 2026-05-09 |
| 0007 | [Sync con backend pluggable](0007-sync-pluggable-backend.md)                                                    | Aceptado                      | 2026-05-09 |
| 0008 | [Account Vault — encryption con scrypt + AES-256-GCM](0008-account-vault-encryption.md)                         | Propuesto                     | 2026-05-09 |
| 0009 | [Logging exhaustivo en todo componente y flujo](0009-logging-everything.md)                                     | Aceptado                      | 2026-05-09 |
| 0010 | [Per-identity custom User-Agent](0010-per-identity-user-agent.md)                                               | Aceptado                      | 2026-05-09 |
| 0011 | [Modals must hide WebContentsView](0011-modals-hide-content-view.md)                                            | Aceptado                      | 2026-05-09 |
| 0012 | [OZ MCP server (automation + validation API)](0012-oz-mcp-server.md)                                            | Aceptado (scope expandido v1) | 2026-05-09 |
| 0013 | [CI strategy (GitHub Actions)](0013-ci-strategy.md)                                                             | Aceptado                      | 2026-05-09 |
| 0014 | [Linter mínimo + pre-commit hook](0014-lint-precommit.md)                                                       | Aceptado                      | 2026-05-09 |
| 0015 | [Workspace model + ventana 1-1 lock exclusivo](0015-workspace-model.md)                                         | Aceptado                      | 2026-05-09 |
| 0016 | [Tab Context Menu (1.7) — native Menu.popup + handler split](0016-tab-context-menu.md)                          | Aceptado                      | 2026-05-10 |
| 0017 | [Proxy model + assignment hierarchy + auto-disable (1.8)](0017-proxy-model.md)                                  | Aceptado                      | 2026-05-10 |
| 0018 | [FingerprintEngine "Ghost+" (1.9) — 11 vectores + GeoIP coherence](0018-fingerprint-engine.md)                  | Aceptado                      | 2026-05-10 |
| 0019 | [Settings + Browsing Data + Tab Discard (1.10) — cierre Sub-Etapa 1A CORE](0019-settings-browsing-data-perf.md) | Aceptado                      | 2026-05-10 |
| 0020 | [Packaging strategy (Etapa 3a — macOS unsigned)](0020-packaging-strategy.md)                                    | Aceptado                      | 2026-05-10 |
| 0021 | [Auto-update strategy (Etapa 3d)](0021-auto-update-strategy.md)                                                 | Aceptado                      | 2026-05-10 |
| 0023 | [Identity-per-workspace hierarchy + migración](0023-identity-workspace-hierarchy.md)                            | Aceptado                      | 2026-05-10 |
| 0024 | [Crash recovery (E2-C-2)](0024-crash-recovery.md)                                                               | Aceptado                      | 2026-05-10 |
| 0025 | [Cloud backup architecture (Dropbox, D-1)](0025-cloud-backup.md)                                                | Aceptado                      | 2026-05-10 |
| 0026 | [Sync engine (D-2)](0026-sync-engine.md)                                                                        | Implementado                  | 2026-05-10 |
| 0027 | [Team mode + key-sharing Curve25519 (E)](0027-team-mode.md)                                                     | Propuesto                     | 2026-05-11 |
| 0028 | [TOTP generation from scratch (no external dep)](0028-totp-from-scratch.md)                                     | Aceptado (J-3 / v1.3.0)       | 2026-05-15 |
| 0029 | [Session warmer: HTTP-only, no BrowserWindows](0029-session-warmer-http-only.md)                                | Aceptado (K1 / v1.4.1)        | 2026-05-15 |
| 0030 | [Bulk Runner (v2 sub-bloque 1)](0030-bulk-runner.md)                                                            | Aceptado                      | 2026-05-21 |
| 0030 | [Diagnostic export: hard sanitization rules](0030-diagnostic-export-sanitization.md) ⚠️ número duplicado        | Aceptado (H-2 / v1.1.6)       | 2026-05-15 |
| 0031 | [Scheduled Bulk Runs (v2 Etapa 2.1)](0031-scheduled-bulk-runs.md)                                               | Aceptado                      | 2026-05-22 |
| 0032 | [Bulk Run History Dashboard](0032-bulk-history-dashboard.md)                                                    | Aceptado (alpha.24–28)        | 2026-05-25 |
| 0033 | [Bulk Run Native OS Notifications](0033-bulk-notifications.md)                                                  | Aceptado (alpha.27)           | 2026-05-25 |
| 0034 | [Sticky-sessid auto-rotation per identity](0034-sticky-sessid-rotation.md)                                      | Aceptado (alpha.30)           | 2026-05-27 |
| 0035 | [Default Identity global (paridad Ghost)](0035-default-identity-global.md)                                      | Aceptado                      | 2026-06-17 |
| 0036 | [Page-control layer (v3-A scraping/agent-control)](0036-page-control-layer.md)                                  | Aceptado (primer slice)       | 2026-06-17 |
| 0037 | [Activation gate (pre-SaaS test builds)](0037-activation-gate.md)                                               | Aceptado                      | 2026-06-18 |
| 0038 | [Publishing Studio (módulo de publicaciones multi-red)](0038-publishing-studio.md)                              | Aceptado                      | 2026-06-19 |
| 0039 | [Fail-closed proxy enforcement (blackhole en vez de direct://)](0039-fail-closed-proxy-enforcement.md)          | Aceptado                      | 2026-07-14 |

> Notas: **0022 no existe** (gap en la numeración) y **0030 está duplicado** (dos ADRs distintos con el mismo número). Se dejan como están para no romper links; no reutilizar.

## Cómo agregar un ADR

1. Copia la plantilla de [`../DOCUMENTATION-RULES.md`](../DOCUMENTATION-RULES.md#plantilla-de-adr)
2. Numera secuencial (siguiente disponible: 0040)
3. Estado inicial: "Propuesto"
4. Cuando se acepta y se ejecuta: cambiar a "Aceptado"
5. Si después se reemplaza por otro ADR, marcar "Reemplazado por NNNN"
6. Agregar la fila a este índice
