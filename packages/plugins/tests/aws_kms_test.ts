import assert from "node:assert/strict";
import {
  type AwsKmsKeyDescriptor,
  type AwsKmsLifecycleClient,
  AwsKmsProvider,
} from "../src/providers/aws/mod.ts";

const noSleep = {
  maxAttempts: 3,
  baseDelayMs: 1,
  sleep: () => Promise.resolve(),
};

const baseKey: AwsKmsKeyDescriptor = {
  keyId: "1234abcd-12ab-34cd-56ef-1234567890ab",
  arn: "arn:aws:kms:us-east-1:1:key/1234abcd-12ab-34cd-56ef-1234567890ab",
  state: "Enabled",
  keyUsage: "ENCRYPT_DECRYPT",
  multiRegion: false,
  description: "tenant primary key",
};

function fakeLifecycle(
  overrides: Partial<AwsKmsLifecycleClient> = {},
): AwsKmsLifecycleClient {
  return {
    createKey: () => Promise.resolve(baseKey),
    describeKey: () => Promise.resolve(baseKey),
    enableKey: () => Promise.resolve(baseKey),
    disableKey: () => Promise.resolve({ ...baseKey, state: "Disabled" }),
    scheduleDeletion: () =>
      Promise.resolve({ ...baseKey, state: "PendingDeletion" }),
    ...overrides,
  };
}

Deno.test("kms createKey happy path", async () => {
  const provider = new AwsKmsProvider({
    lifecycle: fakeLifecycle(),
    retry: noSleep,
  });
  const result = await provider.createKey({
    description: "tenant primary key",
  });
  assert.equal(result.state, "Enabled");
});

Deno.test("kms describeKey maps NotFoundException to undefined", async () => {
  const provider = new AwsKmsProvider({
    lifecycle: fakeLifecycle({
      describeKey: () => {
        const e = new Error("nope") as Error & { name: string };
        e.name = "NotFoundException";
        return Promise.reject(e);
      },
    }),
    retry: noSleep,
  });
  const result = await provider.describeKey({ keyId: "missing" });
  assert.equal(result, undefined);
});

Deno.test("kms scheduleDeletion retries on InternalFailure", async () => {
  let attempts = 0;
  const provider = new AwsKmsProvider({
    lifecycle: fakeLifecycle({
      scheduleDeletion: () => {
        attempts += 1;
        if (attempts < 3) {
          const e = new Error("internal") as Error & { name: string };
          e.name = "InternalFailure";
          return Promise.reject(e);
        }
        return Promise.resolve({ ...baseKey, state: "PendingDeletion" });
      },
    }),
    retry: noSleep,
  });
  await provider.scheduleDeletion({
    keyId: baseKey.keyId,
    pendingWindowDays: 7,
  });
  assert.equal(attempts, 3);
});

Deno.test("kms listAllKeys paginates", async () => {
  const pages = [
    { items: [{ ...baseKey, keyId: "key-1" }], nextToken: "p2" },
    { items: [{ ...baseKey, keyId: "key-2" }], nextToken: undefined },
  ];
  let pageIndex = 0;
  const provider = new AwsKmsProvider({
    lifecycle: fakeLifecycle({
      listKeys: () => Promise.resolve(pages[pageIndex++]),
    }),
    retry: noSleep,
  });
  const all = await provider.listAllKeys();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.keyId, "key-1");
});

Deno.test("kms detectDrift reports keyUsage mismatch", async () => {
  const provider = new AwsKmsProvider({
    lifecycle: fakeLifecycle({
      describeKey: () =>
        Promise.resolve({ ...baseKey, keyUsage: "SIGN_VERIFY" }),
    }),
    retry: noSleep,
  });
  const drift = await provider.detectDrift({
    keyId: baseKey.keyId,
    keyUsage: "ENCRYPT_DECRYPT",
    multiRegion: false,
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "keyUsage");
});

Deno.test("kms encryptEnvelope throws when envelope client missing", async () => {
  const provider = new AwsKmsProvider({
    lifecycle: fakeLifecycle(),
    retry: noSleep,
  });
  await assert.rejects(
    () => provider.encryptEnvelope({ plaintext: "secret" }),
    /envelope client/,
  );
});
