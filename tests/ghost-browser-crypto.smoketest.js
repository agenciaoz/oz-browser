// OZ Browser — Ghost Browser crypto smoke test (G-2a).
//
// Cómo correr:
//   cd oz-browser
//   node tests/ghost-browser-crypto.smoketest.js
//
// Cubre:
//   - fetchGhostKeychainKey: success returns key (fake exec), denied →
//     KEYCHAIN_DENIED, not-found → KEYCHAIN_NOT_FOUND, generic failure →
//     KEYCHAIN_FAILURE, command throw → KEYCHAIN_FAILURE
//   - deriveKey: deterministic 16-byte output, matches a known vector
//   - decryptBlob: round-trip (encrypt → decrypt = plaintext), supports v10
//     and v11 prefixes, accepts Buffer + Uint8Array inputs, strict mode
//     throws on missing prefix, non-strict returns '', bad ciphertext length
//     → BAD_CIPHERTEXT_LEN, wrong key → DECRYPT_FAILED
//   - decryptCookies: maps decrypted plaintext into value_plaintext, old
//     unencrypted cookies (value column populated) preserve value_plaintext,
//     per-row errors do not abort batch
//   - decryptPasswords: same shape as cookies
//
// NO cubre (manual / G-2b):
//   - Real Keychain access on Joses Mac (requires user-approval dialog)
//   - Importer side effects (vault, identityManager, sessions)

const crypto = require('crypto')

const helpers = require('./_helpers-ghost-fixtures.js')
const gc = require('../browser/migrations/ghost-browser-crypto.js')

const { ok, section, done } = helpers.makeRunner(
  'OZ Browser — Ghost Browser crypto (G-2a) smoke test',
)

async function run() {
  // ---------- fetchGhostKeychainKey ----------
  section('fetchGhostKeychainKey')
  {
    const fakeExec = async (cmd, args) => {
      // Verify command is what we expect
      if (cmd !== 'security') throw new Error('wrong cmd: ' + cmd)
      if (!args.includes('-s') || !args.includes(gc.KEYCHAIN_SERVICE)) {
        throw new Error('wrong service')
      }
      return { stdout: 'secret-key-bytes\n', stderr: '', status: 0 }
    }
    const key = await gc.fetchGhostKeychainKey({ exec: fakeExec })
    ok('returns trimmed key on success', key === 'secret-key-bytes')
  }
  {
    const denied = async () => ({
      stdout: '',
      stderr: 'security: SecKeychainSearchCopyNext: User canceled the operation.\n',
      status: 36,
    })
    let code = null
    try {
      await gc.fetchGhostKeychainKey({ exec: denied })
    } catch (e) {
      code = e.code
    }
    ok('user cancel → KEYCHAIN_DENIED', code === 'KEYCHAIN_DENIED')
  }
  {
    const notFound = async () => ({
      stdout: '',
      stderr:
        'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
      status: 44,
    })
    let code = null
    try {
      await gc.fetchGhostKeychainKey({ exec: notFound })
    } catch (e) {
      code = e.code
    }
    ok('not found → KEYCHAIN_NOT_FOUND', code === 'KEYCHAIN_NOT_FOUND')
  }
  {
    const otherFail = async () => ({
      stdout: '',
      stderr: 'security: some other error\n',
      status: 1,
    })
    let code = null
    try {
      await gc.fetchGhostKeychainKey({ exec: otherFail })
    } catch (e) {
      code = e.code
    }
    ok('other non-zero exit → KEYCHAIN_FAILURE', code === 'KEYCHAIN_FAILURE')
  }
  {
    const thrower = async () => {
      throw new Error('ENOENT: security not found')
    }
    let code = null
    try {
      await gc.fetchGhostKeychainKey({ exec: thrower })
    } catch (e) {
      code = e.code
    }
    ok('exec throw → KEYCHAIN_FAILURE', code === 'KEYCHAIN_FAILURE')
  }

  // ---------- deriveKey ----------
  section('deriveKey')
  {
    const key1 = gc.deriveKey('test-passphrase')
    const key2 = gc.deriveKey('test-passphrase')
    ok('returns 16 bytes', key1.length === 16)
    ok('deterministic for same input', key1.equals(key2))
    const key3 = gc.deriveKey('different-passphrase')
    ok('different input → different key', !key1.equals(key3))
  }
  {
    // Known test vector — Chromium's fallback safe-storage key on macOS
    // when no Keychain entry is found. From components/os_crypt/sync/
    // keychain_password_mac.mm: `const char kFallbackPassword[] = "peanuts"`.
    // This regression test ensures the PBKDF2 params (salt, iter count,
    // digest, key length) never drift from Chromium's spec.
    //
    // Derived empirically with Node crypto.pbkdf2Sync:
    //   PBKDF2-HMAC-SHA1("peanuts", "saltysalt", 1003, 16) =
    //   d9a09d499b4e1b7461f28e67972c6dbd
    const expectedHex = 'd9a09d499b4e1b7461f28e67972c6dbd'
    const key = gc.deriveKey('peanuts')
    ok(
      'matches Chromium fallback-key test vector',
      key.toString('hex') === expectedHex,
      `got ${key.toString('hex')}, expected ${expectedHex}`,
    )
  }

  // ---------- decryptBlob ----------
  section('decryptBlob — round-trip')
  {
    const key = gc.deriveKey('test')
    const plain = 'hello world cookie value'
    const enc = gc._encryptBlobForTest(plain, key, 'v10')
    const result = gc.decryptBlob(enc, key)
    ok('round-trip v10 returns original plaintext', result === plain)
  }
  {
    const key = gc.deriveKey('test')
    const plain = 'v11 cookie'
    const enc = gc._encryptBlobForTest(plain, key, 'v11')
    const result = gc.decryptBlob(enc, key)
    ok('round-trip v11 returns original plaintext', result === plain)
  }
  {
    const key = gc.deriveKey('test')
    const plain = 'utf8 — ñ — 日本語'
    const enc = gc._encryptBlobForTest(plain, key)
    const result = gc.decryptBlob(enc, key)
    ok('round-trip handles UTF-8 multibyte', result === plain)
  }
  {
    const key = gc.deriveKey('test')
    const enc = gc._encryptBlobForTest('payload', key)
    // Convert to Uint8Array (different from Buffer)
    const u8 = new Uint8Array(enc)
    const result = gc.decryptBlob(u8, key)
    ok('accepts Uint8Array input', result === 'payload')
  }

  section('decryptBlob — error paths')
  {
    const key = gc.deriveKey('test')
    const noPrefix = Buffer.from('abcdefghij1234567890abcdef')
    let code = null
    try {
      gc.decryptBlob(noPrefix, key)
    } catch (e) {
      code = e.code
    }
    ok('strict (default) → BAD_PREFIX on unknown prefix', code === 'BAD_PREFIX')
  }
  {
    const key = gc.deriveKey('test')
    const noPrefix = Buffer.from('abcdefghij1234567890abcdef')
    const result = gc.decryptBlob(noPrefix, key, { strict: false })
    ok('non-strict → empty string on unknown prefix', result === '')
  }
  {
    const key = gc.deriveKey('test')
    const badLen = Buffer.concat([Buffer.from('v10'), Buffer.from([1, 2, 3, 4, 5])])
    let code = null
    try {
      gc.decryptBlob(badLen, key)
    } catch (e) {
      code = e.code
    }
    ok('non-16-multiple ciphertext → BAD_CIPHERTEXT_LEN', code === 'BAD_CIPHERTEXT_LEN')
  }
  {
    const goodKey = gc.deriveKey('good')
    const wrongKey = gc.deriveKey('wrong')
    const enc = gc._encryptBlobForTest('payload', goodKey)
    let code = null
    try {
      gc.decryptBlob(enc, wrongKey)
    } catch (e) {
      code = e.code
    }
    ok('wrong key → DECRYPT_FAILED', code === 'DECRYPT_FAILED')
  }
  {
    const key = gc.deriveKey('test')
    ok('null blob → empty string', gc.decryptBlob(null, key) === '')
    ok(
      'empty Buffer → empty string',
      gc.decryptBlob(Buffer.alloc(0), key, { strict: false }) === '',
    )
  }

  // ---------- decryptCookies ----------
  section('decryptCookies')
  {
    const key = gc.deriveKey('test')
    const cookies = [
      {
        host_key: '.google.com',
        name: 'NID',
        value: '',
        encrypted_value: gc._encryptBlobForTest('cookie-value-1', key),
      },
      {
        host_key: '.tiktok.com',
        name: 'sessionid',
        value: '',
        encrypted_value: gc._encryptBlobForTest('cookie-value-2', key),
      },
    ]
    const out = gc.decryptCookies(cookies, key)
    ok('count preserved', out.length === 2)
    ok(
      'value_plaintext populated for both',
      out[0].value_plaintext === 'cookie-value-1' &&
        out[1].value_plaintext === 'cookie-value-2',
    )
    ok(
      '_decryptError is null on success',
      out[0]._decryptError === null && out[1]._decryptError === null,
    )
    ok(
      'original encrypted_value preserved',
      out[0].encrypted_value === cookies[0].encrypted_value,
    )
  }
  {
    const key = gc.deriveKey('test')
    const cookies = [
      {
        host_key: '.old.com',
        name: 'plain',
        value: 'plain-cookie-value',
        encrypted_value: Buffer.alloc(0),
      },
    ]
    const out = gc.decryptCookies(cookies, key)
    ok(
      'unencrypted (value column) preserved as value_plaintext',
      out[0].value_plaintext === 'plain-cookie-value',
    )
  }
  {
    const key = gc.deriveKey('test')
    const cookies = [
      {
        host_key: '.bad.com',
        name: 'broken',
        value: '',
        encrypted_value: Buffer.from('not-a-real-blob-format'),
      },
      {
        host_key: '.good.com',
        name: 'works',
        value: '',
        encrypted_value: gc._encryptBlobForTest('ok', key),
      },
    ]
    const out = gc.decryptCookies(cookies, key)
    ok(
      'bad cookie marked with _decryptError, value_plaintext null',
      out[0]._decryptError === 'BAD_PREFIX' && out[0].value_plaintext === null,
    )
    ok('good cookie still decrypted in same batch', out[1].value_plaintext === 'ok')
  }

  // ---------- decryptPasswords ----------
  section('decryptPasswords')
  {
    const key = gc.deriveKey('test')
    const logins = [
      {
        origin_url: 'https://www.instagram.com/',
        username_value: 'contexto.ec',
        password_value: gc._encryptBlobForTest('my-instagram-pw', key),
      },
    ]
    const out = gc.decryptPasswords(logins, key)
    ok('password_plaintext populated', out[0].password_plaintext === 'my-instagram-pw')
    ok('_decryptError null on success', out[0]._decryptError === null)
    ok(
      'other fields preserved',
      out[0].origin_url === 'https://www.instagram.com/' &&
        out[0].username_value === 'contexto.ec',
    )
  }
  {
    const key = gc.deriveKey('test')
    const logins = [
      {
        origin_url: 'https://broken.com/',
        username_value: 'user',
        password_value: Buffer.from('garbage'),
      },
    ]
    const out = gc.decryptPasswords(logins, key)
    ok(
      'bad password row → password_plaintext null, _decryptError set',
      out[0].password_plaintext === null && out[0]._decryptError === 'BAD_PREFIX',
    )
  }

  // ---------- Spot-check Chromium standard compatibility ----------
  section('Chromium standard params spot-check')
  {
    // crypto.createDecipheriv expects key length matching algorithm. We
    // assert our key is exactly 16 bytes (AES-128), IV is 16 bytes of 0x20.
    const key = gc.deriveKey('any')
    ok('derived key is AES-128 length', key.length === 16)
    // Verify by hand: AES_IV from the module is 16 bytes of 0x20.
    const enc = gc._encryptBlobForTest('x', key)
    // The first 3 bytes are the prefix "v10".
    ok(
      'encrypted blob starts with v10 prefix',
      enc[0] === 0x76 && enc[1] === 0x31 && enc[2] === 0x30,
    )
  }

  done()
}

run().catch((e) => {
  console.error('UNCAUGHT:', e.stack || e.message)
  process.exit(1)
})

// quiet "unused crypto" if linter complains
void crypto
