import { createHash } from "node:crypto";
import {
  formatPlatformOperationIdempotencyKey,
  type JsonObject,
  type ManifestResource,
  type PlatformContext,
  type PlatformOperationContext,
  type PlatformOperationRecoveryMode,
  type ResourceHandle,
} from "takosumi-contract";
import {
  type ResolvedResourceV2,
  resolveResourcesV2,
  type ResourceResolutionIssue,
} from "./resource_resolver_v2.ts";
import {
  buildRefDag,
  type RefResolutionIssue,
  resolveSpecRefs,
} from "./ref_resolver_v2.ts";
import {
  buildOperationPlanPreview,
  type OperationPlanPreview,
} from "./operation_plan_preview.ts";
import {
  withDeployTraceContext,
  withDeployTraceSpan,
} from "./deploy_traces.ts";

export type {
  OperationPlanPreview,
  OperationPlanPreviewOperation,
  OperationPlanPreviewWalStage,
} from "./operation_plan_preview.ts";

export interface ApplyV2Outcome {
  readonly applied: readonly AppliedResource[];
  readonly issues: readonly (ResourceResolutionIssue | RefResolutionIssue)[];
  readonly status: "succeeded" | "failed-validation" | "failed-apply";
  /**
   * Present when an apply failure triggered rollback of already-created
   * resources. The top-level status stays `failed-apply`; this field exposes
   * leaked-resource risk when compensation or destroy also fails.
   */
  readonly rollback?: ApplyV2RollbackOutcome;
  /**
   * When `dryRun` was passed, this lists the planned operations in DAG order.
   * Empty / undefined for non-dry-run runs.
   */
  readonly planned?: readonly PlannedResource[];
  /**
   * Public OperationPlan preview for dry-runs. This exposes the deterministic
   * DesiredSnapshot / OperationPlan digests and WAL idempotency tuple the
   * full lifecycle architecture uses, but plan mode still writes no journal entry.
   */
  readonly operationPlanPreview?: OperationPlanPreview;
  readonly recoveryMode?: PlatformOperationRecoveryMode;
  /**
   * Number of resources that were skipped because their `(shape, providerId,
   * name, spec)` fingerprint matched a prior apply record. Always 0 when
   * `priorApplied` is not supplied. Used by the public deploy route to log
   * idempotent reuse for operators.
   */
  readonly reused?: number;
}

export interface ApplyV2RollbackOutcome {
  readonly status: "succeeded" | "partial";
  readonly failures: readonly ApplyV2RollbackFailure[];
}

export interface ApplyV2RollbackFailure {
  readonly name: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
  readonly action: "compensate" | "destroy";
  readonly message: string;
}

export interface AppliedResource {
  readonly name: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
  readonly outputs: JsonObject;
  /**
   * Stable hash of `(shape, providerId, name, spec)` captured at apply time.
   * Persisted alongside the handle so a subsequent apply submission can
   * skip `provider.apply` when the fingerprint is unchanged.
   */
  readonly specFingerprint: string;
}

/**
 * Per-resource snapshot the caller passes to `applyV2` to enable
 * idempotency. Compared against the fingerprint computed for each resource
 * at apply time; a match short-circuits `provider.apply` and reuses the
 * stored handle / outputs (so dependent resources still see correct ref
 * outputs through the resolver).
 */
export interface PriorAppliedSnapshot {
  readonly specFingerprint: string;
  readonly handle: ResourceHandle;
  readonly outputs: JsonObject;
  readonly providerId: string;
}

/**
 * A resource operation in the public plan surface. `applyV2` dry-runs emit
 * `"create"` for now (the apply pipeline does not yet do diffs vs. observed
 * state); the public route also uses this type for destroy WAL previews, where
 * operations are emitted as `"delete"` in reverse DAG order.
 */
export interface PlannedResource {
  readonly name: string;
  readonly shape: string;
  readonly providerId: string;
  readonly op: "create" | "delete";
}

export interface ApplyV2Options {
  readonly resources: readonly ManifestResource[];
  readonly context: PlatformContext;
  readonly deploymentName?: string;
  /**
   * WAL OperationPlan preview already recorded by the caller. When present,
   * `applyV2` attaches the matching operation idempotency tuple to each
   * provider call through `PlatformContext.operation`.
   */
  readonly operationPlanPreview?: OperationPlanPreview;
  readonly recoveryMode?: PlatformOperationRecoveryMode;
  /**
   * When `true`, run validation + ref-DAG resolution but skip
   * `provider.apply` calls. The returned outcome's `planned` field lists the
   * resources that would be applied, in DAG order. Used by
   * `takosumi plan` to produce a structured plan without side effects.
   */
  readonly dryRun?: boolean;
  /**
   * Optional map of `resource.name → PriorAppliedSnapshot` carrying the
   * outputs / handle / fingerprint produced by a prior apply of the same
   * deployment. When a resource's freshly-computed fingerprint matches the
   * snapshot, `applyV2` skips `provider.apply` and reuses the prior handle
   * + outputs (which still flow through the per-resource ref resolver so
   * downstream resources see correct values).
   *
   * v0 policy: a fingerprint *mismatch* still goes through `provider.apply`
   * (the prior handle is left in place rather than auto-destroyed). Future
   * "delta replace" work will tear down stale handles before re-creating.
   */
  readonly priorApplied?: ReadonlyMap<string, PriorAppliedSnapshot>;
}

export interface DestroyV2Options {
  readonly resources: readonly ManifestResource[];
  readonly context: PlatformContext;
  /**
   * WAL OperationPlan preview already recorded by the caller. When present,
   * `destroyV2` attaches the matching operation idempotency tuple to each
   * provider call through `PlatformContext.operation`.
   */
  readonly operationPlanPreview?: OperationPlanPreview;
  readonly recoveryMode?: PlatformOperationRecoveryMode;
  /**
   * Optional handle resolver. When the caller has prior `applyV2` outputs
   * (e.g. persisted from a real deployment), this hook lets `destroyV2`
   * pass the actual provider handle to `provider.destroy`. Without it,
   * `destroyV2` falls back to the resource name as the handle, which
   * matches the convention used by in-memory / filesystem providers in
   * the bundled plugin set.
   */
  readonly handleFor?: (resource: ManifestResource) => ResourceHandle;
}

export interface ResourceDestroyResult {
  readonly name: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
}

export interface ResourceDestroyError {
  readonly name: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
  readonly message: string;
}

export interface DestroyV2Outcome {
  readonly destroyed: readonly ResourceDestroyResult[];
  readonly errors: readonly ResourceDestroyError[];
  readonly issues: readonly (ResourceResolutionIssue | RefResolutionIssue)[];
  readonly status: "succeeded" | "failed-validation" | "partial";
}

export async function applyV2(
  options: ApplyV2Options,
): Promise<ApplyV2Outcome> {
  const {
    resources,
    context: inputContext,
    dryRun = false,
    priorApplied,
    deploymentName,
    operationPlanPreview,
    recoveryMode = "normal",
  } = options;
  const context = withDeployTraceContext(inputContext);

  const resolution = resolveResourcesV2(resources);
  if (resolution.issues.length > 0) {
    return {
      applied: [],
      issues: resolution.issues,
      status: "failed-validation",
    };
  }

  const dag = buildRefDag(resources);
  if (dag.issues.length > 0) {
    return {
      applied: [],
      issues: dag.issues,
      status: "failed-validation",
    };
  }

  const resourceByName = new Map<string, ResolvedResourceV2>();
  for (const r of resolution.resolved) resourceByName.set(r.resource.name, r);

  if (dryRun) {
    const planned: PlannedResource[] = [];
    for (const name of dag.order) {
      const item = resourceByName.get(name);
      if (!item) continue;
      planned.push({
        name,
        shape: item.resource.shape,
        providerId: item.provider.id,
        op: "create",
      });
    }
    return {
      applied: [],
      issues: [],
      status: "succeeded",
      planned,
      operationPlanPreview: buildOperationPlanPreview({
        resources,
        planned,
        edges: dag.edges,
        spaceId: planSpaceId(context),
        ...(deploymentName ? { deploymentName } : {}),
      }),
    };
  }

  const outputsByName = new Map<string, JsonObject>();
  const applied: AppliedResource[] = [];
  const appliedThisRun: AppliedResource[] = [];
  const operationContextByResourceName = buildOperationContextByResourceName(
    operationPlanPreview,
    "apply",
    recoveryMode,
  );
  let reused = 0;

  for (const name of dag.order) {
    const item = resourceByName.get(name);
    if (!item) continue;
    const resolvedSpec = resolveSpecRefs(item.resource.spec, {
      outputs: outputsByName,
    }) as JsonObject;
    const fingerprint = computeSpecFingerprint(
      item.resource,
      item.provider.id,
      resolvedSpec,
    );

    // Idempotent skip: a prior snapshot for this resource exists with the
    // same fingerprint AND was applied by the same provider id. Reuse the
    // handle and outputs without calling `provider.apply` again. Downstream
    // resources still see the prior outputs through the ref resolver.
    const snapshot = priorApplied?.get(name);
    if (
      snapshot &&
      snapshot.specFingerprint === fingerprint &&
      snapshot.providerId === item.provider.id
    ) {
      outputsByName.set(name, snapshot.outputs);
      applied.push({
        name,
        providerId: item.provider.id,
        handle: snapshot.handle,
        outputs: snapshot.outputs,
        specFingerprint: fingerprint,
      });
      reused += 1;
      continue;
    }

    const operation = operationContextByResourceName.get(name);
    try {
      const result = await withDeployTraceSpan(
        { observability: context.observability },
        {
          name: "takosumi.provider.apply",
          trace: context.trace,
          spaceId: context.spaceId,
          groupId: deploymentName,
          operation,
          operationKind: "apply",
          attributes: {
            "takosumi.shape": item.resource.shape,
            "takosumi.provider_id": item.provider.id,
            "takosumi.resource_name": name,
          },
          resultAttributes: (result) => ({
            "takosumi.provider_handle": String(result.handle),
          }),
        },
        () =>
          item.provider.apply(
            resolvedSpec,
            withOperationContext(
              context,
              operation,
            ),
          ),
      );
      outputsByName.set(name, result.outputs as JsonObject);
      const appliedResource = {
        name,
        providerId: item.provider.id,
        handle: result.handle,
        outputs: result.outputs as JsonObject,
        specFingerprint: fingerprint,
      };
      applied.push(appliedResource);
      appliedThisRun.push(appliedResource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rollbackOutcome = await rollback(
        appliedThisRun,
        resourceByName,
        context,
      );
      return {
        applied: [],
        issues: [{
          path: `$.resources[${name}]`,
          message: `apply failed: ${message}`,
        }],
        status: "failed-apply",
        rollback: rollbackOutcome,
      };
    }
  }

  return {
    applied,
    issues: [],
    status: "succeeded",
    ...(operationPlanPreview ? { operationPlanPreview } : {}),
    ...(reused > 0 ? { reused } : {}),
  };
}

function planSpaceId(context: PlatformContext): string {
  return context.spaceId ?? context.tenantId ?? "unknown";
}

/**
 * Stable SHA-256 hash of the canonical `(shape, providerId, name, spec)`
 * tuple. Object keys are sorted recursively so logically identical specs do
 * not re-apply just because their JSON property insertion order changed.
 */
export function computeSpecFingerprint(
  resource: ManifestResource,
  providerId: string,
  resolvedSpec: JsonObject,
): string {
  return `sha256:${
    createHash("sha256").update(canonicalJsonStringify({
      shape: resource.shape,
      providerId,
      name: resource.name,
      spec: resolvedSpec,
    })).digest("hex")
  }`;
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalJsonStringify(object[key])}`
    );
  return `{${entries.join(",")}}`;
}

async function rollback(
  applied: readonly AppliedResource[],
  resourceByName: ReadonlyMap<string, ResolvedResourceV2>,
  context: PlatformContext,
): Promise<ApplyV2RollbackOutcome> {
  const failures: ApplyV2RollbackFailure[] = [];
  for (const entry of [...applied].reverse()) {
    const item = resourceByName.get(entry.name);
    if (!item) continue;
    const action = item.provider.compensate ? "compensate" : "destroy";
    try {
      if (item.provider.compensate) {
        const result = await item.provider.compensate(entry.handle, context);
        if (!result.ok) {
          failures.push({
            name: entry.name,
            providerId: entry.providerId,
            handle: entry.handle,
            action,
            message: result.note ?? "provider compensation returned ok=false",
          });
        }
      } else {
        await item.provider.destroy(entry.handle, context);
      }
    } catch (error) {
      failures.push({
        name: entry.name,
        providerId: entry.providerId,
        handle: entry.handle,
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    status: failures.length === 0 ? "succeeded" : "partial",
    failures,
  };
}

/**
 * Destroy the resources declared by a manifest in reverse topological order
 * (leaves first, roots last) so that providers see their dependencies still
 * present at the moment they tear themselves down.
 *
 * Best-effort: per-resource failures are accumulated in `errors` rather than
 * aborting the whole pass. The final `status` is:
 *  - `succeeded` when every provider returned without throwing.
 *  - `partial`   when at least one provider threw.
 *  - `failed-validation` when the manifest itself was invalid (unknown
 *    shape / provider, cycle, malformed ref). In this case nothing is
 *    destroyed and `issues` carries the resolver diagnostics, mirroring
 *    `applyV2`.
 *
 * Provider handle resolution: the manifest does not carry the runtime handle
 * that `provider.apply` returned at deploy time. `destroyV2` therefore relies
 * on `handleFor(resource)` to map a resource back to its handle. The default
 * handle is the resource name, which matches the in-memory and filesystem
 * provider conventions used by the bundled plugin set; production callers
 * that persist deployment state should pass an explicit `handleFor` that
 * looks up the prior apply outputs.
 */
export async function destroyV2(
  options: DestroyV2Options,
): Promise<DestroyV2Outcome> {
  const {
    resources,
    context: inputContext,
    handleFor,
    operationPlanPreview,
    recoveryMode = "normal",
  } = options;
  const context = withDeployTraceContext(inputContext);

  const resolution = resolveResourcesV2(resources);
  if (resolution.issues.length > 0) {
    return {
      destroyed: [],
      errors: [],
      issues: resolution.issues,
      status: "failed-validation",
    };
  }

  const dag = buildRefDag(resources);
  if (dag.issues.length > 0) {
    return {
      destroyed: [],
      errors: [],
      issues: dag.issues,
      status: "failed-validation",
    };
  }

  const resourceByName = new Map<string, ResolvedResourceV2>();
  for (const r of resolution.resolved) resourceByName.set(r.resource.name, r);

  const reverseOrder = [...dag.order].reverse();
  const destroyed: ResourceDestroyResult[] = [];
  const errors: ResourceDestroyError[] = [];
  const operationContextByResourceName = buildOperationContextByResourceName(
    operationPlanPreview,
    "destroy",
    recoveryMode,
  );

  for (const name of reverseOrder) {
    const item = resourceByName.get(name);
    if (!item) continue;
    const handle: ResourceHandle = handleFor
      ? handleFor(item.resource)
      : item.resource.name;
    const operation = operationContextByResourceName.get(name);
    try {
      await withDeployTraceSpan(
        { observability: context.observability },
        {
          name: "takosumi.provider.destroy",
          trace: context.trace,
          spaceId: context.spaceId,
          operation,
          operationKind: "destroy",
          attributes: {
            "takosumi.shape": item.resource.shape,
            "takosumi.provider_id": item.provider.id,
            "takosumi.resource_name": name,
            "takosumi.provider_handle": String(handle),
          },
        },
        () =>
          item.provider.destroy(
            handle,
            withOperationContext(
              context,
              operation,
            ),
          ),
      );
      destroyed.push({ name, providerId: item.provider.id, handle });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ name, providerId: item.provider.id, handle, message });
    }
  }

  return {
    destroyed,
    errors,
    issues: [],
    status: errors.length === 0 ? "succeeded" : "partial",
  };
}

function buildOperationContextByResourceName(
  preview: OperationPlanPreview | undefined,
  phase: PlatformOperationContext["phase"],
  recoveryMode: PlatformOperationRecoveryMode,
): ReadonlyMap<string, PlatformOperationContext> {
  const contexts = new Map<string, PlatformOperationContext>();
  if (!preview) return contexts;
  const expectedOp = phase === "apply" ? "create" : "delete";
  for (const operation of preview.operations) {
    if (operation.op !== expectedOp) continue;
    contexts.set(operation.resourceName, {
      phase,
      walStage: "commit",
      operationId: operation.operationId,
      resourceName: operation.resourceName,
      providerId: operation.providerId,
      op: operation.op,
      desiredDigest: operation.desiredDigest,
      operationPlanDigest: preview.operationPlanDigest,
      idempotencyKey: operation.idempotencyKey,
      idempotencyKeyString: formatPlatformOperationIdempotencyKey(
        operation.idempotencyKey,
      ),
      recoveryMode,
    });
  }
  return contexts;
}

function withOperationContext(
  context: PlatformContext,
  operation: PlatformOperationContext | undefined,
): PlatformContext {
  return operation ? { ...context, operation } : context;
}
