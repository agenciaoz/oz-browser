# Module: System Diagnostics (system-diagnostics.js + diagnostics-handlers.js)

**Files:**

- `browser/system-diagnostics.js` — lógica pura: buildDiagnostics, summarizeProxies, parseLogTail, readLogTail, selfCheck
- `browser/diagnostics-handlers.js` — handlers Electron (snapshot/logs/selfCheck/screenshot)
- `browser/mcp-tools-diag.js` — tools MCP `oz.diag.*`
- `tests/system-diagnostics.smoketest.js` — 36 assertions (pura)

**ADR:** [`0043-system-diagnostics.md`](../architecture/0043-system-diagnostics.md).

## Para qué

Que el agente (Claude) pueda **revisar todo** el estado del navegador de una sola llamada — incluida captura visual — sin depender de que el usuario le pase datos. Idea de Jose (2026-07-16).

## MCP tools

| Tool                 | Registrado           | Qué devuelve                                                                                         |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `oz.diag.snapshot`   | `oz_diag_snapshot`   | Snapshot estructurado completo (ver abajo). Opts `{includeLog, logLevel, logLimit}`.                 |
| `oz.diag.logs`       | `oz_diag_logs`       | `{ lines[], counts:{DEBUG,INFO,WARN,ERROR}, logPath }`. Opts `{level, limit}`.                       |
| `oz.diag.selfCheck`  | `oz_diag_selfCheck`  | `{ ok, failed, checks:[{name,ok,detail}] }` — el diagnóstico se verifica a sí mismo.                 |
| `oz.diag.screenshot` | `oz_diag_screenshot` | `{ ok, path, target, bytes, width, height, url }` — PNG en disco; el agente lee `path` y lo analiza. |

## Snapshot (`buildDiagnostics`)

```
{
  generatedAt, runtime:{ozVersion,uptimeSec,memoryMB,heapMB,node,platform},
  enforceProxy,
  leakRisk:{ enforced, count, identities:[{id,name,workspaceId}] }, // identities que navegarían SIN proxy (fuga si enforce off)
  identities:{ count, list:[{id,name,workspaceId,isDefault,locked}] },
  proxies:{ total,active,disabled,failing,avgLatencyMs,worst },
  sessionsCached, tabs:{ total,materialized,lazy,windows:[...] },
  workspaces, sync,
  settings:{ performance, privacy, sync, notifications },
  lastScrape:{ jobId, wallMs, cost }, // resumen del último scrape (V3-E)
  selfCheck:{ ok, failed, checks },
  log?:{ lines, counts, logPath } // si includeLog !== false
}
```

## screenshot targets

- `content` (default): página del tab activo.
- `chrome`: el chrome de la WebUI (sidebar + tabstrip + omnibox).
- `full` (alpha.115): chrome + contenido en una llamada → `{ parts:[{part,path,...}] }`. El agente lee ambos PNG (el capturePage del chrome deja el contenido en negro porque el WebContentsView es capa nativa aparte).
- `tab` (+`tabId`) / `identity` (+`identityId`): un tab materializado específico.

Usa `webContents.capturePage()` → guarda en `userData/diagnostics/diag-<label>-<ts>.png`. El módulo no hace visión; el agente lee el PNG y lo analiza.

## Robustez

Todo guardado (`_safe`): un manager ausente deja su bloque en `null` y el resto del snapshot igual sale. `readLogTail` lee solo los últimos ~512KB. Los handlers atrapan y devuelven `{__error}` en vez de tirar.
