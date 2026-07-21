/**
 * Activity HTTP route tests (Core Specification §27 audit_events / §34 Activity).
 *
 *   GET /internal/v1/workspaces/:workspaceId/activity   -> the Workspace's audit trail, newest first
 *
 * Drives the full internal route surface over an in-memory store. Real flows emit
 * Activity events (Capsule created, plan created), and the listing shows
 * them workspace-scoped, newest-first, ?limit-bounded. A second Workspace sees nothing.
 */

import { expect, test } from "bun:test";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import type { OpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  seedProviderConnections,
} from "../../helpers/deploy-control/model_fixture.ts";

const ARCHIVE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const TOKEN = "deploy-control-token";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

function runner(): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      }),
    apply: () => Promise.resolve({ outputs: {} as never }),
    destroy: () => Promise.resolve({}),
  };
}

interface Harness {
  readonly app: {
    request: (path: string, init?: RequestInit) => Promise<Response>;
  };
  readonly store: OpenTofuControlStore;
}

async function harness(): Promise<Harness> {
  const store = new InMemoryOpenTofuControlStore();
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    opentofuControlStore: store,
    opentofuRunner: runner(),
  });
  return { app, store };
}

async function createWorkspace(
  app: Harness["app"],
  handle: string,
): Promise<string> {
  const res = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle,
      displayName: handle,
      type: "personal",
      ownerUserId: `user_${handle}0001`,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).workspace.id as string;
}

/** Creates a source + Capsule in a Workspace and returns the Capsule id. */
async function createCapsule(
  store: OpenTofuControlStore,
  app: Harness["app"],
  workspaceId: string,
  name: string,
): Promise<string> {
  const sourceRes = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      workspaceId,
      name: `${name}-repo`,
      url: `https://github.com/acme/${name}.git`,
    }),
  });
  expect(sourceRes.status).toBe(201);
  const source = (await sourceRes.json()).source;
  const sourceId = source.id as string;

  const nowIso = new Date(0).toISOString();
  const config: InstallConfig = {
    id: `cfg_${name}00000001`,
    workspaceId,
    name: `${name}-module`,
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await store.putInstallConfig(config);

  const installRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name,
        environment: "preview",
        sourceId,
        installConfigId: config.id,
      }),
    },
  );
  expect(installRes.status).toBe(201);
  const capsuleId = (await installRes.json()).capsule.id as string;
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  await seedProviderConnections(store, capsule!);

  const snapshot: SourceSnapshot = {
    id: `snap_${name}00001`,
    origin: "git",
    sourceId,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "a".repeat(40),
    path: source.defaultPath,
    archiveRef: `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snap_${name}/source.tar.zst`,
    archiveDigest: ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: `ssr_${name}00001`,
    fetchedAt: nowIso,
  };
  await store.putSourceSnapshot(snapshot);
  const compatibilityReport: CapsuleCompatibilityReport = {
    id: `caprep_${name}00001`,
    sourceId,
    sourceSnapshotId: snapshot.id,
    modulePath: ".",
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: nowIso,
  };
  await store.putCapsuleCompatibilityReport(compatibilityReport);
  await store.patchCapsule(capsuleId, {
    compatibilityReportId: compatibilityReport.id,
    compatibilityStatus: compatibilityReport.level,
    updatedAt: nowIso,
  });
  return capsuleId;
}

async function listActivity(
  app: Harness["app"],
  workspaceId: string,
  query = "",
): Promise<Response> {
  return await app.request(
    `/internal/v1/workspaces/${workspaceId}/activity${query}`,
    {
      headers: headers(),
    },
  );
}

test("real flows emit Activity events; listing is workspace-scoped and newest-first", async () => {
  const { app, store } = await harness();
  const workspaceId = await createWorkspace(app, "acme");
  const otherWorkspaceId = await createWorkspace(app, "other");

  // Creating a Capsule emits capsule.created.
  const capsuleId = await createCapsule(store, app, workspaceId, "shop");

  // Planning emits run.plan_created.
  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  expect(planRes.status).toBe(201);

  const res = await listActivity(app, workspaceId);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { events: ActivityEvent[] };
  const actions = body.events.map((e) => e.action);

  // Both flows are recorded for the Workspace.
  expect(actions).toContain("capsule.created");
  expect(actions).toContain("run.plan_created");

  // Newest-first: the plan (created after the capsule) sorts ahead of it.
  const planIndex = actions.indexOf("run.plan_created");
  const installIndex = actions.indexOf("capsule.created");
  expect(planIndex).toBeLessThan(installIndex);

  // Every event is scoped to this Workspace; none leak run output values.
  for (const event of body.events) {
    expect(event.workspaceId).toBe(workspaceId);
  }
  // The capsule.created event carries non-secret context only.
  const created = body.events.find((e) => e.action === "capsule.created")!;
  expect(created.targetType).toBe("capsule");
  expect(created.targetId).toBe(capsuleId);
  expect(created.metadata.name).toBe("shop");

  // A different Workspace sees NONE of acme's activity.
  const otherRes = await listActivity(app, otherWorkspaceId);
  expect(otherRes.status).toBe(200);
  expect((await otherRes.json()).events).toEqual([]);
});

test("?limit bounds the page; invalid limits are rejected 400", async () => {
  const { app, store } = await harness();
  const workspaceId = await createWorkspace(app, "acme");

  // Three Capsules => at least three capsule.created events.
  await createCapsule(store, app, workspaceId, "one");
  await createCapsule(store, app, workspaceId, "two");
  await createCapsule(store, app, workspaceId, "three");

  const limited = await listActivity(app, workspaceId, "?limit=2");
  expect(limited.status).toBe(200);
  expect((await limited.json()).events).toHaveLength(2);

  // limit=0, over-max, and non-numeric are all 400.
  expect((await listActivity(app, workspaceId, "?limit=0")).status).toBe(400);
  expect((await listActivity(app, workspaceId, "?limit=501")).status).toBe(400);
  expect((await listActivity(app, workspaceId, "?limit=abc")).status).toBe(400);
});

test("a malformed workspaceId is rejected 400", async () => {
  const { app } = await harness();
  const res = await listActivity(app, "not-a-workspace");
  expect(res.status).toBe(400);
});
