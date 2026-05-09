# ADR 0006 — Apple Silicon como target primario

**Estado:** Aceptado
**Fecha:** 2026-05-09
**Pedido por:** Jose

## Contexto

Jose tiene varias MacBook Air M1 8 GB en su oficina. Los empleados van a usar OZ Browser para gestión de cuentas de redes sociales. Si OZ Browser no corre fluido en M1 Air 8 GB, no sirve.

## Decisión

**Plataforma target primaria: macOS Apple Silicon (M1 / M2 / M3 / M4).** Build = universal binary (arm64 + x86_64) pero arm64 es nativo y prioritario.

## Alternativas consideradas

- **Solo arm64:** rompe Macs Intel todavía en uso (~10% mercado mac 2026).
- **Solo Intel:** Rosetta-mediated en Apple Silicon — ~30% peor performance, gasta más batería. Inaceptable.
- **Build separado por arch:** doble pipeline, doble download, mala UX.

## Consecuencias

- ✅ `electron-builder` con `mac.target = 'universal'` produce un solo `.dmg` que sirve nativamente ambas arch.
- ✅ Apple Silicon obtiene Metal renderer + VideoToolbox HW video decode automáticos.
- ⚠️ Todo C++ addon debe soportar arm64. Lista verificada: `keytar` ✅, `sqlite3` ✅, `sharp` ✅. Si encontramos alguno que no, lo cambiamos.
- ⚠️ Tamaño DMG ~2x (slices x86_64 + arm64). Aceptable.

### Benchmarks objetivo (gates de release)

| Mac (RAM) | Lazy tabs | Materialized concurrentes | RAM total |
|---|---|---|---|
| MacBook Air M1 8 GB | 100 | 10 | < 4 GB |
| MacBook Pro M1/M2 16 GB | 200 | 30 | < 8 GB |
| MacBook Pro M2/M3 32 GB+ | 500 | 100 | < 16 GB |

- Cold start < 2 s en M1 Air
- Crear identity nueva < 100 ms
- Switch tab materialized < 50 ms
- Materialize lazy < 800 ms

### Optimizaciones derivadas

- **Tab discarding** (Bloque 1.10): tabs materialized idle > 30 min vuelven a lazy.
- **Memory pressure handler:** auto-discard cuando RAM > 80%.
- **Performance modes** (Light/Balanced/Power): auto-detect según RAM.
- **Cache eviction caps** por partition.
- **SQLite WAL mode**, lazy partition init, **zstd** compression para snapshots.
- **Battery-aware throttling**: health checks y background tasks reducen frecuencia con battery.

## Referencias

- Detalles en `../OVERVIEW.md` § hardware target
- Detalles en `../PLAN-MAESTRO.md` § 0.5
- Bloque que implementa el perf pass: `1.10` (ver `../PLAN-MAESTRO.md`)
