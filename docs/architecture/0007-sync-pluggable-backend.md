# ADR 0007 — Sync con backend pluggable

**Estado:** Aceptado
**Fecha:** 2026-05-09

## Contexto

Tres casos de uso para sync:

1. **SaaS público** — usuarios random pagan suscripción. Necesita backend nuestro.
2. **Office Edition (Jose)** — empleados de Jose, todos comparten cuenta Dropbox Business. No queremos costo de infra.
3. **Enterprise self-hosted** — clientes que no quieren su data en cloud nuestro.

Un solo backend hardcodeado obliga a uno de los tres a sufrir.

## Decisión

**`sync-client.js` con backends pluggables:** Cloud OZ (Supabase) / Dropbox / S3 self-hosted / Off. El usuario elige en Settings → Sync.

## Alternativas consideradas

- **Solo Supabase:** mejor UX para SaaS, pero obliga a oficina a pagar cuando ya tienen Dropbox.
- **Solo Dropbox:** fricción para usuarios SaaS que no usan Dropbox.
- **Solo self-hosted:** demasiada fricción onboarding.
- **No sync:** rompe el caso de uso "abre cuentas en otra Mac".

## Consecuencias

- ✅ Cada usuario elige según su contexto.
- ✅ E2E encryption client-side: cifrado pasa por backend agnóstico.
- ✅ Office Edition puede arrancar SIN infra propia (Etapa 7-OFFICE).
- ⚠️ Más superficie de testing (4 backends). Mitigación: interfaz `SyncBackend` común; cada implementación es ~150-200 LOC.
- ⚠️ Conflict resolution debe ser igual en todos. Implementación: vector clocks v2 (después de last-write-wins inicial).

## Interfaz `SyncBackend`

```js
interface SyncBackend {
  init(config: BackendConfig): Promise<void>
  push(blob: EncryptedBlob, key: string, version: number): Promise<void>
  pull(key: string): Promise<{ blob: EncryptedBlob, version: number } | null>
  list(prefix: string): Promise<{ key: string, version: number, modified: Date }[]>
  delete(key: string): Promise<void>
}
```

Implementaciones:

- `sync-backend-supabase.js` (Etapa 7)
- `sync-backend-dropbox.js` (Etapa 7-OFFICE)
- `sync-backend-s3.js` (Etapa 10 enterprise)
- `sync-backend-noop.js` (sync off)

## Referencias

- Etapa 7 / Etapa 7-OFFICE / Etapa 7.5 en `../PLAN-MAESTRO.md`
- Doc de feature: `../features/sync.md` (placeholder hasta implementación)
