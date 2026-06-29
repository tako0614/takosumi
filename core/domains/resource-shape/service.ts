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
  ResolverOutput,
  ResourceManagedBy,
  ResourceObject,
  ResourceShapeKind,
  ResourceStatus,
  SpacePolicy,
  SpacePolicySpec,
  TargetPool,
  TargetPoolEntry,
  TargetPoolSpec,
} from "takosumi-contract";
import { TAKOSUMI_API_VERSION } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";
import type { SpaceId } from "../../shared/ids.ts";
import {
  formatResourceShapeId,
  type ResolutionLockRecord,
  type ResourceShapeRecord,
  type SpacePolicyRecord,
  type TargetPoolRecord,
} from "./records.ts";
import type { ResourceShapeStores } from "./stores.ts";
import type { ResourceAdapter } from "./adapter.ts";
import {
  DEFAULT_RESOURCE_SHAPE_CAPABILITIES,
  resolve,
} from "./resolver.ts";
import {
  parseResourceSpec,
  planResourceShape,
  type ResourceShapePlan,
} from "./planner.ts";

export type ResourceServiceErrorCode =
  | "invalid_spec"
  | "invalid_name"
  | "invalid_interfaces"
  | "invalid_interface"
  | "invalid_runtime"
  | "invalid_runtime_interface"
  | "invalid_profile"
  | "invalid_source"
  | "invalid_exposure"
  | "invalid_connections"
  | "invalid_model_policy"
  | "invalid_lifecycle_policy"
  | "invalid_delete_policy"
  | "target_pool_not_found"
  | "no_eligible_target"
  | "unsupported_shape"
  | "selected_target_missing"
  | "not_found"
  | "delete_blocked"
  | "apply_failed";

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
  readonly selectedImplementation: string;
  readonly selectedTarget: string;
  readonly portability: string;
  readonly nativeResourcePlan: readonly NativeResourceRef[];
  readonly riskNotes: readonly string[];
  readonly summary: string;
}

const DEFAULT_POOL_NAME = "default";

export interface ResourceShapeServiceDeps {
  readonly stores: ResourceShapeStores;
  readonly adapter: ResourceAdapter;
  readonly now: () => IsoTimestamp;
}

export class ResourceShapeService {
  readonly #stores: ResourceShapeStores;
  readonly #adapter: ResourceAdapter;
  readonly #now: () => IsoTimestamp;

  constructor(deps: ResourceShapeServiceDeps) {
    this.#stores = deps.stores;
    this.#adapter = deps.adapter;
    this.#now = deps.now;
  }

  // --- Configuration: TargetPool / SpacePolicy --------------------------------

  async putTargetPool(
    space: SpaceId,
    name: string,
    spec: TargetPoolSpec,
  ): Promise<TargetPoolRecord> {
    const now = this.#now();
    const existing = await this.#stores.targetPools.getByName(space, name);
    const record: TargetPoolRecord = {
      id: existing?.id ?? `tkrn:${space}:TargetPool:${name}`,
      spaceId: space,
      name,
      spec: spec as unknown as JsonObject,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.#stores.targetPools.upsert(record);
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

  listTargetPools(space: SpaceId): Promise<readonly TargetPoolRecord[]> {
    return this.#stores.targetPools.listBySpace(space);
  }

  // --- preview / apply / get / list / delete ----------------------------------

  async preview(
    req: ApplyResourceRequest,
  ): Promise<ServiceResult<PreviewResourceResult>> {
    const prepared = await this.#resolveAndPlan(req, undefined);
    if (!prepared.ok) return prepared;
    const { resource, output, plan, entry } = prepared.value;
    const adapterPreview = await this.#adapter.preview({
      resourceId: output.resolutionLock.resourceId,
      plan,
      target: entry,
      credentialRef: entry.ref,
      nativeResources: output.nativeResourcePlan,
      actor: req.actor,
    });
    return {
      ok: true,
      value: {
        resource,
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
  ): Promise<ServiceResult<ResourceObject>> {
    const id = formatResourceShapeId(req.space, req.kind, req.name);
    const existing = await this.#stores.resources.get(id);
    const existingLock = await this.#stores.locks.get(id);

    const prepared = await this.#resolveAndPlan(req, existingLock);
    if (!prepared.ok) return prepared;
    const { output, plan, entry } = prepared.value;

    const now = this.#now();
    const generation = (existing?.generation ?? 0) + 1;

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
      conditions: existing?.conditions,
      labels: req.labels ?? existing?.labels,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#stores.resources.upsert(applyingRecord);

    // Pin the resolution. Reuse the prior lockedAt when the lock was preserved.
    const lockRecord: ResolutionLockRecord = {
      resourceId: id,
      selectedImplementation: output.resolutionLock.selectedImplementation,
      target: output.resolutionLock.target,
      locked: output.resolutionLock.locked,
      reason: output.resolutionLock.reason,
      portability: output.resolutionLock.portability,
      nativeResources: output.resolutionLock.nativeResources,
      lockedAt: existingLock?.lockedAt ?? now,
      updatedAt: now,
    };
    await this.#stores.locks.put(lockRecord);

    try {
      const result = await this.#adapter.apply({
        resourceId: id,
        plan,
        target: entry,
        credentialRef: entry.ref,
        nativeResources: output.nativeResourcePlan,
        actor: req.actor,
      });
      const readyRecord: ResourceShapeRecord = {
        ...applyingRecord,
        phase: "Ready",
        observedGeneration: generation,
        outputs: result.outputs,
        conditions: [readyCondition(generation, this.#now())],
        updatedAt: this.#now(),
      };
      await this.#stores.resources.upsert(readyRecord);
      await this.#stores.locks.put({
        ...lockRecord,
        nativeResources: result.nativeResources,
        updatedAt: this.#now(),
      });
      return {
        ok: true,
        value: this.#assemble(readyRecord, {
          ...lockRecord,
          nativeResources: result.nativeResources,
        }),
      };
    } catch (error) {
      const failedRecord: ResourceShapeRecord = {
        ...applyingRecord,
        phase: "Failed",
        conditions: [failedCondition(generation, this.#now(), error)],
        updatedAt: this.#now(),
      };
      await this.#stores.resources.upsert(failedRecord);
      return {
        ok: false,
        error: { code: "apply_failed", message: errorMessage(error) },
      };
    }
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

  async delete(
    space: SpaceId,
    kind: ResourceShapeKind,
    name: string,
    actor: ActorContext,
  ): Promise<ServiceResult<void>> {
    const id = formatResourceShapeId(space, kind, name);
    const record = await this.#stores.resources.get(id);
    if (!record) {
      return {
        ok: false,
        error: { code: "not_found", message: `resource ${id} not found` },
      };
    }
    const lock = await this.#stores.locks.get(id);
    const pool = await this.#stores.targetPools.getByName(
      space,
      DEFAULT_POOL_NAME,
    );
    const entry = lock && pool
      ? targetPoolSpecOf(pool).targets.find((t) => t.name === lock.target)
      : undefined;
    if (lock && entry) {
      const specResult = parseResourceSpec(record.kind, record.spec);
      const deletePolicy = specResult.ok
        ? specResult.parsed.lifecyclePolicy?.delete
        : undefined;
      if (deletePolicy === "block") {
        return {
          ok: false,
          error: {
            code: "delete_blocked",
            message:
              `resource ${id} has lifecyclePolicy.delete=block and requires an explicit policy change before deletion`,
          },
        };
      }
      await this.#adapter.delete({
        resourceId: id,
        nativeResources: lock.nativeResources ?? [],
        target: entry,
        credentialRef: entry.ref,
        deletePolicy,
        actor,
      });
    }
    await this.#stores.locks.delete(id);
    await this.#stores.resources.delete(id);
    return { ok: true, value: undefined };
  }

  // --- internals --------------------------------------------------------------

  async #resolveAndPlan(
    req: ApplyResourceRequest,
    existingLock: ResolutionLockRecord | undefined,
  ): Promise<
    ServiceResult<{
      readonly resource: ResourceObject;
      readonly output: ResolverOutput;
      readonly plan: ResourceShapePlan;
      readonly entry: TargetPoolEntry;
    }>
  > {
    const specResult = parseResourceSpec(req.kind, req.spec);
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

    const poolRecord = await this.#stores.targetPools.getByName(
      req.space,
      req.targetPoolName ?? DEFAULT_POOL_NAME,
    );
    if (!poolRecord) {
      return {
        ok: false,
        error: {
          code: "target_pool_not_found",
          message:
            `target pool ${req.targetPoolName ?? DEFAULT_POOL_NAME} not found ` +
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
    const spacePolicy = policyRecord
      ? toSpacePolicy(policyRecord)
      : undefined;

    const outcome = resolve({
      resource,
      interfaces: parsed.interfaces,
      targetPool,
      spacePolicy,
      existingLock: existingLock
        ? {
          resourceId: existingLock.resourceId,
          selectedImplementation: existingLock.selectedImplementation,
          target: existingLock.target,
          locked: existingLock.locked,
          reason: existingLock.reason,
          portability: existingLock.portability,
          nativeResources: existingLock.nativeResources,
          lockedAt: existingLock.lockedAt,
        }
        : undefined,
      targetCapabilities: DEFAULT_RESOURCE_SHAPE_CAPABILITIES,
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

    const entry = targetPool.spec.targets.find(
      (t) => t.name === output.selectedTarget,
    );
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "selected_target_missing",
          message:
            `resolver selected target ${output.selectedTarget} not in pool`,
        },
      };
    }

    let plan: ResourceShapePlan;
    try {
      plan = planResourceShape(output.selectedImplementation, parsed, entry);
    } catch (error) {
      return {
        ok: false,
        error: { code: "no_eligible_target", message: errorMessage(error) },
      };
    }

    return { ok: true, value: { resource, output, plan, entry } };
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
}

// --- helpers (module-level, pure) ---------------------------------------------

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
