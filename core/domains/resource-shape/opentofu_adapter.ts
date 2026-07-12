// REAL opentofu-adapter for the Resource Shape API.
//
// `docs/internal/final-plan.md` §9/§17 ("opentofu-adapter broad first"): a resolved
// Resource Shape is materialized by LOWERING it to an internal OpenTofu module
// call and driving the EXISTING Flow A runner (Source / Capsule / Run /
// StateVersion / Output), instead of a bespoke per-provider SDK path. This file
// owns ONLY that lowering + result mapping; the run lifecycle stays inside
// deploy-control behind the `OpentofuRunPort` seam, so the adapter is unit
// testable without a live runner or cloud.
//
// Layering:
//   ResourceShapeService -> OpentofuResourceShapeAdapter (this file)
//                        -> OpentofuRunPort (seam)
//                        -> ControllerOpentofuRunPort -> OpenTofuDeploymentController (Flow A)
//
// The adapter is the only piece that knows ResourceShape/Target vocabulary; the
// port speaks plain "run this generated root with these inputs and this
// ProviderBinding". The RunEngine coupling is isolated to
// `ControllerOpentofuRunPort` and is fully replaceable by `FakeOpentofuRunPort`.
//
// ---------------------------------------------------------------------------
// SOURCE-LESS SYNTHETIC RUN: SEAM / BLOCKER (read before wiring this in prod)
// ---------------------------------------------------------------------------
// The current deploy-control public API does NOT support a fully Source-less,
// Capsule-less synthetic run. `OpenTofuDeploymentController.createPlanRun`
// (core/domains/deploy-control/run-engine/run_engine.ts ~L376) requires an
// existing Capsule: `requestCapsuleId = request.capsuleId ?? request.installationId`
// is resolved through `#requireInstallation` and the call fails closed with
// "plan requires an existing capsuleId (create the Capsule first)" when absent
// (run_engine.ts ~L396-401). It also reads the Capsule's InstallConfig,
// workspace, environment, and current StateVersion for the run's identity,
// policy, and TOCTOU guard.
//
// Consequence: a Resource Shape `apply` cannot, today, dispatch a run purely
// from `plan.moduleFiles`. The Resource needs a BACKING internal Capsule.
// `ControllerOpentofuRunPort` therefore takes a `resolveCapsuleBinding` seam:
// the Resource Shape integration must provision (once, idempotently) a backing
// Capsule per Resource and a `ProviderBinding` mapping `provider -> connectionId`
// (== `credentialRef`), then hand its `{ workspaceId, capsuleId, source }` back.
// `genericRootDispatch.generatedRoot.moduleFiles` then OVERRIDES whatever source
// that Capsule was registered with (run_engine.ts ~L573-585 uses the supplied
// generic dispatch verbatim and skips SourceSnapshot module materialization),
// so the Capsule is just a durable identity/policy/state anchor — the actual
// HCL is the Resource Shape plan's first-party module.
//
// MINIMAL deploy-control change to remove the seam (NOT done here — owned by the
// deploy-control owner): add a Source-less synthetic plan entry point, e.g.
// `createSyntheticPlanRun({ workspaceId, resourceId, generatedRoot, inputs,
// providerBindings, runnerProfileId })` that allocates an ephemeral
// Resource-Shape-owned Capsule (or a first-class `Resource` run subject) instead
// of requiring `request.capsuleId` to pre-exist, mints credentials from the
// supplied `providerBindings` rather than from a stored Capsule
// `ProviderBindingSet`, and records StateVersion/Output against the Resource id.
// Everything downstream (policy, runner dispatch, output capture) already keys
// off `generatedRoot` and would be reused unchanged.

import type {
  ActorContext,
  JsonObject,
  JsonValue,
  NativeResourceRef,
  ResourceDeletePolicy,
  TargetPoolEntry,
  TargetType,
} from "takosumi-contract";
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  DeploymentOutput,
  DispatchGeneratedRoot,
  OpenTofuModuleSource,
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
  generateGenericCapsuleRoot,
  type RootInstallationProviderEnvBinding,
} from "takosumi-rootgen";
import { canonicalProviderAddress } from "@takosumi/providers";
import type {
  AdapterApplyInput,
  AdapterApplyResult,
  AdapterDeleteInput,
  AdapterPreviewResult,
  ResourceAdapter,
} from "./adapter.ts";
import type { ResourceShapePublicOutput } from "./planner.ts";

// ---------------------------------------------------------------------------
// OpentofuRunPort: the few run operations the adapter needs. Keeping this narrow
// (and free of shape-specific vocabulary) is what isolates the RunEngine coupling.
// ---------------------------------------------------------------------------

/** OpenTofu provider mapping for one resolved Target. */
export interface OpentofuProviderBinding {
  /** OpenTofu provider local name, e.g. `cloudflare`, `aws`, `google`. */
  readonly provider: string;
  /** Canonical registry source, e.g. `registry.opentofu.org/cloudflare/cloudflare`. */
  readonly providerSource: string;
  readonly alias?: string;
  /**
   * Optional provider API base URL selected by the Target implementation.
   * Managed compatibility profiles use this to route an existing provider
   * through an operator-owned endpoint. It is capability/TargetPool data, not
   * a Cloud edition branch in the provider binary.
   */
  readonly baseUrl?: string;
  /**
   * ProviderConnection id whose credentials the runner mints for this provider.
   * Undefined when no Takosumi-managed credential is bound (the generated root
   * stays credential-free and relies on ambient runner env, if any).
   */
  readonly connectionId?: string;
}

/** Plan/apply a lowered Resource Shape implementation through Flow A. */
export interface OpentofuRunRequest {
  /** Canonical resource id (`tkrn:{space}:{kind}:{name}`). */
  readonly resourceId: string;
  /** First-party module template id, e.g. `cloudflare-worker-service`. */
  readonly templateId: string;
  /** The first-party module's HCL files (child module materialized by the runner). */
  readonly moduleFiles: readonly {
    readonly path: string;
    readonly text: string;
  }[];
  /** Module variable values, already augmented (accountId/region) and JSON-coerced. */
  readonly inputs: Readonly<Record<string, JsonValue>>;
  /** Typed public OpenTofu outputs projected from the module (`tofu output -json`). */
  readonly publicOutputs: readonly ResourceShapePublicOutput[];
  readonly providerBinding: OpentofuProviderBinding;
  readonly actor: ActorContext;
}

/** Destroy a previously materialized Resource Shape implementation. */
export interface OpentofuDestroyRequest {
  readonly resourceId: string;
  /** Re-generated implementation plan. Present for OpenTofu-backed shapes. */
  readonly templateId?: string;
  readonly moduleFiles?: readonly {
    readonly path: string;
    readonly text: string;
  }[];
  readonly inputs?: Readonly<Record<string, JsonValue>>;
  readonly publicOutputs?: readonly ResourceShapePublicOutput[];
  readonly providerBinding: OpentofuProviderBinding;
  /** Native resources recorded for the Resource (audit / scope only). */
  readonly nativeResources: readonly NativeResourceRef[];
  readonly deletePolicy?: ResourceDeletePolicy;
  readonly actor: ActorContext;
}

export interface OpentofuRunResult {
  /** Underlying Flow A Run id, when one was created. */
  readonly runId?: string;
  readonly summary: string;
  readonly nativeResources: readonly NativeResourceRef[];
  readonly outputs: JsonObject;
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
  destroy(request: OpentofuDestroyRequest): Promise<OpentofuRunResult>;
}

// ---------------------------------------------------------------------------
// Target type -> OpenTofu provider mapping + input augmentation.
// ---------------------------------------------------------------------------

const PROVIDER_LOCAL_NAME_BY_TARGET_TYPE: Readonly<
  Partial<Record<TargetType, string>>
> = Object.freeze({
  cloudflare: "cloudflare",
  aws: "aws",
  gcp: "google",
});

const PROVIDER_SOURCE_BY_LOCAL_NAME: Readonly<Record<string, string>> =
  Object.freeze({
    cloudflare: "cloudflare/cloudflare",
    aws: "hashicorp/aws",
    google: "hashicorp/google",
  });

/** Map a resolved Target type to the OpenTofu provider local name. */
export function providerLocalNameForTargetType(type: TargetType): string {
  return PROVIDER_LOCAL_NAME_BY_TARGET_TYPE[type] ?? type;
}

/** Canonical registry source for an OpenTofu provider local name. */
export function providerSourceForLocalName(localName: string): string {
  return canonicalProviderAddress(
    PROVIDER_SOURCE_BY_LOCAL_NAME[localName] ?? localName,
  );
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

/**
 * Augment the planner's module inputs with Target-derived values the planner may
 * not have emitted (`docs/internal/final-plan.md` §8): Cloudflare-backed modules often
 * need `accountId` (carried by the TargetPool entry `ref`); AWS-backed modules
 * commonly take a `region` from the Target. Existing non-empty values are never
 * overwritten.
 */
export function augmentInputsForTarget(
  rawInputs: Readonly<Record<string, unknown>>,
  target: TargetPoolEntry,
): Record<string, JsonValue> {
  const inputs = normalizeJsonInputs(rawInputs);
  if (target.type === "cloudflare") {
    if (!isNonEmptyString(inputs.accountId) && isNonEmptyString(target.ref)) {
      inputs.accountId = target.ref;
    }
  } else if (target.type === "aws") {
    if (!isNonEmptyString(inputs.region) && isNonEmptyString(target.region)) {
      inputs.region = target.region;
    }
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// OpentofuResourceShapeAdapter: ResourceAdapter -> OpentofuRunPort.
// ---------------------------------------------------------------------------

/**
 * The OpenTofu Resource Shape adapter (id `opentofu`). It maps a resolved
 * shape plan + Target to an {@link OpentofuRunRequest} (provider, augmented inputs,
 * threaded moduleFiles/templateId, ProviderConnection), drives the
 * {@link OpentofuRunPort}, and maps the run result back to the
 * {@link ResourceAdapter} contract.
 */
export class OpentofuResourceShapeAdapter implements ResourceAdapter {
  readonly id = "opentofu";
  readonly #port: OpentofuRunPort;

  constructor(port: OpentofuRunPort) {
    this.#port = port;
  }

  async preview(input: AdapterApplyInput): Promise<AdapterPreviewResult> {
    assertNoImplementationPlugin(input.implementationPlugin, this.id);
    const request = this.#runRequest(input);
    const result = await this.#port.plan(request);
    return {
      summary: result.summary,
      nativeResources: result.nativeResources,
      ...(result.runId ? { runId: result.runId } : {}),
    };
  }

  async apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    assertNoImplementationPlugin(input.implementationPlugin, this.id);
    const request = this.#runRequest(input);
    const result = await this.#port.apply(request);
    return {
      nativeResources: result.nativeResources,
      outputs: result.outputs,
      ...(result.runId ? { runId: result.runId } : {}),
    };
  }

  async delete(input: AdapterDeleteInput): Promise<void> {
    // `retain` keeps the native resources; `block` should have been refused by
    // the service before reaching the adapter — either way we never destroy.
    if (input.deletePolicy === "retain" || input.deletePolicy === "block") {
      return;
    }
    assertNoImplementationPlugin(input.implementationPlugin, this.id);
    const provider = providerLocalNameForTargetType(input.target.type);
    await this.#port.destroy({
      resourceId: input.resourceId,
      ...(input.plan
        ? {
            templateId: input.plan.templateId,
            moduleFiles: input.plan.moduleFiles,
            inputs: augmentInputsForTarget(input.plan.inputs, input.target),
            publicOutputs: input.plan.publicOutputs,
          }
        : {}),
      providerBinding: {
        provider,
        providerSource: providerSourceForLocalName(provider),
        ...providerBindingOptionsFor(input.implementationOptions),
        ...(input.credentialRef ? { connectionId: input.credentialRef } : {}),
      },
      nativeResources: input.nativeResources,
      ...(input.deletePolicy ? { deletePolicy: input.deletePolicy } : {}),
      actor: input.actor,
    });
  }

  #runRequest(input: AdapterApplyInput): OpentofuRunRequest {
    const provider = providerLocalNameForTargetType(input.target.type);
    return {
      resourceId: input.resourceId,
      templateId: input.plan.templateId,
      moduleFiles: input.plan.moduleFiles,
      inputs: augmentInputsForTarget(input.plan.inputs, input.target),
      publicOutputs: input.plan.publicOutputs,
      providerBinding: {
        provider,
        providerSource: providerSourceForLocalName(provider),
        ...providerBindingOptionsFor(input.implementationOptions),
        // The opentofu-adapter injects the bound ProviderConnection (the Target's
        // credentialRef) into the runner per-run; absent means no managed cred.
        ...(input.credentialRef ? { connectionId: input.credentialRef } : {}),
      },
      actor: input.actor,
    };
  }
}

function assertNoImplementationPlugin(
  implementationPlugin: string | undefined,
  adapterId: string,
): void {
  if (!implementationPlugin) return;
  throw new Error(
    `implementation plugin ${implementationPlugin} requires a plugin-aware Resource Shape adapter; ${adapterId} cannot execute it`,
  );
}

// ---------------------------------------------------------------------------
// Result mapping helpers (shared by the real port and reusable by integrators).
// ---------------------------------------------------------------------------

/**
 * Map runner plan-JSON resource changes (`tofu show -json tfplan`) to
 * NativeResourceRefs. `no-op` / pure `delete` changes are skipped so a preview
 * reports the resources the apply WILL own. `type` is the OpenTofu resource type
 * (e.g. `cloudflare_r2_bucket`); `id` is the plan address (the stable handle
 * before apply assigns a provider id).
 */
export function nativeResourcesFromPlanChanges(
  changes: readonly PlanResourceChange[] | undefined,
): readonly NativeResourceRef[] {
  if (!changes) return [];
  const refs: NativeResourceRef[] = [];
  for (const change of changes) {
    const actions = change.actions ?? [];
    const isPureDelete =
      actions.length > 0 && actions.every((a) => a === "delete");
    const isNoOp = actions.length === 0 || actions.every((a) => a === "no-op");
    if (isPureDelete || isNoOp) continue;
    refs.push({ type: change.type, id: change.address });
  }
  return refs;
}

/** Map captured Deployment outputs (`tofu output -json`) to a JsonObject. */
export function outputsFromDeploymentOutputs(
  outputs: readonly DeploymentOutput[] | undefined,
): JsonObject {
  const result: JsonObject = {};
  for (const output of outputs ?? []) result[output.name] = output.value;
  return result;
}

// ---------------------------------------------------------------------------
// ControllerOpentofuRunPort: REAL implementation backed by Flow A.
// ---------------------------------------------------------------------------

/** Backing Capsule identity for a Resource (see the SEAM/BLOCKER note above). */
export interface ResourceCapsuleBinding {
  readonly workspaceId: string;
  readonly capsuleId: string;
  /**
   * Nominal Source for the run row. `generatedRoot.moduleFiles` overrides the
   * actual module materialization, so this is just the recorded Source identity
   * (e.g. a `local` placeholder pointing at the Resource Shape module catalog).
   */
  readonly source: OpenTofuModuleSource;
  readonly runnerProfileId?: string;
  /**
   * StateVersion the destroy plan should target. Threaded onto the destroy run
   * subject when the integration drives destroy through `createPlanRun` rather
   * than `createInstallationDestroyPlan`.
   */
  readonly currentStateVersionId?: string | null;
}

/**
 * The exact deploy-control surface the real port drives. `OpenTofuDeploymentController`
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
   * Resolve the backing Capsule for a Resource. This is the SEAM that works
   * around the "createPlanRun requires a pre-existing Capsule" blocker without
   * touching deploy-control internals (see the file header). The integration
   * must provision the Capsule + its `provider -> connectionId` ProviderBinding.
   */
  readonly resolveCapsuleBinding: (
    request: OpentofuRunRequest | OpentofuDestroyRequest,
  ) => Promise<ResourceCapsuleBinding> | ResourceCapsuleBinding;
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
  readonly #resolveCapsuleBinding: ControllerOpentofuRunPortDeps["resolveCapsuleBinding"];
  readonly #drive: boolean;
  readonly #pollIntervalMs: number;
  readonly #waitTimeoutMs: number;

  constructor(deps: ControllerOpentofuRunPortDeps) {
    this.#driver = deps.driver;
    this.#resolveCapsuleBinding = deps.resolveCapsuleBinding;
    this.#drive = deps.driveRunsSynchronously ?? true;
    this.#pollIntervalMs = deps.pollIntervalMs ?? 1000;
    this.#waitTimeoutMs = deps.waitTimeoutMs ?? 60_000;
  }

  async plan(request: OpentofuRunRequest): Promise<OpentofuRunResult> {
    const binding = await this.#resolveCapsuleBinding(request);
    const planRun = await this.#createAndDrivePlan(request, binding, "create");
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
    const binding = await this.#resolveCapsuleBinding(request);
    const planRun = await this.#createAndDrivePlan(request, binding, "create");
    const nativeResources = nativeResourcesFromPlanChanges(
      planRun.planResourceChanges,
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
    return {
      runId: applyRun.id,
      summary: `applied ${nativeResources.length} native resource(s) for ${request.resourceId}`,
      nativeResources,
      outputs: outputsFromDeploymentOutputs(applyRun.outputs),
    };
  }

  async destroy(request: OpentofuDestroyRequest): Promise<OpentofuRunResult> {
    const binding = await this.#resolveCapsuleBinding(request);
    // Destroy must replay the same generated root used to create the resource.
    // The backing Capsule is only an identity/state anchor, so its nominal local
    // Source is not executable by itself.
    const generatedRootDispatch =
      request.templateId &&
      request.moduleFiles &&
      request.inputs &&
      request.publicOutputs
        ? this.#genericRootDispatch({
            resourceId: request.resourceId,
            templateId: request.templateId,
            moduleFiles: request.moduleFiles,
            inputs: request.inputs,
            publicOutputs: request.publicOutputs,
            providerBinding: request.providerBinding,
            actor: request.actor,
          })
        : undefined;
    const planResponse = await this.#driver.createPlanRun(
      {
        workspaceId: binding.workspaceId,
        capsuleId: binding.capsuleId,
        source: binding.source,
        operation: "destroy",
        ...(request.inputs ? { variables: request.inputs } : {}),
        requiredProviders: [request.providerBinding.providerSource],
        ...(binding.runnerProfileId
          ? { runnerProfileId: binding.runnerProfileId }
          : {}),
      },
      { actor: request.actor.actorAccountId },
      generatedRootDispatch
        ? { genericRootDispatch: generatedRootDispatch }
        : undefined,
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
        confirmDestructive: true,
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
    binding: ResourceCapsuleBinding,
    operation: CreatePlanRunRequest["operation"],
  ): Promise<PublicPlanRun> {
    const response = await this.#driver.createPlanRun(
      {
        workspaceId: binding.workspaceId,
        capsuleId: binding.capsuleId,
        source: binding.source,
        ...(operation ? { operation } : {}),
        variables: request.inputs,
        requiredProviders: [request.providerBinding.providerSource],
        ...(binding.runnerProfileId
          ? { runnerProfileId: binding.runnerProfileId }
          : {}),
      },
      { actor: request.actor.actorAccountId },
      { genericRootDispatch: this.#genericRootDispatch(request) },
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
   * Build the generic-Capsule generated root that carries the Resource Shape
   * module. `genericRootDispatch` overrides the engine's own source-derived root
   * (run_engine.ts ~L573-585): the first-party `moduleFiles` become the child
   * `template-module`, inputs are baked as literals, and `publicOutputs` are
   * projected for `tofu output -json` capture.
   */
  #genericRootDispatch(
    request: OpentofuRunRequest,
  ): GenericRootDispatchContext {
    const outputAllowlist = outputAllowlistFromPublicOutputs(
      request.publicOutputs,
    );
    const providerEnvBindings = providerEnvBindingsFor(request.providerBinding);
    const generatedRoot = generateGenericCapsuleRoot({
      requiredProviders: [request.providerBinding.providerSource],
      inputs: request.inputs,
      outputAllowlist,
      ...(providerEnvBindings.length > 0 ? { providerEnvBindings } : {}),
    });
    const dispatch: DispatchGeneratedRoot = {
      files: generatedRoot.files,
      moduleFiles: request.moduleFiles.map((file) => ({
        path: file.path,
        text: file.text,
      })),
    };
    const providerCredentialDelivery = providerCredentialDeliveryFor(
      request.providerBinding,
    );
    return {
      generatedRoot: dispatch,
      outputAllowlist,
      ...(providerCredentialDelivery ? { providerCredentialDelivery } : {}),
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
function providerEnvBindingsFor(
  binding: OpentofuProviderBinding,
): readonly RootInstallationProviderEnvBinding[] {
  if (!binding.connectionId && !binding.baseUrl) return [];
  const credentialDelivery = providerCredentialDeliveryFor(binding);
  return [
    {
      provider: binding.providerSource,
      ...(binding.alias ? { alias: binding.alias } : {}),
      ...(credentialDelivery ? { credentialDelivery } : {}),
      ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
    },
  ];
}

function providerCredentialDeliveryFor(
  binding: OpentofuProviderBinding,
): RootInstallationProviderEnvBinding["credentialDelivery"] | undefined {
  if (!binding.connectionId && !binding.baseUrl) return undefined;
  return binding.baseUrl ? "provider_env" : "generated_root_variable";
}

function providerBindingOptionsFor(
  implementationOptions: JsonObject | undefined,
): Pick<OpentofuProviderBinding, "baseUrl"> {
  const baseUrl = implementationOptions?.providerBaseUrl;
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return {};
  return { baseUrl: baseUrl.trim() };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const capsuleId = planRun.capsuleId ?? planRun.installationId;
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
    ...(planRun.resolvedProviderEnvBindingsDigest
      ? {
          resolvedProviderEnvBindingsDigest:
            planRun.resolvedProviderEnvBindingsDigest,
        }
      : {}),
    ...(planRun.providerCredentialDelivery
      ? { providerCredentialDelivery: planRun.providerCredentialDelivery }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// FakeOpentofuRunPort: deterministic in-memory port for unit tests. It never
// touches deploy-control, a runner, or a cloud — it records each request and
// returns plausible results derived from the request (native resources by
// provider/template, outputs from the public output names).
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
      summary: `plan ${request.templateId}: create ${nativeResources.length} resource(s)`,
      nativeResources,
      outputs: {},
    });
  }

  apply(request: OpentofuRunRequest): Promise<OpentofuRunResult> {
    this.applyRequests.push(request);
    return Promise.resolve({
      runId: `apply_${++this.#seq}`,
      summary: `apply ${request.templateId}`,
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
    const type =
      request.providerBinding.provider === "cloudflare"
        ? "cloudflare_resource"
        : request.providerBinding.provider === "aws"
          ? "aws_resource"
          : `${request.providerBinding.provider}_resource`;
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
