import { afterEach, describe, expect, test } from "bun:test";
import {
  clearInstallConfigListCache,
  listInstallConfigsCached,
  TEMPLATE_CATALOG_VIEW,
} from "../../../../dashboard/src/lib/install-config-list.ts";

const realFetch = globalThis.fetch;

function stubInstallConfigFetch(): () => readonly string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : String(input));
    return new Response(
      JSON.stringify({
        installConfigs: [
          {
            id: "cfg_1",
            name: "Worker",
            sourceKind: "first_party_capsule",
            trustLevel: "official",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => {
  clearInstallConfigListCache();
  globalThis.fetch = realFetch;
});

describe("listInstallConfigsCached", () => {
  test("shares in-flight InstallConfig requests per Workspace and view", async () => {
    const calls = stubInstallConfigFetch();

    const [a, b] = await Promise.all([
      listInstallConfigsCached("space_1", { view: TEMPLATE_CATALOG_VIEW }),
      listInstallConfigsCached("space_1", { view: TEMPLATE_CATALOG_VIEW }),
    ]);

    expect(calls()).toEqual([
      `/api/v1/capsule-configs?workspaceId=space_1&view=${TEMPLATE_CATALOG_VIEW}`,
    ]);
    expect(a).toEqual(b);
    expect(a[0]?.id).toBe("cfg_1");
  });

  test("separates all-config and template catalog cache entries", async () => {
    const calls = stubInstallConfigFetch();

    await listInstallConfigsCached("space_1");
    await listInstallConfigsCached("space_1", { view: TEMPLATE_CATALOG_VIEW });

    expect(calls()).toEqual([
      "/api/v1/capsule-configs?workspaceId=space_1",
      `/api/v1/capsule-configs?workspaceId=space_1&view=${TEMPLATE_CATALOG_VIEW}`,
    ]);
  });
});
