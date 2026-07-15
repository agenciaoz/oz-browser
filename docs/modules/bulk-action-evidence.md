# bulk-action-evidence

Captura de **evidencia de posteo** (E2). Introducido en v2.0.0-alpha.105.

## Qué hace

`captureEvidence(win, { identityId, actionId, electron })` — tras un posteo exitoso, saca un screenshot de la página como prueba y lo guarda en `userData/publish-evidence/<ts>-<actionId>-<identity>.png`. Devuelve `{ evidencePath }` o `{}`.

**Best-effort, nunca tira:** la evidencia no debe romper un post ya exitoso. Si `capturePage` falla o el `win` es inválido, loggea un warning y devuelve `{}`.

## Integración

Las actions de post la llaman justo antes del `return` de éxito y esparcen el resultado:

```js
const ev = await require('./bulk-action-evidence').captureEvidence(win, {
  identityId: identity.id,
  actionId: 'ig_post',
  electron,
})
return { ...resultado, ...ev } // agrega evidencePath si se pudo
```

Cableado en: `bulk-actions-ig-post.js`, `bulk-actions-x-post.js`, `bulk-actions-fb-post.js`, `bulk-actions-threads-post.js`. El `evidencePath` viaja en el item del bulk run → visible en el historial y en el resultado que devuelve el MCP.

## Dependencias

- `bulk-action-browser-helpers.screenshot(win, {filePath})` — `webContents.capturePage()` → PNG.
- `electron.app.getPath('userData')` para la carpeta base.

## Tests

`tests/bulk-action-evidence.smoketest.js` (6 checks): happy path escribe PNG bajo `publish-evidence/`, nombre incluye actionId, y los dos caminos de fallo devuelven `{}` sin throw.
