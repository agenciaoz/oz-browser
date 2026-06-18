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
