// OZ Browser — Publishing Studio local store (v2 Etapa 4-A).
//
// Persists caption templates, hashtag groups, and a media library in
// localStorage (the WebUI extension origin). No backend — these are authoring
// conveniences that work today. `createStore(storage)` takes an injectable
// storage ({ getItem, setItem }) so it is unit-testable.
//
// Exposes window.OZ.publishingStore (a live instance). In Node it exports
// { createStore }. Tests: tests/publishing-store.smoketest.js

;(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else {
    const api = factory()
    const root = typeof window !== 'undefined' ? window : globalThis
    root.OZ = root.OZ || {}
    let storage = null
    try {
      storage = root.localStorage || null
    } catch (_e) {
      storage = null
    }
    root.OZ.publishingStore = api.createStore(storage)
    root.OZ.publishingStore.createStore = api.createStore
  }
})(function () {
  'use strict'

  const KEYS = {
    templates: 'oz-pub-templates',
    hashtagGroups: 'oz-pub-hashtag-groups',
    media: 'oz-pub-media-library',
  }

  function _id() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  function createStore(storage) {
    // In-memory fallback so the API never throws when storage is missing.
    const mem = {}
    const back = storage || {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => {
        mem[k] = String(v)
      },
    }

    function _read(key) {
      try {
        const raw = back.getItem(key)
        const arr = raw ? JSON.parse(raw) : []
        return Array.isArray(arr) ? arr : []
      } catch (_e) {
        return []
      }
    }
    function _write(key, arr) {
      try {
        back.setItem(key, JSON.stringify(arr))
      } catch (_e) {
        /* quota / unavailable — best effort */
      }
      return arr
    }

    // ── Templates: { id, name, caption, hashtags[] } ──────────────────
    function listTemplates() {
      return _read(KEYS.templates)
    }
    function saveTemplate({ name, caption, hashtags } = {}) {
      const all = _read(KEYS.templates)
      const item = {
        id: _id(),
        name: String(name || 'Untitled').slice(0, 80),
        caption: String(caption || ''),
        hashtags: Array.isArray(hashtags) ? hashtags.slice() : [],
      }
      all.unshift(item)
      _write(KEYS.templates, all)
      return item
    }
    function removeTemplate(id) {
      _write(
        KEYS.templates,
        _read(KEYS.templates).filter((x) => x.id !== id),
      )
    }

    // ── Hashtag groups: { id, name, tags[] } ──────────────────────────
    function listHashtagGroups() {
      return _read(KEYS.hashtagGroups)
    }
    function saveHashtagGroup({ name, tags } = {}) {
      const all = _read(KEYS.hashtagGroups)
      const item = {
        id: _id(),
        name: String(name || 'Group').slice(0, 60),
        tags: (Array.isArray(tags) ? tags : [])
          .map((t) => String(t).trim().replace(/^#+/, ''))
          .filter(Boolean),
      }
      all.unshift(item)
      _write(KEYS.hashtagGroups, all)
      return item
    }
    function removeHashtagGroup(id) {
      _write(
        KEYS.hashtagGroups,
        _read(KEYS.hashtagGroups).filter((x) => x.id !== id),
      )
    }

    // ── Media library: array of absolute paths (deduped) ──────────────
    function listMedia() {
      return _read(KEYS.media)
    }
    function addMedia(path) {
      const p = String(path || '').trim()
      if (!p) return listMedia()
      const all = _read(KEYS.media).filter((x) => x !== p)
      all.unshift(p)
      return _write(KEYS.media, all.slice(0, 200))
    }
    function removeMedia(path) {
      return _write(
        KEYS.media,
        _read(KEYS.media).filter((x) => x !== path),
      )
    }

    return {
      KEYS,
      listTemplates,
      saveTemplate,
      removeTemplate,
      listHashtagGroups,
      saveHashtagGroup,
      removeHashtagGroup,
      listMedia,
      addMedia,
      removeMedia,
    }
  }

  return { createStore }
})
