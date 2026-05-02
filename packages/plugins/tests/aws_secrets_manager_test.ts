import assert from "node:assert/strict";
import {
  type AwsSecretDescriptor,
  type AwsSecretsLifecycleClient,
  AwsSecretsManagerProvider,
} from "../src/providers/aws/mod.ts";

const noSleep = {
  maxAttempts: 3,
  baseDelayMs: 1,
  sleep: () => Promise.resolve(),
};

const baseSecret: AwsSecretDescriptor = {
  arn: "arn:aws:secretsmanager:us-east-1:1:secret:db-creds-AbCdEf",
  name: "db-creds",
  description: "database credentials",
  kmsKeyArn: "arn:aws:kms:us-east-1:1:key/abc",
  rotationEnabled: false,
};

function fakeLifecycle(
  overrides: Partial<AwsSecretsLifecycleClient> = {},
): AwsSecretsLifecycleClient {
  return {
    createSecret: () => Promise.resolve(baseSecret),
    describeSecret: () => Promise.resolve(baseSecret),
    deleteSecret: () => Promise.resolve(true),
    configureRotation: () =>
      Promise.resolve({ ...baseSecret, rotationEnabled: true }),
    ...overrides,
  };
}

Deno.test("secrets-manager createSecret happy path", async () => {
  const provider = new AwsSecretsManagerProvider({
    lifecycle: fakeLifecycle(),
    retry: noSleep,
  });
  const result = await provider.createSecret({ name: "db-creds" });
  assert.equal(result.name, "db-creds");
});

Deno.test("secrets-manager describeSecret maps not-found to undefined", async () => {
  const provider = new AwsSecretsManagerProvider({
    lifecycle: fakeLifecycle({
      describeSecret: () => {
        const e = new Error("missing") as Error & { name: string };
        e.name = "ResourceNotFoundException";
        return Promise.reject(e);
      },
    }),
    retry: noSleep,
  });
  const result = await provider.describeSecret({ name: "missing" });
  assert.equal(result, undefined);
});

Deno.test("secrets-manager configureRotation retries on TooManyRequestsException", async () => {
  let attempts = 0;
  const provider = new AwsSecretsManagerProvider({
    lifecycle: fakeLifecycle({
      configureRotation: () => {
        attempts += 1;
        if (attempts < 2) {
          const e = new Error("throttled") as Error & { name: string };
          e.name = "TooManyRequestsException";
          return Promise.reject(e);
        }
        return Promise.resolve({ ...baseSecret, rotationEnabled: true });
      },
    }),
    retry: noSleep,
  });
  await provider.configureRotation({
    name: "db-creds",
    rotationLambdaArn: "arn:aws:lambda:us-east-1:1:function:rotate",
    rotationIntervalDays: 30,
  });
  assert.equal(attempts, 2);
});

Deno.test("secrets-manager listAllSecrets paginates", async () => {
  const pages = [
    { items: [{ ...baseSecret, name: "a" }], nextToken: "p2" },
    {
      items: [{ ...baseSecret, name: "b" }, { ...baseSecret, name: "c" }],
      nextToken: undefined,
    },
  ];
  let pageIndex = 0;
  const provider = new AwsSecretsManagerProvider({
    lifecycle: fakeLifecycle({
      listSecrets: () => Promise.resolve(pages[pageIndex++]),
    }),
    retry: noSleep,
  });
  const all = await provider.listAllSecrets();
  assert.equal(all.length, 3);
  assert.equal(all[2]?.name, "c");
});

Deno.test("secrets-manager detectDrift reports rotationEnabled mismatch", async () => {
  const provider = new AwsSecretsManagerProvider({
    lifecycle: fakeLifecycle({
      describeSecret: () =>
        Promise.resolve({
          ...baseSecret,
          rotationEnabled: true,
          rotationIntervalDays: 30,
        }),
    }),
    retry: noSleep,
  });
  const drift = await provider.detectDrift({
    name: "db-creds",
    kmsKeyArn: "arn:aws:kms:us-east-1:1:key/abc",
    rotationEnabled: false,
    rotationIntervalDays: 30,
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "rotationEnabled");
});

Deno.test("secrets-manager getSecretValue throws when secrets client missing", async () => {
  const provider = new AwsSecretsManagerProvider({
    lifecycle: fakeLifecycle(),
    retry: noSleep,
  });
  await assert.rejects(
    () => provider.getSecretValue({ secretName: "db-creds", versionId: "1" }),
    /secrets client/,
  );
});
