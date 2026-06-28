import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { recordArtifactSnapshotFromUrl } from "../../../core/api/deploy_control_deploy_routes.ts";
import { OpenTofuDeploymentController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../core/domains/sources/mod.ts";
import { CapsulesService } from "../../../core/domains/capsules/mod.ts";

async function makeApp() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const archives = new Map<string, Uint8Array>();
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_route0001`,
  });
  const controller = new OpenTofuDeploymentController({
    store,
    sourcesService,
  });
  const installationsService = new CapsulesService({ store });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
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
    snapshot: {
      id: string;
      origin: string;
      spaceId: string;
      archiveObjectKey: string;
      archiveDigest: string;
    };
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

test("recordArtifactSnapshotFromUrl stores a digest-verified artifact snapshot", async () => {
  const { store, archives } = await makeApp();
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_artifact0001`,
  });
  const controller = new OpenTofuDeploymentController({
    store,
    sourcesService,
  });
  const bytes = new Uint8Array([0x73, 0x72, 0x63, 0x0a]);
  const digest = await sha256DigestForTest(bytes);
  const snapshot = await recordArtifactSnapshotFromUrl({
    controller,
    writeSourceArchive: (key, data) => {
      archives.set(key, data);
      return Promise.resolve();
    },
    spaceId: "space_aaaaaaaa",
    request: {
      url: "https://artifacts.example.com/app/source.tar.zst",
      digest,
      path: "infra",
    },
    fetcher: async () =>
      new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength) },
      }),
  });

  expect(snapshot.origin).toBe("artifact");
  expect(snapshot.spaceId).toBe("space_aaaaaaaa");
  expect(snapshot.path).toBe("infra");
  expect(snapshot.archiveDigest).toBe(digest);
  expect(archives.get(snapshot.archiveObjectKey)).toEqual(bytes);
});

test("recordArtifactSnapshotFromUrl rejects a digest mismatch", async () => {
  const { store, archives } = await makeApp();
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_artifact0001`,
  });
  const controller = new OpenTofuDeploymentController({
    store,
    sourcesService,
  });
  await expect(
    recordArtifactSnapshotFromUrl({
      controller,
      writeSourceArchive: (key, data) => {
        archives.set(key, data);
        return Promise.resolve();
      },
      spaceId: "space_aaaaaaaa",
      request: {
        url: "https://artifacts.example.com/app/source.tar.zst",
        digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      fetcher: async () => new Response(new Uint8Array([0x62, 0x61, 0x64])),
    }),
  ).rejects.toThrow(/digest mismatch/);
  expect(archives.size).toBe(0);
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

async function sha256DigestForTest(
  bytes: Uint8Array,
): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

test("POST /internal/v1/deploy requires a bearer (401)", async () => {
  const { app } = await makeApp();
  const res = await app.request("/internal/v1/deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spaceId: "space_aaaaaaaa",
      name: "x",
      snapshotId: "snap_x",
    }),
  });
  expect(res.status).toBe(401);
});

test("POST /internal/v1/deploy validates providerEnvBindings connectionId values (400)", async () => {
  const { app } = await makeApp();
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
      providerEnvBindings: [
        {
          provider: "cloudflare",
        },
      ],
    }),
  });
  expect(res.status).toBe(400);
  const payload = await res.json();
  expect(payload.error.code).toBe("invalid_argument");
  expect(payload.error.message).toContain("providerBindings[0].connectionId");
});

test("POST /internal/v1/deploy rejects a missing no-git snapshot (4xx)", async () => {
  const { app } = await makeApp();
  // No such upload/artifact snapshot -> not_found / invalid_argument (never 5xx).
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
