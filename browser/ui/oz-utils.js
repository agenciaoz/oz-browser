// OZ Browser — small utilities used across the WebUI scripts.
// Loaded BEFORE tabstrip.js, identity-editor.js, sidebar.js, webui.js in webui.html.
//
// IMPORTANT: helpers wrapped in an IIFE so they DON'T leak to the global
// object. Otherwise `function safe()` at top-level would put `safe` on
// `window`, and later scripts doing `const { safe } = window.OZ.utils` would
// throw SyntaxError "Identifier 'safe' has already been declared" — global
// lexical declarations conflict with global-object bindings created by
// top-level `function` declarations in classic (non-module) scripts.

;(function () {
  /**
   * Wrap a Promise so any rejection is reported via window.oz.log
   * (which surfaces it in the unified logger + email-Jose popup).
   */
  function safe(promise, source) {
    return Promise.resolve(promise).catch((err) => {
      if (window.oz && window.oz.log) {
        window.oz.log.reportError({
          source: `webui/${source}`,
          message: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : null,
        })
      }
    })
  }

  /** Lookup helper: identity color by id, with fallback. */
  function identityColor(identities, identityId) {
    const i = identities.find((x) => x.id === identityId)
    return i ? i.color : '#666'
  }

  function identityName(identities, identityId) {
    const i = identities.find((x) => x.id === identityId)
    return i ? i.name : 'Unknown'
  }

  window.OZ = window.OZ || {}
  window.OZ.utils = { safe, identityColor, identityName }
})()
