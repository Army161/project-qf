#!/usr/bin/env python3
"""Independent, offline derivation for this review. No wallet, RPC or signing.
This small fixed-input diagnostic is not a general cryptography library.
"""
from __future__ import annotations
import hashlib
import json

ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
P = 2**255 - 19
D = (-121665 * pow(121666, P-2, P)) % P

def b58decode(value: str) -> bytes:
    n = 0
    for char in value:
        n = n * 58 + ALPHABET.index(char)
    zeros = len(value) - len(value.lstrip('1'))
    return b'\0' * zeros + (n.to_bytes((n.bit_length()+7)//8, 'big') if n else b'')

def b58encode(value: bytes) -> str:
    n = int.from_bytes(value, 'big')
    out = ''
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return '1' * (len(value)-len(value.lstrip(b'\0'))) + out

def is_ed25519_compressed_point(value: bytes) -> bool:
    packed = int.from_bytes(value, 'little')
    sign, y = packed >> 255, packed & ((1 << 255)-1)
    if y >= P:
        return False
    y2 = y*y % P
    denominator = (D*y2 + 1) % P
    if not denominator:
        return False
    x2 = ((y2-1)*pow(denominator, P-2, P)) % P
    x = pow(x2, (P+3)//8, P)
    if x*x % P != x2:
        x = x * pow(2, (P-1)//4, P) % P
    return x*x % P == x2 and not (x == 0 and sign == 1)

program = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
expected = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'
program_bytes = b58decode(program)
assert len(program_bytes) == 32
for bump in range(255, -1, -1):
    digest = hashlib.sha256(b'pool_authority' + bytes([bump]) + program_bytes + b'ProgramDerivedAddress').digest()
    if not is_ed25519_compressed_point(digest):
        derived = b58encode(digest)
        result = {'scope':'Independent offline fixed-input SHA256/Ed25519 derivation, not a live check',
                  'program':program,'seed':'pool_authority','bump':bump,
                  'derived':derived,'expected':expected,'matches':derived == expected}
        print(json.dumps(result, indent=2))
        if derived != expected:
            raise SystemExit(1)
        break
else:
    raise SystemExit('No valid bump found')
