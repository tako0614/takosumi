// REAL opentofu-adapter for the Resource Shape API.
//
// `docs/internal/final-plan.md` §9/§17 ("opentofu-adapter broad first"): a resolved
// Resource Shape is materialized by LOWERING it to an internal OpenTofu module
// call and driving the shared Run/runner machinery with a first-class Resource
// subject, instead of a bespoke per-provider SDK path. This file
// owns ONLY that lowering + result mapping; the run lifecycle stays inside
// deploy-control behind the `OpentofuRunPort` seam, so the adapter is unit
// testable without a live runner or cloud.
//
// Layering:
//   ResourceShapeService -> OpentofuResourceShapeAdapter (this file)
//                        -> OpentofuRunPort (seam)
//                        -> ControllerOpentofuRunPort -> OpenTofuController
//
// The adapter is the only piece that knows ResourceShape/Target vocabulary; the
// port speaks plain "run this generated root with these inputs and this
// ProviderBinding". The RunEngine coupling is isolated to
// `ControllerOpentofuRunPort` and is fully replaceable by `FakeOpentofuRunPort`.
//
// Resource runs never allocate a Capsule, InstallConfig, Source, StateVersion,
// or Output row. The Run stores a Resource subject; encrypted state uses a
// Resource-scoped R2 key; the Resource record owns the successful run/state
// pointer and public outputs.

import type {
  ActorContext,
  JsonObject,
  JsonValue,
  NativeResourceRef,
  ResourceDeletePolicy,
  TargetImplementationDescriptor,
} from "takosumi-contract";
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  DispatchGeneratedRoot,
  OutputAllowlistEntry,
  PlanResourceChange,
  PlanRunResponse,
  PublicPlanRun,
} from "@takosumi/internal/deploy-control-api";
import type {
  DeployControlActorContext,
  GenericRootDispatchContext,
  PlanRunInternalContext,
} from "../deploy-control/mod.ts";
import {
  generateOpenTofuChildModuleRoot,
  type RootProviderBinding,
} from "takosumi-rootgen";
import { canonicalProviderAddress } from "@takosumi/providers";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import type {
  AdapterApplyInput,
  AdapterApplyResult,
  AdapterDeleteInput,
  AdapterImportInput,
  AdapterImportResult,
  AdapterObserveResult,
  AdapterPreviewResult,
  AdapterRefreshResult,
  ResourceAdapter,
} from "./adapter.ts";
import type { ResourceShapePublicOutput } from "./planner.ts";
import type {
  ResourceShapeExecutionRecord,
  ResourceShapeStateAdoptionDescriptor,
} from "./records.ts";

// ---------------------------------------------------------------------------
// OpentofuRunPort: the few run operations the adapter needs. Keeping this narrow
// (and free of shape-specific vocabulary) is what isolates the RunEngine coupling.
// ---------------------------------------------------------------------------

/** OpenTofu provider mapping for one resolved Target. */
export interface OpentofuProviderBinding {
  /** OpenTofu provider local name derived from the explicit source. */
  readonly provider: string;
  /** Canonical registry source from the selected descriptor. */
  readonly providerSource: string;
  readonly alias?: string;
  /** Explicit non-secret provider-block arguments from the descriptor. */
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  /**
   * ProviderConnection id whose credentials the runner mints for this provider.
   * Undefined when no Takosumi-managed credential is bound (the generated root
   * stays credential-free and relies on ambient runner env, if any).
   */
  readonly connectionId?: string;
}

/** Plan/apply a lowered Resource Shape implementation as a first-class Resource run. */
export interface OpentofuRunRequest {
  /** Canonical resource id (`tkrn:{space}:{kind}:{name}`). */
  readonly resourceId: string;
  readonly environment: string;
  readonly stateGeneration: number;
  readonly stateAdoption?: ResourceShapeStateAdoptionDescriptor;
  /** Operator-selected registry key from the Target descriptor. */
  readonly moduleTemplate: string;
  /** Operator-injected child module, resolved fail-closed by the service. */
  readonly operatorModule: {
    readonly files: readonly {
      readonly path: string;
      readonly text: string;
    }[];
  };
  /** Module values produced by the descriptor's explicit input mappings. */
  readonly inputs: Readonly<Record<string, JsonValue>>;
  /** Typed public OpenTofu outputs projected from the module (`tofu output -json`). */
  readonly publicOutputs: readonly ResourceShapePublicOutput[];
  /** Native refs currently pinned by the ResolutionLock. */
  readonly nativeResources?: readonly NativeResourceRef[];
  readonly providerBinding: OpentofuProviderBinding;
  readonly actor: ActorContext;
}

/** Config-driven import of one existing child-module resource. */
export interface OpentofuImportRequest extends OpentofuRunRequest {
  readonly nativeId: string;
  readonly importAddress: string;
}

/** Destroy a previously materialized Resource Shape implementation. */
export interface OpentofuDestroyRequest {
  readonly resourceId: string;
  readonly environment: string;
  readonly stateGeneration: number;
  readonly stateAdoption?: ResourceShapeStateAdoptionDescriptor;
  /** Re-generated implementation plan. Present for OpenTofu-backed shapes. */
  readonly moduleTemplate?: string;
  readonly operatorModule?: {
    readonly files: readonly {
      readonly path: string;
      readonly text: string;
    }[];
  };
  readonly inputs?: Readonly<Record<string, JsonValue>>;
  readonly publicOutputs?: readonly ResourceShapePublicOutput[];
  readonly providerBinding: OpentofuProviderBinding;
  /** Native resources recorded for the Resource (audit / scope only). */
  readonly nativeResources: readonly NativeResourceRef[];
  readonly deletePolicy?: ResourceDeletePolicy;
  readonly actor: ActorContext;
}

export interface OpentofuRunResult {
  /** Underlying first-class Resource Run id, when one was created. */
  readonly runId?: string;
  readonly summary: string;
  readonly nativeResources: readonly NativeResourceRef[];
  readonly outputs: JsonObject;
  readonly execution?: ResourceShapeExecutionRecord;
}

export interface OpentofuObserveResult {
  readonly runId?: string;
  readonly status: "current" | "drifted";
  readonly summary: string;
}

/**
 * The run seam the adapter depends on. `plan` previews (no state mutation),
 * `apply` plans-then-applies (mutates state + captures outputs), `destroy`
 * tears down. Implemented for real by {@link ControllerOpentofuRunPort} and for
 * tests by {@link FakeOpentofuRunPort}.
 */
export interface OpentofuRunPort {
  plan(request: OpentofuRunRequest): Promise<OpentofuRunResult>;
  apply(request: OpentofuRunRequest): Promise<OpentofuRunResult>;
  importResource(request: OpentofuImportRequest): Promise<OpentofuRunResult>;
  observe(request: OpentofuRunRequest): Promise<OpentofuObserveResult>;
  refresh(request: OpentofuRunRequest): Promise<OpentofuRunResult>;
  destroy(request: OpentofuDestroyRequest): Promise<OpentofuRunResult>;
}

// ---------------------------------------------------------------------------
// Generic provider-source normalization. Target type never selects a provider.
// ---------------------------------------------------------------------------

/** Derive the OpenTofu local provider name from an explicit registry source. */
export function providerLocalNameForSource(source: string): string {
  const canonical = canonicalProviderAddress(source);
  const parts = canonical.split("/").filter(Boolean);
  const localName = parts[parts.length - 1];
  if (!localName) throw new Error(`invalid provider source: ${source}`);
  return localName;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Keep only JSON-serializable values; drop `undefined`/functions/symbols. The
 * Planner inputs are normally scalars/lists, but this guards the seam so the
 * runner never receives non-HCL-encodable junk.
 */
function normalizeJsonInputs(
  raw: Readonly<Record<string, unknown>>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    const coerced = coerceJsonValue(value);
    if (coerced !== undefined) out[key] = coerced;
  }
  return out;
}

function coerceJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean")
    return value as JsonValue;
  if (Array.isArray(value)) {
    return value.map((v) => coerceJsonValue(v) ?? null);
  }
  if (t === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = coerceJsonValue(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OpentofuResourceShapeAdapter: ResourceAdapter -> OpentofuRunPort.
// ---------------------------------------------------------------------------

/**
 * The OpenTofu Resource Shape adapter (id `opentofu`). It maps a resolved
 * shape plan + Target to an {@link OpentofuRunRequest} (provider, augmented inputs,
 * explicit operator module and ProviderConnection), drives the
 * {@link OpentofuRunPort}, and maps the run result back to the
 * {@link ResourceAdapter} contract.
 */
export class OpentofuResourceShapeAdapter implements ResourceAdapter {
  readonly id = "opentofu";

  availabilityForImplementation(
    implementation: TargetImplementationDescriptor,
  ): { readonly adapterId: string } | undefined {
    return !implementation.plugin &&
      implementation.providerSource &&
      implementation.moduleTemplate
      ? { adapterId: this.id }
      : undefined;
  }
  readonly #port: OpentofuRunPort;

  constructor(port: OpentofuRunPort) {
    this.#port = port;
  }

  async preview(input: AdapterApplyInput): Promise<AdapterPreviewResult> {
    assertModuleBackedImplementation(input.implementation, this.id);
    const request = this.#runRequest(input);
    const result = await this.#port.plan(request);
    return {
      summary: result.summary,
      nativeResources: result.nativeResources,
      ...(result.runId ? { runId: result.runId } : {}),
    };
  }

  async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    assertModuleBackedImplementation(input.implementation, this.id);
    const request = this.#runRequest(input);
    const result = await this.#port.apply(request);
    return {
      nativeResources: result.nativeResources,
      outputs: result.outputs,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.execution ? { execution: result.execution } : {}),
    };
  }

  async importResource(
    input: AdapterImportInput,
  ): Promise<AdapterImportResult> {
    assertModuleBackedImplementation(input.implementation, this.id);
    const importAddress = input.implementation.moduleImportAddress;
    if (!importAddress) {
      throw new Error(
        `Resource Shape implementation "${input.implementation.implementation}" does not declare moduleImportAddress`,
      );
    }
    const result = await this.#port.importResource({
      ...this.#runRequest(input),
      nativeId: input.nativeId,
      importAddress,
    });
    return {
      summary: result.summary,
      nativeResources: result.nativeResources,
      outputs: result.outputs,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.execution ? { execution: result.execution } : {}),
    };
  }

  async observe(input: AdapterApplyInput): Promise<AdapterObserveResult> {
    assertModuleBackedImplementation(input.implementation, this.id);
    return await this.#port.observe(this.#runRequest(input));
  }

  async refresh(input: AdapterApplyInput): Promise<AdapterRefreshResult> {
    assertModuleBackedImplementation(input.implementation, this.id);
    const result = await this.#port.refresh(this.#runRequest(input));
    return {
      summary: result.summary,
      nativeResources: result.nativeResources,
      outputs: result.outputs,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.execution ? { execution: result.execution } : {}),
    };
  }

  async delete(input: AdapterDeleteInput): Promise<void> {
    // `retain` keeps the native resources; `block` should have been refused by
    // the service before reaching the adapter — either way we never destroy.
    if (input.deletePolicy === "retain" || input.deletePolicy === "block") {
      return;
    }
    assertModuleBackedImplementation(input.implementation, this.id);
    await this.#port.destroy({
      resourceId: input.resourceId,
      environment: input.environment,
      stateGeneration: input.stateGeneration,
      ...(input.stateAdoption ? { stateAdoption: input.stateAdoption } : {}),
      ...(input.plan
        ? {
            moduleTemplate: requirePlanModuleTemplate(input.plan),
            operatorModule: requirePlanOperatorModule(input.plan),
            inputs: normalizeJsonInputs(input.plan.inputs),
            publicOutputs: input.plan.publicOutputs,
          }
        : {}),
      providerBinding: providerBindingForImplementation(
        input.implementation,
        input.credentialRef,
      ),
      nativeResources: input.nativeResources,
      ...(input.deletePolicy ? { deletePolicy: input.deletePolicy } : {}),
      actor: input.actor,
    });
  }

  #runRequest(input: AdapterApplyInput): OpentofuRunRequest {
    return {
      resourceId: input.resourceId,
      environment: input.environment,
      stateGeneration: input.stateGeneration,
      ...(input.stateAdoption ? { stateAdoption: input.stateAdoption } : {}),
      moduleTemplate: requirePlanModuleTemplate(input.plan),
      operatorModule: requirePlanOperatorModule(input.plan),
      inputs: normalizeJsonInputs(input.plan.inputs),
      publicOutputs: input.plan.publicOutputs,
      ...(input.nativeResources
        ? { nativeResources: input.nativeResources }
        : {}),
      providerBinding: providerBindingForImplementation(
        input.implementation,
        input.credentialRef,
      ),
      actor: input.actor,
    };
  }
}

function assertModuleBackedImplementation(
  implementation: TargetImplementationDescriptor,
  adapterId: string,
): void {
  if (implementation.plugin) {
    throw new Error(
      `implementation plugin ${implementation.plugin} requires a plugin-aware Resource Shape adapter; ${adapterId} cannot execute it`,
    );
  }
  if (!implementation.providerSource || !implementation.moduleTemplate) {
    throw new Error(
      `implementation ${implementation.implementation} has no explicit providerSource + moduleTemplate for ${adapterId}`,
    );
  }
}

function requirePlanModuleTemplate(plan: AdapterApplyInput["plan"]): string {
  if (!plan.moduleTemplate) {
    throw new Error("OpenTofu Resource Shape plan has no moduleTemplate");
  }
  return plan.moduleTemplate;
}

function requirePlanOperatorModule(
  plan: AdapterApplyInput["plan"],
): NonNullable<AdapterApplyInput["plan"]["operatorModule"]> {
  if (!plan.operatorModule || plan.operatorModule.files.length === 0) {
    throw new Error("OpenTofu Resource Shape plan has no operator module");
  }
  return plan.operatorModule;
}

function providerBindingForImplementation(
  implementation: TargetImplementationDescriptor,
  connectionId: string | undefined,
): OpentofuProviderBinding {
  const source = implementation.providerSource;
  if (!source) {
    throw new Error(
      `implementation ${implementation.implementation} has no providerSource`,
    );
  }
  const providerSource = canonicalProviderAddress(source);
  return {
    provider: providerLocalNameForSource(providerSource),
    providerSource,
    ...(implementation.providerAlias
      ? { alias: implementation.providerAlias }
      : {}),
    ...(implementation.providerConfig &&
    Object.keys(implementation.providerConfig).length > 0
      ? { configuration: implementation.providerConfig }
      : {}),
    ...(connectionId ? { connectionId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Result mapping helpers (shared by the real port and reusable by integrators).
// ---------------------------------------------------------------------------

/**
 * Map runner plan-JSON resource changes (`tofu show -json tfplan`) to
 * NativeResourceRefs. `no-op` / pure `delete` changes are skipped so a preview
 * reports the resources the apply WILL own. `type` is the OpenTofu resource type;
 * `id` is the plan address (the stable handle
 * before apply assigns a provider id).
 */
export function nativeResourcesFromPlanChanges(
  changes: readonly PlanResourceChange[] | undefined,
): readonly NativeResourceRef[] {
  if (!changes) return [];
  const refs: NativeResourceRef[] = [];
  for (const change of changes) {
    const actions = change.actions ?? [];
    if (change.importing === true) {
      refs.push({ type: change.type, id: change.address });
      continue;
    }
    const isPureDelete =
      actions.length > 0 && actions.every((a) => a === "delete");
    const isNoOp = actions.length === 0 || actions.every((a) => a === "no-op");
    if (isPureDelete || isNoOp) continue;
    refs.push({ type: change.type, id: change.address });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// ControllerOpentofuRunPort: real first-class Resource Run implementation.
// ---------------------------------------------------------------------------

/**
 * The exact deploy-control surface the real port drives. `OpenTofuController`
 * structurally satisfies this; depending on the narrow interface (not the whole
 * controller) keeps the coupling explicit and the port mockable.
 */
export interface DeployControlRunDriver {
  createPlanRun(
    request: CreatePlanRunRequest,
    context?: DeployControlActorContext,
    internal?: PlanRunInternalContext,
  ): Promise<PlanRunResponse>;
  getPlanRun(id: string): Promise<PlanRunResponse>;
  createApplyRun(
    request: CreateApplyRunRequest,
    context?: DeployControlActorContext,
  ): Promise<ApplyRunResponse>;
  getApplyRun(id: string): Promise<ApplyRunResponse>;
  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<unknown>;
  runQueuedPlan(runId: string): Promise<unknown>;
  runQueuedApply(runId: string): Promise<ApplyRunResponse>;
}

export interface ControllerOpentofuRunPortDeps {
  readonly driver: DeployControlRunDriver;
  /**
   * Drive `runQueuedPlan` / `runQueuedApply` in-process after create (default
   * `true`). Set `false` when an external queue consumer drives the runner; then
   * the port returns after enqueue and the caller polls.
   */
  readonly driveRunsSynchronously?: boolean;
  readonly pollIntervalMs?: number;
  readonly waitTimeoutMs?: number;
}

export class ControllerOpentofuRunPort implements OpentofuRunPort {
  readonly #driver: DeployControlRunDriver;
  readonly #drive: boolean;
  readonly #pollIntervalMs: number;
  readonly #waitTimeoutMs: number;

  constructor(deps: ControllerOpentofuRunPortDeps) {
    this.#driver = deps.driver;
    this.#drive = deps.driveRunsSynchronously ?? true;
    this.#pollIntervalMs = deps.pollIntervalMs ?? 1000;
    this.#waitTimeoutMs = deps.waitTimeoutMs ?? 60_000;
  }

  async plan(request: OpentofuRunRequest): Promise<OpentofuRunResult> {
    const planRun = await this.#createAndDrivePlan(
      request,
      operationForStateGeneration(request.stateGeneration),
    );
    return {
      runId: planRun.id,
      summary: summarizePlan(planRun),
      nativeResources: nativeResourcesFromPlanChanges(
        planRun.planResourceChanges,
      ),
      outputs: {},
    };
  }

  async apply(request: OpentofuRunRequest): Promise<OpentofuRunResult> {
    const planRun = await this.#createAndDrivePlan(
      request,
      operationForStateGeneration(request.stateGeneration),
    );
    return await this.#applyCompletedPlan(request, planRun, "applied");
  }

  async refresh(request: OpentofuRunRequest): Promise<OpentofuRunResult> {
    const planRun = await this.#createAndDrivePlan(request, "update", {
      refreshOnly: true,
    });
    return await this.#applyCompletedPlan(request, planRun, "refreshed");
  }

  async importResource(
    request: OpentofuImportRequest,
  ): Promise<OpentofuRunResult> {
    const planRun = await this.#createAndDrivePlan(request, "create", {
      resourceImport: true,
    });
    const result = await this.#applyCompletedPlan(request, planRun, "imported");
    return {
      ...result,
      nativeResources: result.nativeResources.map((resource) => ({
        ...resource,
        id: request.nativeId,
      })),
    };
  }

  async #applyCompletedPlan(
    request: OpentofuRunRequest,
    planRun: PublicPlanRun,
    verb: "applied" | "imported" | "refreshed",
  ): Promise<OpentofuRunResult> {
    const nativeResources = resultingNativeResources(
      planRun.planResourceChanges,
      request.nativeResources,
    );
    const applyResponse = await this.#driver.createApplyRun(
      { planRunId: planRun.id, expected: applyGuardFromPlanRun(planRun) },
      { actor: request.actor.actorAccountId },
    );
    let applyRun = applyResponse.applyRun;
    if (this.#drive && applyRun.status === "queued") {
      applyRun = (await this.#driver.runQueuedApply(applyRun.id)).applyRun;
    }
    applyRun = await this.#waitForApplyCompletion(applyRun);
    if (!applyRun.resourceResult) {
      throw new Error(
        `apply ${applyRun.id} succeeded without a Resource result`,
      );
    }
    const resourceResult = applyRun.resourceResult;
    return {
      runId: applyRun.id,
      summary: `${verb} ${nativeResources.length} native resource(s) for ${request.resourceId}`,
      nativeResources,
      outputs: { ...resourceResult.outputs },
      execution: {
        runId: applyRun.id,
        stateGeneration: resourceResult.stateGeneration,
        stateRef: resourceResult.stateRef,
        ...(resourceResult.stateDigest
          ? { stateDigest: resourceResult.stateDigest }
          : {}),
        ...(resourceResult.rawOutputRef
          ? { rawOutputRef: resourceResult.rawOutputRef }
          : {}),
        updatedAt: new Date(applyRun.finishedAt ?? Date.now()).toISOString(),
      },
    };
  }

  async observe(request: OpentofuRunRequest): Promise<OpentofuObserveResult> {
    const planRun = await this.#createAndDrivePlan(request, "update", {
      driftCheck: true,
    });
    const counts =
      planRun.summary ?? observationCounts(planRun.planResourceChanges);
    const add = counts.add ?? 0;
    const change = counts.change ?? 0;
    const destroy = counts.destroy ?? 0;
    const drifted = add + change + destroy > 0;
    return {
      runId: planRun.id,
      status: drifted ? "drifted" : "current",
      summary: drifted
        ? `drift detected: ${add} add, ${change} change, ${destroy} destroy`
        : "no backend drift detected",
    };
  }

  async destroy(request: OpentofuDestroyRequest): Promise<OpentofuRunResult> {
    // Destroy replays the same operator module used to create the Resource.
    const generatedRootDispatch =
      request.moduleTemplate &&
      request.operatorModule &&
      request.inputs &&
      request.publicOutputs
        ? this.#genericRootDispatch({
            resourceId: request.resourceId,
            environment: request.environment,
            stateGeneration: request.stateGeneration,
            moduleTemplate: request.moduleTemplate,
            operatorModule: request.operatorModule,
            inputs: request.inputs,
            publicOutputs: request.publicOutputs,
            providerBinding: request.providerBinding,
            actor: request.actor,
          })
        : undefined;
    if (!generatedRootDispatch) {
      throw new Error(
        `Resource ${request.resourceId} destroy requires its pinned operator module`,
      );
    }
    const workspaceId = workspaceIdFromResourceId(request.resourceId);
    const source = await operatorModuleSource(request);
    const planResponse = await this.#driver.createPlanRun(
      {
        workspaceId,
        source,
        operation: "destroy",
        ...(request.inputs ? { variables: request.inputs } : {}),
        requiredProviders: [request.providerBinding.providerSource],
      },
      { actor: request.actor.actorAccountId },
      {
        genericRootDispatch: generatedRootDispatch,
        baseStateGeneration: request.stateGeneration,
        resourceContext: resourceRunContext(request, workspaceId),
      },
    );
    let planRun = planResponse.planRun;
    if (this.#drive && planRun.status === "queued") {
      await this.#driver.runQueuedPlan(planRun.id);
      planRun = (await this.#driver.getPlanRun(planRun.id)).planRun;
    }
    planRun = await this.#approvePlanIfWaiting(planRun, request.actor);
    const applyResponse = await this.#driver.createApplyRun(
      {
        planRunId: planRun.id,
        expected: applyGuardFromPlanRun(planRun),
      },
      { actor: request.actor.actorAccountId },
    );
    let applyRun = applyResponse.applyRun;
    if (this.#drive && applyRun.status === "queued") {
      applyRun = (await this.#driver.runQueuedApply(applyRun.id)).applyRun;
    }
    applyRun = await this.#waitForApplyCompletion(applyRun);
    return {
      runId: applyRun.id,
      summary: `destroyed ${request.nativeResources.length} native resource(s) for ${request.resourceId}`,
      nativeResources: [],
      outputs: {},
    };
  }

  async #createAndDrivePlan(
    request: OpentofuRunRequest,
    operation: CreatePlanRunRequest["operation"],
    internal: Pick<
      PlanRunInternalContext,
      "driftCheck" | "refreshOnly" | "resourceImport"
    > = {},
  ): Promise<PublicPlanRun> {
    const workspaceId = workspaceIdFromResourceId(request.resourceId);
    const source = await operatorModuleSource(request);
    const response = await this.#driver.createPlanRun(
      {
        workspaceId,
        source,
        ...(operation ? { operation } : {}),
        variables: request.inputs,
        requiredProviders: [request.providerBinding.providerSource],
      },
      { actor: request.actor.actorAccountId },
      {
        genericRootDispatch: this.#genericRootDispatch(
          request,
          requestHasImport(request) ? request : undefined,
        ),
        baseStateGeneration: request.stateGeneration,
        resourceContext: resourceRunContext(request, workspaceId),
        ...internal,
      },
    );
    if (this.#drive && response.planRun.status === "queued") {
      await this.#driver.runQueuedPlan(response.planRun.id);
      return await this.#waitForPlanCompletion(
        (await this.#driver.getPlanRun(response.planRun.id)).planRun,
      );
    }
    return await this.#waitForPlanCompletion(response.planRun);
  }

  async #approvePlanIfWaiting(
    planRun: PublicPlanRun,
    actor: ActorContext,
  ): Promise<PublicPlanRun> {
    let current = planRun;
    const deadline = Date.now() + this.#waitTimeoutMs;
    while (current.status === "queued" || current.status === "running") {
      if (Date.now() >= deadline) {
        throw new Error(
          `plan ${current.id} did not complete within ${this.#waitTimeoutMs}ms`,
        );
      }
      await sleep(this.#pollIntervalMs);
      current = (await this.#driver.getPlanRun(current.id)).planRun;
    }
    if (current.status === "waiting_approval") {
      await this.#driver.approveRun(current.id, {
        approvedBy: actor.actorAccountId,
        reason: "resource-shape-delete",
      });
      current = (await this.#driver.getPlanRun(current.id)).planRun;
    }
    if (current.status !== "succeeded") {
      throw new Error(
        `plan ${current.id} finished with status ${current.status}`,
      );
    }
    return current;
  }

  /**
   * Build the generated root that calls the Resource Shape operator module.
   * The operator module is carried as an internal execution bundle;
   * generatedRoot contains only the ordinary OpenTofu wrapper HCL.
   */
  #genericRootDispatch(
    request: OpentofuRunRequest,
    importRequest?: OpentofuImportRequest,
  ): GenericRootDispatchContext {
    const outputAllowlist = outputAllowlistFromPublicOutputs(
      request.publicOutputs,
    );
    const providerBindings = providerBindingsFor(request.providerBinding);
    const generatedRoot = generateOpenTofuChildModuleRoot({
      requiredProviders: [request.providerBinding.providerSource],
      inputs: request.inputs,
      outputAllowlist,
      ...(providerBindings.length > 0 ? { providerBindings } : {}),
    });
    const dispatch: DispatchGeneratedRoot = {
      files: importRequest
        ? {
            ...generatedRoot.files,
            "imports.tf": importBlock(importRequest),
          }
        : generatedRoot.files,
    };
    return {
      generatedRoot: dispatch,
      operatorModule: {
        files: request.operatorModule.files.map((file) => ({ ...file })),
      },
      workspaceOutputAllowlist: outputAllowlist,
      outputAllowlist,
      ...(request.stateAdoption
        ? { stateAdoption: request.stateAdoption }
        : {}),
    };
  }

  async #waitForPlanCompletion(planRun: PublicPlanRun): Promise<PublicPlanRun> {
    let current = planRun;
    const deadline = Date.now() + this.#waitTimeoutMs;
    while (current.status === "queued" || current.status === "running") {
      if (Date.now() >= deadline) {
        throw new Error(
          `plan ${current.id} did not complete within ${this.#waitTimeoutMs}ms`,
        );
      }
      await sleep(this.#pollIntervalMs);
      current = (await this.#driver.getPlanRun(current.id)).planRun;
    }
    if (current.status !== "succeeded") {
      throw new Error(
        `plan ${current.id} finished with status ${current.status}`,
      );
    }
    return current;
  }

  async #waitForApplyCompletion(
    applyRun: ApplyRunResponse["applyRun"],
  ): Promise<ApplyRunResponse["applyRun"]> {
    let current = applyRun;
    const deadline = Date.now() + this.#waitTimeoutMs;
    while (current.status === "queued" || current.status === "running") {
      if (Date.now() >= deadline) {
        throw new Error(
          `apply ${current.id} did not complete within ${this.#waitTimeoutMs}ms`,
        );
      }
      await sleep(this.#pollIntervalMs);
      current = (await this.#driver.getApplyRun(current.id)).applyRun;
    }
    if (current.status !== "succeeded") {
      throw new Error(
        `apply ${current.id} finished with status ${current.status}`,
      );
    }
    return current;
  }
}

/** One provider binding per managed credential or provider base URL override. */
function providerBindingsFor(
  binding: OpentofuProviderBinding,
): readonly RootProviderBinding[] {
  if (
    !binding.connectionId &&
    !binding.alias &&
    (!binding.configuration || Object.keys(binding.configuration).length === 0)
  ) {
    return [];
  }
  return [
    {
      provider: binding.providerSource,
      ...(binding.alias ? { alias: binding.alias } : {}),
      ...(binding.configuration
        ? { configuration: binding.configuration }
        : {}),
    },
  ];
}

/** Project each typed public output as an allowlist passthrough of the same name. */
export function outputAllowlistFromPublicOutputs(
  publicOutputs: readonly ResourceShapePublicOutput[],
): Record<string, OutputAllowlistEntry> {
  const allowlist: Record<string, OutputAllowlistEntry> = {};
  for (const output of publicOutputs) {
    allowlist[output.name] = { from: output.name, type: output.type };
  }
  return allowlist;
}

function summarizePlan(planRun: PublicPlanRun): string {
  const refs = nativeResourcesFromPlanChanges(planRun.planResourceChanges);
  return `plan ${planRun.id}: create ${refs.length} native resource(s)`;
}

function observationCounts(
  changes: readonly PlanResourceChange[] | undefined,
): { readonly add: number; readonly change: number; readonly destroy: number } {
  let add = 0;
  let change = 0;
  let destroy = 0;
  for (const item of changes ?? []) {
    const actions = item.actions ?? [];
    if (actions.length === 0 || actions.every((action) => action === "no-op")) {
      continue;
    }
    if (actions.length === 1 && actions[0] === "create") add += 1;
    else if (actions.length === 1 && actions[0] === "delete") destroy += 1;
    else change += 1;
  }
  return { add, change, destroy };
}

function resultingNativeResources(
  changes: readonly PlanResourceChange[] | undefined,
  current: readonly NativeResourceRef[] | undefined,
): readonly NativeResourceRef[] {
  if (changes?.some((change) => change.importing === true)) {
    return nativeResourcesFromPlanChanges(changes);
  }
  if (
    !changes ||
    changes.every(
      (change) =>
        !change.actions?.length ||
        change.actions.every((action) => action === "no-op"),
    )
  ) {
    return current ?? [];
  }
  return nativeResourcesFromPlanChanges(changes);
}

function requestHasImport(
  request: OpentofuRunRequest,
): request is OpentofuImportRequest {
  const candidate = request as Partial<OpentofuImportRequest>;
  return (
    typeof candidate.nativeId === "string" &&
    typeof candidate.importAddress === "string"
  );
}

function importBlock(request: OpentofuImportRequest): string {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(
      request.importAddress,
    )
  ) {
    throw new Error(`invalid module import address: ${request.importAddress}`);
  }
  if (
    request.nativeId.trim() === "" ||
    request.nativeId.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(request.nativeId)
  ) {
    throw new Error("native import id must be a non-empty printable string");
  }
  return [
    "import {",
    `  to = module.child.${request.importAddress}`,
    `  id = ${JSON.stringify(request.nativeId)}`,
    "}",
    "",
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workspaceIdFromResourceId(resourceId: string): string {
  const parts = resourceId.split(":");
  if (parts.length < 4 || parts[0] !== "tkrn" || !parts[1]) {
    throw new Error(
      `resourceId ${resourceId} must be formatted tkrn:{workspace}:{kind}:{name}`,
    );
  }
  return parts[1];
}

function operationForStateGeneration(
  stateGeneration: number,
): "create" | "update" {
  return stateGeneration === 0 ? "create" : "update";
}

async function operatorModuleSource(
  request: OpentofuRunRequest | OpentofuDestroyRequest,
): Promise<{ readonly kind: "operator_module"; readonly digest: string }> {
  if (!request.operatorModule) {
    throw new Error(
      `Resource ${request.resourceId} has no operator module execution source`,
    );
  }
  return {
    kind: "operator_module",
    digest: await stableJsonDigest({
      resourceId: request.resourceId,
      moduleTemplate: request.moduleTemplate ?? null,
      files: request.operatorModule.files,
    }),
  };
}

function resourceRunContext(
  request: OpentofuRunRequest | OpentofuDestroyRequest,
  workspaceId: string,
): NonNullable<PlanRunInternalContext["resourceContext"]> {
  return {
    workspaceId,
    resourceId: request.resourceId,
    environment: request.environment,
    providerBinding: {
      provider: request.providerBinding.provider,
      providerSource: request.providerBinding.providerSource,
      ...(request.providerBinding.alias
        ? { alias: request.providerBinding.alias }
        : {}),
      ...(request.providerBinding.connectionId
        ? { connectionId: request.providerBinding.connectionId }
        : {}),
    },
  };
}

/**
 * Build the `CreateApplyRunRequest.expected` TOCTOU guard from a completed plan.
 * Equivalent to deploy-control's own `applyExpectedGuardFromPlanRun`, but reads
 * the PUBLIC PlanRun DTO so the port stays decoupled from the internal run type.
 * Requires the runner to have populated `planDigest` + `planArtifact` (a real or
 * simulated runner); a plan with neither cannot be applied.
 */
export function applyGuardFromPlanRun(
  planRun: PublicPlanRun,
): ApplyExpectedGuard {
  if (!planRun.planDigest || !planRun.planArtifact) {
    throw new Error(
      `applyGuardFromPlanRun: plan ${planRun.id} has no completed plan artifact; ` +
        "apply requires a runner-produced planDigest + planArtifact",
    );
  }
  const capsuleId = planRun.capsuleId;
  return {
    planRunId: planRun.id,
    ...(capsuleId ? { capsuleId } : {}),
    ...(capsuleId
      ? { currentStateVersionId: planRun.capsuleCurrentStateVersionId ?? null }
      : {}),
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest,
    planArtifactDigest: planRun.planArtifact.digest,
    ...(planRun.sourceCommit ? { sourceCommit: planRun.sourceCommit } : {}),
    ...(planRun.providerLockDigest
      ? { providerLockDigest: planRun.providerLockDigest }
      : {}),
    ...(planRun.resolvedProviderBindingsDigest
      ? {
          resolvedProviderBindingsDigest:
            planRun.resolvedProviderBindingsDigest,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// FakeOpentofuRunPort: deterministic in-memory port for unit tests. It never
// touches deploy-control, a runner, or a cloud — it records each request and
// returns plausible results derived from the request (native resources by
// provider/operator module, outputs from the public output names).
// ---------------------------------------------------------------------------

export interface FakeOpentofuRunPortOverrides {
  /** Override the native resources a plan/apply reports for a resourceId. */
  readonly nativeResources?: Readonly<
    Record<string, readonly NativeResourceRef[]>
  >;
  /** Override the outputs an apply returns for a resourceId. */
  readonly outputs?: Readonly<Record<string, JsonObject>>;
}

export class FakeOpentofuRunPort implements OpentofuRunPort {
  readonly planRequests: OpentofuRunRequest[] = [];
  readonly applyRequests: OpentofuRunRequest[] = [];
  readonly importRequests: OpentofuImportRequest[] = [];
  readonly observeRequests: OpentofuRunRequest[] = [];
  readonly refreshRequests: OpentofuRunRequest[] = [];
  readonly destroyRequests: OpentofuDestroyRequest[] = [];
  readonly #overrides: FakeOpentofuRunPortOverrides;
  #seq = 0;

  constructor(overrides: FakeOpentofuRunPortOverrides = {}) {
    this.#overrides = overrides;
  }

  plan(request: OpentofuRunRequest): Promise<OpentofuRunResult> {
    this.planRequests.push(request);
    const nativeResources = this.#nativeResources(request);
    return Promise.resolve({
      runId: `plan_${++this.#seq}`,
      summary: `plan ${request.moduleTemplate}: create ${nativeResources.length} resource(s)`,
      nativeResources,
      outputs: {},
    });
  }

  apply(request: OpentofuRunRequest): Promise<OpentofuRunResult> {
    this.applyRequests.push(request);
    return Promise.resolve({
      runId: `apply_${++this.#seq}`,
      summary: `apply ${request.moduleTemplate}`,
      nativeResources: this.#nativeResources(request),
      outputs: this.#outputs(request),
    });
  }

  importResource(request: OpentofuImportRequest): Promise<OpentofuRunResult> {
    this.importRequests.push(request);
    return Promise.resolve({
      runId: `import_${++this.#seq}`,
      summary: `import ${request.importAddress}`,
      nativeResources: [
        { type: request.importAddress.split(".")[0]!, id: request.nativeId },
      ],
      outputs: this.#outputs(request),
    });
  }

  observe(request: OpentofuRunRequest): Promise<OpentofuObserveResult> {
    this.observeRequests.push(request);
    return Promise.resolve({
      runId: `observe_${++this.#seq}`,
      status: "current",
      summary: `observe ${request.moduleTemplate}: current`,
    });
  }

  refresh(request: OpentofuRunRequest): Promise<OpentofuRunResult> {
    this.refreshRequests.push(request);
    return Promise.resolve({
      runId: `refresh_${++this.#seq}`,
      summary: `refresh ${request.moduleTemplate}`,
      nativeResources: this.#nativeResources(request),
      outputs: this.#outputs(request),
    });
  }

  destroy(request: OpentofuDestroyRequest): Promise<OpentofuRunResult> {
    this.destroyRequests.push(request);
    return Promise.resolve({
      runId: `destroy_${++this.#seq}`,
      summary: `destroy ${request.nativeResources.length} resource(s)`,
      nativeResources: [],
      outputs: {},
    });
  }

  #nativeResources(request: OpentofuRunRequest): readonly NativeResourceRef[] {
    const override = this.#overrides.nativeResources?.[request.resourceId];
    if (override) return override;
    let id = request.resourceId;
    if (isNonEmptyString(request.inputs.appName)) {
      id = request.inputs.appName;
    } else if (isNonEmptyString(request.inputs.endpointName)) {
      id = request.inputs.endpointName;
    }
    const type = `${request.providerBinding.provider}_resource`;
    return [{ type, id }];
  }

  #outputs(request: OpentofuRunRequest): JsonObject {
    const override = this.#overrides.outputs?.[request.resourceId];
    if (override) return override;
    const outputs: JsonObject = {};
    for (const output of request.publicOutputs) {
      outputs[output.name] =
        output.type === "json"
          ? {}
          : `fake://${request.resourceId}/${output.name}`;
    }
    return outputs;
  }
}
