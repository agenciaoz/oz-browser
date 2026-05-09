# ADR 0002 — Lazy tabs (no renderer process hasta click)

**Estado:** Aceptado
**Fecha:** 2026-05-09
**Pedido por:** Jose

## Contexto

Ghost Browser tiene cap implícito de 25 Temporary Identities por workspace. Nuestro caso de uso primario es 50+ cuentas de redes sociales en un workspace. En MacBook Air M1 8 GB (target oficina), 50 tabs con renderer process cada uno = ~3-4 GB solo en procesos vacíos. Imposible.

## Decisión

**Tab class tiene 2 estados: lazy y materialized.** Al crearse, un Tab es un stub JS de ~1 KB. El `WebContentsView` y el renderer process se crean **solo en primer click**. ID estable (UUID) independiente del `webContents.id`.

## Alternativas consideradas

- **Materializar siempre:** simple pero rompe el target M1 Air 8 GB.
- **Materializar con `about:blank`:** WebContentsView vacío todavía cuesta 30-40 MB. 50 tabs ≈ 1.5 GB extra.
- **Tab discarding pasivo (chrome's "memory saver"):** materializa todo, después libera idle. Complejo y ya hay un renderer process por tab inicialmente. No resuelve startup.

## Consecuencias

- ✅ 100 tabs lazy ≈ 100 KB JS en memoria (negligible).
- ✅ Startup rápido (cold start < 2s en M1 Air).
- ✅ Permite import de Excel con 100+ accounts sin abrir 100 procesos.
- ⚠️ Chrome `tabs.*` API solo ve tabs materialized — extensions no pueden iterar tabs lazy. Aceptable: las extensions son útiles en la tab activa.
- ⚠️ Title/favicon de tabs lazy son los que nosotros guardamos (default "New Tab"); no se actualizan hasta materialize.
- ⚠️ Primera materialización tarda lo que tarda la página de cargar — UI debe mostrar loading state.

## Referencias

- Implementado en `browser/tabs.js`
- Doc del módulo: `../modules/tabs.md`
- Benchmark target: `../OVERVIEW.md` § hardware
