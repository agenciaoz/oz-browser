# Guía: activar Sync cross-device (Dropbox) en producción

> Estado del código (validado 2026-07-15): el motor de sync está **wired en `main.js`** (`sync-bootstrap-setup`) y el OAuth es **real (PKCE + Keychain)**. El sync está **OFF por default** (opt-in desde Settings → Sync). Lo único que falta para que funcione en un build repartido es la **App Key de Dropbox a build-time**. Esta guía es esa pieza.

## Por qué hace falta la App Key

La app autentica al usuario final con **PKCE** (no necesita el App Secret en el `.app`), pero sí necesita la **App Key** (pública) embebida a build-time vía webpack DefinePlugin. Sin `OZ_DROPBOX_APP_KEY`, `cloud-backup-setup.js` deja el cliente Dropbox en `null` y el sync devuelve `reason: 'NEEDS_DROPBOX_APP'`.

## Pasos (una vez)

1. **Crear la app Dropbox** en https://www.dropbox.com/developers/apps → "Create app":
   - API: **Scoped access**.
   - Access type: **App folder** (recomendado — la app solo ve su propia carpeta) o Full Dropbox.
   - Nombre único (p.ej. `OZ-Browser-Sync`).
2. En la app creada → pestaña **Permissions**, habilitar: `files.metadata.read`, `files.content.read`, `files.content.write` (y `account_info.read`). Guardar.
3. En **Settings** de la app:
   - Copiar el **App key**.
   - En **OAuth 2 → Redirect URIs**, agregar el redirect que usa `oauth-helper.js` (el loopback/localhost o el `oz://` handler — ver `browser/oauth-helper.js`).
4. **Buildear con la key**: setear `OZ_DROPBOX_APP_KEY=<app key>` en el entorno del build (o en `.env`, NO commitear el valor). Ejemplo:
   ```bash
   OZ_DROPBOX_APP_KEY=xxxxxxxxxxxxxxx npm run publish
   ```
   La key se embebe en el `.app` (es pública, no es secreto). El **App Secret** NO se bundlea — solo lo usan tools admin server-side (`scripts/dropbox-admin.js`).

## Cómo lo activa cada usuario

1. Con un build que trae la key: **Settings → Sync → habilitar** (toggle `automation`/`syncEnabled`).
2. Primera vez: se dispara el **cold-start** (encola cada identity/workspace/bookmark como upsert para que el otro device hidrate) + el flujo OAuth de Dropbox (una vez, token guardado en Keychain).
3. Botón **Sync Now** para forzar un pull inmediato.

## Verificar

- `oz.sync.getStatus` (MCP) o Settings → Sync muestran el estado. Si aparece `NEEDS_DROPBOX_APP`, el build no trae la key. Si `NEEDS_REAUTH`, falta el OAuth del usuario.

## Pendiente conocido (NO bloquea el uso, requiere validación en vivo)

- **Long-poll real**: hoy el pull corre en un `setInterval` de 30s (`sync-setup.js §5`). Migrar a `filesListFolderLongpoll` baja la latencia remoto→local, pero tiene semántica propia de Dropbox (cursor + backoff + dominio notify) y hay que validarla contra Dropbox real antes de reemplazar el poll.
- **GC de tombstones**: los registros borrados quedan como tombstones (`deleted:true`) en Dropbox. Un GC por edad es **inseguro** sin tracking de acknowledgment por dispositivo (un device offline > N días nunca vería el delete y resucitaría el registro). Necesita diseño (marcas de "visto por todos los devices") + validación antes de borrar nada remoto.

Ver: `docs/architecture/0026-sync-engine.md`, `docs/modules/dropbox-client.md`, `docs/modules/cloud-backup-setup.md`.
