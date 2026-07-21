import { constantTimeEqualsBytes } from "takosumi-contract/internal/crypto";

export interface PasskeyRelyingParty {
  id: string;
  name: string;
}

export interface PasskeyUser {
  id: string | Uint8Array;
  name: string;
  displayName: string;
}

export interface PasskeyCredentialDescriptor {
  id: string;
  type: "public-key";
}

export interface PasskeyRegistrationOptionsInput {
  rp: PasskeyRelyingParty;
  user: PasskeyUser;
  challenge?: string | Uint8Array;
  timeout?: number;
}

export interface PasskeyAuthenticationOptionsInput {
  rpId: string;
  allowCredentials?: readonly PasskeyCredentialDescriptor[];
  challenge?: string | Uint8Array;
  timeout?: number;
}

export interface PasskeyAssertionVerificationInput {
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
  publicKeyJwk: JsonWebKey;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

export interface PasskeyAssertionVerificationResult {
  verified: true;
  signCount: number;
}

export interface PasskeyRegistrationClientDataInput {
  expectedChallenge: string;
  expectedOrigin: string;
  clientDataJSON: Uint8Array;
}

export interface PasskeyAttestationStatementInput {
  /**
   * Optional CBOR-encoded `attestationObject` from the client. When the
   * server policy is `attestation: "none"`, the client may omit this and
   * we trust the public key JWK passed alongside. When present we
   * minimally verify that the embedded `fmt` is `"none"` so a non-`none`
   * statement (`packed`/`tpm`/etc.) cannot be silently accepted without a
   * real chain verifier.
   *
   * SUPPORTED POLICY: `attestation: "none"`. Direct/enterprise attestation
   * (verifying the attStmt chain against the AAGUID-keyed FIDO metadata
   * service) is intentionally NOT implemented; it is out of scope until an
   * authenticator allow/deny-list requirement is prioritized. Until then any
   * non-`none` statement is rejected as a defensive default rather than
   * trusted, so this is not a "coming soon" gap — it is the current policy.
   */
  attestationObject?: Uint8Array;
  /**
   * Server's currently-configured attestation policy. Defaults to
   * `"none"` because `createPasskeyRegistrationOptions` only requests
   * `attestation: "none"` today.
   */
  expectedFormat?: "none";
  /**
   * When provided, the embedded registration `authData` is parsed and we
   * assert SHA-256(rpId) === rpIdHash and that the user-present (UP) flag is
   * set. Without this the registration path never confirmed the credential
   * was created for this relying party (the assertion path checks it later,
   * so a mismatched rpId would simply be dead, but verifying at registration
   * time is the WebAuthn-correct behavior). Required when the policy ships a
   * concrete `attestationObject`.
   */
  rpId?: string;
}

const textEncoder = new TextEncoder();

export function createPasskeyRegistrationOptions(
  input: PasskeyRegistrationOptionsInput,
): PublicKeyCredentialCreationOptionsJSON {
  return {
    challenge: passkeyChallenge(input.challenge),
    rp: input.rp,
    user: {
      id:
        typeof input.user.id === "string"
          ? input.user.id
          : base64UrlEncodeBytes(input.user.id),
      name: input.user.name,
      displayName: input.user.displayName,
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: input.timeout ?? 60_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  };
}

export function createPasskeyAuthenticationOptions(
  input: PasskeyAuthenticationOptionsInput,
): PublicKeyCredentialRequestOptionsJSON {
  return {
    challenge: passkeyChallenge(input.challenge),
    rpId: input.rpId,
    allowCredentials: input.allowCredentials ?? [],
    timeout: input.timeout ?? 60_000,
    userVerification: "preferred",
  };
}

/**
 * Verify the `clientDataJSON` returned by the authenticator during
 * registration (`navigator.credentials.create`). Mirrors the registration
 * side of `verifyPasskeyAssertion`: confirms `type === "webauthn.create"`,
 * the challenge matches the server-issued challenge, and the origin
 * matches the server-configured origin.
 *
 * Agent 6 item 4: the registration path previously accepted whatever the
 * client posted without parsing clientDataJSON, leaving the door open for
 * a malicious client to swap challenges across users. This helper closes
 * that gap.
 */
export function verifyPasskeyRegistrationClientData(
  input: PasskeyRegistrationClientDataInput,
): void {
  const clientData = parseClientData(input.clientDataJSON);
  if (clientData.type !== "webauthn.create") {
    throw new TypeError(
      "passkey registration clientDataJSON type must be webauthn.create",
    );
  }
  if (clientData.challenge !== input.expectedChallenge) {
    throw new TypeError("passkey registration challenge mismatch");
  }
  if (clientData.origin !== input.expectedOrigin) {
    throw new TypeError("passkey registration origin mismatch");
  }
}

/**
 * Verify the attestation statement's format matches the server-requested
 * attestation policy. With `attestation: "none"` (current policy), the
 * only acceptable `fmt` is `"none"`. Anything else (`packed`, `tpm`,
 * `android-key`, `apple`, ...) implies the client returned a real
 * attestation chain we do not verify, so we reject loudly.
 *
 * SUPPORTED POLICY: `attestation: "none"` only. Direct attestation (parse +
 * verify the attStmt chain against FIDO MDS metadata keyed by the AAGUID in
 * attestedCredentialData) is deliberately not implemented; it would be added
 * only if an authenticator allow/deny-list requirement is prioritized. Any
 * non-`none` statement is rejected as a defensive default, so this is the
 * current policy rather than an unfinished feature.
 *
 * When `rpId` is supplied, the embedded registration `authData` is also
 * checked: SHA-256(rpId) === rpIdHash and the user-present (UP) flag set.
 */
export async function verifyPasskeyAttestationFormat(
  input: PasskeyAttestationStatementInput,
): Promise<void> {
  const expectedFormat = input.expectedFormat ?? "none";
  if (!input.attestationObject) {
    // No statement provided. With expected "none" this is the common
    // path (the registration options request "none" and the browser
    // ships an empty attStmt); accept it.
    return;
  }
  const decoded = decodeAttestationObject(input.attestationObject);
  if (decoded.fmt !== expectedFormat) {
    throw new TypeError(
      `passkey attestation format mismatch: expected ${expectedFormat}, got ${decoded.fmt}`,
    );
  }
  // Verify the registration authData binds to this relying party and that
  // the user was present, mirroring the assertion-time checks. Only done
  // when the caller supplies the rpId (the route always does today).
  if (input.rpId !== undefined) {
    if (!decoded.authData) {
      throw new TypeError(
        "passkey attestationObject is missing authData for rpId verification",
      );
    }
    assertAuthenticatorData(decoded.authData);
    await assertRpIdHash(decoded.authData, input.rpId);
    assertUserPresent(decoded.authData);
  }
}

/**
 * Read the entry count of a CBOR map at `offset`, honoring the additional-info
 * length encoding (0..23 inline, 24 = uint8 follows, 25 = uint16 follows). The
 * attestationObject top-level map is `{ fmt, authData, attStmt }` (3 keys, so
 * 0xA3 canonically), but be permissive about the count so we don't desync on a
 * conformant authenticator. Larger length encodings (>= 26) are rejected as
 * implausible for this structure.
 */
function readCborMapHeader(
  input: Uint8Array,
  offset: number,
): { length: number; offset: number } {
  const first = input[offset];
  // Major type 5 (map) is 0xA0..0xBF.
  if (first === undefined || (first & 0xe0) !== 0xa0) {
    throw new TypeError("passkey attestationObject is not a CBOR map");
  }
  const additionalInfo = first & 0x1f;
  offset += 1;
  if (additionalInfo <= 23) return { length: additionalInfo, offset };
  if (additionalInfo === 24) {
    const length = input[offset];
    if (length === undefined) {
      throw new TypeError("passkey attestationObject CBOR map is truncated");
    }
    return { length, offset: offset + 1 };
  }
  if (additionalInfo === 25) {
    const hi = input[offset];
    const lo = input[offset + 1];
    if (hi === undefined || lo === undefined) {
      throw new TypeError("passkey attestationObject CBOR map is truncated");
    }
    return { length: (hi << 8) | lo, offset: offset + 2 };
  }
  throw new TypeError("passkey attestationObject CBOR map is too large");
}

/**
 * Minimal CBOR decoder that extracts named fields from an `attestationObject`
 * byte string. The full attestationObject schema is
 * `{ fmt: tstr, authData: bstr, attStmt: map }`; we extract `fmt` for the
 * format gate and `authData` for the rpIdHash / user-present checks. Throws if
 * the input is not a CBOR map containing the requested fields.
 */
function decodeAttestationObject(attestationObject: Uint8Array): {
  fmt: string;
  authData?: Uint8Array;
} {
  const header = readCborMapHeader(attestationObject, 0);
  let offset = header.offset;
  let fmt: string | undefined;
  let authData: Uint8Array | undefined;
  for (
    let entry = 0;
    entry < header.length && offset < attestationObject.byteLength;
    entry += 1
  ) {
    const keyResult = readCborTstr(attestationObject, offset);
    offset = keyResult.offset;
    if (keyResult.value === "fmt") {
      const valueResult = readCborTstr(attestationObject, offset);
      fmt = valueResult.value;
      offset = valueResult.offset;
    } else if (keyResult.value === "authData") {
      const valueResult = readCborBstr(attestationObject, offset);
      authData = valueResult.value;
      offset = valueResult.offset;
    } else {
      offset = skipCborItem(attestationObject, offset);
    }
  }
  if (fmt === undefined) {
    throw new TypeError("passkey attestationObject is missing fmt field");
  }
  return { fmt, authData };
}

function readCborTstr(
  input: Uint8Array,
  offset: number,
): { value: string; offset: number } {
  const initial = input[offset];
  if (initial === undefined) {
    throw new TypeError("passkey attestationObject CBOR string is truncated");
  }
  const majorType = initial >> 5;
  if (majorType !== 3) {
    throw new TypeError(
      "passkey attestationObject CBOR key is not a text string",
    );
  }
  const additionalInfo = initial & 0x1f;
  offset += 1;
  let length = additionalInfo;
  if (additionalInfo === 24) {
    length = input[offset]!;
    offset += 1;
  } else if (additionalInfo === 25) {
    length = (input[offset]! << 8) | input[offset + 1]!;
    offset += 2;
  } else if (additionalInfo >= 26) {
    throw new TypeError("passkey attestationObject CBOR string is too large");
  }
  if (offset + length > input.byteLength) {
    throw new TypeError("passkey attestationObject CBOR string is truncated");
  }
  const slice = input.slice(offset, offset + length);
  return {
    value: new TextDecoder().decode(slice),
    offset: offset + length,
  };
}

function readCborBstr(
  input: Uint8Array,
  offset: number,
): { value: Uint8Array; offset: number } {
  const initial = input[offset];
  if (initial === undefined) {
    throw new TypeError("passkey attestationObject CBOR bytes are truncated");
  }
  const majorType = initial >> 5;
  if (majorType !== 2) {
    throw new TypeError(
      "passkey attestationObject CBOR value is not a byte string",
    );
  }
  const additionalInfo = initial & 0x1f;
  offset += 1;
  let length = additionalInfo;
  if (additionalInfo === 24) {
    length = input[offset]!;
    offset += 1;
  } else if (additionalInfo === 25) {
    length = (input[offset]! << 8) | input[offset + 1]!;
    offset += 2;
  } else if (additionalInfo === 26) {
    length =
      input[offset]! * 2 ** 24 +
      input[offset + 1]! * 2 ** 16 +
      input[offset + 2]! * 2 ** 8 +
      input[offset + 3]!;
    offset += 4;
  } else if (additionalInfo >= 27) {
    throw new TypeError("passkey attestationObject CBOR bytes are too large");
  }
  if (offset + length > input.byteLength) {
    throw new TypeError("passkey attestationObject CBOR bytes are truncated");
  }
  return {
    value: input.slice(offset, offset + length),
    offset: offset + length,
  };
}

function skipCborItem(input: Uint8Array, offset: number): number {
  const initial = input[offset];
  if (initial === undefined) {
    throw new TypeError("passkey attestationObject CBOR item is truncated");
  }
  const majorType = initial >> 5;
  const additionalInfo = initial & 0x1f;
  offset += 1;
  let length = additionalInfo;
  if (additionalInfo === 24) {
    length = input[offset]!;
    offset += 1;
  } else if (additionalInfo === 25) {
    length = (input[offset]! << 8) | input[offset + 1]!;
    offset += 2;
  } else if (additionalInfo === 26) {
    length =
      (input[offset]! << 24) |
      (input[offset + 1]! << 16) |
      (input[offset + 2]! << 8) |
      input[offset + 3]!;
    offset += 4;
  } else if (additionalInfo >= 27) {
    throw new TypeError("passkey attestationObject CBOR length is too large");
  }
  if (majorType === 2 || majorType === 3) {
    return offset + length;
  }
  if (majorType === 0 || majorType === 1 || majorType === 7) {
    return offset;
  }
  if (majorType === 4) {
    let next = offset;
    for (let i = 0; i < length; i += 1) next = skipCborItem(input, next);
    return next;
  }
  if (majorType === 5) {
    let next = offset;
    for (let i = 0; i < length; i += 1) {
      next = skipCborItem(input, next);
      next = skipCborItem(input, next);
    }
    return next;
  }
  // Major type 6 (tagged) — skip tag, then inner item.
  return skipCborItem(input, offset);
}

export async function verifyPasskeyAssertion(
  input: PasskeyAssertionVerificationInput,
): Promise<PasskeyAssertionVerificationResult> {
  const clientData = parseClientData(input.clientDataJSON);
  if (clientData.type !== "webauthn.get") {
    throw new TypeError(
      "passkey assertion clientDataJSON type must be webauthn.get",
    );
  }
  if (clientData.challenge !== input.expectedChallenge) {
    throw new TypeError("passkey assertion challenge mismatch");
  }
  if (clientData.origin !== input.expectedOrigin) {
    throw new TypeError("passkey assertion origin mismatch");
  }
  assertAuthenticatorData(input.authenticatorData);
  await assertRpIdHash(input.authenticatorData, input.rpId);
  assertUserPresent(input.authenticatorData);

  const signedData = concatBytes(
    input.authenticatorData,
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        webCryptoBytes(input.clientDataJSON),
      ),
    ),
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    input.publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    es256SignatureForWebCrypto(input.signature),
    signedData,
  );
  if (!verified) {
    throw new TypeError("passkey assertion signature verification failed");
  }

  return {
    verified: true,
    signCount: authenticatorSignCount(input.authenticatorData),
  };
}

function passkeyChallenge(value?: string | Uint8Array): string {
  if (typeof value === "string") return value;
  if (value) return base64UrlEncodeBytes(value);
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  return base64UrlEncodeBytes(challenge);
}

function parseClientData(clientDataJSON: Uint8Array): Record<string, unknown> {
  const decoded = new TextDecoder().decode(clientDataJSON);
  const parsed: unknown = JSON.parse(decoded);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("passkey clientDataJSON is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.challenge !== "string" ||
    typeof record.origin !== "string"
  ) {
    throw new TypeError("passkey clientDataJSON is missing required fields");
  }
  return record;
}

function assertAuthenticatorData(authenticatorData: Uint8Array): void {
  if (authenticatorData.byteLength < 37) {
    throw new TypeError("passkey authenticatorData must be at least 37 bytes");
  }
}

async function assertRpIdHash(
  authenticatorData: Uint8Array,
  rpId: string,
): Promise<void> {
  const expected = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(rpId)),
  );
  const actual = authenticatorData.slice(0, 32);
  if (!constantTimeEqualsBytes(actual, expected)) {
    throw new TypeError("passkey assertion rpId hash mismatch");
  }
}

function assertUserPresent(authenticatorData: Uint8Array): void {
  const flags = authenticatorData[32];
  if ((flags & 0x01) !== 0x01) {
    throw new TypeError("passkey assertion user-present flag is missing");
  }
}

function authenticatorSignCount(authenticatorData: Uint8Array): number {
  return (
    authenticatorData[33] * 2 ** 24 +
    authenticatorData[34] * 2 ** 16 +
    authenticatorData[35] * 2 ** 8 +
    authenticatorData[36]
  );
}

function concatBytes(
  first: Uint8Array,
  second: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(first.byteLength + second.byteLength);
  output.set(first, 0);
  output.set(second, first.byteLength);
  return output;
}

function webCryptoBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function es256SignatureForWebCrypto(
  signature: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (signature.byteLength === 64) return webCryptoBytes(signature);
  return derToP1363Es256Signature(signature);
}

function derToP1363Es256Signature(
  signature: Uint8Array,
): Uint8Array<ArrayBuffer> {
  let offset = 0;
  if (signature[offset] !== 0x30) {
    throw new TypeError("passkey assertion signature format is unsupported");
  }
  offset += 1;
  const sequenceLength = readDerLength(signature, offset);
  offset = sequenceLength.offset;
  if (offset + sequenceLength.length !== signature.byteLength) {
    throw new TypeError("passkey assertion signature DER sequence is invalid");
  }

  const r = readDerInteger(signature, offset);
  const s = readDerInteger(signature, r.offset);
  if (s.offset !== signature.byteLength) {
    throw new TypeError("passkey assertion signature DER sequence is invalid");
  }

  const output = new Uint8Array(64);
  output.set(padEs256Integer(r.value), 0);
  output.set(padEs256Integer(s.value), 32);
  return output;
}

function readDerLength(
  input: Uint8Array,
  offset: number,
): { length: number; offset: number } {
  const first = input[offset];
  if (first === undefined) {
    throw new TypeError("passkey assertion signature DER length is invalid");
  }
  offset += 1;
  if ((first & 0x80) === 0) return { length: first, offset };

  const lengthBytes = first & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 2) {
    throw new TypeError(
      "passkey assertion signature DER length is unsupported",
    );
  }
  if (offset + lengthBytes > input.byteLength) {
    throw new TypeError("passkey assertion signature DER length is invalid");
  }

  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    length = length * 256 + input[offset + index];
  }
  return { length, offset: offset + lengthBytes };
}

function readDerInteger(
  input: Uint8Array,
  offset: number,
): { value: Uint8Array; offset: number } {
  if (input[offset] !== 0x02) {
    throw new TypeError("passkey assertion signature DER integer is invalid");
  }
  offset += 1;
  const length = readDerLength(input, offset);
  offset = length.offset;
  if (length.length === 0 || offset + length.length > input.byteLength) {
    throw new TypeError("passkey assertion signature DER integer is invalid");
  }
  return {
    value: input.slice(offset, offset + length.length),
    offset: offset + length.length,
  };
}

function padEs256Integer(value: Uint8Array): Uint8Array<ArrayBuffer> {
  let start = 0;
  while (start < value.byteLength - 1 && value[start] === 0) {
    start += 1;
  }
  const trimmed = value.slice(start);
  if (trimmed.byteLength > 32) {
    throw new TypeError("passkey assertion signature DER integer is too large");
  }

  const output = new Uint8Array(32);
  output.set(trimmed, 32 - trimmed.byteLength);
  return output;
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: PasskeyRelyingParty;
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  pubKeyCredParams: readonly [{ type: "public-key"; alg: -7 }];
  timeout: number;
  attestation: "none";
  authenticatorSelection: {
    residentKey: "preferred";
    userVerification: "preferred";
  };
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  rpId: string;
  allowCredentials: readonly PasskeyCredentialDescriptor[];
  timeout: number;
  userVerification: "preferred";
}
