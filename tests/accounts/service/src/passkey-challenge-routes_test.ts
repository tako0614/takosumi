import { expect, test } from "bun:test";
import { createAccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import type { PasskeyChallengeAdmissionInput, PasskeyChallengeSweepInput } from "../../../../accounts/service/src/passkey-challenge-policy.ts";
import { legacyPasskeyChallengeKey, passkeyChallengeKey } from "../../../../accounts/service/src/passkey-challenge-store.ts";

const issuer = "https://passkey.example.test";
const passkeys = { rpId: "passkey.example.test", rpName: "Fixture", origin: issuer };
const subject = "tsub_fixture";
const path = "/api/v1/auth/passkeys/authenticate";
function request(suffix: string, body: unknown, session?: string) {
  return new Request(issuer + path + suffix, { method: "POST",
    headers: { origin: issuer, "content-type": "application/json",
      ...(session ? { authorization: `Bearer ${session}` } : {}) },
    body: JSON.stringify(body) });
}

class ObservedStore extends InMemoryAccountsStore {
  admissions: string[] = [];
  sweeps = 0;
  override admitPasskeyChallenge(input: PasskeyChallengeAdmissionInput) {
    this.admissions.push(input.key);
    return super.admitPasskeyChallenge(input);
  }
  override prunePasskeyChallenges(input: PasskeyChallengeSweepInput) {
    this.sweeps++;
    return super.prunePasskeyChallenges(input);
  }
}

test("invalid passkey options inputs do not reach challenge admission or cleanup", async () => {
  const store = new ObservedStore();
  const handler = createAccountsHandler({ issuer, passkeys, store });
  for (const value of [null, "other", `tsub_${"x".repeat(252)}`, `tsub_${"é".repeat(126)}`]) {
    expect((await handler(request("/options", { subject: value }))).status).toBe(400);
  }
  expect((await handler(request("/options", { subject }, "s".repeat(513)))).status).toBe(400);
  expect(store.admissions).toHaveLength(0);
  expect(store.sweeps).toBe(0);
});

test("passkey options accept the exact byte bound and persist only a fixed-size key", async () => {
  const store = new ObservedStore();
  const handler = createAccountsHandler({ issuer, passkeys, store });
  const response = await handler(request("/options", { subject: `tsub_${"x".repeat(251)}` }));
  expect(response.status).toBe(200);
  expect(store.admissions).toHaveLength(1);
  expect(store.admissions[0]).toHaveLength(75);
  expect(store.admissions[0]).not.toContain("tsub_");
  expect(await response.json()).toMatchObject({ allowCredentials: [] });
});

test("passkey capability absence fails at composition without disabling ordinary Accounts", () => {
  const store = new InMemoryAccountsStore();
  Object.defineProperty(store, "admitPasskeyChallenge", { value: undefined });
  expect(() => createAccountsHandler({ issuer, passkeys, store })).toThrow("bounded challenge");
  expect(() => createAccountsHandler({ issuer, store })).not.toThrow();
});

test("passkey hashed keys bind tuple boundaries and context", async () => {
  const common = { intent: "authenticate" as const, challenge: "A".repeat(43) };
  const a = { ...common, subject: "tsub_a:b", sessionId: "c" };
  const b = { ...common, subject: "tsub_a", sessionId: "b:c" };
  expect(legacyPasskeyChallengeKey(a)).toBe(legacyPasskeyChallengeKey(b));
  expect(await passkeyChallengeKey(a)).not.toBe(await passkeyChallengeKey(b));
  expect(await passkeyChallengeKey(a)).not.toBe(await passkeyChallengeKey({ ...a, intent: "register" }));
});

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

async function signedBody(challenge: string) {
  // Synthetic local key/custody; real verification runs, not a real device/SSO.
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const client = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge, origin: issuer }));
  const auth = new Uint8Array(37);
  auth.set(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(passkeys.rpId))));
  auth[32] = 0x05;
  new DataView(auth.buffer).setUint32(33, 1);
  const signed = new Uint8Array(69);
  signed.set(auth);
  signed.set(new Uint8Array(await crypto.subtle.digest("SHA-256", client)), 37);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
  return { publicKeyJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    body: { credentialId: "fixture-credential", expectedChallenge: challenge,
      authenticatorData: encode(auth), clientDataJSON: encode(client), signature: encode(signature) } };
}

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy" : "v2"} passkey ceremony completes through actual verification once`, async () => {
    const store = new InMemoryAccountsStore();
    const at = Date.now();
    store.saveAccount({ subject, createdAt: at, updatedAt: at });
    const handler = createAccountsHandler({ issuer, passkeys, store });
    let challenge: string;
    if (legacy) {
      challenge = "L".repeat(43);
      store.savePasskeyChallenge(legacyPasskeyChallengeKey({ subject, sessionId: null,
        intent: "authenticate", challenge }), challenge, at + 60_000);
    } else {
      const options = await handler(request("/options", { subject }));
      expect(options.status).toBe(200);
      challenge = ((await options.json()) as { challenge: string }).challenge;
    }
    const signed = await signedBody(challenge);
    store.savePasskeyCredential({ credentialId: "fixture-credential", subject,
      publicKeyJwk: signed.publicKeyJwk, signCount: 0, createdAt: at, updatedAt: at });
    const completed = await handler(request("/complete", signed.body));
    expect(completed.status).toBe(200);
    expect(completed.headers.get("set-cookie")).toBeTruthy();
    expect(store.findPasskeyCredential("fixture-credential")?.signCount).toBe(1);
    const replay = await handler(request("/complete", signed.body));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: "unknown_challenge" } });
  });
}

test("legacy challenge from another session cannot authenticate or erase its original binding", async () => {
  const store = new InMemoryAccountsStore();
  const at = Date.now();
  const challenge = "S".repeat(43);
  const key = legacyPasskeyChallengeKey({ subject, sessionId: "another-session",
    intent: "authenticate", challenge });
  store.savePasskeyChallenge(key, challenge, at + 60_000);
  store.saveAccount({ subject, createdAt: at, updatedAt: at });
  const signed = await signedBody(challenge);
  store.savePasskeyCredential({ credentialId: "fixture-credential", subject,
    publicKeyJwk: signed.publicKeyJwk, signCount: 0, createdAt: at, updatedAt: at });
  const handler = createAccountsHandler({ issuer, passkeys, store });
  const response = await handler(request("/complete", signed.body));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "unknown_challenge" } });
  expect(store.consumePasskeyChallenge(key, at)).toBe(challenge);
});
