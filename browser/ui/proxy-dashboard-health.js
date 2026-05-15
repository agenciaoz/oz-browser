// OZ Browser — Proxy Dashboard health integration (H-2i, v1.1.4).
//
// Wraps window.oz.health.* (E2-C-6 anti-detect health backend) and exposes
// helpers that proxy-dashboard.js uses to decorate identity rows with
// coherence info (overall status pill + Apply-geo fix button when the
// ipTimezone vector flags a mismatch).
//
// Pattern matches proxy-dashboard-alerts.js / proxy-dashboard-actions.js:
// loaded as a sibling script, exposes window.OZ_DashboardHealth, never
// touches the DOM directly — render helpers return HTML strings the parent
// concatenates into <tr> markup.
//
// Doc: docs/modules/proxy-dashboard-health.md
// Backend module: anti-detect-health.js + anti-detect-health-handlers.js.

;(function () {
  // ---------------- fetch ----------------
  // Returns a Map<identityId, healthRecord>. Resilient — if the IPC bridge
  // is missing (early load, fresh install, bridge swap), returns an empty
  // Map so the caller falls back to the legacy leakRisk-only rendering.
  async function fetchHealthMap() {
    const map = new Map()
    if (!window.oz || !window.oz.health || typeof window.oz.health.list !== 'function') {
      return map
    }
    try {
      const records = await window.oz.health.list()
      if (!Array.isArray(records)) return map
      for (const r of records) {
        if (r && r.identityId) map.set(r.identityId, r)
      }
    } catch (_err) {
      // swallow — degraded render is preferable to crashing the dashboard.
    }
    return map
  }

  // ---------------- status derivation ----------------
  // Combines proxy presence (legacy "leakRisk") + healthRecord.overall into
  // a single status pill value for the identity row.
  //
  // Rules:
  //   - non-default identity without proxy   → 'red' (leak risk wins)
  //   - healthRecord absent                  → fall back to legacy (proxy?green:gray)
  //   - healthRecord.overall                 → green | yellow | red
  function deriveStatus(identity, healthRecord) {
    if (!identity.isDefault && !identity.proxy) return 'red'
    if (healthRecord && healthRecord.overall) {
      return healthRecord.overall
    }
    return identity.proxy ? 'green' : 'gray'
  }

  // Builds a one-line summary of the worst vector for the status pill
  // tooltip. Returns null if no problem worth surfacing.
  function buildStatusSummary(healthRecord, t) {
    if (!healthRecord || !healthRecord.vectors) return null
    const order = [
      'ipTimezone',
      'fingerprintCoherence',
      'cookieHealth',
      'proxyReachability',
    ]
    const rank = { red: 2, yellow: 1, green: 0, unknown: 0 }
    let worst = null
    for (const key of order) {
      const v = healthRecord.vectors[key]
      if (!v) continue
      const r = rank[v.status] || 0
      if (!worst || r > (rank[worst.status] || 0)) {
        worst = { key, ...v }
      }
    }
    if (!worst || (worst.status !== 'red' && worst.status !== 'yellow')) {
      return null
    }
    const labelMap = {
      ipTimezone: t('proxyDashboard.coherence.vectorIpTz', 'Timezone vs proxy'),
      fingerprintCoherence: t(
        'proxyDashboard.coherence.vectorFp',
        'Fingerprint coherence',
      ),
      cookieHealth: t('proxyDashboard.coherence.vectorCookies', 'Cookies'),
      proxyReachability: t('proxyDashboard.coherence.vectorProxy', 'Proxy reachability'),
    }
    return `${labelMap[worst.key] || worst.key}: ${worst.summary || worst.status}`
  }

  // ---------------- fix button ----------------
  // Returns the HTML for an inline "Apply geo" button to drop into the
  // Actions cell — or empty string if no actionable fix.
  //
  // Why only APPLY_GEO surfaces here: REROLL_FP / REASSIGN / MARK_RELOGIN
  // already have dedicated UI in health-modal + sidebar; surfacing all of
  // them inline would clutter the row. APPLY_GEO is the one fix that
  // directly resolves the "proxy in JP but TZ is Europe/Madrid" mismatch
  // — the most common anti-detect blunder users hit when stacking proxies
  // and identities.
  function renderFixButton(identity, healthRecord, t, esc) {
    if (!healthRecord || !healthRecord.vectors) return ''
    const ipTz = healthRecord.vectors.ipTimezone
    if (!ipTz || !ipTz.fix || ipTz.fix.kind !== 'apply-geo-suggestion') return ''
    // Don't surface for default identity (no proxy → fix doesn't apply).
    if (identity.isDefault) return ''
    const title = esc(
      ipTz.fix.label ||
        t('proxyDashboard.coherence.applyFixTitle', 'Apply proxy geo to fingerprint'),
    )
    return `<button data-act="apply-geo-fix" data-id="${esc(identity.id)}" title="${title}">🔧 ${t('proxyDashboard.coherence.applyFix', 'Apply geo')}</button>`
  }

  // ---------------- onChanged wiring ----------------
  // Returns an unsubscribe function. The dashboard wires this once at
  // start() so any applyFix from elsewhere (health-modal, sidebar, MCP)
  // triggers a re-fetch + re-render without polling.
  function subscribeChanged(onChange) {
    if (
      !window.oz ||
      !window.oz.health ||
      typeof window.oz.health.onChanged !== 'function'
    ) {
      return () => {}
    }
    try {
      return window.oz.health.onChanged(() => {
        try {
          onChange()
        } catch (_err) {
          // swallow — keep listener stable.
        }
      })
    } catch (_err) {
      return () => {}
    }
  }

  window.OZ_DashboardHealth = {
    fetchHealthMap,
    deriveStatus,
    buildStatusSummary,
    renderFixButton,
    subscribeChanged,
  }
})()
