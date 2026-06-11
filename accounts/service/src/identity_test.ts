import { expect, test } from "bun:test";
import { assertEquals, assertRejects } from "../../../test/assert.ts";
import {
  authenticatePasskey,
  registerPasskeyCredential,
  resolveUpstreamAccount,
} from "./identity.ts";
import { InMemoryAccountsStore } from "./store.ts";

const textEncoder = new TextEncoder();

test("resolveUpstreamAccount creates and reuses a stable Takosumi account", async () => {
  const store = new InMemoryAccountsStore();
  const first = await resolveUpstreamAccount({
    store,
    subjectSecret: "subject-secret",
    providerId: "github",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
    profile: {
      email: "octo@example.test",
      displayName: "Octo",
    },
    now: 1000,
  });
  const second = await resolveUpstreamAccount({
    store,
    subjectSecret: "subject-secret",
    providerId: "github",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
    profile: {
      displayName: "Octo Cat",
    },
    now: 2000,
  });

  expect(first.subject).toEqual(second.subject);
  expect(second.subject.startsWith("tsub_")).toEqual(true);
  expect(second.email).toEqual("octo@example.test");
  expect(second.displayName).toEqual("Octo Cat");
  expect(second.createdAt).toEqual(1000);
  expect(second.updatedAt).toEqual(2000);
});

test("resolveUpstreamAccount carries the upstream email_verified assertion", async () => {
  const store = new InMemoryAccountsStore();
  const verified = await resolveUpstreamAccount({
    store,
    subjectSecret: "subject-secret",
    providerId: "google",
    upstreamIssuer: "https://accounts.google.com",
    upstreamSubject: "verified-user",
    profile: {
      email: "verified@example.test",
      emailVerified: true,
    },
    now: 1000,
  }) as { emailVerified?: boolean };
  expect(verified.emailVerified).toEqual(true);

  // A provider that does not assert email_verified leaves it undefined
  // (genuinely unknown) rather than coercing it to a boolean.
  const unknown = await resolveUpstreamAccount({
    store,
    subjectSecret: "subject-secret",
    providerId: "github",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "unknown-user",
    profile: { email: "unknown@example.test" },
    now: 1000,
  }) as { emailVerified?: boolean };
  expect(unknown.emailVerified).toEqual(undefined);
});

test("registerPasskeyCredential requires an existing account", async () => {
  const store = new InMemoryAccountsStore();
  await assertRejects(
    () =>
      registerPasskeyCredential({
        store,
        subject: "tsub_missing",
        credentialId: "credential-1",
        publicKeyJwk: { kty: "EC" },
      }),
    TypeError,
    "subject does not exist",
  );
});

test("authenticatePasskey verifies the assertion and updates sign count", async () => {
  const store = new InMemoryAccountsStore();
  const account = await resolveUpstreamAccount({
    store,
    subjectSecret: "subject-secret",
    providerId: "github",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
    now: 1000,
  });
  const assertion = await createSignedAssertion({
    challenge: "challenge-1",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 3,
  });
  await registerPasskeyCredential({
    store,
    subject: account.subject,
    credentialId: "credential-1",
    publicKeyJwk: assertion.publicKeyJwk,
    signCount: 2,
    now: 1000,
  });

  const result = await authenticatePasskey({
    store,
    credentialId: "credential-1",
    expectedChallenge: "challenge-1",
    expectedOrigin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
    signature: assertion.signature,
    now: 2000,
  });

  expect(result.account.subject).toEqual(account.subject);
  expect(result.credential.signCount).toEqual(3);
  expect(result.credential.updatedAt).toEqual(2000);
});

test("authenticatePasskey rejects non-increasing sign counts", async () => {
  const store = new InMemoryAccountsStore();
  const account = await resolveUpstreamAccount({
    store,
    subjectSecret: "subject-secret",
    providerId: "github",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
  });
  const assertion = await createSignedAssertion({
    challenge: "challenge-1",
    origin: "https://accounts.example.test",
    rpId: "accounts.example.test",
    signCount: 3,
  });
  await registerPasskeyCredential({
    store,
    subject: account.subject,
    credentialId: "credential-1",
    publicKeyJwk: assertion.publicKeyJwk,
    signCount: 3,
  });

  await assertRejects(
    () =>
      authenticatePasskey({
        store,
        credentialId: "credential-1",
        expectedChallenge: "challenge-1",
        expectedOrigin: "https://accounts.example.test",
        rpId: "accounts.example.test",
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
        signature: assertion.signature,
      }),
    TypeError,
    "sign count did not increase",
  );
});

interface SignedAssertionInput {
  challenge: string;
  origin: string;
  rpId: string;
  signCount: number;
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
    flags: 0x01,
    signCount: input.signCount,
  });
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientDataJSON),
  );
  const signedData = concatBytes(authenticatorData, clientDataHash);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      signedData,
    ),
  );

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
