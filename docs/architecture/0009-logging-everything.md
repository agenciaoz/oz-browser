# ADR 0009 — Logging exhaustivo en todo componente y flujo

**Estado:** Aceptado
**Fecha:** 2026-05-09
**Pedido por:** Jose

## Contexto

Sin logs no se debuggea nada. Cuando algo se rompe, lo raro pasa, o el cliente reporta un comportamiento extraño, lo único que tenemos para reconstruir lo que pasó son los logs. Si los logs son pobres, perdemos horas adivinando.

> "Sin buenos logs después las cosas se rompen y no sabemos dónde está el daño." — Jose

## Decisión

**Logging exhaustivo es obligatorio en cada componente y flujo.** Niveles:

- `DEBUG` — datos detallados que solo importan al diagnosticar (parámetros entrantes, IDs, latencias). En producción se filtra a archivo, no a consola.
- `INFO` — eventos del lifecycle del producto (app start, identity created, tab materialized, sync started/finished).
- `WARN` — anomalías recuperables (proxy lento, retry, cookie expired, fallback usado).
- `ERROR` — fallas reales que afectan al usuario o que requieren atención.

### Reglas

1. **Cada operación crítica genera al menos UN log de nivel ≥ INFO** con:
   - Source (módulo)
   - Identifier (id de la entidad afectada)
   - Outcome (éxito / error)
   - Latencia para operaciones que pueden ser lentas
2. **Cada error capturado se loggea en ERROR** con stack trace completo + contexto.
3. **Cada IPC handler loggea al ENTRAR** (DEBUG con args) y al SALIR (INFO con outcome).
4. **Cada flow asincrónico de varios pasos loggea cada paso** (con un correlation id si cruza módulos).
5. **Métricas de performance se loggean cada 30 s** (RAM, CPU, tabs count, identities materialized count).
6. **Toda navegación de tab loggea** (URL, status code, latency).
7. **Toda request HTTP via proxy loggea** (URL, proxy usado, bytes IN/OUT, latency).
8. **Logs nunca contienen passwords, tokens, ni cookies completas.** Filtros automáticos (regex) en `logger.js`.

### Formato de línea

```
[ISO timestamp] LEVEL [source] message {key: value, ...}
```

### Storage

- **Local file:** `~/Library/Logs/OZ Browser/oz-browser.log` con rotación a 10 MB y mantención de 3 archivos viejos.
- **Sesiones de prueba (dev):** consola también recibe (mirror).
- **Crash:** logs últimas N líneas auto-adjuntan al email-Jose popup.

### UI in-app: Log Viewer (Bloque 1.2 / 1.7)

Vista accesible vía `View → Show Log Viewer` (Cmd+Opt+L). Muestra:
- Stream live de logs (auto-scroll opcional)
- Filtros: por nivel, por source, por search string, por time range
- Botones: Clear, Copy all, Export to file, Email to Jose
- Hot reload sin reiniciar app

Esto evita el "abre Terminal y `tail -f` el log" durante pruebas. Útil cuando un colaborador externo prueba y manda screenshot.

### Telemetría opcional (Etapa 7+)

Logs INFO/WARN/ERROR (sin DEBUG) opcionalmente se sync al Activity Tracker → Admin Dashboard (Etapa 7.5) si el user opta-in. Desde el dashboard, Jose ve patrones (qué error se repite en qué Mac).

## Alternativas consideradas

- **Logging selectivo:** "solo loggea lo importante". El problema: lo importante se sabe DESPUÉS del bug.
- **Logging solo en errores:** se pierden la mayoría de bugs sutiles donde nada erra pero algo está raro.
- **Console.log en lugar de logger estructurado:** sin niveles, sin filtros, sin file rotation, sin search.

## Consecuencias

- ✅ Cuando algo se rompe, podemos reconstruir qué pasó.
- ✅ Tests + reproducción de bugs son posibles con los logs.
- ✅ Activity tracker se beneficia de los mismos logs.
- ⚠️ Volumen de logs: ~1-5 MB/día por user activo. Mitigación: rotation + DEBUG filtrado en prod build.
- ⚠️ Performance: logging async (write stream no bloquea). Disco: SSD apple silicon → trivial.
- ⚠️ Privacy: filtros automáticos para passwords/tokens/cookies. Tests del filtro en CI.

## Referencias

- Implementación: `browser/logger.js`
- Doc de feature: `../features/logging.md`
- Filtros de privacy: a implementar en Bloque 1.5 cuando llegue el vault.
