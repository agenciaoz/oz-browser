# Etapa 0 — Resultado: ✅ GO

**Fecha:** 2026-05-09
**Stack validado:** Electron 42.0.1 + WebContentsView + `session.fromPartition('persist:...')` + `session.setProxy()` + `app.on('login')`
**Proxy provider probado:** Oxylabs Mobile HTTPS (`us-pr.oxylabs.io:10001`)

---

## Criterios pasados (4/4)

### 1. ✅ Aislamiento de cookies/storage por pestaña

`session.fromPartition('persist:identity-a')` y `persist:identity-b` crean particiones físicas en disco:

```
~/Library/Application Support/ghost-clone-spike-etapa-0/Partitions/identity-a/Cookies
~/Library/Application Support/ghost-clone-spike-etapa-0/Partitions/identity-b/Cookies
```

Cada uno es un SQLite separado. **Verificado a nivel de archivo**, no es un hack runtime.

### 2. ✅ Proxy distinto por pestaña

Cada partition con su propio proxy via `session.setProxy({ proxyRules })`.

| Identity | IP recibida | Ciudad | Proveedor (org) |
|---|---|---|---|
| A (sessid spikeA001) | 172.56.234.232 | Los Angeles | T-Mobile USA (AS21928) |
| B (sessid spikeB002) | 151.204.147.207 | New York City | Verizon Business (AS701) |

Mismo endpoint Oxylabs, distintos sessid, IPs móviles distintas de carriers distintos.

### 3. ✅ Autenticación de proxy con user/pass

`app.on('login')` disparó correctamente con `authInfo.isProxy === true` para AMBAS sesiones. Los logs:

```
[proxy-auth] Inyectando creds para Identity A (US sticky — IP móvil 1)
[proxy-auth] Inyectando creds para Identity B (US sticky — IP móvil 2)
```

Patrón del handler (canonical):
```js
app.on('login', (event, webContents, request, authInfo, callback) => {
  if (authInfo.isProxy) {
    event.preventDefault();
    const cred = sessionCreds.get(webContents.session);
    callback(cred.username, cred.password);
  }
});
```

### 4. ✅ Persistencia de cookies entre reinicios

Procedimiento:
1. Run 1 → set cookies vía test buttons → cerrar app con `kill`
2. Run 2 → click "Persistence" → cookies del run anterior leídas correctamente
3. SQLite confirmó valores idénticos sobrevivieron:
   - `identity-a`: `spike-test=value-a-1778351017428` + `isolation-test=only-in-A`
   - `identity-b`: `spike-test=value-b-1778351017428` (sin `isolation-test` ← aislamiento)

### Bonus: sticky session Oxylabs

Después del reinicio, las IPs fueron las MISMAS que en el primer run (porque `sesstime-30` mantiene la sticky por 30 min). Esto valida que podemos diseñar la app para que mantenga "el mismo" proxy IP por Identity durante una sesión de trabajo.

---

## Implicaciones para Etapa 1

Todas las bases técnicas críticas están validadas. Etapa 1 puede arrancar sin riesgo de bloqueador arquitectónico:

- ✅ Modelo Identity = `persist:identity-${uuid}` ya probado
- ✅ Proxy por Identity = `session.setProxy()` + `app.on('login')` ya probado
- ✅ Cookie isolation = nativo de Electron, no hay que escribir nada custom
- ✅ Persistencia = nativa con prefijo `persist:`
- ✅ Pool import + auto-assign = trivial encima de lo que ya existe

---

## Lo que NO se probó en este spike (queda para Etapa 1)

- Performance con 10+ identities concurrentes (RAM, CPU)
- Auto-update de Electron
- Comportamiento al cambiar proxy en runtime (en este spike el proxy se setea una sola vez)
- DNS leak protection más allá del proxy (el HTTPS proxy resuelve DNS por su lado pero queda WebRTC, que controlamos en Etapa 1 con el toggle "Disable WebRTC")
- Inyección de preload script con overrides antidetect (Etapa 1-2)

Estos son ejecuciones de ingeniería estándar, no riesgos arquitectónicos.

---

## Costos hasta aquí

- Apple Developer: $0 (no necesario aún)
- Hosting: $0
- Oxylabs: ya pagado por Jose por su uso normal
- **Total spike Etapa 0: $0**
