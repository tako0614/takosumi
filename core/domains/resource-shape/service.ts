// Resource Shape service: the Flow B control loop for one resource.
//
// preview/apply resolve a shape (Resolver) to an implementation+Target, pin the
// decision (ResolutionLock), persist desired+observed state, and drive an
// adapter (opentofu-adapter or stub) to materialize native resources. The
// service is store- and adapter-injected so it runs the same against in-memory
// or durable (D1/Postgres) stores and against the stub or runner adapter.

import type {
  ActorContext,
  Condition,
  JsonObject,
  NativeResourceRef,
  ResourceConnectionSpec,
  ResourceDeploymentAdmission,
  ResourceDeploymentQuote,
  ResourceDeploymentQuoteContext,
  ResourceDeploymentReview,
  ResolverOutput,
  ResourceManagedBy,
  ResourceEvent,
  ResourceObject,
  ResourceShapeKind,
  ResourceStatus,
  SpacePolicy,
  SpacePolicySpec,
  TargetImplementationDescriptor,
  TargetPool,
  TargetPoolEntry,
  TargetPoolSpec,
} from "takosumi-contract";
import {
  isResourceShapeKind,
  NOOP_RESOURCE_DEPLOYMENT_ADMISSION,
  TAKOSUMI_API_VERSION,
} from "takosumi-contract";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type { IsoTimestamp } from "../../shared/time.ts";
import type { SpaceId } from "../../shared/ids.ts";
import { log } from "../../shared/log.ts";
import {
  formatResourceShapeId,
  type ResolutionLockRecord,
  type ResourceShapeRecord,
  type SpacePolicyRecord,
  type TargetPoolRecord,
} from "./records.ts";
import type { ResourceShapeStores } from "./stores.ts";
import type {
  AdapterApplyResult,
  AdapterObservationStatus,
  AdapterImportResult,
  AdapterObserveResult,
  AdapterRefreshResult,
  ResolvedResourceConnection,
  ResourceAdapter,
} from "./adapter.ts";
import { adapterApplyMutationOutcome } from "./adapter.ts";
import { resolve } from "./resolver.ts";
import {
  parseResourceSpec,
  planResourceShape,
  type ParsedResourceSpec,
  type ResourceShapePlan,
  type ResourceShapeModuleRegistry,
  EMPTY_RESOURCE_SHAPE_MODULE_REGISTRY,
  type ResourceShapeSchemaRegistry,
  EMPTY_RESOURCE_SHAPE_SCHEMA_REGISTRY,
} from "./planner.ts";
import { secretLikeJsonPath } from "./secret_guard.ts";
import type { ActivityLedger } from "../activity/mod.ts";
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";

export type ResourceServiceErrorCode =
  | "invalid_spec"
  | "invalid_name"
  | "invalid_interfaces"
  | "invalid_interface"
  | "invalid_protocols"
  | "invalid_protocol"
  | "invalid_consistency"
  | "invalid_delivery"
  | "invalid_engine"
  | "invalid_migrations_path"
  | "invalid_image"
  | "invalid_ports"
  | "invalid_public_http"
  | "invalid_environment"
  | "invalid_compatibility_date"
  | "invalid_runtime"
  | "invalid_profile"
  | "invalid_source"
  | "invalid_connections"
  | "invalid_model_policy"
  | "invalid_lifecycle_policy"
  | "invalid_delete_policy"
  | "invalid_target_pool"
  | "target_pool_in_use"
  | "target_pool_not_found"
  | "policy_denied"
  | "capability_missing"
  | "unsupported_shape"
  | "selected_target_missing"
  | "resolution_descriptor_missing"
  | "connection_not_found"
  | "connection_not_ready"
  | "not_found"
  | "delete_blocked"
  | "observe_blocked"
  | "refresh_blocked"
  | "invalid_import"
  | "import_conflict"
  | "reconcile_conflict"
  | "deployment_review_required"
  | "deployment_plan_changed"
  | "deployment_quote_invalid"
  | "deployment_admission_denied"
  | "deployment_finalize_pending"
  | "deployment_billing_finalize_failed"
  | "apply_failed"
  | "observe_failed"
  | "refresh_failed"
  | "import_failed"
  | "delete_failed";

export interface ResourceServiceError {
  readonly code: ResourceServiceErrorCode;
  readonly message: string;
}

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResourceServiceError };

export interface ApplyResourceRequest {
  readonly actor: ActorContext;
  readonly space: SpaceId;
  readonly project?: string;
  readonly environment?: string;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  readonly spec: JsonObject;
  readonly managedBy?: ResourceManagedBy;
  readonly labels?: Readonly<Record<string, string>>;
  readonly targetPoolName?: string;
  readonly spacePolicyName?: string;
}

export interface PreviewResourceResult {
  readonly resource: ResourceObject;
  readonly planDigest: string;
  readonly specDigest: string;
  readonly resolutionFingerprint: string;
  readonly quote?: ResourceDeploymentQuote;
  readonly selectedImplementation: string;
  readonly selectedTarget: string;
  readonly portability: string;
  readonly nativeResourcePlan: readonly NativeResourceRef[];
  readonly riskNotes: readonly string[];
  readonly summary: string;
}

export interface ObserveResourceResult {
  readonly resource: ResourceObject;
  readonly observation: {
    readonly status: AdapterObservationStatus;
    readonly summary: string;
    readonly runId?: string;
  };
}

export interface RefreshResourceResult {
  readonly resource: ResourceObject;
  readonly refresh: {
    readonly summary: string;
    readonly runId?: string;
  };
}

export interface ImportResourceRequest extends ApplyResourceRequest {
  /** Provider-native identity consumed only by the adapter import boundary. */
  readonly nativeId: string;
}

export interface ImportResourceResult {
  readonly resource: ResourceObject;
  readonly import: {
    readonly summary: string;
    readonly runId?: string;
  };
}

const DEFAULT_POOL_NAME = "default";
const DEFAULT_DELETE_TIMEOUT_MS = 120_000;

export interface ResourceShapeServiceDeps {
  readonly stores: ResourceShapeStores;
  readonly adapter: ResourceAdapter;
  readonly now: () => IsoTimestamp;
  readonly deleteTimeoutMs?: number;
  readonly lifecycleObserver?: ResourceShapeLifecycleObserver;
  /** Optional host quote/payment policy. OSS uses a non-blocking no-op. */
  readonly deploymentAdmission?: ResourceDeploymentAdmission;
  /** Shared non-secret Activity ledger used for Resource event projection. */
  readonly activity?: ActivityLedger;
  /** Explicit operator module catalog for `moduleTemplate` descriptors. */
  readonly moduleRegistry?: ResourceShapeModuleRegistry;
  /** Explicit schemas for operator-defined Resource Shape tokens. */
  readonly schemaRegistry?: ResourceShapeSchemaRegistry;
  /** Absolute providerConfig URL values trusted by this operator. */
  readonly allowedProviderConfigUrls?: readonly string[];
  /** @deprecated Use allowedProviderConfigUrls. */
  readonly allowedProviderBaseUrls?: readonly string[];
}

export type ResourceShapeLifecycleEvent =
  | {
      readonly type: "ready";
      readonly spaceId: SpaceId;
      readonly resourceId: string;
    }
  | {
      readonly type: "unknown";
      readonly spaceId: SpaceId;
      readonly resourceId: string;
      readonly operation: "apply" | "import" | "refresh" | "delete";
    }
  | {
      readonly type: "terminating";
      readonly spaceId: SpaceId;
      readonly resourceId: string;
    }
  | {
      readonly type: "retired";
      readonly spaceId: SpaceId;
      readonly resourceId: string;
    };

export interface ResourceShapeLifecycleObserver {
  observe(event: ResourceShapeLifecycleEvent): Promise<void>;
}

export interface DeleteResourceOptions {
  /**
   * Break-glass ledger tombstone. Normal deletes try adapter/native cleanup
   * first; force deletes are for operator cleanup of failed resources whose
   * native cleanup credentials or target no longer exist.
   */
  readonly force?: boolean;
}

export class ResourceShapeService {
  readonly #stores: ResourceShapeStores;
  readonly #adapter: ResourceAdapter;
  readonly #now: () => IsoTimestamp;
  readonly #deleteTimeoutMs: number;
  readonly #allowedProviderConfigUrls: ReadonlySet<string>;
  readonly #moduleRegistry: ResourceShapeModuleRegistry;
  readonly #schemaRegistry: ResourceShapeSchemaRegistry;
  readonly #activity: ActivityLedger | undefined;
  readonly #deploymentAdmission: ResourceDeploymentAdmission;
  #lifecycleObserver: ResourceShapeLifecycleObserver | undefined;

  constructor(deps: ResourceShapeServiceDeps) {
    this.#stores = deps.stores;
    this.#adapter = deps.adapter;
    this.#now = deps.now;
    this.#deleteTimeoutMs = deps.deleteTimeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS;
    this.#lifecycleObserver = deps.lifecycleObserver;
    this.#activity = deps.activity;
    this.#deploymentAdmission =
      deps.deploymentAdmission ?? NOOP_RESOURCE_DEPLOYMENT_ADMISSION;
    this.#moduleRegistry =
      deps.moduleRegistry ?? EMPTY_RESOURCE_SHAPE_MODULE_REGISTRY;
    this.#schemaRegistry =
      deps.schemaRegistry ?? EMPTY_RESOURCE_SHAPE_SCHEMA_REGISTRY;
    this.#allowedProviderConfigUrls = new Set(
      (
        deps.allowedProviderConfigUrls ??
        deps.allowedProviderBaseUrls ??
        []
      ).map(normalizeBaseUrl),
    );
  }

  setLifecycleObserver(
    observer: ResourceShapeLifecycleObserver | undefined,
  ): void {
    this.#lifecycleObserver = observer;
  }

  // --- Configuration: TargetPool / SpacePolicy --------------------------------

  async putTargetPool(
    space: SpaceId,
    name: string,
    spec: TargetPoolSpec,
  ): Promise<ServiceResult<TargetPoolRecord>> {
    const validation = validateTargetPoolSpec(
      name,
      spec,
      this.#allowedProviderConfigUrls,
    );
    if (validation) return { ok: false, error: validation };
    const now = this.#now();
    const existing = await this.#stores.targetPools.getByName(space, name);
    if (existing) {
      if (canonicalJson(existing.spec) === canonicalJson(spec)) {
        return { ok: true, value: existing };
      }
      const reference = await this.#targetPoolReference(existing);
      if (reference) {
        return {
          ok: false,
          error: {
            code: "target_pool_in_use",
            message: `TargetPool ${name} is pinned by ${reference.resourceId}; delete or explicitly migrate that Resource before changing the pool`,
          },
        };
      }
    }
    const record: TargetPoolRecord = {
      id: existing?.id ?? `tkrn:${space}:TargetPool:${name}`,
      spaceId: space,
      name,
      spec: spec as unknown as JsonObject,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return { ok: true, value: await this.#stores.targetPools.upsert(record) };
  }

  async putSpacePolicy(
    space: SpaceId,
    name: string,
    spec: SpacePolicySpec,
  ): Promise<SpacePolicyRecord> {
    const now = this.#now();
    const existing = await this.#stores.spacePolicies.getByName(space, name);
    const record: SpacePolicyRecord = {
      id: existing?.id ?? `tkrn:${space}:SpacePolicy:${name}`,
      spaceId: space,
      name,
      spec: spec as unknown as JsonObject,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.#stores.spacePolicies.upsert(record);
  }

  listSpacePolicies(space: SpaceId): Promise<readonly SpacePolicyRecord[]> {
    return this.#stores.spacePolicies.listBySpace(space);
  }

  listSpacePoliciesPage(
    space: SpaceId,
    params: PageParams,
  ): Promise<Page<SpacePolicyRecord>> {
    return this.#stores.spacePolicies.listBySpacePage(space, params);
  }

  getSpacePolicy(
    space: SpaceId,
    name: string,
  ): Promise<SpacePolicyRecord | undefined> {
    return this.#stores.spacePolicies.getByName(space, name);
  }

  async deleteSpacePolicy(space: SpaceId, name: string): Promise<void> {
    const existing = await this.#stores.spacePolicies.getByName(space, name);
    if (existing) await this.#stores.spacePolicies.delete(existing.id);
  }

  listTargetPools(space: SpaceId): Promise<readonly TargetPoolRecord[]> {
    return this.#stores.targetPools.listBySpace(space);
  }

  listTargetPoolsPage(
    space: SpaceId,
    params: PageParams,
  ): Promise<Page<TargetPoolRecord>> {
    return this.#stores.targetPools.listBySpacePage(space, params);
  }

  getTargetPool(
    space: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined> {
    return this.#stores.targetPools.getByName(space, name);
  }

  async deleteTargetPool(
    space: SpaceId,
    name: string,
  ): Promise<ServiceResult<void>> {
    const existing = await this.#stores.targetPools.getByName(space, name);
    if (!existing) return { ok: true, value: undefined };
    const reference = await this.#targetPoolReference(existing);
    if (reference) {
      return {
        ok: false,
        error: {
          code: "target_pool_in_use",
          message: `TargetPool ${name} is pinned by ${reference.resourceId}; delete or explicitly migrate that Resource before deleting the pool`,
        },
      };
    }
    await this.#stores.targetPools.delete(existing.id);
    return { ok: true, value: undefined };
  }

  // --- preview / apply / get / list / delete ----------------------------------

  async preview(
    req: ApplyResourceRequest,
  ): Promise<ServiceResult<PreviewResourceResult>> {
    const resourceId = formatResourceShapeId(req.space, req.kind, req.name);
    const existing = await this.#stores.resources.get(resourceId);
    const existingLock = await this.#stores.locks.get(resourceId);
    const prepared = await this.#resolveAndPlan(req, existingLock);
    if (!prepared.ok) return prepared;
    const { resource, output, plan, entry, parsed } = prepared.value;
    const resolvedConnections = await this.#resolveConnections(
      req.space,
      output.resolutionLock.resourceId,
      parsed,
    );
    if (!resolvedConnections.ok) return resolvedConnections;
    const adapterPreview = await this.#adapter.preview({
      resourceId: output.resolutionLock.resourceId,
      environment: req.environment ?? existing?.environment ?? "default",
      stateGeneration:
        existing?.execution?.stateGeneration ??
        existing?.stateAdoption?.stateGeneration ??
        0,
      ...(existing?.stateAdoption
        ? { stateAdoption: existing.stateAdoption }
        : {}),
      plan,
      target: entry,
      implementation: output.selectedImplementationDescriptor,
      credentialRef: entry.credentialRef,
      nativeResources: output.nativeResourcePlan,
      ...(Object.keys(resolvedConnections.value).length > 0
        ? { resolvedConnections: resolvedConnections.value }
        : {}),
      actor: req.actor,
    });
    const evidence = await resourceDeploymentEvidence(req, output, plan);
    const quoteContext = resourceDeploymentQuoteContext(
      req,
      output,
      evidence,
      this.#now(),
    );
    let quote: ResourceDeploymentQuote | undefined;
    try {
      quote = await this.#deploymentAdmission.quote(quoteContext);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "deployment_quote_invalid",
          message: errorMessage(error),
        },
      };
    }
    if (quote) {
      const quoteError = deploymentQuoteError(quote, quoteContext);
      if (quoteError) {
        return {
          ok: false,
          error: { code: "deployment_quote_invalid", message: quoteError },
        };
      }
    }
    return {
      ok: true,
      value: {
        resource,
        planDigest: evidence.planDigest,
        specDigest: evidence.specDigest,
        resolutionFingerprint: evidence.resolutionFingerprint,
        ...(quote ? { quote } : {}),
        selectedImplementation: output.selectedImplementation,
        selectedTarget: output.selectedTarget,
        portability: output.portability,
        nativeResourcePlan: output.nativeResourcePlan,
        riskNotes: output.riskNotes,
        summary: adapterPreview.summary,
      },
    };
  }

  async apply(
    req: ApplyResourceRequest,
    review: ResourceDeploymentReview,
  ): Promise<ServiceResult<ResourceObject>> {
    return await this.#applyDeployment(req, review, false);
  }

  /**
   * Host recovery entrypoint for a Resource left Applying after an uncertain
   * backend outcome. It only performs adapter refresh; it never redispatches
   * provider mutation. Hosts should call it from their durable reservation/run
   * reconciler, not as an ordinary user retry.
   */
  async recoverApply(
    req: ApplyResourceRequest,
    review: ResourceDeploymentReview,
  ): Promise<ServiceResult<ResourceObject>> {
    return await this.#applyDeployment(req, review, true);
  }

  async #applyDeployment(
    req: ApplyResourceRequest,
    review: ResourceDeploymentReview,
    recoveryRequested: boolean,
  ): Promise<ServiceResult<ResourceObject>> {
    if (!review) {
      return {
        ok: false,
        error: {
          code: "deployment_review_required",
          message: "deployment apply requires preview review evidence",
        },
      };
    }
    const id = formatResourceShapeId(req.space, req.kind, req.name);
    const existing = await this.#stores.resources.get(id);
    if (existing?.phase === "Deleting") {
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} is currently deleting`,
        },
      };
    }
    const recoveringApplying = existing?.phase === "Applying";
    if (recoveringApplying && !applyingRequestMatchesRecord(req, existing)) {
      return {
        ok: false,
        error: {
          code: "apply_failed",
          message: `resource ${id} is already applying a different desired state`,
        },
      };
    }
    if (recoveringApplying && !recoveryRequested) {
      return {
        ok: false,
        error: {
          code: "deployment_finalize_pending",
          message: `resource ${id} is already Applying; the host recovery loop must reconcile its prior backend outcome`,
        },
      };
    }
    if (recoveryRequested && !recoveringApplying) {
      return {
        ok: false,
        error: {
          code: "apply_failed",
          message: `resource ${id} is not awaiting apply recovery`,
        },
      };
    }
    const existingLock = await this.#stores.locks.get(id);

    const prepared = await this.#resolveAndPlan(req, existingLock);
    if (!prepared.ok) return prepared;
    const { output, plan, entry, parsed } = prepared.value;
    const resolvedConnections = await this.#resolveConnections(
      req.space,
      id,
      parsed,
    );
    if (!resolvedConnections.ok) return resolvedConnections;

    const evidence = await resourceDeploymentEvidence(req, output, plan);
    const reviewError = deploymentReviewError(review, evidence.planDigest);
    if (reviewError) {
      return {
        ok: false,
        error: { code: "deployment_plan_changed", message: reviewError },
      };
    }
    const context = resourceDeploymentQuoteContext(
      req,
      output,
      evidence,
      this.#now(),
    );
    const now = nextApplyClaimTimestamp(this.#now(), existing?.updatedAt);
    const generation = recoveringApplying
      ? existing.generation
      : (existing?.generation ?? 0) + 1;

    // Persist desired state in the Applying phase before touching the adapter.
    const applyingRecord: ResourceShapeRecord = {
      id,
      spaceId: req.space,
      project: req.project,
      environment: req.environment,
      kind: req.kind,
      name: req.name,
      managedBy: req.managedBy ?? "opentofu",
      spec: req.spec,
      phase: "Applying",
      generation,
      observedGeneration: existing?.observedGeneration ?? 0,
      outputs: existing?.outputs,
      execution: existing?.execution,
      ...(existing?.stateAdoption
        ? { stateAdoption: existing.stateAdoption }
        : {}),
      conditions: existing?.conditions,
      labels: req.labels ?? existing?.labels,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    // Pin the resolution. Reuse the prior lockedAt when the lock was preserved.
    const lockRecord: ResolutionLockRecord = {
      resourceId: id,
      selectedImplementation: output.resolutionLock.selectedImplementation,
      targetPool: output.resolutionLock.targetPool,
      target: output.resolutionLock.target,
      targetSnapshot: output.resolutionLock.targetSnapshot,
      implementationSnapshot: output.resolutionLock.implementationSnapshot,
      implementationFingerprint:
        output.resolutionLock.implementationFingerprint,
      locked: output.resolutionLock.locked,
      reason: output.resolutionLock.reason,
      portability: output.resolutionLock.portability,
      nativeResources: output.resolutionLock.nativeResources,
      lockedAt: existingLock?.lockedAt ?? now,
      updatedAt: now,
    };

    // Claim the Resource lifecycle before reserving money. This makes a
    // concurrent caller lose before it can create or release the winner's
    // idempotent reservation.
    let claimSucceeded = false;
    try {
      const claim = await this.#stores.beginApply({
        applyingRecord,
        plannedLock: lockRecord,
        ...(existing ? { expected: versionOf(existing) } : {}),
      });
      claimSucceeded = claim.status === "begun";
    } catch (error) {
      return {
        ok: false,
        error: { code: "apply_failed", message: errorMessage(error) },
      };
    }
    if (!claimSucceeded) {
      return {
        ok: false,
        error: {
          code: "reconcile_conflict",
          message: `resource ${id} changed before apply could be claimed`,
        },
      };
    }

    let reservationId: string | undefined;
    try {
      const decision = await this.#deploymentAdmission.reserve({
        ...context,
        review,
      });
      if (decision.reasons.length > 0) {
        const rolledBack = await rollbackUnstartedApplyClaim(
          this.#stores,
          applyingRecord,
          lockRecord,
          existing,
          existingLock,
        );
        return rolledBack
          ? {
              ok: false,
              error: {
                code: "deployment_admission_denied",
                message: decision.reasons.join("; "),
              },
            }
          : applyClaimRollbackPending(id);
      }
      reservationId = decision.reservationId;
    } catch (error) {
      const rolledBack = await rollbackUnstartedApplyClaim(
        this.#stores,
        applyingRecord,
        lockRecord,
        existing,
        existingLock,
      );
      return rolledBack
        ? {
            ok: false,
            error: {
              code: "deployment_admission_denied",
              message: errorMessage(error),
            },
          }
        : applyClaimRollbackPending(id);
    }

    let adapterSucceeded = false;
    let adapterStarted = false;
    let adapterResult: AdapterApplyResult | undefined;
    try {
      // Everything after a successful reservation is guarded. A failure before
      // backend success releases the reservation and leaves no billable work.
      await this.#recordResourceEvent({
        action: recoveringApplying
          ? "resource.apply.recovery_started"
          : "resource.apply.started",
        space: req.space,
        resourceId: id,
        actor: req.actor,
        metadata: { generation, phase: "Applying" },
      });

      const adapterInput = {
        resourceId: id,
        environment: req.environment ?? existing?.environment ?? "default",
        stateGeneration:
          existing?.execution?.stateGeneration ??
          existing?.stateAdoption?.stateGeneration ??
          0,
        ...(existing?.stateAdoption
          ? { stateAdoption: existing.stateAdoption }
          : {}),
        plan,
        target: entry,
        implementation: output.selectedImplementationDescriptor,
        credentialRef: entry.credentialRef,
        nativeResources: output.nativeResourcePlan,
        ...(Object.keys(resolvedConnections.value).length > 0
          ? { resolvedConnections: resolvedConnections.value }
          : {}),
        actor: req.actor,
      };
      adapterStarted = true;
      // Never redispatch provider mutation for an Applying record: the prior
      // call may have succeeded before its response or Ready persistence was
      // lost. Recovery is read-only refresh over the pinned backend identity.
      const result = recoveringApplying
        ? await this.#adapter.refresh(adapterInput)
        : await this.#adapter.apply(adapterInput);
      adapterSucceeded = true;
      adapterResult = result;
      if (existing?.stateAdoption && !result.execution) {
        throw new Error(
          `resource ${id} apply succeeded without Resource-owned execution state; refusing to consume confirmed state adoption`,
        );
      }
      const { stateAdoption: _consumedStateAdoption, ...readyRecordBase } =
        applyingRecord;
      const readyRecord: ResourceShapeRecord = {
        ...readyRecordBase,
        phase: "Ready",
        observedGeneration: generation,
        outputs: result.outputs,
        execution: result.execution ?? existing?.execution,
        conditions: [readyCondition(generation, this.#now())],
        updatedAt: this.#now(),
      };
      const readyLock = {
        ...lockRecord,
        nativeResources: result.nativeResources,
        updatedAt: this.#now(),
      };
      // Publish the final backend identity and Ready record as one fenced
      // transaction. A reader can never observe Ready with the planned lock or
      // an Applying Resource with final native identifiers.
      const published = await this.#stores.commitApply({
        readyRecord,
        finalLock: readyLock,
        expectedApplying: {
          generation: applyingRecord.generation,
          phase: "Applying",
          updatedAt: applyingRecord.updatedAt,
        },
      });
      if (published.status !== "committed") {
        throw new Error(
          `resource ${id} changed before Ready finalization could commit`,
        );
      }
      await this.#notifyLifecycle({
        type: "ready",
        spaceId: req.space,
        resourceId: id,
      });
      await this.#recordResourceEvent({
        action: "resource.apply.succeeded",
        space: req.space,
        resourceId: id,
        actor: req.actor,
        ...(result.runId ? { runId: result.runId } : {}),
        metadata: {
          generation,
          observedGeneration: generation,
          phase: "Ready",
          nativeResourceCount: result.nativeResources.length,
        },
      });
      if (review.quoteId) {
        try {
          await this.#deploymentAdmission.capture({
            ...context,
            review,
            ...(reservationId ? { reservationId } : {}),
            nativeResources: result.nativeResources,
          });
          await this.#recordResourceEvent({
            action: "resource.billing.captured",
            space: req.space,
            resourceId: id,
            actor: req.actor,
            metadata: {
              generation,
              ...(reservationId ? { reservationId } : {}),
            },
          });
        } catch (error) {
          // The backend mutation and canonical Resource are already durable.
          // Never release this reservation: a host recovery loop can safely
          // retry its idempotent capture against the Ready Resource.
          try {
            await this.#deploymentAdmission.markSettlementPending({
              ...context,
              review,
              ...(reservationId ? { reservationId } : {}),
              backendOutcome: "succeeded",
              nativeResources: result.nativeResources,
              reason: "billing_capture_failed",
            });
          } catch (pendingError) {
            log.warn(
              "service.resource_shape.billing_settlement_pending_failed",
              {
                resourceId: id,
                error: pendingError,
              },
            );
          }
          await this.#recordResourceEvent({
            action: "resource.billing.capture_pending",
            space: req.space,
            resourceId: id,
            actor: req.actor,
            metadata: {
              generation,
              ...(reservationId ? { reservationId } : {}),
            },
          });
          return {
            ok: false,
            error: {
              code: "deployment_billing_finalize_failed",
              message:
                `resource ${id} is Ready but billing capture is pending: ` +
                errorMessage(error),
            },
          };
        }
      }
      return {
        ok: true,
        value: this.#assemble(published.record, published.lock),
      };
    } catch (error) {
      if (adapterSucceeded) {
        // Backend work may exist. Do not restore the old lock, publish a false
        // Failed state, or release payment. Keep Applying for deterministic
        // recovery and durably mark the reservation as capture-pending.
        if (review.quoteId) {
          try {
            await this.#deploymentAdmission.markSettlementPending({
              ...context,
              review,
              ...(reservationId ? { reservationId } : {}),
              backendOutcome: "succeeded",
              nativeResources: adapterResult?.nativeResources ?? [],
              reason: "resource_finalize_failed",
            });
          } catch (pendingError) {
            log.warn(
              "service.resource_shape.billing_settlement_pending_failed",
              {
                resourceId: id,
                error: pendingError,
              },
            );
          }
        }
        await this.#notifyLifecycle({
          type: "unknown",
          spaceId: req.space,
          resourceId: id,
          operation: "apply",
        });
        await this.#recordResourceEvent({
          action: "resource.apply.finalize_pending",
          space: req.space,
          resourceId: id,
          actor: req.actor,
          metadata: {
            generation,
            phase: "Applying",
            ...(reservationId ? { reservationId } : {}),
          },
        });
        return {
          ok: false,
          error: {
            code: "deployment_finalize_pending",
            message:
              `resource ${id} backend apply succeeded but durable finalization is pending: ` +
              errorMessage(error),
          },
        };
      }

      if (
        adapterStarted &&
        (recoveringApplying || adapterApplyMutationOutcome(error) !== "none")
      ) {
        // A timeout, transport error, plugin crash, or ordinary thrown Error
        // cannot prove that the provider made no change. Keep the reservation
        // and Applying record recoverable; releasing here could create a live
        // but unbilled resource.
        if (review.quoteId) {
          try {
            await this.#deploymentAdmission.markSettlementPending({
              ...context,
              review,
              ...(reservationId ? { reservationId } : {}),
              backendOutcome: "unknown",
              nativeResources: [],
              reason: "backend_outcome_unknown",
            });
          } catch (pendingError) {
            log.warn(
              "service.resource_shape.billing_settlement_pending_failed",
              {
                resourceId: id,
                error: pendingError,
              },
            );
          }
        }
        await this.#notifyLifecycle({
          type: "unknown",
          spaceId: req.space,
          resourceId: id,
          operation: "apply",
        });
        await this.#recordResourceEvent({
          action: "resource.apply.outcome_unknown",
          space: req.space,
          resourceId: id,
          actor: req.actor,
          metadata: {
            generation,
            phase: "Applying",
            ...(reservationId ? { reservationId } : {}),
          },
        });
        return {
          ok: false,
          error: {
            code: "deployment_finalize_pending",
            message:
              `resource ${id} backend outcome is unknown and recovery is required: ` +
              errorMessage(error),
          },
        };
      }

      try {
        await this.#deploymentAdmission.release({
          ...context,
          review,
          ...(reservationId ? { reservationId } : {}),
          reason: "resource_apply_failed_before_backend_success",
        });
      } catch (releaseError) {
        log.warn("service.resource_shape.billing_release_failed", {
          resourceId: id,
          error: releaseError,
        });
      }
      const failedRecord: ResourceShapeRecord = {
        ...applyingRecord,
        phase: "Failed",
        conditions: [failedCondition(generation, this.#now(), error)],
        updatedAt: this.#now(),
      };
      try {
        const failed = await this.#stores.abortApply({
          resourceId: id,
          expectedApplying: {
            generation: applyingRecord.generation,
            phase: "Applying",
            updatedAt: applyingRecord.updatedAt,
          },
          expectedPlannedLock: lockRecord,
          replacement: {
            record: failedRecord,
            lock: existingLock ?? null,
          },
        });
        if (failed.status !== "rolled_back") {
          log.warn("service.resource_shape.failure_record_conflict", {
            resourceId: id,
            status: failed.status,
          });
        }
      } catch (persistenceError) {
        log.warn("service.resource_shape.failure_record_failed", {
          resourceId: id,
          error: persistenceError,
        });
      }
      await this.#notifyLifecycle({
        type: "unknown",
        spaceId: req.space,
        resourceId: id,
        operation: "apply",
      });
      await this.#recordResourceEvent({
        action: "resource.apply.failed",
        space: req.space,
        resourceId: id,
        actor: req.actor,
        metadata: { generation, phase: "Failed" },
      });
      return {
        ok: false,
        error: { code: "apply_failed", message: errorMessage(error) },
      };
    }
  }

  /**
   * Adopt one existing provider resource through an explicit Target descriptor.
   * The adapter is required to prove a read-only import before this projection
   * becomes Ready; failed attempts remain removable ledger-only records.
   */
  async importResource(
    req: ImportResourceRequest,
  ): Promise<ServiceResult<ImportResourceResult>> {
    if (
      req.nativeId.trim() === "" ||
      req.nativeId.length > 2048 ||
      /[\u0000-\u001f\u007f]/.test(req.nativeId)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_import",
          message:
            "nativeId must be a non-empty printable string no longer than 2048 characters",
        },
      };
    }

    const id = formatResourceShapeId(req.space, req.kind, req.name);
    const importRequestDigest = await resourceImportRequestDigest(req);
    const [existing, existingLock] = await Promise.all([
      this.#stores.resources.get(id),
      this.#stores.locks.get(id),
    ]);
    const recoveringImport =
      existing !== undefined &&
      existingLock !== undefined &&
      importRequestMatchesApplying(req, existing, importRequestDigest);
    if (existing && !recoveringImport) {
      return {
        ok: false,
        error: {
          code: "import_conflict",
          message: `resource ${id} already exists`,
        },
      };
    }
    if (!existing && existingLock) {
      return {
        ok: false,
        error: {
          code: "import_conflict",
          message: `resource ${id} has an orphaned ResolutionLock and requires operator recovery`,
        },
      };
    }

    const prepared = await this.#resolveAndPlan(
      req,
      recoveringImport ? existingLock : undefined,
    );
    if (!prepared.ok) return prepared;
    const { output, plan, entry, parsed } = prepared.value;
    if (
      !output.selectedImplementationDescriptor.plugin &&
      !output.selectedImplementationDescriptor.moduleImportAddress
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_import",
          message: `resource implementation ${output.selectedImplementation} does not declare moduleImportAddress`,
        },
      };
    }
    const resolvedConnections = await this.#resolveConnections(
      req.space,
      id,
      parsed,
    );
    if (!resolvedConnections.ok) return resolvedConnections;

    const now = nextApplyClaimTimestamp(this.#now(), existing?.updatedAt);
    const applyingRecord: ResourceShapeRecord = {
      id,
      spaceId: req.space,
      project: req.project,
      environment: req.environment,
      kind: req.kind,
      name: req.name,
      managedBy: "import-pending",
      spec: req.spec,
      phase: "Applying",
      generation: 1,
      observedGeneration: 0,
      conditions: [importingCondition(1, now, importRequestDigest)],
      labels: req.labels,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const lockRecord: ResolutionLockRecord = {
      resourceId: id,
      selectedImplementation: output.resolutionLock.selectedImplementation,
      targetPool: output.resolutionLock.targetPool,
      target: output.resolutionLock.target,
      targetSnapshot: output.resolutionLock.targetSnapshot,
      implementationSnapshot: output.resolutionLock.implementationSnapshot,
      implementationFingerprint:
        output.resolutionLock.implementationFingerprint,
      locked: output.resolutionLock.locked,
      reason: output.resolutionLock.reason,
      portability: output.resolutionLock.portability,
      nativeResources: output.resolutionLock.nativeResources,
      lockedAt: existingLock?.lockedAt ?? now,
      updatedAt: now,
    };

    let claim: Awaited<ReturnType<ResourceShapeStores["beginApply"]>>;
    try {
      claim = await this.#stores.beginApply({
        applyingRecord,
        plannedLock: lockRecord,
        ...(recoveringImport && existing
          ? { expected: versionOf(existing) }
          : {}),
      });
    } catch (error) {
      return {
        ok: false,
        error: { code: "import_failed", message: errorMessage(error) },
      };
    }
    if (claim.status !== "begun") {
      return {
        ok: false,
        error: {
          code: "import_conflict",
          message: `resource ${id} changed before import could be claimed`,
        },
      };
    }

    let result: AdapterImportResult;
    try {
      await this.#recordResourceEvent({
        action: "resource.import.started",
        space: req.space,
        resourceId: id,
        actor: req.actor,
        metadata: { generation: 1, phase: "Applying" },
      });
      result = await this.#adapter.importResource({
        resourceId: id,
        environment: req.environment ?? "default",
        stateGeneration: 0,
        plan,
        target: entry,
        implementation: output.selectedImplementationDescriptor,
        credentialRef: entry.credentialRef,
        nativeResources: output.nativeResourcePlan,
        ...(Object.keys(resolvedConnections.value).length > 0
          ? { resolvedConnections: resolvedConnections.value }
          : {}),
        actor: req.actor,
        nativeId: req.nativeId,
      });
      if (
        !output.selectedImplementationDescriptor.plugin &&
        !result.execution
      ) {
        throw new Error(
          `resource ${id} import succeeded without Resource-owned execution state`,
        );
      }
    } catch (error) {
      const failedAt = this.#now();
      const failedRecord: ResourceShapeRecord = {
        ...applyingRecord,
        phase: "Failed",
        conditions: [importFailedCondition(1, failedAt, error, req.nativeId)],
        updatedAt: failedAt,
      };
      let failurePersisted = false;
      try {
        const failed = await this.#stores.abortApply({
          resourceId: id,
          expectedApplying: {
            generation: applyingRecord.generation,
            phase: "Applying",
            updatedAt: applyingRecord.updatedAt,
          },
          expectedPlannedLock: lockRecord,
          replacement: { record: failedRecord, lock: lockRecord },
        });
        failurePersisted = failed.status === "rolled_back";
      } catch (persistenceError) {
        log.warn("service.resource_shape.import_failure_record_failed", {
          resourceId: id,
          error: persistenceError,
        });
      }
      await this.#notifyLifecycle({
        type: "unknown",
        spaceId: req.space,
        resourceId: id,
        operation: "import",
      });
      await this.#recordResourceEvent({
        action: "resource.import.failed",
        space: req.space,
        resourceId: id,
        actor: req.actor,
        metadata: {
          generation: 1,
          phase: failurePersisted ? "Failed" : "Applying",
          ...(failurePersisted ? {} : { reason: "finalize_pending" }),
        },
      });
      return {
        ok: false,
        error: {
          code: "import_failed",
          message: failurePersisted
            ? errorMessage(error)
            : `resource ${id} import failed but its atomic failure record could not be finalized; retry recovery is required`,
        },
      };
    }

    const importedAt = this.#now();
    const readyRecord: ResourceShapeRecord = {
      ...applyingRecord,
      managedBy: req.managedBy ?? "import",
      phase: "Ready",
      observedGeneration: 1,
      outputs: result.outputs,
      execution: result.execution,
      conditions: [importedCondition(1, importedAt)],
      updatedAt: importedAt,
    };
    const importedLock: ResolutionLockRecord = {
      ...lockRecord,
      nativeResources: result.nativeResources,
      updatedAt: importedAt,
    };
    let persisted;
    try {
      persisted = await this.#stores.commitApply({
        readyRecord,
        finalLock: importedLock,
        expectedApplying: {
          generation: applyingRecord.generation,
          phase: "Applying",
          updatedAt: applyingRecord.updatedAt,
        },
      });
    } catch (error) {
      await this.#notifyLifecycle({
        type: "unknown",
        spaceId: req.space,
        resourceId: id,
        operation: "import",
      });
      await this.#recordResourceEvent({
        action: "resource.import.finalize_pending",
        space: req.space,
        resourceId: id,
        actor: req.actor,
        ...(result.runId ? { runId: result.runId } : {}),
        metadata: { generation: 1, phase: "Applying" },
      });
      return {
        ok: false,
        error: {
          code: "import_failed",
          message: `resource ${id} backend import succeeded but atomic finalization is pending; retry the same import request: ${errorMessage(error)}`,
        },
      };
    }
    if (persisted.status !== "committed") {
      return {
        ok: false,
        error: {
          code: "import_failed",
          message: `resource ${id} changed while backend import was running`,
        },
      };
    }
    await this.#notifyLifecycle({
      type: "ready",
      spaceId: req.space,
      resourceId: id,
    });
    await this.#recordResourceEvent({
      action: "resource.import.succeeded",
      space: req.space,
      resourceId: id,
      actor: req.actor,
      ...(result.runId ? { runId: result.runId } : {}),
      metadata: {
        generation: 1,
        observedGeneration: 1,
        phase: "Ready",
        nativeResourceCount: result.nativeResources.length,
      },
    });
    return {
      ok: true,
      value: {
        resource: this.#assemble(persisted.record, persisted.lock),
        import: {
          summary: result.summary,
          ...(result.runId ? { runId: result.runId } : {}),
        },
      },
    };
  }

  async get(
    space: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ServiceResult<ResourceObject>> {
    const id = formatResourceShapeId(space, kind, name);
    const record = await this.#stores.resources.get(id);
    if (!record) {
      return {
        ok: false,
        error: { code: "not_found", message: `resource ${id} not found` },
      };
    }
    const lock = await this.#stores.locks.get(id);
    return { ok: true, value: this.#assemble(record, lock) };
  }

  async list(space: SpaceId): Promise<readonly ResourceObject[]> {
    const records = await this.#stores.resources.listBySpace(space);
    const out: ResourceObject[] = [];
    for (const record of records) {
      const lock = await this.#stores.locks.get(record.id);
      out.push(this.#assemble(record, lock));
    }
    return out;
  }

  async listPage(
    space: SpaceId,
    params: PageParams,
  ): Promise<Page<ResourceObject>> {
    const page = await this.#stores.resources.listBySpacePage(space, params);
    const items: ResourceObject[] = [];
    for (const record of page.items) {
      const lock = await this.#stores.locks.get(record.id);
      items.push(this.#assemble(record, lock));
    }
    return {
      items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * Lists this Resource's durable audit history newest first. The rows remain
   * readable after the Resource ledger record is deleted because Activity is
   * the append-only evidence source; this method deliberately does not call
   * {@link get} or create a second Resource lifecycle authority.
   */
  async listEvents(
    space: SpaceId,
    kind: ResourceShapeKind,
    name: string,
    params: PageParams,
  ): Promise<Page<ResourceEvent>> {
    if (!this.#activity) return { items: [] };
    const resourceId = formatResourceShapeId(space, kind, name);
    const page = await this.#activity.listTargetPage(
      space,
      "resource",
      resourceId,
      params,
    );
    return {
      items: page.items.map((event) => ({
        id: event.id,
        space,
        resourceId,
        action: event.action,
        ...(event.actorId ? { actorId: event.actorId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        metadata: event.metadata,
        createdAt: event.createdAt,
      })),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * Runs a read-only backend observation against the exact Target and
   * implementation pinned by the Resource's ResolutionLock. The resulting
   * condition update is CAS-fenced so a slow observer cannot overwrite a
   * concurrent apply or delete.
   */
  async observe(
    space: SpaceId,
    kind: ResourceShapeKind,
    name: string,
    actor: ActorContext,
  ): Promise<ServiceResult<ObserveResourceResult>> {
    const id = formatResourceShapeId(space, kind, name);
    const record = await this.#stores.resources.get(id);
    if (!record) {
      return {
        ok: false,
        error: { code: "not_found", message: `resource ${id} not found` },
      };
    }
    if (
      record.phase !== "Ready" ||
      record.observedGeneration !== record.generation
    ) {
      return {
        ok: false,
        error: {
          code: "observe_blocked",
          message: `resource ${id} is ${record.phase} at generation ${record.generation}; observation requires a fully applied Ready generation`,
        },
      };
    }
    const lock = await this.#stores.locks.get(id);
    if (!lock) {
      return {
        ok: false,
        error: {
          code: "resolution_descriptor_missing",
          message: `resource ${id} has no durable ResolutionLock`,
        },
      };
    }
    const entry = await this.#targetPoolEntryForLock(space, lock);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "resolution_descriptor_missing",
          message: `resource ${id} no longer has a recoverable pinned Target`,
        },
      };
    }
    const implementation = this.#implementationDescriptorForLock(
      lock,
      entry,
      record.kind,
    );
    if (!implementation) {
      return {
        ok: false,
        error: {
          code: "resolution_descriptor_missing",
          message: `resource ${id} has no recoverable pinned implementation descriptor`,
        },
      };
    }
    const parsed = parseResourceSpec(
      record.kind,
      record.spec,
      this.#schemaRegistry,
    );
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          code: parsed.error.code as ResourceServiceErrorCode,
          message: parsed.error.message,
        },
      };
    }
    let plan: ResourceShapePlan;
    try {
      plan = planResourceShape(
        implementation,
        parsed.parsed,
        entry,
        this.#moduleRegistry,
      );
    } catch (error) {
      return {
        ok: false,
        error: { code: "capability_missing", message: errorMessage(error) },
      };
    }
    if (plan.requiresAdapterPlugin && !implementation.plugin) {
      return {
        ok: false,
        error: {
          code: "capability_missing",
          message: `resource ${id} requires its pinned adapter plugin for observation`,
        },
      };
    }
    const resolvedConnections = await this.#resolveConnections(
      space,
      id,
      parsed.parsed,
    );
    if (!resolvedConnections.ok) return resolvedConnections;

    const expected = {
      generation: record.generation,
      phase: record.phase,
      updatedAt: record.updatedAt,
    } as const;
    await this.#recordResourceEvent({
      action: "resource.observe.started",
      space,
      resourceId: id,
      actor,
      metadata: {
        generation: record.generation,
        observedGeneration: record.observedGeneration,
      },
    });
    let observation: AdapterObserveResult;
    try {
      observation = await this.#adapter.observe({
        resourceId: id,
        environment: record.environment ?? "default",
        stateGeneration:
          record.execution?.stateGeneration ??
          record.stateAdoption?.stateGeneration ??
          0,
        ...(record.stateAdoption
          ? { stateAdoption: record.stateAdoption }
          : {}),
        plan,
        target: entry,
        implementation,
        credentialRef: entry.credentialRef,
        nativeResources: lock.nativeResources ?? [],
        ...(Object.keys(resolvedConnections.value).length > 0
          ? { resolvedConnections: resolvedConnections.value }
          : {}),
        actor,
      });
    } catch (error) {
      const failedAt = this.#now();
      const failedRecord: ResourceShapeRecord = {
        ...record,
        conditions: observationFailedConditions(
          record.conditions,
          record.generation,
          failedAt,
          error,
        ),
        updatedAt: failedAt,
      };
      const persisted = await this.#stores.resources.compareAndSet(
        failedRecord,
        expected,
      );
      if (persisted.status === "conflict") {
        await this.#recordResourceEvent({
          action: "resource.observe.failed",
          space,
          resourceId: id,
          actor,
          metadata: {
            generation: record.generation,
            reason: "reconcile_conflict",
          },
        });
        return {
          ok: false,
          error: {
            code: "reconcile_conflict",
            message: `resource ${id} changed while backend observation was running`,
          },
        };
      }
      if (persisted.status === "not_found") {
        await this.#recordResourceEvent({
          action: "resource.observe.failed",
          space,
          resourceId: id,
          actor,
          metadata: { generation: record.generation, reason: "not_found" },
        });
        return {
          ok: false,
          error: { code: "not_found", message: `resource ${id} not found` },
        };
      }
      await this.#recordResourceEvent({
        action: "resource.observe.failed",
        space,
        resourceId: id,
        actor,
        metadata: { generation: record.generation, phase: record.phase },
      });
      return {
        ok: false,
        error: { code: "observe_failed", message: errorMessage(error) },
      };
    }

    const observedAt = this.#now();
    const observedRecord: ResourceShapeRecord = {
      ...record,
      conditions: observationConditions(
        record.conditions,
        record.generation,
        observedAt,
        observation.status,
        observation.summary,
      ),
      updatedAt: observedAt,
    };
    const persisted = await this.#stores.resources.compareAndSet(
      observedRecord,
      expected,
    );
    if (persisted.status === "not_found") {
      await this.#recordResourceEvent({
        action: "resource.observe.failed",
        space,
        resourceId: id,
        actor,
        ...(observation.runId ? { runId: observation.runId } : {}),
        metadata: { generation: record.generation, reason: "not_found" },
      });
      return {
        ok: false,
        error: { code: "not_found", message: `resource ${id} not found` },
      };
    }
    if (persisted.status === "conflict") {
      await this.#recordResourceEvent({
        action: "resource.observe.failed",
        space,
        resourceId: id,
        actor,
        ...(observation.runId ? { runId: observation.runId } : {}),
        metadata: {
          generation: record.generation,
          reason: "reconcile_conflict",
        },
      });
      return {
        ok: false,
        error: {
          code: "reconcile_conflict",
          message: `resource ${id} changed while backend observation was running`,
        },
      };
    }
    await this.#recordResourceEvent({
      action: "resource.observe.succeeded",
      space,
      resourceId: id,
      actor,
      ...(observation.runId ? { runId: observation.runId } : {}),
      metadata: {
        generation: record.generation,
        phase: persisted.record.phase,
        observationStatus: observation.status,
      },
    });
    return {
      ok: true,
      value: {
        resource: this.#assemble(persisted.record, lock),
        observation,
      },
    };
  }

  /**
   * Internal scheduler entrypoint for a durably claimed Resource. Keeping the
   * record-to-scope projection inside the Resource Shape domain prevents host
   * schedulers from inventing a separate ownership mapping.
   */
  observeClaimedResource(
    resource: ResourceShapeRecord,
    actor: ActorContext,
  ): Promise<ServiceResult<ObserveResourceResult>> {
    return this.observe(resource.spaceId, resource.kind, resource.name, actor);
  }

  /**
   * Publishes a new Resource-owned state/output revision from the exact pinned
   * backend without changing native provider resources. The adapter operation
   * is claimed with CAS before dispatch, and both success and failure are
   * fenced so a force tombstone or concurrent reconcile cannot be resurrected.
   */
  async refresh(
    space: SpaceId,
    kind: ResourceShapeKind,
    name: string,
    actor: ActorContext,
  ): Promise<ServiceResult<RefreshResourceResult>> {
    const id = formatResourceShapeId(space, kind, name);
    const record = await this.#stores.resources.get(id);
    if (!record) {
      return {
        ok: false,
        error: { code: "not_found", message: `resource ${id} not found` },
      };
    }
    if (
      (record.phase !== "Ready" && record.phase !== "Failed") ||
      record.observedGeneration !== record.generation
    ) {
      return {
        ok: false,
        error: {
          code: "refresh_blocked",
          message: `resource ${id} is ${record.phase} at generation ${record.generation}; refresh requires a previously applied generation`,
        },
      };
    }
    const lock = await this.#stores.locks.get(id);
    if (!lock) {
      return {
        ok: false,
        error: {
          code: "resolution_descriptor_missing",
          message: `resource ${id} has no durable ResolutionLock`,
        },
      };
    }
    const entry = await this.#targetPoolEntryForLock(space, lock);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "resolution_descriptor_missing",
          message: `resource ${id} no longer has a recoverable pinned Target`,
        },
      };
    }
    const implementation = this.#implementationDescriptorForLock(
      lock,
      entry,
      record.kind,
    );
    if (!implementation) {
      return {
        ok: false,
        error: {
          code: "resolution_descriptor_missing",
          message: `resource ${id} has no recoverable pinned implementation descriptor`,
        },
      };
    }
    const parsed = parseResourceSpec(
      record.kind,
      record.spec,
      this.#schemaRegistry,
    );
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          code: parsed.error.code as ResourceServiceErrorCode,
          message: parsed.error.message,
        },
      };
    }
    let plan: ResourceShapePlan;
    try {
      plan = planResourceShape(
        implementation,
        parsed.parsed,
        entry,
        this.#moduleRegistry,
      );
    } catch (error) {
      return {
        ok: false,
        error: { code: "capability_missing", message: errorMessage(error) },
      };
    }
    if (plan.requiresAdapterPlugin && !implementation.plugin) {
      return {
        ok: false,
        error: {
          code: "capability_missing",
          message: `resource ${id} requires its pinned adapter plugin for refresh`,
        },
      };
    }
    const resolvedConnections = await this.#resolveConnections(
      space,
      id,
      parsed.parsed,
    );
    if (!resolvedConnections.ok) return resolvedConnections;

    const claimAt = this.#now();
    const claimedRecord: ResourceShapeRecord = {
      ...record,
      phase: "Applying",
      conditions: refreshingConditions(
        record.conditions,
        record.generation,
        claimAt,
      ),
      updatedAt: claimAt,
    };
    const claim = await this.#stores.resources.compareAndSet(claimedRecord, {
      generation: record.generation,
      phase: record.phase,
      updatedAt: record.updatedAt,
    });
    if (claim.status === "not_found") {
      return {
        ok: false,
        error: { code: "not_found", message: `resource ${id} not found` },
      };
    }
    if (claim.status === "conflict") {
      return {
        ok: false,
        error: {
          code: "reconcile_conflict",
          message: `resource ${id} changed while refresh was being claimed`,
        },
      };
    }
    const claimed = claim.record;
    const claimVersion = {
      generation: claimed.generation,
      phase: claimed.phase,
      updatedAt: claimed.updatedAt,
    } as const;
    await this.#recordResourceEvent({
      action: "resource.refresh.started",
      space,
      resourceId: id,
      actor,
      metadata: {
        generation: record.generation,
        observedGeneration: record.observedGeneration,
        phase: "Applying",
      },
    });

    const failRefresh = async (
      error: unknown,
    ): Promise<ServiceResult<RefreshResourceResult>> => {
      const failedAt = this.#now();
      const failed = await this.#stores.resources.compareAndSet(
        {
          ...claimed,
          phase: "Failed",
          outputs: record.outputs,
          execution: record.execution,
          conditions: refreshFailedConditions(
            record.conditions,
            record.generation,
            failedAt,
            error,
          ),
          updatedAt: failedAt,
        },
        claimVersion,
      );
      await this.#recordResourceEvent({
        action: "resource.refresh.failed",
        space,
        resourceId: id,
        actor,
        metadata: {
          generation: record.generation,
          reason:
            failed.status === "updated" ? "adapter_failed" : failed.status,
          ...(failed.status === "updated" ? { phase: "Failed" } : {}),
        },
      });
      if (failed.status === "not_found") {
        return {
          ok: false,
          error: { code: "not_found", message: `resource ${id} not found` },
        };
      }
      if (failed.status === "conflict") {
        return {
          ok: false,
          error: {
            code: "reconcile_conflict",
            message: `resource ${id} changed while backend refresh was running`,
          },
        };
      }
      await this.#notifyLifecycle({
        type: "unknown",
        spaceId: space,
        resourceId: id,
        operation: "refresh",
      });
      return {
        ok: false,
        error: { code: "refresh_failed", message: errorMessage(error) },
      };
    };

    let result: AdapterRefreshResult;
    try {
      result = await this.#adapter.refresh({
        resourceId: id,
        environment: record.environment ?? "default",
        stateGeneration:
          record.execution?.stateGeneration ??
          record.stateAdoption?.stateGeneration ??
          0,
        ...(record.stateAdoption
          ? { stateAdoption: record.stateAdoption }
          : {}),
        plan,
        target: entry,
        implementation,
        credentialRef: entry.credentialRef,
        nativeResources: lock.nativeResources ?? [],
        ...(Object.keys(resolvedConnections.value).length > 0
          ? { resolvedConnections: resolvedConnections.value }
          : {}),
        actor,
      });
      if (record.stateAdoption && !result.execution) {
        throw new Error(
          `resource ${id} refresh succeeded without Resource-owned execution state; refusing to consume confirmed state adoption`,
        );
      }
    } catch (error) {
      return await failRefresh(error);
    }

    const refreshedAt = this.#now();
    const { stateAdoption: _consumedStateAdoption, ...refreshedBase } = claimed;
    const refreshedRecord: ResourceShapeRecord = {
      ...refreshedBase,
      phase: "Ready",
      outputs: result.outputs,
      execution: result.execution ?? record.execution,
      conditions: refreshedConditions(
        record.conditions,
        record.generation,
        refreshedAt,
      ),
      updatedAt: refreshedAt,
    };
    const persisted = await this.#stores.resources.compareAndSet(
      refreshedRecord,
      claimVersion,
    );
    if (persisted.status === "not_found") {
      await this.#recordResourceEvent({
        action: "resource.refresh.failed",
        space,
        resourceId: id,
        actor,
        ...(result.runId ? { runId: result.runId } : {}),
        metadata: { generation: record.generation, reason: "not_found" },
      });
      return {
        ok: false,
        error: { code: "not_found", message: `resource ${id} not found` },
      };
    }
    if (persisted.status === "conflict") {
      await this.#recordResourceEvent({
        action: "resource.refresh.failed",
        space,
        resourceId: id,
        actor,
        ...(result.runId ? { runId: result.runId } : {}),
        metadata: {
          generation: record.generation,
          reason: "reconcile_conflict",
        },
      });
      return {
        ok: false,
        error: {
          code: "reconcile_conflict",
          message: `resource ${id} changed while backend refresh was running`,
        },
      };
    }
    const refreshedLock: ResolutionLockRecord = {
      ...lock,
      nativeResources: result.nativeResources,
      updatedAt: refreshedAt,
    };
    try {
      await this.#stores.locks.put(refreshedLock);
    } catch (error) {
      const failedAt = this.#now();
      await this.#stores.resources.compareAndSet(
        {
          ...persisted.record,
          phase: "Failed",
          conditions: refreshFailedConditions(
            persisted.record.conditions,
            persisted.record.generation,
            failedAt,
            error,
          ),
          updatedAt: failedAt,
        },
        {
          generation: persisted.record.generation,
          phase: persisted.record.phase,
          updatedAt: persisted.record.updatedAt,
        },
      );
      await this.#notifyLifecycle({
        type: "unknown",
        spaceId: space,
        resourceId: id,
        operation: "refresh",
      });
      await this.#recordResourceEvent({
        action: "resource.refresh.failed",
        space,
        resourceId: id,
        actor,
        ...(result.runId ? { runId: result.runId } : {}),
        metadata: {
          generation: record.generation,
          phase: "Failed",
          reason: "resolution_lock_persist_failed",
        },
      });
      return {
        ok: false,
        error: { code: "refresh_failed", message: errorMessage(error) },
      };
    }
    await this.#notifyLifecycle({
      type: "ready",
      spaceId: space,
      resourceId: id,
    });
    await this.#recordResourceEvent({
      action: "resource.refresh.succeeded",
      space,
      resourceId: id,
      actor,
      ...(result.runId ? { runId: result.runId } : {}),
      metadata: {
        generation: persisted.record.generation,
        observedGeneration: persisted.record.observedGeneration,
        phase: persisted.record.phase,
        nativeResourceCount: result.nativeResources.length,
      },
    });
    return {
      ok: true,
      value: {
        resource: this.#assemble(persisted.record, refreshedLock),
        refresh: {
          summary: result.summary,
          ...(result.runId ? { runId: result.runId } : {}),
        },
      },
    };
  }

  async delete(
    space: SpaceId,
    kind: ResourceShapeKind,
    name: string,
    actor: ActorContext,
    options: DeleteResourceOptions = {},
  ): Promise<ServiceResult<void>> {
    const id = formatResourceShapeId(space, kind, name);
    const record = await this.#stores.resources.get(id);
    if (!record) {
      return {
        ok: false,
        error: { code: "not_found", message: `resource ${id} not found` },
      };
    }
    if (options.force) {
      const lock = await this.#stores.locks.get(id);
      await this.#recordResourceEvent({
        action: "resource.delete.started",
        space,
        resourceId: id,
        actor,
        metadata: { generation: record.generation, forced: true },
      });
      await this.#notifyLifecycle({
        type: "terminating",
        spaceId: space,
        resourceId: id,
      });
      let removed;
      try {
        removed = await this.#stores.removeResource({
          resourceId: id,
          expected: versionOf(record),
          expectedLock: lock ?? null,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "delete_failed",
            message: `resource ${id} force tombstone could not be finalized atomically: ${errorMessage(error)}`,
          },
        };
      }
      if (removed.status === "conflict") {
        return {
          ok: false,
          error: {
            code: "reconcile_conflict",
            message: `resource ${id} changed while force tombstone was being finalized`,
          },
        };
      }
      await this.#notifyLifecycle({
        type: "retired",
        spaceId: space,
        resourceId: id,
      });
      await this.#recordResourceEvent({
        action: "resource.delete.succeeded",
        space,
        resourceId: id,
        actor,
        metadata: { generation: record.generation, forced: true },
      });
      return { ok: true, value: undefined };
    }
    if (record.phase === "Applying") {
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} is currently applying or refreshing`,
        },
      };
    }
    if (
      record.phase === "Failed" &&
      record.managedBy === "import-pending" &&
      record.observedGeneration === 0
    ) {
      const lock = await this.#stores.locks.get(id);
      await this.#recordResourceEvent({
        action: "resource.delete.started",
        space,
        resourceId: id,
        actor,
        metadata: {
          generation: record.generation,
          backendCleanup: false,
          importPending: true,
        },
      });
      await this.#notifyLifecycle({
        type: "terminating",
        spaceId: space,
        resourceId: id,
      });
      let removed;
      try {
        removed = await this.#stores.removeResource({
          resourceId: id,
          expected: versionOf(record),
          expectedLock: lock ?? null,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "delete_failed",
            message: `resource ${id} failed-import cleanup could not be finalized atomically: ${errorMessage(error)}`,
          },
        };
      }
      if (removed.status === "conflict") {
        return {
          ok: false,
          error: {
            code: "reconcile_conflict",
            message: `resource ${id} changed while failed-import cleanup was being finalized`,
          },
        };
      }
      await this.#notifyLifecycle({
        type: "retired",
        spaceId: space,
        resourceId: id,
      });
      await this.#recordResourceEvent({
        action: "resource.delete.succeeded",
        space,
        resourceId: id,
        actor,
        metadata: {
          generation: record.generation,
          backendCleanup: false,
          importPending: true,
        },
      });
      return { ok: true, value: undefined };
    }
    const consumer = await this.#firstConnectionConsumer(space, id);
    if (consumer) {
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} is still referenced by ${consumer.id}`,
        },
      };
    }
    const lock = await this.#stores.locks.get(id);
    if (!lock) {
      if (!(await this.#stores.resources.get(id))) {
        return { ok: true, value: undefined };
      }
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} has no durable ResolutionLock, so backend identity is unknown; use an explicitly authorized force delete to tombstone only the ledger`,
        },
      };
    }
    const entry = await this.#targetPoolEntryForLock(space, lock);
    if (!entry) {
      if (!(await this.#stores.resources.get(id))) {
        return { ok: true, value: undefined };
      }
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} no longer has a recoverable pinned Target; backend and ledger deletion are blocked until the Target is restored or an explicitly authorized force delete tombstones only the ledger`,
        },
      };
    }
    const specResult = parseResourceSpec(
      record.kind,
      record.spec,
      this.#schemaRegistry,
    );
    const deletePolicy = specResult.ok
      ? specResult.parsed.lifecyclePolicy?.delete
      : undefined;
    if (!specResult.ok) {
      return {
        ok: false,
        error: {
          code: specResult.error.code as ResourceServiceErrorCode,
          message: specResult.error.message,
        },
      };
    }
    if (deletePolicy === "block") {
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} has lifecyclePolicy.delete=block and requires an explicit policy change before deletion`,
        },
      };
    }
    const implementation = this.#implementationDescriptorForLock(
      lock,
      entry,
      record.kind,
    );
    if (!implementation) {
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} has no recoverable implementation descriptor snapshot; restore the historical Target descriptor or use an explicitly authorized force tombstone`,
        },
      };
    }
    let deletePlan: ResourceShapePlan;
    try {
      deletePlan = planResourceShape(
        implementation,
        specResult.parsed,
        entry,
        this.#moduleRegistry,
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} cannot reconstruct its pinned delete plan: ${errorMessage(error)}`,
        },
      };
    }
    if (deletePlan.requiresAdapterPlugin && !implementation.plugin) {
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} requires its pinned adapter plugin before backend deletion; restore the plugin or use an explicitly authorized force tombstone`,
        },
      };
    }

    let claimedRecord = record;
    if (record.phase !== "Deleting") {
      const deleteClaim = await this.#stores.resources.claimDelete(
        {
          ...record,
          phase: "Deleting",
          conditions: [deletingCondition(record.generation, this.#now())],
          updatedAt: this.#now(),
        },
        record.generation,
      );
      if (deleteClaim.status === "already_deleting") {
        claimedRecord = deleteClaim.record;
      }
      if (deleteClaim.status === "not_found") {
        return {
          ok: false,
          error: { code: "not_found", message: `resource ${id} not found` },
        };
      }
      if (deleteClaim.status === "conflict") {
        return {
          ok: false,
          error: {
            code: "delete_blocked",
            message: `resource ${id} changed while delete was being claimed`,
          },
        };
      }
      if (deleteClaim.status === "claimed") {
        claimedRecord = deleteClaim.record;
      }
    }

    await this.#recordResourceEvent({
      action: "resource.delete.started",
      space,
      resourceId: id,
      actor,
      metadata: {
        generation: claimedRecord.generation,
        phase: "Deleting",
        forced: false,
      },
    });
    await this.#notifyLifecycle({
      type: "terminating",
      spaceId: space,
      resourceId: id,
    });
    try {
      await withTimeout(
        this.#adapter.delete({
          resourceId: id,
          environment: claimedRecord.environment ?? "default",
          stateGeneration:
            claimedRecord.execution?.stateGeneration ??
            claimedRecord.stateAdoption?.stateGeneration ??
            0,
          ...(claimedRecord.stateAdoption
            ? { stateAdoption: claimedRecord.stateAdoption }
            : {}),
          plan: deletePlan,
          nativeResources: lock.nativeResources ?? [],
          target: entry,
          implementation,
          credentialRef: entry.credentialRef,
          deletePolicy,
          actor,
        }),
        this.#deleteTimeoutMs,
        `delete ${id}`,
      );
    } catch (error) {
      const failedAt = this.#now();
      const failed = await this.#stores.resources.compareAndSet(
        {
          ...claimedRecord,
          phase: "Failed",
          conditions: [
            deleteFailedCondition(claimedRecord.generation, failedAt, error),
          ],
          updatedAt: failedAt,
        },
        versionOf(claimedRecord),
      );
      if (failed.status === "not_found") {
        // A concurrent idempotent delete finalized the same canonical Resource.
        return { ok: true, value: undefined };
      }
      if (failed.status === "conflict") {
        await this.#recordResourceEvent({
          action: "resource.delete.failed",
          space,
          resourceId: id,
          actor,
          metadata: {
            generation: claimedRecord.generation,
            reason: "reconcile_conflict",
            forced: false,
          },
        });
        return {
          ok: false,
          error: {
            code: "reconcile_conflict",
            message: `resource ${id} changed while backend deletion was running`,
          },
        };
      }
      await this.#notifyLifecycle({
        type: "unknown",
        spaceId: space,
        resourceId: id,
        operation: "delete",
      });
      await this.#recordResourceEvent({
        action: "resource.delete.failed",
        space,
        resourceId: id,
        actor,
        metadata: {
          generation: claimedRecord.generation,
          phase: "Failed",
          forced: false,
        },
      });
      return {
        ok: false,
        error: { code: "delete_failed", message: errorMessage(error) },
      };
    }

    let removed;
    try {
      removed = await this.#stores.removeResource({
        resourceId: id,
        expected: versionOf(claimedRecord),
        expectedLock: lock,
      });
    } catch (error) {
      await this.#notifyLifecycle({
        type: "unknown",
        spaceId: space,
        resourceId: id,
        operation: "delete",
      });
      await this.#recordResourceEvent({
        action: "resource.delete.failed",
        space,
        resourceId: id,
        actor,
        metadata: {
          generation: claimedRecord.generation,
          phase: "Deleting",
          reason: "finalize_pending",
          forced: false,
        },
      });
      return {
        ok: false,
        error: {
          code: "delete_failed",
          message: `resource ${id} backend deletion succeeded but atomic finalization is pending; retry delete: ${errorMessage(error)}`,
        },
      };
    }
    if (removed.status === "conflict") {
      await this.#notifyLifecycle({
        type: "unknown",
        spaceId: space,
        resourceId: id,
        operation: "delete",
      });
      return {
        ok: false,
        error: {
          code: "reconcile_conflict",
          message: `resource ${id} changed while backend deletion was being finalized`,
        },
      };
    }
    await this.#notifyLifecycle({
      type: "retired",
      spaceId: space,
      resourceId: id,
    });
    await this.#recordResourceEvent({
      action: "resource.delete.succeeded",
      space,
      resourceId: id,
      actor,
      metadata: {
        generation: claimedRecord.generation,
        backendCleanup: true,
        forced: false,
      },
    });
    return { ok: true, value: undefined };
  }

  // --- internals --------------------------------------------------------------

  async #recordResourceEvent(input: {
    readonly action: string;
    readonly space: SpaceId;
    readonly resourceId: string;
    readonly actor: ActorContext;
    readonly runId?: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    if (!this.#activity) return;
    try {
      await this.#activity.record({
        workspaceId: input.space,
        actorId: input.actor.actorAccountId,
        action: input.action,
        targetType: "resource",
        targetId: input.resourceId,
        ...(input.runId ? { runId: input.runId } : {}),
        metadata: { ...input.metadata },
      });
    } catch (error) {
      // ActivityService already swallows persistence failures, but keep the
      // Resource outcome isolated when a custom host ledger implements the
      // same seam incorrectly.
      log.warn("service.resource_shape.activity_record_failed", {
        action: input.action,
        spaceId: input.space,
        resourceId: input.resourceId,
        error,
      });
    }
  }

  async #notifyLifecycle(event: ResourceShapeLifecycleEvent): Promise<void> {
    if (!this.#lifecycleObserver) return;
    try {
      await this.#lifecycleObserver.observe(event);
    } catch (error) {
      // Resource state is already durable at this point. An Interface observer
      // failure must not rewrite a successful backend apply/delete outcome.
      // The event is safe to replay; a durable outbox/repair loop is tracked as
      // separate reconciler work.
      log.warn("service.resource_shape.lifecycle_observer_failed", {
        lifecycleType: event.type,
        spaceId: event.spaceId,
        resourceId: event.resourceId,
        error,
      });
    }
  }

  async #resolveAndPlan(
    req: ApplyResourceRequest,
    existingLock: ResolutionLockRecord | undefined,
  ): Promise<
    ServiceResult<{
      readonly resource: ResourceObject;
      readonly output: ResolverOutput;
      readonly plan: ResourceShapePlan;
      readonly entry: TargetPoolEntry;
      readonly parsed: ParsedResourceSpec;
    }>
  > {
    const specResult = parseResourceSpec(
      req.kind,
      req.spec,
      this.#schemaRegistry,
    );
    if (!specResult.ok) {
      return {
        ok: false,
        error: {
          code: specResult.error.code as ResourceServiceErrorCode,
          message: specResult.error.message,
        },
      };
    }
    const parsed = specResult.parsed;

    const targetPoolName =
      existingLock?.targetPool ?? req.targetPoolName ?? DEFAULT_POOL_NAME;
    const poolRecord = await this.#stores.targetPools.getByName(
      req.space,
      targetPoolName,
    );
    if (!poolRecord) {
      return {
        ok: false,
        error: {
          code: "target_pool_not_found",
          message:
            `target pool ${targetPoolName} not found ` +
            `in space ${req.space}`,
        },
      };
    }
    const policyRecord = await this.#stores.spacePolicies.getByName(
      req.space,
      req.spacePolicyName ?? DEFAULT_POOL_NAME,
    );

    const resource = this.#buildResourceObject(req);
    const targetPool = toTargetPool(poolRecord);
    const spacePolicy = policyRecord ? toSpacePolicy(policyRecord) : undefined;

    const outcome = resolve({
      resource,
      interfaces: parsed.interfaces,
      targetPool,
      spacePolicy,
      existingLock: existingLock
        ? {
            resourceId: existingLock.resourceId,
            selectedImplementation: existingLock.selectedImplementation,
            targetPool: existingLock.targetPool,
            target: existingLock.target,
            targetSnapshot: existingLock.targetSnapshot,
            implementationSnapshot: existingLock.implementationSnapshot,
            implementationFingerprint: existingLock.implementationFingerprint,
            locked: existingLock.locked,
            reason: existingLock.reason,
            portability: existingLock.portability,
            nativeResources: existingLock.nativeResources,
            lockedAt: existingLock.lockedAt,
          }
        : undefined,
    });
    if (!outcome.ok) {
      return {
        ok: false,
        error: {
          code: outcome.error.code as ResourceServiceErrorCode,
          message: outcome.error.message,
        },
      };
    }
    const output = outcome.output;

    const entry =
      output.resolutionLock.targetSnapshot ??
      targetPool.spec.targets.find((t) => t.name === output.selectedTarget);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "selected_target_missing",
          message: `resolver selected target ${output.selectedTarget} not in pool`,
        },
      };
    }

    let plan: ResourceShapePlan;
    try {
      plan = planResourceShape(
        output.selectedImplementationDescriptor,
        parsed,
        entry,
        this.#moduleRegistry,
      );
    } catch (error) {
      return {
        ok: false,
        error: { code: "capability_missing", message: errorMessage(error) },
      };
    }
    if (
      plan.requiresAdapterPlugin &&
      !output.selectedImplementationDescriptor.plugin
    ) {
      return {
        ok: false,
        error: {
          code: "capability_missing",
          message:
            `${req.kind} implementation ${output.selectedImplementation} ` +
            "requires an installed adapter plugin; its planner module does not materialize a backend resource",
        },
      };
    }

    return { ok: true, value: { resource, output, plan, entry, parsed } };
  }

  async #resolveConnections(
    space: SpaceId,
    consumerResourceId: string,
    parsed: ParsedResourceSpec,
  ): Promise<
    ServiceResult<Readonly<Record<string, ResolvedResourceConnection>>>
  > {
    const connections = connectionsForParsedResource(parsed);
    if (!connections) return { ok: true, value: {} };

    const resourcesById = new Map(
      (await this.#stores.resources.listBySpace(space)).map((resource) => [
        resource.id,
        resource,
      ]),
    );
    const resolved: Record<string, ResolvedResourceConnection> = {};
    for (const name of Object.keys(connections).sort()) {
      const connection = connections[name]!;
      if (connection.resource === consumerResourceId) {
        return {
          ok: false,
          error: {
            code: "invalid_connections",
            message: `spec.connections.${name}.resource cannot reference the consumer itself`,
          },
        };
      }
      const resource = resourcesById.get(connection.resource);
      // Do not reveal whether a resource id belongs to another Space.
      if (!resource) {
        return {
          ok: false,
          error: {
            code: "connection_not_found",
            message: `spec.connections.${name}.resource was not found in space ${space}`,
          },
        };
      }
      if (
        this.#connectionPathReaches(
          resource.id,
          consumerResourceId,
          resourcesById,
          new Set(),
        )
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_connections",
            message: `spec.connections.${name}.resource creates a dependency cycle`,
          },
        };
      }
      const lock = await this.#stores.locks.get(resource.id);
      if (
        resource.phase !== "Ready" ||
        resource.observedGeneration !== resource.generation ||
        !lock
      ) {
        return {
          ok: false,
          error: {
            code: "connection_not_ready",
            message: `spec.connections.${name}.resource is not Ready`,
          },
        };
      }
      resolved[name] = {
        resourceId: resource.id,
        kind: resource.kind,
        permissions: connection.permissions,
        projection: connection.projection,
        target: lock.target,
        nativeResources: lock.nativeResources ?? [],
        outputs: resource.outputs ?? {},
      };
    }
    return { ok: true, value: resolved };
  }

  #connectionPathReaches(
    currentId: string,
    targetId: string,
    resourcesById: ReadonlyMap<string, ResourceShapeRecord>,
    visited: Set<string>,
  ): boolean {
    if (currentId === targetId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);

    const current = resourcesById.get(currentId);
    if (!current) return false;
    const parsed = parseResourceSpec(
      current.kind,
      current.spec,
      this.#schemaRegistry,
    );
    if (!parsed.ok) return false;
    const connections = connectionsForParsedResource(parsed.parsed);
    if (!connections) return false;
    return Object.values(connections).some((connection) =>
      this.#connectionPathReaches(
        connection.resource,
        targetId,
        resourcesById,
        visited,
      ),
    );
  }

  async #firstConnectionConsumer(
    space: SpaceId,
    resourceId: string,
  ): Promise<ResourceShapeRecord | undefined> {
    const resources = await this.#stores.resources.listBySpace(space);
    for (const candidate of resources) {
      if (candidate.id === resourceId) continue;
      const parsed = parseResourceSpec(
        candidate.kind,
        candidate.spec,
        this.#schemaRegistry,
      );
      if (!parsed.ok) continue;
      const connections = connectionsForParsedResource(parsed.parsed);
      if (
        connections &&
        Object.values(connections).some(
          (connection) => connection.resource === resourceId,
        )
      ) {
        return candidate;
      }
    }
    return undefined;
  }

  async #targetPoolReference(
    pool: TargetPoolRecord,
  ): Promise<ResolutionLockRecord | undefined> {
    const targetNames = new Set(
      targetPoolSpecOf(pool).targets.map((target) => target.name),
    );
    const resources = await this.#stores.resources.listBySpace(pool.spaceId);
    for (const resource of resources) {
      const lock = await this.#stores.locks.get(resource.id);
      if (!lock) continue;
      if (lock.targetPool === pool.name) return lock;
      // Legacy locks predate targetPool persistence. Conservatively protect
      // every pool that could have supplied the recorded target.
      if (!lock.targetPool && targetNames.has(lock.target)) return lock;
    }
    return undefined;
  }

  #buildResourceObject(req: ApplyResourceRequest): ResourceObject {
    return {
      apiVersion: TAKOSUMI_API_VERSION,
      kind: req.kind,
      metadata: {
        name: req.name,
        space: req.space,
        project: req.project,
        environment: req.environment,
        owner: req.actor.actorAccountId,
        labels: req.labels,
        managedBy: req.managedBy ?? "opentofu",
      },
      spec: req.spec,
    };
  }

  #assemble(
    record: ResourceShapeRecord,
    lock: ResolutionLockRecord | undefined,
  ): ResourceObject {
    const status: ResourceStatus = {
      phase: record.phase,
      observedGeneration: record.observedGeneration,
      resolution: lock
        ? {
            selectedImplementation: lock.selectedImplementation,
            target: lock.target,
            locked: lock.locked,
            portability: lock.portability ?? "partial",
          }
        : undefined,
      outputs: record.outputs,
      conditions: record.conditions,
    };
    return {
      apiVersion: TAKOSUMI_API_VERSION,
      kind: record.kind,
      metadata: {
        name: record.name,
        space: record.spaceId,
        project: record.project,
        environment: record.environment,
        labels: record.labels,
        managedBy: record.managedBy,
      },
      spec: record.spec,
      status,
    };
  }

  async #targetPoolEntryForLock(
    space: SpaceId,
    lock: ResolutionLockRecord,
  ): Promise<TargetPoolEntry | undefined> {
    if (lock.targetSnapshot) return cloneTargetPoolEntry(lock.targetSnapshot);

    if (lock.targetPool) {
      const pool = await this.#stores.targetPools.getByName(
        space,
        lock.targetPool,
      );
      return pool
        ? targetPoolSpecOf(pool).targets.find(
            (target) => target.name === lock.target,
          )
        : undefined;
    }

    // Compatibility only for legacy locks. Ambiguous same-name targets are
    // treated as unknown rather than guessing a backend identity.
    const pools = await this.#stores.targetPools.listBySpace(space);
    const matches: TargetPoolEntry[] = [];
    for (const pool of pools) {
      const entry = targetPoolSpecOf(pool).targets.find(
        (target) => target.name === lock.target,
      );
      if (entry) matches.push(entry);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  #implementationDescriptorForLock(
    lock: ResolutionLockRecord,
    entry: TargetPoolEntry,
    kind: ResourceShapeKind,
  ): TargetImplementationDescriptor | undefined {
    if (lock.implementationSnapshot) {
      return cloneImplementationDescriptor(lock.implementationSnapshot);
    }
    // Historical read normalization only. Recover from explicit descriptor
    // data in the pinned Target snapshot before consulting the same resolved
    // current Target. Never derive execution data from type/vendor names.
    const snapshotted = lock.targetSnapshot?.implementations?.find(
      (candidate) =>
        candidate.shape === kind &&
        candidate.implementation === lock.selectedImplementation,
    );
    if (snapshotted) return cloneImplementationDescriptor(snapshotted);
    const current = entry.implementations?.find(
      (candidate) =>
        candidate.shape === kind &&
        candidate.implementation === lock.selectedImplementation,
    );
    return current ? cloneImplementationDescriptor(current) : undefined;
  }
}

// --- helpers (module-level, pure) ---------------------------------------------

function versionOf(record: ResourceShapeRecord): {
  readonly generation: number;
  readonly phase: ResourceShapeRecord["phase"];
  readonly updatedAt: string;
} {
  return {
    generation: record.generation,
    phase: record.phase,
    updatedAt: record.updatedAt,
  };
}

async function rollbackUnstartedApplyClaim(
  stores: ResourceShapeStores,
  claimed: ResourceShapeRecord,
  plannedLock: ResolutionLockRecord,
  previous: ResourceShapeRecord | undefined,
  previousLock: ResolutionLockRecord | undefined,
): Promise<boolean> {
  try {
    const restored = await stores.abortApply({
      resourceId: claimed.id,
      expectedApplying: {
        generation: claimed.generation,
        phase: "Applying",
        updatedAt: claimed.updatedAt,
      },
      expectedPlannedLock: plannedLock,
      replacement: previous
        ? { record: previous, lock: previousLock ?? null }
        : null,
    });
    return restored.status === "rolled_back";
  } catch (error) {
    log.warn("service.resource_shape.apply_claim_rollback_failed", {
      resourceId: claimed.id,
      error,
    });
    return false;
  }
}

function applyClaimRollbackPending(
  resourceId: string,
): ServiceResult<ResourceObject> {
  return {
    ok: false,
    error: {
      code: "deployment_finalize_pending",
      message: `resource ${resourceId} admission failed but its Applying claim could not be rolled back; host recovery is required`,
    },
  };
}

function nextApplyClaimTimestamp(now: string, previous?: string): IsoTimestamp {
  if (!previous) return now as IsoTimestamp;
  const nowMs = Date.parse(now);
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(nowMs) || !Number.isFinite(previousMs)) {
    return now as IsoTimestamp;
  }
  return new Date(
    Math.max(nowMs, previousMs + 1),
  ).toISOString() as IsoTimestamp;
}

function applyingRequestMatchesRecord(
  request: ApplyResourceRequest,
  record: ResourceShapeRecord,
): boolean {
  return (
    request.space === record.spaceId &&
    request.kind === record.kind &&
    request.name === record.name &&
    (request.project ?? null) === (record.project ?? null) &&
    (request.environment ?? null) === (record.environment ?? null) &&
    (request.managedBy ?? "opentofu") === record.managedBy &&
    canonicalJson(request.spec) === canonicalJson(record.spec) &&
    canonicalJson(request.labels ?? record.labels ?? null) ===
      canonicalJson(record.labels ?? null)
  );
}

async function resourceImportRequestDigest(
  request: ImportResourceRequest,
): Promise<string> {
  return await canonicalSha256({
    apiVersion: "takosumi.resource-import-request/v1",
    desired: {
      space: request.space,
      project: request.project ?? null,
      environment: request.environment ?? null,
      kind: request.kind,
      name: request.name,
      spec: request.spec,
      managedBy: request.managedBy ?? "import",
      labels: request.labels ?? null,
      targetPoolName: request.targetPoolName ?? null,
      spacePolicyName: request.spacePolicyName ?? null,
    },
    // The digest is the only recovery marker stored in the Resource condition;
    // the provider-native identity itself never enters status or audit events.
    nativeId: request.nativeId,
  });
}

function importRequestMatchesApplying(
  request: ImportResourceRequest,
  record: ResourceShapeRecord,
  requestDigest: string,
): boolean {
  const marker = record.conditions?.find(
    (condition) =>
      condition.type === "Ready" && condition.reason === "Importing",
  );
  return (
    record.phase === "Applying" &&
    record.managedBy === "import-pending" &&
    record.generation === 1 &&
    record.observedGeneration === 0 &&
    request.space === record.spaceId &&
    request.kind === record.kind &&
    request.name === record.name &&
    (request.project ?? null) === (record.project ?? null) &&
    (request.environment ?? null) === (record.environment ?? null) &&
    canonicalJson(request.spec) === canonicalJson(record.spec) &&
    canonicalJson(request.labels ?? null) ===
      canonicalJson(record.labels ?? null) &&
    marker?.message === `import-request:${requestDigest}`
  );
}

function toTargetPool(record: TargetPoolRecord): TargetPool {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "TargetPool",
    metadata: { name: record.name, space: record.spaceId },
    spec: targetPoolSpecOf(record),
  };
}

function targetPoolSpecOf(record: TargetPoolRecord): TargetPoolSpec {
  return record.spec as unknown as TargetPoolSpec;
}

function cloneTargetPoolEntry(entry: TargetPoolEntry): TargetPoolEntry {
  return JSON.parse(JSON.stringify(entry)) as TargetPoolEntry;
}

function cloneImplementationDescriptor(
  descriptor: TargetImplementationDescriptor,
): TargetImplementationDescriptor {
  return JSON.parse(
    JSON.stringify(descriptor),
  ) as TargetImplementationDescriptor;
}

interface ResourceDeploymentEvidence {
  readonly planDigest: string;
  readonly specDigest: string;
  readonly resolutionFingerprint: string;
}

async function resourceDeploymentEvidence(
  request: ApplyResourceRequest,
  output: ResolverOutput,
  plan: ResourceShapePlan,
): Promise<ResourceDeploymentEvidence> {
  // ResolutionLock may retain a host-defined, human-readable implementation
  // fingerprint. Deploy review and commercial quote evidence must expose one
  // fixed digest shape regardless of how that internal identifier was formed.
  const resolutionFingerprint = await canonicalSha256({
    apiVersion: "takosumi.resource-resolution/v1",
    shape: request.kind,
    targetPool: output.resolutionLock.targetPool,
    target: output.selectedTarget,
    targetSnapshot: output.resolutionLock.targetSnapshot,
    implementation: output.selectedImplementation,
    implementationSnapshot: output.resolutionLock.implementationSnapshot,
    implementationFingerprint:
      output.resolutionLock.implementationFingerprint ?? null,
    portability: output.portability,
  });
  const specDigest = await canonicalSha256({
    apiVersion: "takosumi.resource-spec/v1",
    space: request.space,
    kind: request.kind,
    name: request.name,
    spec: request.spec,
  });
  const planDigest = await canonicalSha256({
    apiVersion: "takosumi.resource-deploy-plan/v1",
    desired: {
      space: request.space,
      project: request.project,
      environment: request.environment,
      kind: request.kind,
      name: request.name,
      spec: request.spec,
      labels: request.labels,
    },
    resolution: {
      targetPool: output.resolutionLock.targetPool,
      target: output.selectedTarget,
      targetSnapshot: output.resolutionLock.targetSnapshot,
      implementation: output.selectedImplementation,
      implementationSnapshot: output.selectedImplementationDescriptor,
      implementationFingerprint: resolutionFingerprint,
      portability: output.portability,
    },
    nativeResourcePlan: output.nativeResourcePlan,
    adapterPlan: plan,
  });
  return { planDigest, specDigest, resolutionFingerprint };
}

function resourceDeploymentQuoteContext(
  request: ApplyResourceRequest,
  output: ResolverOutput,
  evidence: ResourceDeploymentEvidence,
  now: string,
): ResourceDeploymentQuoteContext {
  return {
    space: request.space,
    resourceId: formatResourceShapeId(
      request.space,
      request.kind,
      request.name,
    ),
    kind: request.kind,
    name: request.name,
    spec: request.spec,
    selectedImplementation: output.selectedImplementation,
    selectedTarget: output.selectedTarget,
    resolutionFingerprint: evidence.resolutionFingerprint,
    nativeResourcePlan: output.nativeResourcePlan,
    planDigest: evidence.planDigest,
    specDigest: evidence.specDigest,
    actor: request.actor,
    now,
  };
}

function deploymentReviewError(
  review: ResourceDeploymentReview,
  expectedPlanDigest: string,
): string | undefined {
  if (!SHA256_DIGEST_PATTERN.test(review.planDigest)) {
    return "deployment review planDigest must be a SHA-256 digest";
  }
  if (review.planDigest !== expectedPlanDigest) {
    return "deployment changed after preview; preview the current service definition again";
  }
  if (Boolean(review.quoteId) !== Boolean(review.quoteDigest)) {
    return "deployment review must provide quoteId and quoteDigest together";
  }
  if (review.quoteDigest && !SHA256_DIGEST_PATTERN.test(review.quoteDigest)) {
    return "deployment review quoteDigest must be a SHA-256 digest";
  }
  return undefined;
}

function deploymentQuoteError(
  quote: ResourceDeploymentQuote,
  context: ResourceDeploymentQuoteContext,
): string | undefined {
  if (!quote.quoteId.trim()) return "deployment quoteId is required";
  if (!SHA256_DIGEST_PATTERN.test(quote.quoteDigest)) {
    return "deployment quoteDigest must be a SHA-256 digest";
  }
  if (
    quote.planDigest !== context.planDigest ||
    quote.specDigest !== context.specDigest ||
    quote.resolutionFingerprint !== context.resolutionFingerprint
  ) {
    return "deployment quote does not match the resolved deployment plan";
  }
  if (!/^[A-Z]{3}$/u.test(quote.currency)) {
    return "deployment quote currency must be an ISO 4217 code";
  }
  if (
    !Number.isSafeInteger(quote.estimatedTotalUsdMicros) ||
    quote.estimatedTotalUsdMicros < 0
  ) {
    return "deployment quote total must be non-negative USD micros";
  }
  if (quote.ratingStatus === "unrated" && quote.estimatedTotalUsdMicros !== 0) {
    return "an unrated deployment quote must have zero USD amount";
  }
  if (quote.ratingStatus === "rated") {
    if (
      !quote.catalogId ||
      !quote.catalogVersion ||
      !quote.offeringId ||
      !quote.offeringVersion
    ) {
      return "a rated deployment quote requires catalog and offering identity";
    }
  } else if (quote.ratingStatus !== "unrated") {
    return "deployment quote ratingStatus must be rated or unrated";
  }
  const expiresAt = Date.parse(quote.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(context.now)) {
    return "deployment quote is expired or has an invalid expiry";
  }
  let total = 0;
  for (const item of quote.lineItems) {
    if (
      !item.sku.trim() ||
      !item.skuVersion.trim() ||
      !item.unit.trim() ||
      !Number.isFinite(item.quantity) ||
      item.quantity < 0 ||
      !Number.isSafeInteger(item.unitPriceUsdMicros) ||
      item.unitPriceUsdMicros < 0 ||
      !Number.isSafeInteger(item.amountUsdMicros) ||
      item.amountUsdMicros < 0
    ) {
      return "deployment quote contains an invalid line item";
    }
    total += item.amountUsdMicros;
    if (!Number.isSafeInteger(total)) {
      return "deployment quote line total exceeds the safe USD micros range";
    }
  }
  if (total !== quote.estimatedTotalUsdMicros) {
    return "deployment quote line items do not equal the estimated total";
  }
  return undefined;
}

async function canonicalSha256(value: unknown): Promise<string> {
  return `sha256:${await sha256HexOfStringAsync(canonicalJson(value))}`;
}

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

const CAPABILITY_LEVELS = new Set([
  "native",
  "shim",
  "emulated",
  "unsupported",
]);
function validateTargetPoolSpec(
  name: string,
  spec: unknown,
  allowedProviderConfigUrls: ReadonlySet<string>,
): ResourceServiceError | undefined {
  const nameError = tokenError(name, "TargetPool name");
  if (nameError) return nameError;
  if (!isObject(spec)) {
    return invalidTargetPool("TargetPool spec must be an object");
  }
  const targets = spec.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    return invalidTargetPool(
      "TargetPool spec.targets must contain at least one target",
    );
  }
  const seenTargets = new Set<string>();
  for (const [index, raw] of targets.entries()) {
    if (!isObject(raw)) {
      return invalidTargetPool(`TargetPool target[${index}] must be an object`);
    }
    const targetName = raw.name;
    if (typeof targetName !== "string") {
      return invalidTargetPool(`TargetPool target[${index}].name is required`);
    }
    const targetNameError = tokenError(
      targetName,
      `TargetPool target[${index}].name`,
    );
    if (targetNameError) return targetNameError;
    if (seenTargets.has(targetName)) {
      return invalidTargetPool(
        `TargetPool target name ${targetName} is duplicated`,
      );
    }
    seenTargets.add(targetName);

    const type = raw.type;
    if (typeof type !== "string") {
      return invalidTargetPool(`TargetPool target[${index}].type is required`);
    }
    const typeError = tokenError(type, `TargetPool target[${index}].type`);
    if (typeError) return typeError;

    if (typeof raw.priority !== "number" || !Number.isInteger(raw.priority)) {
      return invalidTargetPool(
        `TargetPool target[${index}].priority must be an integer`,
      );
    }

    if (raw.ref !== undefined && typeof raw.ref !== "string") {
      return invalidTargetPool(
        `TargetPool target[${index}].ref must be a string`,
      );
    }
    if (
      raw.credentialRef !== undefined &&
      typeof raw.credentialRef !== "string"
    ) {
      return invalidTargetPool(
        `TargetPool target[${index}].credentialRef must be a string`,
      );
    }
    if (raw.region !== undefined && typeof raw.region !== "string") {
      return invalidTargetPool(
        `TargetPool target[${index}].region must be a string`,
      );
    }

    if (raw.implementations === undefined) continue;
    if (!Array.isArray(raw.implementations)) {
      return invalidTargetPool(
        `TargetPool target[${index}].implementations must be an array`,
      );
    }
    for (const [implIndex, impl] of raw.implementations.entries()) {
      if (!isObject(impl)) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}] must be an object`,
        );
      }
      const shape = impl.shape;
      if (typeof shape !== "string") {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}].shape is required`,
        );
      }
      if (!isResourceShapeKind(shape)) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}].shape is not a valid token: ${shape}`,
        );
      }
      const shapeError = tokenError(
        shape,
        `TargetPool target[${index}].implementations[${implIndex}].shape`,
      );
      if (shapeError) return shapeError;
      const implementation = impl.implementation;
      if (typeof implementation !== "string") {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}].implementation is required`,
        );
      }
      const implError = tokenError(
        implementation,
        `TargetPool target[${index}].implementations[${implIndex}].implementation`,
      );
      if (implError) return implError;

      if (impl.nativeResourceType !== undefined) {
        if (typeof impl.nativeResourceType !== "string") {
          return invalidTargetPool(
            `TargetPool target[${index}].implementations[${implIndex}].nativeResourceType must be a string`,
          );
        }
        const nativeTypeError = tokenError(
          impl.nativeResourceType,
          `TargetPool target[${index}].implementations[${implIndex}].nativeResourceType`,
        );
        if (nativeTypeError) return nativeTypeError;
      }

      if (impl.plugin !== undefined) {
        if (typeof impl.plugin !== "string") {
          return invalidTargetPool(
            `TargetPool target[${index}].implementations[${implIndex}].plugin must be a string`,
          );
        }
        const pluginError = tokenError(
          impl.plugin,
          `TargetPool target[${index}].implementations[${implIndex}].plugin`,
        );
        if (pluginError) return pluginError;
      }

      const hasPlugin = typeof impl.plugin === "string";
      const hasProviderSource = typeof impl.providerSource === "string";
      const hasModuleTemplate = typeof impl.moduleTemplate === "string";
      if (hasPlugin === (hasProviderSource || hasModuleTemplate)) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}] must declare exactly one execution path: plugin, or providerSource + moduleTemplate`,
        );
      }
      if (!hasPlugin && (!hasProviderSource || !hasModuleTemplate)) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}] module execution requires both providerSource and moduleTemplate`,
        );
      }
      if (hasPlugin && impl.moduleImportAddress !== undefined) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}] plugin execution cannot declare moduleImportAddress`,
        );
      }
      if (hasPlugin && hasModuleExecutionFields(impl)) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}] plugin execution cannot also declare provider or module fields`,
        );
      }
      if (hasProviderSource) {
        const providerSourceError = providerSourceTokenError(
          impl.providerSource as string,
          `TargetPool target[${index}].implementations[${implIndex}].providerSource`,
        );
        if (providerSourceError) return providerSourceError;
      }
      if (impl.providerAlias !== undefined) {
        if (typeof impl.providerAlias !== "string") {
          return invalidTargetPool(
            `TargetPool target[${index}].implementations[${implIndex}].providerAlias must be a string`,
          );
        }
        const aliasError = tokenError(
          impl.providerAlias,
          `TargetPool target[${index}].implementations[${implIndex}].providerAlias`,
        );
        if (aliasError) return aliasError;
      }
      if (hasModuleTemplate) {
        const templateError = tokenError(
          impl.moduleTemplate as string,
          `TargetPool target[${index}].implementations[${implIndex}].moduleTemplate`,
        );
        if (templateError) return templateError;
      }
      if (impl.moduleImportAddress !== undefined) {
        if (
          typeof impl.moduleImportAddress !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/u.test(
            impl.moduleImportAddress,
          )
        ) {
          return invalidTargetPool(
            `TargetPool target[${index}].implementations[${implIndex}].moduleImportAddress must be a child resource address such as resource_type.name`,
          );
        }
      }

      if (impl.providerConfig !== undefined) {
        if (!isObject(impl.providerConfig)) {
          return invalidTargetPool(
            `TargetPool target[${index}].implementations[${implIndex}].providerConfig must be an object`,
          );
        }
        const field = `TargetPool target[${index}].implementations[${implIndex}].providerConfig`;
        const secret = findSecretLikeJson(impl.providerConfig, field);
        if (secret) return invalidTargetPool(secret);
        const urlError = validateProviderConfigUrls(
          impl.providerConfig,
          field,
          allowedProviderConfigUrls,
        );
        if (urlError) return urlError;
      }

      if (impl.moduleInputMappings !== undefined) {
        const mappingError = validateModuleInputMappings(
          impl.moduleInputMappings,
          `TargetPool target[${index}].implementations[${implIndex}].moduleInputMappings`,
        );
        if (mappingError) return mappingError;
      }

      if (impl.moduleOutputs !== undefined) {
        const outputError = validateModuleOutputs(
          impl.moduleOutputs,
          `TargetPool target[${index}].implementations[${implIndex}].moduleOutputs`,
        );
        if (outputError) return outputError;
      }

      const interfaces = impl.interfaces;
      if (!isObject(interfaces)) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}].interfaces must be an object`,
        );
      }
      for (const [iface, level] of Object.entries(interfaces)) {
        const ifaceError = tokenError(
          iface,
          `TargetPool target[${index}].implementations[${implIndex}].interfaces key`,
        );
        if (ifaceError) return ifaceError;
        if (typeof level !== "string" || !CAPABILITY_LEVELS.has(level)) {
          return invalidTargetPool(
            `TargetPool target[${index}].implementations[${implIndex}].interfaces.${iface} must be native, shim, emulated, or unsupported`,
          );
        }
      }

      if (impl.options !== undefined) {
        if (!isObject(impl.options)) {
          return invalidTargetPool(
            `TargetPool target[${index}].implementations[${implIndex}].options must be an object`,
          );
        }
        const secret = findSecretLikeJson(
          impl.options,
          `TargetPool target[${index}].implementations[${implIndex}].options`,
        );
        if (secret) return invalidTargetPool(secret);
      }
    }
  }
  return undefined;
}

function connectionsForParsedResource(
  parsed: ParsedResourceSpec,
): Readonly<Record<string, ResourceConnectionSpec>> | undefined {
  if (parsed.schema === "registered") return parsed.connections;
  if (parsed.kind === "EdgeWorker" || parsed.kind === "ContainerService") {
    return parsed.spec.connections;
  }
  return undefined;
}

function invalidTargetPool(message: string): ResourceServiceError {
  return { code: "invalid_target_pool", message };
}

function hasModuleExecutionFields(
  descriptor: Readonly<Record<string, unknown>>,
): boolean {
  return [
    "providerSource",
    "providerAlias",
    "providerConfig",
    "moduleTemplate",
    "moduleImportAddress",
    "moduleInputMappings",
  ].some((key) => descriptor[key] !== undefined);
}

function providerSourceTokenError(
  source: string,
  field: string,
): ResourceServiceError | undefined {
  const token = tokenError(source, field);
  if (token) return token;
  const segments = source.split("/");
  if (
    (segments.length !== 2 && segments.length !== 3) ||
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(segment),
    )
  ) {
    return invalidTargetPool(
      `${field} must be an OpenTofu provider address (namespace/type or hostname/namespace/type)`,
    );
  }
  return undefined;
}

function validateProviderConfigUrls(
  value: unknown,
  field: string,
  allowedUrls: ReadonlySet<string>,
): ResourceServiceError | undefined {
  if (typeof value === "string") {
    if (!/^https?:\/\//iu.test(value)) {
      return undefined;
    }
    let normalized: string;
    try {
      normalized = normalizeBaseUrl(value);
    } catch {
      return invalidTargetPool(`${field} contains an invalid absolute URL`);
    }
    return allowedUrls.has(normalized)
      ? undefined
      : invalidTargetPool(
          `${field} URL ${normalized} is not in the operator allowlist`,
        );
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const error = validateProviderConfigUrls(
        item,
        `${field}[${index}]`,
        allowedUrls,
      );
      if (error) return error;
    }
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const error = validateProviderConfigUrls(
        item,
        `${field}.${key}`,
        allowedUrls,
      );
      if (error) return error;
    }
  }
  return undefined;
}

function validateModuleInputMappings(
  mappings: unknown,
  field: string,
): ResourceServiceError | undefined {
  if (!isObject(mappings)) {
    return invalidTargetPool(`${field} must be an object`);
  }
  for (const [inputName, raw] of Object.entries(mappings)) {
    const inputError = tokenError(inputName, `${field} key`);
    if (inputError) return inputError;
    if (!isObject(raw)) {
      return invalidTargetPool(`${field}.${inputName} must be an object`);
    }
    if (
      raw.source !== "spec" &&
      raw.source !== "target" &&
      raw.source !== "literal"
    ) {
      return invalidTargetPool(
        `${field}.${inputName}.source must be spec, target, or literal`,
      );
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      return invalidTargetPool(
        `${field}.${inputName}.required must be a boolean`,
      );
    }
    if (raw.source === "literal") {
      if (!("value" in raw)) {
        return invalidTargetPool(
          `${field}.${inputName}.value is required for literal mappings`,
        );
      }
      if (raw.path !== undefined) {
        return invalidTargetPool(
          `${field}.${inputName}.path is not valid for literal mappings`,
        );
      }
    } else {
      if (typeof raw.path !== "string" || !isJsonPointer(raw.path)) {
        return invalidTargetPool(
          `${field}.${inputName}.path must be an RFC 6901 JSON Pointer`,
        );
      }
      if (raw.value !== undefined) {
        return invalidTargetPool(
          `${field}.${inputName}.value is only valid for literal mappings`,
        );
      }
    }
    if ("value" in raw && !isJsonValue(raw.value)) {
      return invalidTargetPool(`${field}.${inputName}.value must be JSON`);
    }
    if ("default" in raw && !isJsonValue(raw.default)) {
      return invalidTargetPool(`${field}.${inputName}.default must be JSON`);
    }
    const secret = findSecretLikeJson(raw, `${field}.${inputName}`);
    if (secret) return invalidTargetPool(secret);
  }
  return undefined;
}

const OUTPUT_VALUE_TYPES = new Set([
  "string",
  "url",
  "hostname",
  "number",
  "boolean",
  "json",
]);

function validateModuleOutputs(
  outputs: unknown,
  field: string,
): ResourceServiceError | undefined {
  if (!Array.isArray(outputs)) {
    return invalidTargetPool(`${field} must be an array`);
  }
  const seen = new Set<string>();
  for (const [index, output] of outputs.entries()) {
    if (!isObject(output) || typeof output.name !== "string") {
      return invalidTargetPool(`${field}[${index}].name is required`);
    }
    const nameError = tokenError(output.name, `${field}[${index}].name`);
    if (nameError) return nameError;
    if (seen.has(output.name)) {
      return invalidTargetPool(
        `${field} contains duplicate output ${output.name}`,
      );
    }
    seen.add(output.name);
    if (
      typeof output.type !== "string" ||
      !OUTPUT_VALUE_TYPES.has(output.type)
    ) {
      return invalidTargetPool(
        `${field}[${index}].type must be string, url, hostname, number, boolean, or json`,
      );
    }
  }
  return undefined;
}

function isJsonPointer(value: string): boolean {
  return value === "" || /^(?:\/(?:[^~/]|~[01])*)+$/u.test(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/u, "");
}

function tokenError(
  value: string,
  field: string,
): ResourceServiceError | undefined {
  if (value.trim() === "")
    return invalidTargetPool(`${field} must not be blank`);
  if (/\s/.test(value)) {
    return invalidTargetPool(`${field} must not contain whitespace`);
  }
  return undefined;
}

function findSecretLikeJson(value: unknown, path: string): string | undefined {
  const found = secretLikeJsonPath(value, path);
  return found
    ? `${found} is secret-looking; use Credential or ProviderConnection materialization instead`
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSpacePolicy(record: SpacePolicyRecord): SpacePolicy {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "SpacePolicy",
    metadata: { name: record.name },
    spec: record.spec as unknown as SpacePolicySpec,
  };
}

function readyCondition(generation: number, at: IsoTimestamp): Condition {
  return {
    type: "Ready",
    status: "true",
    reason: "Applied",
    observedGeneration: generation,
    lastTransitionAt: at,
  };
}

function importingCondition(
  generation: number,
  at: IsoTimestamp,
  requestDigest: string,
): Condition {
  return {
    type: "Ready",
    status: "unknown",
    reason: "Importing",
    message: `import-request:${requestDigest}`,
    observedGeneration: generation,
    lastTransitionAt: at,
  };
}

function importedCondition(generation: number, at: IsoTimestamp): Condition {
  return {
    type: "Ready",
    status: "true",
    reason: "Imported",
    observedGeneration: generation,
    lastTransitionAt: at,
  };
}

function importFailedCondition(
  generation: number,
  at: IsoTimestamp,
  error: unknown,
  nativeId: string,
): Condition {
  return {
    type: "Ready",
    status: "false",
    reason: "ImportFailed",
    message: redactImportNativeId(errorMessage(error), nativeId),
    observedGeneration: generation,
    lastTransitionAt: at,
  };
}

function redactImportNativeId(message: string, nativeId: string): string {
  return nativeId
    ? message.split(nativeId).join("[provider-native-id]")
    : message;
}

function deletingCondition(generation: number, at: IsoTimestamp): Condition {
  return {
    type: "Ready",
    status: "false",
    reason: "Deleting",
    observedGeneration: generation,
    lastTransitionAt: at,
  };
}

function failedCondition(
  generation: number,
  at: IsoTimestamp,
  error: unknown,
): Condition {
  return {
    type: "Ready",
    status: "false",
    reason: "ApplyFailed",
    message: errorMessage(error),
    observedGeneration: generation,
    lastTransitionAt: at,
  };
}

function deleteFailedCondition(
  generation: number,
  at: IsoTimestamp,
  error: unknown,
): Condition {
  return {
    type: "Ready",
    status: "false",
    reason: "DeleteFailed",
    message: errorMessage(error),
    observedGeneration: generation,
    lastTransitionAt: at,
  };
}

function observationConditions(
  existing: readonly Condition[] | undefined,
  generation: number,
  at: IsoTimestamp,
  status: AdapterObservationStatus,
  summary: string,
): readonly Condition[] {
  const drifted = status !== "current";
  return mergeConditions(existing, [
    {
      type: "Reconciling",
      status: "false",
      reason: "ObservationComplete",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Drifted",
      status: drifted ? "true" : "false",
      reason:
        status === "current"
          ? "BackendInSync"
          : status === "missing"
            ? "BackendResourceMissing"
            : "BackendDriftDetected",
      message: summary,
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Degraded",
      status: "false",
      reason: "ObservationSucceeded",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
  ]);
}

function observationFailedConditions(
  existing: readonly Condition[] | undefined,
  generation: number,
  at: IsoTimestamp,
  error: unknown,
): readonly Condition[] {
  const message = errorMessage(error);
  return mergeConditions(existing, [
    {
      type: "Reconciling",
      status: "unknown",
      reason: "ObservationFailed",
      message,
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Degraded",
      status: "true",
      reason: "ObservationFailed",
      message,
      observedGeneration: generation,
      lastTransitionAt: at,
    },
  ]);
}

function refreshingConditions(
  existing: readonly Condition[] | undefined,
  generation: number,
  at: IsoTimestamp,
): readonly Condition[] {
  return mergeConditions(existing, [
    {
      type: "Ready",
      status: "unknown",
      reason: "Refreshing",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Reconciling",
      status: "true",
      reason: "Refreshing",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
  ]);
}

function refreshedConditions(
  existing: readonly Condition[] | undefined,
  generation: number,
  at: IsoTimestamp,
): readonly Condition[] {
  return mergeConditions(existing, [
    {
      type: "Ready",
      status: "true",
      reason: "Refreshed",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Reconciling",
      status: "false",
      reason: "RefreshComplete",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Drifted",
      status: "false",
      reason: "StateRefreshed",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Degraded",
      status: "false",
      reason: "RefreshSucceeded",
      observedGeneration: generation,
      lastTransitionAt: at,
    },
  ]);
}

function refreshFailedConditions(
  existing: readonly Condition[] | undefined,
  generation: number,
  at: IsoTimestamp,
  error: unknown,
): readonly Condition[] {
  const message = errorMessage(error);
  return mergeConditions(existing, [
    {
      type: "Ready",
      status: "unknown",
      reason: "RefreshFailed",
      message,
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Reconciling",
      status: "unknown",
      reason: "RefreshFailed",
      message,
      observedGeneration: generation,
      lastTransitionAt: at,
    },
    {
      type: "Degraded",
      status: "true",
      reason: "RefreshFailed",
      message,
      observedGeneration: generation,
      lastTransitionAt: at,
    },
  ]);
}

function mergeConditions(
  existing: readonly Condition[] | undefined,
  replacements: readonly Condition[],
): readonly Condition[] {
  const replacementTypes = new Set(
    replacements.map((condition) => condition.type),
  );
  return [
    ...(existing ?? []).filter(
      (condition) => !replacementTypes.has(condition.type),
    ),
    ...replacements,
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
