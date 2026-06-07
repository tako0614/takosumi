import { expect, test } from "bun:test";
import type {
  ApplyRunResponse,
  InstallConfig,
  PlanRunResponse,
} from "takosumi-contract/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { OutputShare, OutputSnapshot } from "takosumi-contract/output-snapshots";
import type { Space } from "takosumi-contract/spaces";
import type { OpenTofuRunner } from "../domains/deploy-control/mod.ts";
import { applyExpectedGuardFromPlanRun } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import { createTakosumiService } from "../bootstrap.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ARCHIVE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const TOKEN = "deploy-control-token";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

/**
 * Stands up a service over a known in-memory store, then walks the new
 * Space-direct Installation model end-to-end through the public routes:
 *   POST /api/spaces -> POST /api/sources -> seed InstallConfig (operations
 *   facade) -> POST /api/spaces/:id/installations -> seed a SourceSnapshot for
 *   the source (so the installation plan does not 409 source_sync_required).
 *
 * Returns the wired app plus the seeded ids so the caller can drive the
 * Installation-driven plan / approve / apply roundtrip.
 */
async function seedInstallationViaRoutes(
  runner: OpenTofuRunner,
  options: { readonly environment?: string } = {},
): Promise<{
  app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  installationId: string;
  store: InMemoryOpenTofuDeploymentStore;
  spaceId: string;
}> {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { app, operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    opentofuDeploymentStore: store,
    opentofuRunner: runner,
    startWorkerDaemon: false,
  });

  const spaceRes = await app.request("/api/spaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle: "acme",
      displayName: "acme",
      type: "personal",
      ownerUserId: "user_test00000001",
    }),
  });
  expect(spaceRes.status).toBe(201);
  const spaceId = (await spaceRes.json()).space.id as string;

  const sourceRes = await app.request("/api/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      spaceId,
      name: "repo",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(sourceRes.status).toBe(201);
  const sourceId = (await sourceRes.json()).source.id as string;

  // Seed a deterministic InstallConfig through the in-process operations facade
  // (the fire-and-forget official catalog seed may not have drained yet).
  const nowIso = new Date(0).toISOString();
  const config: InstallConfig = {
    id: "cfg_test00000001",
    spaceId,
    name: "test-module",
    installType: "opentofu_module",
    trustLevel: "space",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await operations.installations.putInstallConfig(config);

  const installRes = await app.request(`/api/spaces/${spaceId}/installations`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      name: "web",
      environment: options.environment ?? "production",
      sourceId,
      installConfigId: config.id,
    }),
  });
  expect(installRes.status).toBe(201);
  const installationId = (await installRes.json()).installation.id as string;

  // Seed the SourceSnapshot directly so the Installation-driven plan resolves a
  // pinned snapshot (the real source_sync runs in the runner; the fake runner
  // here only implements plan/apply).
  const snapshot: SourceSnapshot = {
    id: "snap_e2e000001",
    sourceId,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: ".",
    archiveObjectKey:
      `spaces/${spaceId}/sources/${sourceId}/snapshots/snap_e2e000001/source.tar.zst`,
    archiveDigest: ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: "ssr_e2e000001",
    fetchedAt: nowIso,
  };
  await store.putSourceSnapshot(snapshot);

  return { app, installationId, store, spaceId };
}

test("deployControl e2e exposes OpenTofu plan and apply runs", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());

  // Installation-driven plan (spec §23): resolves the latest SourceSnapshot and
  // dispatches with installation state scope.
  const planRes = await app.request(
    `/api/installations/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
  expect(planRes.status).toEqual(201);
  const plan = await planRes.json() as PlanRunResponse;
  expect(plan.planRun.status).toEqual("succeeded");
  expect(plan.planRun.planDigest).toEqual(PLAN_DIGEST);
  expect(plan.planRun.planArtifact?.digest).toEqual(PLAN_DIGEST);

  // The plan introduces a delete/replace change, so the §25 action policy flags
  // it requiresApproval and the §19 Run projects waiting_approval; approve
  // before the apply.
  const runRes = await app.request(`/api/runs/${plan.planRun.id}`, {
    headers: headers(),
  });
  expect(runRes.status).toEqual(200);
  expect((await runRes.json() as { run: Run }).run.status).toEqual(
    "waiting_approval",
  );
  const approveRes = await app.request(
    `/api/runs/${plan.planRun.id}/approve`,
    { method: "POST", headers: headers({ "content-type": "application/json" }) },
  );
  expect(approveRes.status).toEqual(200);

  const applyRes = await app.request("/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    }),
  });
  expect(applyRes.status).toEqual(201);
  const apply = await applyRes.json() as ApplyRunResponse;
  expect(apply.applyRun.status).toEqual("succeeded");
  // New Installation status after a successful apply is "active" (§5 / §27).
  expect(apply.installation?.status).toEqual("active");
  // The new Deployment projects non-sensitive outputs as the `outputsPublic`
  // map (the legacy `outputs[]` lived on the rich Deployment, now removed).
  expect(apply.deployment?.outputsPublic.launch_url).toEqual(
    "https://app.example.test",
  );

  const outputsRes = await app.request(
    `/v1/installations/${installationId}/deployment-outputs`,
    { headers: headers() },
  );
  expect(outputsRes.status).toEqual(200);
  // The deployment-outputs projection lists one launch_url DeploymentOutput
  // derived from the current Deployment's outputsPublic map.
  expect((await outputsRes.json()).outputs).toEqual([
    {
      name: "launch_url",
      kind: "launch_url",
      value: "https://app.example.test",
      sensitive: false,
    },
  ]);
});

test("run logs/events expose diagnostics + audit trail (§30)", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());
  const planRes = await app.request(
    `/api/installations/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
  const plan = await planRes.json() as PlanRunResponse;

  const logsRes = await app.request(`/api/runs/${plan.planRun.id}/logs`, {
    headers: headers(),
  });
  expect(logsRes.status).toEqual(200);
  const logs = await logsRes.json();
  expect(Array.isArray(logs.diagnostics)).toBe(true);
  expect(Array.isArray(logs.auditEvents)).toBe(true);
  // The plan recorded at least a plan.requested / plan.completed audit event.
  expect(logs.auditEvents.length).toBeGreaterThan(0);

  const eventsRes = await app.request(`/api/runs/${plan.planRun.id}/events`, {
    headers: headers(),
  });
  expect(eventsRes.status).toEqual(200);
  const events = await eventsRes.json();
  expect(Array.isArray(events.auditEvents)).toBe(true);
  expect(events.auditEvents.length).toBeGreaterThan(0);
  // events is the audit-only subset; it carries no diagnostics field.
  expect(events.diagnostics).toBeUndefined();
});

test("run logs for a missing run is 404", async () => {
  const { app } = await seedInstallationViaRoutes(fakeRunner());
  const res = await app.request("/api/runs/plan_missing00000001/logs", {
    headers: headers(),
  });
  expect(res.status).toEqual(404);
});

test("deployment get + rollback-plan happy path; missing deployment is 404 (§30)", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());

  // Drive a full plan -> approve -> apply so a Deployment exists.
  const planRes = await app.request(
    `/api/installations/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
  const plan = await planRes.json() as PlanRunResponse;
  await app.request(`/api/runs/${plan.planRun.id}/approve`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
  });
  const applyRes = await app.request("/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    }),
  });
  const apply = await applyRes.json() as ApplyRunResponse;
  const deploymentId = apply.deployment?.id as string;
  expect(deploymentId).toBeTruthy();

  // Public §30 Installation read + deployments list.
  const instRes = await app.request(`/api/installations/${installationId}`, {
    headers: headers(),
  });
  expect(instRes.status).toEqual(200);
  expect((await instRes.json()).installation.id).toEqual(installationId);

  const deploymentsRes = await app.request(
    `/api/installations/${installationId}/deployments`,
    { headers: headers() },
  );
  expect(deploymentsRes.status).toEqual(200);
  expect((await deploymentsRes.json()).deployments.length).toBeGreaterThan(0);

  // GET /api/deployments/:id.
  const getRes = await app.request(`/api/deployments/${deploymentId}`, {
    headers: headers(),
  });
  expect(getRes.status).toEqual(200);
  const got = await getRes.json();
  expect(got.deployment.id).toEqual(deploymentId);
  expect(got.deployment.installationId).toEqual(installationId);

  // POST /api/deployments/:id/rollback-plan creates a NEW plan run pinned to the
  // deployment's source snapshot; it flows through the normal plan lifecycle.
  const rollbackRes = await app.request(
    `/api/deployments/${deploymentId}/rollback-plan`,
    { method: "POST", headers: headers() },
  );
  expect(rollbackRes.status).toEqual(201);
  const rollback = await rollbackRes.json() as PlanRunResponse;
  expect(rollback.planRun.id).not.toEqual(plan.planRun.id);
  expect(rollback.planRun.sourceSnapshotId).toEqual(
    apply.deployment?.sourceSnapshotId,
  );

  // Missing deployment is a typed 404.
  const missing = await app.request("/api/deployments/deploy_missing0001", {
    headers: headers(),
  });
  expect(missing.status).toEqual(404);
  const missingRollback = await app.request(
    "/api/deployments/deploy_missing0001/rollback-plan",
    { method: "POST", headers: headers() },
  );
  expect(missingRollback.status).toEqual(404);
});

test("space PATCH updates displayName (§30 MVP)", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());
  // Recover the space id via the public Installation read.
  const instRes = await app.request(`/api/installations/${installationId}`, {
    headers: headers(),
  });
  const spaceId = (await instRes.json()).installation.spaceId as string;

  const patchRes = await app.request(`/api/spaces/${spaceId}`, {
    method: "PATCH",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ displayName: "Acme Renamed" }),
  });
  expect(patchRes.status).toEqual(200);
  expect((await patchRes.json()).space.displayName).toEqual("Acme Renamed");

  // An unknown field is rejected (the allowlist is displayName-only for MVP).
  const badRes = await app.request(`/api/spaces/${spaceId}`, {
    method: "PATCH",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ handle: "renamed" }),
  });
  expect(badRes.status).toEqual(400);
});

/**
 * Seeds a consumer Space and a latest OutputSnapshot for the producer
 * Installation directly into the store, so the OutputShare routes can validate a
 * grant of `bucket_name` from the producer's `fromSpace` to a separate
 * consumer Space.
 */
async function seedOutputShareScenario(): Promise<{
  app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  fromSpaceId: string;
  toSpaceId: string;
  producerInstallationId: string;
}> {
  const { app, store, spaceId, installationId } = await seedInstallationViaRoutes(
    fakeRunner(),
  );
  const toSpaceId = "space_consumer0001";
  const consumer: Space = {
    id: toSpaceId,
    handle: "consumer",
    displayName: "Consumer",
    type: "personal",
    ownerUserId: "user_test00000002",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  await store.putSpace(consumer);
  const snapshot: OutputSnapshot = {
    id: "out_e2e000001",
    spaceId,
    installationId,
    stateGeneration: 1,
    rawOutputArtifactKey:
      `spaces/${spaceId}/installations/${installationId}/runs/r1/outputs.raw.json.enc`,
    publicOutputs: {},
    spaceOutputs: { bucket_name: "my-bucket", region: "auto" },
    outputDigest: "sha256:oute2e",
    createdAt: new Date(0).toISOString(),
  };
  await store.putOutputSnapshot(snapshot);
  return {
    app,
    fromSpaceId: spaceId,
    toSpaceId,
    producerInstallationId: installationId,
  };
}

test("output-shares create / approve / list / revoke happy path (§18)", async () => {
  const { app, fromSpaceId, toSpaceId, producerInstallationId } =
    await seedOutputShareScenario();

  // Create: a grant of bucket_name from the producer's Space to the consumer.
  const createRes = await app.request("/api/output-shares", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      fromSpaceId,
      toSpaceId,
      producerInstallationId,
      outputs: [{ name: "bucket_name", alias: "bucket" }],
    }),
  });
  expect(createRes.status).toEqual(201);
  const created = (await createRes.json()).share as OutputShare;
  expect(created.status).toEqual("pending");
  expect(created.outputs).toEqual([
    { name: "bucket_name", alias: "bucket", sensitive: false },
  ]);

  const approveRes = await app.request(
    `/api/output-shares/${created.id}/approve`,
    { method: "POST", headers: headers() },
  );
  expect(approveRes.status).toEqual(200);
  const approved = (await approveRes.json()).share as OutputShare;
  expect(approved.status).toEqual("active");
  expect(approved.acceptedAt).toBeDefined();

  // List from the granting Space surfaces the share.
  const listFrom = await app.request(
    `/api/output-shares?spaceId=${fromSpaceId}`,
    { headers: headers() },
  );
  expect(listFrom.status).toEqual(200);
  expect(((await listFrom.json()).shares as OutputShare[]).map((s) => s.id))
    .toEqual([created.id]);

  // List from the consumer Space surfaces the same share (received side).
  const listTo = await app.request(
    `/api/output-shares?spaceId=${toSpaceId}`,
    { headers: headers() },
  );
  expect(listTo.status).toEqual(200);
  expect(((await listTo.json()).shares as OutputShare[]).map((s) => s.id))
    .toEqual([created.id]);

  // Revoke moves it to revoked.
  const revokeRes = await app.request(
    `/api/output-shares/${created.id}/revoke`,
    { method: "POST", headers: headers() },
  );
  expect(revokeRes.status).toEqual(200);
  expect(((await revokeRes.json()).share as OutputShare).status).toEqual(
    "revoked",
  );
});

test("output-shares create 409 when a name is absent from the producer's outputs (§18)", async () => {
  const { app, fromSpaceId, toSpaceId, producerInstallationId } =
    await seedOutputShareScenario();
  const res = await app.request("/api/output-shares", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      fromSpaceId,
      toSpaceId,
      producerInstallationId,
      outputs: [{ name: "not_a_real_output" }],
    }),
  });
  // failed_precondition maps to HTTP 409.
  expect(res.status).toEqual(409);
  expect((await res.json()).error.code).toEqual("failed_precondition");
});

test("output-shares create 404 when the consumer Space is missing (§18)", async () => {
  const { app, fromSpaceId, producerInstallationId } =
    await seedOutputShareScenario();
  const res = await app.request("/api/output-shares", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      fromSpaceId,
      toSpaceId: "space_missing00001",
      producerInstallationId,
      outputs: [{ name: "bucket_name" }],
    }),
  });
  expect(res.status).toEqual(404);
});

test("output-shares revoke 404 for a missing share (§18)", async () => {
  const { app } = await seedOutputShareScenario();
  const res = await app.request(
    "/api/output-shares/oshare_missing00001/revoke",
    { method: "POST", headers: headers() },
  );
  expect(res.status).toEqual(404);
});

test("installation PATCH safely updates status only (§30)", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());
  const patch = await app.request(`/api/installations/${installationId}`, {
    method: "PATCH",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ status: "stale" }),
  });
  expect(patch.status).toEqual(200);
  expect((await patch.json()).installation.status).toEqual("stale");

  const rejectedDestroyState = await app.request(
    `/api/installations/${installationId}`,
    {
      method: "PATCH",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "destroyed" }),
    },
  );
  expect(rejectedDestroyState.status).toEqual(400);
  expect((await rejectedDestroyState.json()).error.message).toContain(
    "destroy flow",
  );

  const rejectedField = await app.request(
    `/api/installations/${installationId}`,
    {
      method: "PATCH",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ installConfigId: "cfg_other" }),
    },
  );
  expect(rejectedField.status).toEqual(400);
  expect((await rejectedField.json()).error.message).toContain(
    "unknown_field",
  );
});

test("installation DELETE creates a destroy-plan run instead of deleting state (§30 / §23)", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());
  const del = await app.request(`/api/installations/${installationId}`, {
    method: "DELETE",
    headers: headers(),
  });
  expect(del.status).toEqual(202);
  const payload = await del.json() as PlanRunResponse;
  expect(payload.planRun.installationId).toEqual(installationId);
  expect(payload.planRun.operation).toEqual("destroy");
  expect(payload.planRun.status).toEqual("succeeded");

  const runRes = await app.request(`/api/runs/${payload.planRun.id}`, {
    headers: headers(),
  });
  expect(runRes.status).toEqual(200);
  const run = (await runRes.json() as { run: Run }).run;
  expect(run.type).toEqual("destroy_plan");
  expect(run.status).toEqual("waiting_approval");
});

test("deployControl e2e rejects mismatched plan digest guard", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());

  const planRes = await app.request(
    `/api/installations/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
  expect(planRes.status).toEqual(201);
  const plan = await planRes.json() as PlanRunResponse;

  // Approve so the apply is gated only by the plan-digest guard under test.
  const approveRes = await app.request(
    `/api/runs/${plan.planRun.id}/approve`,
    { method: "POST", headers: headers({ "content-type": "application/json" }) },
  );
  expect(approveRes.status).toEqual(200);

  const res = await app.request("/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: plan.planRun.id,
      expected: {
        ...applyExpectedGuardFromPlanRun(plan.planRun),
        planDigest: "sha256:not-a-real-digest",
      },
    }),
  });
  expect(res.status).toEqual(409);
});

test("POST /api/installations/:id/drift-check creates a drift_check run that is never waiting_approval and cannot be applied", async () => {
  // The fake runner reports a delete+create change (the §25 action policy would
  // normally park a plan waiting_approval). A drift check must NOT park.
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());

  const driftRes = await app.request(
    `/api/installations/${installationId}/drift-check`,
    { method: "POST", headers: headers() },
  );
  expect(driftRes.status).toEqual(201);
  const drift = await driftRes.json() as PlanRunResponse;
  expect(drift.planRun.driftCheck).toBe(true);
  expect(drift.planRun.status).toEqual("succeeded");

  // The §19 Run projects type drift_check and succeeded (NOT waiting_approval).
  const runRes = await app.request(`/api/runs/${drift.planRun.id}`, {
    headers: headers(),
  });
  expect(runRes.status).toEqual(200);
  const run = (await runRes.json() as { run: Run }).run;
  expect(run.type).toEqual("drift_check");
  expect(run.status).toEqual("succeeded");

  // A drift check can never be applied.
  const applyRes = await app.request("/v1/apply-runs", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      planRunId: drift.planRun.id,
      expected: applyExpectedGuardFromPlanRun(drift.planRun),
    }),
  });
  expect(applyRes.status).toEqual(409);
});

function fakeRunner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_e2e/tfplan",
          digest: PLAN_DIGEST,
        },
        // A replace (delete+create) change so the §25 action policy flags the
        // plan requiresApproval (parks waiting_approval), exercising the
        // approve -> apply roundtrip below. Approval is no longer gated by the
        // environment alone — it is driven by the plan's actual changes.
        planResourceChanges: [
          {
            address: "module.app.cloudflare_workers_script.this",
            type: "cloudflare_workers_script",
            actions: ["delete", "create"],
          },
        ],
      }),
    apply: () =>
      Promise.resolve({
        outputs: {
          launch_url: {
            sensitive: false,
            value: "https://app.example.test",
          },
        },
      }),
  };
}
