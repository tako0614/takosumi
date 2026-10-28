/**
 * Behavior of the installed-app page logic (TASK-0115): Home's state for each
 * app, the words for the server's app view (state, primary action, problems,
 * unreadable parts), how versions read, how history is told from the app's
 * own Runs, how created resources are grouped, and that an unknown cost
 * stays unknown.
 */
import { describe, expect, test } from "bun:test";
import {
  APP_HISTORY_RUN_TYPES,
  appCostState,
  appInstalledRef,
  appPrimaryActionLabel,
  appPrimaryStep,
  appVersionChangeBusy,
  appRunHistory,
  appState,
  appStateRank,
  appStateSentence,
  appViewIncomplete,
  groupInventoryResources,
  linkedApps,
  mergeAppHistoryPages,
  openableScreens,
  primaryProblem,
  providerRowLabels,
  repositoryLabel,
  resourceTypeLabel,
  reviewPurposeForRun,
  stateVersionLabels,
  versionLabel,
} from "../../../../../dashboard/src/lib/app-page.ts";
import { planResourceName } from "../../../../../dashboard/src/lib/run-plan-resources.ts";
import type {
  Capsule,
  CapsuleAppAction,
  CapsuleAppView,
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
});

function appView(patch: Partial<CapsuleAppView> = {}): CapsuleAppView {
  return {
    kind: "takosumi.capsule-app@v1",
    capsuleId: "cap_app",
    workspaceId: "ws_a",
    projectId: "prj_a",
    name: "office",
    environment: "production",
    status: "active",
    applied: true,
    state: "installed",
    primaryAction: "open",
    problems: [],
    screens: [],
    version: { updateAvailable: false, stale: false, autoUpdate: false },
    progress: { revisionPreparing: false },
    uninstall: { mode: "scheduled", graceDays: 7 },
    observedAt: "2026-10-28T00:00:00.000Z",
    ...patch,
  };
}

describe("the server's app view", () => {
  test("the sentence says the server's state and what is under way", () => {
    expect(appStateSentence(appView())).toBe("app.state.sentence.ready");
    expect(appStateSentence(appView({ version: { updateAvailable: true, stale: false, autoUpdate: false } })))
      .toBe("app.state.sentence.updateAvailable");
    expect(appStateSentence(appView({ progress: { revisionPreparing: false, review: { runId: "run_p", runType: "plan" } } })))
      .toBe("app.state.sentence.changeWaiting");
    expect(appStateSentence(appView({ state: "needs_attention" }))).toBe("app.state.sentence.needsAttention");
    expect(appStateSentence(appView({ state: "installing", applied: false }))).toBe("app.state.sentence.installing");
    expect(
      appStateSentence(appView({ state: "installing", applied: false, progress: { revisionPreparing: false, review: { runId: "run_p", runType: "plan" } } })),
    ).toBe("app.state.sentence.installReview");
    expect(
      appStateSentence(appView({
        state: "updating",
        progress: { revisionPreparing: false, run: { id: "run_a", type: "apply", status: "running", createdAt: "2026-10-28T00:00:00.000Z" } },
      })),
    ).toBe("app.state.sentence.updating");
    expect(appStateSentence(appView({ state: "updating", progress: { revisionPreparing: true } })))
      .toBe("app.state.sentence.updatePreparing");
    expect(appStateSentence(appView({ state: "uninstall_scheduled" }))).toBe("app.state.sentence.uninstalling");
    expect(appStateSentence(appView({ state: "uninstalling" }))).toBe("app.state.sentence.uninstallingNow");
    expect(appStateSentence(appView({ state: "uninstalled" }))).toBe("app.state.sentence.uninstalled");
    expect(appStateSentence(appView({ state: "stopped" }))).toBe("app.state.sentence.stopped");
    // A state a newer server adds never reads as ready.
    expect(appStateSentence(appView({ state: "paused" as CapsuleAppView["state"] }))).toBe("app.state.sentence.unknown");
  });

  test("every primary action but Open and nothing-to-do has its own label", () => {
    const actions: readonly CapsuleAppAction[] = [
      "view_resources", "review", "retry", "retry_screen", "fix_connection",
      "continue_install", "cancel_uninstall", "uninstall_now", "reinstall",
    ];
    for (const action of actions) expect(appPrimaryActionLabel(action)).toBeDefined();
    expect(appPrimaryActionLabel("open")).toBeUndefined();
    expect(appPrimaryActionLabel("none")).toBeUndefined();
    expect(appPrimaryActionLabel("uninstall_now")).toBe("app.uninstall.now");
  });

  test("the primary problem is the first error; warnings never drive an action", () => {
    const view = appView({
      state: "needs_attention",
      primaryAction: "retry",
      problems: [
        { code: "run_failed", severity: "error", runId: "run_f", runType: "apply" },
        { code: "screen_unavailable", severity: "error" },
      ],
    });
    expect(primaryProblem(view)?.runId).toBe("run_f");
    expect(primaryProblem(appView({ problems: [{ code: "uninstall_scheduled", severity: "warning" }] }))).toBeUndefined();
  });

  test("a part the server could not read is named, not shown empty", () => {
    expect(appViewIncomplete(appView({ incomplete: ["screens"] }), "screens")).toBe(true);
    expect(appViewIncomplete(appView({ incomplete: ["screens"] }), "version")).toBe(false);
    expect(appViewIncomplete(appView(), "screens")).toBe(false);
    expect(appViewIncomplete(undefined, "screens")).toBe(false);
  });

  test("a run's review is an uninstall for a removal and an install before the first apply", () => {
    expect(reviewPurposeForRun("destroy_plan", true)).toBe("uninstall");
    expect(reviewPurposeForRun("plan", false)).toBe("install");
    expect(reviewPurposeForRun("plan", true)).toBe("apply");
  });
});

describe("what the page does with the server's view", () => {
  test("every primary action maps to one in-page step", () => {
    const failed = { code: "run_failed", severity: "error", runId: "run_f", runType: "apply" } as const;
    const blocked = { code: "policy_blocked", severity: "error", runId: "run_b", runType: "plan" } as const;
    const screen = { code: "screen_unavailable", severity: "error", screenFailure: { id: "f", failureDigest: "d", stateVersionId: "sv", stateGeneration: 1, errorCode: "e" } } as const;
    const cases: readonly (readonly [Partial<CapsuleAppView>, unknown])[] = [
      [{ primaryAction: "open" }, { kind: "open" }],
      [{ primaryAction: "view_resources" }, { kind: "show_created" }],
      [{ primaryAction: "review", progress: { revisionPreparing: false, review: { runId: "run_p", runType: "plan" } } }, { kind: "review", runId: "run_p", runType: "plan" }],
      [{ primaryAction: "review", problems: [blocked] }, { kind: "review", runId: "run_b", runType: "plan" }],
      [{ primaryAction: "review" }, { kind: "none" }],
      [{ primaryAction: "retry", problems: [failed] }, { kind: "retry", problem: failed }],
      [{ primaryAction: "retry", problems: [{ code: "capsule_error", severity: "error" }] }, { kind: "retry", problem: { code: "capsule_error", severity: "error" } }],
      [{ primaryAction: "retry_screen", problems: [screen] }, { kind: "retry_screen", problem: screen }],
      [{ primaryAction: "fix_connection" }, { kind: "fix_connection" }],
      [{ primaryAction: "continue_install" }, { kind: "continue_install" }],
      [{ primaryAction: "cancel_uninstall" }, { kind: "cancel_uninstall" }],
      [{ primaryAction: "uninstall_now" }, { kind: "uninstall_now" }],
      [{ primaryAction: "reinstall" }, { kind: "reinstall" }],
      [{ primaryAction: "none" }, { kind: "none" }],
      [{ primaryAction: "something_new" as CapsuleAppView["primaryAction"] }, { kind: "none" }],
    ];
    for (const [patch, step] of cases) {
      expect({ action: patch.primaryAction, step: appPrimaryStep(appView(patch)) }).toEqual({ action: patch.primaryAction, step });
    }
  });

  test("a version change waits while another change is under way or waiting for review", () => {
    expect(appVersionChangeBusy(appView())).toBe(false);
    expect(appVersionChangeBusy(appView({ state: "updating" }))).toBe(true);
    expect(appVersionChangeBusy(appView({ progress: { revisionPreparing: true } }))).toBe(true);
    expect(appVersionChangeBusy(appView({ progress: { revisionPreparing: false, review: { runId: "run_p", runType: "plan" } } }))).toBe(true);
    expect(appVersionChangeBusy(appView({ progress: { revisionPreparing: false, run: { id: "run_a", type: "apply", status: "running", createdAt: "2026-10-28T00:00:00.000Z" } } }))).toBe(true);
    // A preparation that stalled is continued or replaced, not waited on.
    expect(appVersionChangeBusy(appView({ progress: { revisionPreparing: false, revisionPlanId: "grp_stalled" } }))).toBe(false);
  });

  test("an installed app updates its own ref, never the Source's default ref", () => {
    const repository = { url: "https://github.com/example/office.git", defaultRef: "main" };
    const pinned = appView({ version: { repository, current: { sourceSnapshotId: "s", ref: "v2", path: ".", commit: COMMIT_A }, updateAvailable: false, stale: false, autoUpdate: false } });
    expect(appInstalledRef(pinned, undefined)).toBe("v2");
    // The server could not read the version: the Capsule's adopted revision decides.
    const unread = appView({ incomplete: ["version"], version: { repository, updateAvailable: false, stale: false, autoUpdate: false } });
    expect(appInstalledRef(unread, capsule({ adoptedSourceRevision: { sourceSnapshotId: "s", ref: "v2", path: ".", resolvedCommit: COMMIT_A } }))).toBe("v2");
    // Neither known: nothing to update — not the default ref.
    expect(appInstalledRef(unread, capsule())).toBeUndefined();
  });

  test("screens are linked only with absolute http(s) launch URLs", () => {
    const screen = (url: string, title?: string) => ({ interfaceId: url, name: "app.launcher", url, ...(title ? { title } : {}) });
    expect(openableScreens([
      screen("https://apps.example.test/a", "A"),
      screen("javascript:alert(1)"),
      screen("/relative"),
      screen("data:text/html,x"),
      screen("http://apps.example.test/b"),
    ])).toEqual([{ name: "A", url: "https://apps.example.test/a" }, { url: "http://apps.example.test/b" }]);
  });

  test("a refreshed first history page keeps the older pages it still reaches", () => {
    const r = (id: string) => run({ id, type: "apply", status: "succeeded", createdAt: "2026-10-01T00:00:00.000Z" });
    const older = { startCursor: "c1", runs: [r("run_3"), r("run_4")], nextCursor: "c2" };
    // Same first page: older pages kept, cursor continues after them.
    expect(mergeAppHistoryPages({ runs: [r("run_1"), r("run_2")], nextCursor: "c1" }, older)).toEqual({
      runs: [r("run_1"), r("run_2"), r("run_3"), r("run_4")], nextCursor: "c2",
    });
    // New runs pushed the first page down into the older ones: deduplicated.
    expect(mergeAppHistoryPages({ runs: [r("run_0"), r("run_1"), r("run_2"), r("run_3")], nextCursor: "c9" }, older).runs.map((item) => item.id))
      .toEqual(["run_0", "run_1", "run_2", "run_3", "run_4"]);
    // So many new runs that a gap could open: only the first page is kept.
    expect(mergeAppHistoryPages({ runs: [r("run_new")], nextCursor: "c_new" }, older)).toEqual({ runs: [r("run_new")], nextCursor: "c_new" });
    expect(mergeAppHistoryPages(undefined, older)).toEqual({ runs: [] });
  });
});

describe("history", () => {
  const snapshots = [
    snapshot("snap_1", "v1.0.0", COMMIT_A, "2026-10-01T00:00:00.000Z"),
    snapshot("snap_2", "v1.1.0", COMMIT_B, "2026-10-02T00:00:00.000Z"),
  ];
  // The server lists the app's own Runs newest first.
  const runs = [
    run({ id: "apply_unknown", type: "apply", status: "succeeded", createdAt: "2026-10-06T00:01:00.000Z", finishedAt: "2026-10-06T00:02:00.000Z" }),
    run({ id: "plan_blocked", type: "plan", status: "succeeded", policyStatus: "deny", createdAt: "2026-10-05T12:00:00.000Z", policyReasons: [{ code: "provider_not_allowed", layer: "provider", provider: "registry.opentofu.org/hashicorp/aws" }] }),
    run({ id: "plan_waiting", type: "destroy_plan", status: "waiting_approval", createdAt: "2026-10-05T06:00:00.000Z", policyReasons: [{ code: "approval_required_destroy", layer: "action" }] }),
    run({ id: "apply_fail", type: "apply", status: "failed", createdAt: "2026-10-05T00:01:00.000Z", finishedAt: "2026-10-05T00:02:00.000Z" }),
    run({ id: "apply_4", type: "apply", status: "succeeded", sourceSnapshotId: "snap_1", createdAt: "2026-10-04T00:01:00.000Z" }),
    run({ id: "plan_ok", type: "plan", status: "succeeded", policyStatus: "pass", createdAt: "2026-10-03T12:00:00.000Z" }),
    run({ id: "apply_3", type: "apply", status: "succeeded", sourceSnapshotId: "snap_2", createdAt: "2026-10-03T00:01:00.000Z" }),
    run({ id: "apply_2", type: "apply", status: "succeeded", planRunId: "plan_2", createdAt: "2026-10-02T00:01:00.000Z" }),
    run({ id: "plan_2", type: "plan", status: "succeeded", sourceSnapshotId: "snap_2", createdAt: "2026-10-02T00:00:00.000Z" }),
    run({ id: "apply_1", type: "apply", status: "succeeded", sourceSnapshotId: "snap_1", createdAt: "2026-10-01T00:01:00.000Z" }),
  ];
  const versions = [
    stateVersion("sv_1", 1, "apply_1", "2026-10-01T00:02:00.000Z"),
    stateVersion("sv_2", 2, "apply_2", "2026-10-02T00:02:00.000Z"),
    stateVersion("sv_3", 3, "apply_3", "2026-10-03T00:02:00.000Z"),
    stateVersion("sv_4", 4, "apply_4", "2026-10-04T00:02:00.000Z"),
    stateVersion("sv_5", 5, "apply_unknown", "2026-10-06T00:02:00.000Z"),
  ];

  test("is asked of the server for the app's lifecycle runs only", () => {
    expect([...APP_HISTORY_RUN_TYPES].sort()).toEqual(["apply", "destroy_apply", "destroy_plan", "plan", "state_recovery"]);
  });

  test("tells install, update, settings, version changes and stopped plans newest first, each with its run", () => {
    const events = appRunHistory({ runs, stateVersions: versions, snapshots });
    expect(events.map((event) => [event.kind, event.version, event.runId])).toEqual([
      ["change", undefined, "apply_unknown"],
      ["policy_blocked", undefined, "plan_blocked"],
      ["approval_waiting", undefined, "plan_waiting"],
      ["apply_failed", undefined, "apply_fail"],
      ["version", "v1.0.0 · aaaaaaa", "apply_4"],
      ["settings", undefined, "apply_3"],
      ["update", "v1.1.0 · bbbbbbb", "apply_2"],
      ["install", "v1.0.0 · aaaaaaa", "apply_1"],
    ]);
    // A policy event carries its structured reasons; a reviewed plan is not an event.
    expect(events.find((event) => event.runId === "plan_blocked")?.policyReasons).toEqual([
      { code: "provider_not_allowed", layer: "provider", provider: "registry.opentofu.org/hashicorp/aws" },
    ]);
    expect(events.find((event) => event.runId === "plan_waiting")?.policyReasons?.[0]?.code).toBe("approval_required_destroy");
    expect(events.some((event) => event.runId === "plan_ok" || event.runId === "plan_2")).toBe(false);
  });

  test("names the current version from the server when its snapshot is not loaded", () => {
    const events = appRunHistory({
      runs: [run({ id: "apply_1", type: "apply", status: "succeeded", createdAt: "2026-10-01T00:01:00.000Z" })],
      stateVersions: [stateVersion("sv_1", 1, "apply_1", "2026-10-01T00:02:00.000Z")],
      snapshots: [],
      current: { stateVersionId: "sv_1", ref: "main", commit: COMMIT_A },
    });
    expect(events).toEqual([{ key: "run:apply_1", kind: "install", at: "2026-10-01T00:01:00.000Z", runId: "apply_1", version: "main · aaaaaaa" }]);
  });

  test("a removal, a recovery and work under way read as such", () => {
    const events = appRunHistory({
      runs: [
        run({ id: "destroy_ok", type: "destroy_apply", status: "succeeded", createdAt: "2026-10-09T00:00:00.000Z" }),
        run({ id: "destroy_fail", type: "destroy_apply", status: "failed", createdAt: "2026-10-08T00:00:00.000Z" }),
        run({ id: "applying", type: "apply", status: "running", createdAt: "2026-10-07T00:00:00.000Z" }),
        run({ id: "recovered", type: "state_recovery", status: "succeeded", createdAt: "2026-10-06T00:00:00.000Z" }),
        run({ id: "cancelled", type: "apply", status: "cancelled", createdAt: "2026-10-05T00:00:00.000Z" }),
      ],
      stateVersions: [],
      snapshots: [],
    });
    expect(events.map((event) => [event.kind, event.runId])).toEqual([
      ["uninstall", "destroy_ok"],
      ["uninstall_failed", "destroy_fail"],
      ["applying", "applying"],
      ["recovered", "recovered"],
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
