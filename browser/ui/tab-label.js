// OZ Browser — Tab display label (alpha.38).
//
// Builds the compact tab-strip label "Identity · RED" so you can tell at a
// glance which identity a tab belongs to (Jose's request, Ghost-style).
// The full page title stays in the tab tooltip.
//
// Pure (no DOM) → unit-testable. Dual-export (node + browser global).
//
// API:
//   networkAbbrev(url)  -> 'IG' | 'X' | ... | ''   (known social/site)
//   hostLabel(url)      -> 'google' | 'notion' | '' (registrable-ish word)
//   tabDisplayLabel(identityName, url) -> 'Contexto · IG'

;(function () {
  'use strict'

  // host substring (or exact) → abbreviation. Order matters (first match wins).
  const NETWORKS = [
    [/(^|\.)instagram\.com$/, 'IG'],
    [/(^|\.)(twitter\.com|x\.com)$/, 'X'],
    [/(^|\.)(facebook\.com|fb\.com)$/, 'FB'],
    [/(^|\.)tiktok\.com$/, 'TT'],
    [/(^|\.)(youtube\.com|youtu\.be)$/, 'YT'],
    [/(^|\.)linkedin\.com$/, 'IN'],
    [/(^|\.)threads\.(net|com)$/, 'TH'],
    [/(^|\.)(whatsapp\.com|web\.whatsapp\.com)$/, 'WA'],
    [/(^|\.)(telegram\.org|t\.me)$/, 'TG'],
    [/(^|\.)reddit\.com$/, 'RD'],
    [/(^|\.)pinterest\.(com|[a-z.]+)$/, 'PIN'],
    [/(^|\.)snapchat\.com$/, 'SC'],
    [/(^|\.)twitch\.tv$/, 'TW'],
    [/mail\.google\.com$/, 'GM'],
  ]

  function parseHost(url) {
    if (!url || typeof url !== 'string') return ''
    try {
      const u = new URL(url)
      if (!u.host) return ''
      return u.hostname.toLowerCase().replace(/^www\./, '')
    } catch (_e) {
      return ''
    }
  }

  function networkAbbrev(url) {
    const host = parseHost(url)
    if (!host) return ''
    for (const [re, abbr] of NETWORKS) {
      if (re.test(host)) return abbr
    }
    return ''
  }

  // Registrable-ish word: second-level label of the host (mail.google.com →
  // 'google', x.com → 'x'). '' for about:blank / chrome:// / no host.
  function hostLabel(url) {
    const host = parseHost(url)
    if (!host) return ''
    const parts = host.split('.').filter(Boolean)
    if (parts.length < 2) return parts[0] || ''
    return parts[parts.length - 2]
  }

  function tabDisplayLabel(identityName, url) {
    const name = (identityName || '').trim()
    const suffix = networkAbbrev(url) || hostLabel(url)
    if (name && suffix) return `${name} · ${suffix}`
    if (name) return name
    return suffix || 'New Tab'
  }

  const api = { networkAbbrev, hostLabel, tabDisplayLabel }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') {
    window.OZ = window.OZ || {}
    window.OZ.TabLabel = api
  }
})()
