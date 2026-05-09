# ADR 0003 — Default Identity usa `defaultSession`

**Estado:** Aceptado
**Fecha:** 2026-05-09

## Contexto

`ElectronChromeExtensions` se inicializa con UNA session (la default). Cuando le pasamos un `webContents` cuya session NO coincide (i.e. una partition session de una identity custom), tira `Invalid WebContents argument`. Eso bloquea ChromeWebStore extensions en cualquier identity no-default.

## Decisión

**La identity llamada "Default" usa `session.defaultSession`** en lugar de `session.fromPartition('persist:identity-default')`. Las demás identities usan partitions normales.

## Alternativas consideradas

- **Una instancia de `ElectronChromeExtensions` por identity:** cara y complica el setup de Web Store install (cada partition tiene que tener su propia copia de extensions). Reservado para Bloque 1.10.
- **Skip extensions completo:** no podemos vender un browser sin Chrome extensions. Descartado.
- **Hookear el `checkWebContentsArgument` para que acepte cualquier session:** rompe la garantía interna de electron-chrome-extensions; riesgoso.

## Consecuencias

- ✅ Chrome Web Store extensions funcionan en Default identity sin trabajo extra.
- ⚠️ Extensions NO funcionan en otras identities hasta Bloque 1.10. Aceptable para v1 (las identities no-default son típicamente cuentas de redes sociales sin extensions críticas).
- ⚠️ Cookies/storage de Default identity comparten el storage del defaultSession con cualquier otra cosa que use defaultSession (browser-action popups, etc.). En la práctica no es un problema porque la WebUI vive en chrome-extension scheme separado.
- ⚠️ Backup/restore de Default identity copia el defaultSession's storage, no una partition propia — el backup-manager.js debe manejarlo.

## Referencias

- Implementado en `browser/identity-manager.js` (`getSession()`)
- Implementado en `browser/window-manager.js` (skip `extensions.addTab` si session ≠ defaultSession)
- Reemplazo futuro: ADR pendiente — instancias múltiples de ElectronChromeExtensions (Bloque 1.10)
