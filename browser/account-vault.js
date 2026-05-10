// OZ Browser — Account Vault (cifrado AES-256-GCM con master key en Keychain).
//
// Doc: docs/modules/account-vault.md
// ADR: docs/architecture/0008-account-vault-encryption.md
// Bloque: 1.5a (CORE)
//
// Modelo: blob JSON {accounts: [...]} cifrado con AES-256-GCM. Master key
// auto-generada al primer uso (32 bytes random) y guardada en macOS Keychain
// via @napi-rs/keyring. Modo simplificado vs ADR original — sin scrypt KDF
// porque la key tiene 256 bits de entropía nativa (no es derivada de password
// humano), entonces no hay vector de ataque por brute-force offline.
//
// Header del vault.enc:
//   {
//     "version": 1,
//     "mode": "auto",                            // 'auto' (Keychain key) o 'passphrase' (futuro)
//     "cipher": {
//       "algo": "aes-256-gcm",
//       "iv": "<base64 12 bytes>",
//       "authTag": "<base64 16 bytes>"
//     },
//     "ciphertext": "<base64 — JSON.stringify(accounts) cifrado>"
//   }
//
// Storage:
//   - Vault file:   ~/Library/Application Support/OZ Browser/data/vault.enc
//   - Master key:   Keychain service="oz-browser-vault", account="master-key-v1"
//
// Lifecycle:
//   const vault = new Vault({ keychain })            // inyectable para tests
//   await vault.unlock()                              // lee key + descifra blob
//   vault.isUnlocked === true
//   vault.getAccounts()                               // array (snapshot)
//   vault.setAccounts(arr)                            // re-cifra + persist
//   vault.lock()                                      // wipe in-memory accounts
//
// Sensitive data handling:
//   - Las accounts viven en RAM SOLO mientras unlocked.
//   - lock() pone accounts en null (no zeroize porque V8 GC no garantiza
//     borrar bytes — para protección contra heap dump real necesitaríamos
//     SecureBuffer, fuera del scope v1).
//   - El master key buffer también se borra en lock().

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')
const log = require('./logger')

const KEYCHAIN_SERVICE = 'oz-browser-vault'
const KEYCHAIN_ACCOUNT = 'master-key-v1'
const VAULT_VERSION = 1

class VaultError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

class Vault {
  /**
   * @param {object} opts
   * @param {object} [opts.keychain] - injectable Keychain port for tests.
   *   Must expose: getPassword(service, account) → string | null,
   *                setPassword(service, account, password) → void,
   *                deletePassword(service, account) → boolean
   *   Default: real `@napi-rs/keyring` wrapper.
   * @param {string} [opts.dataDir] - override storage dir (tests).
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || path.join(app.getPath('userData'), 'data')
    this.filePath = path.join(this.dataDir, 'vault.enc')
    this.keychain = opts.keychain || _defaultKeychain()

    // In-memory state (only while unlocked).
    this._unlocked = false
    this._key = null // Buffer 32 bytes
    this._accounts = null // array
  }

  // ---------- public API ----------

  get isUnlocked() {
    return this._unlocked
  }

  /**
   * Unlock the vault. First call ever auto-generates the master key + creates
   * an empty vault file. Subsequent calls read the key from Keychain and
   * decrypt the existing blob.
   *
   * Throws VaultError with codes:
   *   - 'KEYCHAIN_FAILURE' if Keychain access denied / not available
   *   - 'VAULT_TAMPERED' if AES-GCM authTag verification fails
   *   - 'VAULT_CORRUPT' if file exists but JSON is malformed
   */
  async unlock() {
    if (this._unlocked) return // idempotent

    let keyHex = null
    try {
      keyHex = this.keychain.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    } catch (err) {
      throw new VaultError(`Keychain access failed: ${err.message}`, 'KEYCHAIN_FAILURE')
    }

    if (!keyHex) {
      // First-time setup: generate key, store in Keychain, create empty vault.
      this._initFirstTime()
      this._unlocked = true
      log.info('account-vault', 'first-time vault initialized', {
        path: this.filePath,
      })
      return
    }

    this._key = Buffer.from(keyHex, 'hex')
    if (this._key.length !== 32) {
      throw new VaultError(
        `Master key in Keychain has wrong length (${this._key.length} bytes, expected 32)`,
        'KEYCHAIN_BAD_KEY',
      )
    }

    if (!fs.existsSync(this.filePath)) {
      // Key exists but no vault file — treat as fresh, recreate empty.
      this._accounts = []
      this._save()
      this._unlocked = true
      log.warn('account-vault', 'key in Keychain but no vault file — created empty', {
        path: this.filePath,
      })
      return
    }

    let raw
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      throw new VaultError(`Cannot read vault file: ${err.message}`, 'VAULT_IO_ERROR')
    }

    let header
    try {
      header = JSON.parse(raw)
    } catch (err) {
      throw new VaultError(
        `Vault file is not valid JSON: ${err.message}`,
        'VAULT_CORRUPT',
      )
    }

    if (header.version !== VAULT_VERSION || header.mode !== 'auto') {
      throw new VaultError(
        `Unsupported vault format (version=${header.version}, mode=${header.mode})`,
        'VAULT_VERSION_MISMATCH',
      )
    }

    let plaintext
    try {
      plaintext = _decrypt(this._key, header.cipher, header.ciphertext)
    } catch (err) {
      throw new VaultError(
        `Decrypt failed (key wrong, file corrupt, or tampered): ${err.message}`,
        'VAULT_TAMPERED',
      )
    }

    try {
      this._accounts = JSON.parse(plaintext)
    } catch (err) {
      throw new VaultError(
        `Decrypted plaintext is not valid JSON: ${err.message}`,
        'VAULT_CORRUPT',
      )
    }

    if (!Array.isArray(this._accounts)) {
      throw new VaultError(
        `Decrypted plaintext is not an array of accounts`,
        'VAULT_CORRUPT',
      )
    }

    this._unlocked = true
    log.info('account-vault', 'vault unlocked', {
      accountsCount: this._accounts.length,
    })
  }

  lock() {
    if (this._key) {
      // Best-effort: zero out the key buffer before releasing.
      this._key.fill(0)
    }
    this._key = null
    this._accounts = null
    this._unlocked = false
    log.info('account-vault', 'vault locked')
  }

  /**
   * Returns a deep-cloned array of accounts. Caller can mutate without affecting
   * vault internal state until setAccounts() is called.
   */
  getAccounts() {
    this._requireUnlocked()
    return JSON.parse(JSON.stringify(this._accounts))
  }

  /**
   * Replace the entire accounts array. Re-encrypts and persists.
   * Fresh iv generated each save (CRITICAL — reusing iv with same key on
   * different plaintexts breaks AES-GCM security).
   */
  setAccounts(accounts) {
    this._requireUnlocked()
    if (!Array.isArray(accounts)) {
      throw new VaultError('setAccounts requires an array', 'BAD_ARG')
    }
    this._accounts = JSON.parse(JSON.stringify(accounts))
    this._save()
    log.info('account-vault', 'vault saved', { accountsCount: this._accounts.length })
  }

  /**
   * Delete the vault completely (file + Keychain key). Used by Settings →
   * Reset Vault and by tests cleanup. After this, next unlock() will be
   * first-time setup again.
   */
  destroy() {
    this.lock()
    try {
      this.keychain.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    } catch (_e) {
      // best-effort
    }
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath)
    } catch (_e) {
      // best-effort
    }
    log.warn('account-vault', 'vault destroyed (file + key removed)')
  }

  // ---------- internal ----------

  _requireUnlocked() {
    if (!this._unlocked) {
      throw new VaultError('Vault is locked — call unlock() first', 'LOCKED')
    }
  }

  _initFirstTime() {
    // Generate 32 bytes of cryptographic randomness — this IS the master key,
    // not derived from anything. 256 bits of entropy = no offline attack viable.
    this._key = crypto.randomBytes(32)
    this.keychain.setPassword(
      KEYCHAIN_SERVICE,
      KEYCHAIN_ACCOUNT,
      this._key.toString('hex'),
    )
    this._accounts = []
    this._save()
  }

  _save() {
    if (!this._key || !this._accounts) {
      throw new VaultError('Cannot save: vault not unlocked', 'LOCKED')
    }
    const plaintext = JSON.stringify(this._accounts)
    const cipherResult = _encrypt(this._key, plaintext)
    const header = {
      version: VAULT_VERSION,
      mode: 'auto',
      cipher: {
        algo: 'aes-256-gcm',
        iv: cipherResult.iv.toString('base64'),
        authTag: cipherResult.authTag.toString('base64'),
      },
      ciphertext: cipherResult.ciphertext.toString('base64'),
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(header), 'utf-8')
    } catch (err) {
      throw new VaultError(`Cannot write vault file: ${err.message}`, 'VAULT_IO_ERROR')
    }
  }
}

// ---------- crypto primitives (canonical from ADR 0008) ---------------------

function _encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12) // GCM standard nonce length
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { iv, ciphertext: ct, authTag }
}

function _decrypt(key, cipherHeader, ciphertextB64) {
  if (cipherHeader.algo !== 'aes-256-gcm') {
    throw new Error(`Unsupported cipher algo: ${cipherHeader.algo}`)
  }
  const iv = Buffer.from(cipherHeader.iv, 'base64')
  const authTag = Buffer.from(cipherHeader.authTag, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag) // CRITICAL: must be before update/final
  const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return pt.toString('utf-8')
}

// ---------- default Keychain port (real @napi-rs/keyring) -------------------

function _defaultKeychain() {
  // Lazy require so tests can inject mock without loading the native module.
  let Entry
  try {
    Entry = require('@napi-rs/keyring').Entry
  } catch (err) {
    throw new VaultError(
      `@napi-rs/keyring not available: ${err.message}`,
      'KEYRING_MODULE_MISSING',
    )
  }
  return {
    getPassword(service, account) {
      const entry = new Entry(service, account)
      try {
        return entry.getPassword()
      } catch (_e) {
        // Native API throws if entry doesn't exist — treat as null.
        return null
      }
    },
    setPassword(service, account, password) {
      const entry = new Entry(service, account)
      entry.setPassword(password)
    },
    deletePassword(service, account) {
      const entry = new Entry(service, account)
      try {
        return entry.deletePassword()
      } catch (_e) {
        return false
      }
    },
  }
}

module.exports = {
  Vault,
  VaultError,
  VAULT_VERSION,
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  // Internal exports for testing only.
  _encrypt,
  _decrypt,
}
