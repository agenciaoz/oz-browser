// OZ Browser — Tasks module pure helpers (alpha.45).
//
// The sidebar gains a Tasks module (Ghost parity: checklists with progress).
// These pure functions own the list mutations + progress math so they are
// unit-testable with no DOM/Electron (ADR 0005). DOM wiring lives in
// sidebar-tasks.js; persistence is localStorage (key oz-tasks).
//
// A task = { id: string, text: string, done: boolean }.

;(function () {
  'use strict'

  function makeId() {
    return 'task-' + Math.random().toString(36).slice(2, 9)
  }

  /** Append a task. Empty/whitespace text → unchanged. Returns a new array. */
  function addTask(tasks, text) {
    const t = String(text || '').trim()
    if (!t) return (tasks || []).slice()
    return [...(tasks || []), { id: makeId(), text: t, done: false }]
  }

  /** Toggle the done flag of one task. Returns a new array. */
  function toggleTask(tasks, id) {
    return (tasks || []).map((x) => (x.id === id ? { ...x, done: !x.done } : x))
  }

  /** Remove a task by id. Returns a new array. */
  function removeTask(tasks, id) {
    return (tasks || []).filter((x) => x.id !== id)
  }

  /** Drop all completed tasks. Returns a new array. */
  function clearCompleted(tasks) {
    return (tasks || []).filter((x) => !x.done)
  }

  /** Progress summary: { done, total, pct } (pct 0–100, 0 when empty). */
  function progress(tasks) {
    const total = (tasks || []).length
    const done = (tasks || []).filter((x) => x.done).length
    const pct = total === 0 ? 0 : Math.round((done / total) * 100)
    return { done, total, pct }
  }

  /** Defensive: coerce arbitrary parsed JSON into a valid task array. */
  function sanitize(value) {
    if (!Array.isArray(value)) return []
    return value
      .filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string')
      .map((x) => ({ id: x.id, text: x.text, done: !!x.done }))
  }

  const api = {
    makeId,
    addTask,
    toggleTask,
    removeTask,
    clearCompleted,
    progress,
    sanitize,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') {
    window.OZ = window.OZ || {}
    window.OZ.SidebarTasksUtils = api
  }
})()
