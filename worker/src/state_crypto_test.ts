import assert from "node:assert/strict";
import { test } from "bun:test";
import { digestBytes, StateArtifactCrypto } from "./state_crypto.ts";

const PASSPHRASE = "takosumi-state-crypto-test-passphrase-0123456789abcdef";

function cryptoFromEnv(): StateArtifactCrypto {
  return StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
  });
}

test("state crypto seals and opens binary plaintext, verifying the content digest", async () => {
  const crypto = cryptoFromEnv();
  // Arbitrary binary (a plan.bin is not valid UTF-8); include high bytes + NUL.
  const plaintext = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f, 0xab, 0xcd]);
  const sealed = await crypto.seal(plaintext);

  assert.equal(sealed.contentDigest, await digestBytes(plaintext));
  assert.equal(sealed.ciphertextLength, sealed.ciphertext.byteLength);
  // The ciphertext must not be the plaintext.
  assert.notDeepEqual(sealed.ciphertext, plaintext);

  const opened = await crypto.open(sealed.ciphertext, sealed.contentDigest);
  assert.deepEqual(opened, plaintext);
});

test("state crypto round-trips JSON tfstate text", async () => {
  const crypto = cryptoFromEnv();
  const state = new TextEncoder().encode(
    JSON.stringify({ version: 4, serial: 7, resources: [] }),
  );
  const sealed = await crypto.seal(state);
  const opened = await crypto.open(sealed.ciphertext, sealed.contentDigest);
  assert.deepEqual(opened, state);
});

test("state crypto open fails closed on a ciphertext bit-flip (AES-GCM auth tag)", async () => {
  const crypto = cryptoFromEnv();
  const plaintext = new TextEncoder().encode("sensitive-state-value");
  const sealed = await crypto.seal(plaintext);

  const tampered = new Uint8Array(sealed.ciphertext);
  // Flip a bit in the ciphertext body (past the 12-byte IV) — the GCM tag must
  // reject it before any plaintext is returned.
  tampered[tampered.length - 1] ^= 0x01;
  await assert.rejects(() => crypto.open(tampered, sealed.contentDigest));
});

test("state crypto open fails closed on an IV bit-flip", async () => {
  const crypto = cryptoFromEnv();
  const plaintext = new TextEncoder().encode("another-state");
  const sealed = await crypto.seal(plaintext);
  const tampered = new Uint8Array(sealed.ciphertext);
  tampered[0] ^= 0x01; // first IV byte
  await assert.rejects(() => crypto.open(tampered));
});

test("state crypto open fails closed when the expected content digest mismatches", async () => {
  const crypto = cryptoFromEnv();
  const plaintext = new TextEncoder().encode("genuine-state");
  const sealed = await crypto.seal(plaintext);
  // Decryption succeeds (auth tag is valid) but the recorded digest is wrong:
  // restore must still fail closed rather than hand back unexpected content.
  const wrongDigest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(() => crypto.open(sealed.ciphertext, wrongDigest));
});

test("state crypto open succeeds without an expected digest (digest optional)", async () => {
  const crypto = cryptoFromEnv();
  const plaintext = new TextEncoder().encode("no-digest-check");
  const sealed = await crypto.seal(plaintext);
  const opened = await crypto.open(sealed.ciphertext);
  assert.deepEqual(opened, plaintext);
});

test("state crypto fromEnv fails closed in production without a passphrase", () => {
  assert.throws(() =>
    StateArtifactCrypto.fromEnv({ TAKOSUMI_ENVIRONMENT: "production" })
  );
});

test("two seals of the same plaintext differ (random IV) but both open", async () => {
  const crypto = cryptoFromEnv();
  const plaintext = new TextEncoder().encode("repeatable");
  const a = await crypto.seal(plaintext);
  const b = await crypto.seal(plaintext);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.equal(a.contentDigest, b.contentDigest);
  assert.deepEqual(await crypto.open(a.ciphertext, a.contentDigest), plaintext);
  assert.deepEqual(await crypto.open(b.ciphertext, b.contentDigest), plaintext);
});
