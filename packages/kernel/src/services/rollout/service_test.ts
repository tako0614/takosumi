// Rollout canary service tests — Deployment-centric.
//
// Each canary step drives a Deployment through the canonical
// `DeploymentService` lifecycle. These tests exercise the rollout
// service against a stub `RolloutDeploymentClient` so the service can
// be validated independently of Agent A's full deployment pipeline.

import assert from "node:assert/strict";
import {
  buildHttpWeightedAssignmentModel,
  buildSideEffectPolicyReport,
  type RolloutApplyOutcome,
  RolloutCanaryService,
  type RolloutDeploymentClient,
  type RolloutResolveInput,
} from "./mod.ts";
import type { PublicDeployManifest } from "../../domains/deploy/types.ts";
import type { Deployment, GroupHead } from "takosumi-contract";

Deno.test("buildHttpWeightedAssignmentModel splits primary/canary weights for HTTP routes", () => {
  const model = buildHttpWeightedAssignmentModel({
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    step: {
      id: "10",
      canaryAppReleaseId: "release_canary",
      canaryWeightPermille: 100,
    },
  });

  assert.deepEqual(model.routes.map((route) => route.routeName), ["web"]);
  assert.deepEqual(model.routes[0].assignments, [
    { appReleaseId: "release_primary", weightPermille: 900 },
    { appReleaseId: "release_canary", weightPermille: 100 },
  ]);
  assert.equal(
    model.nonHttpDefaults.events.defaultAppReleaseId,
    "release_primary",
  );
  assert.equal(
    model.nonHttpDefaults.publications.defaultAppReleaseId,
    "release_primary",
  );
  assert.equal(model.nonHttpDefaults.events.reason, "http-only-canary");
  assert.equal(model.nonHttpDefaults.publications.reason, "http-only-canary");
});

Deno.test("buildHttpWeightedAssignmentModel rejects out-of-range canary weights", () => {
  assert.throws(
    () =>
      buildHttpWeightedAssignmentModel({
        manifest: sampleManifest(),
        primaryAppReleaseId: "release_primary",
        step: {
          id: "1",
          canaryAppReleaseId: "release_canary",
          canaryWeightPermille: 1500,
        },
      }),
    RangeError,
  );
});

Deno.test("buildSideEffectPolicyReport pins non-HTTP surfaces to the primary release", () => {
  const report = buildSideEffectPolicyReport();
  assert.equal(report.status, "passed");
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].id, "non_http_side_effects");
  assert.equal(
    report.checks[0].enforcementPoint,
    "rollout.assignment.nonHttpDefaults",
  );
});

Deno.test("RolloutCanaryService runs each canary step as a distinct Deployment", async () => {
  const stub = new StubDeploymentClient();
  const service = new RolloutCanaryService({
    deploymentService: stub,
    idFactory: sequenceIds(["run_1"]),
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });

  const run = await service.run({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    steps: [
      {
        id: "10",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 100,
      },
      {
        id: "50",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 500,
      },
    ],
  });

  assert.equal(run.status, "succeeded");
  assert.equal(run.steps.length, 2);
  assert.deepEqual(
    run.steps.map((step) => step.status),
    ["applied", "applied"],
  );
  assert.equal(run.deployments.length, 2);
  assert.deepEqual(run.deployments.map((d) => d.id), [
    stub.resolveCalls[0].deploymentId,
    stub.resolveCalls[1].deploymentId,
  ]);
  assert.equal(stub.resolveCalls.length, 2);
  assert.equal(stub.applyCalls.length, 2);
  assert.equal(run.assignmentModel.kind, "http_weighted");
});

Deno.test("RolloutCanaryService stops on first failed step and marks run failed", async () => {
  const stub = new StubDeploymentClient({ failOnIndex: 1 });
  const service = new RolloutCanaryService({
    deploymentService: stub,
    idFactory: sequenceIds(["run_2"]),
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });

  const run = await service.run({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    steps: [
      {
        id: "10",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 100,
      },
      {
        id: "50",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 500,
      },
      {
        id: "100",
        canaryAppReleaseId: "release_canary",
        canaryWeightPermille: 1000,
      },
    ],
  });

  assert.equal(run.status, "failed");
  assert.deepEqual(run.steps.map((step) => step.status), ["applied", "failed"]);
  assert.equal(run.deployments.length, 1);
  assert.match(run.steps[1].error ?? "", /injected/);
});

class StubDeploymentClient implements RolloutDeploymentClient {
  readonly resolveCalls: Array<RolloutResolveInput & { deploymentId: string }> =
    [];
  readonly applyCalls: string[] = [];
  #counter = 0;
  readonly #failOnIndex: number | undefined;

  constructor(options: { failOnIndex?: number } = {}) {
    this.#failOnIndex = options.failOnIndex;
  }

  resolveDeployment(input: RolloutResolveInput): Promise<Deployment> {
    const index = this.#counter++;
    if (this.#failOnIndex !== undefined && index === this.#failOnIndex) {
      return Promise.reject(new Error("injected resolveDeployment failure"));
    }
    const id = input.deploymentId ?? `deployment_${index}`;
    this.resolveCalls.push({ ...input, deploymentId: id });
    return Promise.resolve(deployment(id, input.spaceId, input.groupId));
  }

  applyDeployment(deploymentId: string): Promise<RolloutApplyOutcome> {
    this.applyCalls.push(deploymentId);
    return Promise.resolve({
      deployment: deployment(deploymentId, "space_a", "demo-app", "applied"),
      groupHead: groupHead("demo-app", deploymentId),
    });
  }
}

function deployment(
  id: string,
  spaceId: string,
  groupId: string | undefined,
  status: "resolved" | "applied" = "resolved",
): Deployment {
  return {
    id,
    group_id: groupId ?? "demo-app",
    space_id: spaceId,
    input: {
      manifest_snapshot: "sha256:stub",
      source_kind: "inline",
    },
    resolution: {
      descriptor_closure: {
        resolutions: [],
        dependencies: [],
        closureDigest: "sha256:empty",
        createdAt: "2026-04-30T00:00:00.000Z",
      },
      resolved_graph: {
        digest: "sha256:empty",
        components: [],
        projections: [],
      },
    },
    desired: {
      routes: [],
      bindings: [],
      resources: [],
      runtime_network_policy: {
        policyDigest: "sha256:empty",
        defaultEgress: "deny-by-default",
      },
      activation_envelope: {
        primary_assignment: {
          componentAddress: "component:web",
          weight: 1000,
        },
        envelopeDigest: "sha256:empty",
      },
    },
    status,
    conditions: [],
    policy_decisions: [],
    approval: null,
    rollback_target: null,
    created_at: "2026-04-30T00:00:00.000Z",
    applied_at: status === "applied" ? "2026-04-30T00:00:00.000Z" : null,
    finalized_at: status === "applied" ? "2026-04-30T00:00:00.000Z" : null,
  };
}

function groupHead(groupId: string, currentId: string): GroupHead {
  return {
    space_id: "space_rollout",
    group_id: groupId,
    current_deployment_id: currentId,
    previous_deployment_id: null,
    generation: 1,
    advanced_at: "2026-04-30T00:00:00.000Z",
  };
}

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
      },
    },
    routes: {
      web: {
        target: "web",
        protocol: "https",
        host: "demo.example.test",
        path: "/",
      },
      events: { target: "web", protocol: "event" },
    },
    publications: {
      updates: {
        type: "publication.topic@v1",
        from: "web",
        outputs: { event: { routeRef: "events" } },
      },
    },
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? crypto.randomUUID();
}
