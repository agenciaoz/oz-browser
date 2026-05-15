// OZ Browser — Content script preload (auto-fill + auto-save) (1.5c).
//
// Doc: docs/modules/preload-content.md
// Bloque: 1.5c
//
// Este preload se inyecta en CADA renderer process de tabs de identities (NO
// en el WebUI chrome — eso usa el preload.js de la raíz). Lo wirea
// identity-manager.js via session.setPreloads([this path]) por cada
// partition session.
//
// Funciones:
//   1. Auto-fill: al cargar una página de login conocida, pide credentials
//      al main via IPC y rellena los inputs. Silencioso por default.
//   2. Auto-save: al detectar form submit en una login page, captura
//      username+password y propone al main via IPC. Main muestra dialog.
//
// Por qué `contextIsolation: true` no es problema: usamos `electron.ipcRenderer`
// directamente en el preload (NO via contextBridge a window). Las acciones se
// ejecutan en el preload world, que tiene acceso al DOM via document directo.
//
// Seguridad — auto-fill es silent (decisión Jose 2026-05-09 noche). NO hace
// confirmación inline. Defensa anti-phishing depende de:
//   - Solo se inyecta en hosts EXACTOS de la whitelist de site-templates
//     (no soporta "smart" matching que un atacante pueda spoofear).
//   - El TLS handshake del browser ya valida el dominio (sin SSL pinning
//     custom — usa la PKI estándar del sistema).
//   - Vault solo se descifra cuando el user explícitamente abre Account
//     Manager (UX choice 1.5b) — primer cold boot no hay credentials en RAM.

const { ipcRenderer } = require('electron')

// Cache local de site-templates para no requerir IPC por cada decisión.
// Versión copiada en build time vía require — el módulo es pure data.
const {
  matchByHost,
  matchByLoginUrl,
  isLoginUrl,
  matchByTotpUrl,
  isTotpUrl,
} = require('./site-templates')

// IDENTITY RESOLUTION: el preload NO sabe (ni necesita saber) qué identity es
// — el handler IPC del main lo resuelve desde event.sender.session via
// IdentityManager.identityIdForSession(). Más seguro: un renderer comprometido
// no puede pedir credentials de OTRA identity (las arg de identityId del
// preload son ignoradas por el main para llamadas desde renderer).
//
// Solo skip auto-fill cuando estamos corriendo en el chrome-extension WebUI
// (preload chrome — ya tiene su propio bridge en preload.js). Heurística:
// la URL chrome-extension://...
if (location.protocol !== 'chrome-extension:') {
  installAutoFill()
  installAutoSave()
  // J-3 (v1.3.0): TOTP injection on 2FA challenge pages.
  installTotpFill()
}

function installAutoFill() {
  // Esperar al DOMContentLoaded — los inputs no existen antes.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryFillCredentials)
  } else {
    tryFillCredentials()
  }

  // SPA navigations (X, IG, FB son SPAs). Re-check on URL change.
  let lastUrl = location.href
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      tryFillCredentials()
    }
  }, 1500)
}

async function tryFillCredentials() {
  if (!isLoginUrl(location.href)) return
  const template = matchByLoginUrl(location.href) || matchByHost(location.hostname)
  if (!template) return

  // Canonical site id (first host in template).
  const site = template.hosts[0]
  let creds
  try {
    // identityId is resolved by main from event.sender.session — we pass null
    // so the main side knows to deduce. The third arg is ignored for renderer
    // callers (prevents impersonation).
    creds = await ipcRenderer.invoke('oz:accounts:getCredentialsForSite', site, null)
  } catch (_e) {
    return // IPC failure — silent
  }
  if (!creds || creds.__error || !creds.username) return

  // Wait for inputs to be in DOM (some sites render React after a tick).
  const usernameEl = await waitForSelector(template.selectors.usernameInput, 4000)
  if (!usernameEl) return
  setInputValue(usernameEl, creds.username)

  // Two-step flows (X, Google): only fill username first; password input
  // appears in the second screen after Next button.
  if (template.flow === 'two-step') {
    return // user clicks Next manually for now (auto-click could be aggressive)
  }

  const passwordEl = await waitForSelector(template.selectors.passwordInput, 2000)
  if (passwordEl) setInputValue(passwordEl, creds.password)
}

// J-3 (v1.3.0): TOTP auto-injection on 2FA challenge pages.
// Pattern matches installAutoFill: trigger on load + SPA URL changes,
// match by totpUrlPatterns OR fallback to detecting the input by
// `autocomplete="one-time-code"` (HTML spec for 2FA inputs), request
// the code via IPC (main generates TOTP from accountVault.totpSecret),
// fill the input.
function installTotpFill() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryFillTotp)
  } else {
    tryFillTotp()
  }
  let lastUrl = location.href
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      tryFillTotp()
    }
  }, 1500)
}

async function tryFillTotp() {
  // Two paths: URL pattern match (Instagram, FB, Google) OR generic
  // detection by autocomplete attribute (works for unknown sites that
  // follow the modern spec). Hostname-based filter prevents firing on
  // every page — we only attempt if we know this is a templated host.
  const template = matchByHost(location.hostname)
  if (!template || !template.selectors || !template.selectors.totpInput) return
  // Skip if URL doesn't look like 2FA AND there's no obvious one-time-code
  // input visible. (Some flows like X reuse the login URL.)
  if (!isTotpUrl(location.href)) {
    const probe = document.querySelector('input[autocomplete="one-time-code"]')
    if (!probe) return
  }

  const site = template.hosts[0]
  let totp
  try {
    totp = await ipcRenderer.invoke('oz:accounts:getTotpForSite', site, null)
  } catch (_e) {
    return
  }
  if (!totp || totp.__error || !totp.code) return

  const input = await waitForSelector(template.selectors.totpInput, 4000)
  if (!input) return
  setInputValue(input, totp.code)
}

function installAutoSave() {
  // Hook submit globally — captures Enter-on-form and click-on-submit.
  document.addEventListener(
    'submit',
    (ev) => {
      try {
        handleFormSubmit(ev.target)
      } catch (_e) {
        // never throw from event handler — would break the actual submit
      }
    },
    true, // capture phase to run before site's own handlers
  )
}

function handleFormSubmit(form) {
  if (!form || !form.querySelectorAll) return
  const template = matchByLoginUrl(location.href) || matchByHost(location.hostname)
  if (!template) return

  // Find username + password inputs IN THIS FORM (or fall back to template).
  const usernameInput =
    form.querySelector(template.selectors.usernameInput) ||
    form.querySelector('input[type="email"], input[type="text"], input[name*="user"]')
  const passwordInput =
    form.querySelector(template.selectors.passwordInput) ||
    form.querySelector('input[type="password"]')
  if (!usernameInput || !passwordInput) return

  const username = usernameInput.value || ''
  const password = passwordInput.value || ''
  if (!username || !password) return

  const site = template.hosts[0]
  ipcRenderer
    .invoke('oz:accounts:proposeAutoSave', {
      site,
      username,
      password,
      // identityId resolved by main from event.sender.session
    })
    .catch(() => {
      /* silent */
    })
}

// ---------- DOM utils -------------------------------------------------------

function waitForSelector(selector, timeoutMs) {
  return new Promise((resolve) => {
    const found = document.querySelector(selector)
    if (found) return resolve(found)
    const start = Date.now()
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) {
        observer.disconnect()
        resolve(el)
      } else if (Date.now() - start > timeoutMs) {
        observer.disconnect()
        resolve(null)
      }
    })
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    })
    setTimeout(() => {
      observer.disconnect()
      resolve(null)
    }, timeoutMs)
  })
}

/**
 * Set input.value AND fire React-compatible change events. Just setting .value
 * doesn't trigger React state updates because React tracks the descriptor's
 * setter. We use the native HTMLInputElement setter to be transparent.
 */
function setInputValue(el, value) {
  const proto = Object.getPrototypeOf(el)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) {
    setter.call(el, value)
  } else {
    el.value = value
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
