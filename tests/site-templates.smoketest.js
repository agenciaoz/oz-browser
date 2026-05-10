// OZ Browser — Site templates smoke test (1.5c).
//
// Cómo correr:
//   cd oz-browser
//   node tests/site-templates.smoketest.js
//
// Cubre:
//   - matchByHost detecta correctamente las 10 plataformas
//   - matchByHost normaliza www. y case (X.com, X.COM, www.x.com → x)
//   - matchByHost devuelve null para hosts desconocidos
//   - isLoginUrl detecta /login pages para cada plataforma
//   - isLoginUrl rechaza URLs que NO son login (homepage, perfil, etc.)
//   - matchByLoginUrl devuelve el template correcto para login URLs
//   - siteIdForUrl devuelve canonical host (primer host del template)
//   - Cada template tiene los selectores requeridos
//   - Each loginUrlPattern es regex válida

const {
  TEMPLATES,
  matchByHost,
  isLoginUrl,
  matchByLoginUrl,
  siteIdForUrl,
} = require('../browser/site-templates.js')

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

console.log('OZ Browser — Site templates smoke test')

// 1. Estructura de templates
section('Estructura de templates')
{
  ok('TEMPLATES.length === 10', TEMPLATES.length === 10, `length=${TEMPLATES.length}`)
  for (const t of TEMPLATES) {
    ok(
      `${t.id}: tiene id/name/hosts/loginUrlPatterns/flow/selectors`,
      t.id &&
        t.name &&
        Array.isArray(t.hosts) &&
        Array.isArray(t.loginUrlPatterns) &&
        t.flow &&
        t.selectors,
    )
    ok(`${t.id}: hosts array no-vacío`, t.hosts.length > 0)
    ok(
      `${t.id}: loginUrlPatterns son regex`,
      t.loginUrlPatterns.every((r) => r instanceof RegExp),
    )
    ok(`${t.id}: selectors.usernameInput presente`, !!t.selectors.usernameInput)
    ok(`${t.id}: selectors.passwordInput presente`, !!t.selectors.passwordInput)
    ok(`${t.id}: selectors.submitButton presente`, !!t.selectors.submitButton)
    ok(`${t.id}: selectors.loggedInIndicator presente`, !!t.selectors.loggedInIndicator)
  }
}

// 2. matchByHost básico
section('matchByHost: hits exactos por plataforma')
{
  ok('x.com → x', matchByHost('x.com')?.id === 'x')
  ok('twitter.com → x', matchByHost('twitter.com')?.id === 'x')
  ok('instagram.com → instagram', matchByHost('instagram.com')?.id === 'instagram')
  ok('facebook.com → facebook', matchByHost('facebook.com')?.id === 'facebook')
  ok('m.facebook.com → facebook', matchByHost('m.facebook.com')?.id === 'facebook')
  ok('tiktok.com → tiktok', matchByHost('tiktok.com')?.id === 'tiktok')
  ok('linkedin.com → linkedin', matchByHost('linkedin.com')?.id === 'linkedin')
  ok('accounts.google.com → google', matchByHost('accounts.google.com')?.id === 'google')
  ok('reddit.com → reddit', matchByHost('reddit.com')?.id === 'reddit')
  ok('old.reddit.com → reddit', matchByHost('old.reddit.com')?.id === 'reddit')
  ok('threads.net → threads', matchByHost('threads.net')?.id === 'threads')
  ok('web.telegram.org → telegram', matchByHost('web.telegram.org')?.id === 'telegram')
  ok('discord.com → discord', matchByHost('discord.com')?.id === 'discord')
  ok('discordapp.com → discord', matchByHost('discordapp.com')?.id === 'discord')
}

// 3. Normalización
section('matchByHost: normaliza www. y case')
{
  ok('www.x.com → x', matchByHost('www.x.com')?.id === 'x')
  ok('X.COM → x (case insensitive)', matchByHost('X.COM')?.id === 'x')
  ok(
    'WWW.Instagram.COM → instagram',
    matchByHost('WWW.Instagram.COM')?.id === 'instagram',
  )
}

// 4. matchByHost: misses
section('matchByHost: hosts desconocidos')
{
  ok('foo.com → null', matchByHost('foo.com') === null)
  ok('google.com (sin accounts.) → null', matchByHost('google.com') === null)
  ok('subdomain.x.com → null (subdomain no listado)', matchByHost('api.x.com') === null)
  ok('"" → null', matchByHost('') === null)
  ok('null → null', matchByHost(null) === null)
  ok('undefined → null', matchByHost(undefined) === null)
}

// 5. isLoginUrl: hits
section('isLoginUrl: login URLs reales')
{
  ok('https://x.com/i/flow/login', isLoginUrl('https://x.com/i/flow/login'))
  ok('https://twitter.com/login', isLoginUrl('https://twitter.com/login'))
  ok(
    'https://www.instagram.com/accounts/login/',
    isLoginUrl('https://www.instagram.com/accounts/login/'),
  )
  ok('https://www.facebook.com/login/', isLoginUrl('https://www.facebook.com/login/'))
  ok('https://m.facebook.com/login/', isLoginUrl('https://m.facebook.com/login/'))
  ok('https://www.tiktok.com/login', isLoginUrl('https://www.tiktok.com/login'))
  ok('https://www.linkedin.com/login', isLoginUrl('https://www.linkedin.com/login'))
  ok(
    'https://accounts.google.com/signin',
    isLoginUrl('https://accounts.google.com/signin'),
  )
  ok('https://www.reddit.com/login', isLoginUrl('https://www.reddit.com/login'))
  ok('https://old.reddit.com/login', isLoginUrl('https://old.reddit.com/login'))
  ok('https://www.threads.net/login', isLoginUrl('https://www.threads.net/login'))
  ok('https://web.telegram.org/a/', isLoginUrl('https://web.telegram.org/a/'))
  ok('https://discord.com/login', isLoginUrl('https://discord.com/login'))
}

// 6. isLoginUrl: misses (homepage, etc.)
section('isLoginUrl: NO matchea homepage / perfil / random')
{
  ok('https://x.com/ → false', !isLoginUrl('https://x.com/'))
  ok('https://x.com/joe → false', !isLoginUrl('https://x.com/joe'))
  ok('https://www.instagram.com/ → false', !isLoginUrl('https://www.instagram.com/'))
  ok('https://www.facebook.com/ → false', !isLoginUrl('https://www.facebook.com/'))
  ok(
    'https://google.com/search?q=hi → false',
    !isLoginUrl('https://google.com/search?q=hi'),
  )
  ok('"" → false', !isLoginUrl(''))
  ok('null → false', !isLoginUrl(null))
}

// 7. matchByLoginUrl
section('matchByLoginUrl: devuelve template correcto')
{
  ok('x.com login → x', matchByLoginUrl('https://x.com/i/flow/login')?.id === 'x')
  ok(
    'instagram login → instagram',
    matchByLoginUrl('https://www.instagram.com/accounts/login/')?.id === 'instagram',
  )
  ok(
    'facebook login → facebook',
    matchByLoginUrl('https://www.facebook.com/login/')?.id === 'facebook',
  )
  ok('homepage → null', matchByLoginUrl('https://x.com/') === null)
}

// 8. siteIdForUrl: canonical
section('siteIdForUrl: canonical')
{
  ok(
    'twitter.com URL → x.com canonical',
    siteIdForUrl('https://twitter.com/joe') === 'x.com',
  )
  ok(
    'mobile.twitter.com URL → x.com canonical',
    siteIdForUrl('https://mobile.twitter.com/joe') === 'x.com',
  )
  ok(
    'm.facebook.com URL → facebook.com canonical',
    siteIdForUrl('https://m.facebook.com/profile') === 'facebook.com',
  )
  ok(
    'old.reddit.com → reddit.com canonical',
    siteIdForUrl('https://old.reddit.com/r/news') === 'reddit.com',
  )
  ok(
    'discordapp.com → discord.com canonical',
    siteIdForUrl('https://discordapp.com/channels/123') === 'discord.com',
  )

  // Sin template — devuelve normalized host
  ok(
    'unknown host → normalized host',
    siteIdForUrl('https://www.example.com/path') === 'example.com',
  )
  ok('hostname directo (no URL)', siteIdForUrl('twitter.com') === 'x.com')
}

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
