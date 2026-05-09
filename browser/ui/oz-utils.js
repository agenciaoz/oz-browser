// OZ Browser — small utilities used across the WebUI scripts.
// Loaded BEFORE tabstrip.js and sidebar.js in webui.html.

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
