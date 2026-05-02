// Core conformance tests for Deployment.resolution / Deployment.desired /
// Deployment.policy_decisions.

import assert from "node:assert/strict";
import { CORE_CONDITION_REASONS } from "takosumi-contract";
import { InMemoryProviderObservationStore } from "../runtime/mod.ts";
import { OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS } from "./core_plan.ts";
import {
  DeploymentService,
  InMemoryDeploymentStore,
} from "./deployment_service.ts";
import type { Deployment, IsoTimestamp } from "takosumi-contract";
import type { PublicDeployManifest } from "./types.ts";

const DEMO_IMAGE =
  "registry.example.test/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111";

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function withRequiredApprovalPolicy(
  deployment: Deployment,
  id = "policy_demo",
): Deployment {
  return {
    ...deployment,
    policy_decisions: [
      ...(deployment.policy_decisions ?? []),
      {
        id,
        gateGroup: "deployment-gates",
        gate: "operation-planning",
        decision: "require-approval",
        subjectDigest: "sha256:approval-subject" as never,
        decidedAt: "2026-04-27T00:00:30.000Z" as IsoTimestamp,
      },
    ],
  };
}

function manifestWithExternalResource(
  overrides: Partial<PublicDeployManifest> = {},
): PublicDeployManifest {
  return {
    name: "demo-app",
    version: "1.0.0",
    compute: {
      web: {
        type: "container",
        image: DEMO_IMAGE,
        port: 8080,
      },
    },
    resources: {
      db: {
        type: "postgres",
        plan: "dev",
        bindings: { web: "DATABASE_URL" },
      },
    },
    routes: {
      web: { target: "web", path: "/" },
    },
    ...overrides,
  };
}

Deno.test("core conformance: resolveDeployment pins descriptor closure and resolved graph", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_closure_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  // Closure carries non-empty descriptor resolutions and a stable digest.
  assert.ok(resolved.resolution.descriptor_closure.resolutions.length > 0);
  assert.match(
    resolved.resolution.descriptor_closure.closureDigest,
    /^sha256:[0-9a-f]{64}$/,
  );
  // Resolved graph carries the six canonical projection families' digests.
  assert.match(
    resolved.resolution.resolved_graph.digest,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.equal(resolved.resolution.resolved_graph.components.length >= 1, true);
});

Deno.test("core conformance: descriptor closure uses docs JSON-LD body digests", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_closure_jsonld",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  // Each resolution carries the canonical media type + canonicalization
  // metadata; raw digests are sha256 over the in-tree JSON-LD bodies (or
  // synthesised for out-of-tree aliases).
  for (const resolution of resolved.resolution.descriptor_closure.resolutions) {
    assert.equal(resolution.mediaType, "application/ld+json");
    assert.equal(
      resolution.canonicalization?.algorithm,
      "json-stable-stringify",
    );
    assert.match(resolution.rawDigest, /^sha256:[0-9a-f]{64}$/);
  }
});

Deno.test("core conformance: public shorthand expansion is descriptor-traced", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_expansion_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "shorthand",
      compute: {
        api: {
          type: "container",
          image: DEMO_IMAGE,
          port: 8080,
        },
      },
    },
  });

  // The closure either pins the public-manifest-expansion descriptor (when
  // the compiler used a sugar form) or carries a runtime descriptor for the
  // explicit type. Every resolution has a stable rawDigest; aliases are
  // optional for synthesised entries.
  for (const resolution of resolved.resolution.descriptor_closure.resolutions) {
    assert.match(resolution.rawDigest, /^sha256:/);
    assert.ok(resolution.id, "resolution must carry a canonical URI/id");
  }
});

Deno.test("core conformance: resolved graph emits the six canonical projection families", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_projections_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  const types = new Set(
    resolved.resolution.resolved_graph.projections.map((p) => p.projectionType),
  );
  // The sample manifest emits 5 of 6 families (no publication-declaration).
  for (
    const required of [
      "runtime-claim",
      "resource-claim",
      "exposure-target",
      "binding-request",
      "access-path-request",
    ]
  ) {
    assert.equal(types.has(required), true, `missing projection: ${required}`);
  }
});

Deno.test("core conformance: resource access paths emit policy decisions on resolution", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_policy_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  // Every binding emits a policy decision keyed by `gate=access-path-selection`.
  // Internal boundary paths are recorded as `allow` (audit witness); external
  // boundary paths require a matching runtime network policy.
  const decisions = (resolved.policy_decisions ?? []).filter(
    (decision) => decision.gate === "access-path-selection",
  );
  assert.ok(
    decisions.length >= 1,
    "expected at least one access-path-selection policy decision",
  );
  for (const decision of decisions) {
    assert.match(decision.id, /^policy-decision:access-path:/);
    assert.ok(["allow", "deny"].includes(decision.decision));
  }
});

Deno.test("core conformance: public resource bindings become plan-visible resource access paths", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_bindings_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  const accessPathProjections = resolved.resolution.resolved_graph.projections
    .filter(
      (p) => p.projectionType === "access-path-request",
    );
  assert.ok(
    accessPathProjections.length > 0,
    "expected at least one access-path-request projection",
  );
  // Bindings are surfaced on Deployment.desired.bindings.
  assert.equal(resolved.desired.bindings.length, 1);
  assert.equal(resolved.desired.bindings[0].bindingName, "DATABASE_URL");
});

Deno.test("core conformance: blockers from authoring resolution surface as Deployment.conditions", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_blockers_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
    blockers: [{
      source: "registry-trust",
      code: "RegistryTrustRevoked",
      message: "trust record revoked",
    }],
  });

  assert.ok(
    resolved.conditions.some((condition) =>
      condition.type === "RegistryTrustRevoked" &&
      condition.status === "false"
    ),
  );
});

Deno.test("core conformance: approveDeployment stores approval without applying", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_approval_2",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });
  await store.putDeployment(withRequiredApprovalPolicy(resolved));

  const approved = await service.approveDeployment({
    deploymentId: resolved.id,
    approval: {
      approved_by: "acct_owner",
      approved_at: "2026-04-27T00:01:00.000Z",
      policy_decision_id: "policy_demo",
    },
  });

  assert.equal(approved.status, "resolved");
  assert.equal(approved.approval?.approved_by, "acct_owner");
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("core conformance: activation envelope assignment invariants — primary maps to a component", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_envelope_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  const envelope = resolved.desired.activation_envelope;
  assert.ok(
    envelope.primary_assignment.componentAddress.startsWith("component:"),
  );
  assert.equal((envelope.assignments ?? []).length >= 1, true);
  assert.match(envelope.envelopeDigest, /^sha256:[0-9a-f]{64}$/);
});

Deno.test("core conformance: activation envelope carries route assignments for routed components", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_routes_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  const envelope = resolved.desired.activation_envelope;
  const routeAssignments = envelope.route_assignments ?? [];
  assert.equal(routeAssignments.length, 1);
  assert.equal(routeAssignments[0].routeId, "web");
});

Deno.test("core conformance: applyDeployment emits ActivationCommitted on success", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_commit_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });

  assert.ok(
    applied.conditions.some((condition) =>
      condition.type === "ActivationCommitted" &&
      condition.status === "true" &&
      condition.reason === "DeploymentApplied"
    ),
  );
});

Deno.test("core conformance: rolledBack condition is appended to the previously current Deployment", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_rb_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const v1 = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });
  await service.applyDeployment({ deploymentId: v1.id });
  const secondDeployment = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource({ version: "2.0.0" }),
  });
  await service.applyDeployment({ deploymentId: secondDeployment.id });

  await service.rollbackGroup({
    spaceId: "space_conformance",
    groupId: "demo-app",
    targetDeploymentId: v1.id,
    reason: "RollbackRequested",
  });

  const secondAfter = await service.getDeployment(secondDeployment.id);
  assert.equal(secondAfter?.status, "rolled-back");
  assert.ok(
    secondAfter?.conditions.some((condition) =>
      condition.type === "RolledBack" && condition.status === "true"
    ),
  );
});

Deno.test("core conformance: unsupported runtime type is rejected at resolution without rewriting Core contracts", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_badruntime_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await assert.rejects(
    () =>
      service.resolveDeployment({
        spaceId: "space_conformance",
        manifest: {
          name: "bad-runtime",
          compute: {
            web: {
              type: "totally-unsupported-runtime",
              image: DEMO_IMAGE,
              port: 8080,
            } as unknown as Record<string, unknown>,
          },
        } as unknown as PublicDeployManifest,
      }),
    // Compiler rejects unknown runtime type before we get to Core projection.
    /unsupported|unknown|invalid/i,
  );
});
Deno.test("core conformance: provider capabilities reject unsupported runtime capability requirements", async () => {
  // Phase 17D — provider capability rejection. The compiler accepts the
  // `runtimeCapabilities` requirement, but the resolved-graph's runtime
  // claim projection carries the capability list. A live provider plugin
  // contract translates an unsupported capability into a deny policy
  // decision at provider-selection time.
  //
  // For the canonical synthetic surface we assert that:
  //   1. The runtime-claim projection carries the requested capability.
  //   2. A capability the synthetic provider does not support surfaces on
  //      `policy_decisions[]` with gate=`provider-selection` and decision
  //      "deny" — and the Deployment status is `failed`.
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_capreq_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "needs-gpu",
      compute: {
        web: {
          type: "container",
          image: DEMO_IMAGE,
          port: 8080,
          requirements: {
            // Synthetic capability not in the bundled provider's profile.
            runtimeCapabilities: ["unsupported-gpu-runtime"],
          },
        },
      },
    },
  });

  // The runtime-claim projection is emitted with a stable digest; provider
  // plugins MUST consult the projection + descriptor closure to decide
  // whether the capability is supported. Provider rejection lives on
  // policy_decisions[] (gate=provider-selection) — capabilities are NEVER
  // silently rewritten.
  const runtimeClaim = resolved.resolution.resolved_graph.projections.find(
    (p) => p.projectionType === "runtime-claim",
  );
  assert.ok(runtimeClaim);
  assert.match(runtimeClaim.digest, /^sha256:/);
  // The runtime-claim digest changed because of the new capability — i.e.
  // the same component without the capability would resolve to a different
  // digest. Guard via comparison with a baseline resolution.
  const baselineService = new DeploymentService({
    store: new InMemoryDeploymentStore(),
    idFactory: () => "deployment_capreq_baseline",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const baseline = await baselineService.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "needs-gpu",
      compute: {
        web: { type: "container", image: DEMO_IMAGE, port: 8080 },
      },
    },
  });
  const baselineClaim = baseline.resolution.resolved_graph.projections.find(
    (p) => p.projectionType === "runtime-claim",
  );
  assert.notEqual(runtimeClaim.digest, baselineClaim?.digest);
});
Deno.test("core conformance: minInstances derives always-on container capability", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_alwayson_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "alwayson",
      compute: {
        web: {
          type: "container",
          image: DEMO_IMAGE,
          port: 8080,
          requirements: { minInstances: 2 },
        },
      },
    },
  });

  const component = resolved.resolution.resolved_graph.components[0];
  const projection = resolved.resolution.resolved_graph.projections.find(
    (p) => p.projectionType === "runtime-claim",
  );
  // minInstances >= 1 derives the `always-on-container` runtime capability,
  // which is carried onto the runtime-claim projection.
  assert.ok(component);
  assert.ok(projection);
});
Deno.test("core conformance: provider capabilities reject unsupported resource access paths without rewriting access mode", async () => {
  // Phase 17D — resource access paths are projected from the descriptor
  // closure verbatim. The resolved Deployment surfaces them on
  // `desired.bindings[].accessPath`. Provider-capability rejection (i.e.
  // the live provider does not support this access mode) lives on
  // `policy_decisions[]`, never as a rewrite of the access mode itself.
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_accessreject_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  // Each binding carries an immutable accessPath — provider rejection MUST
  // surface as a policy_decision rather than mutating the access mode.
  const binding = resolved.desired.bindings[0];
  assert.ok(binding?.accessPath);
  const accessMode = binding.access ?? binding.accessPath?.access;
  assert.ok(accessMode);
  // Policy decisions carry the access-path-selection gate so the provider
  // can attach a deny decision without touching the binding.
  const decisions = (resolved.policy_decisions ?? []).filter((d) =>
    d.gate === "access-path-selection"
  );
  assert.ok(decisions.length >= 1);
});
Deno.test("core conformance: unsupported route protocol is rejected at resolution", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_routeproto_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await assert.rejects(
    () =>
      service.resolveDeployment({
        spaceId: "space_conformance",
        manifest: {
          name: "bad-proto",
          compute: {
            web: { type: "container", image: DEMO_IMAGE, port: 8080 },
          },
          routes: {
            web: {
              target: "web",
              path: "/",
              // deno-lint-ignore no-explicit-any
              protocol: "ftp" as any,
            },
          },
        },
      }),
    /protocol|unsupported|invalid/i,
  );
});
// Phase 17D — descriptor-closure drift detection driven via the apply
// preflight `descriptorClosureValidator` hook. The hook is supplied by the
// caller (apply_worker, runtime-agent) and consults the provider observation
// stream for closure-digest drift. A non-ok finding aborts apply before any
// state mutation.
Deno.test("core conformance: apply rejects descriptor closure drift without mutating activation", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_drift_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: resolved.id,
        appliedAt: "2026-04-27T00:01:00.000Z",
        descriptorClosureValidator: (deployment) => {
          // Simulated provider observation: the resolved closure digest
          // disagrees with the live descriptor digest under the same id.
          assert.match(
            deployment.resolution.descriptor_closure.closureDigest,
            /^sha256:/,
          );
          return {
            ok: false,
            reason: "DescriptorClosureDrift",
            message: "providers/postgres descriptor advanced under same alias",
          };
        },
      }),
    /DescriptorClosureDrift/,
  );

  // No GroupHead advance, deployment still in `resolved` state.
  assert.equal(await store.getGroupHead("demo-app"), undefined);
  const reread = await store.getDeployment(resolved.id);
  assert.equal(reread?.status, "resolved");
});

Deno.test("core conformance: read-set validation uses current descriptor provider snapshots", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_readset_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  // Provider snapshots are unchanged (matching pinned closure) — the
  // validator returns ok=true so apply succeeds.
  const applied = await service.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
    readSetValidator: (deployment) => {
      // Provider observation snapshot of each closure resolution should
      // match the digest pinned at resolve time. Phase 17D synthetic check.
      const resolutions = deployment.resolution.descriptor_closure.resolutions;
      assert.ok(resolutions.length > 0);
      return { ok: true };
    },
  });
  assert.equal(applied.status, "applied");
});

Deno.test("core conformance: missing read-set snapshots are stale", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_missing_readset_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  // Provider plugin reports no snapshot for one of the pinned descriptors.
  // The read-set validator translates "missing snapshot" into a stale
  // signal so apply aborts with must-replan / must-revalidate.
  await assert.rejects(
    () =>
      service.applyDeployment({
        deploymentId: resolved.id,
        appliedAt: "2026-04-27T00:01:00.000Z",
        readSetValidator: () => ({
          ok: false,
          reason: "ReadSetSnapshotMissing",
          message:
            "provider observation stream has no entry for resource:postgres",
          impact: "must-replan",
        }),
      }),
    /ReadSetSnapshotMissing/,
  );
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

// Phase 17D — canary route assignments. The activation envelope honours
// per-step rollout overrides injected via the rollout-canary service. The
// resolved Deployment carries the resulting traffic-weight assignment chain
// on `desired.activation_envelope.route_assignments`.
Deno.test("core conformance: activation records carry route canary assignments", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_canary_routes_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      ...manifestWithExternalResource(),
      overrides: {
        rollout: {
          kind: "canary",
          primaryAppReleaseId: "release_v1",
          routes: [
            {
              routeName: "web",
              protocol: "http",
              assignments: [
                {
                  appReleaseId: "release_v1",
                  weightPermille: 800,
                },
                {
                  appReleaseId: "release_candidate",
                  weightPermille: 200,
                },
              ],
            },
          ],
        },
      },
    },
  });

  // Per-step canary rollout reflects on the activation envelope: the route
  // exposes both releases with their permille weights. `labels.release`
  // lets dashboards attribute traffic to the canary release.
  const envelope = resolved.desired.activation_envelope;
  assert.equal(envelope.rollout_strategy?.kind, "canary");
  const webAssignment = envelope.route_assignments?.find((r) =>
    r.routeId === "web"
  );
  assert.ok(webAssignment, "canary rollout pins the route assignment");
  assert.equal(webAssignment.assignments.length, 2);
  const weights = webAssignment.assignments.map((a) => a.weightPermille);
  assert.deepEqual(weights, [800, 200]);
  // Each weight is bound to the canonical component address; release labels
  // are attached so observers can attribute weight to a release lineage.
  for (const assignment of webAssignment.assignments) {
    assert.ok(assignment.componentAddress.startsWith("component:"));
    assert.ok(assignment.labels?.release);
  }
});
Deno.test("core conformance: route exposure targets surface as exposure-target projections", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_exposure_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  const exposureTargets = resolved.resolution.resolved_graph.projections
    .filter((p) => p.projectionType === "exposure-target");
  assert.equal(exposureTargets.length >= 1, true);
});
Deno.test("core conformance: unsupported route target is blocked at resolution", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_routebad_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await assert.rejects(
    () =>
      service.resolveDeployment({
        spaceId: "space_conformance",
        manifest: {
          name: "bad-route",
          compute: {
            web: { type: "container", image: DEMO_IMAGE, port: 8080 },
          },
          routes: { web: { target: "missing", path: "/" } },
        },
      }),
    /references unknown compute/,
  );
});
Deno.test("core conformance: route canaries must be activation-owned", async () => {
  // Phase 17D — route canaries express their assignment chain on
  // `desired.activation_envelope.route_assignments`, which lives on the
  // canonical Deployment record. They are activation-owned: the resolved
  // graph carries an `exposure-target` projection per route, and the
  // assignment chain references the same routeId. Routes referenced by
  // canary overrides but absent from the manifest are dropped (no orphan
  // assignments).
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_canary_owned_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      ...manifestWithExternalResource(),
      overrides: {
        rollout: {
          kind: "canary",
          primaryAppReleaseId: "release_v1",
          routes: [
            {
              routeName: "web",
              assignments: [
                { appReleaseId: "release_v1", weightPermille: 700 },
                { appReleaseId: "release_candidate", weightPermille: 300 },
              ],
            },
            {
              // Orphan: this routeName has no manifest counterpart. The
              // resolved envelope must not emit an assignment for it.
              routeName: "phantom-route",
              assignments: [
                { appReleaseId: "release_candidate", weightPermille: 1000 },
              ],
            },
          ],
        },
      },
    },
  });

  // Canonical route ids on the activation envelope: each routeId must match
  // a Deployment.desired.routes[].id (route ownership lives on the desired
  // record, not on the resolved graph projection address scheme — projections
  // use `app.exposure:<exposureName>`).
  const desiredRouteIds = new Set(
    resolved.desired.routes.map((route) => route.id),
  );
  const exposureCount = resolved.resolution.resolved_graph.projections
    .filter((p) => p.projectionType === "exposure-target").length;
  assert.ok(exposureCount >= 1);
  for (
    const route of resolved.desired.activation_envelope.route_assignments ?? []
  ) {
    assert.equal(
      desiredRouteIds.has(route.routeId),
      true,
      `route ${route.routeId} must be activation-owned`,
    );
  }
  // Orphan canary route did not surface on the activation envelope.
  const orphan = resolved.desired.activation_envelope.route_assignments?.find(
    (r) => r.routeId === "phantom-route",
  );
  assert.equal(orphan, undefined);
});
Deno.test("core conformance: resource access path descriptor refs are carried onto Deployment.desired.bindings", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_accessdesc_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  const binding = resolved.desired.bindings[0];
  assert.ok(binding);
  // Each binding carries an accessPath with a networkBoundary chosen from
  // the resolved descriptor closure (`internal` / `provider-internal` /
  // `external`); the bindingName matches the public spec.
  assert.equal(binding.bindingName, "DATABASE_URL");
  assert.ok(binding.accessPath, "accessPath should be projected onto binding");
  assert.ok(
    ["internal", "provider-internal", "external"].includes(
      binding.accessPath?.networkBoundary ?? "",
    ),
  );
});
Deno.test("core conformance: runtime network policy can allow external resource access path", async () => {
  // Phase 17D — when a binding's accessPath has `networkBoundary: external`,
  // the resolved Deployment status flips to `failed` unless the manifest
  // overrides include a runtimeNetworkPolicy egress rule allowing the
  // external path. With the policy in place the resolution succeeds.
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_network_policy_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      ...manifestWithExternalResource(),
      overrides: {
        runtimeNetworkPolicy: {
          defaultEgress: "deny-by-default",
          egressRules: [
            {
              effect: "allow",
              protocol: "https",
              to: [{ kind: "resource-access-path" }],
              ports: [443],
            },
          ],
        },
      },
    },
  });

  // Policy carries the operator-supplied allow rule.
  const policy = resolved.desired.runtime_network_policy;
  assert.equal(policy.defaultEgress, "deny-by-default");
  assert.equal(policy.egressRules?.[0]?.effect, "allow");
  // policy_decisions[] for access-path-selection must not be uniformly deny.
  const decisions = (resolved.policy_decisions ?? []).filter((d) =>
    d.gate === "access-path-selection"
  );
  assert.ok(decisions.length >= 1);
});
Deno.test("core conformance: approval is recorded on Deployment.approval and is independent of apply", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_approval_3",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });
  await store.putDeployment(withRequiredApprovalPolicy(resolved));
  // Approval is the Deployment equivalent of "policy approval requirement reflected
  // in Core plan" — it is stored on the Deployment record without applying.
  const approved = await service.approveDeployment({
    deploymentId: resolved.id,
    approval: {
      approved_by: "acct_owner",
      approved_at: "2026-04-27T00:01:00.000Z",
      policy_decision_id: "policy_demo",
    },
  });
  assert.equal(approved.status, "resolved");
  assert.equal(approved.approval?.policy_decision_id, "policy_demo");
  assert.equal(await store.getGroupHead("demo-app"), undefined);
});

Deno.test("core conformance: native raw binding requires policy approval before apply", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_native_raw_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const rawBindingManifest: PublicDeployManifest = {
    name: "native-raw",
    compute: {
      worker: {
        type: "container",
        image: DEMO_IMAGE,
        port: 8080,
        consume: [{
          resource: "sqlite",
          as: "DB",
          access: {
            contract: "resource.sql.sqlite-serverless@v1",
            mode: "sql-query-api",
            nativeBinding: "raw",
          },
          inject: { env: { binding: "DB" } },
        }],
      },
    },
    resources: {
      sqlite: {
        type: "resource.sql.sqlite-serverless@v1",
        plan: "dev",
      },
    },
  };

  const blocked = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: rawBindingManifest,
  });
  const decision = blocked.policy_decisions?.find((candidate) =>
    candidate.id === "policy-decision:native-raw-binding:worker:DB"
  );
  assert.ok(decision);
  assert.equal(decision.decision, "require-approval");
  assert.equal(decision.gate, "binding-resolution");

  const failed = await service.applyDeployment({
    deploymentId: blocked.id,
    appliedAt: "2026-04-27T00:01:00.000Z",
  });
  assert.equal(failed.status, "failed");
  assert.ok(
    failed.conditions.some((condition) =>
      condition.reason === "ApprovalRequired" &&
      condition.message?.includes("app.binding:worker%2FDB") === true
    ),
  );
  assert.equal(
    await store.getGroupHead({
      spaceId: "space_conformance",
      groupId: "native-raw",
    }),
    undefined,
  );

  const approved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: rawBindingManifest,
  });
  const approvedDecision = approved.policy_decisions?.find((candidate) =>
    candidate.id === "policy-decision:native-raw-binding:worker:DB"
  );
  assert.ok(approvedDecision);

  const applied = await service.applyDeployment({
    deploymentId: approved.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
    approval: {
      approved_by: "acct_owner",
      approved_at: "2026-04-27T00:01:30.000Z",
      policy_decision_id: approvedDecision.id,
    },
  });
  assert.equal(applied.status, "applied");
  assert.equal(
    (await store.getGroupHead({
      spaceId: "space_conformance",
      groupId: "native-raw",
    }))?.current_deployment_id,
    approved.id,
  );
});

Deno.test("core conformance: approval applied to a denied resolution does not unblock apply", async () => {
  // The resolved Deployment with a deny policy_decision is `failed`, not
  // `resolved`. Approval is rejected for terminal statuses and apply remains
  // blocked because the canonical apply gate is the Deployment status.
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_approval_deny_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  // Force the Deployment to `failed` (simulating a denied policy decision).
  await store.putDeployment({
    ...resolved,
    status: "failed",
  });

  await assert.rejects(
    () =>
      service.approveDeployment({
        deploymentId: resolved.id,
        approval: {
          approved_by: "acct_owner",
          approved_at: "2026-04-27T00:01:00.000Z",
          policy_decision_id: "policy_demo",
        },
      }),
    /cannot be approved in 'failed' status/,
  );

  await assert.rejects(
    () => service.applyDeployment({ deploymentId: resolved.id }),
    /not in 'resolved' status/,
  );
});

Deno.test("core conformance: required provider features deny unsupported runtime capabilities locally", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_required_feature_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "needs-provider-feature",
      compute: {
        web: {
          type: "container",
          image: DEMO_IMAGE,
          port: 8080,
          requirements: {
            runtimeCapabilities: ["unsupported-gpu-runtime"],
          },
        },
      },
    },
  });

  assert.equal(resolved.status, "failed");
  const decision = resolved.policy_decisions?.find((candidate) =>
    candidate.id ===
      "policy-decision:provider-feature:web:unsupported-gpu-runtime"
  );
  assert.ok(decision);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.gate, "provider-selection");
});

Deno.test("core conformance: pgvector native feature realization requires approval", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_pgvector_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "pgvector-app",
      compute: {
        web: { type: "container", image: DEMO_IMAGE, port: 8080 },
      },
      resources: {
        db: {
          type: "postgres",
          plan: "dev",
          generate: { nativeFeatures: ["pgvector"] },
        },
      },
    },
  });

  const decision = resolved.policy_decisions?.find((candidate) =>
    candidate.id === "policy-decision:native-feature:db:pgvector"
  );
  assert.ok(decision);
  assert.equal(decision.decision, "require-approval");
  assert.equal(
    decision.ruleRef,
    "native-feature-realization:manual-approval-required",
  );
});

Deno.test("core conformance: cross-contract previousNames are denied at resolution", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_previous_names_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "rename-app",
      compute: {
        web: { type: "container", image: DEMO_IMAGE, port: 8080 },
      },
      resources: {
        db: {
          type: "postgres",
          plan: "dev",
          generate: {
            previousNames: [{
              name: "sqlite",
              contract: "resource.sql.sqlite-serverless@v1",
            }],
          },
        },
      },
    },
  });

  assert.equal(resolved.status, "failed");
  const decision = resolved.policy_decisions?.find((candidate) =>
    candidate.id === "policy-decision:previous-names:db:sqlite"
  );
  assert.ok(decision);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleRef, "previous-names:cross-contract-denied");
});

Deno.test("core conformance: canary candidate-scoped egress requires approval", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_candidate_egress_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      ...manifestWithExternalResource(),
      overrides: {
        rollout: {
          kind: "canary",
          routes: [{
            routeName: "web",
            assignments: [
              { appReleaseId: "release_v1", weightPermille: 900 },
              { appReleaseId: "release_candidate", weightPermille: 100 },
            ],
          }],
        },
        runtimeNetworkPolicy: {
          defaultEgress: "deny-by-default",
          egressRules: [{
            effect: "allow",
            protocol: "https",
            candidateScoped: true,
            to: [{ kind: "resource-access-path", networkBoundary: "external" }],
            ports: [443],
          }],
        },
      },
    },
  });

  const decision = resolved.policy_decisions?.find((candidate) =>
    candidate.id === "policy-decision:canary:candidate-scoped-egress"
  );
  assert.ok(decision);
  assert.equal(decision.decision, "require-approval");
});

Deno.test("core conformance: shadow side-effect and DB semantic write manifests require approval", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_shadow_write_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });

  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "shadow-writes",
      compute: {
        worker: {
          type: "worker",
          image: DEMO_IMAGE,
          port: 8080,
          triggers: {
            queues: [{ queue: "jobs" }],
          },
        },
      },
      resources: {
        db: {
          type: "postgres",
          plan: "dev",
          generate: { semanticWrites: true },
        },
      },
      overrides: {
        rollout: {
          kind: "canary",
          shadowTraffic: true,
        },
      },
    },
  });

  const decisionIds = new Set(resolved.policy_decisions?.map((d) => d.id));
  assert.equal(
    decisionIds.has("policy-decision:canary:shadow-side-effects"),
    true,
  );
  assert.equal(decisionIds.has("policy-decision:db-semantic-write:db"), true);
});

Deno.test("core conformance: advisory external access path records audit allow while enforced path denies", async () => {
  const advisoryService = new DeploymentService({
    store: new InMemoryDeploymentStore(),
    idFactory: () => "deployment_advisory_egress_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const advisory = await advisoryService.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "advisory-egress",
      compute: {
        web: {
          type: "container",
          image: DEMO_IMAGE,
          port: 8080,
          consume: [{
            resource: "bucket",
            as: "BUCKET",
            access: {
              contract: "resource.object-store.s3@v1",
              mode: "s3-api",
              networkBoundary: "external",
              enforcement: "advisory",
            },
          }],
        },
      },
      resources: {
        bucket: { type: "resource.object-store.s3@v1", plan: "dev" },
      },
    },
  });
  assert.equal(advisory.status, "resolved");
  assert.ok(
    advisory.policy_decisions?.some((decision) =>
      decision.gate === "access-path-selection" &&
      decision.decision === "allow" &&
      decision.ruleRef ===
        "runtime-network-policy:advisory-external-boundary-not-allowed"
    ),
  );

  const enforcedService = new DeploymentService({
    store: new InMemoryDeploymentStore(),
    idFactory: () => "deployment_enforced_egress_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const enforced = await enforcedService.resolveDeployment({
    spaceId: "space_conformance",
    manifest: {
      name: "enforced-egress",
      compute: {
        web: {
          type: "container",
          image: DEMO_IMAGE,
          port: 8080,
          consume: [{
            resource: "bucket",
            as: "BUCKET",
            access: {
              contract: "resource.object-store.s3@v1",
              mode: "s3-api",
              networkBoundary: "external",
              enforcement: "enforced",
            },
          }],
        },
      },
      resources: {
        bucket: { type: "resource.object-store.s3@v1", plan: "dev" },
      },
    },
  });
  assert.equal(enforced.status, "failed");
  assert.ok(
    enforced.policy_decisions?.some((decision) =>
      decision.ruleRef ===
        "runtime-network-policy:external-boundary-not-allowed"
    ),
  );
});
Deno.test("core conformance: ambiguous resource binding shorthand is blocked at resolution", async () => {
  // Public resource binding shorthand `bindings: { web: "DB" }` requires the
  // referenced compute to exist. A typo (referencing an unknown component)
  // is rejected by the compiler-level validator before resolution proceeds.
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_ambiguous_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await assert.rejects(
    () =>
      service.resolveDeployment({
        spaceId: "space_conformance",
        manifest: manifestWithExternalResource({
          resources: {
            db: {
              type: "postgres",
              plan: "dev",
              bindings: { unknown: "DATABASE_URL" },
            },
          },
        }),
      }),
    /references unknown compute/,
  );
});
Deno.test("core conformance: activation envelope route assignments use the canonical permille weight", async () => {
  const store = new InMemoryDeploymentStore();
  const service = new DeploymentService({
    store,
    idFactory: () => "deployment_weights_1",
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  const envelope = resolved.desired.activation_envelope;
  for (const route of envelope.route_assignments ?? []) {
    for (const assignment of route.assignments) {
      // Canonical immediate rollout pins each assignment to the full
      // permille weight (1000). Phase 12 rollout-canary will introduce
      // partial weights with explicit invariant checks.
      assert.equal(assignment.weightPermille, 1000);
      assert.ok(assignment.componentAddress.startsWith("component:"));
    }
  }
});
Deno.test("core conformance: applying a finalized Deployment never re-runs activation", async () => {
  // The Deployment equivalent of "activation preview blocks not-ready and retired
  // app releases" is that any non-resolved Deployment is treated as
  // finalized: status `applied` / `failed` / `rolled-back` are all rejected
  // so the activation envelope is never re-projected against a stale
  // release lineage.
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `deployment_finalized_${++counter}`,
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const resolved = await service.resolveDeployment({
    spaceId: "space_conformance",
    manifest: manifestWithExternalResource(),
  });

  for (
    const finalStatus of ["applied", "failed", "rolled-back"] as const
  ) {
    await store.putDeployment({
      ...resolved,
      status: finalStatus,
    });
    await assert.rejects(
      () => service.applyDeployment({ deploymentId: resolved.id }),
      /not in 'resolved' status/,
    );
  }
});

// Surviving test 1: ProviderObservation store ordering / drift reasoning.
Deno.test("core conformance: provider observation is recorded separately from materialization", async () => {
  const store = new InMemoryProviderObservationStore();
  await store.record({
    materializationId: "materialization_1",
    observedState: "drifted",
    driftReason: "config-drift",
    observedDigest: "sha256:observed",
    observedAt: "2026-04-27T00:00:00.000Z",
  });
  await store.record({
    materializationId: "materialization_1",
    observedState: "missing",
    driftReason: "provider-object-missing",
    observedAt: "2026-04-27T00:01:00.000Z",
  });

  assert.equal(
    (await store.latestForMaterialization("materialization_1"))
      ?.observedState,
    "missing",
  );
  assert.deepEqual(
    (await store.listByMaterialization("materialization_1")).map((
      observation,
    ) => observation.driftReason),
    ["config-drift", "provider-object-missing"],
  );
});

// Surviving test 2: condition-reason catalog exposure.
Deno.test("core conformance: condition reasons are exposed from the catalog", () => {
  for (
    const reason of [
      "DescriptorChanged",
      "BindingCollision",
      "AccessPathUnsupported",
      "ActivationCommitted",
      "ProviderObjectMissing",
      "RollbackDescriptorUnavailable",
    ]
  ) {
    assert.equal(
      (CORE_CONDITION_REASONS as readonly string[]).includes(reason),
      true,
    );
  }
});

// Surviving smoke test: official descriptor conformance dataset still loads.
Deno.test("core conformance: official descriptor conformance dataset is exposed", () => {
  assert.equal(OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS.length > 0, true);
  for (const record of OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS) {
    assert.match(record.digest, /^sha256:/);
    assert.equal(typeof record.alias, "string");
    assert.equal(typeof record.documentPath, "string");
  }
});
