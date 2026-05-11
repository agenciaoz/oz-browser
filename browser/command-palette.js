// OZ Browser — Command Palette (C-1) data layer.
//
// Pure module: builds the searchable command list from runtime sources
// (identities, workspaces, open tabs) plus a static set of actions, scores
// candidates against a user query using a VS-Code-style fuzzy match, and
// returns a ranked array of matches with character indices for highlighting.
//
// No Electron / DOM / IO. Testable in plain Node.
//
// Categories ordered by typical relevance:
//   1. action      — verb-style commands (New Tab, Lock Tab, Snapshot, etc.)
//   2. tab         — currently open tabs in the focused window
//   3. identity    — switch to / open new tab in
//   4. workspace   — switch to workspace
//
// Each command has the shape:
//   {
//     id:       string  — stable opaque id ('action:new-tab', 'identity:abc')
//     type:     'action' | 'tab' | 'identity' | 'workspace'
//     label:    string  — primary text shown in the result row
//     hint?:    string  — secondary text shown muted on the right
//     subtitle?:string  — small grey line under the label (eg. tab URL)
//     keywords?:string  — extra terms appended to the search corpus
//     accent?:  string  — color swatch (#hex) shown on the left
//     emoji?:   string  — icon char
//     payload:  any     — opaque object the UI reads to execute the command
//   }
//
// Action payloads use a discriminated `action` field so the renderer can
// dispatch with a single switch:
//   { action: 'new-tab' }
//   { action: 'lock-tab', tabId }
//   { action: 'open-modal', modal: 'settings' }
// ...etc.

'use strict'

/**
 * Build the full command list from runtime data.
 *
 * @param {object} sources
 * @param {Array}  sources.identities          — IdentityManager.list() output
 * @param {Array}  sources.workspaces          — WorkspaceManager.list() output
 * @param {Array}  sources.tabs                — current window's tab list
 * @param {string} [sources.activeIdentityId]
 * @param {string} [sources.activeWorkspaceId]
 * @param {string} [sources.focusedTabId]
 * @returns {Array} command list (never null)
 */
function buildCommands(sources) {
  const {
    identities = [],
    workspaces = [],
    tabs = [],
    activeIdentityId = null,
    activeWorkspaceId = null,
    focusedTabId = null,
  } = sources || {}

  const out = []

  // Build action payloads with the current focused-tab id baked in so the
  // renderer's executor doesn't need to re-lookup focus state at execute
  // time (which would be stale by the time the user picks a row).
  const tabAction = (action) =>
    focusedTabId ? { action, tabId: focusedTabId } : { action }

  // ── Static actions ──
  // Ordered by typical productivity value. Each action lists keywords that
  // help fuzzy match catch synonyms ("preferences" → settings).
  const actions = [
    {
      id: 'action:new-tab',
      label: 'New Tab',
      hint: '⌘T',
      keywords: 'open create blank',
      emoji: '➕',
      payload: { action: 'new-tab', identityId: activeIdentityId },
    },
    {
      id: 'action:new-identity',
      label: 'New Identity',
      hint: '⌥N',
      keywords: 'create persona profile account',
      emoji: '👤',
      payload: { action: 'new-identity' },
    },
    {
      id: 'action:duplicate-tab',
      label: 'Duplicate Tab',
      hint: '⌥D',
      keywords: 'clone copy',
      emoji: '⎘',
      payload: tabAction('duplicate-tab'),
    },
    {
      id: 'action:reopen-closed-tab',
      label: 'Reopen Closed Tab',
      hint: '⇧⌘T',
      keywords: 'undo restore last',
      emoji: '↩︎',
      payload: { action: 'reopen-closed-tab' },
    },
    {
      id: 'action:toggle-pin',
      label: 'Pin / Unpin Tab',
      hint: '⌥P',
      keywords: 'fix sticky',
      emoji: '📌',
      payload: tabAction('toggle-pin'),
    },
    {
      id: 'action:toggle-lock',
      label: 'Lock / Unlock Tab',
      hint: '⌥L',
      keywords: 'protect freeze prevent close',
      emoji: '🔒',
      payload: tabAction('toggle-lock'),
    },
    {
      id: 'action:move-to-new-window',
      label: 'Move Tab to New Window',
      hint: '⌥S',
      keywords: 'detach split',
      emoji: '🪟',
      payload: tabAction('move-to-new-window'),
    },
    {
      id: 'action:take-snapshot',
      label: 'Take Snapshot Now',
      hint: '⇧⌘B',
      keywords: 'backup time machine save state',
      emoji: '📸',
      payload: { action: 'take-snapshot' },
    },
    {
      id: 'action:open-time-machine',
      label: 'Open Time Machine',
      keywords: 'backup restore snapshots history',
      emoji: '⏱',
      payload: { action: 'open-modal', modal: 'timeMachine' },
    },
    {
      id: 'action:open-vault',
      label: 'Open Account Vault',
      keywords: 'accounts passwords credentials autofill',
      emoji: '🔐',
      payload: { action: 'open-modal', modal: 'accountManager' },
    },
    {
      id: 'action:open-proxies',
      label: 'Open Proxies',
      keywords: 'proxy oxylabs ip network',
      emoji: '🌐',
      payload: { action: 'open-modal', modal: 'proxyManager' },
    },
    {
      id: 'action:open-browsing-data',
      label: 'Open Browsing Data',
      keywords: 'bookmarks history downloads',
      emoji: '📚',
      payload: { action: 'open-modal', modal: 'browsingData' },
    },
    {
      id: 'action:open-settings',
      label: 'Open Settings',
      keywords: 'preferences config options',
      emoji: '⚙️',
      payload: { action: 'open-modal', modal: 'settings' },
    },
    {
      id: 'action:open-bulk-opener',
      label: 'Bulk Open Identities…',
      hint: '⌥⇧O',
      keywords: 'multi account batch many open mass',
      emoji: '🎯',
      payload: { action: 'open-modal', modal: 'bulkOpener' },
    },
    {
      id: 'action:toggle-devtools',
      label: 'Toggle DevTools',
      hint: '⇧⌘J',
      keywords: 'inspector debug',
      emoji: '🛠',
      payload: { action: 'toggle-devtools' },
    },
  ]
  for (const a of actions) out.push({ type: 'action', ...a })

  // ── Identities ──
  // "Switch to Identity X" — selects identity (active) and opens new tab if
  // there's no live tab for that identity. UI decides exact behavior; data
  // layer just hands over identityId.
  for (const i of identities) {
    if (!i || !i.id) continue
    const isActive = i.id === activeIdentityId
    const locked = i.locked ? ' 🔒' : ''
    out.push({
      id: `identity:${i.id}`,
      type: 'identity',
      label: `${i.name || 'Identity'}${locked}`,
      hint: isActive ? 'active' : 'identity',
      subtitle: i.id === 'default' ? 'Default identity' : undefined,
      keywords: `persona profile ${i.name || ''}`,
      accent: i.color || undefined,
      payload: { action: 'switch-identity', identityId: i.id },
    })
  }

  // ── Workspaces ──
  for (const w of workspaces) {
    if (!w || !w.id) continue
    // H3a archived workspaces still surface but tagged so the user knows.
    if (w.isArchived) continue
    const isActive = w.id === activeWorkspaceId
    const frozen = w.isFrozen ? ' 🔒' : ''
    out.push({
      id: `workspace:${w.id}`,
      type: 'workspace',
      label: `${w.name || 'Workspace'}${frozen}`,
      hint: isActive ? 'active' : 'workspace',
      keywords: `space project ${w.name || ''}`,
      accent: w.color || undefined,
      payload: { action: 'switch-workspace', workspaceId: w.id },
    })
  }

  // ── Tabs (focused window only) ──
  for (const t of tabs) {
    if (!t || t.id == null) continue
    const title = t.title || t.url || 'Untitled'
    const isFocused = t.id === focusedTabId
    const locked = t.locked ? ' 🔒' : ''
    const pinned = t.pinned ? ' 📌' : ''
    out.push({
      id: `tab:${t.id}`,
      type: 'tab',
      label: `${title}${locked}${pinned}`,
      hint: isFocused ? 'focused' : 'tab',
      subtitle: t.url || undefined,
      keywords: t.url || '',
      payload: { action: 'select-tab', tabId: t.id },
    })
  }

  return out
}

// Fuzzy scoring constants.  Calibrated against typical productivity-app
// behavior: prefix match dominates, then word-start matches, then any
// subsequence. Consecutive characters give a sharp bonus so "newt" ranks
// "New Tab" above "Notion (new tickets)".
const SCORE_EXACT = 100 // entire query is a substring of label
const SCORE_PREFIX = 60 // label starts with the query
const SCORE_PER_CHAR = 8 // every matched character
const BONUS_WORD_START = 12 // matched char follows a space / `-` / `_` / `/`
const BONUS_CAMEL = 8 // matched char is uppercase after lowercase
const BONUS_FIRST = 14 // first character of the label
const BONUS_CONSECUTIVE = 10 // matched char follows another matched char
const PENALTY_GAP = 1 // each unmatched character between matches

/** Word-boundary detection: classify `prev` char to decide if the next match
 *  is at a word start. Returns true for space-class delimiters. */
function isBoundary(ch) {
  return ch === ' ' || ch === '-' || ch === '_' || ch === '/' || ch === '.'
}

/**
 * Score `query` against `text`.  Returns:
 *   { score: number, indices: number[] }   on match
 *   null                                   on no match
 *
 * Greedy first-match — leftmost subsequence wins (good enough for short
 * labels; matches VS Code's filepath quickopen well-enough for UX needs).
 */
function fuzzyMatch(query, text) {
  if (typeof query !== 'string' || typeof text !== 'string') return null
  if (query.length === 0) return { score: 0, indices: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q.length > t.length) return null

  // Fast path — exact substring.
  const idx = t.indexOf(q)
  if (idx !== -1) {
    const indices = []
    for (let i = 0; i < q.length; i++) indices.push(idx + i)
    let score = SCORE_EXACT + q.length * SCORE_PER_CHAR
    if (idx === 0) score += SCORE_PREFIX + BONUS_FIRST
    else if (isBoundary(t.charCodeAt(idx - 1) ? t[idx - 1] : '')) {
      score += BONUS_WORD_START
    }
    return { score, indices }
  }

  // Subsequence walk.
  const indices = []
  let ti = 0
  let qi = 0
  let prevMatched = false
  let score = 0
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      indices.push(ti)
      score += SCORE_PER_CHAR
      if (ti === 0) score += BONUS_FIRST
      else {
        const prev = t[ti - 1]
        if (isBoundary(prev)) score += BONUS_WORD_START
        // Detect camelCase boundary by looking at the *original* (cased) text.
        if (text[ti - 1] !== prev && text[ti].toLowerCase() === text[ti]) {
          // no-op; we only bonus when going lower→Upper which we can't see
          // post-toLowerCase. Skip until we keep original casing parallel.
        }
        if (
          text[ti] >= 'A' &&
          text[ti] <= 'Z' &&
          text[ti - 1] >= 'a' &&
          text[ti - 1] <= 'z'
        ) {
          score += BONUS_CAMEL
        }
        if (prevMatched) score += BONUS_CONSECUTIVE
      }
      qi += 1
      prevMatched = true
    } else {
      if (prevMatched) score -= PENALTY_GAP
      prevMatched = false
    }
    ti += 1
  }
  if (qi < q.length) return null
  return { score, indices }
}

/**
 * Score a command against `query` over a corpus of {label, keywords, subtitle}.
 * Returns null if no field matches. Score = best-field-score (so matching
 * a label gives more weight than matching a hidden keyword).
 */
function scoreCommand(command, query) {
  if (!query) return { score: 0, indices: [], field: 'label' }
  // Try label first — its indices are the ones used for highlighting.
  const m = fuzzyMatch(query, command.label || '')
  let best = m ? { ...m, field: 'label' } : null
  // Keywords are hidden — score them at -20% so they don't out-rank label hits.
  if (command.keywords) {
    const k = fuzzyMatch(query, command.keywords)
    if (k) {
      const adjusted = { score: k.score * 0.8, indices: [], field: 'keywords' }
      if (!best || adjusted.score > best.score) best = adjusted
    }
  }
  if (command.subtitle) {
    const s = fuzzyMatch(query, command.subtitle)
    if (s) {
      const adjusted = { score: s.score * 0.6, indices: [], field: 'subtitle' }
      if (!best || adjusted.score > best.score) best = adjusted
    }
  }
  return best
}

// Category ordering tiebreaker — when scores tie, prefer the category that
// is most likely to be what the user wants.
const TYPE_ORDER = { action: 0, tab: 1, identity: 2, workspace: 3 }

/**
 * Match + rank commands against `query`. With no query, returns commands
 * in default order: actions first, then tabs (focused first), identities
 * (active first), workspaces (active first).
 *
 * @param {Array}  commands
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=50] — max results returned
 * @returns {Array<{command, score, indices}>}
 */
function matchAndRank(commands, query, opts) {
  const limit = (opts && opts.limit) || 50
  const trimmed = typeof query === 'string' ? query.trim() : ''

  if (!trimmed) {
    // Empty query — return the natural order with a small score so the
    // UI can render and selection logic is uniform.
    const out = commands.slice(0, limit).map((c, idx) => ({
      command: c,
      score: -idx,
      indices: [],
    }))
    return out
  }

  const matched = []
  for (const c of commands) {
    const r = scoreCommand(c, trimmed)
    if (r && r.score > 0) {
      matched.push({ command: c, score: r.score, indices: r.indices })
    }
  }
  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Stable secondary sort by type then label, so two tabs with the same
    // score don't reorder randomly between renders.
    const ta = TYPE_ORDER[a.command.type] ?? 99
    const tb = TYPE_ORDER[b.command.type] ?? 99
    if (ta !== tb) return ta - tb
    return (a.command.label || '').localeCompare(b.command.label || '')
  })
  return matched.slice(0, limit)
}

module.exports = {
  buildCommands,
  fuzzyMatch,
  scoreCommand,
  matchAndRank,
  // Exported for tests / future tuning.
  _constants: {
    SCORE_EXACT,
    SCORE_PREFIX,
    SCORE_PER_CHAR,
    BONUS_WORD_START,
    BONUS_CAMEL,
    BONUS_FIRST,
    BONUS_CONSECUTIVE,
    PENALTY_GAP,
    TYPE_ORDER,
  },
}
