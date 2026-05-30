"""
EchoCrypt steg layer — magic-byte framing with random padding.
Wraps encrypted payloads so receivers can validate frame integrity
and strip random trailing padding without needing out-of-band length info.
"""

import os
import random

MAGIC = b'\xAC\x00\x57\x1C'


def steg_wrap(payload: bytes) -> bytes:
    """
    Wrap payload in a steg frame:
      MAGIC(4) + length(4 big-endian) + payload + random_padding(4–16 bytes)
    """
    length = len(payload).to_bytes(4, 'big')
    padding = os.urandom(random.randint(4, 16))
    return MAGIC + length + payload + padding


def steg_unwrap(data: bytes) -> bytes:
    """
    Unwrap a steg frame and return the inner payload.
    Raises ValueError if magic bytes don't match.
    """
    if data[:4] != MAGIC:
        raise ValueError("Invalid magic bytes — not a valid EchoCrypt frame")
    length = int.from_bytes(data[4:8], 'big')
    return data[8:8 + length]
