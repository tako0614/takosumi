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
  AccessibleApp,
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

function accessibleApp(
  capsuleId: string,
  name: string,
  role: AccessibleApp["role"],
): AccessibleApp {
  return {
    capsuleId,
    name,
    role,
    ownerDisplayName: "Owner",
    state: "installed",
    primaryAction: "open",
  } as AccessibleApp;
}

describe("loadConnectionUsage", () => {
  test("personal connections inspect only apps owned by the caller", async () => {
    const bindingReads: string[] = [];
    const usage = await loadConnectionUsage(undefined, {
      listAccessibleApps: async () => [
        accessibleApp("cap_owner", "Owned app", "owner"),
        accessibleApp("cap_member", "Member app", "member"),
      ],
      listCapsules: async () => {
        throw new Error("personal app list must not use workspace fallback");
      },
      getBindingSet: async (capsuleId) => {
        bindingReads.push(capsuleId);
        return bindings(capsuleId, ["pc_personal"]);
      },
    });
    expect(bindingReads).toEqual(["cap_owner"]);
    expect(usage.incomplete).toBe(false);
    expect(usage.appsByConnection.get("pc_personal")).toEqual([
      { capsuleId: "cap_owner", name: "Owned app" },
    ]);
  });

  test("apps 404 falls back only to a known legacy workspace", async () => {
    let fallbackWorkspace: string | undefined;
    const withWorkspace = await loadConnectionUsage("ws_legacy", {
      listAccessibleApps: async () => undefined,
      listCapsules: async (workspaceId) => {
        fallbackWorkspace = workspaceId;
        return [capsule("cap_legacy", "Legacy app")];
      },
      getBindingSet: async (capsuleId) => bindings(capsuleId, ["pc_legacy"]),
    });
    expect(fallbackWorkspace).toBe("ws_legacy");
    expect(withWorkspace.incomplete).toBe(false);
    expect(withWorkspace.appsByConnection.get("pc_legacy")).toEqual([
      { capsuleId: "cap_legacy", name: "Legacy app" },
    ]);

    let fallbackCalled = false;
    const withoutWorkspace = await loadConnectionUsage(undefined, {
      listAccessibleApps: async () => undefined,
      listCapsules: async () => {
        fallbackCalled = true;
        return [];
      },
      getBindingSet: async () => null,
    });
    expect(fallbackCalled).toBe(false);
    expect(withoutWorkspace.appsByConnection.size).toBe(0);
    expect(withoutWorkspace.incomplete).toBe(true);
  });

  test("an app-list authorization/service error is not hidden by legacy workspace data", async () => {
    let fallbackCalled = false;
    let thrown: unknown;
    try {
      await loadConnectionUsage("ws_legacy", {
        listAccessibleApps: async () => {
          throw new Error("403");
        },
        listCapsules: async () => {
          fallbackCalled = true;
          return [capsule("cap_legacy", "Legacy app")];
        },
        getBindingSet: async () => bindings("cap_legacy", ["pc_legacy"]),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new Error("403"));
    expect(fallbackCalled).toBe(false);
  });

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
