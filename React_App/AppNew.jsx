import { useState, useEffect, useRef, useCallback } from 'react'
import { deriveKey, decrypt as cryptoDecrypt, encrypt as cryptoEncrypt } from './crypto.js'
import { stegUnwrap, stegWrap } from './steg.js'
import { parsePacket, crc32 } from './protocol.js'
import { SessionManager } from './session.js'

// ─── Connection status states ─────────────────────────────────────────────────
const STATUS = {
  LOCKED: 'LOCKED',
  READY: 'READY',
  LISTENING: 'LISTENING',
  RECEIVING: 'RECEIVING',
  DECODING: 'DECODING',
}

const STATUS_LABEL = {
  [STATUS.LOCKED]: 'Awaiting passphrase',
  [STATUS.READY]: 'Ready — press Listen to start',
  [STATUS.LISTENING]: 'Listening for transmissions',
  [STATUS.RECEIVING]: 'Receiving signal…',
  [STATUS.DECODING]: 'Decoding — please wait…',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function base64ToUint8Array(b64) {
  // atob requires length to be a multiple of 4, with at most 2 '=' padding chars.
  // Python's b64decode pads silently; atob does not.
  // Strip any existing '=' then add canonical padding (0, 1, or 2 chars only).
  const s = b64.replace(/=+$/, '')
  const rem = s.length % 4
  // rem=0 → no padding; rem=2 → add '=='; rem=3 → add '='; rem=1 → corrupt, pass as-is
  const padded = rem === 2 ? s + '==' : rem === 3 ? s + '=' : s
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function ts() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function mkId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// ─── Component ────────────────────────────────────────────────────────────────

function AppNew() {
  // ── Core state ──
  const [connStatus, setConnStatus] = useState(STATUS.LOCKED)
  const [isListening, setIsListening] = useState(false)
  const [isDecoding, setIsDecoding] = useState(false)
  const [messages, setMessages] = useState([])
  const [flashGreen, setFlashGreen] = useState(false)

  // ── Passphrase screen ──
  const [passphraseInput, setPassphraseInput] = useState('')
  const [keyLoading, setKeyLoading] = useState(false)
  const [keyError, setKeyError] = useState('')

  // ── Mic device picker ──
  const [micDevices, setMicDevices] = useState([])   // [{deviceId, label}]
  const [selectedMicId, setSelectedMicId] = useState('default')

  // ── Audio level meter ──
  const [audioLevel, setAudioLevel] = useState(0)   // 0-100
  const levelRafRef = useRef(null)
  const levelAccRef = useRef(0)       // accumulated peak between RAF frames

  // ── ggwave decode hints (from stdout intercept) ──
  const [ggwaveHint, setGGWaveHint] = useState('')   // shown under level bar

  // ── Derived key (cached) ──
  const derivedKeyRef = useRef(null)

  // ── GGWave ──
  const ggwaveRef = useRef(null)
  const instanceRef = useRef(null)
  const audioCtxRef = useRef(null)
  const recorderRef = useRef(null)
  const mediaStreamRef = useRef(null)

  // ── Packet sessions (IMG + MSG) ──
  const imgPacketsRef = useRef({})
  const corruptRef = useRef({})
  const msgSessionsRef = useRef(new SessionManager())

  // ── Receiving signal detection ──
  const receivingTimeoutRef = useRef(null)
  const isReceivingRef = useRef(false)

  // ── Graceful stop control ──
  const drainTimerRef = useRef(null)
  const drainResolveRef = useRef(null)

  // ── Raw mic stream ref ──
  const rawStreamRef = useRef(null)

  // ── Serial decode queue — prevents concurrent async packet processing ──
  const decodeQueueRef = useRef(Promise.resolve())

  // ── Send panel state ──
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const imgPickerRef = useRef(null)

  // ── Init GGWave + register stdout hook ───────────────────────────────────────
  // Use a ref so the global hook is always stable and never needs re-registration
  const ggwaveLogHandlerRef = useRef(null)

  useEffect(() => {
    // Register a stable global hook pointing to the latest handler via ref
    window.__ggwaveOnPrint = (msg) => {
      if (ggwaveLogHandlerRef.current) ggwaveLogHandlerRef.current(msg)
    }

    const init = async () => {
      try {
        if (typeof window.ggwave_factory === 'undefined') {
          console.error('ggwave_factory not found — check script tag in index.html')
          return
        }
        ggwaveRef.current = await window.ggwave_factory()
        console.log('GGWave loaded ✅')
      } catch (e) {
        console.error('Failed to load ggwave:', e)
      }
    }
    init()

    return () => { window.__ggwaveOnPrint = null }
  }, [])  // stable — no deps needed

  // ── Handle ggwave stdout lines ───────────────────────────────────────────────
  const handleGGWaveLog = useCallback((msg) => {
    if (!msg) return
    if (msg.includes('Receiving sound data')) {
      setGGWaveHint('📡 Receiving acoustic data…')
      setConnStatus(s => (s === STATUS.LISTENING || s === STATUS.RECEIVING) ? STATUS.RECEIVING : s)
    } else if (msg.includes('Received end marker')) {
      setGGWaveHint('🔍 Analyzing captured frames…')
    } else if (msg.includes('Analyzing captured data')) {
      setGGWaveHint('🔍 Analyzing captured frames…')
    } else if (msg.includes('Failed to capture')) {
      setGGWaveHint('⚠️ Decode failed — too few frames captured')
    }
  }, [])

  // Keep the ref always pointing to the latest version of the callback
  useEffect(() => {
    ggwaveLogHandlerRef.current = handleGGWaveLog
  }, [handleGGWaveLog])

  // ── Enumerate mic devices (runs once on mount) ───────────────────────────────
  useEffect(() => {
    const enumerate = async () => {
      try {
        // Request mic permission first so labels are visible
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
        tmp.getTracks().forEach(t => t.stop())

        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices
          .filter(d => d.kind === 'audioinput')
          .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone (${d.deviceId.slice(0, 8)})` }))
        setMicDevices(mics)
      } catch (_) {
        // Permission denied — will prompt again on Listen
      }
    }
    enumerate()
  }, [])

  // ── Passphrase submit ────────────────────────────────────────────────────────
  const handlePassphraseSubmit = async () => {
    if (!passphraseInput.trim()) {
      setKeyError('Please enter a passphrase.')
      return
    }
    setKeyLoading(true)
    setKeyError('')
    try {
      derivedKeyRef.current = await deriveKey(passphraseInput.trim())
      setConnStatus(STATUS.READY)
    } catch (e) {
      setKeyError('Key derivation failed. Try again.')
      console.error(e)
    } finally {
      setKeyLoading(false)
    }
  }

  // ── Typed array helper ────────────────────────────────────────────────────────
  const convertTypedArray = (src, type) => {
    const buffer = new ArrayBuffer(src.byteLength)
    new src.constructor(buffer).set(src)
    return new type(buffer)
  }

  // ── Uint8Array → base64 (for outbound packets) ────────────────────────────────
  const uint8ToB64 = (bytes) => {
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  }

  // ── Play GGWave-encoded packets acoustically ────────────────────────────────
  //
  // Encoding approach (mirrors working test.html exactly):
  //   • Use GGWAVE_SAMPLE_FORMAT_I16 — same as test.html which passed
  //   • encode() returns Int8Array of raw I16 PCM bytes
  //   • Convert I16 → Float32 before feeding to Web Audio API
  //   • Protocol: ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST (same as Python sender)
  const playPackets = useCallback(async (packets, onProgress) => {
    if (!ggwaveRef.current) throw new Error('GGWave not ready')
    const ggwave = ggwaveRef.current

    const AudioCtx = window.AudioContext || window.webkitAudioContext
    const ctx = new AudioCtx({ sampleRate: 48000 })
    if (ctx.state === 'suspended') await ctx.resume()

    // Build an I16-format encode instance (same as test.html)
    const params = ggwave.getDefaultParameters()
    params.sampleRateInp = 48000
    params.sampleRateOut = 48000
    params.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16
    params.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_I16
    const inst = ggwave.init(params)

    try {
      for (let i = 0; i < packets.length; i++) {
        onProgress && onProgress(i + 1, packets.length)

        // encode() → typed_memory_view of raw I16 bytes (Int8Array layout)
        const view = ggwave.encode(
          inst,
          packets[i],
          ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST,
          100
        )

        // Copy out of WASM memory
        const i16Bytes = new Int8Array(view.length)
        for (let j = 0; j < view.length; j++) i16Bytes[j] = view[j]

        // I16 bytes → Int16Array → Float32Array (Web Audio needs F32)
        const i16Samples = new Int16Array(i16Bytes.buffer)
        const f32 = new Float32Array(i16Samples.length)
        for (let j = 0; j < i16Samples.length; j++) f32[j] = i16Samples[j] / 32768.0

        const buf = ctx.createBuffer(1, f32.length, 48000)
        buf.copyToChannel(f32, 0)

        await new Promise(resolve => {
          const src = ctx.createBufferSource()
          src.buffer = buf
          src.connect(ctx.destination)
          src.onended = resolve
          src.start()
        })

        // 100 ms gap between packets (same as Python INTER_PACKET_DELAY)
        if (i < packets.length - 1) await new Promise(r => setTimeout(r, 100))
      }
    } finally {
      ggwave.free(inst)
      ctx.close()
    }
  }, [])

  // ── Send text: encrypt → stegWrap → base64 → MSG packets → play ────────────
  const sendTextMsg = async (text) => {
    if (!derivedKeyRef.current || !text.trim() || isSending) return
    setIsSending(true)
    const id = Math.random().toString(36).slice(2, 4).toUpperCase()
    // GGWave hard limit: 140 bytes per packet.
    // MSG overhead: "MSG|AB|999/999|" = up to 15 chars  →  safe payload = 115
    const MSG_MAX = 115
    try {
      const plain = new TextEncoder().encode(text.trim())
      const enc = await cryptoEncrypt(plain, derivedKeyRef.current)
      const frame = stegWrap(enc)
      const b64 = uint8ToB64(frame)
      const chunks = []
      for (let i = 0; i < b64.length; i += MSG_MAX) chunks.push(b64.slice(i, i + MSG_MAX))
      const pkts = chunks.length === 1
        ? [`MSG|${id}|${chunks[0]}`]
        : chunks.map((c, k) => `MSG|${id}|${k + 1}/${chunks.length}|${c}`)
      setMessages(prev => [
        { id: mkId(), kind: 'msg_out', text: text.trim(), timestamp: ts() },
        ...prev,
      ])
      setGGWaveHint(`📤 Sending (${pkts.length} packet${pkts.length > 1 ? 's' : ''})…`)
      await playPackets(pkts, (cur, tot) => setGGWaveHint(`📤 Packet ${cur}/${tot}…`))
      setGGWaveHint(`✅ Sent (${pkts.length} packet${pkts.length > 1 ? 's' : ''})`)
    } catch (err) {
      console.error('Send error:', err)
      setGGWaveHint('⚠️ Send failed: ' + err.message)
    } finally {
      setIsSending(false)
    }
  }

  // ── Send image: resize → encrypt → stegWrap → base64 → IMG packets → play ──
  const sendImageMsg = async (file) => {
    if (!derivedKeyRef.current || !file || isSending) return
    setIsSending(true)
    const id = Math.random().toString(36).slice(2, 4).toUpperCase()
    // GGWave hard limit: 140 bytes per packet.
    // IMG overhead: "IMG|AB|999/999|a1b2c3d4|" = up to 24 chars  →  safe payload = 100
    const IMG_MAX = 100
    try {
      // 64×64 JPEG at quality 35 — same as Python encode_image_to_encrypted_packets
      const bmp = await createImageBitmap(file)
      const canvas = document.createElement('canvas')
      canvas.width = 64; canvas.height = 64
      canvas.getContext('2d').drawImage(bmp, 0, 0, 64, 64)
      bmp.close()
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.35))
      const imgBytes = new Uint8Array(await blob.arrayBuffer())
      const preview = URL.createObjectURL(blob)

      const enc = await cryptoEncrypt(imgBytes, derivedKeyRef.current)
      const frame = stegWrap(enc)
      const b64 = uint8ToB64(frame)

      const chunks = []
      for (let i = 0; i < b64.length; i += IMG_MAX) chunks.push(b64.slice(i, i + IMG_MAX))
      const pkts = chunks.map((c, k) => `IMG|${id}|${k + 1}/${chunks.length}|${crc32(c)}|${c}`)

      setMessages(prev => [
        { id: mkId(), kind: 'img_out', sessionId: id, dataUrl: preview, total: pkts.length, timestamp: ts() },
        ...prev,
      ])
      setGGWaveHint(`📤 Sending image (${pkts.length} packets)…`)
      await playPackets(pkts, (cur, tot) => setGGWaveHint(`📤 Image ${cur}/${tot}…`))
      setGGWaveHint(`✅ Image sent (${pkts.length} packets)`)
    } catch (err) {
      console.error('Image send error:', err)
      setGGWaveHint('⚠️ Image send failed: ' + err.message)
    } finally {
      setIsSending(false)
    }
  }

  // ── MSG decryption ───────────────────────────────────────────────────────────
  const decryptMsgPayload = async (b64Payload) => {
    if (!derivedKeyRef.current) throw new Error('No key')
    const raw = base64ToUint8Array(b64Payload)
    const unwrapped = stegUnwrap(raw)
    const plainBytes = await cryptoDecrypt(unwrapped, derivedKeyRef.current)
    return new TextDecoder('utf-8').decode(plainBytes)
  }

  // ── Handle fully-assembled MSG session ────────────────────────────────────────
  const handleCompleteMSG = useCallback(async (sessionId, b64Full) => {
    let text
    let isDecrypted = true
    try {
      text = await decryptMsgPayload(b64Full)
    } catch (e) {
      console.warn('MSG decrypt failed:', e)
      text = `[Decryption failed — wrong passphrase or corrupt data]`
      isDecrypted = false
    }

    setMessages(prev => {
      const filtered = prev.filter(m => !(m.kind === 'msg_partial' && m.sessionId === sessionId))
      return [
        { id: mkId(), kind: 'msg', sessionId, text, isDecrypted, timestamp: ts() },
        ...filtered,
      ]
    })

    msgSessionsRef.current.remove(sessionId)
  }, [])

  // ── Handle parsed packet ──────────────────────────────────────────────────────
  const handlePacket = useCallback(async (parsed) => {

    // IMG packet
    if (parsed.type === 'IMG') {
      const { id, index, total, payload, isValid, hasCRC, hasSessionId } = parsed

      if (!imgPacketsRef.current[id]) {
        imgPacketsRef.current[id] = {}
        corruptRef.current[id] = []
      }

      if (hasCRC && !isValid) {
        if (!corruptRef.current[id].includes(index)) corruptRef.current[id].push(index)
        return
      }

      imgPacketsRef.current[id][index] = payload
      const receivedCount = Object.keys(imgPacketsRef.current[id]).length

      let b64 = ''
      const missing = []
      for (let i = 1; i <= total; i++) {
        if (imgPacketsRef.current[id][i]) b64 += imgPacketsRef.current[id][i]
        else missing.push(i)
      }

      const isComplete = missing.length === 0

      // During reception: dataUrl is null (show progress bar only — b64 is encrypted, not raw JPEG).
      // When complete: stegUnwrap → AES-GCM decrypt → valid JPEG bytes → data URL.
      let dataUrl = null
      if (isComplete) {
        try {
          const raw = base64ToUint8Array(b64)
          const unwrapped = stegUnwrap(raw)
          const jpegBytes = await cryptoDecrypt(unwrapped, derivedKeyRef.current)
          let jpegB64 = ''
          for (let j = 0; j < jpegBytes.length; j++) jpegB64 += String.fromCharCode(jpegBytes[j])
          dataUrl = 'data:image/jpeg;base64,' + btoa(jpegB64)
        } catch (e) {
          console.warn('IMG decrypt failed:', e)
        }
      }

      setMessages(prev => {
        const existingIdx = prev.findIndex(m => m.kind === 'img' && m.sessionId === id)
        const updated = {
          id: existingIdx >= 0 ? prev[existingIdx].id : mkId(),
          kind: 'img',
          sessionId: id,
          dataUrl,
          total,
          receivedCount,
          isComplete,
          missing,
          corrupt: corruptRef.current[id] || [],
          hasCRC,
          hasSessionId,
          timestamp: ts(),
        }
        if (existingIdx >= 0) {
          const next = [...prev]
          next[existingIdx] = updated
          return next
        }
        return [updated, ...prev]
      })

      if (isComplete) {
        setTimeout(() => {
          delete imgPacketsRef.current[id]
          delete corruptRef.current[id]
        }, 1000)
      }
      return
    }

    // MSG packet
    if (parsed.type === 'MSG') {
      const { id, index, total, payload, isSinglePacket } = parsed

      if (isSinglePacket) {
        await handleCompleteMSG(id, payload)
        return
      }

      const session = msgSessionsRef.current.getOrCreate(id, 'MSG', total)
      session.addChunk(index, payload)

      if (session.complete) {
        await handleCompleteMSG(id, session.reassemble())
      } else {
        const receivedCount = Object.keys(session.received).length
        setMessages(prev => {
          const existingIdx = prev.findIndex(m => m.kind === 'msg_partial' && m.sessionId === id)
          const placeholder = {
            id: existingIdx >= 0 ? prev[existingIdx].id : mkId(),
            kind: 'msg_partial',
            sessionId: id,
            receivedCount,
            total,
            timestamp: ts(),
          }
          if (existingIdx >= 0) {
            const next = [...prev]
            next[existingIdx] = placeholder
            return next
          }
          return [placeholder, ...prev]
        })
      }
      return
    }

    // NACK
    if (parsed.type === 'NACK') {
      console.log(`NACK: session ${parsed.id}, missing [${parsed.missing.join(', ')}]`)
    }
  }, [handleCompleteMSG])

  // ── Main decoded packet handler ───────────────────────────────────────────────
  const handleRawDecoded = useCallback(async (text) => {
    console.log('Decoded:', text)
    setGGWaveHint(`✅ Decoded: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`)

    setFlashGreen(true)
    setTimeout(() => setFlashGreen(false), 300)

    const parsed = parsePacket(text)
    if (parsed) {
      await handlePacket(parsed)
    } else {
      setMessages(prev => [
        { id: mkId(), kind: 'text', text, timestamp: ts() },
        ...prev,
      ])
    }
  }, [handlePacket])

  // ── Hard stop — tears down all audio resources ────────────────────────────────
  const hardStop = useCallback(() => {
    if (drainTimerRef.current) {
      clearTimeout(drainTimerRef.current)
      drainTimerRef.current = null
    }
    drainResolveRef.current = null

    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = null
    }

    recorderRef.current?.disconnect()
    recorderRef.current = null
    mediaStreamRef.current?.disconnect()
    mediaStreamRef.current = null
    rawStreamRef.current?.getTracks().forEach(t => t.stop())
    rawStreamRef.current = null

    if (audioCtxRef.current) {
      audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    if (instanceRef.current && ggwaveRef.current) {
      ggwaveRef.current.free(instanceRef.current)
      instanceRef.current = null
    }
    if (receivingTimeoutRef.current) {
      clearTimeout(receivingTimeoutRef.current)
      receivingTimeoutRef.current = null
    }
    isReceivingRef.current = false
    setAudioLevel(0)
    setIsListening(false)
    setIsDecoding(false)
    setConnStatus(STATUS.READY)
    console.log('Audio resources released')
  }, [])

  // ── Decode WAV file directly ────────────────────────────────────────────────
  const decodeFromFile = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = null // reset

    if (!ggwaveRef.current) return

    try {
      hardStop() // stop mic if running
      setIsDecoding(true)
      setConnStatus(STATUS.DECODING)
      setGGWaveHint(`📁 Analyzing ${file.name}…`)

      const arrayBuffer = await file.arrayBuffer()
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      const tempCtx = new AudioCtx({ sampleRate: 48000 })
      const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer)

      const float32Data = audioBuffer.getChannelData(0)
      const float32Bytes = new Int8Array(float32Data.buffer)

      const params = ggwaveRef.current.getDefaultParameters()
      params.sampleRateInp = tempCtx.sampleRate
      params.sampleRateOut = tempCtx.sampleRate

      const tempInstance = ggwaveRef.current.init(params)

      const CHUNK_SIZE_BYTES = 4096
      const decodedPackets = []   // collect all decoded strings first, then process serially
      let chunksProcessed = 0

      for (let i = 0; i < float32Bytes.length; i += CHUNK_SIZE_BYTES) {
        const chunk = float32Bytes.slice(i, i + CHUNK_SIZE_BYTES)
        chunksProcessed++
        const res = ggwaveRef.current.decode(tempInstance, chunk)

        if (res && res.length > 0) {
          const resBytes = new Uint8Array(res.length)
          for (let j = 0; j < res.length; j++) resBytes[j] = res[j]
          const decoded = new TextDecoder('utf-8').decode(resBytes)
          console.log('File decoded:', decoded)
          decodedPackets.push(decoded)
        }
      }

      ggwaveRef.current.free(tempInstance)
      tempCtx.close()

      if (decodedPackets.length > 0) {
        setGGWaveHint(`📦 Processing ${decodedPackets.length} packet(s) from ${file.name}…`)
        // Feed through the shared serial queue — prevents concurrent state corruption
        for (const pkt of decodedPackets) {
          decodeQueueRef.current = decodeQueueRef.current.then(() => handleRawDecoded(pkt))
        }
        // Chain cleanup so it fires only after the last packet is fully processed
        decodeQueueRef.current = decodeQueueRef.current.then(() => {
          setGGWaveHint(`✅ Decoded ${decodedPackets.length} packet(s) from ${file.name}`)
          setIsDecoding(false)
          setConnStatus(STATUS.READY)
        })
      } else {
        console.log(`No signal found. Chunks: ${chunksProcessed}, pcm bytes: ${float32Bytes.length}`)
        setGGWaveHint(`⚠️ No signal found in ${file.name}`)
        setIsDecoding(false)
        setConnStatus(STATUS.READY)
      }
    } catch (err) {
      console.error('File decode error:', err)
      setGGWaveHint('⚠️ Failed to read audio file')
      setIsDecoding(false)
      setConnStatus(STATUS.READY)
    }
  }

  // ── Start listening ───────────────────────────────────────────────────────────
  const startListening = async () => {
    if (!ggwaveRef.current) {
      console.error('GGWave not ready')
      return
    }
    try {
      // ── Step 1: Create AudioContext at 48000 Hz ──
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      audioCtxRef.current = new AudioCtx({ sampleRate: 48000 })
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume()
      }
      const actualRate = audioCtxRef.current.sampleRate
      console.log('AudioContext state:', audioCtxRef.current.state, '@', actualRate, 'Hz')

      // ── Step 2: Init ggwave instance ──
      const params = ggwaveRef.current.getDefaultParameters()
      params.sampleRateInp = actualRate
      params.sampleRateOut = actualRate
      instanceRef.current = ggwaveRef.current.init(params)
      console.log('GGWave instance ready, sampleRate:', actualRate)

      // ── Step 3: Get mic access (use selected device) ──
      const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
      if (selectedMicId && selectedMicId !== 'default') {
        audioConstraints.deviceId = { exact: selectedMicId }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      rawStreamRef.current = stream

      // Re-enumerate if we hadn't gotten labels yet
      if (micDevices.length === 0) {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices
          .filter(d => d.kind === 'audioinput')
          .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone (${d.deviceId.slice(0, 8)})` }))
        setMicDevices(mics)
      }

      const trackLabel = stream.getAudioTracks()[0]?.label ?? 'unknown'
      console.log('Mic granted:', trackLabel)

      // ── Step 4: Wire mic → ScriptProcessor → destination ──
      mediaStreamRef.current = audioCtxRef.current.createMediaStreamSource(stream)
      recorderRef.current = audioCtxRef.current.createScriptProcessor(1024, 1, 1)

      // RAF-based level update (max one re-render per animation frame, ~60fps)
      const updateLevel = () => {
        setAudioLevel(Math.round(levelAccRef.current * 100))
        levelAccRef.current = 0
        levelRafRef.current = requestAnimationFrame(updateLevel)
      }
      levelRafRef.current = requestAnimationFrame(updateLevel)

      recorderRef.current.onaudioprocess = (e) => {
        const float32Data = new Float32Array(e.inputBuffer.getChannelData(0))

        // ── Level accumulation (max of absolute values in this chunk) ──
        let peak = 0
        for (let i = 0; i < float32Data.length; i++) {
          const abs = Math.abs(float32Data[i])
          if (abs > peak) peak = abs
        }
        if (peak > levelAccRef.current) levelAccRef.current = peak

        // ── Signal-level receiving indicator ──
        const avg = peak
        if (avg > 0.005) {
          if (!isReceivingRef.current) {
            isReceivingRef.current = true
            setConnStatus(STATUS.RECEIVING)
          }
          if (receivingTimeoutRef.current) clearTimeout(receivingTimeoutRef.current)
          receivingTimeoutRef.current = setTimeout(() => {
            isReceivingRef.current = false
            setConnStatus(s => s === STATUS.RECEIVING ? STATUS.LISTENING : s)
          }, 500)
        }

        // ── GGWave decode ──
        try {
          const int8Data = convertTypedArray(float32Data, Int8Array)
          const res = ggwaveRef.current?.decode(instanceRef.current, int8Data)
          if (res && res.length > 0) {
            const decoded = new TextDecoder('utf-8').decode(res)
            console.log('GGWave decoded:', decoded)
            // Chain onto the queue so packets are processed serially, never concurrently
            decodeQueueRef.current = decodeQueueRef.current.then(() => handleRawDecoded(decoded)).then(() => {
              // Resolve drain immediately if we're in drain mode
              if (drainResolveRef.current) {
                drainResolveRef.current()
                drainResolveRef.current = null
              }
            })
          }
        } catch (err) {
          if (instanceRef.current) console.error('GGWave decode error:', err)
        }
      }

      mediaStreamRef.current.connect(recorderRef.current)
      recorderRef.current.connect(audioCtxRef.current.destination)

      setGGWaveHint('')
      setIsListening(true)
      setIsDecoding(false)
      setConnStatus(STATUS.LISTENING)
      console.log('Listening started')
    } catch (err) {
      console.error('startListening error:', err)
      if (audioCtxRef.current) {
        audioCtxRef.current.close()
        audioCtxRef.current = null
      }
      rawStreamRef.current?.getTracks().forEach(t => t.stop())
      rawStreamRef.current = null
    }
  }

  // ── Graceful stop ─────────────────────────────────────────────────────────────
  // 1. Mutes mic immediately (no new audio enters ggwave)
  // 2. Keeps ScriptProcessor alive for up to 4 s to drain ggwave's internal buffer
  // 3. Hard-stops when decode succeeds OR drain timer fires
  const stopListening = useCallback(() => {
    if (!isListening) return

    // Stop mic tracks — no new audio
    rawStreamRef.current?.getTracks().forEach(t => t.stop())
    rawStreamRef.current = null

    // Disconnect mic source from processor (processor stays connected to ctx destination)
    mediaStreamRef.current?.disconnect()
    mediaStreamRef.current = null

    // Cancel level RAF
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = null
    }
    setAudioLevel(0)

    setIsListening(false)
    setIsDecoding(true)
    setConnStatus(STATUS.DECODING)
    console.log('Mic stopped — draining ggwave for up to 4 s…')

    new Promise(resolve => {
      drainResolveRef.current = resolve
      drainTimerRef.current = setTimeout(resolve, 4000)
    }).then(() => {
      console.log('Drain complete — tearing down')
      hardStop()
    })
  }, [isListening, hardStop])

  // ── Session cleanup ───────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => msgSessionsRef.current.cleanup(), 10_000)
    return () => clearInterval(id)
  }, [])

  // ─── Render ───────────────────────────────────────────────────────────────────
  const isLocked = connStatus === STATUS.LOCKED
  const showMeter = isListening || isDecoding

  return (
    <div className="ec-root">
      {flashGreen && <div className="ec-flash" />}

      {/* PASSPHRASE SCREEN */}
      {isLocked ? (
        <div className="ec-lock-overlay">
          <div className="ec-lock-card">
            <h1 className="ec-lock-title">ECHOCRYPT</h1>
            <p className="ec-lock-sub">SECURE DATA LINK TERMINAL</p>

            <div className="ec-lock-input-group">
              <span className="ec-lock-prompt">&gt;</span>
              <input
                className="ec-lock-input"
                type="password"
                placeholder="ENTER_PASSPHRASE"
                value={passphraseInput}
                onChange={e => setPassphraseInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handlePassphraseSubmit()}
                autoFocus
              />
            </div>

            {keyError && <p className="ec-lock-error">ERR: {keyError}</p>}

            <button
              className="ec-btn-terminal"
              onClick={handlePassphraseSubmit}
              disabled={keyLoading}
            >
              {keyLoading ? 'DERIVING_KEY...' : 'INITIALIZE_LINK'}
            </button>
          </div>
        </div>
      ) : (
        /* DASHBOARD SCREEN */
        <div className="hud-dashboard">

          <header className="hud-top-bar">
            <div className="hud-brand">
              <span className="hud-brand-logo">ECHOCRYPT_</span>
              <span className="hud-brand-sub">SYS.v9 // ACOUSTIC_LINK</span>
            </div>
            <div className="hud-status-wrapper">
              <span className="hud-crypto-badge">AES-256 GCM SECURED</span>
              <StatusBadge status={connStatus} />
            </div>
          </header>

          <div className="hud-grid">

            {/* LEFT: SENSOR TELEMETRY */}
            <aside className="hud-sidebar">
              <div className="hud-panel">
                <div className="hud-panel-title">SENSOR ARRAY</div>
                <div className="hud-panel-content">
                  {micDevices.length > 0 && !isListening && !isDecoding && (
                    <select className="hud-mic-select" value={selectedMicId} onChange={e => setSelectedMicId(e.target.value)}>
                      <option value="default">SYS.DEFAULT_MIC</option>
                      {micDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label.toUpperCase()}</option>)}
                    </select>
                  )}

                  <div className="hud-controls-grid">
                    <button className={`hud-btn ${isListening ? 'active' : ''}`} onClick={isListening ? stopListening : startListening} disabled={!ggwaveRef.current || isDecoding}>
                      {isDecoding ? 'DECODING' : isListening ? 'HALT_RX' : 'INIT_RX'}
                    </button>
                    <label className={`hud-btn-outline ${isDecoding ? 'disabled' : ''}`}>
                      LOAD_WAV
                      <input type="file" accept=".wav,audio/wav" onChange={decodeFromFile} style={{ display: 'none' }} disabled={isDecoding} />
                    </label>
                    <button className="hud-btn-outline warning" onClick={() => { hardStop(); derivedKeyRef.current = null; setConnStatus(STATUS.LOCKED) }} disabled={isDecoding}>
                      SYS_RESET
                    </button>
                  </div>
                </div>
              </div>

              <div className="hud-panel hud-meter-panel">
                <div className="hud-panel-title">TELEMETRY_DATA</div>
                <div className="hud-meter-content">
                  {showMeter ? (
                    <div className="hud-meter-container">
                      <div className="hud-meter-bar" style={{ height: `${Math.min(audioLevel * 2, 100)}%` }}></div>
                      <span className="hud-meter-value">LVL {audioLevel}</span>
                    </div>
                  ) : (
                    <div className="hud-meter-idle">SENSORS_IDLE</div>
                  )}
                </div>
              </div>
            </aside>

            {/* CENTER: MAIN TERMINAL STREAM */}
            <main className="hud-terminal">
              <div className="hud-terminal-header">
                <span className="hud-terminal-tab">LIVE_STREAM</span>
                <span className="hud-terminal-tab dim">ARCHIVE</span>
              </div>

              <div className="hud-terminal-body">
                {messages.length === 0 ? (
                  <div className="hud-empty-state">
                    <div className="hud-radar">
                      <div className="hud-radar-sweep"></div>
                      <div className="hud-radar-grid"></div>
                    </div>
                    <div className="hud-empty-text">AWAITING TRANSMISSION...</div>
                  </div>
                ) : (
                  <div className="hud-message-stream">
                    {messages.map(msg => <MessageCard key={msg.id} msg={msg} />)}
                  </div>
                )}
              </div>

              {/* COMMAND PROMPT AT BOTTOM OF TERMINAL */}
              <div className="hud-command-line">
                <label className={`hud-attach-btn ${isSending ? 'disabled' : ''}`}>
                  [ATTACH]
                  <input ref={imgPickerRef} type="file" accept="image/*" style={{ display: 'none' }} disabled={isSending} onChange={e => { const f = e.target.files[0]; e.target.value = null; if (f) sendImageMsg(f); }} />
                </label>
                <span className="hud-prompt-char">root@echo:~#</span>
                <input id="ec-send-input" className="hud-cmd-input" type="text" placeholder={isSending ? 'TRANSMITTING_PAYLOAD...' : 'Enter command or payload...'} value={inputText} disabled={isSending} onChange={e => setInputText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && inputText.trim()) { e.preventDefault(); sendTextMsg(inputText); setInputText(''); } }} />
                <button className="hud-cmd-submit" disabled={isSending || !inputText.trim()} onClick={() => { sendTextMsg(inputText); setInputText('') }}>
                  {isSending ? 'TX...' : 'EXEC'}
                </button>
              </div>
            </main>

          </div>
        </div>
      )}
    </div>
  )
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    [STATUS.LOCKED]: { label: 'SYS_LOCKED', cls: 'locked' },
    [STATUS.READY]: { label: 'SYS_READY', cls: 'ready' },
    [STATUS.LISTENING]: { label: 'SENSORS_ACTIVE', cls: 'listening' },
    [STATUS.RECEIVING]: { label: 'RX_DATA_STREAM', cls: 'receiving' },
    [STATUS.DECODING]: { label: 'DECRYPTING', cls: 'decoding' },
  }
  const { label, cls } = map[status] || map[STATUS.LOCKED]
  return (
    <div className={`hud-status-badge ${cls}`}>
      <div className="hud-status-dot"></div>
      <span>{label}</span>
    </div>
  )
}

// ─── MessageCard ─────────────────────────────────────────────────────────────
function MessageCard({ msg }) {
  const isOut = msg.kind === 'msg_out' || msg.kind === 'img_out'
  const label =
    msg.kind === 'img' ? 'PAYLOAD: IMAGE_RX'
      : msg.kind === 'img_out' ? 'PAYLOAD: IMAGE_TX'
        : msg.kind === 'msg' ? 'PAYLOAD: TEXT_RX'
          : msg.kind === 'msg_out' ? 'PAYLOAD: TEXT_TX'
            : msg.kind === 'msg_partial' ? 'BUFFERING_STREAM'
              : 'UNKNOWN_SIGNAL'
  return (
    <div className={`hud-log-entry ${isOut ? 'hud-log-out' : 'hud-log-in'}`}>
      <div className="hud-log-meta">
        <span className="hud-log-time">[{msg.timestamp}]</span>
        <span className="hud-log-label">{label}</span>
        {msg.sessionId && <span className="hud-log-sid">ID:{msg.sessionId.substring(0, 8)}</span>}
      </div>
      <div className="hud-log-content">
        <span className="hud-log-caret">&gt;</span>
        <div className="hud-log-body">
          <MessageBody msg={msg} />
        </div>
      </div>
    </div>
  )
}

// ─── MessageBody ─────────────────────────────────────────────────────────────
function MessageBody({ msg }) {
  switch (msg.kind) {
    case 'msg':
      return <div className={`hud-text ${msg.isDecrypted ? '' : 'hud-error'}`}>{msg.text}</div>
    case 'msg_out':
      return <div className="hud-text">{msg.text}</div>
    case 'msg_partial':
      return (
        <div className="hud-partial">
          <ProgressBar value={msg.receivedCount} max={msg.total} />
          <span className="hud-partial-text">ASSEMBLING [ {msg.receivedCount} / {msg.total} ]</span>
        </div>
      )
    case 'img':
      return (
        <div className="hud-img-wrap">
          {!msg.isComplete && (
            <div className="hud-img-loading">
              <ProgressBar value={msg.receivedCount} max={msg.total} />
              <span>FRAGMENTS: {msg.receivedCount}/{msg.total}</span>
              {msg.missing.length > 0 && <span className="hud-error">MISSING_PKT: {msg.missing.join(', ')}</span>}
            </div>
          )}
          {msg.isComplete && !msg.dataUrl && <div className="hud-error">ERR: DECRYPTION_FAILED</div>}
          {msg.dataUrl && (
            <div className="hud-img-success">
              <img src={msg.dataUrl} alt="RX" className="hud-img-render" />
              <button className="hud-btn-outline" onClick={() => {
                const a = document.createElement('a'); a.href = msg.dataUrl; a.download = `intel-${Date.now()}.jpg`; a.click()
              }}>[ SAVE_TO_DISK ]</button>
            </div>
          )}
        </div>
      )
    case 'img_out':
      return (
        <div className="hud-img-wrap">
          <img src={msg.dataUrl} alt="TX" className="hud-img-render" />
          <span className="hud-muted">TX_SUCCESS ({msg.total} PKT)</span>
        </div>
      )
    case 'text':
    default:
      return <div className="hud-text">{msg.text}</div>
  }
}

// ─── ProgressBar ─────────────────────────────────────────────────────────────
function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="hud-progress-bg">
      <div className="hud-progress-fill" style={{ width: `${pct}%` }}></div>
    </div>
  )
}

export default AppNew

// ─── Scoped styles ────────────────────────────────────────────────────────────
const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  
  :root {
    --bg-void: #15161A;
    --bg-surface: #1E1F24;
    --bg-elevated: #282A30;
    --border-light: rgba(255, 255, 255, 0.1);
    
    --amber: #FF9E00;
    --amber-dim: rgba(255, 158, 0, 0.15);
    
    --cyan: #00E5FF;
    --cyan-dim: rgba(0, 229, 255, 0.15);
    
    --red: #FF3366;
    --red-dim: rgba(255, 51, 102, 0.15);
    
    --text-primary: #D1D5DB;
    --text-secondary: #9CA3AF;
    
    --mono: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
  }

  body {
    background: var(--bg-void); color: var(--text-primary); font-family: var(--mono);
    font-size: 13px; line-height: 1.5; min-height: 100dvh; overflow: hidden;
  }
  
  .ec-root { position: relative; width: 100vw; height: 100dvh; display: flex; flex-direction: column; }
  
  /* FLASH ANIMATION */
  .ec-flash { position:fixed; inset:0; z-index:9999; background:var(--cyan-dim); pointer-events:none; animation:ec-flash-anim .3s ease-out forwards; }
  @keyframes ec-flash-anim { from{opacity:1} to{opacity:0} }

  /* LOCK SCREEN (Amber Theme) */
  .ec-lock-overlay {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at center, var(--bg-surface) 0%, var(--bg-void) 100%);
    z-index: 100;
  }
  .ec-lock-card {
    border: 1px solid var(--amber); background: rgba(30, 31, 36, 0.8);
    box-shadow: 0 0 30px var(--amber-dim);
    padding: 40px; width: 100%; max-width: 400px;
    display: flex; flex-direction: column; align-items: center; text-align: center;
    backdrop-filter: blur(10px);
  }
  .ec-lock-title { font-size: 24px; color: var(--amber); letter-spacing: 0.2em; margin-bottom: 8px; text-shadow: 0 0 10px var(--amber); }
  .ec-lock-sub { color: var(--text-secondary); font-size: 11px; letter-spacing: 0.1em; margin-bottom: 30px; }
  
  .ec-lock-input-group {
    display: flex; align-items: center; width: 100%; background: var(--bg-void); border: 1px solid var(--border-light);
    padding: 12px 16px; margin-bottom: 20px; transition: border 0.2s;
  }
  .ec-lock-input-group:focus-within { border-color: var(--amber); box-shadow: 0 0 10px var(--amber-dim); }
  .ec-lock-prompt { color: var(--amber); margin-right: 12px; font-weight: bold; }
  .ec-lock-input {
    flex: 1; background: transparent; border: none; color: var(--text-primary); font-family: var(--mono); outline: none; text-align: center;
  }
  .ec-lock-input::placeholder { color: var(--text-secondary); opacity: 0.5; text-align: center; }
  
  .ec-btn-terminal {
    background: var(--amber-dim); border: 1px solid var(--amber); color: var(--amber);
    padding: 12px; width: 100%; font-family: var(--mono); font-weight: bold; cursor: pointer; transition: 0.2s;
  }
  .ec-btn-terminal:hover:not(:disabled) { background: var(--amber); color: var(--bg-void); }
  .ec-btn-terminal:disabled { opacity: 0.5; cursor: not-allowed; border-color: var(--border-light); color: var(--text-secondary); background: transparent; }
  .ec-lock-error { color: var(--red); font-size: 11px; margin-bottom: 12px; }

  /* HUD DASHBOARD */
  .hud-dashboard {
    flex: 1; display: flex; flex-direction: column; padding: 16px; gap: 16px; height: 100dvh;
  }

  .hud-top-bar {
    display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid var(--border-light); padding-bottom: 16px;
  }
  .hud-brand { display: flex; align-items: baseline; gap: 12px; }
  .hud-brand-logo { font-size: 18px; font-weight: bold; color: var(--amber); letter-spacing: 0.1em; }
  .hud-brand-sub { font-size: 10px; color: var(--text-secondary); letter-spacing: 0.05em; }
  
  .hud-status-wrapper { display: flex; align-items: center; gap: 16px; }
  .hud-crypto-badge { font-size: 10px; color: var(--cyan); border: 1px solid var(--cyan-dim); padding: 4px 8px; background: rgba(0,229,255,0.05); }

  /* GRID LAYOUT */
  .hud-grid {
    flex: 1; display: grid; grid-template-columns: 280px 1fr; gap: 16px; min-height: 0;
  }

  /* SIDEBAR */
  .hud-sidebar { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
  .hud-panel {
    background: var(--bg-surface); border: 1px solid var(--border-light);
    display: flex; flex-direction: column;
  }
  .hud-panel-title {
    background: var(--border-light); color: var(--text-primary); font-size: 10px; padding: 6px 12px;
    letter-spacing: 0.1em; font-weight: bold;
  }
  .hud-panel-content { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  
  .hud-mic-select {
    width: 100%; background: var(--bg-void); border: 1px solid var(--border-light); color: var(--text-primary);
    font-family: var(--mono); font-size: 11px; padding: 8px; outline: none; cursor: pointer;
  }
  
  .hud-controls-grid { display: flex; flex-direction: column; gap: 8px; }
  .hud-btn {
    background: var(--amber-dim); border: 1px solid var(--amber); color: var(--amber);
    font-family: var(--mono); font-size: 11px; padding: 10px; cursor: pointer; font-weight: bold; transition: 0.2s;
  }
  .hud-btn:hover:not(:disabled) { background: var(--amber); color: var(--bg-void); }
  .hud-btn.active { background: var(--red-dim); border-color: var(--red); color: var(--red); }
  .hud-btn:disabled { opacity: 0.5; cursor: not-allowed; border-color: var(--border-light); color: var(--text-secondary); background: transparent; }

  .hud-btn-outline {
    background: transparent; border: 1px solid var(--border-light); color: var(--text-primary);
    font-family: var(--mono); font-size: 11px; padding: 10px; cursor: pointer; text-align: center; transition: 0.2s;
  }
  .hud-btn-outline:hover:not(.disabled) { border-color: var(--amber); color: var(--amber); }
  .hud-btn-outline.disabled { opacity: 0.5; cursor: not-allowed; }
  .hud-btn-outline.warning:hover { border-color: var(--red); color: var(--red); }

  /* METER PANEL */
  .hud-meter-panel { flex: 1; min-height: 150px; }
  .hud-meter-content { padding: 16px; flex: 1; display: flex; align-items: center; justify-content: center; height: 100%; }
  .hud-meter-container { display: flex; flex-direction: column; align-items: center; gap: 12px; height: 100%; width: 100%; justify-content: flex-end; }
  .hud-meter-bar { width: 40px; background: var(--amber); transition: height 0.05s linear; box-shadow: 0 0 15px var(--amber); max-height: 100%; }
  .hud-meter-value { font-size: 10px; color: var(--amber); margin-top: auto; }
  .hud-meter-idle { color: var(--text-secondary); font-size: 11px; opacity: 0.5; }

  /* MAIN TERMINAL */
  .hud-terminal {
    background: var(--bg-surface); border: 1px solid var(--border-light);
    display: flex; flex-direction: column; min-height: 0;
  }
  .hud-terminal-header {
    display: flex; border-bottom: 1px solid var(--border-light);
  }
  .hud-terminal-tab {
    padding: 8px 16px; font-size: 10px; border-right: 1px solid var(--border-light);
    color: var(--amber); font-weight: bold; background: var(--amber-dim);
  }
  .hud-terminal-tab.dim { background: transparent; color: var(--text-secondary); font-weight: normal; }

  .hud-terminal-body {
    flex: 1; overflow-y: auto; padding: 20px; position: relative;
  }

  /* EMPTY STATE */
  .hud-empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; opacity: 0.7;
  }
  .hud-radar {
    width: 120px; height: 120px; border: 1px solid var(--amber); border-radius: 50%;
    position: relative; margin-bottom: 24px; box-shadow: 0 0 20px var(--amber-dim);
  }
  .hud-radar-grid {
    position: absolute; inset: 0; border-radius: 50%;
    background: 
      linear-gradient(90deg, transparent 49%, var(--amber) 49%, var(--amber) 51%, transparent 51%),
      linear-gradient(0deg, transparent 49%, var(--amber) 49%, var(--amber) 51%, transparent 51%);
    opacity: 0.3;
  }
  .hud-radar-sweep {
    position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(from 0deg, transparent 70%, rgba(255, 158, 0, 0.8) 100%);
    animation: sweep 2s linear infinite;
  }
  @keyframes sweep { to { transform: rotate(360deg); } }
  .hud-empty-text { font-size: 12px; color: var(--amber); letter-spacing: 0.2em; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% {opacity:1} 50% {opacity:0.4} }

  /* COMMAND LINE (Input) */
  .hud-command-line {
    border-top: 1px solid var(--border-light); background: var(--bg-void);
    display: flex; align-items: center; padding: 12px 16px; gap: 12px;
  }
  .hud-attach-btn {
    color: var(--text-secondary); cursor: pointer; transition: 0.2s; font-weight: bold; font-size: 11px;
  }
  .hud-attach-btn:hover:not(.disabled) { color: var(--amber); }
  .hud-attach-btn.disabled { opacity: 0.5; cursor: not-allowed; }
  
  .hud-prompt-char { color: var(--amber); font-weight: bold; font-size: 13px; }
  .hud-cmd-input {
    flex: 1; background: transparent; border: none; outline: none;
    color: var(--text-primary); font-family: var(--mono); font-size: 13px;
  }
  .hud-cmd-input::placeholder { color: var(--text-secondary); opacity: 0.5; }
  
  .hud-cmd-submit {
    background: var(--amber); color: var(--bg-void); border: none;
    font-family: var(--mono); font-size: 11px; font-weight: bold; padding: 6px 16px; cursor: pointer;
  }
  .hud-cmd-submit:disabled { background: var(--border-light); color: var(--text-secondary); cursor: not-allowed; }

  /* LOG ENTRIES (Messages) */
  .hud-message-stream { display: flex; flex-direction: column; gap: 12px; }
  .hud-log-entry {
    border-left: 2px solid var(--amber); background: var(--amber-dim);
    padding: 12px 16px; display: flex; flex-direction: column; gap: 6px;
  }
  .hud-log-in { border-left-color: var(--cyan); background: var(--cyan-dim); }
  
  .hud-log-meta { display: flex; gap: 16px; font-size: 10px; color: var(--amber); opacity: 0.8; letter-spacing: 0.05em; }
  .hud-log-in .hud-log-meta { color: var(--cyan); }
  
  .hud-log-content { display: flex; gap: 12px; color: var(--text-primary); }
  .hud-log-caret { color: var(--text-secondary); }
  .hud-log-body { flex: 1; word-break: break-word; white-space: pre-wrap; }
  
  .hud-error { color: var(--red); }
  .hud-muted { color: var(--text-secondary); font-size: 11px; }
  
  .hud-partial { display: flex; align-items: center; gap: 12px; }
  .hud-partial-text { font-size: 11px; color: var(--cyan); }
  
  .hud-progress-bg { flex: 1; max-width: 200px; height: 4px; background: rgba(255,255,255,0.1); }
  .hud-progress-fill { height: 100%; background: var(--cyan); transition: width 0.2s; }
  .hud-log-out .hud-progress-fill { background: var(--amber); }

  .hud-img-wrap { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
  .hud-img-render { max-width: 300px; border: 1px solid var(--border-light); }
  .hud-img-success { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }

  /* STATUS BADGE COMPONENT */
  .hud-status-badge { display: flex; align-items: center; gap: 8px; font-size: 10px; font-weight: bold; }
  .hud-status-dot { width: 8px; height: 8px; border-radius: 50%; }
  
  .hud-status-badge.locked { color: var(--text-secondary); }
  .hud-status-badge.locked .hud-status-dot { background: var(--text-secondary); }
  
  .hud-status-badge.ready { color: var(--amber); }
  .hud-status-badge.ready .hud-status-dot { background: var(--amber); box-shadow: 0 0 8px var(--amber); }
  
  .hud-status-badge.listening { color: var(--cyan); }
  .hud-status-badge.listening .hud-status-dot { background: var(--cyan); box-shadow: 0 0 8px var(--cyan); animation: pulse 1s infinite; }
  
  .hud-status-badge.receiving { color: var(--cyan); }
  .hud-status-badge.receiving .hud-status-dot { background: var(--cyan); box-shadow: 0 0 8px var(--cyan); animation: pulse 0.2s infinite; }
  
  .hud-status-badge.decoding { color: var(--amber); }
  .hud-status-badge.decoding .hud-status-dot { background: var(--amber); animation: pulse 0.1s infinite; }

  /* SCROLLBAR */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg-void); }
  ::-webkit-scrollbar-thumb { background: var(--border-light); }
  ::-webkit-scrollbar-thumb:hover { background: var(--amber); }

  @media (max-width: 768px) {
    .hud-grid { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .hud-sidebar { flex-direction: row; flex-wrap: wrap; }
    .hud-panel { flex: 1; min-width: 250px; }
  }
`

if (typeof document !== 'undefined' && !document.getElementById('echocrypt-styles')) {
  const style = document.createElement('style')
  style.id = 'echocrypt-styles'
  style.textContent = CSS
  document.head.appendChild(style)
}