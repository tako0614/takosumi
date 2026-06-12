import { expect, test } from "bun:test";

import { createApiApp } from "./app.ts";
import { OpenTofuDeploymentController } from "../domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../domains/deploy-control/store.ts";
import { SourcesService } from "../domains/sources/mod.ts";
import { InstallationsService } from "../domains/installations/mod.ts";

async function makeApp() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const archives = new Map<string, Uint8Array>();
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_route0001`,
  });
  const controller = new OpenTofuDeploymentController({ store, sourcesService });
  const installationsService = new InstallationsService({ store });
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    deployControlPublicRouteOptions: {
      controller,
      installationsService,
      writeSourceArchive: (key, bytes) => {
        archives.set(key, bytes);
        return Promise.resolve();
      },
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_1",
              spaceIds: ["space_aaaaaaaa"],
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  return { app, store, archives };
}

const TAR = new Uint8Array([0x74, 0x61, 0x72, 0x0a, 0x01, 0x02, 0x03]);

test("POST /internal/v1/spaces/:id/uploads requires a bearer (401)", async () => {
  const { app } = await makeApp();
  const res = await app.request("/internal/v1/spaces/space_aaaaaaaa/uploads", {
    method: "POST",
    body: TAR,
  });
  expect(res.status).toBe(401);
});

test("POST /internal/v1/spaces/:id/uploads records an upload snapshot and stores the archive", async () => {
  const { app, store, archives } = await makeApp();
  const res = await app.request("/internal/v1/spaces/space_aaaaaaaa/uploads", {
    method: "POST",
    headers: { authorization: "Bearer scoped-token" },
    body: TAR,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    snapshot: { id: string; origin: string; spaceId: string; archiveObjectKey: string; archiveDigest: string };
  };
  expect(body.snapshot.origin).toBe("upload");
  expect(body.snapshot.spaceId).toBe("space_aaaaaaaa");
  // The archive was written to R2_SOURCE at the recorded key.
  expect(archives.has(body.snapshot.archiveObjectKey)).toBe(true);
  // The snapshot is retrievable from the ledger.
  const stored = await store.getSourceSnapshot(body.snapshot.id);
  expect(stored?.origin).toBe("upload");
  expect(body.snapshot.archiveDigest.startsWith("sha256:")).toBe(true);
});

test("POST /internal/v1/spaces/:id/uploads rejects a Space outside the principal scope (403)", async () => {
  const { app } = await makeApp();
  const res = await app.request("/internal/v1/spaces/space_bbbbbbbb/uploads", {
    method: "POST",
    headers: { authorization: "Bearer scoped-token" },
    body: TAR,
  });
  expect(res.status).toBe(403);
});

test("POST /internal/v1/deploy requires a bearer (401)", async () => {
  const { app } = await makeApp();
  const res = await app.request("/internal/v1/deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId: "space_aaaaaaaa", name: "x", snapshotId: "snap_x" }),
  });
  expect(res.status).toBe(401);
});

test("POST /internal/v1/deploy rejects a non-upload snapshot (4xx)", async () => {
  const { app } = await makeApp();
  // No such upload snapshot -> not_found / invalid_argument (never 5xx).
  const res = await app.request("/internal/v1/deploy", {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: "space_aaaaaaaa",
      name: "x",
      snapshotId: "snap_missing0001",
    }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});
