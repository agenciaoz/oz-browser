# Activación + panel de equipo (build de prueba)

Cómo repartir OZ Browser al equipo, manejar accesos y ver uso.

## Panel de admin

- **URL:** https://oz-activate.joserodrigo-413.workers.dev
- **Token de admin:** (NO está en el repo — guardalo en tu gestor de contraseñas; lo seteamos como secret del Worker `ADMIN_TOKEN`).
- Abrís la URL, pegás el token, y tenés: crear claves, revocar/reactivar, eliminar, ver activaciones (máquina + versión + último visto) y la actividad reciente.

## Cómo activa cada miembro

1. Le pasás el `.dmg` (desde GitHub Releases — la versión Latest) y una **clave** `OZ-XXXX-XXXX-XXXX`.
2. Abre la app → pantalla de activación → pega la clave → Activar. La app se reinicia ya activada.
3. En cada arranque revalida online; si no hay internet, sigue andando hasta **7 días** (gracia offline).

## Manejar claves

**Desde el panel** (lo más fácil): botón "Generar clave" (nombre/email/días), y por fila "Revocar" / "Reactivar" / "✕ eliminar".

**Por API** (si preferís script), con tu token de admin:

```bash
BASE=https://oz-activate.joserodrigo-413.workers.dev
ADMIN=<tu-admin-token>
# crear (days=0 = sin vencimiento)
curl -s -X POST $BASE/admin/create -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"name":"Pedro","email":"pedro@...","days":30}'
# revocar
curl -s -X POST $BASE/admin/revoke -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"key":"OZ-XXXX-XXXX-XXXX"}'
```

Revocar corta el acceso en el **próximo chequeo online** del usuario (o cuando venza su gracia offline).

## Proxies por usuario (Decodo) — alpha.100

Cada clave puede llevar su **propio set de proxies**. Al activar (y en cada revalidación), el servidor los entrega y la app los **importa + auto-asigna a las identidades solo** — el usuario no configura nada. Además la app queda en **fail-closed**: si en algún momento no hay proxy disponible, **bloquea la navegación** (blackhole `socks5://127.0.0.1:1`) en vez de caer a la IP real. Un install con proxies de licencia **no puede navegar sin proxy**.

### Cargar proxies a un usuario

**Desde el panel:** en la fila de la licencia, botón **🌐 Proxies** → se abre un textarea. Pegás un proxy por línea con el formato:

```
host:puerto:usuario:password
gate.decodo.com:10001:user-Juanja-country-us-city-miami-sessionduration-30:yMLusga8n+...
```

La ciudad se deduce del `-city-<slug>` del usuario. También hay un botón **⚡ Generar 10 Decodo Miami** que arma 10 sesiones sticky con un prefijo único por usuario (pide user/pass master la primera vez).

### Modelo recomendado: un sub-user Decodo por persona

Para aislamiento real (bandwidth + credenciales separadas por persona), creá un **sub-user en Decodo** para cada miembro y cargale SUS proxies. Ejemplo: "Juanja" tiene su sub-user propio (`user-Juanja-country-us-city-miami-sessionduration-30`). Alternativa más barata: repartir slices de puertos de una sola cuenta master (`gate.decodo.com:10001-11000` = 1000 IPs sticky, mismo user), 10 puertos por persona sin solapar.

### Onboarding de un usuario nuevo

1. Creás su sub-user en Decodo (o reservás un slice de puertos del master).
2. En el panel: generás su clave → botón 🌐 Proxies → pegás sus 10 líneas → Guardar.
3. Le pasás el instalador (Release Latest) + su clave.
4. Activa → le entran los proxies puestos y no puede navegar sin ellos.

### API (opcional)

```bash
# reemplaza TODOS los proxies de una clave
curl -s -X POST $BASE/admin/setproxies -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' \
  -d '{"key":"OZ-XXXX-XXXX-XXXX","proxies":[{"host":"gate.decodo.com","port":10001,"protocol":"https","username":"user-...-city-miami","password":"...","city":"miami","country":"US","tags":["decodo"]}]}'
# leer los proxies de una clave
curl -s -X POST $BASE/admin/getproxies -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"key":"OZ-XXXX-XXXX-XXXX"}'
```

App-side: `browser/license-proxies.js` (import + auto-assign, idempotente, dedup por `host:port:username`) + `proxy-boot-setup.js` (wiring en boot) + enforcement fail-closed en `proxy-sticky-rotation.js`. Ver `docs/modules/license-proxies.md`.

> ⚠️ **Costo:** el trial de Decodo trae poco bandwidth (100 MB). Uso real de varias personas requiere un plan pago.

## Qué se ve de actividad

Hoy: evento `app-open` por cada validación (quién, máquina, versión, cuándo). Próximo: eventos por acción (bulk runs, scrapes) para ver "en qué trabajaron".

> Transparencia recomendada: avisá al equipo que la herramienta reporta uso operativo (qué/cuándo), no contenido de páginas ni teclas.

## Operar el backend

- Código: `activation-server/worker.js` (+ `wrangler.toml`). D1 `oz-admin`.
- Redeploy: `cd activation-server && npx wrangler deploy`.
- Secrets: `npx wrangler secret put ADMIN_TOKEN` / `HMAC_SECRET`.
- Datos: también consultables con el MCP de Cloudflare (D1 query sobre `oz-admin`).

## Dev / troubleshooting

- Saltar la activación en desarrollo: `OZ_LICENSE_DISABLED=1`.
- Apuntar a otro servidor: `OZ_LICENSE_SERVER=https://...`.
- Si la ventana de activación no abriera, la app **no se brickea** (fail-open) y deja entrar; queda log de error.
