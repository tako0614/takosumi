import { afterEach, describe, expect, test } from "bun:test";
import {
  clearCapsuleListCache,
  listCapsulesCached,
} from "../../../../dashboard/src/lib/capsule-list.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  clearCapsuleListCache();
  globalThis.fetch = realFetch;
});

describe("launcher Capsule list", () => {
  test("follows the bounded cursor without requesting overview or duplicating page one", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      const cursor = new URL(path, "https://dashboard.test").searchParams.get(
        "cursor",
      );
      return Response.json(
        cursor === "cursor_next"
          ? { capsules: [{ id: "capsule_2" }] }
          : {
              capsules: [{ id: "capsule_1" }],
              nextCursor: "cursor_next",
            },
      );
    }) as typeof fetch;

    const first = await listCapsulesCached("workspace_1", {
      includeDestroyed: false,
    });
    const cached = await listCapsulesCached("workspace_1", {
      includeDestroyed: false,
    });

    expect(first.map((capsule) => capsule.id)).toEqual([
      "capsule_1",
      "capsule_2",
    ]);
    expect(cached).toEqual(first);
    expect(calls).toEqual([
      "/api/v1/workspaces/workspace_1/capsules?includeDestroyed=false",
      "/api/v1/workspaces/workspace_1/capsules?includeDestroyed=false&cursor=cursor_next",
    ]);
    expect(
      calls.some((path) => path.includes("/dashboard/overview")),
    ).toBeFalse();
  });
});
