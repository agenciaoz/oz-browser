// OZ Browser — Ghost Browser reader (G-1) smoke test — JSON paths.
//
// Cómo correr:
//   cd oz-browser
//   node tests/ghost-browser-reader.smoketest.js
//
// Cubre las funciones del reader que NO tocan SQLite:
//   - detectInstall: found / not found / version parsing
//   - readIdentitiesIndex: object/array shapes, missing, malformed, mixed
//   - readProjectsList: object/array shapes, missing, malformed
//   - readProject: basic, missing, multi-window dedup, no-identity tabs,
//     tab.identity → identityHash, favicon + graveyard preserved
//   - listProjectDirs: excludes archived, supports orphan detection
//   - readBookmarks: missing file, nested folders
//   - archived: missing dir, basic listing
//
// SQLite-touching tests live in ghost-browser-reader-sqlite.smoketest.js.

const fs = require('fs')
const path = require('path')

const helpers = require('./_helpers-ghost-fixtures.js')
const reader = require('../browser/migrations/ghost-browser-reader.js')

const ROOT = helpers.makeRoot('oz-ghost-reader-json-')
const mkInstall = (name) => helpers.mkInstall(ROOT, name)
const writeJson = helpers.writeJson

const { ok, section, done } = helpers.makeRunner(
  'OZ Browser — Ghost Browser reader (G-1) smoke test [JSON paths]',
)
console.log(`Test root: ${ROOT}`)

async function run() {
  // ---------- detectInstall ----------
  section('detectInstall')
  {
    const fakeHome = fs.mkdtempSync(path.join(ROOT, 'home-'))
    const ghostDefault = path.join(
      fakeHome,
      'Library/Application Support/GhostBrowser/Default',
    )
    fs.mkdirSync(ghostDefault, { recursive: true })
    writeJson(path.join(ghostDefault, 'Preferences'), {
      profile: { created_by_version: '136.0.7103.114' },
    })
    const r = reader.detectInstall({ homeDir: fakeHome })
    ok('found = true when Default/ exists', r.found === true)
    ok(
      'dataDir is the GhostBrowser path',
      r.dataDir && r.dataDir.endsWith('Library/Application Support/GhostBrowser'),
    )
    ok('version parsed from Preferences', r.version === '136.0.7103.114')
  }
  {
    const emptyHome = fs.mkdtempSync(path.join(ROOT, 'home-empty-'))
    const r = reader.detectInstall({ homeDir: emptyHome })
    ok('found = false when no GhostBrowser dir', r.found === false)
    ok('dataDir is null when not found', r.dataDir === null)
    ok('version is null when not found', r.version === null)
  }
  {
    const fakeHome = fs.mkdtempSync(path.join(ROOT, 'home-no-prefs-'))
    fs.mkdirSync(
      path.join(fakeHome, 'Library/Application Support/GhostBrowser/Default'),
      { recursive: true },
    )
    const r = reader.detectInstall({ homeDir: fakeHome })
    ok('found = true even without Preferences', r.found === true)
    ok('version = null when no Preferences', r.version === null)
  }

  // ---------- readIdentitiesIndex ----------
  section('readIdentitiesIndex')
  {
    const dir = mkInstall('idx-obj')
    writeJson(path.join(dir, 'Default/Identities/identities.json'), {
      identities: ['hashA', 'hashB', 'hashC'],
    })
    const r = reader.readIdentitiesIndex(dir)
    ok('returns array of 3 hashes', r.length === 3)
    ok('preserves order', r[0] === 'hashA' && r[2] === 'hashC')
  }
  {
    const dir = mkInstall('idx-arr')
    writeJson(path.join(dir, 'Default/Identities/identities.json'), ['h1', 'h2'])
    const r = reader.readIdentitiesIndex(dir)
    ok('accepts bare-array shape', r.length === 2 && r[0] === 'h1')
  }
  {
    const dir = mkInstall('idx-missing')
    const r = reader.readIdentitiesIndex(dir)
    ok('missing file → empty array', Array.isArray(r) && r.length === 0)
  }
  {
    const dir = mkInstall('idx-malformed')
    fs.writeFileSync(
      path.join(dir, 'Default/Identities/identities.json'),
      '{not valid json',
    )
    const r = reader.readIdentitiesIndex(dir)
    ok('malformed JSON → empty array (no throw)', Array.isArray(r) && r.length === 0)
  }
  {
    const dir = mkInstall('idx-mixed')
    writeJson(path.join(dir, 'Default/Identities/identities.json'), {
      identities: ['validHash', 42, null, 'anotherHash'],
    })
    const r = reader.readIdentitiesIndex(dir)
    ok(
      'non-string entries filtered',
      r.length === 2 && r[0] === 'validHash' && r[1] === 'anotherHash',
    )
  }

  // ---------- readProjectsList ----------
  section('readProjectsList')
  {
    const dir = mkInstall('rpl-obj')
    writeJson(path.join(dir, 'Default/Projects/projects_list.json'), {
      projects: ['uuid-1', 'uuid-2'],
      projects_number: 2,
    })
    const r = reader.readProjectsList(dir)
    ok('parses { projects: [...] } shape', r.length === 2 && r[0] === 'uuid-1')
  }
  {
    const dir = mkInstall('rpl-arr')
    writeJson(path.join(dir, 'Default/Projects/projects_list.json'), ['u1', 'u2', 'u3'])
    const r = reader.readProjectsList(dir)
    ok('accepts bare-array shape', r.length === 3)
  }
  {
    const dir = mkInstall('rpl-missing')
    const r = reader.readProjectsList(dir)
    ok('missing file → []', r.length === 0)
  }
  {
    const dir = mkInstall('rpl-malformed')
    fs.writeFileSync(path.join(dir, 'Default/Projects/projects_list.json'), 'garbage{')
    const r = reader.readProjectsList(dir)
    ok('malformed → []', r.length === 0)
  }

  // ---------- readProject ----------
  section('readProject')
  {
    const dir = mkInstall('rp-basic')
    const uuid = 'def69364'
    writeJson(path.join(dir, 'Default/Projects', uuid, 'project.json'), {
      id: uuid,
      name: 'El Informe',
      graveyard: { 'dead-tab': '13422' },
      windows: [
        {
          guid: 'w1',
          active_tab: 0,
          tabs: [
            {
              guid: 't1',
              identity: 'hashA',
              url: 'https://tiktok.com/',
              title: 'TikTok',
              favicon: 'data:image/png;base64,AAAA',
            },
            {
              guid: 't2',
              identity: 'hashA',
              url: 'https://google.com/',
              title: 'Google',
            },
            {
              guid: 't3',
              identity: 'hashB',
              url: 'https://instagram.com/',
              title: 'IG',
            },
          ],
        },
      ],
    })
    const r = reader.readProject(dir, uuid)
    ok('id matches', r.id === uuid)
    ok('name matches', r.name === 'El Informe')
    ok('tabs count = 3', r.tabs.length === 3)
    ok(
      'identities Set deduped to 2 (hashA + hashB)',
      r.identities.size === 2 && r.identities.has('hashA') && r.identities.has('hashB'),
    )
    ok(
      'tab.identity → tab.identityHash',
      r.tabs[0].identityHash === 'hashA' && r.tabs[2].identityHash === 'hashB',
    )
    ok('favicon preserved', r.tabs[0].favicon.startsWith('data:image'))
    ok('graveyard preserved', !!r.graveyard['dead-tab'])
  }
  {
    const dir = mkInstall('rp-multi-window')
    const uuid = 'multi'
    writeJson(path.join(dir, 'Default/Projects', uuid, 'project.json'), {
      id: uuid,
      name: 'Multi',
      windows: [
        { tabs: [{ identity: 'A', url: 'u1' }] },
        { tabs: [{ identity: 'B', url: 'u2' }] },
        { tabs: [{ identity: 'A', url: 'u3' }] },
      ],
    })
    const r = reader.readProject(dir, uuid)
    ok('multi-window flattens to single tabs array', r.tabs.length === 3)
    ok('identities deduped across windows', r.identities.size === 2)
    ok('windows array preserved length', r.windows.length === 3)
  }
  {
    const dir = mkInstall('rp-missing')
    const r = reader.readProject(dir, 'no-such-uuid')
    ok('missing project → null', r === null)
  }
  {
    const dir = mkInstall('rp-no-identity-key')
    const uuid = 'no-id'
    writeJson(path.join(dir, 'Default/Projects', uuid, 'project.json'), {
      id: uuid,
      windows: [{ tabs: [{ url: 'orphan' }] }],
    })
    const r = reader.readProject(dir, uuid)
    ok(
      'tabs without identity → identityHash=null',
      r.tabs[0].identityHash === null && r.identities.size === 0,
    )
  }

  // ---------- listProjectDirs ----------
  section('listProjectDirs')
  {
    const dir = mkInstall('lpd')
    fs.mkdirSync(path.join(dir, 'Default/Projects/uuid-A'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'Default/Projects/uuid-B'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'Default/Projects/archived'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(dir, 'Default/Projects/archived/old-uuid'), {
      recursive: true,
    })
    writeJson(path.join(dir, 'Default/Projects/projects_list.json'), {
      projects: ['uuid-A'],
    })
    const dirs = reader.listProjectDirs(dir)
    ok('lists 2 dirs', dirs.length === 2)
    ok('archived dir excluded', !dirs.includes('archived') && dirs.includes('uuid-A'))
    const listed = reader.readProjectsList(dir)
    const orphans = dirs.filter((d) => !listed.includes(d))
    ok('orphan detection works (uuid-B is orphan)', orphans[0] === 'uuid-B')
  }
  {
    const dir = mkInstall('lpd-missing')
    fs.rmSync(path.join(dir, 'Default/Projects'), { recursive: true })
    ok('missing Projects dir → []', reader.listProjectDirs(dir).length === 0)
  }

  // ---------- readBookmarks ----------
  section('readBookmarks')
  {
    const dir = mkInstall('bk-missing')
    const r = reader.readBookmarks(dir)
    ok('missing Bookmarks → []', r.length === 0)
  }
  {
    const dir = mkInstall('bk-basic')
    writeJson(path.join(dir, 'Default/Bookmarks'), {
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: 'Bookmarks Bar',
          children: [
            {
              type: 'url',
              url: 'https://a.com',
              name: 'A',
              date_added: '1000',
            },
            {
              type: 'folder',
              name: 'Work',
              children: [
                {
                  type: 'url',
                  url: 'https://b.com',
                  name: 'B',
                  date_added: '2000',
                },
              ],
            },
          ],
        },
        other: { type: 'folder', name: 'Other', children: [] },
      },
    })
    const r = reader.readBookmarks(dir)
    ok('flattens nested folders to 2 bookmarks', r.length === 2)
    ok(
      'folder path is nested',
      r[1].folder === 'Bookmarks Bar/Work' && r[0].folder === 'Bookmarks Bar',
    )
    ok(
      'url + title + dateAdded preserved',
      r[0].url === 'https://a.com' && r[0].title === 'A' && r[0].dateAdded === '1000',
    )
  }

  // ---------- archived ----------
  section('archived')
  {
    const dir = mkInstall('arc-missing')
    const r = reader.archived(dir)
    ok('missing archived dir → []', r.length === 0)
  }
  {
    const dir = mkInstall('arc-basic')
    fs.mkdirSync(path.join(dir, 'Default/Projects/archived/old-uuid-1'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(dir, 'Default/Projects/archived/old-uuid-2'), {
      recursive: true,
    })
    const r = reader.archived(dir)
    ok('lists archived uuids', r.length === 2 && r.includes('old-uuid-1'))
  }

  done()
}

run()
  .catch((e) => {
    console.error('UNCAUGHT:', e.stack || e.message)
    process.exit(1)
  })
  .finally(() => {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
  })
