import { afterEach, describe, expect, test } from "bun:test";
import {
  abandonUnappliedCapsule,
  capsuleAbandonmentCompleted,
  deleteCapsule,
} from "../../../../dashboard/src/lib/control-api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Capsule DELETE", () => {
  test("defaults to scheduling deletion and can explicitly request a destroy Plan", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ capsule: { id: "cap_1" }, graceDays: 7 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(deleteCapsule("cap_1")).resolves.toMatchObject({ graceDays: 7 });
    await expect(deleteCapsule("cap_1", { immediate: false })).resolves.toMatchObject({
      graceDays: 7,
    });
    await expect(deleteCapsule("cap_1", { immediate: true })).resolves.toMatchObject({
      graceDays: 7,
    });
    expect(calls).toEqual([
      { url: "/api/v1/capsules/cap_1", method: "DELETE" },
      { url: "/api/v1/capsules/cap_1?immediate=false", method: "DELETE" },
      { url: "/api/v1/capsules/cap_1?immediate=true", method: "DELETE" },
    ]);
  });
});

describe("Capsule abandonment readback", () => {
  const expected = { id: "cap_1", workspaceId: "ws_1" };
  const destroyedCapsule = {
    id: "cap_1",
    workspaceId: "ws_1",
    name: "service",
    slug: "service",
    sourceId: "src_1",
    installConfigId: "cfg_1",
    environment: "production",
    currentStateGeneration: 0,
    status: "destroyed",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:01:00.000Z",
  };

  test("confirms an acknowledged abandonment without a body by reading the same Capsule without cache", async () => {
    const calls: { path: string; method?: string; cache?: RequestCache }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(input), method: init?.method, cache: init?.cache });
      return init?.method === "POST"
        ? new Response(null, { status: 202 })
        : Response.json({ capsule: destroyedCapsule });
    }) as typeof fetch;
    await expect(abandonUnappliedCapsule(expected)).resolves.toBe(true);
    expect(calls).toEqual([
      { path: "/api/v1/capsules/cap_1/abandon", method: "POST", cache: undefined },
      { path: "/api/v1/capsules/cap_1", method: "GET", cache: "no-store" },
    ]);
  });

  test("accepts the first response and a lost-ack retry only with destroyed readback", () => {
    expect(
      capsuleAbandonmentCompleted(
        {
          abandoned: true,
          capsule: destroyedCapsule,
        },
        expected,
      ),
    ).toBe(true);
    expect(
      capsuleAbandonmentCompleted(
        {
          alreadyDeleted: true,
          capsule: destroyedCapsule,
        },
        expected,
      ),
    ).toBe(true);
    expect(
      capsuleAbandonmentCompleted(
        {
          alreadyDeleted: true,
          capsule: { ...destroyedCapsule, status: "active" },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      capsuleAbandonmentCompleted(
        {
          abandoned: true,
          capsule: { ...destroyedCapsule, id: "cap_other" },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      capsuleAbandonmentCompleted(
        {
          abandoned: true,
          capsule: { ...destroyedCapsule, currentStateGeneration: 1 },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      capsuleAbandonmentCompleted(
        { abandoned: true, capsule: { status: "destroyed" } },
        expected,
      ),
    ).toBe(false);
    expect(capsuleAbandonmentCompleted({ abandoned: true }, expected)).toBe(
      false,
    );
    expect(capsuleAbandonmentCompleted(null, expected)).toBe(false);
  });
});
