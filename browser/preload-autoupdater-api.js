// OZ Browser — preload helper for the auto-updater API surface (I-2 v1.6.0).
//
// Extracted from preload.js to keep it under the 500-LOC budget (ADR 0005).
// Exports a builder that returns the `autoUpdater` slice of window.oz.
//
// Usage in preload.js:
//   const { buildAutoUpdaterApi } = require('./browser/preload-autoupdater-api')
//   contextBridge.exposeInMainWorld('oz', { ..., autoUpdater: buildAutoUpdaterApi(ipcRenderer) })

function buildAutoUpdaterApi(ipcRenderer) {
  return {
    checkNow: () => ipcRenderer.invoke('oz:auto-updater:check'),
    installNow: () => ipcRenderer.invoke('oz:auto-updater:install'),
    // Subscribe to the 6 broadcast channels with a single callback that
    // receives { event, payload } where event is one of:
    //   'checking' | 'available' | 'not-available' | 'download-progress'
    //   | 'downloaded' | 'error'
    onEvent(cb) {
      const events = [
        'checking',
        'available',
        'not-available',
        'download-progress',
        'downloaded',
        'error',
      ]
      const unsubs = events.map((evt) => {
        const listener = (_e, payload) => cb({ event: evt, payload })
        ipcRenderer.on(`oz:auto-updater:${evt}`, listener)
        return () => ipcRenderer.off(`oz:auto-updater:${evt}`, listener)
      })
      return () => unsubs.forEach((u) => u())
    },
  }
}

module.exports = { buildAutoUpdaterApi }
