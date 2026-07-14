import { afterEach, describe, expect, test } from "bun:test";
import {
  clearCurrentStateVersionCache,
  listCurrentStateVersionsCached,
} from "../../../../dashboard/src/lib/current-state-versions.ts";

const realFetch = globalThis.fetch;

function stubCurrentStateVersionFetch(): () => readonly string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : String(input));
    return new Response(
      JSON.stringify({
        stateVersions: [
          {
            id: "state_1",
            workspaceId: "space_1",
            capsuleId: "inst_1",
            environment: "prod",
            generation: 1,
            createdByRunId: "apply_1",
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => {
  clearCurrentStateVersionCache();
  globalThis.fetch = realFetch;
});

describe("listCurrentStateVersionsCached", () => {
  test("shares in-flight current StateVersion requests", async () => {
    const calls = stubCurrentStateVersionFetch();

    const [a, b] = await Promise.all([
      listCurrentStateVersionsCached("space_1", { includeDestroyed: false }),
      listCurrentStateVersionsCached("space_1", { includeDestroyed: false }),
    ]);

    expect(calls()).toEqual([
      "/api/v1/workspaces/space_1/current-state-versions?includeDestroyed=false",
    ]);
    expect(a).toEqual(b);
    expect(a[0]?.id).toBe("state_1");
  });
});
