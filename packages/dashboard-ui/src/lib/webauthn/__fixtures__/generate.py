#!/usr/bin/env python3
"""
Regenerate attestation-objects.json — the test vectors that cose.test.ts
imports.

Each fixture is a WebAuthn-shaped attestationObject built from a known
EC2 (P-256 / P-384 / P-521) or RSA-2048 keypair via a minimal CBOR
encoder. cose.test.ts decodes the fixture and asserts the recovered JWK
matches the public key the generator emitted.

Run:
  cd takosumi/packages/dashboard-ui/src/lib/webauthn/__fixtures__
  python3 generate.py > attestation-objects.json

When to re-run:
  - Adding a new attestation format / key type
  - Changing the RP ID (`accounts.takosumi.test` hard-coded below)
  - Test vector rotation

Output is deterministic-PER-RUN (cred_id is random), so commit the
generated JSON to avoid noisy diffs unless intentional.
"""
import base64
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.asymmetric import ec, rsa

RP_ID = "accounts.takosumi.test"


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


# ----- CBOR encoder (just the subset WebAuthn needs) ------------------------


def cbor_uint(n: int) -> bytes:
    if n < 24:
        return bytes([n])
    if n < 256:
        return bytes([0x18, n])
    if n < 65536:
        return bytes([0x19]) + n.to_bytes(2, "big")
    raise ValueError(n)


def cbor_neg(n: int) -> bytes:
    pos = -1 - n
    if pos < 24:
        return bytes([0x20 | pos])
    if pos < 256:
        return bytes([0x38, pos])
    if pos < 65536:
        return bytes([0x39]) + pos.to_bytes(2, "big")
    raise ValueError(n)


def cbor_bstr(b: bytes) -> bytes:
    if len(b) < 24:
        return bytes([0x40 | len(b)]) + b
    if len(b) < 256:
        return bytes([0x58, len(b)]) + b
    if len(b) < 65536:
        return bytes([0x59]) + len(b).to_bytes(2, "big") + b
    raise ValueError


def cbor_tstr(s: str) -> bytes:
    b = s.encode()
    if len(b) < 24:
        return bytes([0x60 | len(b)]) + b
    raise ValueError


def cbor_map(items: list[tuple[bytes, bytes]]) -> bytes:
    n = len(items)
    if n < 24:
        head = bytes([0xa0 | n])
    else:
        head = bytes([0xb8, n])
    return head + b"".join(k + v for k, v in items)


# ----- COSE key encoders ----------------------------------------------------


def cose_ec2(curve_id: int, x: bytes, y: bytes, alg: int = -7) -> bytes:
    """EC2 key: kty=2, alg, crv, x, y"""
    return cbor_map([
        (cbor_uint(1), cbor_uint(2)),
        (cbor_uint(3), cbor_neg(alg)),
        (cbor_neg(-1), cbor_uint(curve_id)),
        (cbor_neg(-2), cbor_bstr(x)),
        (cbor_neg(-3), cbor_bstr(y)),
    ])


def cose_rsa(n_bytes: bytes, e_bytes: bytes, alg: int = -257) -> bytes:
    """RSA key: kty=3, alg, n, e"""
    return cbor_map([
        (cbor_uint(1), cbor_uint(3)),
        (cbor_uint(3), cbor_neg(alg)),
        (cbor_neg(-1), cbor_bstr(n_bytes)),
        (cbor_neg(-2), cbor_bstr(e_bytes)),
    ])


# ----- WebAuthn attestation-object assembly --------------------------------


def make_auth_data(rp_hash: bytes, sign_count: int, aaguid: bytes,
                   cred_id: bytes, cose: bytes) -> bytes:
    flags = bytes([0x41])  # UP + AT
    return (rp_hash + flags + sign_count.to_bytes(4, "big") + aaguid +
            len(cred_id).to_bytes(2, "big") + cred_id + cose)


def make_attestation_obj(auth_data: bytes) -> bytes:
    return cbor_map([
        (cbor_tstr("fmt"), cbor_tstr("none")),
        (cbor_tstr("attStmt"), cbor_map([])),
        (cbor_tstr("authData"), cbor_bstr(auth_data)),
    ])


def make_packed_attestation_obj(auth_data: bytes, alg: int = -7,
                                sig: bytes | None = None) -> bytes:
    """Packed-format attestation: real Touch ID / Windows Hello emit this.
    attStmt = {alg: <int>, sig: <bstr>}. The SPA's CBOR decoder + COSE→JWK
    converter must navigate past the attStmt map and pull the public key
    out of authData — the same path as fmt=none, but with a non-trivial
    attStmt that exercises map nesting.
    """
    if sig is None:
        sig = bytes(64)  # placeholder; this test does NOT verify the sig
    att_stmt = cbor_map([
        (cbor_tstr("alg"), cbor_neg(alg)),
        (cbor_tstr("sig"), cbor_bstr(sig)),
    ])
    return cbor_map([
        (cbor_tstr("fmt"), cbor_tstr("packed")),
        (cbor_tstr("attStmt"), att_stmt),
        (cbor_tstr("authData"), cbor_bstr(auth_data)),
    ])


# ----- Generator ----------------------------------------------------------


def main() -> None:
    rp_hash = hashlib.sha256(RP_ID.encode()).digest()
    aaguid = b"\x00" * 16
    cred_id = os.urandom(32)
    fixtures: dict[str, object] = {}

    for cid, cobj, crv, lbl in [
        (1, ec.SECP256R1(), "P-256", "p256"),
        (2, ec.SECP384R1(), "P-384", "p384"),
        (3, ec.SECP521R1(), "P-521", "p521"),
    ]:
        priv = ec.generate_private_key(cobj)
        pub = priv.public_key().public_numbers()
        size = (cobj.key_size + 7) // 8
        x = pub.x.to_bytes(size, "big")
        y = pub.y.to_bytes(size, "big")
        cose = cose_ec2(cid, x, y)
        att_obj = make_attestation_obj(
            make_auth_data(rp_hash, 0, aaguid, cred_id, cose),
        )
        fixtures[lbl] = {
            "attestationObjectB64url": b64url(att_obj),
            "expectedCredentialIdB64url": b64url(cred_id),
            "expectedJwk": {
                "kty": "EC",
                "crv": crv,
                "x": b64url(x),
                "y": b64url(y),
            },
        }

    priv_rsa = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub_rsa = priv_rsa.public_key().public_numbers()
    n_bytes = pub_rsa.n.to_bytes((pub_rsa.n.bit_length() + 7) // 8, "big")
    e_bytes = pub_rsa.e.to_bytes((pub_rsa.e.bit_length() + 7) // 8, "big")
    cose = cose_rsa(n_bytes, e_bytes)
    att_obj = make_attestation_obj(
        make_auth_data(rp_hash, 0, aaguid, cred_id, cose),
    )
    fixtures["rsa2048"] = {
        "attestationObjectB64url": b64url(att_obj),
        "expectedCredentialIdB64url": b64url(cred_id),
        "expectedJwk": {
            "kty": "RSA",
            "n": b64url(n_bytes),
            "e": b64url(e_bytes),
        },
    }

    # ---- Packed-format fixtures (real authenticators emit this) ----
    # Same keys, same expectedJwk — only fmt + attStmt differ. The SPA
    # must still extract the public key correctly when attStmt contains
    # the alg + sig pair from a real attestation.
    p256_priv = ec.generate_private_key(ec.SECP256R1())
    p256_pub = p256_priv.public_key().public_numbers()
    px = p256_pub.x.to_bytes(32, "big")
    py = p256_pub.y.to_bytes(32, "big")
    p256_cose = cose_ec2(1, px, py)
    p256_packed = make_packed_attestation_obj(
        make_auth_data(rp_hash, 0, aaguid, cred_id, p256_cose),
        alg=-7,
    )
    fixtures["p256-packed"] = {
        "attestationObjectB64url": b64url(p256_packed),
        "expectedCredentialIdB64url": b64url(cred_id),
        "expectedJwk": {
            "kty": "EC",
            "crv": "P-256",
            "x": b64url(px),
            "y": b64url(py),
        },
    }

    priv_rsa2 = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub_rsa2 = priv_rsa2.public_key().public_numbers()
    n2 = pub_rsa2.n.to_bytes((pub_rsa2.n.bit_length() + 7) // 8, "big")
    e2 = pub_rsa2.e.to_bytes((pub_rsa2.e.bit_length() + 7) // 8, "big")
    rsa_cose = cose_rsa(n2, e2)
    rsa_packed = make_packed_attestation_obj(
        make_auth_data(rp_hash, 0, aaguid, cred_id, rsa_cose),
        alg=-257,
        sig=bytes(256),
    )
    fixtures["rsa2048-packed"] = {
        "attestationObjectB64url": b64url(rsa_packed),
        "expectedCredentialIdB64url": b64url(cred_id),
        "expectedJwk": {
            "kty": "RSA",
            "n": b64url(n2),
            "e": b64url(e2),
        },
    }

    json.dump(fixtures, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
