/**
 * EchoCrypt session layer.
 * Tracks in-flight multi-packet transmissions (both MSG and IMG types).
 * Pure JS — no React, no Web Audio. Safe to reuse in React Native.
 */

const SESSION_TTL_MS = 60_000

export class Session {
  /**
   * @param {string} id     Session ID (e.g. "A1", "T3")
   * @param {string} type   'MSG' | 'IMG'
   * @param {number} total  Expected chunk count
   */
  constructor(id, type, total) {
    this.id = id
    this.type = type
    this.total = total
    this.received = {}      // { idx: payload_string }
    this.createdAt = Date.now()
    this.complete = false
  }

  /**
   * Store a received chunk (1-indexed).
   * @param {number} idx
   * @param {string} payload  Base64 chunk string
   */
  addChunk(idx, payload) {
    this.received[idx] = payload
    if (Object.keys(this.received).length === this.total) {
      this.complete = true
    }
  }

  /**
   * Return indices (1-based) of missing chunks.
   * @returns {number[]}
   */
  missingIndices() {
    const missing = []
    for (let i = 1; i <= this.total; i++) {
      if (!this.received[i]) missing.push(i)
    }
    return missing
  }

  /**
   * Reassemble all chunks in order into a single base64 string.
   * Call only when complete === true.
   * @returns {string}
   */
  reassemble() {
    return Array.from({ length: this.total }, (_, i) => this.received[i + 1]).join('')
  }

  /**
   * @returns {boolean}
   */
  isExpired() {
    return Date.now() - this.createdAt > SESSION_TTL_MS
  }
}

export class SessionManager {
  constructor() {
    /** @type {Record<string, Session>} */
    this.sessions = {}
  }

  /**
   * Get an existing session or create a new one.
   * @param {string} id
   * @param {string} type   'MSG' | 'IMG'
   * @param {number} total
   * @returns {Session}
   */
  getOrCreate(id, type, total) {
    if (!this.sessions[id]) {
      this.sessions[id] = new Session(id, type, total)
    }
    return this.sessions[id]
  }

  /**
   * Retrieve an existing session without creating.
   * @param {string} id
   * @returns {Session|undefined}
   */
  get(id) {
    return this.sessions[id]
  }

  /**
   * Delete a session by ID.
   * @param {string} id
   */
  remove(id) {
    delete this.sessions[id]
  }

  /**
   * Remove all sessions older than SESSION_TTL_MS.
   */
  cleanup() {
    for (const id in this.sessions) {
      if (this.sessions[id].isExpired()) {
        delete this.sessions[id]
      }
    }
  }
}
