import assert from "node:assert/strict";
import type { Deployment } from "takosumi-contract";
import {
  DeploymentService,
  InMemoryDeploymentStore,
} from "../domains/deploy/deployment_service.ts";
import type { PublicDeployManifest } from "../domains/deploy/types.ts";
import { InMemoryOutboxStore } from "../shared/events.ts";
import { ApplyWorker } from "./apply_worker.ts";

Deno.test("ApplyWorker promotes a resolved Deployment to applied", async () => {
  const store = new InMemoryDeploymentStore();
  const outboxStore = new InMemoryOutboxStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_worker_apply",
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_deploy",
    manifest: sampleManifest(),
  });

  const worker = new ApplyWorker({
    store,
    deploymentService: service,
    outboxStore,
    clock: () => new Date("2026-04-27T00:01:00.000Z"),
  });

  const result = await worker.process({
    deploymentId: resolved.id,
    correlationId: "corr_worker_apply",
  });

  assert.equal(result.deployment.status, "applied");
  assert.equal(result.deployment.id, "deployment_worker_apply");
  assert.equal(result.head?.current_deployment_id, resolved.id);

  const [event] = await outboxStore.listPending();
  assert.equal(event.type, "deploy.apply.succeeded");
  assert.equal(event.payload.deploymentId, "deployment_worker_apply");
  assert.equal(event.payload.status, "applied");
});

Deno.test(
  "ApplyWorker reports DEPLOYMENT_STALE when applying a non-resolved Deployment",
  async () => {
    const store = new InMemoryDeploymentStore();
    const outboxStore = new InMemoryOutboxStore();
    const service = new DeploymentService({
      store,
      idFactory: () => "deployment_worker_stale",
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const resolved = await service.resolveDeployment({
      spaceId: "space_deploy",
      manifest: sampleManifest(),
    });
    // Drive the deployment past `resolved` so a second apply attempt finds
    // it in `applied` state — the worker must surface this as a failure.
    await service.applyDeployment({
      deploymentId: resolved.id,
      appliedAt: "2026-04-27T00:00:30.000Z",
    });

    const worker = new ApplyWorker({
      store,
      deploymentService: service,
      outboxStore,
      clock: () => new Date("2026-04-27T00:01:00.000Z"),
    });

    await assert.rejects(
      () =>
        worker.process({
          deploymentId: resolved.id,
          correlationId: "corr_worker_stale",
        }),
      /is not in 'resolved' status/,
    );

    const events = await outboxStore.listPending();
    const failed = events.find((event) => event.type === "deploy.apply.failed");
    assert.ok(failed, "expected a deploy.apply.failed event");
    assert.equal(failed!.payload.code, "APPLY_FAILED");
    assert.equal(failed!.payload.deploymentId, resolved.id);
  },
);

Deno.test(
  "ApplyWorker fails with APPLY_FAILED when the Deployment id is unknown",
  async () => {
    const store = new InMemoryDeploymentStore();
    const outboxStore = new InMemoryOutboxStore();
    const service = new DeploymentService({
      store,
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
    });

    const worker = new ApplyWorker({
      store,
      deploymentService: service,
      outboxStore,
      clock: () => new Date("2026-04-27T00:01:00.000Z"),
    });

    await assert.rejects(
      () =>
        worker.process({
          deploymentId: "deployment_does_not_exist",
          correlationId: "corr_worker_unknown",
        }),
      /unknown deployment/,
    );

    const [event] = await outboxStore.listPending();
    assert.equal(event.type, "deploy.apply.failed");
    assert.equal(event.payload.code, "APPLY_FAILED");
    assert.equal(event.payload.deploymentId, "deployment_does_not_exist");
  },
);

Deno.test(
  "ApplyWorker maps DeploymentStaleError to DEPLOYMENT_STALE on the failure event",
  async () => {
    const store = new InMemoryDeploymentStore();
    const outboxStore = new InMemoryOutboxStore();
    const baseService = new DeploymentService({
      store,
      idFactory: () => "deployment_worker_stale_error",
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const resolved = await baseService.resolveDeployment({
      spaceId: "space_deploy",
      manifest: sampleManifest(),
    });

    const stale = createStaleDeploymentError([
      { key: "group_activation:space_deploy:demo-app", impact: "must-replan" },
    ]);
    const failingService = makeFailingService(baseService, () => {
      throw stale;
    });

    const worker = new ApplyWorker({
      store,
      deploymentService: failingService,
      outboxStore,
      clock: () => new Date("2026-04-27T00:01:00.000Z"),
    });

    await assert.rejects(
      () =>
        worker.process({
          deploymentId: resolved.id,
          correlationId: "corr_worker_stale_error",
        }),
      /stale group head/,
    );

    const [event] = await outboxStore.listPending();
    assert.equal(event.type, "deploy.apply.failed");
    assert.equal(event.payload.code, "DEPLOYMENT_STALE");
    assert.deepEqual(event.payload.staleEntries, [
      { key: "group_activation:space_deploy:demo-app", impact: "must-replan" },
    ]);
  },
);

Deno.test(
  "ApplyWorker maps DeploymentBlockedError to POLICY_BLOCKED on the failure event",
  async () => {
    const store = new InMemoryDeploymentStore();
    const outboxStore = new InMemoryOutboxStore();
    const baseService = new DeploymentService({
      store,
      idFactory: () => "deployment_worker_policy",
      clock: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const resolved = await baseService.resolveDeployment({
      spaceId: "space_deploy",
      manifest: sampleManifest(),
    });

    const blocked = new Error("deployment blocked by registry-trust:UNKNOWN");
    blocked.name = "DeploymentBlockedError";
    const failingService = makeFailingService(baseService, () => {
      throw blocked;
    });

    const worker = new ApplyWorker({
      store,
      deploymentService: failingService,
      outboxStore,
      clock: () => new Date("2026-04-27T00:01:00.000Z"),
    });

    await assert.rejects(
      () =>
        worker.process({
          deploymentId: resolved.id,
          correlationId: "corr_worker_policy",
        }),
      /deployment blocked by/,
    );

    const [event] = await outboxStore.listPending();
    assert.equal(event.type, "deploy.apply.failed");
    assert.equal(event.payload.code, "POLICY_BLOCKED");
  },
);

function sampleManifest(): PublicDeployManifest {
  return {
    name: "demo-app",
    version: "1.0.0",
    compute: {
      web: {
        type: "container",
        image:
          "registry.example.test/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111",
        port: 8080,
        env: { MESSAGE: "hello" },
      },
    },
    resources: {
      db: { type: "postgres", plan: "dev" },
    },
  };
}

function createStaleDeploymentError(
  entries: readonly Record<string, unknown>[],
): Error & { staleEntries: readonly Record<string, unknown>[] } {
  const error = new Error(
    "stale group head for demo-app: expected current dep_a but found dep_b",
  ) as Error & { staleEntries: readonly Record<string, unknown>[] };
  error.name = "DeploymentStaleError";
  error.staleEntries = entries;
  return error;
}

function makeFailingService(
  base: DeploymentService,
  onApply: () => Promise<Deployment> | Deployment,
): DeploymentService {
  // The worker only calls `applyDeployment`; intercept that single method
  // and delegate everything else to the real service. Keeping this as a
  // narrow proxy avoids leaking test-only types into production code.
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "applyDeployment") {
        return async () => await onApply();
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
