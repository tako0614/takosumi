// runner/lib/state_reconcile.ts
//
// State reconciliation: recovers provider resources that a previous interrupted
// mutation left live on the host but unrecorded in OpenTofu state.
//
// The host answers every accepted mutation with a durable, replayable
// operation, but a client that lost the response (header timeout, crash,
// network cut) never recorded the resource. A later `tofu plan -destroy` then
// covers only the recorded subset, and the host correctly refuses dependent
// deletes of resources the plan does not know — a deterministic deadlock that
// retries cannot advance. A retried apply hits the same wall whenever the
// desired body changed, because the create intent conflicts with the live
// resource.
//
// The repair uses only standard OpenTofu machinery: enumerate the declared
// resources from a normal plan's `planned_values`, subtract `prior_state`
// addresses, and `tofu import` each missing address so the following plan —
// apply or destroy — covers the full live set. Healthy runs find zero missing
// addresses and pay no extra provider calls.
import { join } from "node:path";

import { runCommand } from "./exec.ts";
import { prepareRuntimeInputVariableFile } from "./runtime_inputs.ts";
import { isRecord } from "./util.ts";
import type { CommandContext } from "./types.ts";

/** One declared resource whose host-side name a plan resolved concretely. */
export interface ReconcileCandidate {
  readonly address: string;
  readonly name: string;
  readonly space?: string;
}

/** A declared address the reconcile could not act on, with the reason. */
export interface ReconcileSkip {
  readonly address: string;
  readonly reason:
    | "name_unresolved"
    | "absent_on_host"
    | "import_failed";
}

export interface StateReconcileSummary {
  /**
   * `reconciled` — enumeration ran; `imported` may still be empty on a
   * healthy state. `enumerate_failed` — the enumeration plan itself failed,
   * so the run proceeds exactly as it did before reconciliation existed.
   */
  readonly status: "reconciled" | "enumerate_failed";
  readonly declaredAddresses: number;
  readonly recordedAddresses: number;
  readonly imported: readonly string[];
  readonly absent: readonly string[];
  readonly skipped: readonly ReconcileSkip[];
  readonly error?: string;
}

interface PlanJsonResource {
  readonly address?: unknown;
  readonly values?: unknown;
}

interface PlanJsonModule {
  readonly resources?: readonly PlanJsonResource[];
  readonly child_modules?: readonly PlanJsonModule[];
}

function* walkModuleResources(
  module: PlanJsonModule | undefined,
): Generator<PlanJsonResource> {
  if (module === undefined) return;
  for (const resource of module.resources ?? []) {
    yield resource;
  }
  for (const child of module.child_modules ?? []) {
    yield* walkModuleResources(child);
  }
}

function parsedPlan(planJson: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(planJson);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

function plannedRoot(planJson: string): PlanJsonModule | undefined {
  const parsed = parsedPlan(planJson);
  const planned = parsed?.["planned_values"];
  if (!isRecord(planned)) return undefined;
  const root = planned["root_module"];
  return isRecord(root) ? (root as PlanJsonModule) : undefined;
}

function priorRoot(planJson: string): PlanJsonModule | undefined {
  const parsed = parsedPlan(planJson);
  const prior = parsed?.["prior_state"];
  if (!isRecord(prior)) return undefined;
  const values = prior["values"];
  if (!isRecord(values)) return undefined;
  const root = values["root_module"];
  return isRecord(root) ? (root as PlanJsonModule) : undefined;
}

/** Every resource address the plan's prior state recorded. */
export function recordedAddressesFromPlanJson(
  planJson: string,
): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const resource of walkModuleResources(priorRoot(planJson))) {
    if (typeof resource.address === "string" && resource.address.length > 0) {
      addresses.add(resource.address);
    }
  }
  return addresses;
}

/**
 * Every declared resource the plan resolved, keyed by address. Resources whose
 * host-side `name` stayed unknown at plan time are returned separately: an
 * import cannot name them, and a resource whose name could not resolve could
 * not have been created by that name either.
 */
export function declaredResourcesFromPlanJson(planJson: string): {
  readonly candidates: readonly ReconcileCandidate[];
  readonly unresolvable: readonly string[];
} {
  const candidates: ReconcileCandidate[] = [];
  const unresolvable: string[] = [];
  for (const resource of walkModuleResources(plannedRoot(planJson))) {
    const address = resource.address;
    if (typeof address !== "string" || address.length === 0) continue;
    const values = isRecord(resource.values) ? resource.values : undefined;
    const name = values?.["name"];
    if (typeof name !== "string" || name.length === 0) {
      unresolvable.push(address);
      continue;
    }
    const space = values?.["space"];
    candidates.push({
      address,
      name,
      ...(typeof space === "string" && space.length > 0 ? { space } : {}),
    });
  }
  return { candidates, unresolvable };
}

/**
 * Declared resources with a resolvable name that prior state does not record —
 * the set a previous interrupted mutation may have left live on the host.
 */
export function missingReconcileCandidates(planJson: string): {
  readonly candidates: readonly ReconcileCandidate[];
  readonly unresolvable: readonly string[];
  readonly declaredAddresses: number;
  readonly recordedAddresses: number;
} {
  const declared = declaredResourcesFromPlanJson(planJson);
  const recorded = recordedAddressesFromPlanJson(planJson);
  return {
    candidates: declared.candidates.filter(
      (candidate) => !recorded.has(candidate.address),
    ),
    unresolvable: declared.unresolvable.filter(
      (address) => !recorded.has(address),
    ),
    declaredAddresses: declared.candidates.length + declared.unresolvable.length,
    recordedAddresses: recorded.size,
  };
}

/**
 * The import ID one candidate names. The provider accepts `SPACE/NAME` and
 * the bare `NAME` short form; an unset space resolves to the provider's
 * configured default, which is exactly where a resource that never declared a
 * space lives.
 */
export function reconcileImportId(candidate: ReconcileCandidate): string {
  return candidate.space === undefined
    ? candidate.name
    : `${candidate.space}/${candidate.name}`;
}

const IMPORT_ABSENT_PATTERNS: readonly RegExp[] = [
  /cannot import non-existent remote object/iu,
  /resource_not_found/iu,
  /not[_ ]found/iu,
  /does not exist/iu,
  /\b404\b/u,
];

function importFailureIsAbsence(output: string): boolean {
  return IMPORT_ABSENT_PATTERNS.some((pattern) => pattern.test(output));
}

function boundedOutput(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Runs one `tofu import` per missing candidate, tolerating the not-found
 * outcome that proves the address was never actually created. A real import
 * failure is recorded and the loop continues: the plan that follows carries
 * the same failure surface the run had before reconciliation existed, so the
 * reconcile never makes a run worse.
 */
export async function reconcileStateFromPlanJson(args: {
  readonly planJson: string;
  readonly moduleDir: string;
  readonly context: CommandContext;
  readonly variableFilePath?: string;
  readonly workspaceRoot: string;
}): Promise<StateReconcileSummary> {
  const missing = missingReconcileCandidates(args.planJson);
  const imported: string[] = [];
  const absent: string[] = [];
  const skipped: ReconcileSkip[] = missing.unresolvable.map((address) => ({
    address,
    reason: "name_unresolved" as const,
  }));

  for (const candidate of missing.candidates) {
    const variableFile = await prepareRuntimeInputVariableFile(
      args.context.runtimeInputs ?? [],
      args.workspaceRoot,
    );
    let result: Awaited<ReturnType<typeof runCommand>>;
    try {
      result = await runCommand(
        [
          "tofu",
          "import",
          ...(args.variableFilePath
            ? [`-var-file=${args.variableFilePath}`]
            : []),
          ...variableFile.args,
          "-input=false",
          "-no-color",
          candidate.address,
          reconcileImportId(candidate),
        ],
        {
          cwd: args.moduleDir,
          context: args.context,
          isolateProcessGroup: true,
          onSpawn: variableFile.onSpawn,
        },
      );
      await variableFile.delivered();
    } finally {
      await variableFile.dispose();
    }
    if (result.exitCode === 0) {
      imported.push(candidate.address);
      continue;
    }
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    if (importFailureIsAbsence(output)) {
      absent.push(candidate.address);
      skipped.push({ address: candidate.address, reason: "absent_on_host" });
    } else {
      skipped.push({
        address: candidate.address,
        reason: "import_failed",
      });
    }
  }

  return {
    status: "reconciled",
    declaredAddresses: missing.declaredAddresses,
    recordedAddresses: missing.recordedAddresses,
    imported,
    absent,
    skipped,
  };
}

/**
 * Runs a normal (non-destroy) plan solely to enumerate declared resources and
 * their resolved names, so a destroy can reconcile state before the destroy
 * plan is built. The plan file is written to `planPath`, separate from the
 * reviewed plan artifact the caller produces afterwards.
 */
export async function enumeratePlanJsonForReconcile(args: {
  readonly moduleDir: string;
  readonly context: CommandContext;
  readonly variableFilePath?: string;
  readonly workspaceRoot: string;
  readonly planPath: string;
}): Promise<{ readonly planJson?: string; readonly error?: string }> {
  const variableFile = await prepareRuntimeInputVariableFile(
    args.context.runtimeInputs ?? [],
    args.workspaceRoot,
  );
  let plan: Awaited<ReturnType<typeof runCommand>>;
  try {
    plan = await runCommand(
      [
        "tofu",
        "plan",
        ...(args.variableFilePath
          ? [`-var-file=${args.variableFilePath}`]
          : []),
        ...variableFile.args,
        "-input=false",
        "-no-color",
        "-out",
        args.planPath,
      ],
      {
        cwd: args.moduleDir,
        context: args.context,
        isolateProcessGroup: true,
        onSpawn: variableFile.onSpawn,
      },
    );
    await variableFile.delivered();
  } finally {
    await variableFile.dispose();
  }
  if (plan.exitCode !== 0) {
    return {
      error: boundedOutput(
        [plan.stderr, plan.stdout].filter(Boolean).join("\n"),
      ),
    };
  }
  const show = await runCommand(
    ["tofu", "show", "-json", args.planPath],
    {
      cwd: args.moduleDir,
      context: args.context,
      isolateProcessGroup: true,
    },
  );
  const planJson =
    show.exitCode === 0 && show.stdout.trim().length > 0
      ? show.stdout
      : undefined;
  if (planJson === undefined) {
    return { error: "enumeration plan JSON could not be read" };
  }
  return { planJson };
}

/** The summary a failed enumeration produces: the run continues unreconciled. */
export function reconcileEnumerationFailed(
  error: string | undefined,
): StateReconcileSummary {
  return {
    status: "enumerate_failed",
    declaredAddresses: 0,
    recordedAddresses: 0,
    imported: [],
    absent: [],
    skipped: [],
    ...(error === undefined ? {} : { error }),
  };
}

/** The workspace-relative path the enumeration plan is written to. */
export function reconcilePlanPath(workspaceRoot: string): string {
  return join(workspaceRoot, "tfreconcile.plan");
}

/**
 * Every resource address the saved plan expects to already exist in state —
 * per `resource_changes`, the addresses whose action is anything but a pure
 * create. A pure create needs no prior state entry, so a healthy first apply
 * produces an empty set here and costs the reconcile no provider calls.
 */
export function statefulActionAddressesFromPlanJson(
  planJson: string,
): ReadonlySet<string> {
  const addresses = new Set<string>();
  const parsed = parsedPlan(planJson);
  const changes = parsed?.["resource_changes"];
  if (!Array.isArray(changes)) return addresses;
  for (const change of changes) {
    if (!isRecord(change)) continue;
    const address = change["address"];
    const inner = change["change"];
    const actions = isRecord(inner) ? inner["actions"] : undefined;
    if (!Array.isArray(actions)) continue;
    const pureCreate = actions.length === 1 && actions[0] === "create";
    if (!pureCreate && typeof address === "string" && address.length > 0) {
      addresses.add(address);
    }
  }
  return addresses;
}

/**
 * `tofu state list` for the restored workspace state. An absent or unreadable
 * state file is an empty set, not an error: first-run applies legitimately
 * have no recorded addresses.
 */
export async function stateListAddresses(
  moduleDir: string,
  context: CommandContext,
): Promise<ReadonlySet<string>> {
  const result = await runCommand(
    ["tofu", "state", "list", "-no-color"],
    { cwd: moduleDir, context, isolateProcessGroup: true },
  );
  if (result.exitCode !== 0) return new Set<string>();
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/**
 * `tofu show -json` of the saved plan artifact — a local read with no provider
 * contact, so an apply run can diff the reviewed plan's action set against the
 * restored state before deciding any reconcile work is needed.
 */
export async function savedPlanJson(
  moduleDir: string,
  planPath: string,
  context: CommandContext,
): Promise<string | undefined> {
  const result = await runCommand(
    ["tofu", "show", "-json", planPath],
    { cwd: moduleDir, context, isolateProcessGroup: true },
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0
    ? result.stdout
    : undefined;
}

/**
 * Reconciles the restored apply-workspace state against the reviewed plan.
 * Plan-phase imports never reach the state store — only apply/destroy runs
 * persist state — so an apply of a plan that adopted strays must re-import
 * the same set here. The check is cheap: one local `state list` and one local
 * `show -json` decide whether any provider call is needed at all.
 */
export async function reconcileApplyWorkspaceState(args: {
  readonly moduleDir: string;
  readonly planPath: string;
  readonly context: CommandContext;
  readonly variableFilePath?: string;
  readonly workspaceRoot: string;
  readonly enumeratePlanPath: string;
}): Promise<StateReconcileSummary | undefined> {
  const [planJson, recorded] = await Promise.all([
    savedPlanJson(args.moduleDir, args.planPath, args.context),
    stateListAddresses(args.moduleDir, args.context),
  ]);
  if (planJson === undefined) return undefined;
  const planned = statefulActionAddressesFromPlanJson(planJson);
  const missing = [...planned].filter((address) => !recorded.has(address));
  if (missing.length === 0) return undefined;
  const enumeration = await enumeratePlanJsonForReconcile({
    moduleDir: args.moduleDir,
    context: args.context,
    ...(args.variableFilePath === undefined
      ? {}
      : { variableFilePath: args.variableFilePath }),
    workspaceRoot: args.workspaceRoot,
    planPath: args.enumeratePlanPath,
  });
  if (enumeration.planJson === undefined) {
    return reconcileEnumerationFailed(enumeration.error);
  }
  return await reconcileStateFromPlanJson({
    planJson: enumeration.planJson,
    moduleDir: args.moduleDir,
    context: args.context,
    ...(args.variableFilePath === undefined
      ? {}
      : { variableFilePath: args.variableFilePath }),
    workspaceRoot: args.workspaceRoot,
  });
}
