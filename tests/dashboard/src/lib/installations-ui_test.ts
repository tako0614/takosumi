import { describe, expect, test } from "bun:test";
import {
  appSurfacesFromDeployment,
  appSurfaceFromInstallConfigStore,
  appSurfacesFromOutputs,
  deploymentReadinessAfterApply,
  effectiveCapsuleStatus,
  isDeploymentOpenable,
  launchUrlFromDeployment,
  needsAttention,
  outputLabel,
  pendingNeedsAttention,
  publicLinkRowLabels,
  releaseActivationStatusForDeployment,
} from "../../../../dashboard/src/lib/capsules-ui.ts";
import type { ActivityEvent } from "../../../../dashboard/src/lib/control-api.ts";

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
  test("store service metadata declares a pending app surface before first apply", () => {
    expect(
      appSurfaceFromInstallConfigStore(
        {
          id: "cfg_yurucommu",
          name: "yurucommu",
          sourceKind: "first_party_capsule",
          trustLevel: "official",
          store: {
            order: 1,
            surface: "service",
            kind: "worker",
            provider: "cloudflare",
            suggestedName: "yurucommu",
            badge: { ja: "追加候補", en: "Installable" },
            name: { ja: "yurucommu", en: "yurucommu" },
            description: { ja: "コミュニティ", en: "Community" },
            iconUrl: "https://example.test/yurucommu.svg",
            inputs: [],
          },
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z",
        },
        "ja",
      ),
    ).toEqual({
      name: "yurucommu",
      image: "https://example.test/yurucommu.svg",
    });
  });

  test("derives the launch URL from install inputs when the module declares no URL output", () => {
    // An app whose OpenTofu module forgot to output its URL is still openable:
    // the public host is reconstructed from the public_endpoint projection +
    // the value we set at install (variableMapping).
    const surface = appSurfaceFromInstallConfigStore(
      {
        id: "cfg_app",
        name: "app",
        sourceKind: "first_party_capsule",
        trustLevel: "official",
        variableMapping: { public_subdomain: "photo-blog" },
        store: {
          order: 1,
          surface: "service",
          kind: "worker",
          provider: "cloudflare",
          suggestedName: "app",
          badge: { ja: "追加候補", en: "Installable" },
          name: { ja: "App", en: "App" },
          description: { ja: "アプリ", en: "App" },
          inputs: [],
          installExperience: {
            projections: [
              {
                kind: "public_endpoint",
                variables: { subdomain: "public_subdomain" },
                baseDomain: "app.takos.jp",
              },
            ],
          },
        },
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
      } as never,
      "ja",
    );
    expect(surface?.url).toBe("https://photo-blog.app.takos.jp");
  });

  test("store building blocks do not declare launcher app surfaces", () => {
    expect(
      appSurfaceFromInstallConfigStore(
        {
          id: "cfg_bucket",
          name: "bucket",
          sourceKind: "first_party_capsule",
          trustLevel: "official",
          store: {
            order: 1,
            surface: "building_block",
            kind: "storage",
            provider: "s3",
            suggestedName: "bucket",
            badge: { ja: "部品", en: "Block" },
            name: { ja: "Bucket", en: "Bucket" },
            description: { ja: "ストレージ", en: "Storage" },
            inputs: [],
          },
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z",
        },
        "ja",
      ),
    ).toBeUndefined();
  });

  test("falls back to a bare launch URL when no app metadata exists", () => {
    expect(appSurfacesFromOutputs({})).toEqual([]);
    expect(appSurfacesFromOutputs({ url: "https://x.test/" })).toEqual([
      { url: "https://x.test/" },
    ]);
    expect(appSurfacesFromOutputs({ launch_url: "https://x.test/" })).toEqual([
      { url: "https://x.test/" },
    ]);
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

  test("app_deployment publish declares launcher surfaces for installed apps", () => {
    const surfaces = appSurfacesFromOutputs({
      launch_url: "https://yuru.test/",
      app_deployment: {
        contractVersion: 1,
        name: "yurucommu",
        publish: [
          {
            name: "launcher",
            publisher: "web",
            type: "interface.ui.surface",
            outputs: { url: { kind: "url", routeRef: "root" } },
            display: {
              title: "Yurucommu",
              description: "Self-hosted social app",
              icon: "/icons/yurucommu.svg",
              category: "social",
            },
            spec: { launcher: true },
          },
        ],
      },
    });

    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.name).toBe("Yurucommu");
    expect(surfaces[0]?.icon).toBe("https://yuru.test/icons/yurucommu.svg");
    expect(surfaces[0]?.url).toBe("https://yuru.test/");
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

describe("publicLinkRowLabels", () => {
  test("keeps friendly labels while they are unique", () => {
    const entries: [string, unknown][] = [
      ["launch_url", "https://a.test/"],
      ["endpoint", "https://b.test/"],
    ];
    expect(publicLinkRowLabels(entries)).toEqual([
      outputLabel("launch_url"),
      outputLabel("endpoint"),
    ]);
  });

  test("colliding friendly labels fall back to the humanized raw key", () => {
    // launch_url and app_url map to the SAME friendly label key in every
    // locale (公開アドレス ×N was the live Takos Office defect); url stays
    // distinct and keeps its friendly label.
    const entries: [string, unknown][] = [
      ["launch_url", "https://a.test/"],
      ["url", "https://b.test/"],
      ["app_url", "https://c.test/"],
    ];
    const labels = publicLinkRowLabels(entries);
    expect(labels[0]).toBe("Launch URL");
    expect(labels[1]).toBe(outputLabel("url"));
    expect(labels[2]).toBe("App URL");
    expect(new Set(labels).size).toBe(3);
  });

  test("keys that also humanize identically get host+path disambiguation", () => {
    const entries: [string, unknown][] = [
      ["site_url", "https://a.test/"],
      ["siteUrl", "https://b.test/admin"],
    ];
    expect(publicLinkRowLabels(entries)).toEqual([
      "Site URL (a.test)",
      "Site URL (b.test/admin)",
    ]);
  });
});

describe("release activation launch gating", () => {
  const deployment = {
    id: "dep_1",
    installationId: "cap_1",
    applyRunId: "apply_1",
    status: "active",
    outputsPublic: {
      app_name: "Yurucommu",
      launch_url: "https://yuru.test/",
      takosumi_release: {
        post_apply: [{ command: ["bun", "run", "release"] }],
      },
    },
  };
  const hiddenReleaseDeployment = {
    ...deployment,
    outputsPublic: {
      app_name: "Yurucommu",
      launch_url: "https://yuru.test/",
    },
  };

  function activity(
    action: string,
    metadata: Record<string, unknown> = {},
  ): ActivityEvent {
    return {
      id: `act_${action}`,
      workspaceId: "space_1",
      spaceId: "space_1",
      action,
      targetType: "deployment",
      targetId: "dep_1",
      runId: "apply_1",
      metadata: {
        installationId: "cap_1",
        deploymentId: "dep_1",
        applyRunId: "apply_1",
        ...metadata,
      },
      createdAt: "2026-06-30T19:00:00.000Z",
    };
  }

  test("requires activation success before a takosumi_release URL opens", () => {
    expect(deploymentReadinessAfterApply(undefined, [], "cap_1")).toBe(
      "settling",
    );
    expect(releaseActivationStatusForDeployment(deployment, [], "cap_1")).toBe(
      "pending",
    );
    expect(deploymentReadinessAfterApply(deployment, [], "cap_1")).toBe(
      "activation_pending",
    );
    expect(isDeploymentOpenable(deployment, [], "cap_1")).toBe(false);
    expect(launchUrlFromDeployment(deployment, [], "cap_1")).toBeUndefined();
  });

  test("opens only after the matching release activation succeeds", () => {
    const events = [activity("release_activation.succeeded")];
    expect(
      releaseActivationStatusForDeployment(deployment, events, "cap_1"),
    ).toBe("succeeded");
    expect(deploymentReadinessAfterApply(deployment, events, "cap_1")).toBe(
      "ready",
    );
    expect(isDeploymentOpenable(deployment, events, "cap_1")).toBe(
      true,
    );
    expect(launchUrlFromDeployment(deployment, events, "cap_1")).toBe(
      "https://yuru.test/",
    );
  });

  test("marks matching release activation failure as a failed deployment completion", () => {
    const events = [activity("release_activation.failed")];
    expect(
      releaseActivationStatusForDeployment(deployment, events, "cap_1"),
    ).toBe("failed");
    expect(deploymentReadinessAfterApply(deployment, events, "cap_1")).toBe(
      "activation_failed",
    );
    expect(isDeploymentOpenable(deployment, events, "cap_1")).toBe(
      false,
    );
  });

  test("does not reuse a previous apply's activation success", () => {
    const current = activity("release_activation.succeeded");
    const previous = {
      ...current,
      targetId: "dep_previous",
      runId: "apply_previous",
      metadata: {
        ...current.metadata,
        deploymentId: "dep_previous",
        applyRunId: "apply_previous",
      },
    };
    expect(
      releaseActivationStatusForDeployment(deployment, [previous], "cap_1"),
    ).toBe("pending");
    expect(deploymentReadinessAfterApply(deployment, [previous], "cap_1")).toBe(
      "activation_pending",
    );
  });

  test("uses release activity when takosumi_release is hidden from public outputs", () => {
    const events = [activity("release_activation.pending")];
    expect(
      releaseActivationStatusForDeployment(
        hiddenReleaseDeployment,
        events,
        "cap_1",
      ),
    ).toBe("pending");
    expect(
      isDeploymentOpenable(hiddenReleaseDeployment, events, "cap_1"),
    ).toBe(false);
    expect(
      launchUrlFromDeployment(hiddenReleaseDeployment, events, "cap_1"),
    ).toBeUndefined();
  });

  test("opens hidden-release deployments after matching release activity succeeds", () => {
    const events = [activity("release_activation.succeeded")];
    expect(
      releaseActivationStatusForDeployment(
        hiddenReleaseDeployment,
        events,
        "cap_1",
      ),
    ).toBe("succeeded");
    expect(
      launchUrlFromDeployment(hiddenReleaseDeployment, events, "cap_1"),
    ).toBe("https://yuru.test/");
  });

  test("keeps launcher tiles on the service screen while activation is pending", () => {
    expect(appSurfacesFromDeployment(deployment, [], "cap_1")).toEqual([
      { name: "Yurucommu", icon: undefined, image: undefined, url: undefined },
    ]);
    expect(
      appSurfacesFromDeployment(
        deployment,
        [activity("release_activation.succeeded")],
        "cap_1",
      ),
    ).toEqual([
      {
        name: "Yurucommu",
        icon: undefined,
        image: undefined,
        url: "https://yuru.test/",
      },
    ]);
  });

  test("does not require activation for direct OpenTofu deploy outputs", () => {
    const direct = {
      ...deployment,
      outputsPublic: {
        app_name: "Hello",
        launch_url: "https://hello.test/",
      },
    };
    expect(releaseActivationStatusForDeployment(direct, [], "cap_1")).toBe(
      "not_required",
    );
    expect(deploymentReadinessAfterApply(direct, [], "cap_1")).toBe("ready");
    expect(launchUrlFromDeployment(direct, [], "cap_1")).toBe(
      "https://hello.test/",
    );
  });
});
