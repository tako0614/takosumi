import assert from "node:assert/strict";
import {
  type AwsRdsClient,
  type AwsRdsInstanceDescriptor,
  AwsRdsProvider,
} from "../src/providers/aws/mod.ts";

const noSleep = {
  maxAttempts: 3,
  baseDelayMs: 1,
  sleep: () => Promise.resolve(),
};

const baseDescriptor: AwsRdsInstanceDescriptor = {
  instanceIdentifier: "db-1",
  arn: "arn:aws:rds:us-east-1:1:db:db-1",
  endpoint: "db-1.cluster.aws.com",
  port: 5432,
  engine: "postgres",
  engineVersion: "15.5",
  status: "available",
  databaseName: "app",
  masterUsername: "admin",
};

Deno.test("rds describeInstance returns descriptor on happy path", async () => {
  const client: AwsRdsClient = {
    createInstance: () => Promise.resolve(baseDescriptor),
    describeInstance: () => Promise.resolve(baseDescriptor),
    deleteInstance: () => Promise.resolve(true),
  };
  const provider = new AwsRdsProvider({ client, retry: noSleep });
  const result = await provider.describeInstance({
    instanceIdentifier: "db-1",
  });
  assert.equal(result?.endpoint, "db-1.cluster.aws.com");
});

Deno.test("rds describeInstance maps not-found to undefined", async () => {
  const client: AwsRdsClient = {
    createInstance: () => Promise.resolve(baseDescriptor),
    describeInstance: () => {
      const e = new Error("not found") as Error & { name: string };
      e.name = "DBInstanceNotFound";
      return Promise.reject(e);
    },
    deleteInstance: () => Promise.resolve(true),
  };
  const provider = new AwsRdsProvider({ client, retry: noSleep });
  const result = await provider.describeInstance({
    instanceIdentifier: "missing",
  });
  assert.equal(result, undefined);
});

Deno.test("rds createInstance retries on throttling", async () => {
  let attempts = 0;
  const client: AwsRdsClient = {
    createInstance: () => {
      attempts += 1;
      if (attempts < 3) {
        const e = new Error("throttle") as Error & { name: string };
        e.name = "Throttling";
        return Promise.reject(e);
      }
      return Promise.resolve(baseDescriptor);
    },
    describeInstance: () => Promise.resolve(baseDescriptor),
    deleteInstance: () => Promise.resolve(true),
  };
  const provider = new AwsRdsProvider({ client, retry: noSleep });
  const result = await provider.createInstance({
    instanceIdentifier: "db-1",
    engine: "postgres",
    instanceClass: "db.t3.micro",
    masterUsername: "admin",
  });
  assert.equal(attempts, 3);
  assert.equal(result.instanceIdentifier, "db-1");
});

Deno.test("rds resolveEndpoint throws when status is creating", async () => {
  const client: AwsRdsClient = {
    createInstance: () => Promise.resolve(baseDescriptor),
    describeInstance: () =>
      Promise.resolve({
        ...baseDescriptor,
        status: "creating",
        endpoint: undefined,
        port: undefined,
      }),
    deleteInstance: () => Promise.resolve(true),
  };
  const provider = new AwsRdsProvider({ client, retry: noSleep });
  await assert.rejects(
    () => provider.resolveEndpoint("db-1"),
    /no endpoint yet/,
  );
});

Deno.test("rds listInstances paginates across nextToken pages", async () => {
  const pages = [
    {
      items: [{ ...baseDescriptor, instanceIdentifier: "a" }],
      nextToken: "p2",
    },
    {
      items: [{ ...baseDescriptor, instanceIdentifier: "b" }],
      nextToken: undefined,
    },
  ];
  let pageIndex = 0;
  const client: AwsRdsClient = {
    createInstance: () => Promise.resolve(baseDescriptor),
    describeInstance: () => Promise.resolve(baseDescriptor),
    deleteInstance: () => Promise.resolve(true),
    listInstances: () => Promise.resolve(pages[pageIndex++]),
  };
  const provider = new AwsRdsProvider({ client, retry: noSleep });
  const all = await provider.listInstances();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.instanceIdentifier, "a");
  assert.equal(all[1]?.instanceIdentifier, "b");
});

Deno.test("rds detectDrift returns drift for engine version mismatch", async () => {
  const client: AwsRdsClient = {
    createInstance: () => Promise.resolve(baseDescriptor),
    describeInstance: () =>
      Promise.resolve({ ...baseDescriptor, engineVersion: "14.10" }),
    deleteInstance: () => Promise.resolve(true),
  };
  const provider = new AwsRdsProvider({ client, retry: noSleep });
  const drift = await provider.detectDrift({
    instanceIdentifier: "db-1",
    engine: "postgres",
    engineVersion: "15.5",
    instanceClass: "db.t3.micro",
    masterUsername: "admin",
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "engineVersion");
  assert.equal(drift[0]?.desired, "15.5");
  assert.equal(drift[0]?.observed, "14.10");
});
