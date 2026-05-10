// OZ Browser — Site templates para auto-fill + auto-save (1.5c).
//
// Doc: docs/modules/site-templates.md
// Bloque: 1.5c (CORE)
//
// Cada template describe cómo detectar la login page de una plataforma y
// dónde inyectar credentials. El content script preload (preload-content.js)
// consume estos templates para auto-fill al detectar login + auto-save al
// detectar form submission.
//
// Para AGREGAR una plataforma nueva: agregá un entry al array TEMPLATES con
// los selectores correctos. Validá los selectores manualmente abriendo la
// página de login de la plataforma y haciendo `document.querySelector(...)`
// en DevTools — algunos sitios cambian selectores frecuentemente y hay que
// re-validarlos cada cierto tiempo (sub-bloque de mantenimiento futuro).
//
// 10 plataformas v1 del plan: X, Instagram, Facebook, TikTok, LinkedIn,
// YouTube (Google login), Reddit, Threads, Telegram, Discord.

const TEMPLATES = [
  {
    id: 'x',
    name: 'X / Twitter',
    hosts: ['x.com', 'twitter.com', 'mobile.twitter.com'],
    loginUrlPatterns: [
      /^https?:\/\/(x|twitter|mobile\.twitter)\.com\/(i\/flow\/login|login)/i,
    ],
    flow: 'two-step', // X separa username y password en dos screens
    selectors: {
      usernameInput: 'input[name="text"], input[autocomplete="username"]',
      passwordInput: 'input[name="password"], input[type="password"]',
      submitButton: '[data-testid="LoginForm_Login_Button"], button[type="submit"]',
      nextButton:
        '[role="button"]:has-text("Next"), [data-testid="LoginForm_Next_Button"]',
      loggedInIndicator: '[data-testid="primaryColumn"], a[aria-label="Profile"]',
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    hosts: ['instagram.com', 'www.instagram.com'],
    loginUrlPatterns: [/^https?:\/\/(www\.)?instagram\.com\/accounts\/login/i],
    flow: 'one-step',
    selectors: {
      usernameInput:
        'input[name="username"], input[aria-label="Phone number, username, or email"]',
      passwordInput: 'input[name="password"]',
      submitButton: 'button[type="submit"]',
      loggedInIndicator: 'svg[aria-label="Home"]',
    },
  },
  {
    id: 'facebook',
    name: 'Facebook',
    hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com'],
    loginUrlPatterns: [/^https?:\/\/(www\.|m\.)?facebook\.com\/(login|recover)/i],
    flow: 'one-step',
    selectors: {
      usernameInput: 'input[name="email"], input[id="email"]',
      passwordInput: 'input[name="pass"], input[id="pass"]',
      submitButton: 'button[name="login"], button[id="loginbutton"]',
      loggedInIndicator: '[aria-label="Account"], [data-testid="left_nav_menu"]',
    },
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    hosts: ['tiktok.com', 'www.tiktok.com'],
    loginUrlPatterns: [/^https?:\/\/(www\.)?tiktok\.com\/login/i],
    flow: 'one-step',
    selectors: {
      // TikTok requiere primero elegir login method (email/phone). Asumimos
      // email link clickeado. El user-flow real puede necesitar ajustes.
      usernameInput: 'input[name="username"], input[type="email"]',
      passwordInput: 'input[type="password"]',
      submitButton: 'button[data-e2e="login-button"], button[type="submit"]',
      loggedInIndicator: '[data-e2e="profile-icon"]',
    },
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    hosts: ['linkedin.com', 'www.linkedin.com'],
    loginUrlPatterns: [
      /^https?:\/\/(www\.)?linkedin\.com\/(login|uas\/login|checkpoint)/i,
    ],
    flow: 'one-step',
    selectors: {
      usernameInput: 'input#username, input[name="session_key"]',
      passwordInput: 'input#password, input[name="session_password"]',
      submitButton:
        'button[type="submit"][aria-label*="Sign in"], button[data-litms-control-urn*="login-submit"]',
      loggedInIndicator: '#global-nav, [data-test-app-aware-link]',
    },
  },
  {
    id: 'google',
    name: 'Google (YouTube login)',
    hosts: ['accounts.google.com'],
    loginUrlPatterns: [
      /^https?:\/\/accounts\.google\.com\/(signin|ServiceLogin|v3\/signin)/i,
    ],
    flow: 'two-step', // Google separa email y password
    selectors: {
      usernameInput: 'input[type="email"], input#identifierId',
      passwordInput: 'input[type="password"], input[name="Passwd"]',
      submitButton: 'button[type="button"][jsname="LgbsSe"]',
      nextButton: '#identifierNext button, #passwordNext button',
      loggedInIndicator: '[aria-label*="Google Account"]',
    },
  },
  {
    id: 'reddit',
    name: 'Reddit',
    hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com'],
    loginUrlPatterns: [/^https?:\/\/([a-z]+\.)?reddit\.com\/login/i],
    flow: 'one-step',
    selectors: {
      usernameInput: 'input[name="username"], input#loginUsername',
      passwordInput: 'input[name="password"], input#loginPassword',
      submitButton: 'button[type="submit"], button.AnimatedForm__submitButton',
      loggedInIndicator: '#USER_DROPDOWN_ID, [data-click-id="user"]',
    },
  },
  {
    id: 'threads',
    name: 'Threads',
    hosts: ['threads.net', 'www.threads.net'],
    loginUrlPatterns: [/^https?:\/\/(www\.)?threads\.net\/login/i],
    flow: 'one-step',
    selectors: {
      // Threads usa el mismo backend que Instagram para login.
      usernameInput: 'input[name="username"], input[autocomplete="username"]',
      passwordInput: 'input[name="password"], input[type="password"]',
      submitButton: 'button[type="submit"], div[role="button"]',
      loggedInIndicator: 'a[href="/"][role="link"]',
    },
  },
  {
    id: 'telegram',
    name: 'Telegram Web',
    hosts: ['web.telegram.org'],
    loginUrlPatterns: [/^https?:\/\/web\.telegram\.org\/(a|k|z)\/?(\?.*)?$/i],
    flow: 'phone-only', // Telegram usa phone+code, no password tradicional
    selectors: {
      // Phone number first
      usernameInput: 'input[type="tel"], input[name="phone"]',
      // El password no aplica el flujo standard — es código SMS / 2FA
      passwordInput: 'input[type="password"], input[name="2fa-password"]',
      submitButton: 'button[type="submit"], button.btn-primary',
      loggedInIndicator: '.chat-list, .chatlist',
    },
  },
  {
    id: 'discord',
    name: 'Discord',
    hosts: ['discord.com', 'discordapp.com'],
    loginUrlPatterns: [/^https?:\/\/discord(app)?\.com\/login/i],
    flow: 'one-step',
    selectors: {
      usernameInput: 'input[name="email"], input[type="email"]',
      passwordInput: 'input[name="password"], input[type="password"]',
      submitButton: 'button[type="submit"]',
      loggedInIndicator: '[class*="sidebar"], [class*="channels"]',
    },
  },
]

/**
 * Normalize a hostname for matching. Strips leading "www." and lowercases.
 * Returns null for invalid input.
 */
function _normalizeHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return null
  return hostname.toLowerCase().replace(/^www\./, '')
}

/**
 * Find the template that matches a hostname. Returns the template object or
 * null. Both the input host and template hosts are normalized for matching.
 */
function matchByHost(hostname) {
  const norm = _normalizeHost(hostname)
  if (!norm) return null
  for (const t of TEMPLATES) {
    for (const h of t.hosts) {
      if (_normalizeHost(h) === norm) return t
    }
  }
  return null
}

/**
 * Returns true if the URL looks like a login page for any known template.
 * Used by the content script to decide whether to inject credentials.
 */
function isLoginUrl(url) {
  if (!url || typeof url !== 'string') return false
  for (const t of TEMPLATES) {
    for (const re of t.loginUrlPatterns) {
      if (re.test(url)) return true
    }
  }
  return false
}

/**
 * Returns the template whose loginUrlPatterns matches the URL, or null.
 * Different from matchByHost in that it requires the URL to be a login page,
 * not just any page on the host.
 */
function matchByLoginUrl(url) {
  if (!url || typeof url !== 'string') return null
  for (const t of TEMPLATES) {
    for (const re of t.loginUrlPatterns) {
      if (re.test(url)) return t
    }
  }
  return null
}

/**
 * Returns the canonical "site" id for an account given a URL or hostname.
 * This is the value stored in account.site (e.g. "x.com" canonical form).
 *
 * Convention: account.site uses the FIRST host listed in the template (the
 * canonical one). For sites without a template, returns the normalized host.
 */
function siteIdForUrl(urlOrHost) {
  let host = urlOrHost
  try {
    if (urlOrHost.startsWith('http')) {
      host = new URL(urlOrHost).hostname
    }
  } catch (_e) {
    // not a URL — treat as hostname
  }
  const t = matchByHost(host)
  if (t) return t.hosts[0] // canonical
  return _normalizeHost(host)
}

module.exports = {
  TEMPLATES,
  matchByHost,
  matchByLoginUrl,
  isLoginUrl,
  siteIdForUrl,
}
