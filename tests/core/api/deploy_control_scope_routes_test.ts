/**
 * Deploy-control operation / runner-profile scope enforcement on the
 * Capsule-driven plan routes, the StateVersion rollback plan, the Workspace
 * RunGroup fan-out, and the Dependency edge writes. Every one of these creates
 * (or feeds) a privileged Run, so Workspace membership alone must not be
 * enough — the raw `POST /internal/v1/plan-runs` route has always required the
 * operation + runner-profile scopes, and these routes must agree.
 */
import { expect, test } from "bun:test";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { Dependency } from "takosumi-contract/dependencies";

import { createTakosumiService } from "../../../core/bootstrap.ts";
import type { DeployControlPrincipal } from "../../../core/api/deploy_control_shared.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";

const WORKSPACE_ID = "ws_scoped";
const CAPSULE_ID = "cap_scoped0001";

function headers(): Record<string, string> {
  return {
    authorization: "Bearer scoped-token",
    "content-type": "application/json",
  };
}

async function scopedApp(
  principal: Omit<DeployControlPrincipal, "actor">,
  options: { readonly currentStateVersionId?: string } = {},
) {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
  });
  if (options.currentStateVersionId) {
    const stateVersion: StateVersion = {
      id: options.currentStateVersionId,
      workspaceId: WORKSPACE_ID,
      capsuleId: CAPSULE_ID,
      environment: seeded.capsule.environment,
      generation: 1,
      stateRef: "rl://state",
      digest: "sha256:state",
      createdByRunId: "apply_scoped0001",
      createdAt: "2026-06-06T00:00:00.000Z",
    };
    await store.putStateVersion(stateVersion);
    await store.putCapsule({
      ...seeded.capsule,
      status: "active",
      currentStateVersionId: stateVersion.id,
      currentStateGeneration: 1,
    });
  }
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: store,
    authorizeDeployControlBearer: ({ token }) =>
      token === "scoped-token"
        ? { actor: "acct_scoped", ...principal }
        : undefined,
  });
  return { app, store, seeded };
}

test("capsule plan route rejects a runner profile outside the principal's scope", async () => {
  const { app } = await scopedApp({
    workspaceIds: [WORKSPACE_ID],
    operations: "*",
    runnerProfileIds: ["opentofu-default"],
  });

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/plan`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ runnerId: "operator-privileged" }),
    },
  );

  expect(response.status).toEqual(403);
  expect((await response.json()).error.code).toEqual("permission_denied");
});

test("capsule destroy-plan route rejects a runner profile outside the principal's scope", async () => {
  const { app } = await scopedApp({
    workspaceIds: [WORKSPACE_ID],
    operations: "*",
    runnerProfileIds: ["opentofu-default"],
  });

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/destroy-plan`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ runnerId: "operator-privileged" }),
    },
  );

  expect(response.status).toEqual(403);
});

test("capsule destroy-plan route requires the destroy operation", async () => {
  const { app } = await scopedApp({
    workspaceIds: [WORKSPACE_ID],
    operations: ["create", "update"],
    runnerProfileIds: "*",
  });

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/destroy-plan`,
    { method: "POST", headers: headers() },
  );

  expect(response.status).toEqual(403);
  expect((await response.json()).error.message).toContain("destroy");
});

test("capsule plan route requires update on a Capsule that already has state", async () => {
  const { app } = await scopedApp(
    {
      workspaceIds: [WORKSPACE_ID],
      operations: ["create"],
      runnerProfileIds: "*",
    },
    { currentStateVersionId: "state_scoped0001" },
  );

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/plan`,
    { method: "POST", headers: headers() },
  );

  expect(response.status).toEqual(403);
  expect((await response.json()).error.message).toContain("update");
});

test("state-version rollback-plan route requires the write operation scope", async () => {
  const { app } = await scopedApp(
    {
      workspaceIds: [WORKSPACE_ID],
      operations: ["create"],
      runnerProfileIds: "*",
    },
    { currentStateVersionId: "state_scoped0001" },
  );

  const response = await app.request(
    "/internal/v1/state-versions/state_scoped0001/rollback-plan",
    { method: "POST", headers: headers() },
  );

  expect(response.status).toEqual(403);
});

test("state-version rollback-plan route denies a principal with no allowed runner profile", async () => {
  const { app } = await scopedApp(
    {
      workspaceIds: [WORKSPACE_ID],
      operations: "*",
      runnerProfileIds: ["opentofu-default"],
    },
    { currentStateVersionId: "state_scoped0001" },
  );

  const response = await app.request(
    "/internal/v1/state-versions/state_scoped0001/rollback-plan",
    { method: "POST", headers: headers() },
  );

  expect(response.status).toEqual(403);
  expect((await response.json()).error.message).toContain("runner profile");
});

test("workspace plan-update RunGroup requires the update operation", async () => {
  const { app } = await scopedApp({
    workspaceIds: [WORKSPACE_ID],
    operations: ["create"],
    runnerProfileIds: "*",
  });

  const response = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/plan-update`,
    { method: "POST", headers: headers() },
  );

  expect(response.status).toEqual(403);
});

test("dependency create requires write authority, not just Workspace membership", async () => {
  const { app } = await scopedApp({
    workspaceIds: [WORKSPACE_ID],
    operations: ["create"],
    runnerProfileIds: "*",
  });

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/dependencies`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        producerCapsuleId: CAPSULE_ID,
        mode: "variable_injection",
        outputs: {},
        visibility: "public",
      }),
    },
  );

  expect(response.status).toEqual(403);
});

test("dependency delete requires write authority, not just Workspace membership", async () => {
  const { app, store } = await scopedApp({
    workspaceIds: [WORKSPACE_ID],
    operations: ["create"],
    runnerProfileIds: "*",
  });
  const dependency: Dependency = {
    id: "dep_scoped0001",
    workspaceId: WORKSPACE_ID,
    producerCapsuleId: CAPSULE_ID,
    consumerCapsuleId: CAPSULE_ID,
    mode: "variable_injection",
    outputs: {},
    visibility: "public",
    createdAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putDependency(dependency);

  const response = await app.request(
    "/internal/v1/dependencies/dep_scoped0001",
    { method: "DELETE", headers: headers() },
  );

  expect(response.status).toEqual(403);
  expect(await store.getDependency("dep_scoped0001")).toBeDefined();
});
