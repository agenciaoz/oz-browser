// OZ Browser — preload-hud.js (DEPRECATED placeholder).
//
// Esta era la versión inicial del HUD widget pre-K1 que iba a registrarse via
// `session.registerPreloadScript`. El smoke visual del 2026-05-15 reveló que
// los sandboxed preloads de este build (Electron 42 + electron-forge dev)
// fallan silenciosamente cuando hacen require de archivos siblings (mismo bug
// que afecta a preload-content.js — visible en page console como "Unable to
// load preload script ...preload-content.js / module not found ./site-templates").
//
// El pivot fue mover la inyección a `webContents.executeJavaScript()` desde el
// main process (ver `hud-setup.js`). Ese approach bypassa el sandbox totalmente
// y NO requiere preload registration.
//
// Este archivo queda como placeholder para que cualquier referencia legacy
// (forge.config.js extraResource, etc) no rompa el build. Si lo borrás
// asegurate de quitarlo de forge.config.js también.
//
// Pure builders + tests están en `preload-hud-script.js` — eso SÍ sigue activo.

// Intentional no-op — el HUD se inyecta via hud-setup.js, no via preload.
