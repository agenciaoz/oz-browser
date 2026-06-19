// OZ Browser — preload bridge for the Publishing Studio (v2 Etapa 1).
//
// Extracted from preload.js to keep that file under the 500-LOC budget
// (ADR 0005). Same pattern as preload-bulk-api.js / preload-proxy.js.
//
// openTab() opens the dedicated studio tab; onOpen() fires when the menu /
// palette asks the focused window to open it.

'use strict'

function buildPublishingApi(ipcRenderer) {
  return {
    openTab: () => ipcRenderer.invoke('oz:publishing:openTab'),
    onOpen(cb) {
      const listener = () => cb()
      ipcRenderer.on('oz:publishing:open', listener)
      return () => ipcRenderer.off('oz:publishing:open', listener)
    },
  }
}

module.exports = { buildPublishingApi }
