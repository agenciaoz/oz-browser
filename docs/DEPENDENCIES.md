# OZ Browser — Diagrama de dependencias entre bloques

```mermaid
graph TD
    E0[Etapa 0 ✅<br/>Spike validación] --> B11[Bloque 1.1 ✅<br/>Foundation]
    B11 --> B12[Bloque 1.2 🚧<br/>Identity Manager<br/>Lazy Tabs · Logger]

    B12 --> B13[Bloque 1.3<br/>Workspace Manager]
    B12 --> B14[Bloque 1.4<br/>Proxy Manager]

    B13 --> B15
    B14 --> B15
    B15[⭐ Bloque 1.5 CORE<br/>Account Vault · Auto-fill<br/>Excel I/O · Anti-logout]

    B15 --> B16[Bloque 1.6<br/>Time Machine + Backup]
    B12 --> B17[Bloque 1.7<br/>Tab context menu]

    B15 --> B18[Bloque 1.8<br/>FingerprintEngine Ghost+]
    B14 --> B18

    B16 --> B19[Bloque 1.9<br/>Settings UI<br/>Bookmarks/Downloads/History]
    B17 --> B19
    B18 --> B19

    B19 --> B110[Bloque 1.10<br/>Polish · Extensions all identities<br/>M-series perf optimizations]

    B110 --> E2[Etapa 2<br/>UX competitiva]
    E2 --> E3[Etapa 3<br/>Sign + auto-update<br/>$99 Apple Dev]

    E3 --> E4[Etapa 4<br/>Backend Supabase<br/>auth + entitlements]
    E4 --> E5[Etapa 5<br/>Stripe billing<br/>self-service cancel]
    E5 --> E6[Etapa 6<br/>Marketing site<br/>Vercel + dominio $12]

    E4 --> E7[Etapa 7<br/>Cloud Sync E2E<br/>Supabase backend]
    E4 --> E7O[Etapa 7-OFFICE<br/>Dropbox sync backend<br/>para tu oficina]
    E7O --> E75[Etapa 7.5<br/>Admin Dashboard<br/>bandwidth/tiempo/accounts]

    E6 --> E8[Etapa 8<br/>Windows + Linux<br/>$50-150 cert Win]

    E8 --> E9[Etapa 9 🔮<br/>Antidetect top-tier<br/>fork Chromium · solo si MRR>$5K]
    E8 --> E10[Etapa 10 🔮<br/>Team Enterprise<br/>RBAC · SSO]

    classDef done fill:#22c55e,stroke:#16a34a,color:#fff;
    classDef wip fill:#f59e0b,stroke:#d97706,color:#fff;
    classDef todo fill:#6b7280,stroke:#4b5563,color:#fff;
    classDef core fill:#a855f7,stroke:#7e22ce,color:#fff;
    classDef future fill:#1e293b,stroke:#0f172a,color:#94a3b8;

    class E0,B11 done;
    class B12 wip;
    class B13,B14,B16,B17,B18,B19,B110,E2,E3,E4,E5,E6,E7,E7O,E75,E8 todo;
    class B15 core;
    class E9,E10 future;
```

---

## Path crítico (cómo llegar a "vendible")

```
1.2 cierre  →  1.3  →  1.4  →  1.5 ⭐  →  1.6  →  1.7
                                  ↓
                      1.8 (puede ir en paralelo)
                                  ↓
                  1.9  →  1.10  →  Etapa 2  →  Etapa 3
                                                ↓
                                    Etapa 4  →  5  →  6  =  PRODUCTO VENDIBLE
```

---

## Reglas transversales (aplican a TODOS los bloques)

Estas decisiones afectan cada módulo del proyecto y NO tienen que repetirse en cada bloque:

### Performance (Apple Silicon)
- Universal binary arm64 nativo. Sin Rosetta. Sin C++ addons que no soporten arm64.
- Tab discarding daemon respeta los límites del Performance mode.
- Memory pressure handler activo en todos los modos.
- Cache caps por partition (50 MB Light, 100 MB Balanced, 200 MB Power).
- Disk I/O: SQLite WAL mode, lazy partition init, compresión zstd para snapshots.

### Logging
- Cada operación crítica loggea via `logger.js` (DEBUG/INFO/WARN/ERROR).
- Errores no manejados → `error-handler.js` popup con email a Jose.
- Activity tracker registra eventos comerciales (bandwidth, time, accounts).

### Persistencia
- Datos sensibles (vault) → AES-256-GCM, master key en macOS Keychain.
- Datos no sensibles (identities, workspaces, proxies) → JSON plano en `data/`.
- Snapshots automáticos antes de operaciones destructivas.

### Sync (cuando exista)
- Backend pluggable: Cloud OZ (Supabase) / Dropbox / S3 self-hosted / Off.
- Cliente cifra antes de subir. Backend solo ve blobs.
- Conflict resolution last-write-wins → vector clocks v2.

### UX
- Todo IPC pasa por `window.oz.*` (preload bridge). Renderer NUNCA llama a Node directo.
- Renderer errors se reportan via `oz.log.reportError(...)` al main.
- Todo en español para Jose / oficina; inglés para SaaS público (i18n en Etapa 6).

### Seguridad
- Master password nunca toca disco en plaintext.
- Tokens (Stripe, Supabase, Dropbox) en env vars o macOS Keychain.
- Logs nunca contienen passwords/tokens (filter automático).
- Updates firmados (Etapa 3 onwards).

### Modularidad
- Cada bloque entrega un módulo `browser/X-manager.js` autocontenido.
- IPC channels namespaceados: `oz:identities:*`, `oz:proxies:*`, `oz:vault:*`, etc.
- Tests por módulo (cuando lleguemos a Etapa 1B).
