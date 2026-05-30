# EchoCrypt

Secure, offline, peer-to-peer communication over sound. No WiFi. No Bluetooth. No network. Speaker → air → microphone.

Built on [GGWave](https://github.com/ggerganov/ggwave) for acoustic data transmission and AES-256-GCM for end-to-end encryption.

---

## Quick start

### React receiver app

```bash
cd React_App
npm install
npm run dev
# Open http://localhost:5173 in Chrome
```

### Python sender

```bash
cd Python
pip install -r requirements.txt

# Send an encrypted text message
python sender.py text "hello world" --password "shared-passphrase"

# Send an image
python sender.py image photo.jpg --password "shared-passphrase" --id A1
```

Both sides must use the **same passphrase**.

---

## How it works

```
Sender (Python)                     Receiver (React)
──────────────                      ────────────────
plaintext                           speaker → microphone
  │ encrypt (AES-256-GCM)             │ ggwave decode
  │ steg_wrap (magic + padding)       │ parsePacket()
  │ base64 encode                      │ SessionManager
  │ split into 115-char chunks        │ reassemble
  │ ggwave encode → speaker           │ stegUnwrap()
                                       │ decrypt (WebCrypto)
                                       └── display plaintext
```

**Encryption**: AES-256-GCM with a key derived via PBKDF2-SHA256 (100k iterations, salt `acoustinet_v1`). The Python and browser implementations share the same byte layout — `nonce(12) + ciphertext + tag(16)` — so they interoperate directly.

**Framing**: Every encrypted blob is wrapped in a steg frame (`magic(4) + length(4) + payload + random_padding`). This lets the receiver detect and strip padding without out-of-band length information, and makes the ciphertext length unpredictable.

**Bandwidth**: ~100–300 bytes/sec real-world. A short text message fits in 1–3 packets. A 64×64 JPEG takes 15–30 packets (~30–90 seconds to transmit fully).

---

## Protocol reference

### MSG packets (text)

```
MSG|<id>|<payload>                    # single packet
MSG|<id>|<idx>/<total>|<payload>      # multi-packet
```

- `id`: 2-char alphanumeric session ID (e.g. `T1`, `M3`)
- `payload`: base64(steg_wrap(encrypt(utf8_text)))

### IMG packets (image)

```
IMG|<id>|<idx>/<total>|<crc32>|<payload>   # v2 with CRC (default)
IMG|<id>|<idx>/<total>|<payload>           # v2 without CRC
IMG|<idx>/<total>|<payload>                # v1 legacy (no session ID)
```

- `payload`: base64 chunk of compressed image bytes (≤ 115 chars)
- `crc32`: 8 hex chars, computed over the base64 payload ASCII (not raw bytes)
- Total packet length: ≤ 140 chars

### NACK

```
NACK|<id>|<missing_csv>
# e.g. NACK|A1|3,7,9
```

---

## File structure

```
project/
├── Python/
│   ├── crypto.py               AES-256-GCM + PBKDF2
│   ├── steg.py                 Magic-byte framing
│   ├── sender.py               CLI transmitter
│   ├── encode_image_v2.py      Image → IMG packets
│   ├── decode_image_v2.py      IMG packets → image
│   └── requirements.txt
│
└── React_App/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    ├── public/
    │   └── ggwave.js           GGWave WASM codec (bundled)
    ├── src/
    │   └── main.jsx            React entry point
    ├── AppNew.jsx              Main app (passphrase, listen, display)
    ├── crypto.js               WebCrypto AES-GCM + PBKDF2
    ├── steg.js                 stegUnwrap() / stegWrap()
    ├── session.js              Session + SessionManager
    └── protocol.js             parsePacket() dispatcher + CRC32
```

---

## Running the roundtrip test (no audio hardware needed)

```bash
cd python
pip install pycryptodome
python test_roundtrip.py
```

This tests the full encrypt → steg_wrap → steg_unwrap → decrypt pipeline in pure Python, confirming the crypto layer is correct before touching GGWave.

---

## Security notes

- **PBKDF2 is intentionally slow** (100k iterations). The browser derives the key once on passphrase submit and caches it in a React ref. Never re-derive per packet.
- **AES-GCM provides authenticated encryption** — if a packet is tampered with or the wrong key is used, decryption fails with an explicit error rather than returning garbage.
- The steg magic bytes (`0xAC 0x00 0x57 0x1C`) are a sanity check, not a security mechanism. Security comes entirely from AES-GCM.
- **Session IDs are not authenticated** — an attacker in the room could inject NACK packets. Treat the acoustic channel as untrusted; the crypto provides confidentiality and integrity for the payload content only.

---

## Browser compatibility

| Browser | Status |
|---------|--------|
| Chrome desktop | ✅ Full support |
| Chrome Android | ✅ Full support |
| Firefox | ✅ Should work |
| iOS Safari | ⚠️ Web Audio restrictions — deprioritized in Phase 1 |

---

## Phase 2: React Native migration

These files transfer unchanged to React Native:
- `crypto.js` → WebCrypto via `react-native-quick-crypto`
- `steg.js`, `session.js`, `protocol.js` → identical

These need replacement:
- GGWave WASM → `ggwave-react-native` native bindings
- Web Audio API → `expo-av` or `react-native-audio-recorder-player`
- React DOM UI → React Native components
