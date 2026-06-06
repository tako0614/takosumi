import { expect, test } from "bun:test";
import type {
  ApplyRunResponse,
  InstallConfig,
  PlanRunResponse,
} from "takosumi-contract/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
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
 *   POST /v1/spaces -> POST /v1/sources -> seed InstallConfig (operations
 *   facade) -> POST /v1/spaces/:id/installations -> seed a SourceSnapshot for
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

  const spaceRes = await app.request("/v1/spaces", {
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

  const sourceRes = await app.request("/v1/sources", {
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

  const installRes = await app.request(`/v1/spaces/${spaceId}/installations`, {
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

  return { app, installationId };
}

test("deployControl e2e exposes OpenTofu plan and apply runs", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());

  // Installation-driven plan (spec §23): resolves the latest SourceSnapshot and
  // dispatches with installation state scope.
  const planRes = await app.request(
    `/v1/installations/${installationId}/plan`,
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
  const runRes = await app.request(`/v1/runs/${plan.planRun.id}`, {
    headers: headers(),
  });
  expect(runRes.status).toEqual(200);
  expect((await runRes.json() as { run: Run }).run.status).toEqual(
    "waiting_approval",
  );
  const approveRes = await app.request(
    `/v1/runs/${plan.planRun.id}/approve`,
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

test("deployControl e2e rejects mismatched plan digest guard", async () => {
  const { app, installationId } = await seedInstallationViaRoutes(fakeRunner());

  const planRes = await app.request(
    `/v1/installations/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
  expect(planRes.status).toEqual(201);
  const plan = await planRes.json() as PlanRunResponse;

  // Approve so the apply is gated only by the plan-digest guard under test.
  const approveRes = await app.request(
    `/v1/runs/${plan.planRun.id}/approve`,
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
