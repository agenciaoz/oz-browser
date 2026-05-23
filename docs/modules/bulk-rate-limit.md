# Bulk Rate-limit Registry

Módulo: `browser/bulk-rate-limit.js` (Etapa 2 — v2 sub-bloque 6 + MCP en Etapa 2.2)

## Por qué existe

Las plataformas (IG, X, FB, TikTok) tienen umbrales no-publicados de "esto es un bot, soft-ban". Si una identity hace 500 likes en 1 hora, IG la bloquea durante horas o días. El problema: el bulk runner ejecuta sin saber cuánto ya hizo cada identity, así que sin un freno, dos `oz.bulk.run` consecutivos (por error o por scheduling) podrían superar el cap diario en minutos.

El registry trackea **per-identity per-platform per-action per-day** un contador, persiste a disco, y permite al runner consultar antes de cada item.

## API

```js
const { BulkRateLimit } = require('./bulk-rate-limit')

const reg = new BulkRateLimit({
  userDataDir: app.getPath('userData'), // required
  clock,                                 // optional, test seam
  caps,                                  // optional override map
})

reg.getCap(platform, actionId)        // → number (Infinity if no cap)
reg.getCount(identityId, platform, actionId) // → number (today)
reg.wouldExceed(identityId, platform, actionId) // → boolean
reg.increment(identityId, platform, actionId)   // → newCount, persists
reg.purgeOldEntries(daysOld = 30)               // → entries removed
reg.stats(identityId?)                          // → { [key]: {…} }
```

## Default caps

Conservadores — reflejan umbrales típicos antes de soft-ban observados en la práctica (no son cifras oficiales de las plataformas).

| Plataforma          | Action             | Cap diario        |
| ------------------- | ------------------ | ----------------- |
| instagram.com       | `ig_like`          | 200               |
| instagram.com       | `ig_follow`        | 150               |
| instagram.com       | `ig_comment`       | 50                |
| instagram.com       | `ig_post`          | 10                |
| x.com               | `x_like`           | 500               |
| x.com               | `x_post`           | 100               |
| tiktok.com          | `tiktok_like`      | 500               |
| tiktok.com          | `tiktok_follow`    | 200               |
| facebook.com        | `fb_like`          | 300               |
| facebook.com        | `fb_follow`        | 100               |
| facebook.com        | `fb_post`          | 25                |
| _platform-agnostic_ | `echo`, `navigate` | Infinity (no cap) |

Override: pasar `caps: { 'instagram.com': { ig_like: 50 } }` al constructor, o setear `OZ_BULK_CAP_<platform>_<action>=N` env var en dev/test.

## Persistence

Archivo: `userData/bulk-rate-limits.json`, atómico tmp+rename, schema versionado.

```json
{
  "version": 1,
  "counters": {
    "<identityId>::<platform>::<actionId>::<YYYY-MM-DD>": <count>,
    ...
  }
}
```

- **Day key UTC** (`YYYY-MM-DD`): cambios de día son automáticos. La entry vieja no se borra inmediato — `purgeOldEntries(30)` corre al boot y limpia entries de >30 días.
- **Corrupt file / schema mismatch:** start fresh sin throw (igual que sync-queue / scheduled-actions).
- **Per-identity-platform-action granularity:** dos identities pueden likear 200 cada una y el contador no se mezcla.

## Integration con BulkRunner

`bulk-runner.js` consulta el registry **antes** de cada item y **incrementa después de success**:

```
// pseudo-code
for (const identityId of run.identityIds) {
  if (rateLimit.wouldExceed(identityId, action.platform, action.id)) {
    item.status = 'skipped'
    item.error = { code: 'rate-limit', reason: 'daily cap reached' }
    continue
  }
  const result = await action.run({...})
  rateLimit.increment(identityId, action.platform, action.id)
}
```

`bulk-runner-rate-limit.js` extrae `checkBeforeItem()` + `incrementAfterSuccess()` para mantener `bulk-runner.js` debajo del cap LOC (ADR 0005).

## MCP surface (Etapa 2.2)

```
oz.bulk.rlStats({ identityId?: string })
  → { asOf, entries: [{ identityId, platform, actionId, day, count, cap, remaining }] }
```

- `cap` y `remaining` son `null` para platform-agnostic actions (`echo`, `navigate`).
- Sin filtro: retorna todos los counters de todas las identities del día.
- Con `identityId`: filter.
- Orden estable: (identityId, platform, actionId, day).

Use case: Claude consulta `oz.bulk.rlStats({identityId: 'id-1'})` antes de programar un bulk grande para saber si esa identity todavía tiene margen.

## UI surface

El bulk-runner reporter muestra `⏱️ rate-limit` distintivo para items skipped por cap (vs failed). Tooltip explica el cap específico que se alcanzó.

UI para counters históricos / dashboard: **deferred a Etapa 4** (Reliability + Observabilidad).

## Tests

- `tests/bulk-rate-limit.smoketest.js` — class API (40+ assertions)
- `tests/bulk-handlers-rlstats.smoketest.js` — MCP handler shape (21 assertions)

## Limitaciones conocidas

1. **Caps son globales por (platform, action)**, no per-scheduled-action. No se puede decir "este scheduled bulk no debe exceder 50 likes aunque el cap global sea 200". Punteo Etapa 4.
2. **Day key es UTC**, no timezone-aware. Para usuarios en UTC-5+ esto puede confundir un poco (el "día" del registry vs el "día" del operador difieren ~5h). Aceptable porque las caps son seguros, no exactos.
3. **No hay backoff** — al alcanzar el cap, todas las items restantes del run se skip-ean inmediato. No espera N horas y reintenta. El operador debe re-lanzar al día siguiente (o programar un scheduled run).
4. **Reset only via day rollover** — no hay API público para "limpiar el counter de id-1 ahora". Es intencional: prevent operator footguns.

## Referencias

- `browser/bulk-rate-limit.js` — class
- `browser/bulk-runner-rate-limit.js` — runner integration
- `browser/bulk-handlers.js` — `rateLimitStats()` MCP handler
- `browser/mcp-tools-bulk.js` — `oz.bulk.rlStats` tool definition
- ADR 0030 — Bulk Runner core
