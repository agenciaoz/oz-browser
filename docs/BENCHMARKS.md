# OZ Browser — Benchmarks

> Mediciones de performance por release. Una fila por cierre de bloque significativo. Se llenan automáticamente vía `oz.system.getMetrics` del MCP server (Bloque 1.3-MCP) en un script `scripts/measure.js` (futuro).

---

## Targets (de PLAN-MAESTRO §0.5)

| Mac (RAM)                                | Lazy | Materialized | Memoria total |
| ---------------------------------------- | ---- | ------------ | ------------- |
| **MacBook Air M1 8 GB** ← target oficina | 100  | 10           | < 4 GB        |
| MacBook Pro M1/M2 16 GB                  | 200  | 30           | < 8 GB        |
| MacBook Pro M2/M3 32 GB+                 | 500  | 100          | < 16 GB       |

**SLOs:**

- Cold start (M1 Air): < 2s
- Crear identity nueva: < 100ms
- Switch entre tabs (materialized): < 50ms
- Materializar tab lazy desde click: < 800ms

---

## Histórico

| Fecha      | Bloque | Mac         | Identidades | Lazy | Materialized | Mem | Cold start | Notas                                                                                                    |
| ---------- | ------ | ----------- | ----------- | ---- | ------------ | --- | ---------- | -------------------------------------------------------------------------------------------------------- |
| 2026-05-09 | 1.2    | (sin medir) | —           | —    | —            | —   | —          | Smoke test visual sin métricas. Línea base se establece en 1.3-MCP cuando exista `oz.system.getMetrics`. |

---

## Cómo medir manualmente (mientras 1.3-MCP no esté listo)

```bash
# 1. Cold start
time npm start  # mide hasta primer pixel; aproximado, mejor con Spectron

# 2. Memoria
# En Activity Monitor o
ps aux | grep "OZ Browser"

# 3. Identities
# Crear N identities desde DevTools console:
# for (let i = 0; i < 50; i++) await window.oz.identities.create({ name: `Test ${i}` })
# Bypass del cap: SHELL_DEBUG=1 OZ_TIER=paid npm start
```

## Cómo medir con MCP (post-1.3-MCP)

```bash
# Levanta OZ con MCP enabled
OZ_MCP_ENABLED=1 npm start

# En otra terminal:
curl -X POST http://localhost:9223/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oz.system.getMetrics","arguments":{}}}'
```

Output esperado:

```json
{
  "memoryMB": 215,
  "cpuPercent": 1.4,
  "identitiesCount": 1,
  "tabsLazy": 0,
  "tabsMaterialized": 1,
  "uptimeSec": 12,
  "ozVersion": "0.1.0"
}
```

---

## Reglas

- **Cada cierre de bloque** anota una fila al final de la tabla "Histórico".
- Si una métrica regresiona vs el target, queda flagged y se trabaja antes del próximo cierre.
- Las mediciones del MacBook de Jose son las canónicas (M2 16GB normalmente). Cuando un colaborador externo mida en M1 Air, columna "Mac" lo identifica.
- Los benchmarks de rendimiento de fingerprint (Pixelscan/CreepJS scores) viven en `docs/features/fingerprint-engine.md`, no aquí.
