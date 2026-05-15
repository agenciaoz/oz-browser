// OZ Browser — Proxy Dashboard leak-test integration (H-2j, v1.1.4).
//
// Wraps window.oz.leakTest.* (leak-tests-handlers.js backend) and exposes
// helpers that proxy-dashboard.js uses to:
//   - hydrate a leakMap of cached results per identity on dashboard load
//   - render an inline "Leak test" button + small status badge per row
//   - run the test on demand and pop a detail dialog with the verdict
//
// Result detail is rendered as window.alert() in v1.1.4 — fancier modal
// arrives in a future polish pass. The point of v1.1.4 is to ship the
// test engine; visual depth comes later.
//
// Pattern matches proxy-dashboard-health.js — sibling script, exposes
// window.OZ_DashboardLeaks, returns HTML strings to the parent.
//
// Doc: docs/modules/proxy-dashboard-leaks.md
// Backend module: leak-tests.js + leak-tests-handlers.js.

;(function () {
  // ---------------- fetch ----------------
  // Hydrate cached results on dashboard load. Returns Map<identityId,
  // record>. No fresh runs — those happen on user click.
  async function fetchLeakMap() {
    const map = new Map()
    if (
      !window.oz ||
      !window.oz.leakTest ||
      typeof window.oz.leakTest.list !== 'function'
    ) {
      return map
    }
    try {
      const records = await window.oz.leakTest.list()
      if (!Array.isArray(records)) return map
      for (const r of records) {
        if (r && r.identityId) map.set(r.identityId, r)
      }
    } catch (_err) {
      // swallow
    }
    return map
  }

  // ---------------- render ----------------
  // Returns "<button + small badge>" HTML to drop into the Actions cell.
  // Hidden for default identity (no proxy to test against).
  function renderLeakButton(identity, leakRecord, t, esc) {
    if (identity.isDefault) return ''
    const status = leakRecord && leakRecord.overall ? leakRecord.overall : null
    const badge = status
      ? ` <span class="pill" data-status="${esc(status)}" title="${esc(buildLeakSummary(leakRecord, t))}">${esc(status)}</span>`
      : ''
    const title = esc(
      t(
        'proxyDashboard.leak.runTooltip',
        "Run WebRTC + DNS leak tests in a hidden window using this identity's session",
      ),
    )
    return `<button data-act="run-leak-test" data-id="${esc(identity.id)}" title="${title}">🛡️ ${t('proxyDashboard.leak.run', 'Leak test')}</button>${badge}`
  }

  // Builds the tooltip / dialog summary from a leak record. Concise enough
  // to fit in a title attr; the modal/dialog uses a fuller version.
  function buildLeakSummary(record, t) {
    if (!record) return ''
    const parts = []
    if (record.webrtc) {
      parts.push(
        `${t('proxyDashboard.leak.webrtc', 'WebRTC')}: ${record.webrtc.status} — ${record.webrtc.summary || '-'}`,
      )
    }
    if (record.dns) {
      parts.push(
        `${t('proxyDashboard.leak.dns', 'DNS')}: ${record.dns.status} — ${record.dns.summary || '-'}`,
      )
    }
    return parts.join('\n')
  }

  // ---------------- run ----------------
  // Invoked from proxy-dashboard-actions.js for 'run-leak-test'. Runs the
  // test, updates local cache, returns the record so the caller can
  // re-render + show a detail dialog.
  async function runLeakTest(identityId) {
    if (
      !window.oz ||
      !window.oz.leakTest ||
      typeof window.oz.leakTest.run !== 'function'
    ) {
      return { __error: { code: 'NO_BRIDGE', message: 'Leak test bridge unavailable' } }
    }
    return window.oz.leakTest.run({ identityId })
  }

  // ---------------- subscribe ----------------
  function subscribeChanged(onChange) {
    if (
      !window.oz ||
      !window.oz.leakTest ||
      typeof window.oz.leakTest.onChanged !== 'function'
    ) {
      return () => {}
    }
    try {
      return window.oz.leakTest.onChanged(() => {
        try {
          onChange()
        } catch (_err) {
          // swallow
        }
      })
    } catch (_err) {
      return () => {}
    }
  }

  // ---------------- result dialog ----------------
  // Renders the full result as a multiline string for window.alert. Calls
  // back to t() so it localizes.
  function formatResultDialog(record, t) {
    if (!record) return t('proxyDashboard.leak.noResult', 'No result.')
    if (record.__error) {
      return (
        t('proxyDashboard.leak.error', 'Leak test failed') +
        ': ' +
        (record.__error.message || record.__error.code || 'unknown')
      )
    }
    const lines = []
    lines.push(
      `🛡️ ${t('proxyDashboard.leak.title', 'Leak test result')} — ${record.identityName || record.identityId}`,
    )
    lines.push(`${t('proxyDashboard.leak.overall', 'Overall')}: ${record.overall}`)
    if (record.proxyName) {
      lines.push(
        `${t('proxyDashboard.leak.proxy', 'Proxy')}: ${record.proxyName}${
          record.proxyCountry ? ' (' + record.proxyCountry + ')' : ''
        }${record.proxyPublicIp ? ' · ' + record.proxyPublicIp : ''}`,
      )
    }
    lines.push('')
    if (record.webrtc) {
      lines.push(`WebRTC [${record.webrtc.status}] — ${record.webrtc.summary || ''}`)
      if (record.webrtc.srflxIps && record.webrtc.srflxIps.length) {
        lines.push(`  srflx: ${record.webrtc.srflxIps.join(', ')}`)
      }
      if (record.webrtc.leakedIps && record.webrtc.leakedIps.length) {
        lines.push(
          `  ${t('proxyDashboard.leak.leaked', 'leaked')}: ${record.webrtc.leakedIps.join(', ')}`,
        )
      }
    }
    if (record.dns) {
      lines.push(`DNS/IP [${record.dns.status}] — ${record.dns.summary || ''}`)
      if (record.dns.detectedIp) {
        lines.push(
          `  detected IP: ${record.dns.detectedIp}${record.dns.detectedCountry ? ' (' + record.dns.detectedCountry + ')' : ''}`,
        )
      }
    }
    return lines.join('\n')
  }

  window.OZ_DashboardLeaks = {
    fetchLeakMap,
    renderLeakButton,
    buildLeakSummary,
    runLeakTest,
    subscribeChanged,
    formatResultDialog,
  }
})()
