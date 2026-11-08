/** Ordinary Accounts/PAT clients of the existing revision and Run surfaces. */
import type { PublicRun } from "takosumi-contract/runs";
import process from "node:process";
import type { CliIo } from "./cli-io.ts";
import { isJapaneseCli } from "./cli-help.ts";
import { DeployControlApiError, deployControlApiBase, requestDeployControlApi, type CliOptions } from "./cli-deploy-control-api.ts";
import { canonicalJson, isRecord } from "./cli-util.ts";

const MAX_WAIT_MS = 120_000;
const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SETTLED = new Set(["succeeded", "failed", "cancelled", "expired"]);
class Refusal extends Error { constructor(readonly code: string) { super(code); } }
type Scope = { readonly appId: string; readonly planId: string; readonly workspaceId: string };

/** Preserve inline '=' values, reject unknown flags and extra positionals. */
function argumentsFor(args: readonly string[], kind: "update" | "apply") {
  const [appId, ...rest] = args;
  if (appId === "--help" || appId === "-h" || rest.includes("--help") || rest.includes("-h")) return { help: true } as const;
  if (!bounded(appId, 256) || appId.startsWith("--")) throw new Refusal("app_id_required");
  const strings = new Set(["url", "deployControlUrl", "token", "timeoutMs", ...(kind === "update" ? ["ref", "idempotencyKey"] : ["plan"])]);
  const booleans = new Set(["json", ...(kind === "apply" ? ["yes", "allowDestroy", "observeOnly"] : [])]);
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

function revisionRun(run: PublicRun, ref?: string): PublicRun {
  if (run.type !== "plan" || run.origin?.kind !== "revision" || !bounded(run.origin.ref, 1024) ||
    (ref !== undefined && run.origin.ref !== ref) || !bounded(run.planDigest, 256) ||
    !Number.isSafeInteger(run.baseStateGeneration) || (run.baseStateGeneration ?? 0) < 1 || !bounded(run.sourceSnapshotId, 256)) throw new Refusal("revision_plan_mismatch");
  if (run.policyStatus !== undefined && !["pass", "warn", "deny"].includes(run.policyStatus)) throw new Refusal("invalid_policy_projection");
  return run;
}

function review(plan: PublicRun) {
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (plan.planResources !== undefined && (!Array.isArray(plan.planResources) || plan.planResources.some(r =>
    !isRecord(r) || !bounded(r.address, 4096) || !bounded(r.type, 256) || !Array.isArray(r.actions) ||
    r.actions.some(action => !bounded(action, 64) || !/^[a-z][a-z0-9_-]*$/u.test(action))))) throw new Refusal("invalid_plan_projection");
  if (plan.policyReasons !== undefined && !Array.isArray(plan.policyReasons)) throw new Refusal("invalid_policy_projection");
  return {
    id: plan.id, status: plan.status, ref: plan.origin?.kind === "revision" ? plan.origin.ref : undefined,
    sourceSnapshotId: plan.sourceSnapshotId, planDigest: plan.planDigest, baseStateGeneration: plan.baseStateGeneration,
    policyStatus: plan.policyStatus ?? "unknown",
    policyCodes: plan.policyReasons?.map(r => r.code).filter(c => typeof c === "string" && TOKEN.test(c)),
    changes: { add: count(plan.summary?.add), change: count(plan.summary?.change), destroy: count(plan.summary?.destroy) },
    resources: plan.planResources?.map(r => ({ address: r.address, type: r.type, actions: r.actions })),
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
    if (!bounded(ref, 1024) || !bounded(key, 256)) throw new Refusal("exact_ref_and_idempotency_key_required");
    options = selectTarget(options);
    const requestedRef = ref; const retainedKey = key; const selectedApp = appId;
    const plan = await within(parsed.wait, async signal => {
      const request = client(options, signal);
      createAttempted = true;
      let current = await request(`/api/v1/capsules/${encodeURIComponent(selectedApp)}/revision-plans`, "POST", { ref: requestedRef }, retainedKey);
      coordinatorReturned = true;
      let delay = 250; let lastProgress: string | undefined; let coordinatorIdentity: string | undefined;
      for (let step = 0; step <= 120; step++) {
        signal.throwIfAborted();
        const rp = isRecord(current) ? current.revisionPlan : undefined;
        if (!isRecord(current) || !isRecord(rp) || !bounded(rp.id, 256) || rp.capsuleId !== selectedApp || rp.operation !== "revision" ||
          !bounded(rp.workspaceId, 256) || !isRecord(rp.revision) || rp.revision.targetRef !== requestedRef || !isRecord(rp.revision.base) ||
          !Number.isSafeInteger(rp.revision.base.capsuleStateGeneration) || Number(rp.revision.base.capsuleStateGeneration) < 1 ||
          (revisionPlanId !== undefined && revisionPlanId !== rp.id)) {
          throw new Refusal("revision_identity_mismatch");
        }
        const identity = canonicalJson([rp.id, rp.workspaceId, rp.capsuleId, rp.revision]);
        if (coordinatorIdentity !== undefined && coordinatorIdentity !== identity) throw new Refusal("revision_identity_mismatch");
        coordinatorIdentity = identity;
        revisionPlanId = rp.id;
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
    write(io, options, { status: "review_required", appId, revisionPlanId, planRunId: plan.id, reviewUrl: runUrl(options, plan.id), plan: review(plan) });
    return 0;
  } catch (error) {
    write(io, options, { status: !createAttempted || !coordinatorReturned && error instanceof DeployControlApiError && error.status >= 400 && error.status < 500 ? "refused" : "unconfirmed", appId, revisionPlanId, ref, code: errorCode(error),
      recovery: "Retry only the same app/ref/idempotency key and Accounts identity; no approval or Apply was requested." });
    return error instanceof Refusal && ["app_id_required", "unknown_option", "option_value_required", "invalid_boolean_option", "unexpected_argument", "duplicate_option", "invalid_timeout", "invalid_origin", "conflicting_modes", "exact_ref_and_idempotency_key_required"].includes(error.code) ? 2 : 1;
  }
}

async function linkedApply(request: Client, scope: Scope): Promise<PublicRun | undefined> {
  let cursor: string | undefined; const seen = new Set<string>(); let found: PublicRun | undefined;
  for (let page = 0; page < 100; page++) {
    const query = `?limit=100&type=apply${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await request(`/api/v1/capsules/${encodeURIComponent(scope.appId)}/runs${query}`);
    if (!isRecord(body) || !Array.isArray(body.runs)) throw new Refusal("run_history_incomplete");
    for (const row of body.runs) {
      const run = runFrom({ run: row }, scope.appId);
      if (run.type !== "apply" || run.workspaceId !== scope.workspaceId) throw new Refusal("run_history_identity_mismatch");
      if (run.planRunId === scope.planId) {
        if (found && found.id !== run.id) throw new Refusal("multiple_linked_apply_runs");
        found = run;
      }
    }
    if (body.nextCursor === undefined) return found;
    if (!bounded(body.nextCursor, 4096) || seen.has(body.nextCursor)) throw new Refusal("run_history_incomplete");
    cursor = body.nextCursor; seen.add(cursor);
  }
  throw new Refusal("run_history_incomplete");
}

function applyIdentity(run: PublicRun, scope: Scope): PublicRun {
  if (run.type !== "apply" || run.planRunId !== scope.planId || run.workspaceId !== scope.workspaceId) throw new Refusal("apply_identity_mismatch");
  return run;
}

async function watch(request: Client, run: PublicRun, scope: Scope, signal: AbortSignal): Promise<PublicRun> {
  let current = applyIdentity(run, scope);
  while (!SETTLED.has(current.status)) {
    await pause(1_000, signal);
    current = applyIdentity(runFrom(await request(`/api/v1/runs/${encodeURIComponent(run.id)}`), scope.appId, run.id), scope);
  }
  return current;
}

export async function runAppApply(args: string[], io: CliIo): Promise<number> {
  let options: CliOptions = {}; let appId: string | undefined; let planId: string | undefined;
  let scope: Scope | undefined; let lastRun: PublicRun | undefined; let lastPlan: PublicRun | undefined; let mutationAttempted = false;
  try {
    const parsed = argumentsFor(args, "apply");
    if (parsed.help) { io.stdout(applyHelp()); return 0; }
    ({ appId, options } = parsed); planId = typeof options.plan === "string" ? options.plan : undefined;
    if (!bounded(planId, 256) || (options.yes !== true && options.observeOnly !== true)) throw new Refusal("saved_plan_and_explicit_confirmation_required");
    options = selectTarget(options);
    const selectedApp = appId; const selectedPlan = planId;
    lastRun = await within(parsed.wait, async signal => {
      const request = client(options, signal);
      let plan = revisionRun(runFrom(await request(`/api/v1/runs/${encodeURIComponent(selectedPlan)}`), selectedApp, selectedPlan));
      lastPlan = plan;
      scope = { appId: selectedApp, planId: selectedPlan, workspaceId: plan.workspaceId };
      const existing = await linkedApply(request, scope);
      if (existing) { lastRun = existing; return await watch(request, existing, scope, signal); }
      if (options.observeOnly === true) throw new Refusal("linked_apply_not_observed");
      const body = await request(`/api/v1/capsules/${encodeURIComponent(selectedApp)}`);
      const cap = isRecord(body) ? body.capsule : undefined;
      if (!isRecord(cap) || cap.id !== selectedApp || cap.workspaceId !== plan.workspaceId || cap.status === "destroyed" ||
        cap.currentStateGeneration !== plan.baseStateGeneration || !bounded(cap.currentStateVersionId, 256) ||
        plan.applyExpected?.currentStateVersionId !== cap.currentStateVersionId) throw new Refusal("plan_state_changed");
      if (!["succeeded", "waiting_approval"].includes(plan.status) || plan.policyStatus !== "pass") throw new Refusal("plan_not_applyable");
      const projection = review(plan);
      if ((Object.values(projection.changes).some(value => value === null) || (projection.changes.destroy ?? 0) > 0) && options.allowDestroy !== true) {
        throw new Refusal("destructive_confirmation_required");
      }
      signal.throwIfAborted();
      io.stderr(JSON.stringify({ status: "applying_reviewed_plan", appId: selectedApp, plan: projection, reviewUrl: runUrl(options, plan.id) }));
      const initialIdentity = canonicalJson([plan.id, plan.capsuleId, plan.workspaceId, plan.origin, plan.planDigest, plan.applyExpected, plan.sourceSnapshotId, plan.baseStateGeneration]);
      if (plan.status === "waiting_approval") {
        mutationAttempted = true;
        await request(`/api/v1/runs/${encodeURIComponent(selectedPlan)}/approve`, "POST", {});
        plan = revisionRun(runFrom(await request(`/api/v1/runs/${encodeURIComponent(selectedPlan)}`), selectedApp, selectedPlan));
        lastPlan = plan;
        if (plan.status !== "succeeded" || plan.policyStatus !== "pass" || initialIdentity !== canonicalJson([plan.id, plan.capsuleId, plan.workspaceId, plan.origin, plan.planDigest, plan.applyExpected, plan.sourceSnapshotId, plan.baseStateGeneration])) throw new Refusal("approved_plan_changed");
        const raced = await linkedApply(request, scope);
        if (raced) { lastRun = raced; return await watch(request, raced, scope, signal); }
      }
      signal.throwIfAborted(); mutationAttempted = true;
      lastRun = applyIdentity(runFrom(await request(`/api/v1/runs/${encodeURIComponent(selectedPlan)}/apply`, "POST", {}), selectedApp), scope);
      return await watch(request, lastRun, scope, signal);
    });
    write(io, options, { status: lastRun.status === "succeeded" ? "succeeded" : "failed", appId, planRunId: planId,
      runId: lastRun.id, runStatus: lastRun.status, runUrl: runUrl(options, lastRun.id),
      code: lastRun.errorCode && TOKEN.test(lastRun.errorCode) ? lastRun.errorCode : undefined,
      note: lastRun.status !== "succeeded" ? "A failed or stopped Apply may have effects. Do not repeat it as a new Plan." : undefined });
    return lastRun.status === "succeeded" ? 0 : 1;
  } catch (error) {
    // An uncertain mutation is never followed by another mutation. Fresh,
    // separately bounded reads can observe its exact linked Apply only.
    if (scope && mutationAttempted) {
      try { lastRun = await within(5_000, async signal => {
        const request = client(options, signal);
        const observedPlan = revisionRun(runFrom(await request(`/api/v1/runs/${encodeURIComponent(scope!.planId)}`), scope!.appId, scope!.planId));
        if (observedPlan.workspaceId !== scope!.workspaceId || observedPlan.planDigest !== lastPlan?.planDigest ||
          canonicalJson(observedPlan.origin) !== canonicalJson(lastPlan?.origin)) throw new Refusal("observed_plan_changed");
        lastPlan = observedPlan;
        const observed = await linkedApply(request, scope!);
        if (!observed) return undefined;
        return applyIdentity(runFrom(await request(`/api/v1/runs/${encodeURIComponent(observed.id)}`), scope!.appId, observed.id), scope!);
      }); } catch { /* unavailable readback is not proof of no effect */ }
    }
    const success = lastRun?.status === "succeeded";
    write(io, options, { status: success ? "succeeded" : lastRun && !SETTLED.has(lastRun.status) ? "pending" : mutationAttempted || options.observeOnly === true ? "indeterminate" : "refused",
      appId, planRunId: planId, lastObservedPlanStatus: lastPlan?.status, runId: lastRun?.id, runStatus: lastRun?.status, code: errorCode(error),
      recovery: "Use apps apply with the same app/plan and --observe-only for readback; no new Plan, key, approval or Apply is created by observation." });
    return success ? 0 : error instanceof Refusal && ["app_id_required", "unknown_option", "option_value_required", "invalid_boolean_option", "unexpected_argument", "duplicate_option", "invalid_timeout", "invalid_origin", "conflicting_modes", "saved_plan_and_explicit_confirmation_required"].includes(error.code) ? 2 : 1;
  }
}

export function updateHelp(): string {
  return ["takosumi apps update <app-id> --ref <exact-ref> --idempotency-key <retained-key>",
    isJapaneseCli() ? "既存revision coordinatorでPlanを準備します。承認・Applyは行いません。同じ本人/app/ref/keyで再開します。" : "Prepare a revision Plan only. Retry the same identity/app/ref/key; no approval or Apply.",
    "--url <origin> --token <Accounts PAT with read,write> --json --timeout-ms <1..120000>", "Environment: TAKOSUMI_ACCOUNT_TOKEN"].join("\n");
}
export function applyHelp(): string {
  return ["takosumi apps apply <app-id> --plan <saved-revision-plan-run-id> --yes [--allow-destroy]",
    "takosumi apps apply <app-id> --plan <saved-revision-plan-run-id> --observe-only",
    isJapaneseCli() ? "保存Planを明示実行し、有限時間だけRunを観測します。削除・変更数不明には --allow-destroy が必要です。観測のみでは書き込みません。" : "Execute the saved Plan explicitly and observe its Run for a bounded time. Deletes/unknown counts need --allow-destroy. Observation writes nothing.",
    "--url <origin> --token <Accounts PAT> --json --timeout-ms <1..120000>",
    "Scopes: read for observation; read,write to execute. Environment: TAKOSUMI_ACCOUNT_TOKEN"].join("\n");
}
