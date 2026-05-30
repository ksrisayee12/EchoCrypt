"""
Multi-packet image protocol v2 decoder
Decodes acoustic packets with CRC32 validation and NACK support
"""

from __future__ import annotations

import base64
import zlib
import re
from typing import Iterable, Dict, List, Tuple, Optional

# Protocol v2 with CRC: IMG|<id>|<idx>/<total>|<crc32>|<payload>
PKT_RE_V2 = re.compile(
    r"^IMG\|(?P<id>[^|]+)\|(?P<idx>\d+)\/(?P<total>\d+)\|(?P<crc>[0-9a-fA-F]{8})\|(?P<payload>.*)$"
)

# Protocol v1 (legacy, no CRC): IMG|<idx>/<total>|<payload>
PKT_RE_V1 = re.compile(
    r"^IMG\|(?P<idx>\d+)\/(?P<total>\d+)\|(?P<payload>.*)$"
)

# Protocol v2 without CRC (optional): IMG|<id>|<idx>/<total>|<payload>
PKT_RE_V2_NO_CRC = re.compile(
    r"^IMG\|(?P<id>[^|]+)\|(?P<idx>\d+)\/(?P<total>\d+)\|(?P<payload>.*)$"
)

def _crc32_hex_ascii(s: str) -> str:
    return f"{(zlib.crc32(s.encode('ascii')) & 0xFFFFFFFF):08x}"

def decode_packets_to_bytes_v2(
    packets: Iterable[str],
    img_id: str,
    validate_crc: bool = True,
) -> Tuple[bytes, List[int]]:
    """
    Consumes packets (any order), optionally validates CRC, and reconstructs image bytes.

    Args:
        packets: Iterable of packet strings
        img_id: Session/image ID to decode
        validate_crc: If True, validate CRC and drop corrupt packets. If False, accept all packets.

    Returns:
      (image_bytes, missing_indices)

    - If validate_crc=True: Corrupt packets are ignored (CRC mismatch).
    - If validate_crc=False: All packets are accepted (no CRC validation).
    - If missing_indices is non-empty, image_bytes will be b"" (not decoded).
    """
    parts: Dict[int, str] = {}
    total_expected: Optional[int] = None

    for line in packets:
        line = line.strip()
        if not line.startswith("IMG|"):
            continue

        # Try v2 with CRC first
        m = PKT_RE_V2.match(line)
        has_crc = True
        
        if not m:
            # Try v2 without CRC
            m = PKT_RE_V2_NO_CRC.match(line)
            has_crc = False
        
        if not m:
            # Try v1 (legacy format)
            m = PKT_RE_V1.match(line)
            if m:
                # V1 format doesn't have ID, use img_id as "legacy"
                if img_id != "legacy":
                    continue
                has_crc = False
            else:
                continue

        # Extract fields based on format
        if "id" in m.groupdict():
            pid = m.group("id")
            if pid != img_id:
                continue
        else:
            # V1 format, no ID
            pid = "legacy"

        idx = int(m.group("idx"))
        total = int(m.group("total"))
        payload = m.group("payload")

        # total consistency
        if total_expected is None:
            total_expected = total
        elif total_expected != total:
            # conflicting totals => ignore packet (or raise)
            continue

        # CRC validation (if present and validation enabled)
        if has_crc and validate_crc and "crc" in m.groupdict():
            crc = m.group("crc").lower()
            if _crc32_hex_ascii(payload) != crc:
                # corrupted payload; drop it
                print(f"Warning: Packet {idx} failed CRC validation, dropping")
                continue

        parts[idx] = payload

    if total_expected is None:
        return b"", []  # no packets found for this id

    missing = [i for i in range(1, total_expected + 1) if i not in parts]
    if missing:
        return b"", missing

    # Reassemble
    b64 = "".join(parts[i] for i in range(1, total_expected + 1))
    data = base64.b64decode(b64)
    return data, []

def write_image_bytes(data: bytes, out_path: str) -> str:
    """Writes bytes to disk and returns path."""
    with open(out_path, "wb") as f:
        f.write(data)
    return out_path

def build_nack(img_id: str, missing: List[int]) -> str:
    """
    Builds a NACK message to request retransmission of missing packet indices.
    Example: NACK|A1|3,7,9
    """
    missing_csv = ",".join(str(i) for i in missing)
    return f"NACK|{img_id}|{missing_csv}"


def main():
    """Example usage"""
    import sys
    
    if len(sys.argv) < 3:
        print("Usage: python decode_image_v2.py <packets_file> <image_id> [output_file] [--no-crc]")
        print("Example: python decode_image_v2.py packets_A1.txt A1 recovered.jpg")
        print("         python decode_image_v2.py packets_A1.txt A1 recovered.jpg --no-crc")
        sys.exit(1)
    
    packets_file = sys.argv[1]
    img_id = sys.argv[2]
    output_file = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else f"recovered_{img_id}.jpg"
    validate_crc = "--no-crc" not in sys.argv
    
    print(f"Reading packets from: {packets_file}")
    print(f"Image ID: {img_id}")
    print(f"CRC Validation: {'Enabled' if validate_crc else 'Disabled'}")
    print("-" * 60)
    
    try:
        # Read packets from file
        with open(packets_file, "r") as f:
            packets = f.readlines()
        
        print(f"Read {len(packets)} lines from file")
        
        # Decode packets
        data, missing = decode_packets_to_bytes_v2(packets, img_id=img_id, validate_crc=validate_crc)
        
        if missing:
            print(f"\n⚠️  Missing packets: {missing}")
            print(f"NACK message: {build_nack(img_id, missing)}")
            print("\nImage reconstruction incomplete!")
            sys.exit(1)
        
        if not data:
            print("\n❌ No valid packets found for this image ID")
            sys.exit(1)
        
        # Write image
        write_image_bytes(data, output_file)
        print(f"\n✅ Image successfully reconstructed!")
        print(f"Saved to: {output_file}")
        print(f"Size: {len(data)} bytes")
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

# Made with Bob
