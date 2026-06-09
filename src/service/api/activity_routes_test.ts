/**
 * Activity HTTP route tests (Core Specification §27 audit_events / §34 Activity).
 *
 *   GET /api/spaces/:spaceId/activity   -> the Space's audit trail, newest first
 *
 * Drives the full public surface over an in-memory store. Real flows emit
 * Activity events (Installation created, plan created), and the listing shows
 * them space-scoped, newest-first, ?limit-bounded. A second Space sees nothing.
 */

import { expect, test } from "bun:test";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/installations";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { OpenTofuRunner } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import { createTakosumiService } from "../bootstrap.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
} from "../domains/deploy-control/test_model_fixture.ts";

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
  readonly app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  readonly store: OpenTofuDeploymentStore;
}

async function harness(): Promise<Harness> {
  const store = new InMemoryOpenTofuDeploymentStore();
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1", TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN },
    opentofuDeploymentStore: store,
    opentofuRunner: runner(),
    startWorkerDaemon: false,
  });
  return { app, store };
}

async function createSpace(
  app: Harness["app"],
  handle: string,
): Promise<string> {
  const res = await app.request("/api/spaces", {
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
  return (await res.json()).space.id as string;
}

/** Creates a source + Installation in a Space and returns the Installation id. */
async function createInstallation(
  store: OpenTofuDeploymentStore,
  app: Harness["app"],
  spaceId: string,
  name: string,
): Promise<string> {
  const sourceRes = await app.request("/api/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      spaceId,
      name: `${name}-repo`,
      url: `https://github.com/acme/${name}.git`,
    }),
  });
  expect(sourceRes.status).toBe(201);
  const sourceId = (await sourceRes.json()).source.id as string;

  const nowIso = new Date(0).toISOString();
  const config: InstallConfig = {
    id: `cfg_${name}00000001`,
    spaceId,
    name: `${name}-module`,
    installType: "opentofu_module",
    trustLevel: "space",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await store.putInstallConfig(config);

  const installRes = await app.request(`/api/spaces/${spaceId}/installations`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      name,
      environment: "preview",
      sourceId,
      installConfigId: config.id,
    }),
  });
  expect(installRes.status).toBe(201);
  const installationId = (await installRes.json()).installation.id as string;

  const snapshot: SourceSnapshot = {
    id: `snap_${name}00001`,
    sourceId,
    url: `https://github.com/acme/${name}.git`,
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: ".",
    archiveObjectKey:
      `spaces/${spaceId}/sources/${sourceId}/snapshots/snap_${name}/source.tar.zst`,
    archiveDigest: ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: `ssr_${name}00001`,
    fetchedAt: nowIso,
  };
  await store.putSourceSnapshot(snapshot);
  const compatibilityReport: CapsuleCompatibilityReport = {
    id: `caprep_${name}00001`,
    sourceSnapshotId: snapshot.id,
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: nowIso,
  };
  await store.putCapsuleCompatibilityReport(compatibilityReport);
  await store.patchInstallation(installationId, {
    compatibilityReportId: compatibilityReport.id,
    compatibilityStatus: compatibilityReport.level,
    updatedAt: nowIso,
  });
  return installationId;
}

async function listActivity(
  app: Harness["app"],
  spaceId: string,
  query = "",
): Promise<Response> {
  return await app.request(`/api/spaces/${spaceId}/activity${query}`, {
    headers: headers(),
  });
}

test("real flows emit Activity events; listing is space-scoped and newest-first", async () => {
  const { app, store } = await harness();
  const spaceId = await createSpace(app, "acme");
  const otherSpaceId = await createSpace(app, "other");

  // Creating an Installation emits installation.created.
  const installationId = await createInstallation(store, app, spaceId, "shop");

  // Planning emits run.plan_created.
  const planRes = await app.request(
    `/api/installations/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
  expect(planRes.status).toBe(201);

  const res = await listActivity(app, spaceId);
  expect(res.status).toBe(200);
  const body = await res.json() as { events: ActivityEvent[] };
  const actions = body.events.map((e) => e.action);

  // Both flows are recorded for the Space.
  expect(actions).toContain("installation.created");
  expect(actions).toContain("run.plan_created");

  // Newest-first: the plan (created after the installation) sorts ahead of it.
  const planIndex = actions.indexOf("run.plan_created");
  const installIndex = actions.indexOf("installation.created");
  expect(planIndex).toBeLessThan(installIndex);

  // Every event is scoped to this Space; none leak run output values.
  for (const event of body.events) {
    expect(event.spaceId).toBe(spaceId);
  }
  // The installation.created event carries non-secret context only.
  const created = body.events.find((e) => e.action === "installation.created")!;
  expect(created.targetType).toBe("installation");
  expect(created.targetId).toBe(installationId);
  expect(created.metadata.name).toBe("shop");

  // A different Space sees NONE of acme's activity.
  const otherRes = await listActivity(app, otherSpaceId);
  expect(otherRes.status).toBe(200);
  expect((await otherRes.json()).events).toEqual([]);
});

test("?limit bounds the page; invalid limits are rejected 400", async () => {
  const { app, store } = await harness();
  const spaceId = await createSpace(app, "acme");

  // Three installations => at least three installation.created events.
  await createInstallation(store, app, spaceId, "one");
  await createInstallation(store, app, spaceId, "two");
  await createInstallation(store, app, spaceId, "three");

  const limited = await listActivity(app, spaceId, "?limit=2");
  expect(limited.status).toBe(200);
  expect((await limited.json()).events).toHaveLength(2);

  // limit=0, over-max, and non-numeric are all 400.
  expect((await listActivity(app, spaceId, "?limit=0")).status).toBe(400);
  expect((await listActivity(app, spaceId, "?limit=501")).status).toBe(400);
  expect((await listActivity(app, spaceId, "?limit=abc")).status).toBe(400);
});

test("a malformed spaceId is rejected 400", async () => {
  const { app } = await harness();
  const res = await listActivity(app, "not-a-space");
  expect(res.status).toBe(400);
});
