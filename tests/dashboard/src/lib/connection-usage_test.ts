/**
 * Which apps use each connection (lib/connection-usage.ts): derived from each
 * app's provider bindings with a bounded fan-out, and honest when a read
 * fails.
 */
import { describe, expect, test } from "bun:test";
import {
  CONNECTION_USAGE_CONCURRENCY,
  loadConnectionUsage,
} from "../../../../dashboard/src/lib/connection-usage.ts";
import type {
  Capsule,
  ProviderBindingSet,
} from "../../../../dashboard/src/lib/control-api.ts";

function capsule(id: string, name: string, status = "active"): Capsule {
  return { id, name, slug: id, status } as unknown as Capsule;
}

function bindings(capsuleId: string, connectionIds: readonly string[]): ProviderBindingSet {
  return {
    id: `pbs_${capsuleId}`,
    workspaceId: "ws_1",
    capsuleId,
    environment: "production",
    bindings: connectionIds.map((connectionId) => ({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      connectionId,
    })),
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  };
}

describe("loadConnectionUsage", () => {
  test("maps each connection to the apps whose bindings name it, sorted by name", async () => {
    const usage = await loadConnectionUsage("ws_1", {
      listCapsules: async (workspaceId) => {
        expect(workspaceId).toBe("ws_1");
        return [
          capsule("cap_b", "Blog"),
          capsule("cap_a", "Analytics"),
          capsule("cap_gone", "Removed", "destroyed"),
        ];
      },
      getBindingSet: async (capsuleId) => {
        if (capsuleId === "cap_gone") throw new Error("destroyed apps are not read");
        if (capsuleId === "cap_a") return bindings("cap_a", ["pc_cf", "pc_cf", "pc_aws"]);
        return bindings("cap_b", ["pc_cf"]);
      },
    });
    expect(usage.incomplete).toBe(false);
    expect(usage.appsByConnection.get("pc_cf")).toEqual([
      { capsuleId: "cap_a", name: "Analytics" },
      { capsuleId: "cap_b", name: "Blog" },
    ]);
    expect(usage.appsByConnection.get("pc_aws")).toEqual([
      { capsuleId: "cap_a", name: "Analytics" },
    ]);
    expect(usage.appsByConnection.get("pc_unused")).toBeUndefined();
  });

  test("an unreadable app makes the result incomplete instead of 'unused'", async () => {
    const usage = await loadConnectionUsage("ws_1", {
      listCapsules: async () => [capsule("cap_a", "A"), capsule("cap_b", "B")],
      getBindingSet: async (capsuleId) => {
        if (capsuleId === "cap_b") throw new Error("503");
        return bindings(capsuleId, ["pc_cf"]);
      },
    });
    expect(usage.incomplete).toBe(true);
    expect(usage.appsByConnection.get("pc_cf")).toEqual([
      { capsuleId: "cap_a", name: "A" },
    ]);
  });

  test("apps without a binding set use no connection", async () => {
    const usage = await loadConnectionUsage("ws_1", {
      listCapsules: async () => [capsule("cap_a", "A")],
      getBindingSet: async () => null,
    });
    expect(usage.incomplete).toBe(false);
    expect(usage.appsByConnection.size).toBe(0);
  });

  test("binding reads run a bounded number at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const apps = Array.from({ length: 12 }, (_, i) => capsule(`cap_${i}`, `App ${i}`));
    await loadConnectionUsage("ws_1", {
      listCapsules: async () => apps,
      getBindingSet: async (capsuleId) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return bindings(capsuleId, []);
      },
    });
    expect(peak).toBeLessThanOrEqual(CONNECTION_USAGE_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
