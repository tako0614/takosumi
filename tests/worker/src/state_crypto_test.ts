import assert from "node:assert/strict";
import { test } from "bun:test";
import { selectSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import {
  digestBytes,
  maxStateArtifactCiphertextBytes,
  StateArtifactCrypto,
} from "../../../worker/src/state_crypto.ts";

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
  assert.equal(sealed.format, "aes-gcm-bytes-v2");
  // 5-byte v2 magic + 12-byte IV + plaintext + 16-byte GCM tag. In
  // particular, there is no 4/3 base64 expansion on new writes.
  assert.equal(sealed.ciphertextLength, plaintext.byteLength + 33);
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

test("state crypto opens legacy base64-wrapped AES-GCM artifacts", async () => {
  const plaintext = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x42, 0x43]);
  const binary = Array.from(plaintext, (byte) =>
    String.fromCharCode(byte)
  ).join("");
  const legacy = selectSecretBoundaryCrypto({
    env: { TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE },
  });
  const ciphertext = await legacy.seal(btoa(binary), "global");
  const expectedDigest = await digestBytes(plaintext);

  const artifactCrypto = cryptoFromEnv();
  const opened = await artifactCrypto.open(ciphertext, expectedDigest);
  assert.deepEqual(opened, plaintext);

  // Restore/copy migrations read the old object but every subsequent write is
  // byte-native v2.
  const migrated = await artifactCrypto.seal(opened);
  assert.equal(migrated.format, "aes-gcm-bytes-v2");
  assert.equal(migrated.ciphertextLength, plaintext.byteLength + 33);
});

test("legacy compatibility decoder preserves every base64 padding form", async () => {
  const legacy = selectSecretBoundaryCrypto({
    env: { TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE },
  });
  const artifactCrypto = cryptoFromEnv();
  for (const plaintext of [
    new Uint8Array([0xff]),
    new Uint8Array([0xff, 0x00]),
    new Uint8Array([0xff, 0x00, 0x80]),
    new Uint8Array([0xff, 0x00, 0x80, 0x7f]),
  ]) {
    const binary = Array.from(plaintext, (byte) =>
      String.fromCharCode(byte)
    ).join("");
    const ciphertext = await legacy.seal(btoa(binary), "global");
    assert.deepEqual(
      await artifactCrypto.open(ciphertext, await digestBytes(plaintext)),
      plaintext,
    );
  }
});

test("legacy compatibility decoder rejects authenticated non-base64 plaintext", async () => {
  const legacy = selectSecretBoundaryCrypto({
    env: { TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE },
  });
  const ciphertext = await legacy.seal("!!!!", "global");
  await assert.rejects(() => cryptoFromEnv().open(ciphertext));
});

test("ciphertext limits include both byte-native v2 and larger legacy base64 artifacts", () => {
  const maxPlaintextBytes = 1024;
  const limit = maxStateArtifactCiphertextBytes(maxPlaintextBytes);
  const legacyBase64Bytes = Math.ceil(maxPlaintextBytes / 3) * 4;
  const legacyAesGcmBytes = 12 + legacyBase64Bytes + 16;
  const legacyDevPlaceholderBytes =
    new TextEncoder().encode("takos-secret-placeholder-v1:").byteLength +
    Math.ceil(
        (new TextEncoder().encode("global|-|").byteLength +
          legacyBase64Bytes) /
          3,
      ) *
      4;
  assert.equal(
    limit,
    Math.max(
      maxPlaintextBytes + 33,
      legacyAesGcmBytes,
      legacyDevPlaceholderBytes,
    ),
  );
  assert.throws(() => maxStateArtifactCiphertextBytes(-1));
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
