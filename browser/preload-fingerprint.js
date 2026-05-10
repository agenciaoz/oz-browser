// OZ Browser — Fingerprint preload script (1.9b/c).
//
// Doc: docs/modules/preload-fingerprint.md
// ADR: docs/architecture/0018-fingerprint-engine.md
//
// Este preload corre en cada renderer de tabs de identities (NO en el WebUI
// chrome). Aplica los overrides de fingerprint en el PAGE WORLD via
// webFrame.executeJavaScript ANTES de que la página ejecute su propio JS.
//
// Por qué webFrame.executeJavaScript y no contextBridge: con contextIsolation
// (que usamos por seguridad), el preload world y el page world están
// separados. Object.defineProperty(navigator) en el preload NO afecta al
// navigator del page world. webFrame.executeJavaScript inyecta código en el
// page world ANTES del primer JS de la página, así que los overrides se ven
// como si fueran nativos.
//
// Pattern del FP fetch:
//   ipcRenderer.sendSync('oz:fingerprint:request')
// El handler en main resuelve la identity via event.sender.session
// (mismo trick anti-spoof que 1.5c — el renderer NO puede pedir el FP de
// otra identity). Sync porque debe completar ANTES del primer page JS.
// El round-trip local IPC es <1ms, no perceptible.
//
// Nota: este script NO se inyecta en chrome-extension:// (mismo skip que
// preload-content.js — el WebUI no necesita FP spoof, es nuestro UI).
//
// 1.9.5: el builder del IIFE vive en preload-fingerprint-script.js (módulo
// puro testeable sin Electron). Este file es el bridge IPC + webFrame.

const { ipcRenderer, webFrame } = require('electron')
const { buildOverridesScript } = require('./preload-fingerprint-script')

if (location.protocol !== 'chrome-extension:') {
  try {
    const fp = ipcRenderer.sendSync('oz:fingerprint:request')
    if (fp && fp.ua) {
      const script = buildOverridesScript(fp)
      webFrame.executeJavaScript(script).catch((err) => {
        // Don't break the page if injection fails. Log to main if possible.
        try {
          ipcRenderer.invoke('oz:log', 'WARN', 'preload-fingerprint', 'inject failed', [
            err.message,
          ])
        } catch (_e) {
          // best-effort
        }
      })
    }
  } catch (err) {
    // Sync IPC failed — likely the main handler isn't registered yet (test
    // environment). Skip silently — page loads with native fingerprint.
    try {
      ipcRenderer.invoke('oz:log', 'DEBUG', 'preload-fingerprint', 'no FP available', [
        err.message,
      ])
    } catch (_e) {
      // best-effort
    }
  }
}
