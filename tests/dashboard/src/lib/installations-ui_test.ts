import { describe, expect, test } from "bun:test";
import {
  appSurfacesFromOutputs,
  effectiveCapsuleStatus,
  needsAttention,
  pendingNeedsAttention,
} from "../../../../dashboard/src/lib/capsules-ui.ts";

describe("installation presentation status", () => {
  const now = Date.parse("2026-06-25T12:00:00.000Z");

  test("keeps recent pending services as normal setup", () => {
    const inst = {
      status: "pending",
      updatedAt: "2026-06-25T11:45:01.000Z",
    };
    expect(pendingNeedsAttention(inst, { now })).toBe(false);
    expect(effectiveCapsuleStatus(inst, { now })).toBe("pending");
    expect(needsAttention(inst, { now })).toBe(false);
  });

  test("turns old pending services into needs-attention presentation", () => {
    const inst = {
      status: "pending",
      updatedAt: "2026-06-25T11:29:59.000Z",
    };
    expect(pendingNeedsAttention(inst, { now })).toBe(true);
    expect(effectiveCapsuleStatus(inst, { now })).toBe("needs_attention");
    expect(needsAttention(inst, { now })).toBe(true);
  });

  test("preserves derived stale status ahead of stored active", () => {
    expect(
      effectiveCapsuleStatus({
        status: "active",
        freshness: "stale",
        updatedAt: "2026-06-25T01:00:00.000Z",
      }),
    ).toBe("stale");
  });
});

describe("appSurfacesFromOutputs", () => {
  test("returns [] without app metadata — a bare launch URL is not an app", () => {
    expect(appSurfacesFromOutputs({})).toEqual([]);
    expect(appSurfacesFromOutputs({ url: "https://x.test/" })).toEqual([]);
    expect(appSurfacesFromOutputs({ launch_url: "https://x.test/" })).toEqual(
      [],
    );
  });

  test("flat form: app_name + generic launch URL fallback", () => {
    const surfaces = appSurfacesFromOutputs({
      app_name: "Blog",
      launch_url: "https://blog.test/",
    });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.name).toBe("Blog");
    expect(surfaces[0]?.url).toBe("https://blog.test/");
  });

  test("flat form: an icon alone declares an app (name filled in by the view)", () => {
    const surfaces = appSurfacesFromOutputs({ app_icon: "📝" });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.icon).toBe("📝");
    expect(surfaces[0]?.name).toBeUndefined();
  });

  test("`apps` array yields one surface per entry, in order", () => {
    const surfaces = appSurfacesFromOutputs({
      apps: [
        {
          name: "My Blog",
          image: "https://blog.test/cover.png",
          url: "https://blog.test/",
        },
        { name: "管理画面", icon: "⚙️", url: "https://blog.test/admin" },
      ],
    });
    expect(surfaces.map((s) => s.name)).toEqual(["My Blog", "管理画面"]);
    expect(surfaces[0]?.image).toBe("https://blog.test/cover.png");
    expect(surfaces[1]?.url).toBe("https://blog.test/admin");
  });

  test("drops nameless object/array entries", () => {
    const surfaces = appSurfacesFromOutputs({
      apps: [{ url: "https://blog.test/" }, { name: "Ok" }],
    });
    expect(surfaces.map((s) => s.name)).toEqual(["Ok"]);
  });

  test("`app` object (single) is supported; its own url only, no launch fallback", () => {
    const surfaces = appSurfacesFromOutputs({
      app: { name: "Site", image: "https://s.test/logo.png" },
      launch_url: "https://s.test/",
    });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.name).toBe("Site");
    expect(surfaces[0]?.image).toBe("https://s.test/logo.png");
    expect(surfaces[0]?.url).toBeUndefined();
  });

  test("ignores non-https values for image / url", () => {
    const surfaces = appSurfacesFromOutputs({
      app_name: "X",
      app_image: "not-a-url",
      app_url: "javascript:alert(1)",
    });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.image).toBeUndefined();
    expect(surfaces[0]?.url).toBeUndefined();
  });
});
