"""
EchoCrypt crypto layer — AES-256-GCM + PBKDF2-SHA256
Cross-compatible with browser WebCrypto (see byte layout note below).

Byte layout: nonce(12) + ciphertext + tag(16)
  - WebCrypto AES-GCM expects: nonce separate, then ciphertext||tag as one blob
  - pycryptodome separates tag — we reassemble in the correct order here
"""

from Crypto.Protocol.KDF import PBKDF2
from Crypto.Hash import SHA256
from Crypto.Cipher import AES
import os


SALT = b'acoustinet_v1'
ITERATIONS = 100_000


def derive_key(password: str) -> bytes:
    """Derive a 256-bit key from a passphrase using PBKDF2-SHA256."""
    return PBKDF2(
        password.encode(),
        SALT,
        dkLen=32,
        count=ITERATIONS,
        hmac_hash_module=SHA256
    )


def encrypt(plaintext: bytes, key: bytes) -> bytes:
    """
    Encrypt plaintext with AES-256-GCM.
    Returns: nonce(12) + ciphertext + tag(16)
    This layout is compatible with WebCrypto's AES-GCM decrypt.
    """
    nonce = os.urandom(12)          # ← force 12 bytes
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext)
    return nonce + ciphertext + tag

def decrypt(data: bytes, key: bytes) -> bytes:
    """
    Decrypt AES-256-GCM data.
    Expects: nonce(12) + ciphertext + tag(16)
    Raises ValueError if authentication fails.
    """
    
    nonce = data[:12]
    ciphertext = data[12:-16]
    tag = data[-16:]
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    return cipher.decrypt_and_verify(ciphertext, tag)
