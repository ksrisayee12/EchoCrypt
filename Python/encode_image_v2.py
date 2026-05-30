"""
Multi-packet image protocol v2 encoder
Encodes images into acoustic-friendly packets with CRC32 validation
"""

from __future__ import annotations

import base64
import zlib
from io import BytesIO
from typing import List, Tuple, Literal, Optional
from PIL import Image

PacketFormat = Literal["JPEG", "WEBP", "PNG"]

def _crc32_hex_ascii(s: str) -> str:
    """CRC32 over ASCII bytes of the string, returned as 8 hex chars."""
    return f"{(zlib.crc32(s.encode('ascii')) & 0xFFFFFFFF):08x}"

def _encode_image_bytes(
    img: Image.Image,
    out_format: PacketFormat,
    quality: int = 35
) -> bytes:
    """
    Compress image to bytes. JPEG/WEBP use 'quality'. PNG ignores quality.
    Always converts to RGB for JPEG/WEBP for compatibility.
    """
    buf = BytesIO()
    fmt = out_format.upper()

    if fmt == "JPEG":
        img.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    elif fmt == "WEBP":
        img.convert("RGB").save(buf, format="WEBP", quality=quality, method=6)
    elif fmt == "PNG":
        img.save(buf, format="PNG", optimize=True)
    else:
        raise ValueError("out_format must be JPEG, WEBP, or PNG")

    return buf.getvalue()

def encode_image_to_packets_v2(
    in_path: str,
    img_id: str,
    *,
    max_payload_len: int = 130,     # YOUR constraint
    max_frame_len: int = 140,       # total line length constraint
    out_format: PacketFormat = "JPEG",
    resize_to: Optional[Tuple[int, int]] = (64, 64),
    quality: int = 35
) -> List[str]:
    """
    Reads an image, optionally resizes, compresses, base64-encodes,
    and splits into protocol-v2 packets with CRC32.

    Returns list of strings:
      IMG|<id>|<idx>/<total>|<crc32>|<payload>

    Constraints enforced:
    - payload length <= max_payload_len
    - full packet length <= max_frame_len (asserted)
    """
    if "|" in img_id or not img_id:
        raise ValueError("img_id must be non-empty and must not contain '|'")

    img = Image.open(in_path)
    if resize_to is not None:
        img = img.resize(resize_to, Image.LANCZOS)

    data = _encode_image_bytes(img, out_format=out_format, quality=quality)
    b64 = base64.b64encode(data).decode("ascii")

    # Payload chunking strictly by max_payload_len
    chunks = [b64[i:i + max_payload_len] for i in range(0, len(b64), max_payload_len)]
    total = len(chunks)

    packets: List[str] = []
    for idx, payload in enumerate(chunks, start=1):
        crc = _crc32_hex_ascii(payload)
        pkt = f"IMG|{img_id}|{idx}/{total}|{crc}|{payload}"

        # Enforce constraints
        if len(payload) > max_payload_len:
            raise AssertionError("payload exceeded max_payload_len (unexpected)")
        if len(pkt) > max_frame_len:
            # If this triggers, your header is too long (img_id too long)
            raise ValueError(
                f"Packet too long ({len(pkt)}>{max_frame_len}). "
                f"Shorten img_id or reduce max_payload_len."
            )

        packets.append(pkt)

    return packets


def main():
    """Example usage"""
    import sys
    
    if len(sys.argv) < 3:
        print("Usage: python encode_image_v2.py <input_image> <image_id> [quality]")
        print("Example: python encode_image_v2.py photo.jpg A1 35")
        sys.exit(1)
    
    input_path = sys.argv[1]
    img_id = sys.argv[2]
    quality = int(sys.argv[3]) if len(sys.argv) > 3 else 35
    
    print(f"Encoding image: {input_path}")
    print(f"Image ID: {img_id}")
    print(f"Quality: {quality}")
    print("-" * 60)
    
    try:
        packets = encode_image_to_packets_v2(
            in_path=input_path,
            img_id=img_id,
            max_payload_len=130,
            max_frame_len=140,
            out_format="JPEG",
            resize_to=(64, 64),
            quality=quality
        )
        
        print(f"Generated {len(packets)} packets")
        print("-" * 60)
        
        for i, pkt in enumerate(packets, 1):
            print(f"Packet {i}/{len(packets)} ({len(pkt)} chars):")
            print(pkt)
            print()
        
        # Save to file
        output_file = f"packets_{img_id}.txt"
        with open(output_file, "w") as f:
            for pkt in packets:
                f.write(pkt + "\n")
        
        print(f"Packets saved to: {output_file}")
        
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

# Made with Bob
