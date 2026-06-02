import { test } from "bun:test";
// Vertical-slice integration smoke for the Deployment-centric public surface:
//
//   1. Space + group are created via SpaceDomainServices.
//   2. A Deployment is resolved from a public manifest with
//      `DeploymentService.resolveDeployment` (preview, no provider mutation).
//   3. The Deployment is promoted to `applied` via
//      `DeploymentService.applyDeployment`, advancing the GroupHead.
//
// Runtime-agent terminal result projection onto
// `Deployment.desired.activation_envelope` is covered by
// `runtime-agent-projection/service_test.ts`; this smoke stays focused on the
// deployment lifecycle and GroupHead commit path.
import assert from "node:assert/strict";
import type { TakosumiActorContext } from "takosumi-contract/reference/compat";
import {
  createSpaceDomainServices,
  createInMemorySpaceDomainDependencies,
} from "../../domains/space/services.ts";
import {
  DeploymentService,
  InMemoryDeploymentStore,
} from "../../domains/deploy/deployment_service.ts";
import type { ReferenceDeploySourcePayload } from "../../domains/deploy/types.ts";

test("integration smoke: create space/group, resolve and apply Deployment, advance GroupHead", async () => {
  const actor = actorContext("acct_smoke_owner", "req_smoke");
  const spaceDeps = createInMemorySpaceDomainDependencies({
    clock: fixedSpaceClock("2026-04-27T00:00:00.000Z"),
    idGenerator: spaceSequenceIds([
      "event_space_created",
      "membership_owner",
      "event_group_created",
    ]),
  });
  const spaceDomain = createSpaceDomainServices(spaceDeps);

  const createdSpace = await spaceDomain.spaces.createSpace({
    actor,
    spaceId: "space_smoke",
    name: "Smoke Space",
  });
  assert.equal(createdSpace.ok, true);
  if (!createdSpace.ok) throw new Error("space creation failed");

  const group = await spaceDomain.groups.createGroup({
    actor,
    spaceId: createdSpace.value.id,
    groupId: "group_smoke-app",
    slug: "smoke-app",
    displayName: "Smoke App",
  });
  assert.equal(group.ok, true);
  if (!group.ok) throw new Error("group creation failed");

  assert.deepEqual(
    (await spaceDomain.outbox.listPending()).map((event) => event.type),
    ["space.space.created", "space.group.created"],
  );

  // Phase 7B: drive the Deployment-centric pipeline directly.
  const store = new InMemoryDeploymentStore();
  const deploymentService = new DeploymentService({
    store,
    idFactory: () => "deployment_smoke",
    clock: fixedClock("2026-04-27T00:01:00.000Z"),
  });

  const resolved = await deploymentService.resolveDeployment({
    spaceId: createdSpace.value.id,
    manifest: simpleManifest(),
    input: {
      manifest_snapshot:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      source_kind: "inline",
      source_ref: "memory://smoke-app.yml",
      group: "smoke-app",
    },
  });

  assert.equal(resolved.id, "deployment_smoke");
  assert.equal(resolved.space_id, "space_smoke");
  assert.equal(resolved.group_id, "smoke-app");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.applied_at, null);
  assert.equal(resolved.finalized_at, null);
  assert.equal(resolved.input.source_kind, "inline");
  assert.equal(resolved.input.source_ref, "memory://smoke-app.yml");
  assert.equal(
    resolved.input.manifest_snapshot,
    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.ok(
    resolved.resolution.descriptor_closure.closureDigest.startsWith("sha256:"),
  );
  assert.ok(resolved.resolution.resolved_graph.digest.startsWith("sha256:"));

  // Resolution is non-mutating — no GroupHead is created until apply.
  assert.equal(
    await store.getGroupHead("smoke-app"),
    undefined,
  );

  const applied = await deploymentService.applyDeployment({
    deploymentId: resolved.id,
    appliedAt: "2026-04-27T00:02:00.000Z",
  });

  assert.equal(applied.id, resolved.id);
  assert.equal(applied.status, "applied");
  assert.equal(applied.applied_at, "2026-04-27T00:02:00.000Z");
  assert.equal(applied.finalized_at, "2026-04-27T00:02:00.000Z");
  assert.ok(
    applied.conditions.some((condition) =>
      condition.type === "ActivationCommitted" &&
      condition.status === "true" &&
      condition.reason === "DeploymentApplied"
    ),
  );

  const head = await store.getGroupHead("smoke-app");
  assert.ok(head, "group head should be advanced after apply");
  assert.equal(head.group_id, "smoke-app");
  assert.equal(head.current_deployment_id, applied.id);
  assert.equal(head.previous_deployment_id, null);
  assert.equal(head.generation, 1);
  assert.equal(head.advanced_at, "2026-04-27T00:02:00.000Z");

  // The applied Deployment is also retrievable through listDeployments.
  const listed = await deploymentService.listDeployments({
    spaceId: createdSpace.value.id,
    groupId: "smoke-app",
    status: "applied",
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, applied.id);
});

function simpleManifest(): ReferenceDeploySourcePayload {
  return {
    name: "smoke-app",
    version: "1.0.0",
    env: { APP_ENV: "smoke" },
    compute: {
      web: {
        type: "container",
        image:
          "registry.example.test/smoke-app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        port: 8080,
        env: { PORT: "8080" },
      },
    },
    resources: {
      db: { type: "postgres", plan: "dev" },
    },
    routes: {
      http: { target: "web", host: "smoke.example.test", path: "/" },
    },
  };
}

function actorContext(
  actorAccountId: string,
  requestId: string,
): TakosumiActorContext {
  return {
    actorAccountId,
    roles: ["owner"],
    requestId,
    principalKind: "account",
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("test id sequence exhausted");
    index += 1;
    return value;
  };
}

function fixedSpaceClock(iso: string): { now(): Date } {
  return { now: () => new Date(iso) };
}

function spaceSequenceIds(values: readonly string[]): { create(): string } {
  const next = sequenceIds(values);
  return { create: () => next() };
}
