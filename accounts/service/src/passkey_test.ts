import { expect, test } from "bun:test";
import { assertEquals, assertRejects } from "../../../test/assert.ts";
import {
  createPasskeyAuthenticationOptions,
  createPasskeyRegistrationOptions,
  verifyPasskeyAssertion,
  verifyPasskeyAttestationFormat,
} from "./passkey.ts";

const textEncoder = new TextEncoder();

test("createPasskeyRegistrationOptions builds WebAuthn JSON options", () => {
  const options = createPasskeyRegistrationOptions({
    rp: {
      id: "accounts.example.test",
      name: "Takosumi Accounts",
    },
    user: {
      id: new Uint8Array([1, 2, 3, 4]),
      name: "user@example.test",
      displayName: "Example User",
    },
    challenge: new Uint8Array([5, 6, 7, 8]),
  });

  expect(options.challenge).toEqual("BQYHCA");
  expect(options.user.id).toEqual("AQIDBA");
  expect(options.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
  expect(options.timeout).toEqual(60_000);
  expect(options.attestation).toEqual("none");
  expect(options.authenticatorSelection.userVerification).toEqual("preferred");
});

test("createPasskeyAuthenticationOptions builds WebAuthn request options", () => {
  const options = createPasskeyAuthenticationOptions({
    rpId: "accounts.example.test",
    challenge: "challenge-1",
    allowCredentials: [{
      type: "public-key",
      id: "credential-1",
    }],
    timeout: 30_000,
  });

  expect(options.challenge).toEqual("challenge-1");
  expect(options.rpId).toEqual("accounts.example.test");
  expect(options.allowCredentials).toEqual([{
    type: "public-key",
    id: "credential-1",
  }]);
  expect(options.timeout).toEqual(30_000);
  expect(options.userVerification).toEqual("preferred");
});

test("verifyPasskeyAssertion verifies an ES256 WebAuthn assertion", async () => {
  const assertion = await createSignedAssertion({
    challenge: "challenge-1",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 7,
  });

  const result = await verifyPasskeyAssertion({
    expectedChallenge: "challenge-1",
    expectedOrigin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    publicKeyJwk: assertion.publicKeyJwk,
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
    signature: assertion.signature,
  });

  expect(result).toEqual({ verified: true, signCount: 7 });
});

test("verifyPasskeyAssertion accepts DER-encoded ES256 signatures", async () => {
  const assertion = await createSignedAssertion({
    challenge: "challenge-1",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 8,
    signatureFormat: "der",
  });

  const result = await verifyPasskeyAssertion({
    expectedChallenge: "challenge-1",
    expectedOrigin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    publicKeyJwk: assertion.publicKeyJwk,
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
    signature: assertion.signature,
  });

  expect(result).toEqual({ verified: true, signCount: 8 });
});

test("verifyPasskeyAssertion rejects challenge mismatches", async () => {
  const assertion = await createSignedAssertion({
    challenge: "challenge-1",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 1,
  });

  await assertRejects(
    () =>
      verifyPasskeyAssertion({
        expectedChallenge: "different-challenge",
        expectedOrigin: "https://accounts.example.test",
        rpId: "accounts.example.test",
        publicKeyJwk: assertion.publicKeyJwk,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
        signature: assertion.signature,
      }),
    TypeError,
    "challenge mismatch",
  );
});

test("verifyPasskeyAssertion rejects rpId hash mismatches", async () => {
  const assertion = await createSignedAssertion({
    challenge: "challenge-1",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 1,
  });

  await assertRejects(
    () =>
      verifyPasskeyAssertion({
        expectedChallenge: "challenge-1",
        expectedOrigin: "https://accounts.example.test",
        rpId: "other.example.test",
        publicKeyJwk: assertion.publicKeyJwk,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
        signature: assertion.signature,
      }),
    TypeError,
    "rpId hash mismatch",
  );
});

test("verifyPasskeyAssertion rejects assertions without user presence", async () => {
  const assertion = await createSignedAssertion({
    challenge: "challenge-1",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 1,
    flags: 0x00,
  });

  await assertRejects(
    () =>
      verifyPasskeyAssertion({
        expectedChallenge: "challenge-1",
        expectedOrigin: "https://accounts.example.test",
        rpId: "accounts.example.test",
        publicKeyJwk: assertion.publicKeyJwk,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
        signature: assertion.signature,
      }),
    TypeError,
    "user-present flag",
  );
});

interface SignedAssertionInput {
  challenge: string;
  origin: string;
  rpId: string;
  signCount: number;
  flags?: number;
  signatureFormat?: "raw" | "der";
}

interface SignedAssertion {
  publicKeyJwk: JsonWebKey;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

async function createSignedAssertion(
  input: SignedAssertionInput,
): Promise<SignedAssertion> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  );
  const clientDataJSON = textEncoder.encode(JSON.stringify({
    type: "webauthn.get",
    challenge: input.challenge,
    origin: input.origin,
  }));
  const authenticatorData = await createAuthenticatorData({
    rpId: input.rpId,
    flags: input.flags ?? 0x01,
    signCount: input.signCount,
  });
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientDataJSON),
  );
  const signedData = concatBytes(authenticatorData, clientDataHash);
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      signedData,
    ),
  );
  const signature = input.signatureFormat === "der"
    ? derEncodeEs256Signature(rawSignature)
    : rawSignature;

  return {
    publicKeyJwk,
    authenticatorData,
    clientDataJSON,
    signature,
  };
}

async function createAuthenticatorData(input: {
  rpId: string;
  flags: number;
  signCount: number;
}): Promise<Uint8Array> {
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", textEncoder.encode(input.rpId)),
    ),
    0,
  );
  authenticatorData[32] = input.flags;
  authenticatorData[33] = (input.signCount >>> 24) & 0xff;
  authenticatorData[34] = (input.signCount >>> 16) & 0xff;
  authenticatorData[35] = (input.signCount >>> 8) & 0xff;
  authenticatorData[36] = input.signCount & 0xff;
  return authenticatorData;
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

function cborTstr(value: string): Uint8Array {
  const bytes = textEncoder.encode(value);
  return concatBytes(new Uint8Array([0x60 | bytes.byteLength]), bytes);
}

// Build `{ "fmt": fmt, "authData": authData, "attStmt": {} }` as CBOR.
function buildAttestationObject(fmt: string, authData: Uint8Array): Uint8Array {
  const header = new Uint8Array([0xa3]); // map(3)
  const fmtEntry = concatBytes(cborTstr("fmt"), cborTstr(fmt));
  const authDataEntry = concatBytes(
    cborTstr("authData"),
    concatBytes(new Uint8Array([0x58, authData.byteLength]), authData),
  );
  const attStmtEntry = concatBytes(cborTstr("attStmt"), new Uint8Array([0xa0]));
  return concatBytes(
    concatBytes(concatBytes(header, fmtEntry), authDataEntry),
    attStmtEntry,
  );
}

test("verifyPasskeyAttestationFormat accepts a none attestation bound to the rpId", async () => {
  const authData = await createAuthenticatorData({
    rpId: "accounts.example.test",
    flags: 0x01,
    signCount: 0,
  });
  await verifyPasskeyAttestationFormat({
    attestationObject: buildAttestationObject("none", authData),
    expectedFormat: "none",
    rpId: "accounts.example.test",
  });
});

test("verifyPasskeyAttestationFormat rejects a mismatched rpId hash", async () => {
  const authData = await createAuthenticatorData({
    rpId: "evil.example.test",
    flags: 0x01,
    signCount: 0,
  });
  await assertRejects(
    () =>
      verifyPasskeyAttestationFormat({
        attestationObject: buildAttestationObject("none", authData),
        expectedFormat: "none",
        rpId: "accounts.example.test",
      }),
    TypeError,
    "rpId hash mismatch",
  );
});

test("verifyPasskeyAttestationFormat rejects a missing user-present flag", async () => {
  const authData = await createAuthenticatorData({
    rpId: "accounts.example.test",
    flags: 0x00,
    signCount: 0,
  });
  await assertRejects(
    () =>
      verifyPasskeyAttestationFormat({
        attestationObject: buildAttestationObject("none", authData),
        expectedFormat: "none",
        rpId: "accounts.example.test",
      }),
    TypeError,
    "user-present",
  );
});

test("verifyPasskeyAttestationFormat rejects a non-none fmt", async () => {
  const authData = await createAuthenticatorData({
    rpId: "accounts.example.test",
    flags: 0x01,
    signCount: 0,
  });
  await assertRejects(
    () =>
      verifyPasskeyAttestationFormat({
        attestationObject: buildAttestationObject("packed", authData),
        expectedFormat: "none",
        rpId: "accounts.example.test",
      }),
    TypeError,
    "attestation format mismatch",
  );
});

test("verifyPasskeyAttestationFormat accepts an absent attestationObject", async () => {
  await verifyPasskeyAttestationFormat({ expectedFormat: "none" });
});

function derEncodeEs256Signature(rawSignature: Uint8Array): Uint8Array {
  if (rawSignature.byteLength !== 64) {
    throw new TypeError("test ES256 signature must be 64 bytes");
  }
  const r = derEncodeInteger(rawSignature.slice(0, 32));
  const s = derEncodeInteger(rawSignature.slice(32, 64));
  const sequenceLength = r.byteLength + s.byteLength;
  return new Uint8Array([0x30, sequenceLength, ...r, ...s]);
}

function derEncodeInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.byteLength - 1 && value[start] === 0) {
    start += 1;
  }
  const trimmed = value.slice(start);
  const needsPadding = (trimmed[0] & 0x80) === 0x80;
  const output = new Uint8Array(
    2 + trimmed.byteLength + (needsPadding ? 1 : 0),
  );
  output[0] = 0x02;
  output[1] = output.byteLength - 2;
  output.set(trimmed, needsPadding ? 3 : 2);
  return output;
}
