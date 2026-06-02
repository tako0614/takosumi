// ApplyService adapter over DeploymentService.
//
// The deploy lifecycle is represented by two operations on the Deployment
// record:
//
//   - `applyDeployment(id)`  — promote `resolved` → `applied`
//   - `rollbackGroup(id)`    — point a GroupHead at a prior Deployment
//
// Existing call-sites instantiate `ApplyService` and call `applySourcePayload` /
// `applyPlan` / `rollbackToDeployment`; those method names route to the
// canonical service.
//
// Shape-model dispatch (apply_v2)
// -------------------------------
// Legacy source payloads may carry `resources[]` and dispatch to `applyV2`.
// Internal plan/apply call-sites still use `ApplyService` method names while
// their authoring layer is being folded behind the same service boundary.
// Top-level `template` shorthand is intentionally rejected here; template /
// compiler layers must submit expanded `resources[]`.

import type {
  ActorContext,
  Deployment,
  DeploymentApproval,
  DeploymentInput,
  GroupHead,
  IsoTimestamp,
  JsonObject,
} from "takosumi-contract/reference/compat";
import type { PlatformContext } from "takosumi-contract/internal/provider-adapter";
import type { PlatformOperationRecoveryMode } from "takosumi-contract/reference/runtime-agent-lifecycle";
import { objectAddress } from "takosumi-contract/reference/compat";
import type { ManifestResource } from "./_internal_manifest_types.ts";
import {
  applyV2,
  type ApplyV2Outcome,
  type OperationPlanPreview,
  type PriorAppliedSnapshot,
} from "./apply_v2.ts";
import type { OperationJournalStore } from "./operation_journal.ts";
import {
  type DeploymentFilter,
  DeploymentService,
  type DeploymentServiceOptions,
  type DeploymentStore,
} from "./deployment_service.ts";
import { PlanService, type PlanServiceOptions } from "./plan_service.ts";
import type { DeployBlocker, ReferenceDeploySourcePayload } from "./types.ts";

export interface ApplyDeploySourcePayloadInput {
  spaceId: string;
  manifest: ReferenceDeploySourcePayload;
  env?: string;
  envName?: string;
  input?: DeploymentInput;
  createdAt?: IsoTimestamp;
  createdBy?: string;
  actor?: ActorContext;
  approval?: DeploymentApproval;
  blockers?: readonly DeployBlocker[];
  /**
   * Optional legacy `resources[]` dispatch (`apply_v2`) hand-off fields. The
   * deploy facade resolves these from prior Deployment state and the
   * caller's recovery context before invoking `applySourcePayload`. Plumbing
   * them all the way down to `applyV2` is what enables idempotent
   * replace, recovery-mode escalation, and WAL-tied operation context
   * for the legacy resources dispatch path.
   */
  operationPlanPreview?: OperationPlanPreview;
  recoveryMode?: PlatformOperationRecoveryMode;
  priorApplied?: ReadonlyMap<string, PriorAppliedSnapshot>;
  deploymentName?: string;
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
   * Populated only when the source payload was dispatched through the legacy `resources[]`
   * (`apply_v2`) pipeline. The `head` field is omitted in that case because
   * v2 records resource state directly instead of advancing a GroupHead.
   */
  readonly v2Outcome?: ApplyV2Outcome;
}

/**
 * Subset of {@link PlatformContext} ports needed to construct the context
 * passed to `applyV2`. `refResolver` and `resolvedOutputs` are filled in by
 * `apply_v2` itself per resource; this options bag carries the shared ports.
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
   * Adapters required to construct a `PlatformContext` for the legacy `resources[]`
   * (`apply_v2`) dispatch path. When omitted, source payloads using `resources[]`
   * fail with a clear error.
   */
  platformAdapters?: PlatformContextAdapters;
  /** Tenant id surfaced into `PlatformContext.tenantId` (defaults to spaceId). */
  tenantId?: string;
  /**
   * Durable operation journal (WAL). When supplied, the legacy `resources[]` dispatch
   * path threads it into `applyV2` so that `prepare`/`commit` stage records are
   * written around the provider apply loop, making the idempotency tuple
   * durable. The journal only records stages when the dispatch also has an
   * `operationPlanPreview` to derive the tuple from. Bootstrap resolves the
   * store (in-memory / SQL) and passes it here; omitting it preserves the
   * previous journal-less behavior.
   */
  operationJournalStore?: OperationJournalStore;
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
  readonly #operationJournalStore?: OperationJournalStore;

  constructor(options: ApplyServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#applyBlockerProvider = options.applyBlockerProvider;
    this.#platformAdapters = options.platformAdapters;
    this.#tenantId = options.tenantId;
    this.#operationJournalStore = options.operationJournalStore;
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
   * Resolve a reference deploy source payload into a Deployment, then immediately apply it.
   *
   * Internal legacy source payloads use `resources` as an array and dispatch
   * through `apply_v2`. Top-level authoring shortcuts are retired and must not
   * cross this boundary.
   */
  async applySourcePayload(
    input: ApplyDeploySourcePayloadInput,
  ): Promise<ApplyDeployResult> {
    assertNoRetiredAuthoringShorthand(input.manifest);
    if (sourcePayloadUsesShapeModel(input.manifest)) {
      return await this.#applySourcePayloadV2(input);
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
  // Legacy resources[] dispatch (apply_v2)
  // ---------------------------------------------------------------------

  async #applySourcePayloadV2(
    input: ApplyDeploySourcePayloadInput,
  ): Promise<ApplyDeployResult> {
    if (!this.#platformAdapters) {
      throw new Error(
        "ApplyService.applySourcePayload: legacy resources[] source payload detected " +
          "(`resources` array or `template`) but no `platformAdapters` " +
          "were configured. Wire `secrets` / `observability` / `kms` / " +
          "`objectStorage` adapters into `ApplyServiceOptions`.",
      );
    }
    const resources = resolveSourcePayloadResources(input.manifest);
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const context = createPlatformContext({
      tenantId: this.#tenantId ?? input.spaceId,
      spaceId: input.spaceId,
      adapters: this.#platformAdapters,
    });
    // Forward the optional legacy resources dispatch fields when the caller
    // supplied them. Until a stable persistence layer for prior apply
    // snapshots exists on `DeploymentStore`, the deploy facade is the only
    // way idempotency dedupe / replace-on-mismatch / WAL-bound operation
    // context reach `applyV2` from this entry point. If `priorApplied` is
    // not threaded through by the caller, `applyV2` runs with idempotency
    // dedupe disabled for this dispatch (each apply re-invokes
    // `provider.apply`). See `apply_v2.ts:ApplyV2Options.priorApplied`.
    const outcome = await applyV2({
      resources,
      context,
      ...(input.operationPlanPreview
        ? { operationPlanPreview: input.operationPlanPreview }
        : {}),
      ...(input.recoveryMode ? { recoveryMode: input.recoveryMode } : {}),
      ...(input.priorApplied ? { priorApplied: input.priorApplied } : {}),
      // Durable WAL: only threaded when bootstrap supplied a journal store.
      // `applyV2` no-ops on the journal unless an `operationPlanPreview` is
      // also present, so this is safe to always forward.
      ...(this.#operationJournalStore
        ? { operationJournalStore: this.#operationJournalStore }
        : {}),
      ...(input.deploymentName
        ? { deploymentName: input.deploymentName }
        : (typeof input.manifest.name === "string" &&
            input.manifest.name.length > 0
          ? { deploymentName: input.manifest.name }
          : {})),
    });
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
 * `true` when the input uses the legacy deploy-domain `resources[]` model.
 * Manifestless v1 install/deploy does not use this path.
 */
function sourcePayloadUsesShapeModel(manifest: ReferenceDeploySourcePayload): boolean {
  const m = manifest as Record<string, unknown>;
  if (Array.isArray(m.resources)) return true;
  return false;
}

function assertNoRetiredAuthoringShorthand(
  manifest: ReferenceDeploySourcePayload,
): void {
  const m = manifest as Record<string, unknown>;
  if (m.template !== undefined) {
    throw new Error(
      "ApplyService.applySourcePayload: top-level authoring shortcut is retired; " +
        "submit internal `resources[]` instead",
    );
  }
}

function resolveSourcePayloadResources(
  manifest: ReferenceDeploySourcePayload,
): readonly ManifestResource[] {
  const m = manifest as Record<string, unknown>;
  if (Array.isArray(m.resources)) {
    return m.resources as readonly ManifestResource[];
  }
  throw new Error("ApplyService: legacy resources[] source payload requires `resources[]`");
}

const NOOP_REF_RESOLVER: PlatformContext["refResolver"] = {
  resolve(_expression: string) {
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
  readonly manifest: ReferenceDeploySourcePayload;
  readonly createdAt: IsoTimestamp;
  readonly appliedAt: IsoTimestamp;
  readonly input?: DeploymentInput;
  readonly approval?: DeploymentApproval;
  readonly outcome: ApplyV2Outcome;
}): Deployment {
  const groupId = typeof input.manifest.name === "string" &&
      input.manifest.name.length > 0
    ? input.manifest.name
    : `shape-${"model"}-${input.id}`;
  const manifestSnapshot = JSON.stringify(input.manifest);
  const deploymentInput: DeploymentInput = input.input ?? {
    manifest_snapshot: manifestSnapshot,
    source_kind: "inline",
  };
  // Synthetic v2 deployments do not derive a real digest from a closure /
  // graph / network policy / activation envelope. Earlier code used the
  // sentinel string "sha256:empty", which broke any downstream consumer
  // that validated the digest with a hex regex
  // (`sha256:[0-9a-f]{64}`). We instead emit a zero-padded 64-char marker
  // that satisfies the regex while still being recognizable as "no
  // closure was computed". This is preferable to hashing an empty buffer
  // because the marker is self-documenting in evidence logs.
  const emptyDigest =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const;
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
