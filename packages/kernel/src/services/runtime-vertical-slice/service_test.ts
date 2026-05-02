import assert from "node:assert/strict";
import type {
  ProviderMaterializationPlan,
  ProviderOperation,
} from "../../adapters/provider/mod.ts";
import type { RuntimeAgentWorkItem } from "../../agents/mod.ts";
import {
  DeploymentService,
  InMemoryDeploymentStore,
} from "../../domains/deploy/deployment_service.ts";
import type { PublicDeployManifest } from "../../domains/deploy/types.ts";
import { RuntimeAgentTerminalWorkProjector } from "./service.ts";
import { InMemoryProviderMaterializationStore } from "./stores.ts";

Deno.test("RuntimeAgentTerminalWorkProjector records terminal runtime-agent result on provider operation", async () => {
  const store = new InMemoryProviderMaterializationStore();
  await store.put(providerPlan());
  const projector = new RuntimeAgentTerminalWorkProjector({
    providerMaterializationStore: store,
  });

  await projector.complete(workItem({
    status: "completed",
    completedAt: "2026-04-30T00:01:00.000Z",
    metadata: {
      materializationId: "provider_plan_1",
      providerOperationId: "provider_op_1",
    },
    result: {
      execution: {
        stdout: "created resource",
        code: 0,
      },
    },
  }));

  const stored = await store.get("provider_plan_1");
  assert.equal(stored?.operations[0].execution?.status, "succeeded");
  assert.equal(stored?.operations[0].execution?.stdout, "created resource");
  assert.equal(
    stored?.operations[0].execution?.completedAt,
    "2026-04-30T00:01:00.000Z",
  );
});

Deno.test("RuntimeAgentTerminalWorkProjector projects failed runtime-agent result onto Deployment activation envelope status", async () => {
  const deploymentStore = new InMemoryDeploymentStore();
  const deployments = new DeploymentService({
    store: deploymentStore,
    idFactory: () => "deployment_1",
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
  });
  const resolved = await deployments.resolveDeployment({
    spaceId: "space_1",
    manifest: simpleManifest(),
  });
  const objectAddress = resolved.desired.activation_envelope.primary_assignment
    .componentAddress;
  const projector = new RuntimeAgentTerminalWorkProjector({
    deploymentStore,
  });

  const result = await projector.fail(workItem({
    status: "failed",
    failedAt: "2026-04-30T00:02:00.000Z",
    failureReason: "agent reported provider rejection",
    metadata: {
      deploymentId: resolved.id,
      objectAddress,
    },
    result: {
      deploymentStatus: "failed",
      reason: "ProviderRejected",
      message: "runtime provider rejected activation envelope",
    },
  }));

  assert.equal(result.deployment?.status, "failed");
  assert.equal(result.deployment?.finalized_at, "2026-04-30T00:02:00.000Z");
  assert.ok(
    result.deployment?.conditions.some((condition) =>
      condition.type === "RuntimeAgentWorkFailed" &&
      condition.status === "false" &&
      condition.reason === "ProviderRejected" &&
      condition.scope?.kind === "operation" &&
      condition.scope.ref === objectAddress
    ),
  );
});

function providerPlan(): ProviderMaterializationPlan {
  const operation: ProviderOperation = {
    id: "provider_op_1",
    kind: "runtime.deploy",
    provider: "aws",
    desiredStateId: "desired_1",
    targetId: "workload_web",
    targetName: "web",
    command: [],
    details: {},
    recordedAt: "2026-04-30T00:00:00.000Z",
  };
  return {
    id: "provider_plan_1",
    provider: "aws",
    desiredStateId: "desired_1",
    recordedAt: "2026-04-30T00:00:00.000Z",
    operations: [operation],
  };
}

function workItem(
  input:
    & Pick<RuntimeAgentWorkItem, "status">
    & Partial<RuntimeAgentWorkItem>,
): RuntimeAgentWorkItem {
  return {
    id: "work_1",
    kind: "provider.aws.runtime.deploy",
    status: input.status,
    payload: {},
    provider: "aws",
    priority: 0,
    queuedAt: "2026-04-30T00:00:00.000Z",
    attempts: 1,
    metadata: input.metadata ?? {},
    completedAt: input.completedAt,
    failedAt: input.failedAt,
    failureReason: input.failureReason,
    result: input.result,
  };
}

function simpleManifest(): PublicDeployManifest {
  return {
    name: "smoke-app",
    version: "1.0.0",
    compute: {
      web: {
        type: "container",
        image:
          "registry.example.test/smoke-app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        port: 8080,
      },
    },
    routes: {
      http: { target: "web", host: "smoke.example.test", path: "/" },
    },
  };
}
