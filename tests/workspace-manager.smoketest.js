// OZ Browser — WorkspaceManager smoke test (mock-Electron, Node-puro).
//
// Cómo correr:
//   cd oz-browser
//   node tests/workspace-manager.smoketest.js
//
// Cubre:
//   - _load() auto-crea Default workspace ("General Browsing")
//   - CRUD: create / update / rename / setColor / duplicate / archive / restore /
//     freeze / unfreeze / remove
//   - Default workspace protected (no archive, no remove)
//   - Frozen workspace rechaza update() pero acepta setTabSpecs()
//   - duplicate() copia tabSpecs con ids nuevos, marca isDefault=false
//   - tabSpecs management: setTabSpecs, getTabSpecs, append, remove,
//     setActiveTabId
//   - Persistencia round-trip
//   - Throttled save: setTimeout vs sync save según saveDelayMs
//   - flush() limpia pending timer
//
// NO cubre (requiere GUI / runtime real):
//   - Switch logic (TabbedBrowserWindow.switchToWorkspace) — bloque 1.4b
//   - Lock exclusivo de workspace por ventana — bloque 1.4b
//   - Drag-drop UI — bloque 1.4d

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ---------- Electron mock ----------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-ws-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

// ---------- Test runner ------------------------------------------------------

let passed = 0
let failed = 0
const failures = []

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

function section(name) {
  console.log(`\n— ${name} —`)
}

function freshWM(opts = {}) {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const mod = require('../browser/workspace-manager.js')
  return { mod, instance: new mod.WorkspaceManager(opts) }
}

// ---------- Tests ------------------------------------------------------------

console.log('OZ Browser — WorkspaceManager smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. _load auto-creates Default
section('_load() auto-crea Default workspace')
{
  const { instance: wm, mod } = freshWM()
  const list = wm.list()
  ok('list().length === 1', list.length === 1)
  ok('Default isDefault === true', list[0].isDefault === true)
  ok(
    `Default id === "${mod.DEFAULT_WORKSPACE_ID}"`,
    list[0].id === mod.DEFAULT_WORKSPACE_ID,
  )
  ok('Default name === "General Browsing"', list[0].name === 'General Browsing')
  ok(
    'Default tabSpecs === []',
    Array.isArray(list[0].tabSpecs) && list[0].tabSpecs.length === 0,
  )
  ok(
    `Default quickTabsMode === "${mod.DEFAULT_QUICK_TAB_MODE}"`,
    list[0].quickTabsMode === mod.DEFAULT_QUICK_TAB_MODE,
  )
}

// 2. create + update + rename + setColor
section('CRUD básico')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'Cliente A' })
  const b = wm.create({ name: 'Cliente B', color: '#abcdef' })
  ok('create devuelve id', a.id && b.id && a.id !== b.id)
  ok('total === 3 (default + 2)', wm.list().length === 3)
  ok('color custom respetado', b.color === '#abcdef')
  ok('color default auto-pickeado para A', a.color && a.color !== '#abcdef')

  const renamed = wm.rename(a.id, 'A-Renamed')
  ok('rename actualiza name', renamed && renamed.name === 'A-Renamed')

  const recolored = wm.setColor(a.id, '#000111')
  ok('setColor actualiza color', recolored && recolored.color === '#000111')

  const ignored = wm.update(a.id, { name: 'OK', isDefault: true })
  ok('update ignora fields no whitelisted (isDefault)', !ignored.isDefault)
}

// 3. duplicate
section('duplicate()')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'Source' })
  // Inject some tabSpecs first
  wm.setTabSpecs(a.id, [
    { id: 'tab-1', identityId: 'default', url: 'https://x.com', title: 'X' },
    { id: 'tab-2', identityId: 'default', url: 'https://ig.com', title: 'IG' },
  ])

  const dup = wm.duplicate(a.id)
  ok('duplicate retorna ws nuevo', dup && dup.id && dup.id !== a.id)
  ok('duplicate name === "Source (copy)"', dup.name === 'Source (copy)')
  ok('duplicate isDefault === false', dup.isDefault === false)
  ok('duplicate tabSpecs.length === 2', dup.tabSpecs.length === 2)
  const sameIdsAsSrc = dup.tabSpecs.some((t) => t.id === 'tab-1' || t.id === 'tab-2')
  ok('duplicate tabSpec ids regenerados (no comparte ids con source)', !sameIdsAsSrc)
  ok(
    'duplicate preserva url y title en tabSpecs',
    dup.tabSpecs[0].url === 'https://x.com' && dup.tabSpecs[0].title === 'X',
  )
}

// 4. archive / restore
section('archive() / restore()')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'A' })

  ok('archive(a) === true', wm.archive(a.id) === true)
  ok('a.isArchived === true', wm.get(a.id).isArchived === true)
  ok('listActive() excluye archivado', !wm.listActive().some((w) => w.id === a.id))
  ok(
    'list() incluye archivado',
    wm.list().some((w) => w.id === a.id),
  )

  ok('restore(a) === true', wm.restore(a.id) === true)
  ok('a.isArchived === false post-restore', wm.get(a.id).isArchived === false)
}

// 5. freeze / unfreeze + update bloqueado en frozen
section('freeze() bloquea update()')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'Frozen WS' })

  ok('freeze(a) === true', wm.freeze(a.id) === true)
  ok('a.isFrozen === true', wm.get(a.id).isFrozen === true)

  const updated = wm.update(a.id, { name: 'Cambio prohibido' })
  ok('update() en frozen retorna null', updated === null)
  ok('name no cambió', wm.get(a.id).name === 'Frozen WS')

  // setTabSpecs SÍ funciona aún frozen (es snapshot path)
  wm.setTabSpecs(a.id, [{ id: 't1', identityId: 'default', url: 'about:blank' }])
  ok('setTabSpecs funciona en frozen workspace', wm.getTabSpecs(a.id).length === 1)

  ok('unfreeze(a) === true', wm.unfreeze(a.id) === true)
  const updated2 = wm.update(a.id, { name: 'Ahora sí' })
  ok('update() funciona post-unfreeze', updated2 && updated2.name === 'Ahora sí')
}

// 6. Default protection
section('Default workspace protegido')
{
  const { instance: wm } = freshWM()
  const def = wm.getDefault()

  ok('archive(default) === false', wm.archive(def.id) === false)
  ok('default.isArchived === false', wm.get(def.id).isArchived === false)

  ok('remove(default) === false', wm.remove(def.id) === false)
  ok('Default sigue presente', wm.getDefault() && wm.getDefault().isDefault === true)
}

// 7. remove
section('remove() borra y libera')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'A' })
  ok('remove(a) === true', wm.remove(a.id) === true)
  ok('a removido', wm.get(a.id) === null)
  ok('total vuelve a 1 (solo default)', wm.list().length === 1)
}

// 8. tabSpecs management
section('tabSpecs management')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'TabbedWS' })

  wm.appendTabSpec(a.id, {
    id: 't1',
    identityId: 'default',
    url: 'https://a.com',
    title: 'A',
  })
  wm.appendTabSpec(a.id, {
    id: 't2',
    identityId: 'default',
    url: 'https://b.com',
    title: 'B',
  })
  ok('appendTabSpec acumula', wm.getTabSpecs(a.id).length === 2)

  ok('removeTabSpec encuentra y elimina', wm.removeTabSpec(a.id, 't1') === true)
  ok('post-remove length === 1', wm.getTabSpecs(a.id).length === 1)
  ok('removeTabSpec inexistente === false', wm.removeTabSpec(a.id, 'nope') === false)

  ok('setActiveTabId persiste', wm.setActiveTabId(a.id, 't2') === true)
  ok('get().activeTabId === "t2"', wm.get(a.id).activeTabId === 't2')

  // setTabSpecs sustituye la lista entera
  wm.setTabSpecs(
    a.id,
    [{ id: 'replaced', identityId: 'default', url: 'https://r.com', title: 'R' }],
    'replaced',
  )
  const post = wm.get(a.id)
  ok(
    'setTabSpecs reemplaza',
    post.tabSpecs.length === 1 && post.tabSpecs[0].id === 'replaced',
  )
  ok('setTabSpecs setea activeTabId si se pasa', post.activeTabId === 'replaced')
}

// 9. Persistencia round-trip
section('Persistencia workspaces.json')
{
  const { mod } = freshWM()
  const wm1 = new mod.WorkspaceManager()
  const a = wm1.create({ name: 'Persist A', color: '#001122' })
  wm1.setTabSpecs(a.id, [
    { id: 't1', identityId: 'default', url: 'https://persist.com', title: 'P' },
  ])
  wm1.freeze(a.id)

  // New instance reads from disk.
  const wm2 = new mod.WorkspaceManager()
  const list = wm2.list()
  const aReloaded = list.find((w) => w.name === 'Persist A')
  ok('round-trip total === 2', list.length === 2)
  ok('Persist A isFrozen persistido', aReloaded && aReloaded.isFrozen === true)
  ok('Persist A color persistido', aReloaded && aReloaded.color === '#001122')
  ok('Persist A tabSpecs persistido', aReloaded && aReloaded.tabSpecs.length === 1)
  ok(
    'Persist A tabSpecs[0].url persistido',
    aReloaded && aReloaded.tabSpecs[0].url === 'https://persist.com',
  )
}

// 10. Throttled save (saveDelayMs > 0)
section('Throttled save (debounce)')
{
  const { mod } = freshWM()
  const wm = new mod.WorkspaceManager({ saveDelayMs: 50 })
  const a = wm.create({ name: 'Throttled' })
  // After create the file should exist (create path uses _save which honors delay)
  // Burst 5 changes — should debounce to 1 final write.
  for (let i = 0; i < 5; i++) {
    wm.setTabSpecs(a.id, [
      { id: `t${i}`, identityId: 'default', url: `https://x${i}.com`, title: `T${i}` },
    ])
  }

  // Synchronous flush should write the latest state immediately.
  wm.flush()
  const wm2 = new mod.WorkspaceManager()
  const aReloaded = wm2.get(a.id)
  ok(
    'flush() persiste el último estado',
    aReloaded && aReloaded.tabSpecs.length === 1 && aReloaded.tabSpecs[0].id === 't4',
    aReloaded
      ? `tabSpecs=${JSON.stringify(aReloaded.tabSpecs)}`
      : 'workspace not found post-flush',
  )
}

// 11. Invalid quickTabsMode silently ignored
section('Invalid quickTabsMode ignorado')
{
  const { instance: wm, mod } = freshWM()
  const a = wm.create({ name: 'QT' })
  const before = a.quickTabsMode

  const updated = wm.update(a.id, { quickTabsMode: 'bogus-mode' })
  ok('update con modo inválido no rompe', updated !== null)
  ok('quickTabsMode no cambió', wm.get(a.id).quickTabsMode === before)

  const valid = mod.QUICK_TAB_MODES[1]
  const updated2 = wm.update(a.id, { quickTabsMode: valid })
  ok(`update con modo válido (${valid}) acepta`, updated2.quickTabsMode === valid)
}

// ---------- Cleanup ----------------------------------------------------------

// 12. H3a — identityIds[] field + addIdentity / removeIdentity
section('H3a identityIds[] + add/remove helpers')
{
  const { instance: wm } = freshWM()
  const def = wm.getDefault()
  ok(
    'Default ws has identityIds: []',
    Array.isArray(def.identityIds) && def.identityIds.length === 0,
  )

  wm.addIdentity(def.id, 'id-a')
  wm.addIdentity(def.id, 'id-b')
  wm.addIdentity(def.id, 'id-a') // idempotent
  ok('addIdentity is idempotent', wm.get(def.id).identityIds.length === 2)
  ok(
    'addIdentity persisted both ids',
    wm.get(def.id).identityIds.sort().join(',') === ['id-a', 'id-b'].sort().join(','),
  )

  wm.removeIdentity(def.id, 'id-a')
  wm.removeIdentity(def.id, 'nope') // missing-noop
  ok('removeIdentity removes target only', wm.get(def.id).identityIds.length === 1)
  ok('removeIdentity left id-b', wm.get(def.id).identityIds[0] === 'id-b')
}

// 13. H3a — D7: remove() rejects when ws has identities (no cascade)
section('H3a D7: remove rejects has-identities')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'A' })
  wm.addIdentity(a.id, 'id-x')
  wm.addIdentity(a.id, 'id-y')

  const r = wm.remove(a.id)
  ok(
    'remove without cascade returns has-identities',
    r && r.ok === false && r.reason === 'has-identities' && r.count === 2,
  )
  ok('workspace still present', !!wm.get(a.id))
}

// 14. H3a — D7: remove cascade=true with no locked identities
section('H3a D7: remove cascade=true with no locked')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'A' })
  wm.addIdentity(a.id, 'id-x')
  wm.addIdentity(a.id, 'id-y')

  // Mock host hooks: probe says no locked, run does nothing (test
  // verifies WorkspaceManager *invokes* the hook, not the cascade
  // semantics — those are integration-tested via the Browser host).
  const runCalls = []
  wm.setWorkspaceCascadeHooks({
    probe: () => ({ lockedCount: 0, movableCount: 2 }),
    run: (wsId, ids, dest) => runCalls.push({ wsId, ids, dest }),
  })

  const r = wm.remove(a.id, { cascade: true })
  ok('cascade=true returns true', r === true)
  ok('workspace removed', wm.get(a.id) === null)
  ok(
    'cascade run hook invoked once',
    runCalls.length === 1 &&
      runCalls[0].ids.length === 2 &&
      runCalls[0].dest === 'general',
  )
}

// 15. H3a — D7: remove blocks when has-locked-identities even with cascade
section('H3a D7: remove blocks has-locked-identities')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'A' })
  wm.addIdentity(a.id, 'id-locked')

  wm.setWorkspaceCascadeHooks({
    probe: () => ({ lockedCount: 1, movableCount: 0 }),
    run: () => {
      throw new Error('run should NOT be called when locked')
    },
  })

  const r = wm.remove(a.id, { cascade: true })
  ok(
    'cascade with locked → has-locked-identities',
    r && r.ok === false && r.reason === 'has-locked-identities' && r.lockedCount === 1,
  )
  ok('workspace still present (cascade aborted)', !!wm.get(a.id))
}

// 16. H3a — duplicate() resets identityIds[]
section('H3a duplicate resets identityIds')
{
  const { instance: wm } = freshWM()
  const a = wm.create({ name: 'A' })
  wm.addIdentity(a.id, 'id-x')
  wm.addIdentity(a.id, 'id-y')

  const dup = wm.duplicate(a.id)
  ok('duplicate has empty identityIds', dup.identityIds.length === 0)
  ok('source still has 2 identityIds', wm.get(a.id).identityIds.length === 2)
}

// 17. H3a — defensive backfill on _load (legacy data without identityIds[])
section('H3a defensive backfill on _load')
{
  // Wipe + write legacy-shaped workspaces.json (no identityIds field).
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  const fp = path.join(TEST_USERDATA, 'workspaces.json')
  fs.writeFileSync(
    fp,
    JSON.stringify([
      {
        id: 'general',
        name: 'General',
        color: '#aaa',
        isDefault: true,
        isArchived: false,
        isFrozen: false,
        quickTabsMode: 'on-click',
        createdAt: 1,
        updatedAt: 1,
        tabSpecs: [],
        activeTabId: null,
        // no identityIds
      },
      {
        id: 'legacy-x',
        name: 'Legacy',
        color: '#bbb',
        isDefault: false,
        isArchived: false,
        isFrozen: false,
        quickTabsMode: 'on-click',
        createdAt: 2,
        updatedAt: 2,
        tabSpecs: [],
        activeTabId: null,
      },
    ]),
  )
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  const wmMod = require('../browser/workspace-manager.js')
  const wm = new wmMod.WorkspaceManager()
  ok(
    'all workspaces backfilled with identityIds: []',
    wm.list().every((w) => Array.isArray(w.identityIds) && w.identityIds.length === 0),
  )
}

Module._load = originalLoad

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
