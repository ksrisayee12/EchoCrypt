"""
EchoCrypt sender CLI

Usage:
  python sender.py text "hello world" --password "secretphrase"
  python sender.py image photo.jpg --password "secretphrase" --id A1

Full pipeline:
  Input → bytes → encrypt → steg_wrap → base64 → packets → ggwave → speaker
"""

import argparse
import base64
import random
import string
import sys
import time

import numpy as np
import sounddevice as sd

from crypto import derive_key, encrypt
from steg import steg_wrap
from encode_image_v2 import encode_image_to_packets_v2

# ─── GGWave ───────────────────────────────────────────────────────────────────

try:
    import ggwave
except ImportError:
    print("ERROR: ggwave not installed. Run: pip install ggwave")
    sys.exit(1)

GGWAVE_PROTOCOL_ID = 1   # audible, reliable
GGWAVE_VOLUME = 100
SAMPLE_RATE = 48_000
INTER_PACKET_DELAY = 0.1  # seconds between packets


def transmit(packet: str) -> None:
    """Encode a single ASCII packet with GGWave and play it through the speaker."""
    wav_bytes = ggwave.encode(packet, protocolId=GGWAVE_PROTOCOL_ID, volume=GGWAVE_VOLUME)
    audio = np.frombuffer(wav_bytes, dtype=np.float32)
    sd.play(audio, samplerate=SAMPLE_RATE, blocking=True)


def transmit_packets(packets: list[str], verbose: bool = True, save_path: str = None) -> None:
    total = len(packets)
    
    if save_path:
        print(f"  Generating audio for {total} packet(s)...")
        import soundfile as sf
        all_audio = []
        silence = np.zeros(int(SAMPLE_RATE * INTER_PACKET_DELAY), dtype=np.float32)
        
        for i, pkt in enumerate(packets, 1):
            if verbose:
                print(f"  [{i}/{total}] Encoding {pkt[:60]}{'...' if len(pkt) > 60 else ''}")
            wav_bytes = ggwave.encode(pkt, protocolId=GGWAVE_PROTOCOL_ID, volume=GGWAVE_VOLUME)
            audio = np.frombuffer(wav_bytes, dtype=np.float32)
            all_audio.append(audio)
            if i < total:
                all_audio.append(silence)
                
        final_audio = np.concatenate(all_audio)
        sf.write(save_path, final_audio, samplerate=SAMPLE_RATE)
        print(f"  Saved transmission to {save_path}")
        return

    print("  Starting in 2 seconds...")
    time.sleep(2)   # add this line
    for i, pkt in enumerate(packets, 1):
        if verbose:
            print(f"  [{i}/{total}] {pkt[:60]}{'...' if len(pkt) > 60 else ''}")
        transmit(pkt)
        if i < total:
            time.sleep(INTER_PACKET_DELAY)


# ─── Random ID ────────────────────────────────────────────────────────────────

def random_id(length: int = 2) -> str:
    """Generate a random alphanumeric session ID."""
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=length))


# ─── Text mode ────────────────────────────────────────────────────────────────

def encode_text_to_packets(
    text: str,
    msg_id: str,
    key: bytes,
    max_payload_len: int = 115   # 140 (ggwave max) - 14 (worst-case header: MSG|AB|99/99|) - 11 buffer
) -> list[str]:
    """
    Encrypt text and split into MSG packets.

    Single-packet format:  MSG|<id>|<payload>
    Multi-packet format:   MSG|<id>|<idx>/<total>|<payload>
    """
    plaintext = text.encode('utf-8')
    encrypted = encrypt(plaintext, key)
    wrapped = steg_wrap(encrypted)
    b64 = base64.b64encode(wrapped).decode('ascii')

    chunks = [b64[i:i + max_payload_len] for i in range(0, len(b64), max_payload_len)]
    total = len(chunks)

    if total == 1:
        return [f"MSG|{msg_id}|{chunks[0]}"]
    else:
        return [f"MSG|{msg_id}|{i + 1}/{total}|{chunk}" for i, chunk in enumerate(chunks)]


def cmd_text(args) -> None:
    print(f"[EchoCrypt] Deriving key from passphrase...")
    key = derive_key(args.password)

    msg_id = args.id or random_id()
    print(f"[EchoCrypt] Session ID: {msg_id}")

    packets = encode_text_to_packets(args.message, msg_id, key)
    print(f"[EchoCrypt] Transmitting {len(packets)} packet(s) for text message...")
    transmit_packets(packets, verbose=args.verbose, save_path=args.save)
    print("[EchoCrypt] Transmission complete.")


# ─── Image mode ───────────────────────────────────────────────────────────────

def encode_image_to_encrypted_packets(
    image_path: str,
    img_id: str,
    key: bytes,
    max_payload_len: int = 115,   # 140 (ggwave max) - 25 (IMG|AB|99/99|crc32hex| header)
    quality: int = 35,
) -> list[str]:
    """
    Encode an image, encrypt the compressed bytes, then split into IMG packets.

    This encrypts the raw image bytes before base64-encoding, so the receiver
    must: base64-decode → steg_unwrap → decrypt → reconstruct JPEG.

    Note: The existing AppNew.jsx IMG handler does NOT do decryption yet —
    that will be wired up in Step 9 of the implementation plan.
    For now this produces encrypted IMG packets for the Python → Python path.
    """
    from PIL import Image
    from io import BytesIO

    img = Image.open(image_path).resize((64, 64))
    buf = BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    raw_jpeg = buf.getvalue()

    encrypted = encrypt(raw_jpeg, key)
    wrapped = steg_wrap(encrypted)
    b64 = base64.b64encode(wrapped).decode('ascii')

    import zlib

    def crc32_hex(s: str) -> str:
        return f"{(zlib.crc32(s.encode('ascii')) & 0xFFFFFFFF):08x}"

    chunks = [b64[i:i + max_payload_len] for i in range(0, len(b64), max_payload_len)]
    total = len(chunks)

    packets = []
    for idx, chunk in enumerate(chunks, 1):
        crc = crc32_hex(chunk)
        pkt = f"IMG|{img_id}|{idx}/{total}|{crc}|{chunk}"
        packets.append(pkt)

    return packets


def cmd_image(args) -> None:
    print(f"[EchoCrypt] Deriving key from passphrase...")
    key = derive_key(args.password)

    img_id = args.id or random_id()
    print(f"[EchoCrypt] Session ID: {img_id}")

    if args.encrypt:
        print(f"[EchoCrypt] Encoding + encrypting image: {args.image_path}")
        packets = encode_image_to_encrypted_packets(args.image_path, img_id, key)
    else:
        print(f"[EchoCrypt] Encoding image (no encryption): {args.image_path}")
        packets = encode_image_to_packets_v2(
            in_path=args.image_path,
            img_id=img_id,
            max_payload_len=115,
            max_frame_len=140,
            out_format="JPEG",
            resize_to=(64, 64),
            quality=35,
        )

    print(f"[EchoCrypt] Transmitting {len(packets)} packet(s)...")
    transmit_packets(packets, verbose=args.verbose, save_path=args.save)
    print("[EchoCrypt] Transmission complete.")


# ─── CLI ──────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sender",
        description="EchoCrypt — transmit encrypted data over sound"
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Print each packet as it transmits")

    sub = parser.add_subparsers(dest="command", required=True)

    # text subcommand
    p_text = sub.add_parser("text", help="Transmit an encrypted text message")
    p_text.add_argument("message", help="The message to send")
    p_text.add_argument("--password", "-p", required=True, help="Shared passphrase")
    p_text.add_argument("--id", help="Session ID (default: random 2-char)")
    p_text.add_argument("--save", help="Save transmission to WAV file instead of playing it")
    p_text.set_defaults(func=cmd_text)

    # image subcommand
    p_img = sub.add_parser("image", help="Transmit an image")
    p_img.add_argument("image_path", help="Path to image file")
    p_img.add_argument("--password", "-p", required=True, help="Shared passphrase")
    p_img.add_argument("--id", help="Session ID (default: random 2-char)")
    p_img.add_argument("--save", help="Save transmission to WAV file instead of playing it")
    p_img.add_argument("--encrypt", action="store_true",
                       help="Encrypt image bytes before transmission (Python→Python only for now)")
    p_img.set_defaults(func=cmd_image)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
