/**
 * EchoCrypt crypto layer — browser WebCrypto AES-256-GCM
 *
 * Byte layout (must match Python crypto.py exactly):
 *   nonce(12) + ciphertext + tag(16)
 *
 * WebCrypto AES-GCM expects the tag appended to ciphertext in one blob —
 * so we pass data.slice(12) directly (includes both ciphertext and tag).
 */

const SALT = new TextEncoder().encode('acoustinet_v1')
const ITERATIONS = 100_000

/**
 * Derive a 256-bit AES-GCM key from a passphrase using PBKDF2-SHA256.
 * This is intentionally slow (100k iterations) — call once, cache the result.
 *
 * @param {string} password
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(password) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: SALT,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,           // not extractable
    ['encrypt', 'decrypt']
  )
}

/**
 * Decrypt AES-256-GCM data.
 *
 * @param {Uint8Array} data  nonce(12) + ciphertext + tag(16)
 * @param {CryptoKey}  key   result of deriveKey()
 * @returns {Promise<Uint8Array>}
 * @throws if authentication fails or data is malformed
 */
export async function decrypt(data, key) {
  const nonce = data.slice(0, 12)
  // WebCrypto expects ciphertext||tag as one blob starting at offset 12
  const ciphertextWithTag = data.slice(12)

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertextWithTag
  )

  return new Uint8Array(plaintext)
}

/**
 * Encrypt data with AES-256-GCM.
 * Output: nonce(12) + ciphertext + tag(16) — matches Python crypto.py exactly.
 *
 * @param {Uint8Array} data  plaintext bytes
 * @param {CryptoKey}  key   result of deriveKey()
 * @returns {Promise<Uint8Array>}
 */
export async function encrypt(data, key) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct    = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data)
  const out   = new Uint8Array(12 + ct.byteLength)
  out.set(nonce, 0)
  out.set(new Uint8Array(ct), 12)
  return out
}
