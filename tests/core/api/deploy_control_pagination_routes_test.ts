/**
 * Keyset-pagination behaviour over the §30 deploy-control list routes
 * (installations / connections). Asserts: a default (no `?limit=`) list caps at
 * 100 rows + emits a `nextCursor`; the cursor pages the remainder with no gaps
 * or dupes across the `(createdAt, id)` boundary; an explicit `?limit=` is
 * honoured/clamped; a malformed `?limit=` / `?cursor=` is a 400.
 */
import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuDeploymentController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
import { CapsulesService } from "../../../core/domains/capsules/mod.ts";
import { officialInstallConfigs } from "../../../core/domains/capsules/official_seed.ts";
import type { Connection } from "takosumi-contract/connections";
import type {
  Installation,
  InstallConfig,
} from "takosumi-contract/install-configs";
import { DEFAULT_PAGE_LIMIT } from "takosumi-contract/pagination";

const SPACE_ID = "space_pagination01";

function connectionFixture(i: number): Connection {
  const seq = String(i).padStart(4, "0");
  return {
    id: `conn_${seq}`,
    spaceId: SPACE_ID,
    provider: "cloudflare",
    scope: "space",
    authMethod: "static_token",
    status: "active",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: `2026-01-01T00:00:00.${seq}Z`,
    updatedAt: `2026-01-01T00:00:00.${seq}Z`,
  };
}

function installationFixture(i: number): Installation {
  const seq = String(i).padStart(4, "0");
  return {
    id: `inst_${seq}`,
    spaceId: SPACE_ID,
    name: `app-${seq}`,
    slug: `app-${seq}`,
    environment: "production",
    installType: "core",
    installConfigId: "cfg_test",
    currentStateGeneration: 0,
    status: "active",
    createdAt: `2026-01-01T00:00:00.${seq}Z`,
    updatedAt: `2026-01-01T00:00:00.${seq}Z`,
  } satisfies Installation;
}

function installConfigFixture(
  i: number,
  spaceId?: string,
): InstallConfig {
  const seq = String(i).padStart(4, "0");
  return {
    id: `cfg_${seq}`,
    ...(spaceId !== undefined ? { spaceId } : {}),
    name: `config-${seq}`,
    installType: "core",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: `2026-01-01T00:00:00.${seq}Z`,
    updatedAt: `2026-01-01T00:00:00.${seq}Z`,
  } satisfies InstallConfig;
}

async function makeApp(seed: (store: InMemoryOpenTofuDeploymentStore) => Promise<void>) {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seed(store);
  const controller = new OpenTofuDeploymentController({ store });
  const installationsService = new CapsulesService({ store });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller,
      installationsService,
      authorizeDeployControlBearer: ({ token }) =>
        token === "scoped-token"
          ? {
              actor: "acct_1",
              spaceIds: [SPACE_ID],
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
        ? `/internal/v1/connections?spaceId=${SPACE_ID}`
        : `/internal/v1/connections?spaceId=${SPACE_ID}&cursor=${encodeURIComponent(cursor)}`;
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
  const expected = Array.from({ length: total }, (_, i) =>
    `conn_${String(i).padStart(4, "0")}`,
  );
  expect(seen).toEqual(expected); // ordered, no gaps
});

test("GET /internal/v1/connections honours an explicit ?limit=", async () => {
  const app = await makeApp(async (store) => {
    for (let i = 0; i < 10; i += 1) await store.putConnection(connectionFixture(i));
  });
  const res = await app.request(
    `/internal/v1/connections?spaceId=${SPACE_ID}&limit=3`,
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
    `/internal/v1/connections?spaceId=${SPACE_ID}&limit=-1`,
    { headers: AUTH },
  );
  expect(badLimit.status).toBe(400);
  const badCursor = await app.request(
    `/internal/v1/connections?spaceId=${SPACE_ID}&cursor=not-a-cursor!!`,
    { headers: AUTH },
  );
  expect(badCursor.status).toBe(400);
});

test("GET /internal/v1/workspaces/:id/capsules caps the default page at 100 and emits a cursor", async () => {
  const total = 150;
  const app = await makeApp(async (store) => {
    for (let i = 0; i < total; i += 1) {
      await store.putInstallation(installationFixture(i));
    }
  });
  const res = await app.request(
    `/internal/v1/workspaces/${SPACE_ID}/capsules`,
    { headers: AUTH },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    installations: { id: string }[];
    nextCursor?: string;
  };
  expect(body.installations).toHaveLength(DEFAULT_PAGE_LIMIT);
  expect(body.nextCursor).toBeDefined();

  const next = await app.request(
    `/internal/v1/workspaces/${SPACE_ID}/capsules?cursor=${encodeURIComponent(body.nextCursor!)}`,
    { headers: AUTH },
  );
  const nextBody = (await next.json()) as {
    installations: { id: string }[];
    nextCursor?: string;
  };
  expect(nextBody.installations).toHaveLength(total - DEFAULT_PAGE_LIMIT);
  expect(nextBody.nextCursor).toBeUndefined();
  // No overlap across the page boundary.
  const firstIds = new Set(body.installations.map((r) => r.id));
  for (const row of nextBody.installations) {
    expect(firstIds.has(row.id)).toBe(false);
  }
});

test("GET /internal/v1/install-configs caps the official+scoped union at 100 and pages the rest", async () => {
  // 80 stored official (spaceId-less) + built-in official fallback configs +
  // 170 space-scoped configs are merged into one sorted, paginated union.
  const official = 80;
  const scoped = 170;
  const fallbackOfficialIds = officialInstallConfigs({
    now: () => new Date("2026-06-20T00:00:00.000Z"),
  })
    .map((config) => config.id)
    .sort();
  const total = official + scoped + fallbackOfficialIds.length;
  const app = await makeApp(async (store) => {
    for (let i = 0; i < official; i += 1) {
      await store.putInstallConfig(installConfigFixture(i));
    }
    for (let i = official; i < official + scoped; i += 1) {
      await store.putInstallConfig(installConfigFixture(i, SPACE_ID));
    }
  });

  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    pages += 1;
    const base = `/internal/v1/install-configs?spaceId=${SPACE_ID}`;
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
  // Merge-sorted by (createdAt, id) across the union: fixture rows first, then
  // the built-in official fallback configs created by CapsulesService.
  const fixtureIds = Array.from(
    { length: official + scoped },
    (_, i) => `cfg_${String(i).padStart(4, "0")}`,
  );
  expect(seen).toEqual([...fixtureIds, ...fallbackOfficialIds]);
});

test("GET /internal/v1/install-configs rejects a malformed ?cursor= (400)", async () => {
  const app = await makeApp(async (store) => {
    await store.putInstallConfig(installConfigFixture(0));
  });
  const res = await app.request(
    `/internal/v1/install-configs?spaceId=${SPACE_ID}&cursor=not-a-cursor!!`,
    { headers: AUTH },
  );
  expect(res.status).toBe(400);
});
