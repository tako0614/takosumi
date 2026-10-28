/**
 * Per-app reads for the installed-app page (TASK-0115):
 *
 * - `GET /api/v1/capsules/:id/app`: one server-computed view of an installed
 *   app — state, primary action, problems, every launchable screen, version
 *   and update facts, progress, newest lifecycle Run and uninstall terms.
 * - `GET /api/v1/capsules/:id/runs`: the app's own Runs, newest first, with a
 *   keyset cursor, so history no longer depends on a Workspace-wide window.
 *
 * The caller (`handleCapsules`) has already resolved the Capsule and enforced
 * the same Workspace access as reading the Capsule. Every projection here is
 * value-free: no secret, credential, Output value or Interface input other
 * than the checked launch URL of an authorized screen.
 */
import {
  CAPSULE_APP_VIEW_KIND,
  type CapsuleAppIncompleteSection,
  type CapsuleAppRunSummary,
  type CapsuleAppScreen,
  type CapsuleAppScreenFailure,
  type CapsuleAppUninstall,
  type CapsuleAppVersion,
  type CapsuleAppView,
  type CapsuleAppResponse,
  type CapsuleAdoptedSourceRevision,
} from "takosumi-contract/capsules";
import type { Capsule } from "takosumi-contract/install-configs";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import {
  CAPSULE_RUN_LIST_DEFAULT_LIMIT,
  CAPSULE_RUN_LIST_MAX_LIMIT,
  RUN_TYPES,
  type ListRunsResponse,
  type Run,
  type RunType,
} from "takosumi-contract/runs";
import {
  hasCredentialQueryParams,
  isValidInterfaceName,
  parseInterfaceDisplay,
  TAKOSUMI_API_VERSION,
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
  UI_SURFACE_OPEN_PERMISSION,
} from "takosumi-contract";
import { encodeCursor } from "takosumi-contract/pagination";
import type { ControlPlaneOperations } from "../control-operations.ts";
import { errorJson, json, methodNotAllowed } from "../http-helpers.ts";
import {
  type ControlDispatchContext,
  controlPlaneUnavailable,
  publicRun,
} from "./shared.ts";
import {
  CAPSULE_APP_LIFECYCLE_RUN_TYPES,
  capsuleIsApplied,
  deriveCapsuleAppStatus,
  liveCapsuleUninstall,
  reviewablePlan,
  type CapsuleAppConnectionIssue,
  type CapsuleAppLatestRun,
} from "../../../../core/domains/capsules/app_view.ts";

/** Screen candidate pages read for one app view (100 screens per page). */
const APP_SCREEN_PAGE_LIMIT = 5;
/** Snapshot pages read after the current version when looking for a newer one. */
const APP_SNAPSHOT_PAGE_LIMIT = 5;
/** The failure-list window; one Capsule generation has at most one entry. */
const APP_SCREEN_FAILURE_LIMIT = 100;
const RUN_TYPE_SET: ReadonlySet<string> = new Set(RUN_TYPES);

// --- runs ----------------------------------------------------------------------

export async function handleCapsuleRuns(
  ctx: ControlDispatchContext,
  capsule: Capsule,
  method: string,
): Promise<Response> {
  if (method !== "GET") return methodNotAllowed("GET");
  const { operations, url } = ctx;
  if (typeof operations.listCapsuleRunsPage !== "function") {
    return controlPlaneUnavailable();
  }
  const rawLimit = url.searchParams.get("limit");
  let limit = CAPSULE_RUN_LIST_DEFAULT_LIMIT;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/u.test(rawLimit) || Number(rawLimit) < 1) {
      return errorJson("invalid_request", "limit must be a positive integer", 400);
    }
    limit = Math.min(Number(rawLimit), CAPSULE_RUN_LIST_MAX_LIMIT);
  }
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null || rawCursor === "" ? undefined : rawCursor;
  const rawTypes = url.searchParams.getAll("type");
  const types: RunType[] = [];
  for (const value of rawTypes) {
    if (!RUN_TYPE_SET.has(value)) {
      return errorJson("invalid_request", "type must be a Run type", 400);
    }
    if (!types.includes(value as RunType)) types.push(value as RunType);
  }
  const page = await operations.listCapsuleRunsPage.call(operations, capsule.id, {
    workspaceId: capsule.workspaceId,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(types.length > 0 ? { types } : {}),
  });
  return json({
    runs: await Promise.all(
      page.runs.map((run) => publicRun(operations, run, ctx.assertActive)),
    ),
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  } satisfies ListRunsResponse);
}

// --- app view ------------------------------------------------------------------

export async function handleCapsuleApp(
  ctx: ControlDispatchContext,
  capsule: Capsule,
  method: string,
): Promise<Response> {
  if (method !== "GET") return methodNotAllowed("GET");
  // The newest lifecycle Run decides the state; without the per-Capsule Run
  // seam the view cannot be computed honestly.
  if (typeof ctx.operations.listCapsuleRunsPage !== "function") {
    return controlPlaneUnavailable();
  }
  const app = await readCapsuleAppView(ctx, capsule, Date.now());
  return json({ app } satisfies CapsuleAppResponse, 200, {
    "cache-control": "no-store",
  });
}

interface Optional<T> {
  readonly value?: T;
  readonly failed: boolean;
}

async function optional<T>(read: () => Promise<T>): Promise<Optional<T>> {
  try {
    return { value: await read(), failed: false };
  } catch {
    return { failed: true };
  }
}

async function readCapsuleAppView(
  ctx: ControlDispatchContext,
  capsule: Capsule,
  now: number,
): Promise<CapsuleAppView> {
  const { operations } = ctx;
  const destroyed = capsule.status === "destroyed";
  const applied = capsuleIsApplied(capsule);
  const managed = applied && !destroyed;
  const incomplete = new Set<CapsuleAppIncompleteSection>();

  // Facts that decide the state are required: a failed read fails the request
  // instead of answering with a state the control plane did not establish.
  const [latestRun, revisionPreparing, connectionIssues, admission] = destroyed
    ? [undefined, false, [], { schedule: false, cancel: false }] as const
    : await Promise.all([
        readLatestLifecycleRun(operations, capsule),
        operations.gitInstallPlans.hasInFlightRevisionForCapsule(
          capsule.id,
          capsule.workspaceId,
        ),
        readConnectionIssues(operations, capsule),
        readUninstallAdmission(operations, capsule, applied),
      ]);

  const [installConfig, source, adopted, screens, screenFailure] = await Promise.all([
    optional(() => operations.capsules.getInstallConfig(capsule.installConfigId)),
    optional(async () => (await operations.getSource(capsule.sourceId)).source),
    // Same rule as the Capsule read: provenance exists once a current
    // StateVersion does.
    managed && capsule.currentStateVersionId
      ? optional(() => operations.getCapsuleAdoptedSourceRevision(capsule.id))
      : Promise.resolve<Optional<CapsuleAdoptedSourceRevision | undefined>>({
          failed: false,
        }),
    managed &&
      (capsule.status === "active" || capsule.status === "stale")
      ? optional(() => readScreens(ctx, capsule))
      : Promise.resolve<Optional<readonly CapsuleAppScreen[]>>({
          value: [],
          failed: false,
        }),
    managed
      ? optional(() => readScreenFailure(operations, capsule))
      : Promise.resolve<Optional<ScreenFailureRead>>({
          value: { complete: true },
          failed: false,
        }),
  ]);
  if (installConfig.failed) incomplete.add("display");
  if (screens.failed) incomplete.add("screens");
  if (screenFailure.failed || screenFailure.value?.complete === false) {
    incomplete.add("screen_problems");
  }

  const version = await readVersion(operations, capsule, {
    source: source.value,
    adopted: adopted.value,
    onIncomplete: () => incomplete.add("version"),
  });
  if (source.failed || adopted.failed) incomplete.add("version");

  const screenList = screens.value ?? [];
  const failure = screenFailure.value?.failure;
  const derived = deriveCapsuleAppStatus({
    capsule,
    ...(latestRun ? { latestRun } : {}),
    revisionPreparing,
    connectionIssues,
    ...(failure ? { screenFailure: failure } : {}),
    ...(screens.failed ? {} : { screenCount: screenList.length }),
    uninstallCancellable: admission.cancel,
    now,
  });
  const inFlightRun = latestRun &&
      (latestRun.status === "queued" || latestRun.status === "running")
    ? latestRun
    : undefined;
  const review = reviewablePlan(latestRun);
  const display = installConfig.value?.store;
  const iconUrl = safeImageUrl(display?.iconUrl);

  return {
    kind: CAPSULE_APP_VIEW_KIND,
    capsuleId: capsule.id,
    workspaceId: capsule.workspaceId,
    projectId: capsule.projectId,
    name: capsule.name,
    environment: capsule.environment,
    ...(display ? { displayName: { ja: display.name.ja, en: display.name.en } } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    status: capsule.status,
    applied,
    state: derived.state,
    primaryAction: derived.primaryAction,
    problems: derived.problems,
    screens: screenList,
    version,
    progress: {
      revisionPreparing: !destroyed && revisionPreparing,
      ...(inFlightRun ? { run: runSummary(inFlightRun) } : {}),
      ...(review ? { review: { runId: review.id, runType: review.type } } : {}),
    },
    ...(latestRun ? { latestRun: runSummary(latestRun) } : {}),
    uninstall: uninstallTerms(operations, capsule, {
      applied,
      admission,
      ...(latestRun ? { latestRun } : {}),
    }),
    ...(incomplete.size > 0 ? { incomplete: [...incomplete].sort() } : {}),
    observedAt: new Date(now).toISOString(),
  };
}

async function readLatestLifecycleRun(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<CapsuleAppLatestRun | undefined> {
  if (typeof operations.listCapsuleRunsPage !== "function") {
    throw new Error("the Capsule Run listing is not wired on this host");
  }
  const page = await operations.listCapsuleRunsPage.call(operations, capsule.id, {
    workspaceId: capsule.workspaceId,
    limit: 1,
    types: CAPSULE_APP_LIFECYCLE_RUN_TYPES,
  });
  const run = page.runs[0];
  return run ? { ...runSummary(run), ...(run.policyStatus ? { policyStatus: run.policyStatus } : {}) } : undefined;
}

function runSummary(run: Run | CapsuleAppRunSummary): CapsuleAppRunSummary {
  return {
    id: run.id,
    type: run.type,
    status: run.status,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    ...(run.requiresApproval ? { requiresApproval: true } : {}),
  };
}

/**
 * Bindings whose ProviderConnection is missing from the connections this
 * Workspace can bind, or is no longer usable.
 */
async function readConnectionIssues(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<readonly CapsuleAppConnectionIssue[]> {
  const bindingSet = await operations.capsules.getProviderBindingSetByCapsule(
    capsule.id,
    capsule.environment,
  );
  const bindings = bindingSet?.bindings ?? [];
  if (bindings.length === 0) return [];
  const connections = await operations.connections.listProviderConnections(
    capsule.workspaceId,
  );
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const issues: CapsuleAppConnectionIssue[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.provider}\u0000${binding.connectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const connection = byId.get(binding.connectionId);
    const status = !connection
      ? "missing"
      : connection.status === "revoked" ||
          connection.status === "expired" ||
          connection.status === "error"
        ? connection.status
        : undefined;
    if (status) {
      issues.push({
        provider: binding.provider,
        connectionId: binding.connectionId,
        status,
      });
    }
  }
  return issues;
}

interface ScreenFailureRead {
  readonly failure?: CapsuleAppScreenFailure;
  /** False when the Workspace window was full, so a miss proves nothing. */
  readonly complete: boolean;
}

/**
 * The current generation's dead-lettered screen materialization, if any. The
 * ledger lists dead letters per Workspace, newest first, in a bounded window;
 * when the window is full and this app's entry is not in it, the answer is
 * reported as incomplete rather than as "no failure".
 */
async function readScreenFailure(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<ScreenFailureRead> {
  const failures = await operations.listInterfaceMaterializationFailures(
    capsule.workspaceId,
    { limit: APP_SCREEN_FAILURE_LIMIT },
  );
  const failure = failures.find(
    (candidate) =>
      candidate.capsuleId === capsule.id &&
      candidate.stateGeneration === capsule.currentStateGeneration,
  );
  if (!failure) return { complete: failures.length < APP_SCREEN_FAILURE_LIMIT };
  return {
    complete: true,
    failure: {
      id: failure.id,
      failureDigest: failure.failureDigest,
      stateVersionId: failure.stateVersionId,
      stateGeneration: failure.stateGeneration,
      errorCode: failure.error.code,
    },
  };
}

// --- screens --------------------------------------------------------------------

async function readScreens(
  ctx: ControlDispatchContext,
  capsule: Capsule,
): Promise<readonly CapsuleAppScreen[]> {
  const interfaces = ctx.operations.interfaces;
  if (!interfaces) return [];
  const viewerOrigin = ctx.url.origin;
  const screens: CapsuleAppScreen[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < APP_SCREEN_PAGE_LIMIT; page += 1) {
    const result = await interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage(
      { workspaceId: capsule.workspaceId, phase: "Resolved" },
      ctx.session.subject,
      UI_SURFACE_OPEN_PERMISSION,
      { limit: 100, ...(cursor ? { cursor } : {}) },
      capsule.id,
    );
    for (const item of result.items) {
      const screen = projectAppScreen(item, capsule, viewerOrigin);
      if (screen) screens.push(screen);
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return screens.sort(compareScreens);
}

/**
 * Projects one authorized launcher Interface the way the Dashboard's strict
 * consumer does, keeping only display metadata and the checked launch URL.
 */
export function projectAppScreen(
  value: unknown,
  capsule: Pick<Capsule, "id" | "workspaceId">,
  viewerOrigin?: string,
): CapsuleAppScreen | undefined {
  const record = asRecord(value);
  const metadata = asRecord(record?.metadata);
  const ownerRef = asRecord(metadata?.ownerRef);
  const spec = asRecord(record?.spec);
  const inputs = asRecord(spec?.inputs);
  const urlInput = asRecord(inputs?.url);
  const access = asRecord(spec?.access);
  const document = asRecord(spec?.document);
  const status = asRecord(record?.status);
  const resolvedInputs = asRecord(status?.resolvedInputs);
  const interfaceId = text(metadata?.id);
  const name = text(metadata?.name);
  const generation = nonNegativeInteger(metadata?.generation);
  const resolvedRevision = nonNegativeInteger(status?.resolvedRevision);
  if (
    record?.apiVersion !== TAKOSUMI_API_VERSION ||
    record.kind !== "Interface" ||
    metadata?.workspaceId !== capsule.workspaceId ||
    ownerRef?.kind !== "Capsule" ||
    ownerRef.id !== capsule.id ||
    !interfaceId ||
    !name ||
    !isValidInterfaceName(name) ||
    generation === undefined ||
    generation < 1 ||
    nonNegativeInteger(status?.observedGeneration) !== generation ||
    spec?.type !== UI_SURFACE_INTERFACE_TYPE ||
    spec.version !== UI_SURFACE_INTERFACE_VERSION ||
    (urlInput?.source !== "literal" && urlInput?.source !== "capsule_output") ||
    !document ||
    document.launcher !== true ||
    document.auth !== undefined ||
    document.authentication !== undefined ||
    document.delivery !== undefined ||
    document.credentialDelivery !== undefined ||
    (access?.visibility !== "private" &&
      access?.visibility !== "workspace" &&
      access?.visibility !== "public") ||
    status?.phase !== "Resolved" ||
    resolvedRevision === undefined ||
    resolvedRevision < 1 ||
    !resolvedInputs
  ) {
    return undefined;
  }
  const url = safeLaunchUrl(resolvedInputs.url);
  if (!url) return undefined;
  const display = parseInterfaceDisplay(document.display, {
    surfaceUrl: url,
    ...(viewerOrigin ? { viewerOrigin } : {}),
  });
  return {
    interfaceId,
    name,
    ...(display.title !== undefined ? { title: display.title } : {}),
    ...(display.description !== undefined
      ? { description: display.description }
      : {}),
    ...(display.icon ? { icon: display.icon } : {}),
    ...(display.category !== undefined ? { category: display.category } : {}),
    ...(display.sortOrder !== undefined ? { sortOrder: display.sortOrder } : {}),
    url,
  };
}

function compareScreens(left: CapsuleAppScreen, right: CapsuleAppScreen): number {
  const declared = (left.sortOrder ?? Number.MAX_SAFE_INTEGER) -
    (right.sortOrder ?? Number.MAX_SAFE_INTEGER);
  if (declared !== 0) return declared;
  const titled = (left.title ?? "").localeCompare(right.title ?? "");
  return titled || left.interfaceId.localeCompare(right.interfaceId);
}

function safeLaunchUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.hash) return undefined;
    if (hasCredentialQueryParams(url.searchParams)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeImageUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    if (hasCredentialQueryParams(url.searchParams)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

// --- version ---------------------------------------------------------------------

/** A Git URL without userinfo, query or fragment. */
export function credentialFreeRepositoryUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

async function readVersion(
  operations: ControlPlaneOperations,
  capsule: Capsule,
  input: {
    readonly source?: Source;
    readonly adopted?: CapsuleAdoptedSourceRevision;
    readonly onIncomplete: () => void;
  },
): Promise<CapsuleAppVersion> {
  const repositoryUrl = input.source
    ? credentialFreeRepositoryUrl(input.source.url)
    : undefined;
  const current = input.adopted;
  let latest: SourceSnapshot | undefined;
  if (current && capsule.status !== "destroyed") {
    try {
      const scan = await newestSnapshotForRef(operations, capsule.sourceId, current);
      latest = scan.snapshot;
      if (!scan.complete) input.onIncomplete();
    } catch {
      input.onIncomplete();
    }
  }
  return {
    ...(repositoryUrl && input.source
      ? { repository: { url: repositoryUrl, defaultRef: input.source.defaultRef } }
      : {}),
    ...(current
      ? {
          current: {
            sourceSnapshotId: current.sourceSnapshotId,
            ref: current.ref,
            path: current.path,
            commit: current.resolvedCommit,
          },
        }
      : {}),
    ...(latest
      ? {
          latest: {
            sourceSnapshotId: latest.id,
            ref: latest.ref,
            commit: latest.resolvedCommit,
            fetchedAt: latest.fetchedAt,
          },
        }
      : {}),
    updateAvailable: Boolean(
      current && latest && latest.resolvedCommit !== current.resolvedCommit,
    ),
    stale: capsule.status === "stale",
    autoUpdate: capsule.autoUpdate === true,
  };
}

/**
 * The newest snapshot of the current ref. Snapshots list oldest first by
 * `(fetchedAt, id)`, so the scan starts right after the current snapshot and
 * reads only the snapshots fetched since it.
 */
async function newestSnapshotForRef(
  operations: ControlPlaneOperations,
  sourceId: string,
  current: CapsuleAdoptedSourceRevision,
): Promise<{ readonly snapshot?: SourceSnapshot; readonly complete: boolean }> {
  const base = await operations.getSourceSnapshot(current.sourceSnapshotId);
  let newest: SourceSnapshot | undefined = base.sourceId === sourceId ? base : undefined;
  let cursor: string | undefined = encodeCursor({ createdAt: base.fetchedAt, id: base.id });
  for (let page = 0; page < APP_SNAPSHOT_PAGE_LIMIT; page += 1) {
    const result = await operations.listSourceSnapshots(sourceId, { limit: 100, cursor });
    for (const snapshot of result.snapshots) {
      if (snapshot.ref !== current.ref) continue;
      if (
        !newest ||
        snapshot.fetchedAt > newest.fetchedAt ||
        (snapshot.fetchedAt === newest.fetchedAt && snapshot.id > newest.id)
      ) {
        newest = snapshot;
      }
    }
    if (!result.nextCursor) {
      return { ...(newest ? { snapshot: newest } : {}), complete: true };
    }
    cursor = result.nextCursor;
  }
  return { ...(newest ? { snapshot: newest } : {}), complete: false };
}

// --- uninstall --------------------------------------------------------------------

interface UninstallAdmission {
  readonly schedule: boolean;
  readonly cancel: boolean;
}

/**
 * Whether the schedule and cancel commands would admit a request now. Hosts
 * wire the Capsule service's own rules (including the runtime safety
 * projection); a host without that read falls back to the state-only part.
 */
async function readUninstallAdmission(
  operations: ControlPlaneOperations,
  capsule: Capsule,
  applied: boolean,
): Promise<UninstallAdmission> {
  if (capsule.status === "destroyed") return { schedule: false, cancel: false };
  const scheduling = typeof operations.capsules.scheduleCapsuleUninstall === "function";
  const admission = typeof operations.capsules.uninstallAdmission === "function"
    ? await operations.capsules.uninstallAdmission.call(operations.capsules, capsule)
    : {
        schedule: capsule.status === "uninstalled" ||
          (applied &&
            (capsule.status === "active" ||
              capsule.status === "stale" ||
              capsule.status === "error")),
        cancel: capsule.status === "uninstalled" &&
          capsule.uninstall?.phase === "scheduled",
      };
  return {
    schedule: scheduling && admission.schedule,
    cancel: typeof operations.capsules.cancelCapsuleUninstall === "function" &&
      admission.cancel,
  };
}

function uninstallTerms(
  operations: ControlPlaneOperations,
  capsule: Capsule,
  input: {
    readonly applied: boolean;
    readonly admission: UninstallAdmission;
    readonly latestRun?: CapsuleAppRunSummary;
  },
): CapsuleAppUninstall {
  const graceDays = operations.capsules.uninstallGraceDays;
  const mode: CapsuleAppUninstall["mode"] = capsule.status === "destroyed"
    ? "none"
    : !input.applied
      ? "discard"
      : input.admission.schedule
        ? "scheduled"
        : "none";
  const live = liveCapsuleUninstall(capsule, input.latestRun);
  const pending = live &&
    (live.phase === "scheduled" || live.phase === "destroying")
    ? live
    : undefined;
  const scheduled: CapsuleAppUninstall["scheduled"] = pending
    ? {
        phase: pending.phase === "destroying" ? "destroying" : "scheduled",
        requestedAt: pending.requestedAt,
        deleteAfter: pending.scheduledDestroyAt,
        cancellable: input.admission.cancel,
        blocked: pending.blockedReason !== undefined,
        ...(pending.preDestroyExport
          ? {
              preDestroyExport: {
                status: pending.preDestroyExport.status,
                ...(pending.preDestroyExport.includesServiceData !== undefined
                  ? { includesServiceData: pending.preDestroyExport.includesServiceData }
                  : {}),
              },
            }
          : {}),
      }
    : undefined;
  return {
    mode,
    ...(mode === "scheduled" && typeof graceDays === "number" ? { graceDays } : {}),
    ...(scheduled ? { scheduled } : {}),
  };
}

// --- helpers ------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
