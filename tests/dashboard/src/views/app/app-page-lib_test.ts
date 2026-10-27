/**
 * Behavior of the installed-app page logic (TASK-0115): the state each app is
 * in, how versions read, which run is the app's problem, how history is told,
 * how created resources are grouped, and that an unknown cost stays unknown.
 */
import { describe, expect, test } from "bun:test";
import {
  appCostState,
  appHistory,
  appState,
  appStateRank,
  capsuleRuns,
  groupInventoryResources,
  latestFailedRun,
  linkedApps,
  newerSnapshot,
  providerRowLabels,
  repositoryLabel,
  resourceTypeLabel,
  stateVersionLabels,
  versionLabel,
} from "../../../../../dashboard/src/lib/app-page.ts";
import { planResourceName } from "../../../../../dashboard/src/lib/run-plan-resources.ts";
import type {
  ActivityEvent,
  Capsule,
  PublicStateVersion,
  Run,
  SourceSnapshot,
} from "../../../../../dashboard/src/lib/control-api.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function capsule(patch: Partial<Capsule> = {}): Capsule {
  return {
    id: "cap_app",
    workspaceId: "ws_a",
    name: "office",
    slug: "office",
    installConfigId: "cfg_a",
    environment: "production",
    currentStateVersionId: "sv_2",
    currentStateGeneration: 2,
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

function run(patch: Partial<Run> & Pick<Run, "id" | "type" | "status" | "createdAt">): Run {
  return {
    workspaceId: "ws_a",
    capsuleId: "cap_app",
    createdBy: "sub_a",
    ...patch,
  };
}

function snapshot(id: string, ref: string, commit: string, fetchedAt: string): SourceSnapshot {
  return {
    id,
    origin: "git",
    workspaceId: "ws_a",
    sourceId: "src_a",
    url: "https://github.com/example/office.git",
    ref,
    resolvedCommit: commit,
    path: ".",
    archiveRef: "archive",
    archiveDigest: "sha256:x",
    archiveSizeBytes: 1,
    fetchedByRunId: "run_sync",
    fetchedAt,
  };
}

function stateVersion(id: string, generation: number, runId: string, createdAt: string): PublicStateVersion {
  return {
    id,
    workspaceId: "ws_a",
    capsuleId: "cap_app",
    environment: "production",
    generation,
    createdByRunId: runId,
    createdAt,
  };
}

describe("app state", () => {
  test("one state per app from the Capsule projection alone", () => {
    expect(appState(capsule())).toBe("ready");
    expect(appState(capsule({ freshness: "stale" }))).toBe("update_available");
    expect(appState(capsule({ status: "error" }))).toBe("needs_attention");
    expect(appState(capsule({ status: "disabled" }))).toBe("stopped");
    expect(appState(capsule({ status: "uninstalled" }))).toBe("uninstalling");
    expect(
      appState(capsule({ currentStateVersionId: undefined, currentStateGeneration: 0, status: "pending" }), {
        now: Date.parse("2026-10-01T00:05:00.000Z"),
      }),
    ).toBe("installing");
    // A first install stuck for a long time needs attention, not patience.
    expect(
      appState(capsule({ currentStateVersionId: undefined, currentStateGeneration: 0, status: "pending" }), {
        now: Date.parse("2026-10-02T00:00:00.000Z"),
      }),
    ).toBe("needs_attention");
    // A failed teardown is a problem, not a quiet scheduled uninstall.
    expect(
      appState(
        capsule({
          status: "error",
          uninstall: { phase: "destroying" } as Capsule["uninstall"],
        }),
      ),
    ).toBe("needs_attention");
  });

  test("Home lists what needs the person first", () => {
    const order = (["ready", "stopped", "installing", "update_available", "needs_attention", "uninstalling"] as const)
      .slice()
      .sort((a, b) => appStateRank(a) - appStateRank(b));
    expect(order).toEqual(["needs_attention", "update_available", "installing", "uninstalling", "stopped", "ready"]);
  });
});

describe("versions", () => {
  test("a version reads as tag or branch with the short commit; nothing is hidden", () => {
    expect(versionLabel("v1.2.0", COMMIT_A)).toBe("v1.2.0 · aaaaaaa");
    expect(versionLabel("main", COMMIT_B)).toBe("main · bbbbbbb");
    expect(versionLabel(COMMIT_A, COMMIT_A)).toBe("aaaaaaa");
    expect(versionLabel("HEAD", COMMIT_A)).toBe("aaaaaaa");
    expect(versionLabel("v2", undefined)).toBe("v2");
    expect(versionLabel(undefined, undefined)).toBeUndefined();
    expect(repositoryLabel("https://github.com/example/office.git")).toBe("github.com/example/office");
  });

  test("a newer version is the latest snapshot of the ref the app follows", () => {
    const adopted = { sourceSnapshotId: "snap_1", ref: "main", path: ".", resolvedCommit: COMMIT_A };
    const snapshots = [
      snapshot("snap_1", "main", COMMIT_A, "2026-10-01T00:00:00.000Z"),
      snapshot("snap_other", "v9", COMMIT_B, "2026-10-04T00:00:00.000Z"),
      snapshot("snap_2", "main", COMMIT_B, "2026-10-03T00:00:00.000Z"),
    ];
    expect(newerSnapshot(snapshots, adopted)?.id).toBe("snap_2");
    expect(newerSnapshot(snapshots.slice(0, 1), adopted)).toBeUndefined();
    expect(newerSnapshot(snapshots, undefined)).toBeUndefined();
  });
});

describe("problems", () => {
  test("the app's problem is its newest lifecycle run, only while that run failed", () => {
    const runs = capsuleRuns(
      [
        run({ id: "run_old_fail", type: "apply", status: "failed", createdAt: "2026-10-01T00:00:00.000Z" }),
        run({ id: "run_other_app", type: "apply", status: "failed", createdAt: "2026-10-05T00:00:00.000Z", capsuleId: "cap_other" }),
        run({ id: "run_sync", type: "source_sync", status: "failed", createdAt: "2026-10-05T00:00:00.000Z" }),
        run({ id: "run_new_ok", type: "apply", status: "succeeded", createdAt: "2026-10-02T00:00:00.000Z" }),
      ],
      "cap_app",
    );
    expect(runs.map((item) => item.id)).toEqual(["run_new_ok", "run_old_fail"]);
    expect(latestFailedRun(runs)).toBeUndefined();
    const failing = capsuleRuns(
      [run({ id: "run_fail", type: "plan", status: "failed", createdAt: "2026-10-03T00:00:00.000Z" }), ...runs],
      "cap_app",
    );
    expect(latestFailedRun(failing)?.id).toBe("run_fail");
    // A run the person cancelled or let expire is not a problem.
    expect(
      latestFailedRun(capsuleRuns([run({ id: "run_x", type: "plan", status: "expired", createdAt: "2026-10-04T00:00:00.000Z" })], "cap_app")),
    ).toBeUndefined();
  });
});

describe("history", () => {
  const snapshots = [
    snapshot("snap_1", "v1.0.0", COMMIT_A, "2026-10-01T00:00:00.000Z"),
    snapshot("snap_2", "v1.1.0", COMMIT_B, "2026-10-02T00:00:00.000Z"),
  ];
  const runs = [
    run({ id: "apply_1", type: "apply", status: "succeeded", sourceSnapshotId: "snap_1", createdAt: "2026-10-01T00:01:00.000Z" }),
    run({ id: "plan_2", type: "plan", status: "succeeded", sourceSnapshotId: "snap_2", createdAt: "2026-10-02T00:00:00.000Z" }),
    run({ id: "apply_2", type: "apply", status: "succeeded", planRunId: "plan_2", createdAt: "2026-10-02T00:01:00.000Z" }),
    run({ id: "apply_3", type: "apply", status: "succeeded", sourceSnapshotId: "snap_2", createdAt: "2026-10-03T00:01:00.000Z" }),
    run({ id: "apply_4", type: "apply", status: "succeeded", sourceSnapshotId: "snap_1", createdAt: "2026-10-04T00:01:00.000Z" }),
    run({ id: "apply_fail", type: "apply", status: "failed", createdAt: "2026-10-05T00:01:00.000Z", finishedAt: "2026-10-05T00:02:00.000Z" }),
  ];
  const versions = [
    stateVersion("sv_1", 1, "apply_1", "2026-10-01T00:02:00.000Z"),
    stateVersion("sv_2", 2, "apply_2", "2026-10-02T00:02:00.000Z"),
    stateVersion("sv_3", 3, "apply_3", "2026-10-03T00:02:00.000Z"),
    stateVersion("sv_4", 4, "apply_4", "2026-10-04T00:02:00.000Z"),
    stateVersion("sv_5", 5, "apply_unknown", "2026-10-06T00:02:00.000Z"),
  ];
  const activity: ActivityEvent[] = [
    {
      id: "act_1",
      workspaceId: "ws_a",
      action: "capsule.uninstall_scheduled",
      targetType: "capsule",
      targetId: "cap_app",
      metadata: { capsuleId: "cap_app" },
      createdAt: "2026-10-07T00:00:00.000Z",
    },
    {
      id: "act_other",
      workspaceId: "ws_a",
      action: "capsule.uninstall_scheduled",
      targetType: "capsule",
      targetId: "cap_other",
      metadata: { capsuleId: "cap_other" },
      createdAt: "2026-10-07T00:00:00.000Z",
    },
  ];

  test("tells install, update, settings and version changes newest first, each with its run", () => {
    const events = appHistory({ capsuleId: "cap_app", stateVersions: versions, runs, activity, snapshots });
    expect(events.map((event) => [event.kind, event.version, event.runId])).toEqual([
      ["uninstall_scheduled", undefined, undefined],
      ["change", undefined, "apply_unknown"],
      ["apply_failed", undefined, "apply_fail"],
      ["version", "v1.0.0 · aaaaaaa", "apply_4"],
      ["settings", undefined, "apply_3"],
      ["update", "v1.1.0 · bbbbbbb", "apply_2"],
      ["install", "v1.0.0 · aaaaaaa", "apply_1"],
    ]);
  });

  test("labels each applied version only from recorded snapshot evidence", () => {
    const labels = stateVersionLabels({ stateVersions: versions, runs, snapshots });
    expect(labels.get("sv_1")).toBe("v1.0.0 · aaaaaaa");
    expect(labels.get("sv_2")).toBe("v1.1.0 · bbbbbbb");
    expect(labels.has("sv_5")).toBe(false);
  });
});

describe("what the app created", () => {
  test("groups resources by cloud with readable names and counts, without raw addresses", () => {
    const groups = groupInventoryResources([
      { type: "cloudflare_workers_script", providerSource: "registry.opentofu.org/cloudflare/cloudflare" },
      { type: "cloudflare_d1_database", providerSource: "registry.opentofu.org/cloudflare/cloudflare" },
      { type: "cloudflare_d1_database", providerSource: "registry.opentofu.org/cloudflare/cloudflare" },
      { type: "aws_s3_bucket" },
    ]);
    expect(groups).toEqual([
      {
        key: "cloudflare",
        label: "Cloudflare",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        items: [
          { label: "D1 Database", count: 2 },
          { label: "Workers Script", count: 1 },
        ],
        total: 3,
      },
      { key: "aws", label: "AWS", items: [{ label: "S3 Bucket", count: 1 }], total: 1 },
    ]);
    expect(resourceTypeLabel("random_password", "random")).toBe("Password");
    expect(resourceTypeLabel("cloudflare", "cloudflare")).toBe("Cloudflare");
  });

  test("a review names each resource so two of one kind can be told apart", () => {
    expect(planResourceName({ address: "cloudflare_d1_database.cache", type: "cloudflare_d1_database" })).toBe("cache");
    expect(planResourceName({ address: "module.db.aws_db_instance.main[0]", type: "aws_db_instance" })).toBe("main[0]");
    expect(planResourceName({ address: "random_password", type: "random_password" })).toBeUndefined();
  });

  test("an unknown cost is unknown, never free", () => {
    expect(appCostState(undefined, { loading: false, failed: true })).toEqual({ kind: "unavailable" });
    expect(appCostState(undefined, { loading: true, failed: false })).toEqual({ kind: "loading" });
    const summary = { capsuleId: "cap_app", usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 };
    expect(appCostState(summary, { loading: false, failed: false })).toEqual({ kind: "not_recorded" });
    expect(appCostState({ ...summary, eventCount: 3, unratedEventCount: 3 }, { loading: false, failed: false })).toEqual({ kind: "unrated" });
    expect(
      appCostState({ ...summary, usdMicros: 1_250_000, eventCount: 3, ratedEventCount: 2, unratedEventCount: 1 }, { loading: false, failed: false }),
    ).toEqual({ kind: "rated", usdMicros: 1_250_000, unratedEventCount: 1 });
  });
});

describe("linked apps and connections", () => {
  test("names the apps this app uses and the apps that use it", () => {
    const graph = {
      nodes: [
        { capsuleId: "cap_app", name: "office" },
        { capsuleId: "cap_db", name: "database" },
        { capsuleId: "cap_web", name: "website" },
      ],
      edges: [
        { id: "dep_1", producerCapsuleId: "cap_db", consumerCapsuleId: "cap_app" },
        { id: "dep_2", producerCapsuleId: "cap_app", consumerCapsuleId: "cap_web" },
      ],
    };
    expect(linkedApps("cap_app", graph, "uses")).toEqual([{ edgeId: "dep_1", capsuleId: "cap_db", name: "database" }]);
    expect(linkedApps("cap_app", graph, "usedBy")).toEqual([{ edgeId: "dep_2", capsuleId: "cap_web", name: "website" }]);
    expect(linkedApps("cap_app", undefined, "uses")).toEqual([]);
  });

  test("a provider alias appears only to tell repeated providers apart", () => {
    const cloudflare = "registry.opentofu.org/cloudflare/cloudflare";
    expect(providerRowLabels([{ provider: cloudflare, childAlias: "edge" }])).toEqual(["Cloudflare"]);
    expect(
      providerRowLabels([
        { provider: cloudflare, childAlias: "edge" },
        { provider: cloudflare, rootAlias: "dns" },
        { provider: "registry.opentofu.org/hashicorp/aws" },
      ]),
    ).toEqual(["Cloudflare (edge)", "Cloudflare (dns)", "AWS"]);
  });
});
