import assert from "node:assert/strict";
import {
  type AwsEcsFargateApplyResult,
  type AwsEcsFargateClient,
  AwsEcsFargateProviderMaterializer,
} from "../src/providers/aws/mod.ts";

const desiredState = {
  id: "ds_1",
  spaceId: "space_1",
  groupId: "group_1",
  activationId: "activation_1",
  appName: "docs",
  materializedAt: "2026-04-30T00:00:00.000Z",
  workloads: [],
  resources: [],
  routes: [],
};

function fakeClient(
  overrides: Partial<AwsEcsFargateClient> = {},
): AwsEcsFargateClient {
  const baseResult: AwsEcsFargateApplyResult = {
    serviceArn: "arn:aws:ecs:us-east-1:1:service/cluster/svc",
    taskDefinitionArn: "arn:aws:ecs:us-east-1:1:task-definition/docs:1",
    clusterArn: "arn:aws:ecs:us-east-1:1:cluster/cluster",
    serviceName: "svc",
  };
  return {
    applyEcsService: () => Promise.resolve(baseResult),
    deleteEcsService: () => Promise.resolve({ deleted: true }),
    ...overrides,
  };
}

Deno.test("ecs-fargate happy path emits succeeded operation", async () => {
  const m = new AwsEcsFargateProviderMaterializer({
    client: fakeClient(),
    clusterName: "cluster",
    serviceName: "svc",
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id_1",
    retry: { maxAttempts: 1, baseDelayMs: 1, sleep: () => Promise.resolve() },
  });
  const plan = await m.materialize(desiredState);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]?.execution?.status, "succeeded");
  assert.equal(plan.operations[0]?.kind, "aws-ecs-fargate-apply");
  assert.equal(
    plan.operations[0]?.targetId,
    "arn:aws:ecs:us-east-1:1:service/cluster/svc",
  );
});

Deno.test("ecs-fargate retries on throttling and succeeds", async () => {
  let attempts = 0;
  const m = new AwsEcsFargateProviderMaterializer({
    client: fakeClient({
      applyEcsService: () => {
        attempts += 1;
        if (attempts < 3) {
          const e = new Error("rate") as Error & { name: string };
          e.name = "ThrottlingException";
          return Promise.reject(e);
        }
        return Promise.resolve({
          serviceArn: "arn:svc",
          serviceName: "svc",
          clusterArn: "arn:cluster",
        });
      },
    }),
    clusterName: "cluster",
    serviceName: "svc",
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id_1",
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: () => Promise.resolve() },
  });
  const plan = await m.materialize(desiredState);
  assert.equal(attempts, 3);
  assert.equal(plan.operations[0]?.execution?.status, "succeeded");
});

Deno.test("ecs-fargate maps validation errors to failed condition", async () => {
  const m = new AwsEcsFargateProviderMaterializer({
    client: fakeClient({
      applyEcsService: () => {
        const e = new Error("bad config") as Error & { name: string };
        e.name = "ValidationException";
        return Promise.reject(e);
      },
    }),
    clusterName: "cluster",
    serviceName: "svc",
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id_1",
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: () => Promise.resolve() },
  });
  const plan = await m.materialize(desiredState);
  assert.equal(plan.operations[0]?.execution?.status, "failed");
  assert.equal(plan.operations[0]?.details.errorCategory, "validation");
  assert.equal(plan.operations[0]?.details.reason, "bad config");
});

Deno.test("ecs-fargate access-denied is not retried", async () => {
  let attempts = 0;
  const m = new AwsEcsFargateProviderMaterializer({
    client: fakeClient({
      applyEcsService: () => {
        attempts += 1;
        const e = new Error("denied") as Error & { name: string };
        e.name = "AccessDeniedException";
        return Promise.reject(e);
      },
    }),
    clusterName: "cluster",
    serviceName: "svc",
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id_1",
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: () => Promise.resolve() },
  });
  const plan = await m.materialize(desiredState);
  assert.equal(attempts, 1);
  assert.equal(plan.operations[0]?.details.errorCategory, "access-denied");
});

Deno.test("ecs-fargate detectDrift returns drift fields", async () => {
  const m = new AwsEcsFargateProviderMaterializer({
    client: fakeClient({
      describeEcsService: () =>
        Promise.resolve({
          serviceArn: "arn:svc",
          clusterArn: "arn:cluster",
          serviceName: "svc",
          desiredCount: 5,
        }),
    }),
    clusterName: "cluster",
    serviceName: "svc",
    desiredCount: 3,
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id_1",
  });
  const drift = await m.detectDrift({
    clusterName: "cluster",
    serviceName: "svc",
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "desiredCount");
  assert.equal(drift[0]?.desired, 3);
  assert.equal(drift[0]?.observed, 5);
});

Deno.test("ecs-fargate deleteService throws when client lacks deleteEcsService", async () => {
  const m = new AwsEcsFargateProviderMaterializer({
    client: { applyEcsService: () => Promise.reject(new Error("never")) },
    clusterName: "cluster",
    serviceName: "svc",
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
    idGenerator: () => "id_1",
  });
  await assert.rejects(
    () => m.deleteService({ clusterName: "cluster", serviceName: "svc" }),
    /deleteEcsService/,
  );
});
