# Features de OZ Browser

Un `.md` por feature transversal del producto. Cada doc cubre la feature end-to-end: caso de uso, UI, datos, IPC, persistence, security, performance.

## Implementadas

| Feature                          | Bloque | Doc                                        |
| -------------------------------- | ------ | ------------------------------------------ |
| [Logging exhaustivo](logging.md) | 1.2    | base ✅, UI in-app pendiente (1.7)         |
| Identities con cookie isolation  | 1.2    | identities.md (placeholder, doc pendiente) |
| Lazy tabs                        | 1.2    | parte de identities.md                     |
| Top tabstrip + Sidebar           | 1.2    | parte de identities.md                     |
| Error popup con email            | 1.2    | parte de logging.md                        |

## Pendientes (placeholders)

| Feature                        | Bloque     | Doc                   |
| ------------------------------ | ---------- | --------------------- |
| Identities (full)              | 1.2 cierre | identities.md         |
| Workspaces                     | 1.3        | workspaces.md         |
| Proxies                        | 1.4        | proxies.md            |
| ⭐ Account Vault               | 1.5        | account-vault.md      |
| ⭐ Excel I/O                   | 1.5        | excel-io.md           |
| Site templates                 | 1.5        | site-templates.md     |
| Anti-logout                    | 1.5        | anti-logout.md        |
| Time Machine                   | 1.6        | time-machine.md       |
| Tab Context Menu               | 1.7        | tab-context-menu.md   |
| FingerprintEngine              | 1.8        | fingerprint-engine.md |
| Settings UI                    | 1.9        | settings.md           |
| Multi-extension all-identities | 1.10       | extensions.md         |
| Apple Silicon performance      | 1.10       | apple-silicon-perf.md |
| Auto-update                    | E3         | auto-update.md        |
| Auth + entitlements            | E4         | auth.md               |
| Billing                        | E5         | billing.md            |
| Cloud Sync E2E                 | E7         | sync.md               |
| Office Edition (Dropbox)       | E7-OFFICE  | office-edition.md     |
| Activity Tracking              | E7.5       | activity-tracking.md  |
| Admin Dashboard                | E7.5       | admin-dashboard.md    |

## Cómo agregar una feature nueva

Ver [`../guides/adding-a-feature.md`](../guides/adding-a-feature.md):

1. ADR si aplica → `architecture/`
2. `features/<nueva>.md` con plantilla → ANTES de código
3. `modules/<nuevo>.md` por cada `.js` que crees
4. Implementar
5. `history/<bloque>-resultado.md` al cerrar
