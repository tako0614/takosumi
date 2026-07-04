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
import { RESOURCE_SHAPE_KINDS, TAKOSUMI_API_VERSION } from "takosumi-contract";
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
import { DEFAULT_RESOURCE_SHAPE_CAPABILITIES, resolve } from "./resolver.ts";
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
  | "target_pool_not_found"
  | "no_eligible_target"
  | "unsupported_shape"
  | "selected_target_missing"
  | "not_found"
  | "delete_blocked"
  | "apply_failed"
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
  readonly selectedImplementation: string;
  readonly selectedTarget: string;
  readonly portability: string;
  readonly nativeResourcePlan: readonly NativeResourceRef[];
  readonly riskNotes: readonly string[];
  readonly summary: string;
}

const DEFAULT_POOL_NAME = "default";
const DEFAULT_DELETE_TIMEOUT_MS = 120_000;

export interface ResourceShapeServiceDeps {
  readonly stores: ResourceShapeStores;
  readonly adapter: ResourceAdapter;
  readonly now: () => IsoTimestamp;
  readonly deleteTimeoutMs?: number;
  /**
   * Operator-managed provider/compat base URLs that Resource Shape TargetPool
   * implementation options may reference. Empty by default so customer-written
   * TargetPools cannot redirect provider credentials to arbitrary origins.
   */
  readonly allowedProviderBaseUrls?: readonly string[];
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
  readonly #allowedProviderBaseUrls: ReadonlySet<string>;

  constructor(deps: ResourceShapeServiceDeps) {
    this.#stores = deps.stores;
    this.#adapter = deps.adapter;
    this.#now = deps.now;
    this.#deleteTimeoutMs = deps.deleteTimeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS;
    this.#allowedProviderBaseUrls = new Set(
      (deps.allowedProviderBaseUrls ?? []).map(normalizeBaseUrl),
    );
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
      this.#allowedProviderBaseUrls,
    );
    if (validation) return { ok: false, error: validation };
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

  listTargetPools(space: SpaceId): Promise<readonly TargetPoolRecord[]> {
    return this.#stores.targetPools.listBySpace(space);
  }

  getTargetPool(
    space: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined> {
    return this.#stores.targetPools.getByName(space, name);
  }

  async deleteTargetPool(space: SpaceId, name: string): Promise<void> {
    const existing = await this.#stores.targetPools.getByName(space, name);
    if (existing) await this.#stores.targetPools.delete(existing.id);
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
      credentialRef: entry.credentialRef,
      nativeResources: output.nativeResourcePlan,
      ...(output.selectedImplementationPlugin
        ? { implementationPlugin: output.selectedImplementationPlugin }
        : {}),
      ...(output.selectedImplementationOptions
        ? { implementationOptions: output.selectedImplementationOptions }
        : {}),
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
    if (existing?.phase === "Deleting") {
      return {
        ok: false,
        error: {
          code: "delete_blocked",
          message: `resource ${id} is currently deleting`,
        },
      };
    }
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
        credentialRef: entry.credentialRef,
        nativeResources: output.nativeResourcePlan,
        ...(output.selectedImplementationPlugin
          ? { implementationPlugin: output.selectedImplementationPlugin }
          : {}),
        ...(output.selectedImplementationOptions
          ? { implementationOptions: output.selectedImplementationOptions }
          : {}),
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
      if (existingLock) {
        await this.#stores.locks.put(existingLock);
      } else {
        await this.#stores.locks.delete(id);
      }
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
      await this.#stores.locks.delete(id);
      await this.#stores.resources.delete(id);
      return { ok: true, value: undefined };
    }
    if (record.phase === "Deleting") {
      return { ok: true, value: undefined };
    }
    const lock = await this.#stores.locks.get(id);
    const entry = lock
      ? await this.#findTargetPoolEntryForDelete(space, lock.target)
      : undefined;
    if (lock && entry) {
      const specResult = parseResourceSpec(record.kind, record.spec);
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
        return { ok: true, value: undefined };
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
      const claimedRecord = deleteClaim.record;
      try {
        await withTimeout(
          this.#adapter.delete({
            resourceId: id,
            plan: planResourceShape(
              lock.selectedImplementation,
              specResult.parsed,
              entry,
            ),
            nativeResources: lock.nativeResources ?? [],
            target: entry,
            credentialRef: entry.credentialRef,
            ...implementationDispatchOptionsFor(
              entry,
              record.kind,
              lock.selectedImplementation,
            ),
            deletePolicy,
            actor,
          }),
          this.#deleteTimeoutMs,
          `delete ${id}`,
        );
      } catch (error) {
        await this.#stores.resources.upsert({
          ...claimedRecord,
          phase: "Failed",
          conditions: [
            deleteFailedCondition(record.generation, this.#now(), error),
          ],
          updatedAt: this.#now(),
        });
        return {
          ok: false,
          error: { code: "delete_failed", message: errorMessage(error) },
        };
      }
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
          message: `resolver selected target ${output.selectedTarget} not in pool`,
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

  async #findTargetPoolEntryForDelete(
    space: SpaceId,
    targetName: string,
  ): Promise<TargetPoolEntry | undefined> {
    const defaultPool = await this.#stores.targetPools.getByName(
      space,
      DEFAULT_POOL_NAME,
    );
    const defaultEntry = defaultPool
      ? targetPoolSpecOf(defaultPool).targets.find((t) => t.name === targetName)
      : undefined;
    if (defaultEntry) return defaultEntry;

    const pools = await this.#stores.targetPools.listBySpace(space);
    for (const pool of pools) {
      if (pool.name === DEFAULT_POOL_NAME) continue;
      const entry = targetPoolSpecOf(pool).targets.find(
        (t) => t.name === targetName,
      );
      if (entry) return entry;
    }
    return undefined;
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

const CAPABILITY_LEVELS = new Set([
  "native",
  "shim",
  "emulated",
  "unsupported",
]);
const RESOURCE_SHAPE_KIND_SET = new Set(RESOURCE_SHAPE_KINDS);
const SECRET_KEY_PATTERN =
  /(^|[_-])(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|client[_-]?secret)([_-]|$)/i;
const SECRET_VALUE_PATTERN =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|sk-[A-Za-z0-9_-]{12,})/;

function validateTargetPoolSpec(
  name: string,
  spec: unknown,
  allowedProviderBaseUrls: ReadonlySet<string>,
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
      if (
        typeof shape !== "string" ||
        !RESOURCE_SHAPE_KIND_SET.has(shape as ResourceShapeKind)
      ) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}].shape must be a supported Resource Shape kind`,
        );
      }
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

      const interfaces = impl.interfaces;
      if (!isObject(interfaces) || Object.keys(interfaces).length === 0) {
        return invalidTargetPool(
          `TargetPool target[${index}].implementations[${implIndex}].interfaces must be a non-empty object`,
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
        const optionError = validateImplementationOptions(
          impl.options,
          `TargetPool target[${index}].implementations[${implIndex}].options`,
          {
            allowedProviderBaseUrls,
            plugin: typeof impl.plugin === "string" ? impl.plugin : undefined,
          },
        );
        if (optionError) return optionError;
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

function implementationDispatchOptionsFor(
  entry: TargetPoolEntry,
  shape: ResourceShapeKind,
  implementation: string,
):
  | {
      readonly implementationPlugin?: string;
      readonly implementationOptions?: JsonObject;
    }
  | undefined {
  const matched = entry.implementations?.find(
    (impl) => impl.shape === shape && impl.implementation === implementation,
  );
  if (!matched) return undefined;
  return {
    ...(matched.plugin ? { implementationPlugin: matched.plugin } : {}),
    ...(matched.options ? { implementationOptions: matched.options } : {}),
  };
}

function invalidTargetPool(message: string): ResourceServiceError {
  return { code: "invalid_target_pool", message };
}

function validateImplementationOptions(
  options: Readonly<Record<string, unknown>>,
  field: string,
  context: {
    readonly allowedProviderBaseUrls: ReadonlySet<string>;
    readonly plugin: string | undefined;
  },
): ResourceServiceError | undefined {
  const providerBaseUrl = options.providerBaseUrl;
  if (providerBaseUrl === undefined) return undefined;
  if (typeof providerBaseUrl !== "string" || providerBaseUrl.trim() === "") {
    return invalidTargetPool(
      `${field}.providerBaseUrl must be a non-empty string`,
    );
  }
  if (!context.plugin) {
    return invalidTargetPool(
      `${field}.providerBaseUrl requires an operator-installed implementation plugin`,
    );
  }
  let normalized: string;
  try {
    const url = new URL(providerBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return invalidTargetPool(
        `${field}.providerBaseUrl must use http or https`,
      );
    }
    normalized = normalizeBaseUrl(url.href);
  } catch {
    return invalidTargetPool(
      `${field}.providerBaseUrl must be an absolute URL`,
    );
  }
  if (!context.allowedProviderBaseUrls.has(normalized)) {
    return invalidTargetPool(
      `${field}.providerBaseUrl is not in the operator allowlist`,
    );
  }
  return undefined;
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
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERN.test(value)
      ? `${path} contains a secret-looking value; use Credential or ProviderConnection materialization instead`
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretLikeJson(item, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      return `${path}.${key} is secret-looking; use Credential or ProviderConnection materialization instead`;
    }
    const found = findSecretLikeJson(item, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
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
