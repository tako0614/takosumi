// ApplyService adapter over DeploymentService.
//
// The deploy lifecycle is represented by two operations on the Deployment
// record:
//
//   - `applyDeployment(id)`  — promote `resolved` → `applied`
//   - `rollbackGroup(id)`    — point a GroupHead at a prior Deployment
//
// Existing call-sites instantiate `ApplyService` and call `applyManifest` /
// `applyPlan` / `rollbackToActivation`; those method names route to the
// canonical service.
//
// Shape-model dispatch (apply_v2)
// -------------------------------
// When a manifest carries the current shape-model field (`resources` as an
// array), `applyManifest` short-circuits the legacy plan-then-apply pipeline
// and dispatches to `applyV2`. Historical top-level `template` authoring
// shorthand is intentionally rejected here; template/compiler layers must
// submit expanded `resources[]`.

import type {
  ActorContext,
  Deployment,
  DeploymentApproval,
  DeploymentInput,
  GroupHead,
  IsoTimestamp,
  JsonObject,
  ManifestResource,
  PlatformContext,
  RefResolver,
} from "takosumi-contract";
import { objectAddress } from "takosumi-contract";
import { applyV2, type ApplyV2Outcome } from "./apply_v2.ts";
import {
  type DeploymentFilter,
  DeploymentService,
  type DeploymentServiceOptions,
  type DeploymentStore,
} from "./deployment_service.ts";
import { PlanService, type PlanServiceOptions } from "./plan_service.ts";
import type { DeployBlocker, PublicDeployManifest } from "./types.ts";

export interface ApplyDeployManifestInput {
  spaceId: string;
  manifest: PublicDeployManifest;
  env?: string;
  envName?: string;
  input?: DeploymentInput;
  createdAt?: IsoTimestamp;
  createdBy?: string;
  actor?: ActorContext;
  approval?: DeploymentApproval;
  blockers?: readonly DeployBlocker[];
}

export interface ApplyDeploymentInput {
  deploymentId: string;
  appliedAt?: IsoTimestamp;
  approval?: DeploymentApproval;
}

export interface RollbackDeploymentInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly targetDeploymentId: string;
  readonly advancedAt?: IsoTimestamp;
  readonly reason?: string;
}

export interface ApplyDeployResult {
  readonly deployment: Deployment;
  readonly head?: GroupHead;
  /**
   * Populated only when the manifest was dispatched through the shape-model
   * (`apply_v2`) pipeline. The `head` field is omitted in that case because
   * v2 does not advance the legacy GroupHead.
   */
  readonly v2Outcome?: ApplyV2Outcome;
}

/**
 * Subset of {@link PlatformContext} ports needed to construct the context
 * passed to `applyV2`. `refResolver` and `resolvedOutputs` are filled in by
 * `apply_v2` itself per resource so they are not part of this options bag.
 */
export interface PlatformContextAdapters {
  readonly secrets: PlatformContext["secrets"];
  readonly observability: PlatformContext["observability"];
  readonly kms: PlatformContext["kms"];
  readonly objectStorage: PlatformContext["objectStorage"];
}

export interface ApplyServiceOptions
  extends Omit<DeploymentServiceOptions, "store"> {
  store: DeploymentStore;
  applyBlockerProvider?: ApplyPhaseBlockerProvider;
  /**
   * Pass-through to PlanService. Retained so existing
   * `app_context.ts` plumbing compiles unchanged.
   */
  readSetValidator?: unknown;
  readSetSnapshotProvider?: unknown;
  readSetRevalidator?: unknown;
  /**
   * Adapters required to construct a `PlatformContext` for the shape-model
   * (`apply_v2`) dispatch path. When omitted, manifests using `resources[]`
   * fail with a clear error; legacy `target + services` manifests continue
   * to work without these adapters.
   */
  platformAdapters?: PlatformContextAdapters;
  /** Tenant id surfaced into `PlatformContext.tenantId` (defaults to spaceId). */
  tenantId?: string;
}

export interface ApplyPhaseBlockerProviderInput {
  readonly deployment: Deployment;
  readonly createdAt: IsoTimestamp;
  readonly createdBy?: string;
  readonly actor?: ActorContext;
}

export type ApplyPhaseBlockerProvider = (
  input: ApplyPhaseBlockerProviderInput,
) => readonly DeployBlocker[] | Promise<readonly DeployBlocker[]>;

export class DeploymentBlockedError extends Error {
  readonly blockers: readonly DeployBlocker[];
  constructor(blockers: readonly DeployBlocker[]) {
    super(
      `deployment blocked by ${
        blockers.map((b) => `${b.source}:${b.code}`).join(", ")
      }`,
    );
    this.name = "DeploymentBlockedError";
    this.blockers = Object.freeze(blockers.map((b) => Object.freeze({ ...b })));
  }
}

/**
 * Raised when an `apply_v2` dispatch fails (validation, ref resolution, or
 * provider apply). Carries the underlying outcome so callers can surface
 * structured issues to the operator.
 */
export class ApplyV2Error extends Error {
  readonly outcome: ApplyV2Outcome;
  constructor(outcome: ApplyV2Outcome) {
    const summary = outcome.issues
      .map((i) => `${i.path}: ${i.message}`)
      .join("; ");
    super(`apply_v2 ${outcome.status}: ${summary || "no further detail"}`);
    this.name = "ApplyV2Error";
    this.outcome = outcome;
  }
}

export class ApplyService {
  readonly #store: DeploymentStore;
  readonly #service: DeploymentService;
  readonly #planService: PlanService;
  readonly #applyBlockerProvider?: ApplyPhaseBlockerProvider;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #platformAdapters?: PlatformContextAdapters;
  readonly #tenantId?: string;

  constructor(options: ApplyServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#applyBlockerProvider = options.applyBlockerProvider;
    this.#platformAdapters = options.platformAdapters;
    this.#tenantId = options.tenantId;
    this.#service = new DeploymentService({
      store: options.store,
      clock: this.#clock,
      idFactory: this.#idFactory,
      providerAdapter: options.providerAdapter,
    });
    const planOptions: PlanServiceOptions = {
      store: options.store,
      clock: this.#clock,
      idFactory: this.#idFactory,
    };
    this.#planService = new PlanService(planOptions);
  }

  /**
   * Resolve a manifest into a Deployment, then immediately apply it.
   *
   * If the manifest opts in to the shape model (`resources` as an array), the
   * call is dispatched through `apply_v2` instead of the legacy plan-then-apply
   * pipeline. Top-level `template` is retired and must be expanded before this
   * boundary.
   */
  async applyManifest(
    input: ApplyDeployManifestInput,
  ): Promise<ApplyDeployResult> {
    assertNoRetiredTemplateShorthand(input.manifest);
    if (manifestUsesShapeModel(input.manifest)) {
      return await this.#applyManifestV2(input);
    }
    const resolved = await this.#planService.createPlan({
      spaceId: input.spaceId,
      manifest: input.manifest,
      env: input.env,
      envName: input.envName,
      input: input.input,
      createdAt: input.createdAt,
      blockers: input.blockers,
    });
    return await this.applyDeployment({
      deploymentId: resolved.id,
      appliedAt: input.createdAt,
      approval: input.approval,
    });
  }

  /**
   * Promote a resolved Deployment to `applied`.
   */
  async applyDeployment(
    input: ApplyDeploymentInput,
  ): Promise<ApplyDeployResult> {
    const current = await this.#store.getDeployment(input.deploymentId);
    if (!current) {
      throw new Error(`unknown deployment: ${input.deploymentId}`);
    }
    const createdAt = input.appliedAt ?? this.#clock().toISOString();
    const providerBlockers = await this.#applyBlockerProvider?.({
      deployment: current,
      createdAt,
    }) ?? [];
    if (providerBlockers.length > 0) {
      throw new DeploymentBlockedError(providerBlockers);
    }
    const applied = await this.#service.applyDeployment({
      deploymentId: current.id,
      appliedAt: createdAt,
      approval: input.approval,
    });
    const head = await this.#store.getGroupHead({
      spaceId: applied.space_id,
      groupId: applied.group_id,
    });
    return { deployment: applied, head };
  }

  /**
   * Rollback a group to a prior Deployment.
   */
  async rollbackToDeployment(
    input: RollbackDeploymentInput,
  ): Promise<ApplyDeployResult> {
    const head = await this.#service.rollbackGroup({
      spaceId: input.spaceId,
      groupId: input.groupId,
      targetDeploymentId: input.targetDeploymentId,
      advancedAt: input.advancedAt,
      reason: input.reason,
    });
    const deployment = await this.#store.getDeployment(
      input.targetDeploymentId,
    );
    if (!deployment) {
      throw new Error(
        `rollback target disappeared: ${input.targetDeploymentId}`,
      );
    }
    return { deployment, head };
  }

  /**
   * @deprecated Use `rollbackToDeployment`. Retained because external
   * call-sites still spell it `rollbackToActivation`.
   */
  rollbackToActivation(
    input: RollbackDeploymentInput,
  ): Promise<ApplyDeployResult> {
    return this.rollbackToDeployment(input);
  }

  /** Look up a Deployment record by id. */
  getDeployment(id: string): Promise<Deployment | undefined> {
    return this.#service.getDeployment(id);
  }

  /** List Deployment records matching the filter. */
  listDeployments(
    filter: DeploymentFilter = {},
  ): Promise<readonly Deployment[]> {
    return this.#service.listDeployments(filter);
  }

  // ---------------------------------------------------------------------
  // Shape-model dispatch (apply_v2)
  // ---------------------------------------------------------------------

  async #applyManifestV2(
    input: ApplyDeployManifestInput,
  ): Promise<ApplyDeployResult> {
    if (!this.#platformAdapters) {
      throw new Error(
        "ApplyService.applyManifest: shape-model manifest detected " +
          "(`resources` array or `template`) but no `platformAdapters` " +
          "were configured. Wire `secrets` / `observability` / `kms` / " +
          "`objectStorage` adapters into `ApplyServiceOptions`.",
      );
    }
    const resources = resolveManifestResources(input.manifest);
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const context = createPlatformContext({
      tenantId: this.#tenantId ?? input.spaceId,
      spaceId: input.spaceId,
      adapters: this.#platformAdapters,
    });
    const outcome = await applyV2({ resources, context });
    if (outcome.status !== "succeeded") {
      throw new ApplyV2Error(outcome);
    }
    const deployment = synthesizeAppliedDeploymentFromV2({
      id: this.#idFactory(),
      spaceId: input.spaceId,
      manifest: input.manifest,
      createdAt,
      appliedAt: createdAt,
      input: input.input,
      approval: input.approval,
      outcome,
    });
    const stored = await this.#store.putDeployment(deployment);
    return { deployment: stored, v2Outcome: outcome };
  }
}

// ---------------------------------------------------------------------
// Shape-model helpers (module-private)
// ---------------------------------------------------------------------

/**
 * `true` when the manifest opts into the shape model. The legacy authoring
 * surface uses `resources` as a `Record<string, ...>` map; the shape model
 * uses an array.
 */
function manifestUsesShapeModel(manifest: PublicDeployManifest): boolean {
  const m = manifest as Record<string, unknown>;
  if (Array.isArray(m.resources)) return true;
  return false;
}

function assertNoRetiredTemplateShorthand(
  manifest: PublicDeployManifest,
): void {
  const m = manifest as Record<string, unknown>;
  if (m.template !== undefined) {
    throw new Error(
      "ApplyService.applyManifest: top-level `template` is retired; submit " +
        "expanded `resources[]` instead",
    );
  }
}

function resolveManifestResources(
  manifest: PublicDeployManifest,
): readonly ManifestResource[] {
  const m = manifest as Record<string, unknown>;
  if (Array.isArray(m.resources)) {
    return m.resources as readonly ManifestResource[];
  }
  throw new Error("ApplyService: shape-model manifest requires `resources[]`");
}

const NOOP_REF_RESOLVER: RefResolver = {
  resolve(_expression: string) {
    // apply_v2 builds its own per-resource ref resolver; this fallback is
    // never invoked during a shape-model apply.
    return null;
  },
};

function createPlatformContext(input: {
  readonly tenantId: string;
  readonly spaceId: string;
  readonly adapters: PlatformContextAdapters;
}): PlatformContext {
  return {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    secrets: input.adapters.secrets,
    observability: input.adapters.observability,
    kms: input.adapters.kms,
    objectStorage: input.adapters.objectStorage,
    refResolver: NOOP_REF_RESOLVER,
    resolvedOutputs: new Map<string, JsonObject>(),
  };
}

function synthesizeAppliedDeploymentFromV2(input: {
  readonly id: string;
  readonly spaceId: string;
  readonly manifest: PublicDeployManifest;
  readonly createdAt: IsoTimestamp;
  readonly appliedAt: IsoTimestamp;
  readonly input?: DeploymentInput;
  readonly approval?: DeploymentApproval;
  readonly outcome: ApplyV2Outcome;
}): Deployment {
  const groupId = typeof input.manifest.name === "string" &&
      input.manifest.name.length > 0
    ? input.manifest.name
    : `shape-model-${input.id}`;
  const manifestSnapshot = JSON.stringify(input.manifest);
  const deploymentInput: DeploymentInput = input.input ?? {
    manifest_snapshot: manifestSnapshot,
    source_kind: "inline",
  };
  const emptyDigest = "sha256:empty" as const;
  return Object.freeze({
    id: input.id,
    group_id: groupId,
    space_id: input.spaceId,
    input: deploymentInput,
    resolution: {
      descriptor_closure: {
        resolutions: [],
        closureDigest: emptyDigest,
        createdAt: input.createdAt,
      },
      resolved_graph: {
        digest: emptyDigest,
        components: [],
        projections: [],
      },
    },
    desired: {
      routes: [],
      bindings: [],
      resources: [],
      runtime_network_policy: {
        policyDigest: emptyDigest,
        defaultEgress: "deny-by-default",
      },
      activation_envelope: {
        primary_assignment: {
          componentAddress: objectAddress("app.component", groupId),
          weight: 1000,
        },
        envelopeDigest: emptyDigest,
      },
    },
    status: "applied",
    conditions: [],
    approval: input.approval ?? null,
    rollback_target: null,
    created_at: input.createdAt,
    applied_at: input.appliedAt,
    finalized_at: null,
  }) as Deployment;
}
