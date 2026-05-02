// Deploy orchestrator tests — Deployment-centric.
//
// Phase 3 Agent B migrated this orchestrator onto the Deployment shape.
// These tests exercise the public surface (DeploymentOrchestrator,
// DeploymentPhaseBlockedError, DeploymentPhaseBoundaryCheck) against a stub
// `OrchestratorDeploymentClient` so we can validate phase-boundary sequencing
// without depending on Agent A's full DeploymentService.

import assert from "node:assert/strict";
import {
  type DeploymentOrchestrationResult,
  DeploymentOrchestrator,
  DeploymentPhaseBlockedError,
  type DeploymentPhaseBlocker,
  type DeploymentPhaseBoundaryCheck,
  type OrchestratorDeploymentClient,
  type OrchestratorResolveInput,
} from "./mod.ts";
import type { Deployment, GroupHead } from "takosumi-contract";
import type { PublicDeployManifest } from "../../domains/deploy/types.ts";

Deno.test("DeploymentPhaseBlockedError preserves blocker codes for caller surfacing", () => {
  const blockers: readonly DeploymentPhaseBlocker[] = [
    {
      phase: "resolve",
      source: "registry-trust",
      code: "trust-record-revoked",
      message: "Trust record revoked",
    },
    {
      phase: "apply",
      source: "approval",
      code: "manual-approval-required",
      message: "Manual approval required",
    },
  ];
  const error = new DeploymentPhaseBlockedError(blockers);
  assert.equal(error.name, "DeploymentPhaseBlockedError");
  assert.deepEqual(
    error.blockers.map((blocker) => [blocker.phase, blocker.code]),
    [
      ["resolve", "trust-record-revoked"],
      ["apply", "manual-approval-required"],
    ],
  );
});

Deno.test("DeploymentPhaseBoundaryCheck shape matches the documented orchestrator surface", () => {
  // Compile-time only: ensures the public type stays usable as an input.
  const check: DeploymentPhaseBoundaryCheck = {
    phase: "apply",
    source: "migration",
    subject: "resource:db",
    check: () => ({
      phase: "apply",
      source: "migration",
      code: "migration-checksum-changed",
      message: "Applied migration checksum changed",
    }),
  };
  assert.equal(check.phase, "apply");
});

Deno.test("DeploymentOrchestrator drives a clean Deployment through resolve + apply", async () => {
  const client = new StubOrchestratorClient();
  const orchestrator = new DeploymentOrchestrator({
    deploymentService: client,
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
  });

  const result = await orchestrator.orchestrate({
    spaceId: "space_a",
    manifest: sampleManifest(),
    groupId: "demo-app",
  });

  assert.equal(result.deployment.status, "applied");
  assert.equal(result.groupHead.current_deployment_id, result.deployment.id);
  assert.equal(client.resolveCalls.length, 1);
  assert.equal(client.applyCalls.length, 1);
});

Deno.test("DeploymentOrchestrator raises DeploymentPhaseBlockedError before resolving when pre-resolve blockers exist", async () => {
  const client = new StubOrchestratorClient();
  const orchestrator = new DeploymentOrchestrator({
    deploymentService: client,
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
  });

  await assert.rejects(
    () =>
      orchestrator.orchestrate({
        spaceId: "space_a",
        manifest: sampleManifest(),
        phaseBlockers: [{
          phase: "resolve",
          source: "registry-trust",
          code: "trust-record-revoked",
          message: "Trust revoked",
        }],
      }),
    (error) => {
      assert.ok(error instanceof DeploymentPhaseBlockedError);
      assert.equal(error.blockers[0].code, "trust-record-revoked");
      return true;
    },
  );
  assert.equal(client.resolveCalls.length, 0);
  assert.equal(client.applyCalls.length, 0);
});

Deno.test("DeploymentOrchestrator raises DeploymentPhaseBlockedError after resolve when apply blockers exist", async () => {
  const client = new StubOrchestratorClient();
  const orchestrator = new DeploymentOrchestrator({
    deploymentService: client,
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
  });

  await assert.rejects(
    () =>
      orchestrator.orchestrate({
        spaceId: "space_a",
        manifest: sampleManifest(),
        approvalDecision: {
          allowed: false,
          operation: "deploy.apply",
          reason: "manual approval required",
          subjectDigest: "sha256:approval",
        },
      }),
    (error) => {
      assert.ok(error instanceof DeploymentPhaseBlockedError);
      assert.equal(error.blockers[0].phase, "apply");
      return true;
    },
  );
  // Resolve was attempted but apply was not.
  assert.equal(client.resolveCalls.length, 1);
  assert.equal(client.applyCalls.length, 0);
});

Deno.test("DeploymentOrchestrator surfaces phase boundary checks raised by callers", async () => {
  const client = new StubOrchestratorClient();
  const orchestrator = new DeploymentOrchestrator({
    deploymentService: client,
    clock: () => new Date("2026-04-30T00:00:00.000Z"),
  });

  await assert.rejects(
    () =>
      orchestrator.orchestrate({
        spaceId: "space_a",
        manifest: sampleManifest(),
        phaseBoundaryChecks: [{
          phase: "apply",
          source: "migration",
          subject: "resource:db",
          code: "migration-checksum-changed",
          check: () => ({
            phase: "apply",
            source: "migration",
            code: "migration-checksum-changed",
            message: "Applied migration checksum changed",
          }),
        }],
      }),
    (error) => {
      assert.ok(error instanceof DeploymentPhaseBlockedError);
      assert.equal(error.blockers[0].code, "migration-checksum-changed");
      return true;
    },
  );
});

class StubOrchestratorClient implements OrchestratorDeploymentClient {
  readonly resolveCalls: OrchestratorResolveInput[] = [];
  readonly applyCalls: string[] = [];
  #counter = 0;

  resolveDeployment(input: OrchestratorResolveInput): Promise<Deployment> {
    this.resolveCalls.push(input);
    const id = input.deploymentId ?? `deploy_${this.#counter++}`;
    return Promise.resolve(makeDeployment(id, input.spaceId, input.groupId));
  }

  applyDeployment(
    deploymentId: string,
  ): Promise<DeploymentOrchestrationResult> {
    this.applyCalls.push(deploymentId);
    const deployment = makeDeployment(
      deploymentId,
      "space_a",
      "demo-app",
      "applied",
    );
    const groupHead: GroupHead = {
      space_id: "space_a",
      group_id: "demo-app",
      current_deployment_id: deploymentId,
      previous_deployment_id: null,
      generation: 1,
      advanced_at: "2026-04-30T00:00:00.000Z",
    };
    return Promise.resolve({ deployment, groupHead });
  }
}

function makeDeployment(
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
  };
}
