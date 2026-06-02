// apply_v2 — legacy `resources[]` apply with provider compensate /
// destroy rollback, fingerprint idempotency, replace-on-mismatch, and the
// durable operation journal (WAL).
//
// CANONICAL PRODUCTION PATH — READ BEFORE EXTENDING. `applyV2` is NOT the
// production apply surface today. There are three apply paths in the service:
//   1. InstallerPipeline (domains/installer/mod.ts) — the public Installer API
//      surface. Pointer-only rollback; partial apply on failure has no
//      provider compensation. This is what `POST /v1/installations[...]`
//      drives.
//   2. createDeploymentApplyFacade (app_context.ts) — the default
//      DeploymentService apply facade. Routes through the
//      graph-projection / GroupHead-pointer path (apply_phase /
//      apply_orchestrator), NOT through `applyV2`.
//   3. `applyV2` (this module), reached only via `ApplyService.applySourcePayload`
//      for a `resources[]` manifest.
//
// Consequently the richer guarantees implemented here — provider
// compensate/destroy rollback, fingerprint idempotency skip,
// replace-on-mismatch leak prevention, and the WAL prepare/commit journal —
// are NOT yet exercised by any production caller (idempotency additionally
// needs a `priorApplied` snapshot that nothing persists, and the WAL needs an
// `operationJournalStore` that bootstrap resolves but does not thread through;
// see bootstrap.ts and docs/reference/known-gaps.md). This module is kept
// (not deleted) because it is the intended convergence target and is fully
// unit-tested at the `applyV2` layer. Do not assume code here runs in
// production until the facade is converged onto it.
//
// Round-2 fix: swapped `createHash` from `node:crypto` for the Web Crypto
// backed `sha256HexOfStringAsync` so this module can compile on Cloudflare
// Workers. `computeSpecFingerprint` is now async; callers were already
// inside `async` flows (`applyV2`) so the propagation is local.
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";
import {
  formatPlatformOperationIdempotencyKey,
  type PlatformOperationContext,
  type PlatformOperationRecoveryMode,
} from "takosumi-contract/reference/runtime-agent-lifecycle";
import {
  getProvider,
  type PlatformContext,
  type ProviderPlugin,
  type ResourceHandle,
} from "takosumi-contract/internal/provider-plugin";
import type { JsonObject } from "takosumi-contract/reference/types";
import type { ManifestResource } from "./_internal_manifest_types.ts";
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
  appendOperationPlanJournalStages,
  type OperationJournalStore,
} from "./operation_journal.ts";
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
   * `priorApplied` is not supplied. Used by deployment apply paths to log
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
 * A resource operation in the public plan surface.
 *
 * HONEST LIMITATION: `applyV2` dry-runs emit `"create"` for EVERY resource in
 * DAG order. The plan does NOT compute a diff against observed/prior state, so
 * it does not (and must not be read as if it does) distinguish create vs.
 * update vs. no-op on a re-apply — a dry-run of an unchanged Installation
 * still reports every resource as a `"create"`. There is intentionally no
 * `"update"` / `"no-op"` member here: classifying those requires an
 * observed-state probe that the apply pipeline does not yet have, and adding
 * the members without wiring the probe would let the WAL apply-context filter
 * (which keys on `op === "create"`) silently drop resources. The public route
 * also uses this type for destroy WAL previews, where operations are emitted
 * as `"delete"` in reverse DAG order. See docs/reference/plan-output.md and
 * docs/reference/known-gaps.md for the create-only plan limitation.
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
   * Durable operation journal (WAL). When supplied together with
   * `operationPlanPreview`, `applyV2` writes a `prepare` stage record for
   * every planned operation *before* invoking any `provider.apply`, and a
   * `commit` stage record after the apply loop succeeds. Re-running the same
   * apply with the same `operationPlanPreview` is idempotent at the store
   * level (the append dedupes by `(spaceId, operationPlanDigest,
   * journalEntryId, stage)` and hard-fails on an effect-digest mismatch),
   * which makes the idempotency tuple durable across service restarts.
   *
   * Stage progression is guarded: `commit` is only appended once the matching
   * `prepare` record exists. The store is the single source of truth, so a
   * crash between `prepare` and the provider apply is recoverable — a replay
   * re-derives the same `prepare` tuple and continues.
   *
   * Omitted in every current production path; the durable journal becomes
   * active only when a caller threads a store through. See the service
   * deploy-domain wiring notes and `ApplyService.operationJournalStore`.
   */
  readonly operationJournalStore?: OperationJournalStore;
  /**
   * Clock used to stamp journal records. Defaults to `Date`. Injectable so
   * tests get deterministic `createdAt` values.
   */
  readonly operationJournalClock?: () => Date;
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
   * Replace-on-mismatch: a fingerprint *mismatch* (spec drift) OR a
   * providerId mismatch (resource moved to a different backend) now first
   * issues `provider.destroy(priorApplied[name].handle)` on the previous
   * provider before invoking `provider.apply` on the current one. Destroy
   * is best-effort wrapped in try/catch: a failure does not block the
   * subsequent apply, but a structured warning is appended to the
   * observability trace so operators can detect leaked resources from the
   * prior handle. When the prior providerId is no longer in the registry,
   * destroy is recorded as `provider_not_found` and skipped.
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
   * the bundled adapter set.
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
    operationJournalStore,
    operationJournalClock = () => new Date(),
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
    // Create-only plan: every resource is reported as `"create"`. This is NOT
    // a diff against observed/prior state — see the `PlannedResource` docstring
    // and docs/reference/plan-output.md. A re-apply dry-run still lists every
    // resource as a create even if it is unchanged.
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
      // `buildOperationPlanPreview` became async after the Web Crypto switch.
      operationPlanPreview: await buildOperationPlanPreview({
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

  // WAL prepare stage. Written before any provider.apply so a crash mid-apply
  // is recoverable: a replay re-derives the same idempotency tuple from the
  // same `operationPlanPreview` and the store dedupes it. Only active when the
  // caller threaded both a preview and a durable journal store.
  if (operationJournalStore && operationPlanPreview) {
    await appendOperationPlanJournalStages({
      store: operationJournalStore,
      preview: operationPlanPreview,
      phase: "apply",
      stages: ["prepare"],
      status: "recorded",
      createdAt: operationJournalClock().toISOString(),
    });
  }

  for (const name of dag.order) {
    const item = resourceByName.get(name);
    if (!item) continue;
    const resolvedSpec = resolveSpecRefs(item.resource.spec, {
      outputs: outputsByName,
    }) as JsonObject;
    // `computeSpecFingerprint` became async to use Web Crypto; we await
    // here since the surrounding loop is already async.
    const fingerprint = await computeSpecFingerprint(
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

    // Replace-on-mismatch: the snapshot exists but its fingerprint or
    // providerId differs from the freshly computed one. The prior handle
    // would otherwise leak (the new `provider.apply` creates a fresh
    // resource), so tear it down before re-creating. Destroy is
    // best-effort: if the prior provider is unavailable or its destroy
    // throws, we keep applying and emit a structured warning so operators
    // can chase the leak.
    if (snapshot) {
      await destroyPriorSnapshot({
        resourceName: name,
        snapshot,
        currentProviderId: item.provider.id,
        currentProvider: item.provider,
        currentFingerprint: fingerprint,
        context,
        deploymentName,
      });
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

  // WAL commit stage. Only appended once every provider.apply succeeded, and
  // only after asserting the matching `prepare` record already exists so a
  // commit can never be journaled ahead of its prepare.
  //
  // GRANULARITY CAVEAT (honest): `commit` is written ONCE for the whole apply
  // loop, after all provider.apply calls succeed — not per-operation, and the
  // finer `pre-commit` / `post-commit` / `observe` / `finalize` stages
  // advertised by `OperationPlanPreview.walStages` and docs/reference/
  // wal-stages.md are not written by this path. So a crash AFTER some
  // provider.apply calls but BEFORE this bulk commit append leaves the WAL
  // showing only `prepare` for resources that were in fact materialized;
  // replay cannot distinguish "applied" from "not applied" at per-resource
  // granularity. Writing commit (and pre/post-commit) per operation around
  // each provider.apply is tracked in docs/reference/known-gaps.md; it is not
  // done here because this whole journal path is not yet on a production
  // caller (see the module header and bootstrap.ts).
  if (operationJournalStore && operationPlanPreview) {
    await assertPrepareJournaled(operationJournalStore, operationPlanPreview);
    await appendOperationPlanJournalStages({
      store: operationJournalStore,
      preview: operationPlanPreview,
      phase: "apply",
      stages: ["commit"],
      status: "succeeded",
      createdAt: operationJournalClock().toISOString(),
    });
  }

  return {
    applied,
    issues: [],
    status: "succeeded",
    ...(operationPlanPreview ? { operationPlanPreview } : {}),
    ...(reused > 0 ? { reused } : {}),
  };
}

/**
 * Stage-progression guard: a `commit` journal record must never be written
 * before its `prepare`. Reads the journal for the plan and throws if any
 * planned operation is missing its `prepare` stage. This protects against a
 * caller (or a buggy replay) skipping straight to commit, which would leave
 * the WAL unable to reconstruct the pre-apply intent.
 */
async function assertPrepareJournaled(
  store: OperationJournalStore,
  preview: OperationPlanPreview,
): Promise<void> {
  const entries = await store.listByPlan(
    preview.spaceId,
    preview.operationPlanDigest,
  );
  const prepared = new Set(
    entries
      .filter((entry) => entry.stage === "prepare")
      .map((entry) => entry.journalEntryId),
  );
  for (const operation of preview.operations) {
    if (!prepared.has(operation.idempotencyKey.journalEntryId)) {
      throw new OperationJournalStageProgressionError({
        spaceId: preview.spaceId,
        operationPlanDigest: preview.operationPlanDigest,
        journalEntryId: operation.idempotencyKey.journalEntryId,
        attemptedStage: "commit",
        missingStage: "prepare",
      });
    }
  }
}

export class OperationJournalStageProgressionError extends Error {
  readonly spaceId: string;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly journalEntryId: string;
  readonly attemptedStage: string;
  readonly missingStage: string;

  constructor(input: {
    readonly spaceId: string;
    readonly operationPlanDigest: `sha256:${string}`;
    readonly journalEntryId: string;
    readonly attemptedStage: string;
    readonly missingStage: string;
  }) {
    super(
      `operation journal stage progression violation for ` +
        `${input.spaceId}/${input.operationPlanDigest}/` +
        `${input.journalEntryId}: cannot append ${input.attemptedStage} ` +
        `before ${input.missingStage}`,
    );
    this.name = "OperationJournalStageProgressionError";
    this.spaceId = input.spaceId;
    this.operationPlanDigest = input.operationPlanDigest;
    this.journalEntryId = input.journalEntryId;
    this.attemptedStage = input.attemptedStage;
    this.missingStage = input.missingStage;
  }
}

function planSpaceId(context: PlatformContext): string {
  return context.spaceId ?? context.tenantId ?? "unknown";
}

/**
 * Stable SHA-256 hash of the canonical `(shape, providerId, name, spec)`
 * tuple. Object keys are sorted recursively so logically identical specs do
 * not re-apply just because their JSON property insertion order changed.
 *
 * Now async because the underlying digest call uses Web Crypto
 * (`crypto.subtle`) — required for the service module to compile on Workers.
 */
export async function computeSpecFingerprint(
  resource: ManifestResource,
  providerId: string,
  resolvedSpec: JsonObject,
): Promise<string> {
  const hex = await sha256HexOfStringAsync(canonicalJsonStringify({
    shape: resource.shape,
    providerId,
    name: resource.name,
    spec: resolvedSpec,
  }));
  return `sha256:${hex}`;
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
 * provider conventions used by the bundled adapter set; production callers
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

/**
 * Tear down the resource recorded by `snapshot` before the upcoming
 * `provider.apply` replaces it. The prior provider is looked up by
 * `snapshot.providerId` in the provider registry. When the registry no
 * longer carries that id (e.g. a deployment moved across distributions
 * and the legacy plugin was uninstalled), we fall back to the current
 * provider only when it is the same id; otherwise we record a
 * `prior_provider_not_found` warning and skip destroy so the apply can
 * still proceed.
 *
 * All failures are emitted as structured trace warnings rather than
 * thrown, mirroring `rollback()`'s best-effort policy. The apply continues
 * regardless so a stuck handle does not block recovery.
 */
async function destroyPriorSnapshot(args: {
  readonly resourceName: string;
  readonly snapshot: PriorAppliedSnapshot;
  readonly currentProviderId: string;
  readonly currentProvider: ProviderPlugin;
  readonly currentFingerprint: string;
  readonly context: PlatformContext;
  readonly deploymentName?: string;
}): Promise<void> {
  const {
    resourceName,
    snapshot,
    currentProviderId,
    currentProvider,
    currentFingerprint,
    context,
    deploymentName,
  } = args;

  const reason = snapshot.providerId !== currentProviderId
    ? "provider_id_mismatch"
    : "fingerprint_mismatch";

  // Prefer the prior provider so the destroy targets the same backend that
  // created the resource; fall back to the current provider when ids match.
  let priorProvider: ProviderPlugin | undefined = getProvider(
    snapshot.providerId,
  );
  if (!priorProvider && snapshot.providerId === currentProviderId) {
    priorProvider = currentProvider;
  }

  if (!priorProvider) {
    await emitDestroyWarning(context, {
      resourceName,
      reason,
      outcome: "prior_provider_not_found",
      priorProviderId: snapshot.providerId,
      currentProviderId,
      handle: snapshot.handle,
      currentFingerprint,
      priorFingerprint: snapshot.specFingerprint,
      deploymentName,
      message: `prior provider ${snapshot.providerId} no longer registered; ` +
        `handle ${String(snapshot.handle)} may leak`,
    });
    return;
  }

  try {
    await withDeployTraceSpan(
      { observability: context.observability },
      {
        name: "takosumi.provider.destroy.replace",
        trace: context.trace,
        spaceId: context.spaceId,
        groupId: deploymentName,
        operationKind: "destroy",
        attributes: {
          "takosumi.resource_name": resourceName,
          "takosumi.provider_id": snapshot.providerId,
          "takosumi.replace_reason": reason,
          "takosumi.provider_handle": String(snapshot.handle),
        },
      },
      () => priorProvider!.destroy(snapshot.handle, context),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitDestroyWarning(context, {
      resourceName,
      reason,
      outcome: "destroy_failed",
      priorProviderId: snapshot.providerId,
      currentProviderId,
      handle: snapshot.handle,
      currentFingerprint,
      priorFingerprint: snapshot.specFingerprint,
      deploymentName,
      message: `prior provider destroy failed: ${message}`,
    });
  }
}

interface DestroyWarning {
  readonly resourceName: string;
  readonly reason: "provider_id_mismatch" | "fingerprint_mismatch";
  readonly outcome: "destroy_failed" | "prior_provider_not_found";
  readonly priorProviderId: string;
  readonly currentProviderId: string;
  readonly handle: ResourceHandle;
  readonly currentFingerprint: string;
  readonly priorFingerprint: string;
  readonly deploymentName?: string;
  readonly message: string;
}

/**
 * Append a structured warning span recording a failed (or skipped) prior
 * destroy. We reuse `withDeployTraceSpan` so the span flows through the
 * same observability sink the rest of `applyV2` writes to. The wrapped
 * promise rejects with the warning message, which `withDeployTraceSpan`
 * captures as `statusMessage` on an error-status span. We swallow the
 * rethrown error here so the apply pipeline keeps running.
 */
async function emitDestroyWarning(
  context: PlatformContext,
  warning: DestroyWarning,
): Promise<void> {
  try {
    await withDeployTraceSpan<never>(
      { observability: context.observability },
      {
        name: "takosumi.provider.destroy.replace.warning",
        trace: context.trace,
        spaceId: context.spaceId,
        ...(warning.deploymentName ? { groupId: warning.deploymentName } : {}),
        operationKind: "destroy",
        attributes: {
          "takosumi.resource_name": warning.resourceName,
          "takosumi.replace_reason": warning.reason,
          "takosumi.replace_outcome": warning.outcome,
          "takosumi.prior_provider_id": warning.priorProviderId,
          "takosumi.current_provider_id": warning.currentProviderId,
          "takosumi.prior_handle": String(warning.handle),
          "takosumi.prior_fingerprint": warning.priorFingerprint,
          "takosumi.current_fingerprint": warning.currentFingerprint,
        },
      },
      () => Promise.reject(new Error(warning.message)),
    );
  } catch {
    // Warning is best-effort; rethrown error from the synthetic span is
    // intentionally swallowed so the apply pipeline keeps running.
  }
}
