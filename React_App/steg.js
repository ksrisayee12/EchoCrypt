/**
 * EchoCrypt steg layer — magic-byte frame unwrapping.
 * Strips the 8-byte header and trailing random padding from a steg frame.
 */

const MAGIC = new Uint8Array([0xAC, 0x00, 0x57, 0x1C])

/**
 * Unwrap a steg frame and return the inner payload.
 *
 * Frame format: MAGIC(4) + length(4 big-endian) + payload + padding
 *
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 * @throws {Error} if magic bytes don't match
 */
export function stegUnwrap(data) {
  for (let i = 0; i < 4; i++) {
    if (data[i] !== MAGIC[i]) {
      throw new Error(
        `Invalid magic bytes at offset ${i}: expected 0x${MAGIC[i].toString(16).padStart(2, '0')}, ` +
        `got 0x${data[i].toString(16).padStart(2, '0')} — not a valid EchoCrypt frame`
      )
    }
  }

  // length is stored big-endian at bytes 4–7
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, false)

  if (8 + length > data.length) {
    throw new Error(`Steg frame truncated: declared length ${length} exceeds available data`)
  }

  return data.slice(8, 8 + length)
}

/**
 * Wrap payload bytes into a steg frame for outbound transmission.
 * Matches Python steg_wrap() exactly:
 *   MAGIC(4) + length(4 big-endian uint32) + payload + random_padding(4-16 bytes)
 *
 * CRITICAL: 4-16 random bytes, NOT padded to 16-byte boundary.
 * Python: os.urandom(random.randint(4, 16))
 *
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function stegWrap(payload) {
  const padLen = 4 + Math.floor(Math.random() * 13)  // 4..16 inclusive
  const frame  = new Uint8Array(8 + payload.length + padLen)
  frame.set(MAGIC, 0)
  new DataView(frame.buffer).setUint32(4, payload.length, false)
  frame.set(payload, 8)
  crypto.getRandomValues(frame.subarray(8 + payload.length))
  return frame
}
