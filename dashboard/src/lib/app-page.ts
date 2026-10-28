/**
 * Pure presentation logic for the installed-app page and the Home overview
 * (TASK-0115). The page is organised around what a person does with an
 * installed app — open it, keep it working, update it, change its settings,
 * see what it created and what it costs, uninstall it. The control plane
 * computes the app's state, primary action and problems
 * (`GET /capsules/:id/app`); these helpers only choose the words for them and
 * turn the app's own ledgers (its Runs, StateVersions and resource inventory)
 * into that vocabulary without inventing anything the backend did
 * not record.
 */
import { untrack, type Resource } from "solid-js";
import type {
  Capsule,
  CapsuleAppAction,
  CapsuleAppIncompleteSection,
  CapsuleAppProblem,
  CapsuleAppScreen,
  CapsuleAppView,
  CapsuleCurrentResourceInventory,
  CapsuleUsageSummary,
  ProviderBinding,
  PublicStateVersion,
  Run,
  RunPolicyReason,
  SourceSnapshot,
} from "./control-api.ts";
import { isSafeLinkHref } from "takosumi-contract";
import type { MessageKey } from "../i18n/index.ts";
import { effectiveCapsuleStatus } from "./capsules-ui.ts";
import { readableProviderSourceLabel } from "./provider-labels.ts";

/**
 * The loaded value of a supporting read, kept while it refreshes, without
 * registering with the route's Suspense boundary. A failed read is simply
 * `undefined`; every section renders its own loading and failure state.
 */
/** True once a supporting read has loaded (also while it refreshes). */
export function isSettled(resource: Resource<unknown>): boolean {
  return resource.state === "ready" || resource.state === "refreshing";
}

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
 * show it for every app without per-app reads. The app page itself shows the
 * control plane's own state and problems for the app
 * (`GET /capsules/:id/app`).
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

// --- the server-computed app view ---------------------------------------------

/**
 * The sentence under the app's name, from the control plane's state for the
 * app and what is in progress. The server owns the state; this only chooses
 * the words for it.
 */
export function appStateSentence(app: CapsuleAppView): MessageKey {
  switch (app.state) {
    case "uninstalled":
      return "app.state.sentence.uninstalled";
    case "uninstalling":
      return "app.state.sentence.uninstallingNow";
    case "uninstall_scheduled":
      return "app.state.sentence.uninstalling";
    case "stopped":
      return "app.state.sentence.stopped";
    case "needs_attention":
      return "app.state.sentence.needsAttention";
    case "installing":
      if (app.progress.review) return "app.state.sentence.installReview";
      if (app.progress.run) return "app.state.sentence.installRunning";
      return app.progress.revisionPreparing
        ? "app.state.sentence.preparing"
        : "app.state.sentence.installing";
    case "updating":
      return app.progress.run && isApplyType(app.progress.run.type)
        ? "app.state.sentence.updating"
        : "app.state.sentence.updatePreparing";
    case "installed":
      if (app.progress.review) return "app.state.sentence.changeWaiting";
      return app.version.updateAvailable || app.version.stale
        ? "app.state.sentence.updateAvailable"
        : "app.state.sentence.ready";
    default:
      // A state a newer server added: say only that the app was read.
      return "app.state.sentence.unknown";
  }
}

/** The label of the one primary action; `undefined` for `open` and `none`. */
export function appPrimaryActionLabel(action: CapsuleAppAction): MessageKey | undefined {
  switch (action) {
    case "view_resources":
      return "app.action.viewResources";
    case "review":
      return "app.action.review";
    case "retry":
      return "app.problem.retry";
    case "retry_screen":
      return "app.problem.screenRetry";
    case "fix_connection":
      return "app.action.fixConnection";
    case "continue_install":
      return "app.problem.continueInstall";
    case "cancel_uninstall":
      return "app.uninstall.cancel";
    case "uninstall_now":
      return "app.uninstall.now";
    case "reinstall":
      return "app.action.reinstall";
    default:
      return undefined;
  }
}

/**
 * The screens the page may link to: the server already checked each launch
 * URL; the page checks it again like every other link it renders, keeping
 * only absolute http(s) URLs.
 */
export function openableScreens(
  screens: readonly CapsuleAppScreen[],
): readonly { readonly name?: string; readonly url: string }[] {
  return screens
    .filter((screen) => /^https?:\/\//iu.test(screen.url) && isSafeLinkHref(screen.url))
    .map((screen) => ({ ...(screen.title ? { name: screen.title } : {}), url: screen.url }));
}

/** The first problem that decides the primary action (an error, in order). */
export function primaryProblem(app: CapsuleAppView): CapsuleAppProblem | undefined {
  return app.problems.find((problem) => problem.severity === "error");
}

/**
 * The ref an installed app runs, for updating it or choosing another
 * version: the server's current version, else the Capsule's adopted
 * revision. Never the Source's default ref — without a known ref an
 * installed app has nothing to update.
 */
export function appInstalledRef(
  app: Pick<CapsuleAppView, "version"> | undefined,
  capsule: Pick<Capsule, "adoptedSourceRevision"> | undefined,
): string | undefined {
  const ref = app?.version.current?.ref ?? capsule?.adoptedSourceRevision?.ref;
  return ref?.trim() ? ref.trim() : undefined;
}

/**
 * Another change is under way or waiting for its review, so a new version
 * change would race it to a duplicate Plan. (The server also refuses a second
 * revision while one is still being prepared.) A revision whose preparation
 * stalled does not block: it is continued or replaced.
 */
export function appVersionChangeBusy(
  app: Pick<CapsuleAppView, "state" | "progress">,
): boolean {
  return app.state === "updating" || app.progress.revisionPreparing ||
    app.progress.run !== undefined || app.progress.review !== undefined;
}

/** What the page does for the server's primary action. */
export type AppPrimaryStep =
  | { readonly kind: "open" }
  | { readonly kind: "reinstall" }
  | { readonly kind: "show_created" }
  | { readonly kind: "review"; readonly runId: string; readonly runType: Run["type"] }
  | { readonly kind: "retry"; readonly problem?: CapsuleAppProblem }
  | { readonly kind: "retry_screen"; readonly problem?: CapsuleAppProblem }
  | { readonly kind: "fix_connection" }
  | { readonly kind: "continue_install" }
  | { readonly kind: "cancel_uninstall" }
  | { readonly kind: "uninstall_now" }
  | { readonly kind: "none" };

/**
 * Maps the server's primary action onto the in-page flow that carries it
 * out. `review` opens the plan waiting in `progress.review`, else the run the
 * first problem names; without either there is nothing to open.
 */
export function appPrimaryStep(app: CapsuleAppView): AppPrimaryStep {
  const problem = primaryProblem(app);
  switch (app.primaryAction) {
    case "open":
      return { kind: "open" };
    case "reinstall":
      return { kind: "reinstall" };
    case "view_resources":
      return { kind: "show_created" };
    case "review": {
      const waiting = app.progress.review;
      if (waiting) return { kind: "review", runId: waiting.runId, runType: waiting.runType };
      if (problem?.runId && problem.runType) {
        return { kind: "review", runId: problem.runId, runType: problem.runType };
      }
      return { kind: "none" };
    }
    case "retry":
      return problem ? { kind: "retry", problem } : { kind: "retry" };
    case "retry_screen":
      return problem ? { kind: "retry_screen", problem } : { kind: "retry_screen" };
    case "fix_connection":
      return { kind: "fix_connection" };
    case "continue_install":
      return { kind: "continue_install" };
    case "cancel_uninstall":
      return { kind: "cancel_uninstall" };
    case "uninstall_now":
      return { kind: "uninstall_now" };
    default:
      return { kind: "none" };
  }
}

/** True when the control plane could not read the named part of the view. */
export function appViewIncomplete(
  app: CapsuleAppView | undefined,
  part: CapsuleAppIncompleteSection,
): boolean {
  return app?.incomplete?.includes(part) === true;
}

/**
 * The review a run calls for: a removal plan reviews an uninstall, a first
 * install's plan reviews the install, any other plan reviews a change.
 */
export function reviewPurposeForRun(
  type: Run["type"],
  applied: boolean,
): "install" | "apply" | "uninstall" {
  if (type === "destroy_plan" || type === "destroy_apply") return "uninstall";
  return applied ? "apply" : "install";
}

function isApplyType(type: Run["type"]): boolean {
  return type === "apply" || type === "destroy_apply";
}

function isPlanType(type: Run["type"]): boolean {
  return type === "plan" || type === "destroy_plan";
}

// --- history ----------------------------------------------------------------------

/** The Run types the app's history is told from, requested from the server. */
export const APP_HISTORY_RUN_TYPES: readonly Run["type"][] = [
  "plan",
  "apply",
  "destroy_plan",
  "destroy_apply",
  "state_recovery",
];

export type AppHistoryKind =
  | "install"
  | "update"
  | "version"
  | "settings"
  | "change"
  | "recovered"
  | "uninstall"
  | "apply_failed"
  | "uninstall_failed"
  | "review_failed"
  | "applying"
  | "policy_blocked"
  | "approval_waiting";

export interface AppHistoryEvent {
  readonly key: string;
  readonly kind: AppHistoryKind;
  readonly at: string;
  /** The run to open for the deep dive (failure reason, logs). */
  readonly runId: string;
  /** Version applied by this event, when the snapshot is known. */
  readonly version?: string;
  /** Why a policy blocked this plan or made it wait for an approval. */
  readonly policyReasons?: readonly RunPolicyReason[];
}

/** Older history pages read with "Show more", after the first page. */
export interface AppOlderHistory {
  /** The cursor the first older page was read with. */
  readonly startCursor: string;
  readonly runs: readonly Run[];
  readonly nextCursor?: string;
}

/**
 * The app's Runs from the first history page plus the older pages already
 * read. A refreshed first page keeps the older pages while it still reaches
 * them (same cursor, an overlapping run, or no further page); if new runs
 * pushed it so far that a gap could open, only the first page is kept.
 */
export function mergeAppHistoryPages(
  first: { readonly runs: readonly Run[]; readonly nextCursor?: string } | undefined,
  older: AppOlderHistory | undefined,
): { readonly runs: readonly Run[]; readonly nextCursor?: string } {
  if (!first) return { runs: [] };
  if (!older) return first;
  const firstIds = new Set(first.runs.map((run) => run.id));
  const contiguous = first.nextCursor === undefined ||
    first.nextCursor === older.startCursor ||
    older.runs.some((run) => firstIds.has(run.id));
  if (!contiguous) return first;
  const runs = [...first.runs, ...older.runs.filter((run) => !firstIds.has(run.id))];
  const nextCursor = first.nextCursor === undefined ? undefined : older.nextCursor;
  return nextCursor ? { runs, nextCursor } : { runs };
}

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

/**
 * This app's history, newest first, told from its own Runs (read page by page
 * from the server, so nothing depends on a Workspace-wide window). Applied
 * changes say what they were — install, update, version change, settings —
 * using the StateVersion each one created and the snapshot it used; when that
 * evidence is not loaded the event only says a change was applied. Failed
 * and running attempts, plans a policy blocked and plans waiting for an
 * approval are listed too. A plan that was simply reviewed is not an event.
 */
export function appRunHistory(input: {
  readonly runs: readonly Run[];
  readonly stateVersions: readonly PublicStateVersion[];
  readonly snapshots: readonly SourceSnapshot[];
  /** The version the current StateVersion runs, from the app view. */
  readonly current?: {
    readonly stateVersionId?: string;
    readonly ref: string;
    readonly commit: string;
  };
}): readonly AppHistoryEvent[] {
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const snapshotsById = new Map(
    input.snapshots.map((snapshot) => [snapshot.id, snapshot]),
  );
  const versionsByRun = new Map(
    input.stateVersions.map((version) => [version.createdByRunId, version]),
  );
  const versionsByGeneration = [...input.stateVersions].sort(
    (a, b) => a.generation - b.generation,
  );
  const labelFor = (
    version: PublicStateVersion | undefined,
    snapshotId: string | undefined,
  ): string | undefined => {
    const snapshot = snapshotId ? snapshotsById.get(snapshotId) : undefined;
    if (snapshot) return versionLabel(snapshot.ref, snapshot.resolvedCommit);
    const current = input.current;
    return version && current && version.id === current.stateVersionId
      ? versionLabel(current.ref, current.commit)
      : undefined;
  };
  const appliedKind = (run: Run): { kind: AppHistoryKind; version?: string } => {
    const version = versionsByRun.get(run.id);
    const snapshotId = snapshotIdOf(run, runsById);
    const label = labelFor(version, snapshotId);
    if (version?.generation === 1) return { kind: "install", ...(label ? { version: label } : {}) };
    const previous = version
      ? [...versionsByGeneration].reverse().find((item) => item.generation < version.generation)
      : undefined;
    const previousSnapshot = previous
      ? snapshotIdOf(runsById.get(previous.createdByRunId), runsById)
      : undefined;
    if (!version || !snapshotId || !previousSnapshot) {
      return { kind: "change", ...(label ? { version: label } : {}) };
    }
    if (snapshotId === previousSnapshot) return { kind: "settings" };
    const before = snapshotsById.get(previousSnapshot);
    const after = snapshotsById.get(snapshotId);
    const kind: AppHistoryKind = before && after && after.fetchedAt < before.fetchedAt
      ? "version"
      : "update";
    return { kind, ...(label ? { version: label } : {}) };
  };

  const events: AppHistoryEvent[] = [];
  for (const run of input.runs) {
    const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
    const base = { key: `run:${run.id}`, at, runId: run.id } as const;
    const reasons = run.policyReasons && run.policyReasons.length > 0
      ? { policyReasons: run.policyReasons }
      : {};
    if (run.type === "state_recovery") {
      if (run.status === "succeeded") events.push({ ...base, kind: "recovered" });
      else if (run.status === "failed") events.push({ ...base, kind: "apply_failed" });
      continue;
    }
    if (isApplyType(run.type)) {
      const removal = run.type === "destroy_apply";
      if (run.status === "succeeded") {
        events.push(removal ? { ...base, kind: "uninstall" } : { ...base, ...appliedKind(run) });
      } else if (run.status === "failed") {
        events.push({ ...base, kind: removal ? "uninstall_failed" : "apply_failed" });
      } else if (run.status === "queued" || run.status === "running") {
        events.push({ ...base, kind: "applying", at: run.startedAt ?? run.createdAt });
      }
      continue;
    }
    if (!isPlanType(run.type)) continue;
    const blocked =
      (run.status === "succeeded" && run.policyStatus !== undefined && run.policyStatus !== "pass") ||
      run.errorCode === "policy_denied";
    if (blocked) events.push({ ...base, kind: "policy_blocked", ...reasons });
    else if (run.status === "waiting_approval") {
      events.push({ ...base, kind: "approval_waiting", at: run.createdAt, ...reasons });
    } else if (run.status === "failed") events.push({ ...base, kind: "review_failed" });
  }
  return events.sort(
    (a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key),
  );
}

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
