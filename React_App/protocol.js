/**
 * EchoCrypt protocol parser.
 * Centralizes all packet parsing logic extracted from AppNew.jsx.
 * Pure JS — no React, no Web Audio. Safe to reuse in React Native.
 *
 * Supported packet types:
 *   IMG|<id>|<idx>/<total>|<crc32>|<payload>   (v2 with CRC)
 *   IMG|<id>|<idx>/<total>|<payload>            (v2 without CRC)
 *   IMG|<idx>/<total>|<payload>                 (v1 legacy, no session ID)
 *   MSG|<id>|<payload>                          (single-packet text)
 *   MSG|<id>|<idx>/<total>|<payload>            (multi-packet text)
 *   NACK|<id>|<missing_csv>
 */

// ─── CRC32 ────────────────────────────────────────────────────────────────────

/**
 * CRC32 over ASCII bytes of a string.
 * Matches Python's zlib.crc32 exactly — do NOT change this implementation.
 *
 * @param {string} str
 * @returns {string}  8 lowercase hex chars
 */
export function crc32(str) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < str.length; i++) {
    const byte = str.charCodeAt(i)
    crc = crc ^ byte
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
    }
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0')
}

// ─── Individual parsers ────────────────────────────────────────────────────────

/**
 * IMG|<id>|<idx>/<total>|<crc32>|<payload>
 * @param {string} text
 * @returns {object|null}
 */
function parseIMGv2CRC(text) {
  const match = text.match(/^IMG\|([^|]+)\|(\d+)\/(\d+)\|([0-9a-fA-F]{8})\|(.*)$/)
  if (!match) return null

  const [, id, idx, total, receivedCrc, payload] = match
  const calculatedCrc = crc32(payload)
  const isValid = calculatedCrc.toLowerCase() === receivedCrc.toLowerCase()

  return {
    type: 'IMG',
    id,
    index: parseInt(idx, 10),
    total: parseInt(total, 10),
    crc: receivedCrc,
    calculatedCrc,
    payload,
    isValid,
    hasCRC: true,
    hasSessionId: true,
  }
}

/**
 * IMG|<id>|<idx>/<total>|<payload>  (no CRC field)
 * @param {string} text
 * @returns {object|null}
 */
function parseIMGv2NoCRC(text) {
  const match = text.match(/^IMG\|([^|]+)\|(\d+)\/(\d+)\|(.*)$/)
  if (!match) return null

  const [, id, idx, total, payload] = match

  return {
    type: 'IMG',
    id,
    index: parseInt(idx, 10),
    total: parseInt(total, 10),
    payload,
    isValid: true,
    hasCRC: false,
    hasSessionId: true,
  }
}

/**
 * IMG|<idx>/<total>|<payload>  (legacy v1, no session ID)
 * @param {string} text
 * @returns {object|null}
 */
function parseIMGv1(text) {
  const match = text.match(/^IMG\|(\d+)\/(\d+)\|(.*)$/)
  if (!match) return null

  return {
    type: 'IMG',
    id: 'default',
    index: parseInt(match[1], 10),
    total: parseInt(match[2], 10),
    payload: match[3],
    isValid: true,
    hasCRC: false,
    hasSessionId: false,
  }
}

/**
 * MSG|<id>|<payload>                   (single packet)
 * MSG|<id>|<idx>/<total>|<payload>     (multi-packet)
 * @param {string} text
 * @returns {object|null}
 */
function parseMSG(text) {
  // Try multi-packet first (more specific regex)
  const multiMatch = text.match(/^MSG\|([^|]+)\|(\d+)\/(\d+)\|(.*)$/)
  if (multiMatch) {
    const [, id, idx, total, payload] = multiMatch
    return {
      type: 'MSG',
      id,
      index: parseInt(idx, 10),
      total: parseInt(total, 10),
      payload,
      isSinglePacket: false,
    }
  }

  // Single-packet
  const singleMatch = text.match(/^MSG\|([^|]+)\|(.*)$/)
  if (singleMatch) {
    const [, id, payload] = singleMatch
    return {
      type: 'MSG',
      id,
      index: 1,
      total: 1,
      payload,
      isSinglePacket: true,
    }
  }

  return null
}

/**
 * NACK|<id>|<missing_csv>
 * @param {string} text
 * @returns {object|null}
 */
function parseNACK(text) {
  const match = text.match(/^NACK\|([^|]+)\|(.*)$/)
  if (!match) return null

  const [, id, missingCsv] = match
  const missing = missingCsv
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n))

  return {
    type: 'NACK',
    id,
    missing,
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Parse any EchoCrypt packet string.
 *
 * @param {string} text  Raw decoded ASCII string from GGWave
 * @returns {{ type: string, ... }|null}  null if unrecognized
 */
export function parsePacket(text) {
  if (!text || typeof text !== 'string') return null

  const trimmed = text.trim()

  if (trimmed.startsWith('IMG|')) {
    return parseIMGv2CRC(trimmed)
      ?? parseIMGv2NoCRC(trimmed)
      ?? parseIMGv1(trimmed)
  }

  if (trimmed.startsWith('MSG|')) {
    return parseMSG(trimmed)
  }

  if (trimmed.startsWith('NACK|')) {
    return parseNACK(trimmed)
  }

  return null
}
