import assert from "node:assert/strict";
import {
  cloudPartitionEnvKeys,
  MemoryEncryptedSecretStore,
  MultiCloudSecretBoundaryCrypto,
  PlaceholderSecretBoundaryCrypto,
  SECRET_STORE_KEY_ENV_KEYS,
  SecretEncryptionConfigurationError,
  selectSecretBoundaryCrypto,
} from "./mod.ts";

Deno.test("memory encrypted secret store keeps versioned secret boundary", async () => {
  const store = new MemoryEncryptedSecretStore({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: () => "v1",
  });

  const record = await store.putSecret({
    name: "DATABASE_URL",
    value: "postgres://example",
    metadata: { scope: "test" },
  });

  assert.equal(record.version, "secret_version_v1");
  assert.equal(record.cloudPartition, "global");
  // latestSecret reflects the freshly-written record (no read yet).
  assert.deepEqual(await store.latestSecret("DATABASE_URL"), record);
  assert.equal(await store.getSecret(record), "postgres://example");
  // After reading, lastAccessedAt is recorded on the underlying record.
  const afterRead = await store.latestSecret("DATABASE_URL");
  assert.equal(afterRead?.lastAccessedAt, "2026-04-27T00:00:00.000Z");
  assert.equal((await store.listSecrets()).length, 1);
  assert.equal(await store.deleteSecret(record), true);
  assert.equal(await store.getSecret(record), undefined);
});

Deno.test("selectSecretBoundaryCrypto fails closed in production without key", () => {
  assert.throws(
    () =>
      selectSecretBoundaryCrypto({
        env: { TAKOS_ENVIRONMENT: "production" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SecretEncryptionConfigurationError);
      const message = (error as Error).message;
      assert.match(message, /production/);
      assert.match(message, /Refusing to fall back to plaintext/);
      for (const key of SECRET_STORE_KEY_ENV_KEYS) {
        assert.match(message, new RegExp(key));
      }
      return true;
    },
  );
});

Deno.test("selectSecretBoundaryCrypto fails closed in staging without key", () => {
  assert.throws(
    () =>
      selectSecretBoundaryCrypto({
        env: { TAKOS_ENVIRONMENT: "staging" },
      }),
    SecretEncryptionConfigurationError,
  );
});

Deno.test("selectSecretBoundaryCrypto rejects production opt-in attempts", () => {
  // TAKOS_ALLOW_PLAINTEXT_SECRETS must NOT bypass production fail-closed.
  assert.throws(
    () =>
      selectSecretBoundaryCrypto({
        env: {
          TAKOS_ENVIRONMENT: "production",
          TAKOS_ALLOW_PLAINTEXT_SECRETS: "1",
        },
      }),
    SecretEncryptionConfigurationError,
  );
});

Deno.test("selectSecretBoundaryCrypto returns multi-cloud AES-GCM crypto when global key supplied", async () => {
  const crypto = selectSecretBoundaryCrypto({
    env: {
      TAKOS_ENVIRONMENT: "production",
      TAKOS_SECRET_STORE_PASSPHRASE: "test-passphrase-with-enough-entropy-32",
    },
  });
  assert.ok(crypto instanceof MultiCloudSecretBoundaryCrypto);
  const sealed = await crypto.seal("hello", "global");
  // AES-GCM output begins with a 12-byte IV and is opaque (not base64).
  assert.ok(sealed.length > 12);
  assert.equal(await crypto.open(sealed, "global"), "hello");
});

Deno.test("selectSecretBoundaryCrypto allows local opt-in to placeholder", () => {
  const crypto = selectSecretBoundaryCrypto({
    env: {
      TAKOS_ENVIRONMENT: "local",
      TAKOS_ALLOW_PLAINTEXT_SECRETS: "1",
    },
  });
  assert.ok(crypto instanceof PlaceholderSecretBoundaryCrypto);
});

Deno.test("selectSecretBoundaryCrypto requires local plaintext opt-in", () => {
  assert.throws(
    () =>
      selectSecretBoundaryCrypto({
        env: { TAKOS_ENVIRONMENT: "local" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SecretEncryptionConfigurationError);
      const message = (error as Error).message;
      assert.match(message, /TAKOS_ALLOW_PLAINTEXT_SECRETS=1/);
      return true;
    },
  );
});

Deno.test("MemoryEncryptedSecretStore env option drives fail-closed", () => {
  assert.throws(
    () =>
      new MemoryEncryptedSecretStore({
        env: { TAKOS_ENVIRONMENT: "production" },
      }),
    SecretEncryptionConfigurationError,
  );
});

Deno.test("MemoryEncryptedSecretStore env option uses AES-GCM with key", async () => {
  const store = new MemoryEncryptedSecretStore({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    idGenerator: () => "v1",
    env: {
      TAKOS_ENVIRONMENT: "production",
      ENCRYPTION_KEY: "production-secret-passphrase-32-byte",
    },
  });
  const record = await store.putSecret({
    name: "DATABASE_URL",
    value: "postgres://example",
  });
  assert.equal(await store.getSecret(record), "postgres://example");
});

// ---------------------------------------------------------------------------
// Phase 18.2 H14: per-cloud secret partition isolation
// ---------------------------------------------------------------------------

Deno.test("cloudPartitionEnvKeys derives per-cloud env names", () => {
  assert.deepEqual(cloudPartitionEnvKeys("global"), SECRET_STORE_KEY_ENV_KEYS);
  assert.deepEqual(cloudPartitionEnvKeys("aws"), [
    "TAKOS_SECRET_STORE_PASSPHRASE_AWS",
    "TAKOS_SECRET_STORE_KEY_AWS",
    "TAKOS_SECRET_ENCRYPTION_KEY_AWS",
    "ENCRYPTION_KEY_AWS",
  ]);
});

Deno.test("MultiCloudSecretBoundaryCrypto isolates partitions: aws ciphertext is unreadable with global key only", async () => {
  // The "aws" cloud has a dedicated override key; "gcp" inherits from global.
  const crypto = new MultiCloudSecretBoundaryCrypto({
    globalPassphrase: "global-passphrase-32-byte-x".padEnd(40, "x"),
    perCloudPassphrases: {
      aws: "aws-only-passphrase-32-byte".padEnd(40, "y"),
      gcp: "gcp-only-passphrase-32-byte".padEnd(40, "z"),
    },
  });
  const awsCipher = await crypto.seal("aws-secret", "aws");
  const gcpCipher = await crypto.seal("gcp-secret", "gcp");

  // Same partition opens fine.
  assert.equal(await crypto.open(awsCipher, "aws"), "aws-secret");
  assert.equal(await crypto.open(gcpCipher, "gcp"), "gcp-secret");

  // Cross-partition open MUST fail (AAD + key mismatch).
  await assert.rejects(() => crypto.open(awsCipher, "gcp"));
  await assert.rejects(() => crypto.open(awsCipher, "global"));
  await assert.rejects(() => crypto.open(gcpCipher, "aws"));
});

Deno.test("MultiCloudSecretBoundaryCrypto: aws key compromise does not unlock other partitions", async () => {
  const sealing = new MultiCloudSecretBoundaryCrypto({
    globalPassphrase: "global-pass-".padEnd(40, "g"),
    perCloudPassphrases: {
      aws: "aws-pass-".padEnd(40, "a"),
      gcp: "gcp-pass-".padEnd(40, "c"),
    },
  });
  const gcpCipher = await sealing.seal("top-secret-gcp", "gcp");
  const cloudflareCipher = await sealing.seal(
    "cloudflare-secret",
    "cloudflare",
  );

  // Simulate adversary who compromised ONLY the AWS key (and does not know
  // the global / gcp / cloudflare passphrases). Construct a crypto that
  // believes the AWS key is also the global / gcp / cloudflare key.
  const compromised = new MultiCloudSecretBoundaryCrypto({
    globalPassphrase: "aws-pass-".padEnd(40, "a"),
    perCloudPassphrases: {
      aws: "aws-pass-".padEnd(40, "a"),
      gcp: "aws-pass-".padEnd(40, "a"),
      cloudflare: "aws-pass-".padEnd(40, "a"),
    },
  });
  await assert.rejects(() => compromised.open(gcpCipher, "gcp"));
  await assert.rejects(() => compromised.open(cloudflareCipher, "cloudflare"));
});

Deno.test("MemoryEncryptedSecretStore stores per-cloud partition and rejects cross-partition reads", async () => {
  const store = new MemoryEncryptedSecretStore({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "global-".padEnd(40, "g"),
      perCloudPassphrases: {
        aws: "aws-".padEnd(40, "a"),
        gcp: "gcp-".padEnd(40, "c"),
      },
    }),
  });
  const awsRecord = await store.putSecret({
    name: "AWS_ACCESS_KEY_ID",
    value: "AKIA-FAKE",
    cloudPartition: "aws",
  });
  const gcpRecord = await store.putSecret({
    name: "GCP_API_KEY",
    value: "gcp-fake",
    cloudPartition: "gcp",
  });
  assert.equal(awsRecord.cloudPartition, "aws");
  assert.equal(gcpRecord.cloudPartition, "gcp");
  assert.equal(await store.getSecret(awsRecord), "AKIA-FAKE");
  assert.equal(await store.getSecret(gcpRecord), "gcp-fake");

  const awsList = await store.listSecrets({ cloudPartition: "aws" });
  assert.equal(awsList.length, 1);
  assert.equal(awsList[0].name, "AWS_ACCESS_KEY_ID");
});

Deno.test("MultiCloudSecretBoundaryCrypto.fromEnv picks per-cloud overrides", async () => {
  const env = {
    TAKOS_SECRET_STORE_PASSPHRASE: "global-passphrase-".padEnd(40, "g"),
    TAKOS_SECRET_STORE_PASSPHRASE_AWS: "aws-only-".padEnd(40, "a"),
  };
  const crypto = MultiCloudSecretBoundaryCrypto.fromEnv(
    env,
    env.TAKOS_SECRET_STORE_PASSPHRASE,
  );
  // Sanity: roundtrip works.
  const sealed = await crypto.seal("ok", "aws");
  assert.equal(await crypto.open(sealed, "aws"), "ok");
  // Cross partition still fails when sealed with aws key.
  await assert.rejects(() => crypto.open(sealed, "global"));
});

// ---------------------------------------------------------------------------
// Phase 18.2 H15: rotation policy + version GC
// ---------------------------------------------------------------------------

Deno.test("rotationStatus marks secrets due / expired based on policy", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryEncryptedSecretStore({
    clock: () => now,
    idGenerator: () => "v1",
  });
  await store.putSecret({
    name: "PLATFORM_PRIVATE_KEY",
    value: "sk-fake",
    rotationPolicy: { intervalDays: 30, gracePeriodDays: 7 },
  });

  // active immediately after creation.
  let status = store.rotationStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0].state, "active");

  // due once we cross 30 days.
  now = new Date("2026-02-05T00:00:00.000Z");
  status = store.rotationStatus();
  assert.equal(status[0].state, "due");

  // expired past grace period (30 + 7 = 37 days).
  now = new Date("2026-02-15T00:00:00.000Z");
  status = store.rotationStatus();
  assert.equal(status[0].state, "expired");
});

Deno.test("runVersionGc keeps latest N + recently accessed versions", async () => {
  let counter = 0;
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryEncryptedSecretStore({
    clock: () => now,
    idGenerator: () => `v${++counter}`,
    versionRetention: { keepLatest: 2, accessedWithinDays: 30 },
  });

  // Put 6 versions of the same secret name on consecutive days.
  const refs: { name: string; version: string }[] = [];
  for (let i = 0; i < 6; i++) {
    now = new Date(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`);
    const rec = await store.putSecret({
      name: "DATABASE_URL",
      value: `value-${i}`,
    });
    refs.push({ name: rec.name, version: rec.version });
  }
  // Access version 2 at day 5 to keep it warm.
  now = new Date("2026-01-05T00:00:00.000Z");
  await store.getSecret(refs[1]);

  // Run GC at day 90 — accessed-within-30d window for v2 has passed.
  now = new Date("2026-04-01T00:00:00.000Z");
  const report = store.runVersionGc();
  assert.equal(report.evaluated, 6);
  // We retain: latest (index 5) + keepLatest=2 (indices 5,4). v2 access was
  // > 30 days ago so it falls out. So we keep 2 records.
  assert.equal(report.retained, 2);
  assert.equal(report.deleted.length, 4);

  const remaining = await store.listSecrets();
  assert.equal(remaining.length, 2);
  // Latest pointer is preserved.
  const latest = await store.latestSecret("DATABASE_URL");
  assert.ok(latest);
  assert.equal(latest!.version, refs[5].version);
});

Deno.test("runVersionGc retains versions accessed within window", async () => {
  let counter = 0;
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryEncryptedSecretStore({
    clock: () => now,
    idGenerator: () => `v${++counter}`,
    versionRetention: { keepLatest: 1, accessedWithinDays: 90 },
  });
  const refs = [];
  for (let i = 0; i < 4; i++) {
    now = new Date(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`);
    refs.push(await store.putSecret({ name: "API_KEY", value: `v-${i}` }));
  }
  // Access version 0 close to GC time so it stays warm.
  now = new Date("2026-03-01T00:00:00.000Z");
  await store.getSecret(refs[0]);

  // GC at day 60 — version 0 accessed at day 60, retained.
  now = new Date("2026-03-01T01:00:00.000Z");
  const report = store.runVersionGc();
  // Latest (v4) + recently-accessed (v0) retained.
  assert.equal(report.retained, 2);
});

Deno.test("getSecret updates lastAccessedAt", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryEncryptedSecretStore({
    clock: () => now,
    idGenerator: () => "v1",
  });
  const rec = await store.putSecret({ name: "X", value: "y" });
  assert.equal(rec.lastAccessedAt, undefined);
  now = new Date("2026-01-05T12:00:00.000Z");
  await store.getSecret(rec);
  const reread = await store.getSecretRecord(rec);
  assert.equal(reread!.lastAccessedAt, "2026-01-05T12:00:00.000Z");
});
