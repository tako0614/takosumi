/**
 * Keyset-pagination behaviour over the §30 deploy-control list routes
 * (capsules / connections). Asserts: a default (no `?limit=`) list caps at
 * 100 rows + emits a `nextCursor`; the cursor pages the remainder with no gaps
 * or dupes across the `(createdAt, id)` boundary; an explicit `?limit=` is
 * honoured/clamped; a malformed `?limit=` / `?cursor=` is a 400.
 */
import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { CapsulesService } from "../../../core/domains/capsules/mod.ts";
import type { Capsule } from "takosumi-contract/capsules";
import type { ProviderConnection } from "takosumi-contract/connections";
import type { InstallConfig } from "takosumi-contract/install-configs";
import { DEFAULT_PAGE_LIMIT } from "takosumi-contract/pagination";

const WORKSPACE_ID = "ws_pagination01";

function connectionFixture(i: number): ProviderConnection {
  const seq = String(i).padStart(4, "0");
  return {
    id: `conn_${seq}`,
    workspaceId: WORKSPACE_ID,
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    scope: "workspace",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: `2026-01-01T00:00:00.${seq}Z`,
    updatedAt: `2026-01-01T00:00:00.${seq}Z`,
  };
}

function capsuleFixture(i: number): Capsule {
  const seq = String(i).padStart(4, "0");
  return {
    id: `cap_${seq}`,
    workspaceId: WORKSPACE_ID,
    projectId: "prj_pagination01",
    name: `app-${seq}`,
    slug: `app-${seq}`,
    sourceId: "src_pagination01",
    environment: "production",
    installConfigId: "cfg_test",
    currentStateGeneration: 0,
    status: "active",
    createdAt: `2026-01-01T00:00:00.${seq}Z`,
    updatedAt: `2026-01-01T00:00:00.${seq}Z`,
  } satisfies Capsule;
}

function installConfigFixture(i: number, workspaceId?: string): InstallConfig {
  const seq = String(i).padStart(4, "0");
  return {
    id: `cfg_${seq}`,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    name: `config-${seq}`,
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: `2026-01-01T00:00:00.${seq}Z`,
    updatedAt: `2026-01-01T00:00:00.${seq}Z`,
  } satisfies InstallConfig;
}

function storeInstallConfigFixture(
  i: number,
  workspaceId?: string,
): InstallConfig {
  const config = installConfigFixture(i, workspaceId);
  return {
    ...config,
    store: {
      source: {
        url: `https://example.test/app-${i}.git`,
        ref: "main",
        path: ".",
      },
      order: i,
      surface: "apps",
      kind: "app",
      provider: "fixture",
      suggestedName: config.name,
      badge: { ja: "App", en: "App" },
      name: { ja: config.name, en: config.name },
      description: { ja: "Fixture", en: "Fixture" },
    },
  } satisfies InstallConfig;
}

async function makeApp(
  seed: (store: InMemoryOpenTofuControlStore) => Promise<void>,
) {
  const store = new InMemoryOpenTofuControlStore();
  await seed(store);
  const controller = new OpenTofuController({ store });
  const capsulesService = new CapsulesService({ store });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      capsulesService,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_1",
              workspaceIds: [WORKSPACE_ID],
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  return app;
}

const AUTH = { authorization: "Bearer scoped-token" } as const;

test("GET /internal/v1/connections caps the default page at 100 and pages the rest with no gaps/dupes", async () => {
  const total = 250;
  const app = await makeApp(async (store) => {
    for (let i = 0; i < total; i += 1) {
      await store.putConnection(connectionFixture(i));
    }
  });

  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    pages += 1;
    const url =
      cursor === undefined
        ? `/internal/v1/connections?workspaceId=${WORKSPACE_ID}`
        : `/internal/v1/connections?workspaceId=${WORKSPACE_ID}&cursor=${encodeURIComponent(cursor)}`;
    const res = await app.request(url, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: { id: string }[];
      nextCursor?: string;
    };
    expect(body.connections.length).toBeLessThanOrEqual(DEFAULT_PAGE_LIMIT);
    seen.push(...body.connections.map((c) => c.id));
    if (body.nextCursor === undefined) break;
    cursor = body.nextCursor;
    if (pages > 10) throw new Error("cursor never terminated");
  }

  expect(pages).toBe(3); // 100 + 100 + 50
  expect(seen).toHaveLength(total);
  expect(new Set(seen).size).toBe(total); // no dupes
  const expected = Array.from(
    { length: total },
    (_, i) => `conn_${String(i).padStart(4, "0")}`,
  );
  expect(seen).toEqual(expected); // ordered, no gaps
});

test("GET /internal/v1/connections honours an explicit ?limit=", async () => {
  const app = await makeApp(async (store) => {
    for (let i = 0; i < 10; i += 1)
      await store.putConnection(connectionFixture(i));
  });
  const res = await app.request(
    `/internal/v1/connections?workspaceId=${WORKSPACE_ID}&limit=3`,
    { headers: AUTH },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    connections: unknown[];
    nextCursor?: string;
  };
  expect(body.connections).toHaveLength(3);
  expect(body.nextCursor).toBeDefined();
});

test("GET /internal/v1/connections rejects a malformed ?limit= and ?cursor= (400)", async () => {
  const app = await makeApp(async (store) => {
    await store.putConnection(connectionFixture(0));
  });
  const badLimit = await app.request(
    `/internal/v1/connections?workspaceId=${WORKSPACE_ID}&limit=-1`,
    { headers: AUTH },
  );
  expect(badLimit.status).toBe(400);
  const badCursor = await app.request(
    `/internal/v1/connections?workspaceId=${WORKSPACE_ID}&cursor=not-a-cursor!!`,
    { headers: AUTH },
  );
  expect(badCursor.status).toBe(400);
});

test("GET /internal/v1/workspaces/:id/capsules caps the default page at 100 and emits a cursor", async () => {
  const total = 150;
  const app = await makeApp(async (store) => {
    for (let i = 0; i < total; i += 1) {
      await store.putCapsule(capsuleFixture(i));
    }
  });
  const res = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/capsules`,
    { headers: AUTH },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    capsules: { id: string }[];
    nextCursor?: string;
  };
  expect(body.capsules).toHaveLength(DEFAULT_PAGE_LIMIT);
  expect(body.nextCursor).toBeDefined();

  const next = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/capsules?cursor=${encodeURIComponent(body.nextCursor!)}`,
    { headers: AUTH },
  );
  const nextBody = (await next.json()) as {
    capsules: { id: string }[];
    nextCursor?: string;
  };
  expect(nextBody.capsules).toHaveLength(total - DEFAULT_PAGE_LIMIT);
  expect(nextBody.nextCursor).toBeUndefined();
  // No overlap across the page boundary.
  const firstIds = new Set(body.capsules.map((r) => r.id));
  for (const row of nextBody.capsules) {
    expect(firstIds.has(row.id)).toBe(false);
  }
});

test("GET /internal/v1/workspaces/:id/capsules can exclude destroyed Capsules before paging", async () => {
  const app = await makeApp(async (store) => {
    await store.putCapsule(capsuleFixture(0));
    await store.putCapsule({
      ...capsuleFixture(1),
      status: "destroyed",
    });
    await store.putCapsule(capsuleFixture(2));
  });

  const res = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/capsules?includeDestroyed=false&limit=10`,
    { headers: AUTH },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    capsules: { id: string; status: string }[];
    nextCursor?: string;
  };
  expect(body.capsules.map((capsule) => capsule.id)).toEqual([
    "cap_0000",
    "cap_0002",
  ]);
  expect(body.capsules.every((capsule) => capsule.status !== "destroyed")).toBe(
    true,
  );
  expect(body.nextCursor).toBeUndefined();
});

test("GET /internal/v1/workspaces/:id/capsules rejects malformed includeDestroyed", async () => {
  const app = await makeApp(async (store) => {
    await store.putCapsule(capsuleFixture(0));
  });

  const res = await app.request(
    `/internal/v1/workspaces/${WORKSPACE_ID}/capsules?includeDestroyed=maybe`,
    { headers: AUTH },
  );
  expect(res.status).toBe(400);
});

test("GET /internal/v1/install-configs caps the shared+scoped union at 100 and pages the rest", async () => {
  // 80 operator-scoped configs + 170 Workspace-scoped configs are merged into
  // one sorted, paginated union. No provider-specific fallback catalog is
  // injected by the generic Capsule service.
  const shared = 80;
  const scoped = 170;
  const total = shared + scoped;
  const app = await makeApp(async (store) => {
    for (let i = 0; i < shared; i += 1) {
      await store.putInstallConfig(installConfigFixture(i));
    }
    for (let i = shared; i < shared + scoped; i += 1) {
      await store.putInstallConfig(installConfigFixture(i, WORKSPACE_ID));
    }
  });

  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    pages += 1;
    const base = `/internal/v1/install-configs?workspaceId=${WORKSPACE_ID}`;
    const url =
      cursor === undefined
        ? base
        : `${base}&cursor=${encodeURIComponent(cursor)}`;
    const res = await app.request(url, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installConfigs: { id: string }[];
      nextCursor?: string;
    };
    expect(body.installConfigs.length).toBeLessThanOrEqual(DEFAULT_PAGE_LIMIT);
    seen.push(...body.installConfigs.map((c) => c.id));
    if (body.nextCursor === undefined) break;
    cursor = body.nextCursor;
    if (pages > 10) throw new Error("cursor never terminated");
  }

  expect(pages).toBe(Math.ceil(total / DEFAULT_PAGE_LIMIT));
  expect(seen).toHaveLength(total);
  expect(new Set(seen).size).toBe(total); // no dupes
  // Merge-sorted by (createdAt, id) across the operator + Workspace union.
  const fixtureIds = Array.from(
    { length: shared + scoped },
    (_, i) => `cfg_${String(i).padStart(4, "0")}`,
  );
  expect(seen).toEqual(fixtureIds);
});

test("GET /internal/v1/install-configs?view=store excludes configs without Store presentation", async () => {
  const app = await makeApp(async (store) => {
    await store.putInstallConfig(storeInstallConfigFixture(0));
    await store.putInstallConfig(installConfigFixture(1));
    await store.putInstallConfig(storeInstallConfigFixture(2, WORKSPACE_ID));
  });

  const allResponse = await app.request("/internal/v1/install-configs", {
    headers: AUTH,
  });
  expect(allResponse.status).toBe(200);
  const all = (await allResponse.json()) as {
    installConfigs: { id: string }[];
  };
  expect(all.installConfigs.map((config) => config.id)).toEqual([
    "cfg_0000",
    "cfg_0001",
  ]);

  const storeResponse = await app.request(
    `/internal/v1/install-configs?workspaceId=${WORKSPACE_ID}&view=store`,
    { headers: AUTH },
  );
  expect(storeResponse.status).toBe(200);
  const storeView = (await storeResponse.json()) as {
    installConfigs: { id: string }[];
  };
  expect(storeView.installConfigs.map((config) => config.id)).toEqual([
    "cfg_0000",
  ]);
});

test("GET /internal/v1/install-configs rejects a malformed ?cursor= (400)", async () => {
  const app = await makeApp(async (store) => {
    await store.putInstallConfig(installConfigFixture(0));
  });
  const res = await app.request(
    `/internal/v1/install-configs?workspaceId=${WORKSPACE_ID}&cursor=not-a-cursor!!`,
    { headers: AUTH },
  );
  expect(res.status).toBe(400);
});
