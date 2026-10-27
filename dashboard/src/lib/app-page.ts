/**
 * Pure presentation logic for the installed-app page and the Home overview
 * (TASK-0115). The page is organised around what a person does with an
 * installed app — open it, keep it working, update it, change its settings,
 * see what it created and what it costs, uninstall it — so these helpers turn
 * the control-plane ledgers (Capsule, StateVersion, Run, Activity, resource
 * inventory, graph) into that vocabulary without inventing anything the
 * backend did not record.
 */
import { untrack, type Resource } from "solid-js";
import type {
  ActivityEvent,
  Capsule,
  CapsuleCurrentResourceInventory,
  CapsuleUsageSummary,
  GraphEdge,
  GraphNode,
  ProviderBinding,
  PublicStateVersion,
  Run,
  SourceSnapshot,
} from "./control-api.ts";
import { effectiveCapsuleStatus } from "./capsules-ui.ts";
import { readableProviderSourceLabel } from "./provider-labels.ts";

/**
 * The loaded value of a supporting read, kept while it refreshes, without
 * registering with the route's Suspense boundary. A failed read is simply
 * `undefined`; every section renders its own loading and failure state.
 */
export function settledValue<T>(resource: Resource<T>): T | undefined {
  const state = resource.state;
  return state === "ready" || state === "refreshing"
    ? untrack(() => resource.latest)
    : undefined;
}

// --- app state ---------------------------------------------------------------

/** What a person needs to know about an installed app at a glance. */
export type AppState =
  | "installing"
  | "ready"
  | "update_available"
  | "needs_attention"
  | "uninstalling"
  | "stopped";

/**
 * One state per app, derived from the Capsule projection only so Home can
 * show it for every app without per-app reads. The app page adds problems it
 * reads itself (a failed run, a screen that could not be made openable).
 */
export function appState(
  capsule: Pick<
    Capsule,
    | "status"
    | "freshness"
    | "updatedAt"
    | "currentStateVersionId"
    | "currentStateGeneration"
    | "uninstall"
  >,
  options: { readonly now?: number } = {},
): AppState {
  if (
    capsule.status === "uninstalled" ||
    capsule.uninstall?.phase === "destroying"
  ) {
    return capsule.status === "error" ? "needs_attention" : "uninstalling";
  }
  const status = effectiveCapsuleStatus(capsule, options);
  // Applied once a state exists, even where a projection omits its id.
  if (!capsule.currentStateVersionId && !(capsule.currentStateGeneration > 0)) {
    return status === "error" || status === "needs_attention"
      ? "needs_attention"
      : "installing";
  }
  if (status === "error" || status === "needs_attention") {
    return "needs_attention";
  }
  if (status === "disabled") return "stopped";
  if (status === "stale") return "update_available";
  return "ready";
}

/** Home order: what needs the person first, then alphabetical. */
export function appStateRank(state: AppState): number {
  switch (state) {
    case "needs_attention":
      return 0;
    case "update_available":
      return 1;
    case "installing":
      return 2;
    case "uninstalling":
      return 3;
    case "stopped":
      return 4;
    case "ready":
      return 5;
  }
}

// --- versions ------------------------------------------------------------------

const FULL_COMMIT = /^[0-9a-f]{40}$/iu;

/**
 * A version as a person reads it: the tag or branch with the short commit
 * (`v1.2.0 · 0123abc`), or the short commit alone when the ref is itself a
 * commit or `HEAD`. Nothing is hidden: the exact commit stays in the label.
 */
export function versionLabel(
  ref: string | undefined,
  commit: string | undefined,
): string | undefined {
  const trimmedRef = ref?.trim() ?? "";
  const trimmedCommit = commit?.trim() ?? "";
  const shortCommit = trimmedCommit ? trimmedCommit.slice(0, 7) : "";
  if (!trimmedRef || trimmedRef === "HEAD" || FULL_COMMIT.test(trimmedRef)) {
    return shortCommit || (trimmedRef ? trimmedRef.slice(0, 7) : undefined);
  }
  if (trimmedCommit && trimmedRef === trimmedCommit) return shortCommit;
  return shortCommit ? `${trimmedRef} · ${shortCommit}` : trimmedRef;
}

/** `https://github.com/o/r.git` → `github.com/o/r`. */
export function repositoryLabel(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

/**
 * The newest snapshot the app's Source fetched for the ref the app follows,
 * when it differs from the applied commit. `undefined` when the Source has no
 * newer snapshot (or the snapshot list was unavailable).
 */
export function newerSnapshot(
  snapshots: readonly SourceSnapshot[],
  adopted: Capsule["adoptedSourceRevision"],
): SourceSnapshot | undefined {
  if (!adopted) return undefined;
  const sameRef = snapshots
    .filter((snapshot) => snapshot.ref === adopted.ref)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  const latest = sameRef[0];
  return latest && latest.resolvedCommit !== adopted.resolvedCommit
    ? latest
    : undefined;
}

// --- runs and problems -----------------------------------------------------------

const LIFECYCLE_RUN_TYPES = new Set<Run["type"]>([
  "plan",
  "apply",
  "destroy_plan",
  "destroy_apply",
  "state_recovery",
]);

/** This app's lifecycle runs, newest first. */
export function capsuleRuns(
  runs: readonly Run[],
  capsuleId: string,
): readonly Run[] {
  return runs
    .filter((run) => run.capsuleId === capsuleId && LIFECYCLE_RUN_TYPES.has(run.type))
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
}

/**
 * The run behind the app's current problem: its newest lifecycle run, when
 * that run failed. A newer run (a successful apply, or a new review the person
 * started) supersedes an older failure.
 */
export function latestFailedRun(runs: readonly Run[]): Run | undefined {
  const latest = runs.find((run) => run.type !== "state_recovery");
  return latest?.status === "failed" ? latest : undefined;
}

// --- history ----------------------------------------------------------------------

export type AppHistoryKind =
  | "install"
  | "update"
  | "version"
  | "settings"
  | "change"
  | "recovered"
  | "uninstall"
  | "apply_failed"
  | "review_failed"
  | "applying"
  | "uninstall_scheduled"
  | "uninstall_cancelled"
  | "uninstall_blocked";

export interface AppHistoryEvent {
  readonly key: string;
  readonly kind: AppHistoryKind;
  readonly at: string;
  /** The run to open for the deep dive (failure reason, logs). */
  readonly runId?: string;
  /** Version applied by this event, when the snapshot is known. */
  readonly version?: string;
}

/**
 * This app's events, newest first. Applied changes come from the StateVersion
 * ledger (complete per app); failed and in-progress attempts come from the
 * Run list; uninstall scheduling comes from Activity. Whether an applied
 * change was an update or a settings change is read from the source snapshot
 * each change used — when that is unknown the event says only that a change
 * was applied.
 */
/** The source snapshot an applied run used (its own, or its Plan's). */
function snapshotIdOf(
  run: Run | undefined,
  runsById: ReadonlyMap<string, Run>,
): string | undefined {
  if (!run) return undefined;
  if (run.sourceSnapshotId) return run.sourceSnapshotId;
  const plan = run.planRunId ? runsById.get(run.planRunId) : undefined;
  return plan?.sourceSnapshotId;
}

/**
 * The version each applied StateVersion used, when its run and snapshot are
 * known. A StateVersion without that evidence has no entry.
 */
export function stateVersionLabels(input: {
  readonly stateVersions: readonly PublicStateVersion[];
  readonly runs: readonly Run[];
  readonly snapshots: readonly SourceSnapshot[];
}): ReadonlyMap<string, string> {
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const snapshotsById = new Map(
    input.snapshots.map((snapshot) => [snapshot.id, snapshot]),
  );
  const labels = new Map<string, string>();
  for (const version of input.stateVersions) {
    const snapshotId = snapshotIdOf(runsById.get(version.createdByRunId), runsById);
    const snapshot = snapshotId ? snapshotsById.get(snapshotId) : undefined;
    const label = snapshot
      ? versionLabel(snapshot.ref, snapshot.resolvedCommit)
      : undefined;
    if (label) labels.set(version.id, label);
  }
  return labels;
}

export function appHistory(input: {
  readonly capsuleId: string;
  readonly stateVersions: readonly PublicStateVersion[];
  readonly runs: readonly Run[];
  readonly activity: readonly ActivityEvent[];
  readonly snapshots: readonly SourceSnapshot[];
}): readonly AppHistoryEvent[] {
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const snapshotsById = new Map(
    input.snapshots.map((snapshot) => [snapshot.id, snapshot]),
  );
  const snapshotOf = (run: Run | undefined) => snapshotIdOf(run, runsById);
  const events: AppHistoryEvent[] = [];
  const seenRuns = new Set<string>();
  const versions = [...input.stateVersions]
    .filter((version) => version.capsuleId === input.capsuleId)
    .sort((a, b) => a.generation - b.generation);
  let previousSnapshot: string | undefined;
  for (const version of versions) {
    const run = runsById.get(version.createdByRunId);
    const snapshotId = snapshotOf(run);
    const snapshot = snapshotId ? snapshotsById.get(snapshotId) : undefined;
    const label = snapshot
      ? versionLabel(snapshot.ref, snapshot.resolvedCommit)
      : undefined;
    let kind: AppHistoryKind;
    if (run?.type === "state_recovery") kind = "recovered";
    else if (run?.type === "destroy_apply") kind = "uninstall";
    else if (version.generation === 1) kind = "install";
    else if (snapshotId && previousSnapshot) {
      if (snapshotId === previousSnapshot) kind = "settings";
      else {
        const before = snapshotsById.get(previousSnapshot);
        kind = before && snapshot && snapshot.fetchedAt < before.fetchedAt
          ? "version"
          : "update";
      }
    } else kind = "change";
    events.push({
      key: `sv:${version.id}`,
      kind,
      at: version.createdAt,
      runId: version.createdByRunId,
      ...(label && kind !== "settings" ? { version: label } : {}),
    });
    seenRuns.add(version.createdByRunId);
    if (snapshotId) previousSnapshot = snapshotId;
  }
  for (const run of capsuleRuns(input.runs, input.capsuleId)) {
    if (seenRuns.has(run.id)) continue;
    const applying = run.type === "apply" || run.type === "destroy_apply";
    if (run.status === "failed") {
      events.push({
        key: `run:${run.id}`,
        kind: applying ? "apply_failed" : "review_failed",
        at: run.finishedAt ?? run.createdAt,
        runId: run.id,
      });
    } else if (
      applying &&
      (run.status === "queued" || run.status === "running")
    ) {
      events.push({
        key: `run:${run.id}`,
        kind: "applying",
        at: run.startedAt ?? run.createdAt,
        runId: run.id,
      });
    } else if (run.type === "destroy_apply" && run.status === "succeeded") {
      events.push({
        key: `run:${run.id}`,
        kind: "uninstall",
        at: run.finishedAt ?? run.createdAt,
        runId: run.id,
      });
    }
  }
  for (const event of input.activity) {
    if (
      event.metadata.capsuleId !== input.capsuleId &&
      event.targetId !== input.capsuleId
    ) {
      continue;
    }
    const kind = UNINSTALL_ACTIVITY[event.action];
    if (!kind) continue;
    events.push({ key: `act:${event.id}`, kind, at: event.createdAt });
  }
  return events.sort(
    (a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key),
  );
}

const UNINSTALL_ACTIVITY: Readonly<Record<string, AppHistoryKind>> = {
  "capsule.uninstall_scheduled": "uninstall_scheduled",
  "capsule.uninstall_cancelled": "uninstall_cancelled",
  "capsule.uninstall_blocked": "uninstall_blocked",
};

// --- what the app created ----------------------------------------------------------

export interface ResourceGroupItem {
  readonly label: string;
  readonly count: number;
}

export interface ResourceGroup {
  /** Provider key the group is about (`cloudflare`, `aws`, …). */
  readonly key: string;
  readonly label: string;
  readonly providerSource?: string;
  readonly items: readonly ResourceGroupItem[];
  readonly total: number;
}

function providerKeyOf(resource: {
  readonly type: string;
  readonly providerSource?: string;
}): string {
  if (resource.providerSource) {
    const tail = resource.providerSource.trim().split("/").filter(Boolean).at(-1);
    if (tail) return tail.toLowerCase();
  }
  const prefix = resource.type.trim().split(".").at(-1)?.split("_")[0];
  return (prefix || resource.type).toLowerCase();
}

/**
 * Readable name for a resource type within its provider:
 * `cloudflare_workers_script` → `Workers Script`. The provider word is the
 * group heading, so it is not repeated on every row.
 */
export function resourceTypeLabel(type: string, providerKey?: string): string {
  const tail = type.trim().split(".").at(-1) ?? type;
  const words = tail.split("_").map((word) => word.trim()).filter(Boolean);
  if (providerKey && words.length > 1 && words[0]!.toLowerCase() === providerKey) {
    words.shift();
  }
  if (words.length === 0) return type;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The recorded inventory, grouped by cloud with counts per readable type. */
export function groupInventoryResources(
  resources: readonly { readonly type: string; readonly providerSource?: string }[],
): readonly ResourceGroup[] {
  interface Accumulator {
    providerSource?: string;
    readonly counts: Map<string, number>;
    total: number;
  }
  const groups = new Map<string, Accumulator>();
  for (const resource of resources) {
    const key = providerKeyOf(resource);
    const group: Accumulator = groups.get(key) ?? { counts: new Map(), total: 0 };
    if (!group.providerSource && resource.providerSource) {
      group.providerSource = resource.providerSource;
    }
    const label = resourceTypeLabel(resource.type, key);
    group.counts.set(label, (group.counts.get(label) ?? 0) + 1);
    group.total += 1;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: readableProviderSourceLabel(group.providerSource ?? key),
      ...(group.providerSource ? { providerSource: group.providerSource } : {}),
      items: [...group.counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      total: group.total,
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

/** Recorded inventory resources, or `undefined` when none were recorded. */
export function recordedInventoryResources(
  inventory: CapsuleCurrentResourceInventory | undefined,
): readonly { readonly type: string; readonly providerSource?: string }[] | undefined {
  return inventory?.availability === "recorded" ? inventory.resources : undefined;
}

// --- cost --------------------------------------------------------------------------

/**
 * What the app page can honestly say about this app's running cost. An
 * unknown cost is never shown as free.
 */
export type AppCostState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not_recorded" }
  | { readonly kind: "unrated" }
  | {
      readonly kind: "rated";
      readonly usdMicros: number;
      readonly unratedEventCount: number;
    };

export function appCostState(
  summary: CapsuleUsageSummary | undefined,
  status: { readonly loading: boolean; readonly failed: boolean },
): AppCostState {
  if (status.failed) return { kind: "unavailable" };
  if (!summary) return status.loading ? { kind: "loading" } : { kind: "unavailable" };
  if (summary.eventCount === 0) return { kind: "not_recorded" };
  if (summary.ratedEventCount === 0) return { kind: "unrated" };
  return {
    kind: "rated",
    usdMicros: summary.usdMicros,
    unratedEventCount: summary.unratedEventCount,
  };
}

// --- linked apps -------------------------------------------------------------------

export interface LinkedApp {
  readonly edgeId: string;
  readonly capsuleId: string;
  readonly name: string;
}

/** Apps this app uses (`uses`) or that use it (`usedBy`), from the graph. */
export function linkedApps(
  capsuleId: string,
  graph:
    | {
        readonly nodes: readonly Pick<GraphNode, "capsuleId" | "name">[];
        readonly edges: readonly Pick<
          GraphEdge,
          "id" | "producerCapsuleId" | "consumerCapsuleId"
        >[];
      }
    | undefined,
  side: "uses" | "usedBy",
): readonly LinkedApp[] {
  if (!graph) return [];
  const names = new Map(graph.nodes.map((node) => [node.capsuleId, node.name]));
  return graph.edges
    .filter((edge) =>
      side === "uses"
        ? edge.consumerCapsuleId === capsuleId
        : edge.producerCapsuleId === capsuleId,
    )
    .map((edge) => {
      const other = side === "uses" ? edge.producerCapsuleId : edge.consumerCapsuleId;
      return { edgeId: edge.id, capsuleId: other, name: names.get(other) ?? other };
    });
}

// --- provider connections ------------------------------------------------------------

/** Display name for a provider source: `registry…/cloudflare/cloudflare` → `Cloudflare`. */
export function providerName(provider: string): string {
  return readableProviderSourceLabel(provider);
}

/**
 * One label per provider row. The child alias only distinguishes rows when the
 * same provider appears more than once; otherwise the provider name is enough.
 */
export function providerRowLabels(
  bindings: readonly Pick<ProviderBinding, "provider" | "childAlias" | "rootAlias" | "alias">[],
): readonly string[] {
  const counts = new Map<string, number>();
  for (const binding of bindings) {
    const key = binding.provider.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return bindings.map((binding) => {
    const name = providerName(binding.provider);
    const repeated = (counts.get(binding.provider.trim().toLowerCase()) ?? 0) > 1;
    const alias = binding.childAlias ?? binding.rootAlias ?? binding.alias;
    return repeated && alias ? `${name} (${alias})` : name;
  });
}
