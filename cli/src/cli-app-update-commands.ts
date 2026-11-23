/** Ordinary Accounts/PAT clients of the revision, rollback, history and Run surfaces. */
import { CAPSULE_APP_VIEW_KIND } from "takosumi-contract/capsules";
import type { PublicRun } from "takosumi-contract/runs";
import { MAX_PAGE_LIMIT } from "takosumi-contract/pagination";
import { parseDestroyProviderConnectionReplacements } from "takosumi-contract/connections";
import { isProviderResolutionStatus } from "takosumi-contract/provider-resolution";
import process from "node:process";
import type { CliIo } from "./cli-io.ts";
import { isJapaneseCli } from "./cli-help.ts";
import { DeployControlApiError, deployControlApiBase, requestDeployControlApi, type CliOptions } from "./cli-deploy-control-api.ts";
import { canonicalJson, isRecord } from "./cli-util.ts";

const MAX_WAIT_MS = 120_000;
const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SETTLED = new Set(["succeeded", "failed", "cancelled", "expired"]);
class Refusal extends Error { constructor(readonly code: string) { super(code); } }
type ApplyRunType = "apply" | "destroy_apply";
type Scope = { readonly appId: string; readonly planId: string; readonly workspaceId: string; readonly type: ApplyRunType };
const ARGUMENT_REFUSALS = new Set([
  "app_id_required", "unknown_option", "option_value_required", "invalid_boolean_option",
  "unexpected_argument", "duplicate_option", "invalid_timeout", "invalid_origin", "conflicting_modes",
  "exact_ref_and_idempotency_key_required", "saved_plan_and_explicit_confirmation_required",
  "invalid_connection_replacements", "destroy_plan_id_required", "revision_plan_id_required", "exact_ref_required",
  "state_version_and_idempotency_key_required",
  "invalid_history_limit", "invalid_history_cursor",
]);

/** Preserve inline '=' values, reject unknown flags and extra positionals. */
function argumentsFor(args: readonly string[], kind: "update" | "rollback" | "history" | "apply" | "recover-uninstall") {
  const [appId, ...rest] = args;
  if (appId === "--help" || appId === "-h" || rest.includes("--help") || rest.includes("-h")) return { help: true } as const;
  if (!bounded(appId, 256) || appId.startsWith("--")) throw new Refusal("app_id_required");
  const operationOptions = { update: ["ref", "idempotencyKey", "revisionPlan"], rollback: ["stateVersion", "idempotencyKey"], history: ["limit", "cursor"], apply: ["plan", "destroyPlan"],
    "recover-uninstall": ["connections", "destroyPlan"] }[kind];
  const strings = new Set(["url", "deployControlUrl", "token", "timeoutMs", ...operationOptions]);
  const booleans = new Set([
    "json",
    ...(kind === "apply" ? ["yes", "allowDestroy", "observeOnly"] : []),
    ...(kind === "recover-uninstall" ? ["currentReview"] : []),
  ]);
  const options: CliOptions = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) throw new Refusal("unexpected_argument");
    const equal = arg.indexOf("=");
    const key = arg.slice(2, equal < 0 ? undefined : equal).replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
    if (Object.hasOwn(options, key)) throw new Refusal("duplicate_option");
    if (booleans.has(key)) {
      if (equal >= 0) throw new Refusal("invalid_boolean_option");
      options[key] = true;
    } else if (strings.has(key)) {
      const value = equal >= 0 ? arg.slice(equal + 1) : rest[++i];
      if (typeof value !== "string" || equal < 0 && value.startsWith("--") || value.length === 0) throw new Refusal("option_value_required");
      options[key] = value;
    } else throw new Refusal("unknown_option");
  }
  const wait = options.timeoutMs === undefined ? MAX_WAIT_MS : Number(options.timeoutMs);
  if (!Number.isSafeInteger(wait) || wait < 1 || wait > MAX_WAIT_MS) throw new Refusal("invalid_timeout");
  if (options.yes === true && options.observeOnly === true) throw new Refusal("conflicting_modes");
  return { help: false, appId, options, wait } as const;
}

function selectTarget(options: CliOptions): CliOptions {
  const url = deployControlApiBase(options);
  const base = new URL(url);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Refusal("invalid_origin");
  const token = typeof options.token === "string" ? options.token : process.env.TAKOSUMI_ACCOUNT_TOKEN;
  if (!token) throw new Refusal("accounts_pat_required");
  // Pin selected transport inputs, not semantic identity: each route still
  // authenticates the token and checks current authority independently.
  return { ...options, url, token };
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(new Refusal("observation_timeout")); controller.abort();
  }, ms); });
  try { return await Promise.race([work(controller.signal), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new Refusal("observation_timeout")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function client(options: CliOptions, signal: AbortSignal) {
  return (path: string, method = "GET", body?: unknown, key?: string) => requestDeployControlApi({
    path, method, ...(body !== undefined ? { body } : {}), options, auth: "accounts", signal,
    ...(key ? { extraHeaders: { "Idempotency-Key": key } } : {}),
  });
}
type Client = ReturnType<typeof client>;

function runFrom(value: unknown, appId: string, id?: string): PublicRun {
  const run = isRecord(value) ? value.run : undefined;
  if (!isRecord(run) || !bounded(run.id, 256) || (id !== undefined && run.id !== id) ||
    run.capsuleId !== appId || !bounded(run.workspaceId, 256) || !bounded(run.type, 64) ||
    !["queued", "running", "waiting_approval", ...SETTLED].includes(String(run.status))) throw new Refusal("run_identity_mismatch");
  return run as unknown as PublicRun;
}

function savedChangePlan(run: PublicRun, mismatch: string): PublicRun {
  if (!bounded(run.planDigest, 256) || !Number.isSafeInteger(run.baseStateGeneration) ||
    (run.baseStateGeneration ?? 0) < 1 || !bounded(run.sourceSnapshotId, 256)) throw new Refusal(mismatch);
  if (run.policyStatus !== undefined && !["pass", "warn", "deny"].includes(run.policyStatus)) throw new Refusal("invalid_policy_projection");
  return run;
}

function revisionRun(run: PublicRun, ref?: string): PublicRun {
  if (run.type !== "plan" || run.origin?.kind !== "revision" || !bounded(run.origin.ref, 1024) ||
    (ref !== undefined && run.origin.ref !== ref)) throw new Refusal("revision_plan_mismatch");
  return savedChangePlan(run, "revision_plan_mismatch");
}

function rollbackRun(run: PublicRun, target?: string): PublicRun {
  if (run.type !== "plan" || run.origin?.kind !== "rollback" ||
    !bounded(run.origin.stateVersionId, 256) || (target !== undefined && run.origin.stateVersionId !== target)) {
    throw new Refusal("rollback_plan_mismatch");
  }
  return run;
}

function savedApplyPlan(run: PublicRun, type: ApplyRunType): PublicRun {
  if (type === "apply") {
    return run.origin?.kind === "rollback"
      ? savedChangePlan(rollbackRun(run), "rollback_plan_mismatch")
      : revisionRun(run);
  }
  if (run.type !== "destroy_plan" || !bounded(run.planDigest, 256) ||
    !Number.isSafeInteger(run.baseStateGeneration) || (run.baseStateGeneration ?? 0) < 1 ||
    !bounded(run.applyExpected?.currentStateVersionId, 256)) throw new Refusal("destroy_plan_mismatch");
  return run;
}

function connectionReplacements(value: unknown) {
  if (typeof value !== "string") throw new Refusal("invalid_connection_replacements");
  try {
    return parseDestroyProviderConnectionReplacements(JSON.parse(value));
  } catch {
    throw new Refusal("invalid_connection_replacements");
  }
}

function destroyProviderReview(plan: PublicRun) {
  if (plan.type !== "destroy_plan" || plan.providerResolutions === undefined) return undefined;
  if (!Array.isArray(plan.providerResolutions)) throw new Refusal("invalid_plan_projection");
  return plan.providerResolutions.map(row => {
    if (!isRecord(row) || !isRecord(row.requirement) || !bounded(row.requirement.providerSource, 512) ||
      (row.requirement.alias !== undefined && !bounded(row.requirement.alias, 256)) || !isProviderResolutionStatus(row.status)) {
      throw new Refusal("invalid_plan_projection");
    }
    const connectionId = row.connectionId ?? (isRecord(row.evidence) && row.evidence.kind === "provider_connection"
      ? row.evidence.connectionId : undefined);
    if (connectionId !== undefined && !bounded(connectionId, 256)) throw new Refusal("invalid_plan_projection");
    return { provider: row.requirement.providerSource, alias: row.requirement.alias, connectionId, status: row.status };
  });
}

function review(plan: PublicRun) {
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (plan.planResources !== undefined && (!Array.isArray(plan.planResources) || plan.planResources.some(r =>
    !isRecord(r) || !bounded(r.address, 4096) || !bounded(r.type, 256) || !Array.isArray(r.actions) ||
    r.actions.some(action => !bounded(action, 64) || !/^[a-z][a-z0-9_-]*$/u.test(action))))) throw new Refusal("invalid_plan_projection");
  if (plan.policyReasons !== undefined && !Array.isArray(plan.policyReasons)) throw new Refusal("invalid_policy_projection");
  return {
    id: plan.id, status: plan.status, ref: plan.origin?.kind === "revision" ? plan.origin.ref : undefined,
    stateVersionId: plan.origin?.kind === "rollback" ? plan.origin.stateVersionId : undefined,
    sourceSnapshotId: plan.sourceSnapshotId, planDigest: plan.planDigest, baseStateGeneration: plan.baseStateGeneration,
    policyStatus: plan.policyStatus ?? "unknown",
    policyCodes: plan.policyReasons?.map(r => r.code).filter(c => typeof c === "string" && TOKEN.test(c)),
    changes: { add: count(plan.summary?.add), change: count(plan.summary?.change), destroy: count(plan.summary?.destroy) },
    resources: plan.planResources?.map(r => ({ address: r.address, type: r.type, actions: r.actions })),
    providerConnections: destroyProviderReview(plan),
  };
}

function write(io: CliIo, options: CliOptions, value: Record<string, unknown>): void {
  // The allowlisted result is the same in both modes; no whole API envelope,
  // artifact locator, variables, token or unfiltered exception is emitted.
  if (options.json === true) io.stdout(JSON.stringify(value));
  else io.stdout(JSON.stringify(value, null, 2));
}

function errorCode(error: unknown): string {
  if (error instanceof Refusal) return error.code;
  if (error instanceof DeployControlApiError) return TOKEN.test(error.code ?? "") ? error.code! : `http_${error.status}`;
  return "request_not_confirmed";
}

function destroyConnectionRecoveryFailure(error: unknown) {
  if (!(error instanceof DeployControlApiError) || error.status !== 409 ||
    error.code !== "failed_precondition" || !isRecord(error.body) || !isRecord(error.body.error)) return undefined;
  const { details } = error.body.error;
  if (!isRecord(details) || details.reason !== "destroy_connection_recovery_unproven") return undefined;
  switch (details.connectionRecoveryFailure) {
    case "replacement_unverified":
    case "replacement_auth_mode_mismatch":
    case "bindings_mismatch":
    case "applied_evidence_unavailable":
      return details.connectionRecoveryFailure;
  }
}

function runUrl(options: CliOptions, id: string) { return `${deployControlApiBase(options)}/runs/${encodeURIComponent(id)}`; }

export async function runAppUpdate(args: string[], io: CliIo): Promise<number> {
  let options: CliOptions = {};
  let appId: string | undefined;
  let revisionPlanId: string | undefined;
  let ref: string | undefined;
  let key: string | undefined;
  let createAttempted = false;
  let coordinatorReturned = false;
  try {
    const parsed = argumentsFor(args, "update");
    if (parsed.help) { io.stdout(updateHelp()); return 0; }
    ({ appId, options } = parsed);
    ref = typeof options.ref === "string" ? options.ref : undefined;
    key = typeof options.idempotencyKey === "string" ? options.idempotencyKey : undefined;
    const savedRevisionId = typeof options.revisionPlan === "string" ? options.revisionPlan : undefined;
    if (savedRevisionId !== undefined) {
      if (key !== undefined) throw new Refusal("conflicting_modes");
      if (!TOKEN.test(savedRevisionId)) throw new Refusal("revision_plan_id_required");
      if (!bounded(ref, 1024)) throw new Refusal("exact_ref_required");
    } else if (!bounded(ref, 1024) || !bounded(key, 256)) {
      throw new Refusal("exact_ref_and_idempotency_key_required");
    }
    options = selectTarget(options);
    const requestedRef = ref; const retainedKey = key; const selectedApp = appId;
    const plan = await within(parsed.wait, async signal => {
      const request = client(options, signal);
      let current: unknown;
      if (savedRevisionId !== undefined) {
        current = await request(`/api/v1/revision-plans/${encodeURIComponent(savedRevisionId)}`);
      } else {
        createAttempted = true;
        current = await request(`/api/v1/capsules/${encodeURIComponent(selectedApp)}/revision-plans`, "POST", { ref: requestedRef }, retainedKey);
        coordinatorReturned = true;
      }
      let delay = 250; let lastProgress: string | undefined; let coordinatorIdentity: string | undefined;
      for (let step = 0; step <= 120; step++) {
        signal.throwIfAborted();
        const rp = isRecord(current) ? current.revisionPlan : undefined;
        if (!isRecord(current) || !isRecord(rp) || !bounded(rp.id, 256) || rp.capsuleId !== selectedApp || rp.operation !== "revision" ||
          !bounded(rp.workspaceId, 256) || !isRecord(rp.revision) || rp.revision.targetRef !== requestedRef || !isRecord(rp.revision.base) ||
          !Number.isSafeInteger(rp.revision.base.capsuleStateGeneration) || Number(rp.revision.base.capsuleStateGeneration) < 1 ||
          (savedRevisionId !== undefined && savedRevisionId !== rp.id)) {
          throw new Refusal("revision_identity_mismatch");
        }
        const identity = canonicalJson([rp.id, rp.workspaceId, rp.capsuleId, rp.revision]);
        if (coordinatorIdentity !== undefined && coordinatorIdentity !== identity) throw new Refusal("revision_identity_mismatch");
        coordinatorIdentity = identity;
        revisionPlanId = rp.id;
        coordinatorReturned = true;
        if (current.nextAction === "review_run" && bounded(rp.planRunId, 256)) {
          const plan = revisionRun(runFrom(await request(`/api/v1/runs/${encodeURIComponent(rp.planRunId)}`), selectedApp, rp.planRunId), requestedRef);
          if (plan.workspaceId !== rp.workspaceId || plan.baseStateGeneration !== rp.revision.base.capsuleStateGeneration ||
            !bounded(rp.sourceSnapshotId, 256) || plan.sourceSnapshotId !== rp.sourceSnapshotId ||
            (rp.revision.base.capsuleStateVersionId !== undefined && plan.applyExpected?.currentStateVersionId !== rp.revision.base.capsuleStateVersionId)) throw new Refusal("revision_plan_evidence_mismatch");
          return plan;
        }
        if (current.nextAction !== "reconcile") throw new Refusal(isRecord(rp.diagnostic) && TOKEN.test(String(rp.diagnostic.code)) ? String(rp.diagnostic.code) : "revision_not_reviewable");
        if (step === 120) throw new Refusal("reconcile_limit");
        const progress = JSON.stringify([rp.phase, rp.sourceSnapshotId, rp.compatibilityReportId, rp.planRunId]);
        delay = progress === lastProgress ? Math.min(5_000, delay * 2) : 250;
        lastProgress = progress;
        if (step > 0) await pause(delay, signal);
        current = await request(`/api/v1/revision-plans/${encodeURIComponent(revisionPlanId)}/reconcile`, "POST");
      }
      throw new Refusal("reconcile_limit");
    });
    if (plan.status !== "succeeded" && plan.status !== "waiting_approval") {
      write(io, options, { status: "plan_not_reviewable", appId, revisionPlanId, planRunId: plan.id,
        planStatus: plan.status, reviewUrl: runUrl(options, plan.id) });
      return 1;
    }
    write(io, options, { status: "review_required", appId, revisionPlanId, planRunId: plan.id, reviewUrl: runUrl(options, plan.id), plan: review(plan) });
    return 0;
  } catch (error) {
    const refused = !coordinatorReturned &&
      (!createAttempted || error instanceof DeployControlApiError && error.status >= 400 && error.status < 500);
    write(io, options, { status: refused ? "refused" : "unconfirmed", appId, revisionPlanId, ref, code: errorCode(error),
      recovery: revisionPlanId || options.revisionPlan !== undefined
        ? "Retry the same app/ref and coordinator ID with --revision-plan."
        : "Retry only the same app/ref/idempotency key and Accounts identity; no approval or Apply was requested." });
    return error instanceof Refusal && ARGUMENT_REFUSALS.has(error.code) ? 2 : 1;
  }
}

/** Read one page of the same state history used by the app dashboard. */
export async function runAppHistory(args: string[], io: CliIo): Promise<number> {
  let options: CliOptions = {};
  let appId: string | undefined;
  try {
    const parsed = argumentsFor(args, "history");
    if (parsed.help) { io.stdout(historyHelp()); return 0; }
    ({ appId, options } = parsed);
    const { limit, cursor } = options;
    if (limit !== undefined && (typeof limit !== "string" || !/^[1-9][0-9]*$/u.test(limit) || Number(limit) > MAX_PAGE_LIMIT)) {
      throw new Refusal("invalid_history_limit");
    }
    if (cursor !== undefined && !bounded(cursor, 4096)) throw new Refusal("invalid_history_cursor");
    const query = new URLSearchParams();
    if (typeof limit === "string") query.set("limit", limit);
    if (typeof cursor === "string") query.set("cursor", cursor);
    const selectedApp = appId;
    const path = `/api/v1/capsules/${encodeURIComponent(selectedApp)}/state-versions${query.size ? `?${query}` : ""}`;
    const target = selectTarget(options);
    const page = await within(parsed.wait, signal => client(target, signal)(path));
    if (!isRecord(page) || !Array.isArray(page.stateVersions) || page.stateVersions.length > Number(limit ?? MAX_PAGE_LIMIT) ||
      (page.nextCursor !== undefined && (!bounded(page.nextCursor, 4096) || page.nextCursor === cursor))) {
      throw new Refusal("invalid_state_version_history");
    }
    const stateVersions = page.stateVersions.map((version: unknown) => {
      if (!isRecord(version) || version.capsuleId !== selectedApp || !bounded(version.id, 256) ||
        !bounded(version.environment, 256) || typeof version.generation !== "number" ||
        !Number.isSafeInteger(version.generation) || version.generation < 1 ||
        !bounded(version.createdAt, 128) || !bounded(version.createdByRunId, 256)) {
        throw new Refusal("state_version_identity_mismatch");
      }
      return {
        id: version.id, generation: version.generation, environment: version.environment,
        createdAt: version.createdAt, createdByRunId: version.createdByRunId,
      };
    });
    write(io, options, { appId, stateVersions, nextCursor: page.nextCursor });
    return 0;
  } catch (error) {
    write(io, options, { status: "refused", appId, code: errorCode(error) });
    return error instanceof Refusal && ARGUMENT_REFUSALS.has(error.code) ? 2 : 1;
  }
}

export async function runAppRollback(args: string[], io: CliIo): Promise<number> {
  let options: CliOptions = {};
  let appId: string | undefined;
  let stateVersionId: string | undefined;
  let planRunId: string | undefined;
  let submitted = false;
  try {
    const parsed = argumentsFor(args, "rollback");
    if (parsed.help) { io.stdout(rollbackHelp()); return 0; }
    ({ appId, options } = parsed);
    const target = options.stateVersion;
    const key = options.idempotencyKey;
    if (!bounded(target, 256) || !bounded(key, 256)) throw new Refusal("state_version_and_idempotency_key_required");
    stateVersionId = target;
    options = selectTarget(options);
    const selectedApp = appId;
    const plan = await within(parsed.wait, async signal => {
      const request = client(options, signal);
      const path = `/api/v1/state-versions/${encodeURIComponent(target)}`;
      const body = await request(path);
      const version = isRecord(body) ? body.stateVersion : undefined;
      if (!isRecord(version) || version.id !== target || version.capsuleId !== selectedApp ||
        !bounded(version.workspaceId, 256) || !bounded(version.environment, 256) ||
        !Number.isSafeInteger(version.generation) || Number(version.generation) < 1) throw new Refusal("state_version_identity_mismatch");
      const scopedRun = (value: unknown, id?: string) => {
        const run = rollbackRun(runFrom(value, selectedApp, id), target);
        if (run.workspaceId !== version.workspaceId) throw new Refusal("rollback_plan_mismatch");
        return run;
      };
      signal.throwIfAborted();
      submitted = true;
      const accepted = scopedRun(await request(`${path}/rollback-plan`, "POST", {}, key));
      planRunId = accepted.id;
      for (;;) {
        const run = scopedRun(await request(`/api/v1/runs/${encodeURIComponent(accepted.id)}`), accepted.id);
        if (run.status !== "queued" && run.status !== "running") return run;
        await pause(1_000, signal);
      }
    });
    const reviewUrl = runUrl(options, plan.id);
    if (plan.status !== "succeeded" && plan.status !== "waiting_approval") {
      write(io, options, { status: "plan_not_reviewable", appId, stateVersionId, planRunId: plan.id,
        planStatus: plan.status, reviewUrl });
      return 1;
    }
    write(io, options, { status: "review_required", appId, stateVersionId, planRunId: plan.id, reviewUrl,
      plan: review(savedChangePlan(plan, "rollback_plan_mismatch")) });
    return 0;
  } catch (error) {
    const refused = !submitted || (!planRunId && error instanceof DeployControlApiError && error.status >= 400 && error.status < 500);
    write(io, options, { status: refused ? "refused" : "unconfirmed", appId, stateVersionId, planRunId, code: errorCode(error),
      recovery: submitted && !refused
        ? "Retry only the same app, StateVersion, idempotency key, target URL, and Accounts identity."
        : undefined });
    return error instanceof Refusal && ARGUMENT_REFUSALS.has(error.code) ? 2 : 1;
  }
}

async function readDestroyReviewPointer(request: Client, appPath: string, appId: string) {
  const body = await request(`${appPath}/app`);
  const app = isRecord(body) ? body.app : undefined;
  if (!isRecord(app) || app.kind !== CAPSULE_APP_VIEW_KIND ||
    app.capsuleId !== appId || !bounded(app.workspaceId, 256) ||
    app.applied !== true || app.status === "destroyed" ||
    !isRecord(app.progress) || !isRecord(app.uninstall)) {
    throw new Refusal("current_destroy_review_unavailable");
  }
  const { progress, latestRun } = app;
  const scheduled = app.uninstall.scheduled;
  const reservation = isRecord(scheduled) ? scheduled : undefined;
  const { phase: scheduledPhase, requestedAt, deleteAfter } = reservation ?? {};
  if (progress.revisionPreparing !== false || !isRecord(latestRun) ||
    latestRun.type !== "destroy_plan" || !bounded(latestRun.id, 256) ||
    ((scheduled !== undefined || app.status === "uninstalled") &&
      scheduledPhase !== "scheduled" && scheduledPhase !== "destroying")) {
    throw new Refusal("current_destroy_review_unavailable");
  }
  const { id, status } = latestRun;
  if (status === "queued" || status === "running") {
    const pending = progress.run;
    if (progress.review !== undefined || !isRecord(pending) ||
      pending.id !== id || pending.type !== "destroy_plan" || pending.status !== status) {
      throw new Refusal("current_destroy_review_unavailable");
    }
  } else if (status === "failed") {
    if (progress.run !== undefined || progress.review !== undefined) {
      throw new Refusal("current_destroy_review_unavailable");
    }
    if (reservation) {
      // Accounts omits this problem for an older reservation or the finalizer.
      if (scheduledPhase !== "scheduled" || !bounded(requestedAt, 64) || !bounded(deleteAfter, 64) ||
        !Array.isArray(app.problems) || !app.problems.some(problem =>
          isRecord(problem) && problem.runId === id && problem.runType === "destroy_plan" &&
          (problem.code === "uninstall_failed" || problem.code === "policy_blocked"))) {
        throw new Refusal("current_destroy_review_unavailable");
      }
    }
  } else {
    const review = progress.review;
    if ((status !== "waiting_approval" && status !== "succeeded") ||
      progress.run !== undefined || !isRecord(review) ||
      review.runType !== "destroy_plan" || review.runId !== id) {
      throw new Refusal("current_destroy_review_unavailable");
    }
  }
  return { id, workspaceId: app.workspaceId, status, scheduledPhase, requestedAt, deleteAfter };
}

function destroyReviewAdvanced(before: string, after: string): boolean {
  return (before === "queued" && after === "running") ||
    ((before === "queued" || before === "running") &&
      (after === "waiting_approval" || after === "succeeded" || after === "failed"));
}

async function readManualDestroyPlan(
  request: Client, appPath: string, appId: string,
  selected: Awaited<ReturnType<typeof readDestroyReviewPointer>>,
): Promise<PublicRun> {
  let needsSourceSnapshot = false;
  if (selected.scheduledPhase === "scheduled" || selected.scheduledPhase === "destroying") {
    // Older scheduled Plans may lack origin in the Run projection. The
    // reservation names its own Plan before advancing to the destroying phase.
    const body = await request(appPath);
    const capsule = isRecord(body) ? body.capsule : undefined;
    const reservation = isRecord(capsule) ? capsule.uninstall : undefined;
    if (!isRecord(capsule) || capsule.id !== appId || capsule.workspaceId !== selected.workspaceId ||
      !isRecord(reservation) || reservation.phase !== selected.scheduledPhase ||
      (selected.requestedAt !== undefined && reservation.requestedAt !== selected.requestedAt) ||
      (selected.deleteAfter !== undefined && reservation.scheduledDestroyAt !== selected.deleteAfter) ||
      reservation.destroyPlanRunId === selected.id ||
      (reservation.destroyPlanRunId === undefined
        ? selected.scheduledPhase === "destroying"
        : !bounded(reservation.destroyPlanRunId, 256))) {
      throw new Refusal("current_destroy_review_unavailable");
    }
    // A pre-v1 source-less finalizer can allocate a different Run ID before
    // updating the reservation. A Plan with a pinned Git snapshot uses the
    // path that preserves the finalizer's reserved ID and origin.
    needsSourceSnapshot = selected.scheduledPhase === "scheduled" &&
      reservation.destroyPlanRunId !== undefined;
  }
  const run = runFrom(await request(`/api/v1/runs/${encodeURIComponent(selected.id)}`), appId, selected.id);
  if (run.type !== "destroy_plan" || run.workspaceId !== selected.workspaceId ||
    (run.status !== selected.status && !destroyReviewAdvanced(selected.status, run.status)) ||
    run.origin?.kind === "scheduled_uninstall" ||
    (needsSourceSnapshot && !bounded(run.sourceSnapshotId, 256))) {
    throw new Refusal("current_destroy_review_unavailable");
  }
  return run;
}

/** Find the current manual Destroy Plan, then recheck both the Run and app. */
async function currentDestroyReview(request: Client, appId: string): Promise<PublicRun> {
  const appPath = `/api/v1/capsules/${encodeURIComponent(appId)}`;
  let selected = await readDestroyReviewPointer(request, appPath, appId);
  for (;;) {
    const run = await readManualDestroyPlan(request, appPath, appId, selected);
    const current = await readDestroyReviewPointer(request, appPath, appId);
    if (current.id !== selected.id || current.workspaceId !== selected.workspaceId ||
      current.scheduledPhase !== selected.scheduledPhase ||
      current.requestedAt !== selected.requestedAt || current.deleteAfter !== selected.deleteAfter) break;
    if (current.status === run.status) return run;
    // Only a forward transition warrants another read. Queued and running are
    // the only nonterminal states in this projection, so there are at most two.
    if (!destroyReviewAdvanced(run.status, current.status)) break;
    selected = current;
  }
  throw new Refusal("current_destroy_review_unavailable");
}

/** Create a recovery Plan or read a saved review through the existing Accounts routes. */
export async function runAppRecoverUninstall(args: string[], io: CliIo): Promise<number> {
  let options: CliOptions = {};
  let appId: string | undefined;
  let planRunId: string | undefined;
  let submitted = false;
  try {
    const parsed = argumentsFor(args, "recover-uninstall");
    if (parsed.help) { io.stdout(recoverUninstallHelp()); return 0; }
    ({ appId, options } = parsed);
    const selectedApp = appId;
    const existingPlanId = options.destroyPlan;
    const useCurrentReview = options.currentReview === true;
    if (useCurrentReview && (existingPlanId !== undefined || options.connections !== undefined)) {
      throw new Refusal("conflicting_modes");
    }
    if (existingPlanId !== undefined) {
      if (options.connections !== undefined) throw new Refusal("conflicting_modes");
      if (!bounded(existingPlanId, 256)) throw new Refusal("destroy_plan_id_required");
      planRunId = existingPlanId;
    }
    const replacements = existingPlanId === undefined && !useCurrentReview
      ? connectionReplacements(options.connections)
      : undefined;
    options = selectTarget(options);
    const plan = await within(parsed.wait, async signal => {
      signal.throwIfAborted();
      const request = client(options, signal);
      if (useCurrentReview) return await currentDestroyReview(request, selectedApp);
      if (existingPlanId !== undefined) {
        return runFrom(await request(`/api/v1/runs/${encodeURIComponent(existingPlanId)}`), selectedApp, existingPlanId);
      }
      submitted = true;
      return runFrom(await request(
        `/api/v1/capsules/${encodeURIComponent(selectedApp)}/destroy-plan`, "POST",
        { destroyProviderConnectionReplacements: replacements },
      ), selectedApp);
    });
    if (plan.type !== "destroy_plan") throw new Refusal("destroy_plan_mismatch");
    planRunId = plan.id;
    const link = { appId, planRunId, planStatus: plan.status, reviewUrl: runUrl(options, plan.id) };
    if (plan.status === "queued" || plan.status === "running") {
      write(io, options, { status: "plan_pending", ...link });
      return 0;
    }
    if (plan.status !== "waiting_approval" && plan.status !== "succeeded") {
      write(io, options, { status: "failed", ...link,
        code: plan.errorCode && TOKEN.test(plan.errorCode) ? plan.errorCode : undefined });
      return 1;
    }
    write(io, options, { status: "review_required", ...link, plan: review(savedApplyPlan(plan, "destroy_apply")) });
    return 0;
  } catch (error) {
    const refused = !submitted || error instanceof DeployControlApiError && error.status >= 400 && error.status < 500;
    write(io, options, { status: refused ? "refused" : "unconfirmed", appId, planRunId, code: errorCode(error),
      connectionRecoveryFailure: submitted ? destroyConnectionRecoveryFailure(error) : undefined,
      recovery: refused ? undefined : "Use apps recover-uninstall with the same app and --current-review to inspect its current Destroy Plan, or check the app's Run history before requesting another." });
    return error instanceof Refusal && ARGUMENT_REFUSALS.has(error.code) ? 2 : 1;
  }
}

async function linkedApply(request: Client, scope: Scope): Promise<PublicRun | undefined> {
  const query = new URLSearchParams({ limit: "100", type: scope.type, planRunId: scope.planId });
  const seen = new Set<string>();
  let found: PublicRun | undefined;
  for (let page = 0; page < 100; page++) {
    const body = await request(`/api/v1/capsules/${encodeURIComponent(scope.appId)}/runs?${query}`);
    if (!isRecord(body) || !Array.isArray(body.runs)) throw new Refusal("run_history_incomplete");
    for (const row of body.runs) {
      const run = runFrom({ run: row }, scope.appId);
      if (run.type !== scope.type || run.workspaceId !== scope.workspaceId) throw new Refusal("run_history_identity_mismatch");
      if (run.planRunId === scope.planId) {
        if (found && found.id !== run.id) throw new Refusal("multiple_linked_apply_runs");
        found = run;
      }
    }
    if (body.nextCursor === undefined) return found;
    if (!bounded(body.nextCursor, 4096) || seen.has(body.nextCursor)) throw new Refusal("run_history_incomplete");
    query.set("cursor", body.nextCursor);
    seen.add(body.nextCursor);
  }
  throw new Refusal("run_history_incomplete");
}

function applyIdentity(run: PublicRun, scope: Scope): PublicRun {
  if (run.type !== scope.type || run.planRunId !== scope.planId || run.workspaceId !== scope.workspaceId) throw new Refusal("apply_identity_mismatch");
  return run;
}

async function readApply(request: Client, id: string, scope: Scope): Promise<PublicRun> {
  return applyIdentity(runFrom(await request(`/api/v1/runs/${encodeURIComponent(id)}`), scope.appId, id), scope);
}

async function watch(request: Client, run: PublicRun, scope: Scope, signal: AbortSignal): Promise<PublicRun> {
  let current = applyIdentity(run, scope);
  while (!SETTLED.has(current.status)) {
    await pause(1_000, signal);
    current = await readApply(request, run.id, scope);
  }
  return current;
}

function writeTerminalApply(io: CliIo, options: CliOptions, appId: string | undefined, planId: string | undefined, run: PublicRun): number {
  write(io, options, { status: run.status === "succeeded" ? "succeeded" : "failed", appId, planRunId: planId,
    runId: run.id, runStatus: run.status, runUrl: runUrl(options, run.id),
    code: run.errorCode && TOKEN.test(run.errorCode) ? run.errorCode : undefined,
    note: run.status !== "succeeded" ? "A failed or stopped Apply may have effects. Do not repeat it as a new Plan." : undefined });
  return run.status === "succeeded" ? 0 : 1;
}

function applyPlanIdentity(plan: PublicRun): string {
  return canonicalJson([plan.id, plan.type, plan.capsuleId, plan.workspaceId, plan.origin, plan.planDigest,
    plan.applyExpected, plan.sourceSnapshotId, plan.baseStateGeneration, destroyProviderReview(plan)]);
}

export async function runAppApply(args: string[], io: CliIo): Promise<number> {
  let options: CliOptions = {}; let appId: string | undefined; let planId: string | undefined;
  let scope: Scope | undefined; let lastRun: PublicRun | undefined; let lastPlan: PublicRun | undefined; let mutationAttempted = false;
  let expectedPlanIdentity: string | undefined; let locatedApplyId: string | undefined;
  let applyType: ApplyRunType = "apply";
  try {
    const parsed = argumentsFor(args, "apply");
    if (parsed.help) { io.stdout(applyHelp()); return 0; }
    ({ appId, options } = parsed);
    applyType = options.destroyPlan === undefined ? "apply" : "destroy_apply";
    const selectedPlanOption = options.destroyPlan ?? options.plan;
    if ((options.plan !== undefined && options.destroyPlan !== undefined) || !bounded(selectedPlanOption, 256) ||
      (options.yes !== true && options.observeOnly !== true)) throw new Refusal("saved_plan_and_explicit_confirmation_required");
    planId = selectedPlanOption;
    options = selectTarget(options);
    const selectedApp = appId; const selectedPlan = planId;
    lastRun = await within(parsed.wait, async signal => {
      const request = client(options, signal);
      let plan = savedApplyPlan(runFrom(await request(`/api/v1/runs/${encodeURIComponent(selectedPlan)}`), selectedApp, selectedPlan), applyType);
      lastPlan = plan;
      const initialIdentity = applyPlanIdentity(plan);
      expectedPlanIdentity = initialIdentity;
      scope = { appId: selectedApp, planId: selectedPlan, workspaceId: plan.workspaceId, type: applyType };
      const existing = await linkedApply(request, scope);
      if (existing) {
        locatedApplyId = existing.id;
        lastRun = await readApply(request, existing.id, scope);
        return await watch(request, lastRun, scope, signal);
      }
      if (options.observeOnly === true) throw new Refusal("linked_apply_not_observed");
      const body = await request(`/api/v1/capsules/${encodeURIComponent(selectedApp)}`);
      const cap = isRecord(body) ? body.capsule : undefined;
      if (!isRecord(cap) || cap.id !== selectedApp || cap.workspaceId !== plan.workspaceId || cap.status === "destroyed" ||
        cap.currentStateGeneration !== plan.baseStateGeneration || !bounded(cap.currentStateVersionId, 256) ||
        plan.applyExpected?.currentStateVersionId !== cap.currentStateVersionId) throw new Refusal("plan_state_changed");
      if (!["succeeded", "waiting_approval"].includes(plan.status) || plan.policyStatus !== "pass") throw new Refusal("plan_not_applyable");
      const projection = review(plan);
      if (applyType === "apply" && (Object.values(projection.changes).some(value => value === null) ||
        (projection.changes.destroy ?? 0) > 0) && options.allowDestroy !== true) {
        throw new Refusal("destructive_confirmation_required");
      }
      signal.throwIfAborted();
      io.stderr(JSON.stringify({ status: "applying_reviewed_plan", appId: selectedApp, plan: projection, reviewUrl: runUrl(options, plan.id) }));
      if (plan.status === "waiting_approval") {
        mutationAttempted = true;
        await request(`/api/v1/runs/${encodeURIComponent(selectedPlan)}/approve`, "POST", {});
        const approvedPlan = savedApplyPlan(runFrom(await request(`/api/v1/runs/${encodeURIComponent(selectedPlan)}`), selectedApp, selectedPlan), applyType);
        if (approvedPlan.status !== "succeeded" || approvedPlan.policyStatus !== "pass" || initialIdentity !== applyPlanIdentity(approvedPlan)) throw new Refusal("approved_plan_changed");
        plan = approvedPlan;
        lastPlan = plan;
        const raced = await linkedApply(request, scope);
        if (raced) {
          locatedApplyId = raced.id;
          lastRun = await readApply(request, raced.id, scope);
          return await watch(request, lastRun, scope, signal);
        }
      }
      signal.throwIfAborted(); mutationAttempted = true;
      lastRun = applyIdentity(runFrom(await request(`/api/v1/runs/${encodeURIComponent(selectedPlan)}/apply`, "POST", {}), selectedApp), scope);
      return await watch(request, lastRun, scope, signal);
    });
    return writeTerminalApply(io, options, appId, planId, lastRun);
  } catch (error) {
    // An uncertain mutation is never followed by another mutation. Fresh,
    // separately bounded reads can observe its exact linked Apply only.
    // Keep recovery evidence local: a late response from the aborted command
    // must not change its result while a fresh readback is being refused.
    let observedRun = lastRun; const observedApplyId = locatedApplyId; let observedPlan = lastPlan; let readbackConfirmed = false;
    if (scope && mutationAttempted && observedApplyId === undefined) {
      try { observedRun = await within(5_000, async signal => {
        const request = client(options, signal);
        const freshPlan = savedApplyPlan(runFrom(await request(`/api/v1/runs/${encodeURIComponent(scope!.planId)}`), scope!.appId, scope!.planId), scope!.type);
        if (freshPlan.workspaceId !== scope!.workspaceId || applyPlanIdentity(freshPlan) !== expectedPlanIdentity) throw new Refusal("observed_plan_changed");
        observedPlan = freshPlan;
        const observed = await linkedApply(request, scope!);
        if (!observed) return undefined;
        return await readApply(request, observed.id, scope!);
      }); readbackConfirmed = true; } catch { /* unavailable readback is not proof of no effect */ }
    }
    if (readbackConfirmed && observedRun && SETTLED.has(observedRun.status)) return writeTerminalApply(io, options, appId, planId, observedRun);
    write(io, options, { status: observedRun && !SETTLED.has(observedRun.status) ? "pending" : mutationAttempted || options.observeOnly === true ? "indeterminate" : "refused",
      appId, planRunId: planId, lastObservedPlanStatus: observedPlan?.status, runId: observedRun?.id ?? observedApplyId, runStatus: observedRun?.status, code: errorCode(error),
      recovery: applyType === "destroy_apply"
        ? "Use apps apply with the same app, --destroy-plan and --observe-only for readback."
        : "Use apps apply with the same app/plan and --observe-only for readback; no new Plan, key, approval or Apply is created by observation." });
    return error instanceof Refusal && ARGUMENT_REFUSALS.has(error.code) ? 2 : 1;
  }
}

export function updateHelp(): string {
  return ["takosumi apps update <app-id> --ref <exact-ref> --idempotency-key <retained-key>",
    "takosumi apps update <app-id> --ref <exact-ref> --revision-plan <coordinator-id>",
    isJapaneseCli() ? "Git更新を準備します。既存の更新はアプリ・ref・更新IDを指定して続けられます。承認・Applyは別操作です。" : "Prepare a Git update. Resume an existing update by specifying its app, ref, and coordinator ID. Approval and Apply are separate.",
    "--url <origin> --token <Accounts PAT with read,write> --json --timeout-ms <1..120000>", "Environment: TAKOSUMI_ACCOUNT_TOKEN"].join("\n");
}
export function rollbackHelp(): string {
  return ["takosumi apps rollback <app-id> --state-version <state-version-id> --idempotency-key <retained-key>",
    isJapaneseCli() ? "指定した状態バージョンへの復旧Planを準備します。承認とApplyは別操作です。" : "Prepare a rollback Plan for the specified StateVersion. Approval and Apply are separate.",
    "--url <origin> --token <Accounts PAT with read,write> --json --timeout-ms <1..120000>", "Environment: TAKOSUMI_ACCOUNT_TOKEN"].join("\n");
}
function historyHelp(): string {
  return ["takosumi apps history <app-id> [--limit <count>] [--cursor <nextCursor>]",
    isJapaneseCli() ? "保存済みの状態バージョンを1ページ表示します。復旧には表示されたIDを指定します。" : "List one page of saved StateVersions. Use the returned ID to select a rollback target.",
    `--limit <1..${MAX_PAGE_LIMIT}> --url <origin> --token <Accounts PAT with read> --json --timeout-ms <1..120000>`,
    "Environment: TAKOSUMI_ACCOUNT_TOKEN"].join("\n");
}
export function applyHelp(): string {
  return ["takosumi apps apply <app-id> --plan <saved-update-or-rollback-plan-run-id> --yes [--allow-destroy]",
    "takosumi apps apply <app-id> --plan <saved-update-or-rollback-plan-run-id> --observe-only",
    "takosumi apps apply <app-id> --destroy-plan <saved-destroy-plan-run-id> --yes",
    "takosumi apps apply <app-id> --destroy-plan <saved-destroy-plan-run-id> --observe-only",
    isJapaneseCli() ? "保存Planを明示実行し、有限時間だけRunを観測します。更新・復旧で削除・変更数不明の場合は --allow-destroy が必要です。" : "Execute the saved Plan explicitly and observe its Run for a bounded time. A revision or rollback with deletions or unknown counts needs --allow-destroy.",
    "--url <origin> --token <Accounts PAT> --json --timeout-ms <1..120000>",
    "Scopes: read for observation; read,write to execute. Environment: TAKOSUMI_ACCOUNT_TOKEN"].join("\n");
}

export function recoverUninstallHelp(): string {
  return ["takosumi apps recover-uninstall <app-id> --connections '<JSON array of replacement pairs>'",
    '[{"connectionId":"old-id","replacementConnectionId":"new-id"}]',
    "takosumi apps recover-uninstall <app-id> --destroy-plan <saved-destroy-plan-run-id>",
    "takosumi apps recover-uninstall <app-id> --current-review",
    isJapaneseCli() ? "--connections は削除Planを準備します。--destroy-plan は保存済みの同じPlanを読み取ります。--current-review はアプリの最新の手動削除Planが準備中、レビュー可能、または失敗した場合に、その状態を読み取ります。実行は別コマンドです。" : "Use --connections to prepare a Destroy Plan or --destroy-plan to read a specific saved Plan. Use --current-review to read the app’s latest manual Destroy Plan if it is pending, reviewable, or failed. Execution is a separate command.",
    "--url <origin> --token <Accounts PAT> --json --timeout-ms <1..120000>",
    "Scopes: read,write to prepare; read to review.",
    "Environment: TAKOSUMI_ACCOUNT_TOKEN"].join("\n");
}
