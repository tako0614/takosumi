/**
 * Persistence boundary for the control-plane ledger (core-spec.md §27).
 *
 * The logical schema is the Workspace-owned OpenTofu Capsule DAG model: workspaces,
 * sources(+snapshots), connections(+secret blobs), install_configs,
 * capsules (active UNIQUE(project_id, name, environment)), provider binding sets,
 * a SINGLE `runs` table (internal PlanRun / ApplyRun / SourceSyncRun records
 * persist as rows discriminated by run kind; the public §19 Run is a
 * projection), StateVersions, and Outputs.
 *
 * The in-memory implementation is for dev/test only. Production/staging hosts
 * inject the SQL store or the D1 store, both of which materialize the §27
 * tables.
 */
import type {
  ApplyRun,
  ProviderConnection,
  DispatchStateAdoption,
  DispatchGeneratedRoot,
  InstallConfig,
  Capsule,
  PlanRun,
  RunnerProfile,
  RunStatus,
  StateVersion,
} from "@takosumi/internal/deploy-control-api";
import { coerceRunStatus } from "@takosumi/internal/deploy-control-api";
import type {
  CapsuleCompatibilityLevel,
  CapsuleCompatibilityReport,
} from "takosumi-contract/capsules";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import type { Project } from "takosumi-contract/projects";
import type { ProviderBindingSet } from "takosumi-contract/connections";
import type {
  InstallConfigLifecycleAction,
  OutputAllowlistEntry,
  SourceBuildConfig,
} from "takosumi-contract/install-configs";
import type {
  Dependency,
  DependencySnapshot,
  SealedDependencyValues,
} from "takosumi-contract/dependencies";
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  type ActivityEvent,
} from "takosumi-contract/activity";
import {
  type Page,
  type PageParams,
  pageSorted,
  pageSortedBy,
  pageSortedDesc,
} from "takosumi-contract/pagination";
import type { OutputShare, Output } from "takosumi-contract/outputs";
import {
  RUN_LIST_DEFAULT_LIMIT,
  RUN_LIST_MAX_LIMIT,
  type ArtifactRecord,
  type ResourceOperation,
  type Run,
  type RunGroup,
} from "takosumi-contract/runs";
import type { BackupRecord } from "takosumi-contract/backups";
import type { UsageEvent } from "takosumi-contract/billing";
import { usageEventUsdMicros } from "takosumi-contract/billing";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "takosumi-contract/security";
import type {
  InstalledFormReference,
  JsonObject,
  JsonValue,
  NativeResourceRef,
} from "takosumi-contract";
import {
  installedFormReferenceKey,
  isInstalledFormReference,
} from "takosumi-contract";
import { currentRuntime } from "../../shared/runtime/index.ts";
import { log } from "../../shared/log.ts";

export interface CapsuleListPageParams extends PageParams {
  readonly includeDestroyed?: boolean;
}

/** Validates the current persisted compatibility enum and fails closed. */
export function normalizeStoredCapsuleCompatibilityLevel(
  level: unknown,
): CapsuleCompatibilityLevel {
  if (level === "ready" || level === "needs_patch" || level === "unsupported") {
    return level;
  }
  throw new TypeError(`invalid Capsule compatibility level: ${String(level)}`);
}

/** Validates a persisted report against the current public contract. */
export function normalizeStoredCapsuleCompatibilityReport(
  report: CapsuleCompatibilityReport,
): CapsuleCompatibilityReport {
  if (!report.sourceId?.trim()) {
    throw new TypeError(
      "CapsuleCompatibilityReport must reference a registered Git Source",
    );
  }
  normalizeStoredCapsuleCompatibilityLevel(
    (report as { readonly level: unknown }).level,
  );
  return report;
}

/**
 * Internal (non-public) plan inputs persisted alongside a PlanRun so the queue
 * consumer can re-run the plan after the create call returns. The public PlanRun
 * deliberately keeps only `variablesDigest`; the values live here and are never
 * projected into the public ledger. Removed when the run reaches a terminal
 * state.
 */
export interface PlanRunInputs {
  readonly planRunId: string;
  readonly variables: Readonly<Record<string, JsonValue>>;
  /** Optional child-module wrapper generated from DB/provider configuration. */
  readonly generatedRoot?: DispatchGeneratedRoot;
  /** Resource Shape-only operator module; never sourced from Capsule input. */
  readonly operatorModule?: {
    readonly files: readonly {
      readonly path: string;
      readonly text: string;
    }[];
  };
  /** Confirmed one-shot Resource state adoption; never part of a public Run. */
  readonly stateAdoption?: DispatchStateAdoption;
  /** Workspace-local, non-secret capture selection; never a public projection. */
  readonly workspaceOutputAllowlist?: Readonly<
    Record<string, OutputAllowlistEntry>
  >;
  /** Explicit InstallConfig projection for UI/public Output reads. */
  readonly outputAllowlist?: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly sourceBuild?: SourceBuildConfig;
  readonly lifecycleActions?: readonly InstallConfigLifecycleAction[];
  /**
   * At-rest seal of the SENSITIVE-bearing sidecar payload (spec §11 / §18). A
   * sensitive `published_output` value injected into a plan flows into
   * `variables` AND is baked as a literal into the generic Capsule's generated
   * `main.tf`; either would persist as a cleartext ledger value here. When a
   * sensitive value was injected, the controller seals `{ variables,
   * generatedRoot, outputAllowlist }` into this blob with the SAME AES-GCM
   * envelope used for state / plan / dependency-value artifacts and leaves the
   * cleartext fields empty/absent on the row; it unseals transparently at
   * plan/apply dispatch. The store only ever sees the ciphertext.
   */
  readonly sealed?: SealedDependencyValues;
}

/**
 * Sealed credential blob persisted alongside (but separate from) the public
 * ProviderConnection record. The plaintext is the JSON of `{ [envName]: value }`
 * encrypted as ONE blob via the secret-boundary crypto. The store only ever
 * sees ciphertext; it never decrypts.
 */
/**
 * Opaque encryption-partition token persisted with the sealed blob.
 *
 * Historical rows may contain provider-labelled values. New writes use the
 * connection's explicit `secretPartition`; Core must never grow a provider or
 * auth-flow enum merely to persist encrypted bytes.
 */
export type StoredSecretBlobKind = string;

export interface StoredSecretBlob {
  readonly id: string;
  readonly connectionId: string;
  readonly workspaceId?: string;
  readonly kind: StoredSecretBlobKind;
  /** Base64 of the sealed bytes (the crypto prepends the nonce to the ciphertext). */
  readonly ciphertext: string;
  /** Wrapped/encrypted DEK label for the current secret-boundary crypto scheme. */
  readonly encryptedDek: string;
  /** Base64 of the nonce (also embedded in `ciphertext`); kept for blob clarity. */
  readonly nonce: string;
  /** JSON-encoded additional-authenticated-data fields bound into the seal. */
  readonly aad: string;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly rotatedAt?: string;
}

/**
 * Persisted Source record. Extends the public {@link Source} with internal fields
 * that are NEVER projected into the public API:
 *   - `hookSecretHash` — SHA-256 of the per-source webhook bearer (the plaintext
 *     is returned exactly once at creation and never stored).
 *   - `lastSeenCommit` — last commit the scheduler/webhook observed via a
 *     `source_sync`; used to skip re-syncing when the ref has not moved.
 *   - `autoSync` — whether the scheduler should poll this source.
 */
export interface StoredSource extends Source {
  readonly hookSecretHash: string;
  readonly lastSeenCommit?: string;
  readonly autoSync: boolean;
}

export interface CapsuleStateVersionGuard {
  readonly currentStateVersionId: string | undefined;
  readonly status?: Capsule["status"];
}

export class CapsuleStateVersionGuardConflict extends Error {
  readonly expectedCurrentStateVersionId: string | undefined;
  readonly actualCurrentStateVersionId: string | undefined;
  readonly expectedStatus?: Capsule["status"];
  readonly actualStatus?: Capsule["status"];

  constructor(input: {
    readonly id: string;
    readonly expectedCurrentStateVersionId: string | undefined;
    readonly actualCurrentStateVersionId: string | undefined;
    readonly expectedStatus?: Capsule["status"];
    readonly actualStatus?: Capsule["status"];
  }) {
    super(
      `Capsule ${input.id} currentStateVersionId guard lost the race: ` +
        `expected ${input.expectedCurrentStateVersionId ?? "<none>"} but row ` +
        `is now ${input.actualCurrentStateVersionId ?? "<none>"}` +
        (input.expectedStatus === undefined
          ? ""
          : `; status expected ${input.expectedStatus} but row is ${input.actualStatus}`),
    );
    this.name = "CapsuleStateVersionGuardConflict";
    this.expectedCurrentStateVersionId = input.expectedCurrentStateVersionId;
    this.actualCurrentStateVersionId = input.actualCurrentStateVersionId;
    this.expectedStatus = input.expectedStatus;
    this.actualStatus = input.actualStatus;
  }
}

export class CapsuleStateGenerationGuardConflict extends Error {
  readonly expectedCurrentStateGeneration: number;
  readonly actualCurrentStateGeneration: number;
  readonly expectedStatus?: Capsule["status"];
  readonly actualStatus?: Capsule["status"];

  constructor(input: {
    readonly id: string;
    readonly expectedCurrentStateGeneration: number;
    readonly actualCurrentStateGeneration: number;
    readonly expectedStatus?: Capsule["status"];
    readonly actualStatus?: Capsule["status"];
  }) {
    super(
      `Capsule ${input.id} currentStateGeneration guard lost the race: ` +
        `expected ${input.expectedCurrentStateGeneration} but row is ` +
        `${input.actualCurrentStateGeneration}` +
        (input.expectedStatus === undefined
          ? ""
          : `; status expected ${input.expectedStatus} but row is ${input.actualStatus}`),
    );
    this.name = "CapsuleStateGenerationGuardConflict";
    this.expectedCurrentStateGeneration = input.expectedCurrentStateGeneration;
    this.actualCurrentStateGeneration = input.actualCurrentStateGeneration;
    this.expectedStatus = input.expectedStatus;
    this.actualStatus = input.actualStatus;
  }
}

export interface CommitRunStateResult {
  readonly capsule?: Capsule;
  /**
   * The apply run no longer holds the expected lease fence. No commit writes were
   * applied; callers must treat this as a stale worker/no-op.
   */
  readonly applyRunLeaseLost?: true;
}

export type PublicHostReservationStatus = "reserved" | "released";
export type ManagedPublicHostnameReservationKind = "scoped" | "vanity";

export interface PublicHostReservation {
  readonly hostname: string;
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly capsuleName: string;
  readonly allocationKind: ManagedPublicHostnameReservationKind;
  readonly status: PublicHostReservationStatus;
  readonly reservedAt: string;
  readonly updatedAt: string;
  readonly releasedAt?: string;
}

export interface ReservePublicHostInput {
  readonly hostname: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly capsuleName: string;
  readonly allocationKind: ManagedPublicHostnameReservationKind;
  /** Omitted means the operator does not limit owner vanity slots. */
  readonly vanitySlotLimit?: number;
  readonly now: string;
}

export type ReservePublicHostResult =
  | {
      readonly reserved: true;
      readonly reservation: PublicHostReservation;
    }
  | {
      readonly reserved: false;
      readonly reason: "already_reserved";
      readonly reservation: PublicHostReservation;
    }
  | {
      readonly reserved: false;
      readonly reason: "owner_slot_limit_reached";
      readonly vanitySlotLimit: number;
    };

/** Fields a controller may patch on a Capsule row. */
export type CapsulePatch = Partial<
  Pick<
    Capsule,
    | "currentStateVersionId"
    | "currentStateGeneration"
    | "currentOutputId"
    | "compatibilityReportId"
    | "compatibilityStatus"
    | "status"
    | "autoUpdate"
    | "autoUpdateAttemptSourceSnapshotId"
    | "updatedAt"
  >
>;

/**
 * Atomic provider-applied ledger commit: Run + StateVersion + Output. The
 * terminal Run may be failed and Capsule `error` when a pinned post-apply
 * lifecycle action did not terminal-succeed; provider state is still retained.
 */
export interface CommitRunStateInput {
  readonly stateVersion: StateVersion;
  readonly output?: Output;
  readonly capsulePatch: {
    readonly id: string;
    readonly patch: CapsulePatch;
    readonly guard: CapsuleStateVersionGuard;
  };
  /** Terminal apply / destroy-apply Run committed with StateVersion/Output. */
  readonly applyRunTerminal?: ApplyRun;
  /**
   * Fence token held by the worker attempting to commit `applyRunTerminal`.
   * A mismatch means a stale worker lost ownership; stores return
   * `{ applyRunLeaseLost: true }` without writing any part of the apply ledger.
   */
  readonly applyRunLeaseToken?: string;
  /**
   * Source PlanRun with its `appliedApplyRunId` marker (apply-once).
   */
  readonly planRunApplied?: PlanRun;
}

/** Atomic terminal commit for a first-class Resource apply/destroy Run. */
export interface CommitResourceRunInput {
  readonly applyRunTerminal: ApplyRun;
  readonly planRunApplied: PlanRun;
  readonly applyRunLeaseToken: string;
}

export interface CommitResourceRunResult {
  readonly applyRunLeaseLost?: true;
}

export interface CommitRestoredStateResult {
  readonly capsule?: Capsule;
  /**
   * The restore run no longer holds the expected lease fence. No restore ledger
   * writes were applied; callers must treat this as a stale worker/no-op.
   */
  readonly restoreRunLeaseLost?: true;
}

export interface CommitRestoredStateInput {
  readonly stateVersion: StateVersion;
  readonly capsulePatch: {
    readonly id: string;
    readonly patch: CapsulePatch;
    readonly guard: {
      readonly currentStateGeneration: number;
      readonly status?: Capsule["status"];
    };
  };
  readonly restoreRunTerminal: Run;
  readonly restoreRunLeaseToken: string;
}

/**
 * Status-conditional, lease-fenced compare-and-set transition of a single run
 * row (the most correctness-critical primitive of the queue consumer). Unlike
 * {@link OpenTofuControlStore.putPlanRun} / `putApplyRun` (which INSERT/upsert
 * the initial creation), `transitionRun` is the post-insert mutation: it advances
 * a run's `status` (and lease/heartbeat) ONLY when the row still matches the
 * pre-read expectation, so two consumers racing the same `queued → running`
 * claim cannot both win.
 *
 *   - `id` / `kind` — the row to transition; `kind` selects the run family
 *     (`plan` PlanRun rows, `apply` ApplyRun rows, `source_sync`
 *     SourceSyncRun rows, or `restore` backup/restore rows) so the discriminator
 *     can't be crossed.
 *   - `expectFrom` — the set of statuses the row MUST currently be in for the
 *     CAS to fire. A row whose status is outside this set loses (`won: false`).
 *   - `expectLeaseToken` — when set, the CAS additionally requires the row's
 *     current `leaseToken` to equal this value (a stale fence token loses). When
 *     unset, the lease column is NOT part of the predicate.
 *   - `expectHeartbeatAt` — when set, the CAS additionally requires the row's
 *     current heartbeat column to equal this value (`null` means absent). This
 *     fences stale-`running` takeovers so only the first consumer that observed
 *     the stale heartbeat can re-claim the run.
 *   - `expectStartedAt` — when set, the CAS additionally requires the persisted
 *     run payload's `startedAt` to equal this value (`null` means absent). This
 *     lets cancellation distinguish a never-started queued row from the same
 *     run requeued after execution already began.
 *   - `run` — the new run payload to persist on a win; its `status` is the SET
 *     target (the row's status column + run JSON both move to `run.status`).
 *   - `setLeaseToken` / `clearLeaseToken` — the lease column write on a win:
 *     `setLeaseToken` stamps a new fence token, `clearLeaseToken` nulls it.
 *     Mutually exclusive; omit both to leave the lease column unchanged.
 *   - `clearHeartbeat` — clears both the indexed heartbeat column and the
 *     persisted run JSON's heartbeat on a win. Used when a retryable runner reset
 *     parks a run back at `queued`.
 *   - `heartbeatAt` — when provided, the heartbeat column (and the persisted run
 *     JSON's `heartbeatAt`) move to this value on a win; omit to take the
 *     heartbeat carried on `run`.
 *
 * Returns `{ won: true, run }` with the post-transition run on a win, or
 * `{ won: false, run }` with the RE-READ current row on a lost race (so callers
 * observe the winning transition instead of clobbering it); `run` is absent only
 * when the row truly vanished.
 */
export interface TransitionRunInput {
  readonly id: string;
  readonly kind: "plan" | "apply" | "source_sync" | "restore";
  readonly expectFrom: readonly RunStatus[];
  readonly expectLeaseToken?: string;
  readonly expectHeartbeatAt?: number | null;
  readonly expectStartedAt?: number | string | null;
  readonly run: PlanRun | ApplyRun | SourceSyncRun | Run;
  readonly setLeaseToken?: string;
  readonly clearLeaseToken?: boolean;
  readonly clearHeartbeat?: boolean;
  readonly heartbeatAt?: number;
}

export interface TransitionRunResult {
  readonly won: boolean;
  readonly run?: PlanRun | ApplyRun | SourceSyncRun | Run;
}

export type StoredRunRecord = PlanRun | ApplyRun | SourceSyncRun | Run;

/**
 * Canonical single-ledger Run used only for direct Resource adapter plugins.
 * Module-backed OpenTofu adapters continue to own their existing plan/apply
 * Resource Runs and must never create this second row.
 */
export type ResourceOperationRun = Run & {
  readonly subject: { readonly kind: "resource"; readonly id: string };
  readonly resourceOperation: ResourceOperation;
  /**
   * Exact immutable Form identity for a pinned Resource operation. Missing
   * only on direct-operation Runs created before exact FormRef migration.
   */
  readonly resourceForm?: InstalledFormReference;
  readonly resourceOperationKey: string;
  readonly resourceOperationVersion: number;
  readonly resourceOperationResult?: ResourceOperationResultEvidence;
  readonly resourceOperationAudit?: ResourceOperationAuditEvidence;
};

/** Internal restart-safe direct-adapter result; never projected publicly. */
export interface ResourceOperationResultEvidence {
  readonly summary: string;
  /** Exact Form identity repeated with replayable backend evidence. */
  readonly resourceForm?: InstalledFormReference;
  readonly nativeResources?: readonly NativeResourceRef[];
  readonly outputs?: JsonObject;
  readonly observationStatus?: "current" | "drifted" | "missing";
  /** Opaque backend correlation evidence only; never a canonical Run id. */
  readonly backendOperationId?: string;
}

/** Internal durable Activity outbox carried by the single Run row. */
export interface ResourceOperationAuditEvidence {
  readonly status: "pending" | "completed";
  readonly eventId: string;
  readonly action: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
}

export type BeginResourceOperationRunResult =
  | { readonly status: "created"; readonly run: ResourceOperationRun }
  | { readonly status: "existing"; readonly run: ResourceOperationRun }
  | { readonly status: "conflict"; readonly run?: ResourceOperationRun };

export interface TransitionResourceOperationRunInput {
  readonly id: string;
  readonly operationKey: string;
  readonly expectedVersion: number;
  readonly expectFrom: readonly RunStatus[];
  readonly run: ResourceOperationRun;
}

export interface TransitionResourceOperationRunResult {
  readonly won: boolean;
  readonly run?: ResourceOperationRun;
}

export interface RecoverableResourceOperationRunListOptions {
  readonly workspaceId?: string;
  readonly limit?: number;
}

export interface RecoverableOpenTofuRunListOptions {
  readonly staleQueuedBeforeMs: number;
  readonly staleRunningBeforeMs: number;
  readonly limit?: number;
}

/**
 * Durable runtime-safety projection derived from the single Run ledger.
 * Interface authorization consults this value at the capability boundary, so
 * correctness never depends solely on an in-process terminal-run observer.
 */
export type CapsuleRuntimeSafety =
  | {
      readonly phase: "safe";
      readonly runId: string;
      readonly runType: "apply" | "restore";
    }
  | {
      readonly phase: "unknown";
      readonly runId: string;
      readonly runType: "apply" | "destroy_apply" | "restore";
    }
  | {
      readonly phase: "terminating";
      readonly runId: string;
      readonly runType: "destroy_apply";
    }
  | {
      readonly phase: "retired";
      readonly runId: string;
      readonly runType: "destroy_apply";
    };

/**
 * Durable post-commit billing-finalization markers carried by the ApplyRun
 * ledger row itself. `pending` is committed atomically with provider state;
 * `completed` is appended only after the idempotent host capture succeeds.
 */
export const APPLY_BILLING_CAPTURE_PENDING_EVENT =
  "billing.capture.pending" as const;
export const APPLY_BILLING_CAPTURE_COMPLETED_EVENT =
  "billing.capture.completed" as const;

export function applyRunBillingCapturePending(run: ApplyRun): boolean {
  let latestPending = -1;
  let latestCompleted = -1;
  for (let index = 0; index < run.auditEvents.length; index += 1) {
    const type = run.auditEvents[index]?.type;
    if (type === APPLY_BILLING_CAPTURE_PENDING_EVENT) latestPending = index;
    if (type === APPLY_BILLING_CAPTURE_COMPLETED_EVENT) latestCompleted = index;
  }
  return latestPending > latestCompleted;
}

export interface OpenTofuControlStore {
  /** Declares whether ledger writes survive process restart. */
  readonly persistence: "durable" | "ephemeral";
  putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile>;
  getRunnerProfile(id: string): Promise<RunnerProfile | undefined>;
  listRunnerProfiles(): Promise<readonly RunnerProfile[]>;

  // Internal run records. PHYSICALLY these persist into the single §27 `runs`
  // table (discriminated by run kind: plan/destroy_plan rows for PlanRun,
  // apply/destroy_apply rows for ApplyRun, source_sync rows for SourceSyncRun);
  // the typed accessors stay so the controller keeps its internal shapes.
  putPlanRun(run: PlanRun): Promise<PlanRun>;
  getPlanRun(id: string): Promise<PlanRun | undefined>;

  // Internal (non-public) plan inputs for the queue consumer. Never projected.
  putPlanRunInputs(inputs: PlanRunInputs): Promise<void>;
  getPlanRunInputs(planRunId: string): Promise<PlanRunInputs | undefined>;
  deletePlanRunInputs(planRunId: string): Promise<void>;

  putApplyRun(run: ApplyRun): Promise<ApplyRun>;
  getApplyRun(id: string): Promise<ApplyRun | undefined>;

  /**
   * Status-conditional, lease-fenced compare-and-set transition of a run row.
   * The post-insert mutation primitive: advances a run's status (+ lease /
   * heartbeat) ONLY when the row still matches `expectFrom` (and, when set, the
   * `expectLeaseToken` fence). See {@link TransitionRunInput} for the win/lose
   * contract; a lost race re-reads and returns the current row with `won: false`.
   */
  transitionRun(input: TransitionRunInput): Promise<TransitionRunResult>;

  // SourceSyncRun ledger records (rows of `runs` with kind source_sync).
  putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun>;
  getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined>;
  listSourceSyncRuns(sourceId: string): Promise<readonly SourceSyncRun[]>;
  putCompatibilityCheckRun(run: Run): Promise<Run>;
  getCompatibilityCheckRun(id: string): Promise<Run | undefined>;
  /** Insert-only start for a deterministic direct Resource adapter Run. */
  beginResourceOperationRun(
    run: ResourceOperationRun,
  ): Promise<BeginResourceOperationRunResult>;
  getResourceOperationRun(
    id: string,
  ): Promise<ResourceOperationRun | undefined>;
  /** Version- and status-fenced transition; terminal outcomes are never upserted. */
  transitionResourceOperationRun(
    input: TransitionResourceOperationRunInput,
  ): Promise<TransitionResourceOperationRunResult>;
  /** Running sagas and terminal Runs with a pending audit outbox. */
  listRecoverableResourceOperationRuns(
    options?: RecoverableResourceOperationRunListOptions,
  ): Promise<readonly ResourceOperationRun[]>;
  putBackupRun(run: Run): Promise<Run>;
  getBackupRun(id: string): Promise<Run | undefined>;
  listRunsByWorkspace(
    workspaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly StoredRunRecord[]>;
  /** Latest decisive mutation for runtime Interface safety, if one exists. */
  getCapsuleRuntimeSafety(
    capsuleId: string,
  ): Promise<CapsuleRuntimeSafety | undefined>;
  /**
   * Internal scheduler safety net read: returns oldest-first dispatchable
   * non-terminal OpenTofu rows plus terminal provider-applied rows whose durable
   * billing finalization marker is still pending. This is intentionally not the
   * public newest-first run list, because repair must find very old work even
   * when it is far outside dashboard pagination.
   */
  listRecoverableOpenTofuRuns(
    options: RecoverableOpenTofuRunListOptions,
  ): Promise<readonly StoredRunRecord[]>;

  // Artifact ledger rows (spec §30 artifacts). Artifact bytes live in object
  // storage; these rows keep non-secret run-scoped pointers for audit and
  // backup/export manifests.
  putArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord>;
  listArtifactRecordsForRun(runId: string): Promise<readonly ArtifactRecord[]>;

  // Workspace records (spec §4). The owner namespace Capsules live under.
  putWorkspace(workspace: Workspace): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  listWorkspacesByIds(ids: readonly string[]): Promise<readonly Workspace[]>;
  getWorkspaceByHandle(handle: string): Promise<Workspace | undefined>;
  listWorkspaces(): Promise<readonly Workspace[]>;
  /**
   * Lists only the Workspaces directly owned by `ownerUserId` (spec §4), same
   * `(createdAt, id)` sort as `listWorkspaces`. Used by the dashboard session
   * `GET /api/v1/workspaces` to scope the read to the caller's spaces instead of
   * loading every tenant's Workspace and filtering in the route.
   */
  listWorkspacesByOwner(ownerUserId: string): Promise<readonly Workspace[]>;

  // Canonical Workspace membership ledger. The Workspace namespace owner is
  // persisted as an ordinary active owner member on Workspace creation.
  putWorkspaceMember(member: WorkspaceMember): Promise<WorkspaceMember>;
  getWorkspaceMember(
    workspaceId: string,
    accountId: string,
  ): Promise<WorkspaceMember | undefined>;
  listWorkspaceMembers(
    workspaceId: string,
  ): Promise<readonly WorkspaceMember[]>;
  listWorkspaceMembersByAccount(
    accountId: string,
  ): Promise<readonly WorkspaceMember[]>;

  // Workspace-owned Project records. Capsules reference one Project id.
  putProject(project: Project): Promise<Project>;
  getProject(id: string): Promise<Project | undefined>;
  getProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<Project | undefined>;
  listProjectsByWorkspace(workspaceId: string): Promise<readonly Project[]>;

  // InstallConfig records. `workspaceId` absent = operator-shared config.
  putInstallConfig(config: InstallConfig): Promise<InstallConfig>;
  getInstallConfig(id: string): Promise<InstallConfig | undefined>;
  listInstallConfigs(workspaceId?: string): Promise<readonly InstallConfig[]>;

  // Capsule records (active UNIQUE(project_id, name, environment)).
  putCapsule(capsule: Capsule): Promise<Capsule>;
  getCapsule(id: string): Promise<Capsule | undefined>;
  getCapsuleByName(
    projectId: string,
    name: string,
    environment: string,
  ): Promise<Capsule | undefined>;
  listCapsules(workspaceId?: string): Promise<readonly Capsule[]>;
  /**
   * Keyset-paged Capsule listing (spec §30 list route). Pages by the
   * existing `(createdAt, id)` sort; returns at most `params.limit` (default /
   * cap {@link MAX_PAGE_LIMIT}) rows plus an opaque `nextCursor` when more exist.
   */
  listCapsulesPage(
    workspaceId: string,
    params: CapsuleListPageParams,
  ): Promise<Page<Capsule>>;
  reservePublicHost(
    input: ReservePublicHostInput,
  ): Promise<ReservePublicHostResult>;
  getPublicHostReservation(
    hostname: string,
  ): Promise<PublicHostReservation | undefined>;
  releasePublicHostsForCapsule(capsuleId: string, now: string): Promise<void>;
  patchCapsule(
    id: string,
    patch: CapsulePatch,
    guard?: CapsuleStateVersionGuard,
  ): Promise<Capsule | undefined>;

  /** Atomically commits terminal Run + StateVersion + optional Output + Capsule cursor. */
  commitRunState(input: CommitRunStateInput): Promise<CommitRunStateResult>;
  commitResourceRun(
    input: CommitResourceRunInput,
  ): Promise<CommitResourceRunResult>;

  commitRestoredState(
    input: CommitRestoredStateInput,
  ): Promise<CommitRestoredStateResult>;

  // ProviderConnection records (public fields) + their sealed secret blobs. The blob is
  // stored in a separate namespace so the public ProviderConnection can be listed
  // without ever touching ciphertext.
  putConnection(connection: ProviderConnection): Promise<ProviderConnection>;
  getConnection(id: string): Promise<ProviderConnection | undefined>;
  listConnections(workspaceId: string): Promise<readonly ProviderConnection[]>;
  /** Keyset-paged Workspace ProviderConnection listing (spec §30 connection list route). */
  listConnectionsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<ProviderConnection>>;
  /**
   * Lists instance-wide `operator`-scoped Connections (no owning Workspace). Backs
   * the §30 operator-scope `GET /api/connections` listing for the unrestricted
   * bearer when `?workspaceId` is omitted.
   */
  listOperatorConnections(): Promise<readonly ProviderConnection[]>;
  deleteConnection(id: string): Promise<boolean>;

  putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob>;
  getSecretBlob(connectionId: string): Promise<StoredSecretBlob | undefined>;
  deleteSecretBlob(connectionId: string): Promise<boolean>;

  // Source records (public fields + internal hook-secret hash / lastSeenCommit /
  // autoSync). The hook secret plaintext is NEVER stored.
  putSource(source: StoredSource): Promise<StoredSource>;
  getSource(id: string): Promise<StoredSource | undefined>;
  listSources(workspaceId?: string): Promise<readonly StoredSource[]>;
  /** Keyset-paged Source listing for a Workspace (spec §30 source list route). */
  listSourcesPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<StoredSource>>;
  deleteSource(id: string): Promise<boolean>;

  // SourceSnapshot records (immutable archive snapshots).
  putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot>;
  getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined>;
  listSourceSnapshots(sourceId: string): Promise<readonly SourceSnapshot[]>;
  /**
   * Lists SourceSnapshots for a batch of Source ids in ONE query (used by the
   * control-backup bundle to replace a per-Source round-trip). SourceSnapshots
   * have no `space_id` column, so this batches by the already-loaded id list
   * rather than space-scoping. An empty `sourceIds` yields an empty result. Order is not
   * contractual — callers re-group/sort per Source.
   */
  listSourceSnapshotsBySourceIds(
    sourceIds: readonly string[],
  ): Promise<readonly SourceSnapshot[]>;
  /**
   * Keyset-paged SourceSnapshot listing for a Source (spec §30 pagination). The
   * keyset column is `fetchedAt` (not `createdAt`); the opaque cursor carries it
   * in the `createdAt` slot.
   */
  listSourceSnapshotsPage(
    sourceId: string,
    params: PageParams,
  ): Promise<Page<SourceSnapshot>>;

  // CapsuleCompatibilityReport records (spec §12 / §27).
  putCapsuleCompatibilityReport(
    report: CapsuleCompatibilityReport,
  ): Promise<CapsuleCompatibilityReport>;
  getCapsuleCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReport | undefined>;
  getLatestCapsuleCompatibilityReportForSourceSnapshot(
    sourceSnapshotId: string,
    options?: {
      readonly sourceId?: string;
      readonly capsuleId?: string;
    },
  ): Promise<CapsuleCompatibilityReport | undefined>;

  // Provider Binding records, one row per
  // (capsule, environment), with that pair as the upsert key.
  putProviderBindingSet(
    profile: ProviderBindingSet,
  ): Promise<ProviderBindingSet>;
  deleteProviderBindingSet(
    capsuleId: string,
    environment: string,
  ): Promise<void>;
  getProviderBindingSetByCapsule(
    capsuleId: string,
    environment: string,
  ): Promise<ProviderBindingSet | undefined>;

  // StateVersion records (spec §20). Immutable per-(Capsule, environment,
  // generation) metadata recorded after a successful apply/destroy state
  // persist. The encrypted state bytes live in the state store; only the metadata
  // enters the ledger.
  putStateVersion(snapshot: StateVersion): Promise<StateVersion>;
  getStateVersion(id: string): Promise<StateVersion | undefined>;
  getLatestStateVersion(
    capsuleId: string,
    environment: string,
  ): Promise<StateVersion | undefined>;
  listStateVersions(
    capsuleId: string,
    environment: string,
  ): Promise<readonly StateVersion[]>;
  listStateVersionsPage(
    capsuleId: string,
    environment: string,
    params: PageParams,
  ): Promise<Page<StateVersion>>;
  /**
   * Lists all StateVersions for a Workspace in one query. SQL adapters may use
   * a legacy physical `space_id` column internally. Spans all environments;
   * callers that need per-(Capsule, environment) grouping/order re-group.
   */
  listStateVersionsByWorkspace(
    workspaceId: string,
  ): Promise<readonly StateVersion[]>;

  // Dependency DAG edges. A Dependency connects a producer Capsule's outputs
  // to a consumer Capsule's inputs within the same Workspace.
  putDependency(dependency: Dependency): Promise<Dependency>;
  getDependency(id: string): Promise<Dependency | undefined>;
  listDependenciesByWorkspace(
    workspaceId: string,
  ): Promise<readonly Dependency[]>;
  listDependenciesForConsumer(
    consumerCapsuleId: string,
  ): Promise<readonly Dependency[]>;
  listDependenciesForProducer(
    producerCapsuleId: string,
  ): Promise<readonly Dependency[]>;
  deleteDependency(id: string): Promise<boolean>;

  // DependencySnapshot records (spec §17 / §27 dependency_snapshots). The plan
  // path pins one per run; the apply path re-reads it to verify producer state
  // generations / pinned values before applying (invariant 9).
  putDependencySnapshot(
    snapshot: DependencySnapshot,
  ): Promise<DependencySnapshot>;
  getDependencySnapshot(id: string): Promise<DependencySnapshot | undefined>;

  // Output records (spec §16 / §27 output_snapshots). Recorded after a
  // successful apply: bounded Workspace-local outputs + the separately
  // allowlisted publicOutputs + digest; the raw envelope stays an encrypted
  // artifact-store object (rawArtifactRef).
  putOutput(snapshot: Output): Promise<Output>;
  getOutput(id: string): Promise<Output | undefined>;
  getLatestOutput(capsuleId: string): Promise<Output | undefined>;
  listOutputs(capsuleId: string): Promise<readonly Output[]>;
  /**
   * Lists all Outputs for a Workspace in one query. SQL adapters may use a
   * legacy physical `space_id` column internally. Order is not contractual;
   * callers that need per-Capsule grouping/order re-group.
   */
  listOutputsByWorkspace(workspaceId: string): Promise<readonly Output[]>;

  // OutputShare records. A cross-Workspace grant from a producer Capsule's
  // projected outputs to a consumer Workspace. The grant carries names and
  // optional aliases only (sensitive
  // sharing is not supported, invariant 12); resolved output VALUES are never
  // stored on the share.
  putOutputShare(share: OutputShare): Promise<OutputShare>;
  getOutputShare(id: string): Promise<OutputShare | undefined>;
  /** Shares granted by a Workspace (the producer side). */
  listOutputSharesFromWorkspace(
    fromWorkspaceId: string,
  ): Promise<readonly OutputShare[]>;
  /** Shares granted to a Workspace (the consumer side). */
  listOutputSharesToWorkspace(
    toWorkspaceId: string,
  ): Promise<readonly OutputShare[]>;

  // RunGroup records (spec §19 / §24 / §27 run_groups). Orders multiple Runs
  // across the dependency DAG (e.g. a Workspace update after stale propagation).
  putRunGroup(group: RunGroup): Promise<RunGroup>;
  getRunGroup(id: string): Promise<RunGroup | undefined>;
  listRunGroups(workspaceId: string): Promise<readonly RunGroup[]>;

  // Activity audit-trail records (spec §27 audit_events / §34 Activity). The
  // Workspace-scoped audit ledger surfaced in the dashboard Activity view. Listing
  // orders newest first (createdAt desc, id desc) and defaults to 100 rows.
  putActivityEvent(event: ActivityEvent): Promise<ActivityEvent>;
  listActivityEvents(
    workspaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly ActivityEvent[]>;
  /**
   * Newest-first keyset page for one target inside the shared Activity ledger.
   * Resource Shape exposes this filtered projection as Resource events.
   */
  listActivityEventsForTargetPage(
    workspaceId: string,
    targetType: string,
    targetId: string,
    params: PageParams,
  ): Promise<Page<ActivityEvent>>;

  // Credential mint audit rows (spec invariant 17). Values are never persisted;
  // this ledger records only run/Workspace/Capsule/connection/phase metadata.
  putCredentialMintEvent(
    event: CredentialMintEvent,
  ): Promise<CredentialMintEvent>;
  listCredentialMintEventsForRun(
    runId: string,
  ): Promise<readonly CredentialMintEvent[]>;

  // Security findings (§26 / §30). Values are non-secret security metadata
  // emitted by Capsule Gate, plan policy, and later scanners.
  putSecurityFinding(finding: SecurityFinding): Promise<SecurityFinding>;
  listSecurityFindings(
    workspaceId: string,
    options?: { readonly runId?: string; readonly limit?: number },
  ): Promise<readonly SecurityFinding[]>;

  // Provider-neutral OSS showback ledger. Commercial plans, subscriptions,
  // balances, reservations, payment-provider records, and settlement live in
  // the host extension and never enter this store.
  putUsageEvent(event: UsageEvent): Promise<UsageEvent>;
  listUsageEvents(workspaceId: string): Promise<readonly UsageEvent[]>;
  /** Keyset-paged usage-event listing for a Workspace (spec §30 pagination). */
  listUsageEventsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<UsageEvent>>;

  // Control-backup ledger pointers. One row per sealed control-backup bundle
  // written to artifact storage. The bundle bytes
  // live in artifact storage; only the pointer (ref / digest / sizeBytes)
  // enters the ledger. Listing orders newest first (createdAt desc, id desc).
  putBackupRecord(record: BackupRecord): Promise<BackupRecord>;
  getBackupRecord(id: string): Promise<BackupRecord | undefined>;
  listBackupRecords(workspaceId: string): Promise<readonly BackupRecord[]>;
  /**
   * Keyset-paged control-backup listing for a Workspace (spec §30 pagination).
   * Ordered newest-first (createdAt DESC, id DESC), so the keyset descends.
   */
  listBackupRecordsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<BackupRecord>>;
}

/**
 * Read-coerces a persisted PlanRun / ApplyRun's `status` to the unified
 * {@link RunStatus} (RunStatus unify, S2). A row written before the `blocked` →
 * `failed` collapse stored `status: "blocked"`; this maps it to `failed` on read
 * so old rows read back in the new model. Undefined passes through.
 */
function coerceRunRowStatus<R extends PlanRun | ApplyRun>(
  run: R | undefined,
): R | undefined {
  if (!run || run.status !== ("blocked" as unknown as R["status"])) return run;
  return { ...run, status: coerceRunStatus(run.status) } as R;
}

export class InMemoryOpenTofuControlStore implements OpenTofuControlStore {
  readonly persistence = "ephemeral" as const;
  readonly #runnerProfiles = new Map<string, RunnerProfile>();
  /** Single in-memory Run ledger; typed methods below are filtered views. */
  readonly #runs = new Map<string, StoredRunRecord>();
  readonly #planRunInputs = new Map<string, PlanRunInputs>();
  /**
   * Per-run lease fence tokens. `leaseToken` is NOT a field of the public
   * PlanRun / ApplyRun JSON (it rides only the indexed `runs.lease_token`
   * column in the SQL / D1 backends), so the in-memory store keeps it in a
   * side map keyed by run id to mirror the same fence semantics in
   * {@link transitionRun}.
   */
  readonly #runLeases = new Map<string, string>();
  readonly #workspaces = new Map<string, Workspace>();
  readonly #workspaceMembers = new Map<string, WorkspaceMember>();
  readonly #projects = new Map<string, Project>();
  readonly #installConfigs = new Map<string, InstallConfig>();
  readonly #capsules = new Map<string, Capsule>();
  readonly #publicHostReservations = new Map<string, PublicHostReservation>();
  readonly #connections = new Map<string, ProviderConnection>();
  readonly #secretBlobs = new Map<string, StoredSecretBlob>();
  readonly #sources = new Map<string, StoredSource>();
  readonly #sourceSnapshots = new Map<string, SourceSnapshot>();
  readonly #capsuleCompatibilityReports = new Map<
    string,
    CapsuleCompatibilityReport
  >();
  readonly #providerBindingSets = new Map<string, ProviderBindingSet>();
  readonly #stateVersions = new Map<string, StateVersion>();
  readonly #dependencies = new Map<string, Dependency>();
  readonly #dependencySnapshots = new Map<string, DependencySnapshot>();
  readonly #outputs = new Map<string, Output>();
  readonly #outputShares = new Map<string, OutputShare>();
  readonly #runGroups = new Map<string, RunGroup>();
  readonly #activityEvents = new Map<string, ActivityEvent>();
  readonly #credentialMintEvents = new Map<string, CredentialMintEvent>();
  readonly #securityFindings = new Map<string, SecurityFinding>();
  readonly #usageEvents = new Map<string, UsageEvent>();
  readonly #backupRecords = new Map<string, BackupRecord>();
  readonly #artifactRecords = new Map<string, ArtifactRecord>();

  constructor() {
    maybeWarnInMemoryStore("InMemoryOpenTofuControlStore");
  }

  putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    this.#runnerProfiles.set(profile.id, profile);
    return Promise.resolve(profile);
  }

  getRunnerProfile(id: string): Promise<RunnerProfile | undefined> {
    return Promise.resolve(this.#runnerProfiles.get(id));
  }

  listRunnerProfiles(): Promise<readonly RunnerProfile[]> {
    return Promise.resolve(
      Array.from(this.#runnerProfiles.values()).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
  }

  putPlanRun(run: PlanRun): Promise<PlanRun> {
    this.#runs.set(run.id, run);
    return Promise.resolve(run);
  }

  getPlanRun(id: string): Promise<PlanRun | undefined> {
    const run = this.#runs.get(id);
    return Promise.resolve(
      run && isPlanRunRecord(run) ? coerceRunRowStatus(run) : undefined,
    );
  }

  putPlanRunInputs(inputs: PlanRunInputs): Promise<void> {
    this.#planRunInputs.set(inputs.planRunId, inputs);
    return Promise.resolve();
  }

  getPlanRunInputs(planRunId: string): Promise<PlanRunInputs | undefined> {
    return Promise.resolve(this.#planRunInputs.get(planRunId));
  }

  deletePlanRunInputs(planRunId: string): Promise<void> {
    this.#planRunInputs.delete(planRunId);
    return Promise.resolve();
  }

  putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    this.#runs.set(run.id, run);
    return Promise.resolve(run);
  }

  getApplyRun(id: string): Promise<ApplyRun | undefined> {
    const run = this.#runs.get(id);
    return Promise.resolve(
      run && isApplyRunRecord(run) ? coerceRunRowStatus(run) : undefined,
    );
  }

  /**
   * In-memory compare-and-set. The store is single-threaded, so the read +
   * conditional write are already atomic with respect to other awaits; the JS
   * predicate is byte-identical in SEMANTICS to the SQL / D1 fenced UPDATE:
   * the transition fires only when the current status is in `expectFrom` AND
   * (when set) the lease, heartbeat, and started-at fences match. A miss re-reads
   * (here: returns the unchanged in-memory row) with `won: false`.
   */
  transitionRun(input: TransitionRunInput): Promise<TransitionRunResult> {
    const current = this.#runs.get(input.id);
    if (!current || transitionKindForRun(current) !== input.kind) {
      return Promise.resolve({ won: false });
    }
    const currentLease = this.#runLeases.get(input.id);
    const statusMatches = input.expectFrom.includes(current.status);
    const leaseMatches =
      input.expectLeaseToken === undefined ||
      input.expectLeaseToken === currentLease;
    const currentHeartbeat = current.heartbeatAt ?? null;
    const heartbeatMatches =
      input.expectHeartbeatAt === undefined ||
      input.expectHeartbeatAt === currentHeartbeat;
    const currentStartedAt = current.startedAt ?? null;
    const startedAtMatches =
      input.expectStartedAt === undefined ||
      input.expectStartedAt === currentStartedAt;
    if (
      !statusMatches ||
      !leaseMatches ||
      !heartbeatMatches ||
      !startedAtMatches
    ) {
      return Promise.resolve({ won: false, run: current });
    }
    const persisted: PlanRun | ApplyRun | SourceSyncRun | Run =
      input.clearHeartbeat
        ? stripRunHeartbeat(input.run)
        : ({
            ...input.run,
            ...resolvedHeartbeat(input),
          } as PlanRun | ApplyRun | SourceSyncRun | Run);
    this.#runs.set(input.id, persisted);
    if (input.clearLeaseToken) {
      this.#runLeases.delete(input.id);
    } else if (input.setLeaseToken !== undefined) {
      this.#runLeases.set(input.id, input.setLeaseToken);
    }
    return Promise.resolve({ won: true, run: persisted });
  }

  putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    this.#runs.set(run.id, run);
    return Promise.resolve(run);
  }

  getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    const run = this.#runs.get(id);
    return Promise.resolve(run && isSourceSyncRunRecord(run) ? run : undefined);
  }

  listSourceSyncRuns(sourceId: string): Promise<readonly SourceSyncRun[]> {
    return Promise.resolve(
      Array.from(this.#runs.values())
        .filter(isSourceSyncRunRecord)
        .filter((row) => row.sourceId === sourceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  putCompatibilityCheckRun(run: Run): Promise<Run> {
    if (run.type !== "compatibility_check") {
      return Promise.reject(
        new Error(
          "putCompatibilityCheckRun only accepts compatibility_check runs",
        ),
      );
    }
    this.#runs.set(run.id, run);
    return Promise.resolve(run);
  }

  getCompatibilityCheckRun(id: string): Promise<Run | undefined> {
    const run = this.#runs.get(id);
    return Promise.resolve(
      run && isPublicRunRecord(run) && run.type === "compatibility_check"
        ? run
        : undefined,
    );
  }

  beginResourceOperationRun(
    run: ResourceOperationRun,
  ): Promise<BeginResourceOperationRunResult> {
    assertResourceOperationRunStart(run);
    const current = this.#runs.get(run.id);
    if (!current) {
      this.#runs.set(run.id, run);
      return Promise.resolve({ status: "created", run });
    }
    if (!isResourceOperationRun(current)) {
      return Promise.resolve({ status: "conflict" });
    }
    return Promise.resolve(
      sameResourceOperationIdentity(current, run)
        ? { status: "existing", run: current }
        : { status: "conflict", run: current },
    );
  }

  getResourceOperationRun(
    id: string,
  ): Promise<ResourceOperationRun | undefined> {
    const run = this.#runs.get(id);
    return Promise.resolve(
      run && isResourceOperationRun(run) ? run : undefined,
    );
  }

  transitionResourceOperationRun(
    input: TransitionResourceOperationRunInput,
  ): Promise<TransitionResourceOperationRunResult> {
    assertResourceOperationRun(input.run);
    const current = this.#runs.get(input.id);
    if (!current || !isResourceOperationRun(current)) {
      return Promise.resolve({ won: false });
    }
    if (
      current.resourceOperationKey !== input.operationKey ||
      current.resourceOperationVersion !== input.expectedVersion ||
      !input.expectFrom.includes(current.status) ||
      !resourceOperationRunTransitionAllowed(current, input.run)
    ) {
      return Promise.resolve({ won: false, run: current });
    }
    this.#runs.set(input.id, input.run);
    return Promise.resolve({ won: true, run: input.run });
  }

  listRecoverableResourceOperationRuns(
    options: RecoverableResourceOperationRunListOptions = {},
  ): Promise<readonly ResourceOperationRun[]> {
    const limit = clampRecoverableResourceOperationRunListLimit(options.limit);
    return Promise.resolve(
      Array.from(this.#runs.values())
        .filter(isResourceOperationRun)
        .filter(
          (run) =>
            (options.workspaceId === undefined ||
              run.workspaceId === options.workspaceId) &&
            resourceOperationRunNeedsRecovery(run),
        )
        .sort(compareStoredRunRecordsAsc)
        .slice(0, limit),
    );
  }

  putBackupRun(run: Run): Promise<Run> {
    if (run.type !== "backup" && run.type !== "restore") {
      return Promise.reject(
        new Error("putBackupRun only accepts backup/restore runs"),
      );
    }
    this.#runs.set(run.id, run);
    return Promise.resolve(run);
  }

  getBackupRun(id: string): Promise<Run | undefined> {
    const run = this.#runs.get(id);
    return Promise.resolve(
      run &&
        isPublicRunRecord(run) &&
        (run.type === "backup" || run.type === "restore")
        ? run
        : undefined,
    );
  }

  listRunsByWorkspace(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly StoredRunRecord[]> {
    const limit = clampRunListLimit(options.limit);
    const rows = Array.from(this.#runs.values()).filter(
      (row) => row.workspaceId === workspaceId,
    );
    return Promise.resolve(
      rows.sort(compareStoredRunRecordsDesc).slice(0, limit),
    );
  }

  getCapsuleRuntimeSafety(
    capsuleId: string,
  ): Promise<CapsuleRuntimeSafety | undefined> {
    const rows = Array.from(this.#runs.values()).filter(
      (run): run is ApplyRun | Run =>
        (isApplyRunRecord(run) || isPublicRunRecord(run)) &&
        runtimeSafetyCandidate(run, capsuleId),
    );
    const latest = rows.sort(compareRuntimeSafetyCandidatesDesc)[0];
    return Promise.resolve(
      latest ? capsuleRuntimeSafetyFromRun(latest) : undefined,
    );
  }

  listRecoverableOpenTofuRuns(
    options: RecoverableOpenTofuRunListOptions,
  ): Promise<readonly StoredRunRecord[]> {
    const limit = clampRecoverableOpenTofuRunListLimit(options.limit);
    const rows = Array.from(this.#runs.values());
    return Promise.resolve(
      rows
        .filter((row) => isRecoverableOpenTofuRunRecord(row, options))
        .sort(compareStoredRunRecordsAsc)
        .slice(0, limit),
    );
  }

  putArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord> {
    this.#artifactRecords.set(record.id, record);
    return Promise.resolve(record);
  }

  listArtifactRecordsForRun(runId: string): Promise<readonly ArtifactRecord[]> {
    return Promise.resolve(
      Array.from(this.#artifactRecords.values())
        .filter((row) => row.runId === runId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  putWorkspace(workspace: Workspace): Promise<Workspace> {
    this.#workspaces.set(workspace.id, workspace);
    return Promise.resolve(workspace);
  }

  getWorkspace(id: string): Promise<Workspace | undefined> {
    return Promise.resolve(this.#workspaces.get(id));
  }

  listWorkspacesByIds(ids: readonly string[]): Promise<readonly Workspace[]> {
    return Promise.resolve(
      ids
        .map((id) => this.#workspaces.get(id))
        .filter((row): row is Workspace => row !== undefined),
    );
  }

  getWorkspaceByHandle(handle: string): Promise<Workspace | undefined> {
    return Promise.resolve(
      Array.from(this.#workspaces.values()).find(
        (row) => row.handle === handle,
      ),
    );
  }

  listWorkspaces(): Promise<readonly Workspace[]> {
    return Promise.resolve(
      Array.from(this.#workspaces.values()).sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  listWorkspacesByOwner(ownerUserId: string): Promise<readonly Workspace[]> {
    return Promise.resolve(
      Array.from(this.#workspaces.values())
        .filter((row) => row.ownerUserId === ownerUserId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  putWorkspaceMember(member: WorkspaceMember): Promise<WorkspaceMember> {
    this.#workspaceMembers.set(
      workspaceMemberKey(member.workspaceId, member.accountId),
      member,
    );
    return Promise.resolve(member);
  }

  getWorkspaceMember(
    workspaceId: string,
    accountId: string,
  ): Promise<WorkspaceMember | undefined> {
    return Promise.resolve(
      this.#workspaceMembers.get(workspaceMemberKey(workspaceId, accountId)),
    );
  }

  listWorkspaceMembers(
    workspaceId: string,
  ): Promise<readonly WorkspaceMember[]> {
    return Promise.resolve(
      Array.from(this.#workspaceMembers.values())
        .filter((row) => row.workspaceId === workspaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listWorkspaceMembersByAccount(
    accountId: string,
  ): Promise<readonly WorkspaceMember[]> {
    return Promise.resolve(
      Array.from(this.#workspaceMembers.values())
        .filter((row) => row.accountId === accountId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  putProject(project: Project): Promise<Project> {
    this.#projects.set(project.id, project);
    return Promise.resolve(project);
  }

  getProject(id: string): Promise<Project | undefined> {
    return Promise.resolve(this.#projects.get(id));
  }

  getProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<Project | undefined> {
    return Promise.resolve(
      Array.from(this.#projects.values()).find(
        (row) => row.workspaceId === workspaceId && row.slug === slug,
      ),
    );
  }

  listProjectsByWorkspace(workspaceId: string): Promise<readonly Project[]> {
    return Promise.resolve(
      Array.from(this.#projects.values())
        .filter((row) => row.workspaceId === workspaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    this.#installConfigs.set(config.id, config);
    return Promise.resolve(config);
  }

  getInstallConfig(id: string): Promise<InstallConfig | undefined> {
    return Promise.resolve(this.#installConfigs.get(id));
  }

  listInstallConfigs(workspaceId?: string): Promise<readonly InstallConfig[]> {
    const rows = Array.from(this.#installConfigs.values());
    const filtered =
      workspaceId === undefined
        ? rows
        : rows.filter((row) => row.workspaceId === workspaceId);
    return Promise.resolve(
      filtered.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  putCapsule(capsuleInput: Capsule): Promise<Capsule> {
    const capsule = normalizeCapsule(capsuleInput);
    for (const existing of this.#capsules.values()) {
      if (
        existing.id !== capsule.id &&
        existing.status !== "destroyed" &&
        capsule.status !== "destroyed" &&
        existing.projectId === capsule.projectId &&
        existing.name === capsule.name &&
        existing.environment === capsule.environment
      ) {
        return Promise.reject(
          new Error(
            `capsule unique(project_id, name, environment) violated: ` +
              `${capsule.projectId}/${capsule.name} ` +
              `(${capsule.environment})`,
          ),
        );
      }
    }
    this.#capsules.set(capsule.id, capsule);
    return Promise.resolve(capsule);
  }

  getCapsule(id: string): Promise<Capsule | undefined> {
    return Promise.resolve(this.#capsules.get(id));
  }

  getCapsuleByName(
    projectId: string,
    name: string,
    environment: string,
  ): Promise<Capsule | undefined> {
    return Promise.resolve(
      Array.from(this.#capsules.values()).find(
        (row) =>
          row.status !== "destroyed" &&
          row.projectId === projectId &&
          row.name === name &&
          row.environment === environment,
      ),
    );
  }

  listCapsules(workspaceId?: string): Promise<readonly Capsule[]> {
    const rows = Array.from(this.#capsules.values());
    const filtered =
      workspaceId === undefined
        ? rows
        : rows.filter((row) => row.workspaceId === workspaceId);
    return Promise.resolve(
      filtered.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  async listCapsulesPage(
    workspaceId: string,
    params: CapsuleListPageParams,
  ): Promise<Page<Capsule>> {
    const rows = await this.listCapsules(workspaceId);
    const visibleRows =
      params.includeDestroyed === false
        ? rows.filter((row) => row.status !== "destroyed")
        : rows;
    return pageSorted(visibleRows, params);
  }

  async reservePublicHost(
    input: ReservePublicHostInput,
  ): Promise<ReservePublicHostResult> {
    const hostname = input.hostname.toLowerCase();
    const workspace = this.#workspaces.get(input.workspaceId);
    if (!workspace) {
      throw new Error("public host reservation workspace was not found");
    }
    const ownerUserId = workspace.ownerUserId;
    const existing = this.#publicHostReservations.get(hostname);
    if (
      existing &&
      existing.status === "reserved" &&
      existing.capsuleId !== input.capsuleId
    ) {
      return {
        reserved: false,
        reservation: existing,
        reason: "already_reserved",
      };
    }
    if (
      input.allocationKind === "vanity" &&
      input.vanitySlotLimit !== undefined
    ) {
      const occupiedHostnames = new Set(
        [...this.#publicHostReservations.values()]
          .filter(
            (reservation) =>
              reservation.status === "reserved" &&
              reservation.ownerUserId === ownerUserId &&
              reservation.allocationKind === "vanity" &&
              reservation.hostname !== hostname,
          )
          .map((reservation) => reservation.hostname),
      );
      if (occupiedHostnames.size >= input.vanitySlotLimit) {
        return {
          reserved: false,
          reason: "owner_slot_limit_reached",
          vanitySlotLimit: input.vanitySlotLimit,
        };
      }
    }
    const reservation: PublicHostReservation = {
      hostname,
      ownerUserId,
      workspaceId: input.workspaceId,
      capsuleId: input.capsuleId,
      capsuleName: input.capsuleName,
      allocationKind: input.allocationKind,
      status: "reserved",
      reservedAt:
        existing?.capsuleId === input.capsuleId
          ? existing.reservedAt
          : input.now,
      updatedAt: input.now,
    };
    this.#publicHostReservations.set(hostname, reservation);
    return { reserved: true, reservation };
  }

  getPublicHostReservation(
    hostname: string,
  ): Promise<PublicHostReservation | undefined> {
    return Promise.resolve(
      this.#publicHostReservations.get(hostname.toLowerCase()),
    );
  }

  releasePublicHostsForCapsule(capsuleId: string, now: string): Promise<void> {
    for (const [hostname, reservation] of this.#publicHostReservations) {
      if (
        reservation.capsuleId !== capsuleId ||
        reservation.status !== "reserved"
      ) {
        continue;
      }
      this.#publicHostReservations.set(hostname, {
        ...reservation,
        status: "released",
        updatedAt: now,
        releasedAt: now,
      });
    }
    return Promise.resolve();
  }

  patchCapsule(
    id: string,
    patch: CapsulePatch,
    guard?: CapsuleStateVersionGuard,
  ): Promise<Capsule | undefined> {
    const existing = this.#capsules.get(id);
    if (!existing) return Promise.resolve(undefined);
    if (
      guard !== undefined &&
      (existing.currentStateVersionId !== guard.currentStateVersionId ||
        (guard.status !== undefined && existing.status !== guard.status))
    ) {
      return Promise.reject(
        new CapsuleStateVersionGuardConflict({
          id,
          expectedCurrentStateVersionId: guard.currentStateVersionId,
          actualCurrentStateVersionId: existing.currentStateVersionId,
          expectedStatus: guard.status,
          actualStatus: existing.status,
        }),
      );
    }
    const updated = normalizeCapsule({ ...existing, ...patch });
    this.#capsules.set(id, updated);
    return Promise.resolve(updated);
  }

  /**
   * In-memory commit. The store is single-threaded, so the sequential writes are
   * already atomic with respect to other awaits — there is no concurrent writer
   * to interleave. There is, however, NO rollback: if a write throws partway
   * (e.g. the guarded patch hits a conflict), the StateVersion /
   * Output already set into the maps stay set. The SQL and D1 backends
   * roll back / batch for true all-or-nothing; the in-memory store is dev/test
   * only and surfaces the error to the caller, which fails the run. To keep the
   * guard-conflict case torn-free even here, the guarded Capsule patch is
   * evaluated FIRST so a guard miss/conflict short-circuits before any
   * StateVersion / Output write lands.
   */
  commitRunState(input: CommitRunStateInput): Promise<CommitRunStateResult> {
    const { capsulePatch } = input;
    if (
      input.applyRunTerminal &&
      input.applyRunLeaseToken !== undefined &&
      this.#runLeases.get(input.applyRunTerminal.id) !==
        input.applyRunLeaseToken
    ) {
      return Promise.resolve({ applyRunLeaseLost: true });
    }
    const existing = this.#capsules.get(capsulePatch.id);
    if (!existing) {
      return Promise.resolve({ capsule: undefined });
    }
    const guard = capsulePatch.guard;
    if (
      existing.currentStateVersionId !== guard.currentStateVersionId ||
      (guard.status !== undefined && existing.status !== guard.status)
    ) {
      return Promise.reject(
        new CapsuleStateVersionGuardConflict({
          id: capsulePatch.id,
          expectedCurrentStateVersionId: guard.currentStateVersionId,
          actualCurrentStateVersionId: existing.currentStateVersionId,
          expectedStatus: guard.status,
          actualStatus: existing.status,
        }),
      );
    }
    this.#stateVersions.set(input.stateVersion.id, input.stateVersion);
    if (input.output) {
      this.#outputs.set(input.output.id, input.output);
    }
    // Commit-tail fold (S2): the terminal ApplyRun + the applied PlanRun land in
    // the SAME atomic unit as the StateVersion so a crash can no longer tear them.
    // The apply terminal clears its lease fence (mirrors transitionRun
    // clearLeaseToken); the plan patch is a plain write (already terminal, no
    // lease).
    if (input.applyRunTerminal) {
      this.#runs.set(input.applyRunTerminal.id, input.applyRunTerminal);
      this.#runLeases.delete(input.applyRunTerminal.id);
    }
    if (input.planRunApplied) {
      this.#runs.set(input.planRunApplied.id, input.planRunApplied);
    }
    const updated = normalizeCapsule({
      ...existing,
      ...capsulePatch.patch,
    });
    this.#capsules.set(capsulePatch.id, updated);
    return Promise.resolve({ capsule: updated });
  }

  commitResourceRun(
    input: CommitResourceRunInput,
  ): Promise<CommitResourceRunResult> {
    if (
      this.#runLeases.get(input.applyRunTerminal.id) !==
      input.applyRunLeaseToken
    ) {
      return Promise.resolve({ applyRunLeaseLost: true });
    }
    this.#runs.set(input.applyRunTerminal.id, input.applyRunTerminal);
    this.#runs.set(input.planRunApplied.id, input.planRunApplied);
    this.#runLeases.delete(input.applyRunTerminal.id);
    return Promise.resolve({});
  }

  commitRestoredState(
    input: CommitRestoredStateInput,
  ): Promise<CommitRestoredStateResult> {
    if (
      this.#runLeases.get(input.restoreRunTerminal.id) !==
      input.restoreRunLeaseToken
    ) {
      return Promise.resolve({ restoreRunLeaseLost: true });
    }
    const { capsulePatch } = input;
    const existing = this.#capsules.get(capsulePatch.id);
    if (!existing) {
      return Promise.resolve({ capsule: undefined });
    }
    const guard = capsulePatch.guard;
    if (
      existing.currentStateGeneration !== guard.currentStateGeneration ||
      (guard.status !== undefined && existing.status !== guard.status)
    ) {
      return Promise.reject(
        new CapsuleStateGenerationGuardConflict({
          id: capsulePatch.id,
          expectedCurrentStateGeneration: guard.currentStateGeneration,
          actualCurrentStateGeneration: existing.currentStateGeneration,
          expectedStatus: guard.status,
          actualStatus: existing.status,
        }),
      );
    }
    const updated = normalizeCapsule({
      ...existing,
      ...capsulePatch.patch,
    });
    this.#stateVersions.set(input.stateVersion.id, input.stateVersion);
    this.#runs.set(input.restoreRunTerminal.id, input.restoreRunTerminal);
    this.#runLeases.delete(input.restoreRunTerminal.id);
    this.#capsules.set(capsulePatch.id, updated);
    return Promise.resolve({ capsule: updated });
  }

  putConnection(connection: ProviderConnection): Promise<ProviderConnection> {
    this.#connections.set(connection.id, connection);
    return Promise.resolve(connection);
  }

  getConnection(id: string): Promise<ProviderConnection | undefined> {
    return Promise.resolve(this.#connections.get(id));
  }

  listConnections(workspaceId: string): Promise<readonly ProviderConnection[]> {
    return Promise.resolve(
      Array.from(this.#connections.values())
        .filter((row) => row.workspaceId === workspaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  async listConnectionsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<ProviderConnection>> {
    return pageSorted(await this.listConnections(workspaceId), params);
  }

  listOperatorConnections(): Promise<readonly ProviderConnection[]> {
    return Promise.resolve(
      Array.from(this.#connections.values())
        .filter(
          (row) => row.workspaceId === undefined && row.scope === "operator",
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  deleteConnection(id: string): Promise<boolean> {
    return Promise.resolve(this.#connections.delete(id));
  }

  putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob> {
    this.#secretBlobs.set(blob.connectionId, blob);
    return Promise.resolve(blob);
  }

  getSecretBlob(connectionId: string): Promise<StoredSecretBlob | undefined> {
    return Promise.resolve(this.#secretBlobs.get(connectionId));
  }

  deleteSecretBlob(connectionId: string): Promise<boolean> {
    return Promise.resolve(this.#secretBlobs.delete(connectionId));
  }

  putSource(source: StoredSource): Promise<StoredSource> {
    this.#sources.set(source.id, source);
    return Promise.resolve(source);
  }

  getSource(id: string): Promise<StoredSource | undefined> {
    return Promise.resolve(this.#sources.get(id));
  }

  listSources(workspaceId?: string): Promise<readonly StoredSource[]> {
    const rows = Array.from(this.#sources.values());
    const filtered =
      workspaceId === undefined
        ? rows
        : rows.filter((row) => row.workspaceId === workspaceId);
    return Promise.resolve(
      filtered.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  async listSourcesPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<StoredSource>> {
    return pageSorted(await this.listSources(workspaceId), params);
  }

  deleteSource(id: string): Promise<boolean> {
    return Promise.resolve(this.#sources.delete(id));
  }

  putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    const normalized = normalizeSourceSnapshot(snapshot);
    this.#sourceSnapshots.set(normalized.id, normalized);
    return Promise.resolve(normalized);
  }

  getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined> {
    return Promise.resolve(this.#sourceSnapshots.get(id));
  }

  listSourceSnapshots(sourceId: string): Promise<readonly SourceSnapshot[]> {
    return Promise.resolve(
      Array.from(this.#sourceSnapshots.values())
        .filter((row) => row.sourceId === sourceId)
        .sort(
          (a, b) =>
            a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listSourceSnapshotsBySourceIds(
    sourceIds: readonly string[],
  ): Promise<readonly SourceSnapshot[]> {
    if (sourceIds.length === 0) return Promise.resolve([]);
    const ids = new Set(sourceIds);
    return Promise.resolve(
      Array.from(this.#sourceSnapshots.values()).filter(
        (row) => row.sourceId !== undefined && ids.has(row.sourceId),
      ),
    );
  }

  async listSourceSnapshotsPage(
    sourceId: string,
    params: PageParams,
  ): Promise<Page<SourceSnapshot>> {
    return pageSortedBy(
      await this.listSourceSnapshots(sourceId),
      params,
      (s) => ({
        createdAt: s.fetchedAt,
        id: s.id,
      }),
    );
  }

  putCapsuleCompatibilityReport(
    report: CapsuleCompatibilityReport,
  ): Promise<CapsuleCompatibilityReport> {
    const normalized = normalizeStoredCapsuleCompatibilityReport(report);
    this.#capsuleCompatibilityReports.set(normalized.id, normalized);
    return Promise.resolve(normalized);
  }

  getCapsuleCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReport | undefined> {
    return Promise.resolve(this.#capsuleCompatibilityReports.get(id));
  }

  getLatestCapsuleCompatibilityReportForSourceSnapshot(
    sourceSnapshotId: string,
    options: {
      readonly sourceId?: string;
      readonly capsuleId?: string;
    } = {},
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const candidates = [...this.#capsuleCompatibilityReports.values()]
      .filter(
        (report) =>
          report.sourceSnapshotId === sourceSnapshotId &&
          (options.sourceId === undefined ||
            report.sourceId === options.sourceId) &&
          (options.capsuleId === undefined ||
            report.capsuleId === undefined ||
            report.capsuleId === options.capsuleId),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
    return Promise.resolve(candidates[0]);
  }

  putProviderBindingSet(
    profile: ProviderBindingSet,
  ): Promise<ProviderBindingSet> {
    // One profile per (Capsule, environment): drop a stale row under a
    // different id for the same pair.
    for (const [key, existing] of this.#providerBindingSets) {
      if (
        existing.capsuleId === profile.capsuleId &&
        existing.environment === profile.environment &&
        key !== profile.id
      ) {
        this.#providerBindingSets.delete(key);
      }
    }
    this.#providerBindingSets.set(profile.id, profile);
    return Promise.resolve(profile);
  }

  deleteProviderBindingSet(
    capsuleId: string,
    environment: string,
  ): Promise<void> {
    for (const [key, existing] of this.#providerBindingSets) {
      if (
        existing.capsuleId === capsuleId &&
        existing.environment === environment
      ) {
        this.#providerBindingSets.delete(key);
      }
    }
    return Promise.resolve();
  }

  getProviderBindingSetByCapsule(
    capsuleId: string,
    environment: string,
  ): Promise<ProviderBindingSet | undefined> {
    return Promise.resolve(
      Array.from(this.#providerBindingSets.values()).find(
        (row) => row.capsuleId === capsuleId && row.environment === environment,
      ),
    );
  }

  putStateVersion(snapshot: StateVersion): Promise<StateVersion> {
    this.#stateVersions.set(snapshot.id, snapshot);
    return Promise.resolve(snapshot);
  }

  getStateVersion(id: string): Promise<StateVersion | undefined> {
    return Promise.resolve(this.#stateVersions.get(id));
  }

  listStateVersions(
    capsuleId: string,
    environment: string,
  ): Promise<readonly StateVersion[]> {
    return Promise.resolve(
      Array.from(this.#stateVersions.values())
        .filter(
          (row) =>
            row.capsuleId === capsuleId && row.environment === environment,
        )
        .sort((a, b) => a.generation - b.generation),
    );
  }

  async listStateVersionsPage(
    capsuleId: string,
    environment: string,
    params: PageParams,
  ): Promise<Page<StateVersion>> {
    return pageSorted(
      await this.listStateVersions(capsuleId, environment),
      params,
    );
  }

  listStateVersionsByWorkspace(
    workspaceId: string,
  ): Promise<readonly StateVersion[]> {
    return Promise.resolve(
      Array.from(this.#stateVersions.values()).filter(
        (row) => row.workspaceId === workspaceId,
      ),
    );
  }

  getLatestStateVersion(
    capsuleId: string,
    environment: string,
  ): Promise<StateVersion | undefined> {
    let latest: StateVersion | undefined;
    for (const row of this.#stateVersions.values()) {
      if (row.capsuleId !== capsuleId || row.environment !== environment)
        continue;
      if (!latest || row.generation > latest.generation) latest = row;
    }
    return Promise.resolve(latest);
  }

  putDependency(dependency: Dependency): Promise<Dependency> {
    this.#dependencies.set(dependency.id, dependency);
    return Promise.resolve(dependency);
  }

  getDependency(id: string): Promise<Dependency | undefined> {
    return Promise.resolve(this.#dependencies.get(id));
  }

  listDependenciesByWorkspace(
    workspaceId: string,
  ): Promise<readonly Dependency[]> {
    return Promise.resolve(
      Array.from(this.#dependencies.values())
        .filter((row) => row.workspaceId === workspaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listDependenciesForConsumer(
    consumerCapsuleId: string,
  ): Promise<readonly Dependency[]> {
    return Promise.resolve(
      Array.from(this.#dependencies.values())
        .filter((row) => row.consumerCapsuleId === consumerCapsuleId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listDependenciesForProducer(
    producerCapsuleId: string,
  ): Promise<readonly Dependency[]> {
    return Promise.resolve(
      Array.from(this.#dependencies.values())
        .filter((row) => row.producerCapsuleId === producerCapsuleId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  deleteDependency(id: string): Promise<boolean> {
    return Promise.resolve(this.#dependencies.delete(id));
  }

  putDependencySnapshot(
    snapshot: DependencySnapshot,
  ): Promise<DependencySnapshot> {
    this.#dependencySnapshots.set(snapshot.id, snapshot);
    return Promise.resolve(snapshot);
  }

  getDependencySnapshot(id: string): Promise<DependencySnapshot | undefined> {
    return Promise.resolve(this.#dependencySnapshots.get(id));
  }

  putOutput(snapshot: Output): Promise<Output> {
    this.#outputs.set(snapshot.id, snapshot);
    return Promise.resolve(snapshot);
  }

  getOutput(id: string): Promise<Output | undefined> {
    return Promise.resolve(this.#outputs.get(id));
  }

  getLatestOutput(capsuleId: string): Promise<Output | undefined> {
    let latest: Output | undefined;
    for (const row of this.#outputs.values()) {
      if (row.capsuleId !== capsuleId) continue;
      // The latest projection is the one at the highest state generation; ties
      // (re-applied same generation) break to the most recently created.
      if (
        !latest ||
        row.stateGeneration > latest.stateGeneration ||
        (row.stateGeneration === latest.stateGeneration &&
          row.createdAt.localeCompare(latest.createdAt) >= 0)
      ) {
        latest = row;
      }
    }
    return Promise.resolve(latest);
  }

  listOutputs(capsuleId: string): Promise<readonly Output[]> {
    return Promise.resolve(
      Array.from(this.#outputs.values())
        .filter((row) => row.capsuleId === capsuleId)
        .sort(
          (a, b) =>
            a.stateGeneration - b.stateGeneration ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        ),
    );
  }

  listOutputsByWorkspace(workspaceId: string): Promise<readonly Output[]> {
    return Promise.resolve(
      Array.from(this.#outputs.values()).filter(
        (row) => row.workspaceId === workspaceId,
      ),
    );
  }

  putOutputShare(share: OutputShare): Promise<OutputShare> {
    this.#outputShares.set(share.id, share);
    return Promise.resolve(share);
  }

  getOutputShare(id: string): Promise<OutputShare | undefined> {
    return Promise.resolve(this.#outputShares.get(id));
  }

  listOutputSharesFromWorkspace(
    fromWorkspaceId: string,
  ): Promise<readonly OutputShare[]> {
    return Promise.resolve(
      Array.from(this.#outputShares.values())
        .filter((row) => row.fromWorkspaceId === fromWorkspaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listOutputSharesToWorkspace(
    toWorkspaceId: string,
  ): Promise<readonly OutputShare[]> {
    return Promise.resolve(
      Array.from(this.#outputShares.values())
        .filter((row) => row.toWorkspaceId === toWorkspaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  putRunGroup(group: RunGroup): Promise<RunGroup> {
    this.#runGroups.set(group.id, group);
    return Promise.resolve(group);
  }

  getRunGroup(id: string): Promise<RunGroup | undefined> {
    return Promise.resolve(this.#runGroups.get(id));
  }

  listRunGroups(workspaceId: string): Promise<readonly RunGroup[]> {
    return Promise.resolve(
      Array.from(this.#runGroups.values())
        .filter((row) => row.workspaceId === workspaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  putActivityEvent(event: ActivityEvent): Promise<ActivityEvent> {
    this.#activityEvents.set(event.id, event);
    return Promise.resolve(event);
  }

  listActivityEvents(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ActivityEvent[]> {
    const limit = clampActivityLimit(options.limit);
    const rows = Array.from(this.#activityEvents.values())
      .filter((row) => row.workspaceId === workspaceId)
      // Newest first: createdAt desc, then id desc as a stable tie-break.
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      )
      .slice(0, limit);
    return Promise.resolve(rows);
  }

  listActivityEventsForTargetPage(
    workspaceId: string,
    targetType: string,
    targetId: string,
    params: PageParams,
  ): Promise<Page<ActivityEvent>> {
    const newestFirst = Array.from(this.#activityEvents.values())
      .filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.targetType === targetType &&
          row.targetId === targetId,
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
    return Promise.resolve(pageSortedDesc(newestFirst, params));
  }

  putCredentialMintEvent(
    event: CredentialMintEvent,
  ): Promise<CredentialMintEvent> {
    this.#credentialMintEvents.set(event.id, event);
    return Promise.resolve(event);
  }

  listCredentialMintEventsForRun(
    runId: string,
  ): Promise<readonly CredentialMintEvent[]> {
    return Promise.resolve(
      Array.from(this.#credentialMintEvents.values())
        .filter((row) => row.runId === runId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  putSecurityFinding(finding: SecurityFinding): Promise<SecurityFinding> {
    this.#securityFindings.set(finding.id, finding);
    return Promise.resolve(finding);
  }

  listSecurityFindings(
    workspaceId: string,
    options: { readonly runId?: string; readonly limit?: number } = {},
  ): Promise<readonly SecurityFinding[]> {
    const limit = clampActivityLimit(options.limit);
    return Promise.resolve(
      Array.from(this.#securityFindings.values())
        .filter((row) => row.workspaceId === workspaceId)
        .filter((row) =>
          options.runId === undefined ? true : row.runId === options.runId,
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
        .slice(0, limit),
    );
  }

  putUsageEvent(event: UsageEvent): Promise<UsageEvent> {
    const existing = Array.from(this.#usageEvents.values()).find(
      (row) => row.idempotencyKey === event.idempotencyKey,
    );
    if (existing) return Promise.resolve(existing);
    const normalized = normalizeUsageEvent(event);
    this.#usageEvents.set(event.id, normalized);
    return Promise.resolve(normalized);
  }

  listUsageEvents(workspaceId: string): Promise<readonly UsageEvent[]> {
    return Promise.resolve(
      Array.from(this.#usageEvents.values())
        .filter((row) => row.workspaceId === workspaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  async listUsageEventsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<UsageEvent>> {
    const newestFirst = [...(await this.listUsageEvents(workspaceId))].sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    return pageSortedDesc(newestFirst, params);
  }

  putBackupRecord(record: BackupRecord): Promise<BackupRecord> {
    this.#backupRecords.set(record.id, record);
    return Promise.resolve(record);
  }

  getBackupRecord(id: string): Promise<BackupRecord | undefined> {
    return Promise.resolve(this.#backupRecords.get(id));
  }

  listBackupRecords(workspaceId: string): Promise<readonly BackupRecord[]> {
    return Promise.resolve(
      Array.from(this.#backupRecords.values())
        .filter((row) => row.workspaceId === workspaceId)
        // Newest first: createdAt desc, then id desc as a stable tie-break.
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        ),
    );
  }

  async listBackupRecordsPage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<BackupRecord>> {
    // Newest-first listing ⇒ descending keyset pager.
    return pageSortedDesc(await this.listBackupRecords(workspaceId), params);
  }
}

/**
 * Clamps an Activity listing limit to `1..ACTIVITY_MAX_LIMIT`, defaulting to
 * `ACTIVITY_DEFAULT_LIMIT` when unset / non-finite (spec §27). The route layer
 * already rejects an out-of-range explicit limit; this is the store-side floor.
 */
export function clampActivityLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return ACTIVITY_DEFAULT_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > ACTIVITY_MAX_LIMIT) return ACTIVITY_MAX_LIMIT;
  return floored;
}

/** Store-side clamp for Workspace Run listings. Route layers reject bad input. */
export function clampRunListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return RUN_LIST_DEFAULT_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > RUN_LIST_MAX_LIMIT) return RUN_LIST_MAX_LIMIT;
  return floored;
}

const RECOVERABLE_RUN_LIST_DEFAULT_LIMIT = 100;
const RECOVERABLE_RUN_LIST_MAX_LIMIT = 5_000;

export function clampRecoverableOpenTofuRunListLimit(
  limit: number | undefined,
): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return RECOVERABLE_RUN_LIST_DEFAULT_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > RECOVERABLE_RUN_LIST_MAX_LIMIT) {
    return RECOVERABLE_RUN_LIST_MAX_LIMIT;
  }
  return floored;
}

export function clampRecoverableResourceOperationRunListLimit(
  limit: number | undefined,
): number {
  return clampRecoverableOpenTofuRunListLimit(limit);
}

export function isResourceOperationRun(
  row: StoredRunRecord,
): row is ResourceOperationRun {
  const candidate = row as Partial<ResourceOperationRun>;
  return (
    isPublicRunRecord(row) &&
    candidate.subject?.kind === "resource" &&
    isResourceOperationToken(candidate.resourceOperation) &&
    (candidate.resourceForm === undefined ||
      isInstalledFormReference(candidate.resourceForm)) &&
    (candidate.resourceOperationResult?.resourceForm === undefined ||
      isInstalledFormReference(
        candidate.resourceOperationResult.resourceForm,
      )) &&
    resourceOperationRunType(candidate.resourceOperation) === candidate.type &&
    typeof candidate.resourceOperationKey === "string" &&
    candidate.resourceOperationKey.length > 0 &&
    Number.isSafeInteger(candidate.resourceOperationVersion) &&
    (candidate.resourceOperationVersion ?? 0) > 0
  );
}

export function resourceOperationRunNeedsRecovery(
  run: ResourceOperationRun,
): boolean {
  return (
    run.status === "running" || run.resourceOperationAudit?.status === "pending"
  );
}

export function assertResourceOperationRun(run: ResourceOperationRun): void {
  if (!isResourceOperationRun(run)) {
    throw new TypeError("invalid canonical Resource operation Run");
  }
  if (run.id.trim() === "" || run.workspaceId.trim() === "") {
    throw new TypeError("Resource operation Run id/workspaceId are required");
  }
}

export function assertResourceOperationRunStart(
  run: ResourceOperationRun,
): void {
  assertResourceOperationRun(run);
  if (
    run.status !== "running" ||
    run.resourceOperationVersion !== 1 ||
    run.resourceOperationResult !== undefined ||
    run.resourceOperationAudit !== undefined ||
    run.finishedAt !== undefined ||
    run.errorCode !== undefined
  ) {
    throw new TypeError(
      "a canonical Resource operation Run must start at running version 1 without terminal/result evidence",
    );
  }
}

function isResourceOperationToken(value: unknown): value is ResourceOperation {
  return (
    value === "preview" ||
    value === "apply" ||
    value === "import" ||
    value === "observe" ||
    value === "refresh" ||
    value === "delete"
  );
}

function resourceOperationRunType(
  operation: ResourceOperation,
): ResourceOperationRun["type"] {
  if (operation === "preview") return "plan";
  if (operation === "observe") return "drift_check";
  if (operation === "delete") return "destroy_apply";
  return "apply";
}

export function sameResourceOperationIdentity(
  left: ResourceOperationRun,
  right: ResourceOperationRun,
): boolean {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.subject.id === right.subject.id &&
    left.resourceOperation === right.resourceOperation &&
    optionalInstalledFormReferenceKey(left.resourceForm) ===
      optionalInstalledFormReferenceKey(right.resourceForm) &&
    left.resourceOperationKey === right.resourceOperationKey &&
    left.type === right.type
  );
}

function optionalInstalledFormReferenceKey(
  value: InstalledFormReference | undefined,
): string | undefined {
  return value === undefined ? undefined : installedFormReferenceKey(value);
}

/**
 * Direct Resource Runs are monotonic sagas. A running row may accumulate one
 * immutable backend result and one pending success-Activity intent before its
 * terminal transition. A succeeded row may only acknowledge that exact
 * pending Activity; no terminal outcome or evidence can be rewritten.
 */
export function resourceOperationRunTransitionAllowed(
  current: ResourceOperationRun,
  next: ResourceOperationRun,
): boolean {
  if (
    !sameResourceOperationIdentity(current, next) ||
    next.resourceOperationVersion !== current.resourceOperationVersion + 1 ||
    resourceOperationRunImmutableJson(current) !==
      resourceOperationRunImmutableJson(next)
  ) {
    return false;
  }
  if (current.status === "running") {
    if (
      next.status !== "running" &&
      next.status !== "succeeded" &&
      next.status !== "failed"
    ) {
      return false;
    }
    if (
      current.resourceOperationResult &&
      canonicalStoreJson(current.resourceOperationResult) !==
        canonicalStoreJson(next.resourceOperationResult)
    ) {
      return false;
    }
    if (current.resourceOperationAudit) {
      if (next.status === "failed") {
        return next.resourceOperationAudit === undefined;
      }
      return (
        canonicalStoreJson(current.resourceOperationAudit) ===
        canonicalStoreJson(next.resourceOperationAudit)
      );
    }
    return next.resourceOperationAudit?.status !== "completed";
  }
  if (current.status !== "succeeded" || next.status !== "succeeded") {
    return false;
  }
  const currentAudit = current.resourceOperationAudit;
  const nextAudit = next.resourceOperationAudit;
  return (
    current.finishedAt === next.finishedAt &&
    current.errorCode === next.errorCode &&
    canonicalStoreJson(current.resourceOperationResult) ===
      canonicalStoreJson(next.resourceOperationResult) &&
    currentAudit?.status === "pending" &&
    nextAudit?.status === "completed" &&
    currentAudit.eventId === nextAudit.eventId &&
    currentAudit.action === nextAudit.action &&
    currentAudit.createdAt === nextAudit.createdAt &&
    canonicalStoreJson(currentAudit.metadata) ===
      canonicalStoreJson(nextAudit.metadata)
  );
}

function resourceOperationRunImmutableJson(run: ResourceOperationRun): string {
  const {
    status: _status,
    resourceOperationVersion: _version,
    resourceOperationResult: _result,
    resourceOperationAudit: _audit,
    finishedAt: _finishedAt,
    errorCode: _errorCode,
    ...immutable
  } = run;
  return canonicalStoreJson(immutable);
}

function canonicalStoreJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "undefined" : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStoreJson).join(",")}]`;
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStoreJson(object[key])}`)
    .join(",")}}`;
}

/** True only for rows that can change whether a Capsule runtime is safe. */
export function runtimeSafetyCandidate(
  row: ApplyRun | Run,
  capsuleId: string,
): boolean {
  if (row.capsuleId !== capsuleId) return false;
  if ("planRunId" in row) {
    if (row.operation === "destroy") {
      if (
        row.status === "queued" ||
        row.status === "running" ||
        row.status === "succeeded"
      ) {
        return true;
      }
      if (row.status === "failed") return applyRunMutationDispatched(row);
      return row.status === "expired" && row.startedAt !== undefined;
    }
    // A normal apply keeps the pinned revision while queued/running. A prior
    // unsafe result therefore remains decisive until a later apply succeeds.
    if (row.status === "succeeded") return true;
    if (row.status === "failed") return applyRunMutationDispatched(row);
    return row.status === "expired" && row.startedAt !== undefined;
  }
  return (
    row.type === "restore" &&
    ["queued", "running", "succeeded", "failed", "expired"].includes(row.status)
  );
}

/**
 * Failed apply/destroy rows are decisive only after provider dispatch or a
 * service-side lifecycle action was actually invoked. Pre-flight credential,
 * policy, stale-plan, unavailable-activator, or queue failures cannot have
 * changed the Capsule and therefore keep the last pinned runtime revision.
 */
export function applyRunMutationDispatched(row: ApplyRun): boolean {
  return row.auditEvents.some(
    (event) =>
      event.data?.providerDispatched === true ||
      event.data?.lifecycleActionDispatched === true,
  );
}

export function capsuleRuntimeSafetyFromRun(
  row: ApplyRun | Run,
): CapsuleRuntimeSafety {
  if ("planRunId" in row) {
    if (row.operation === "destroy") {
      if (row.status === "succeeded") {
        return { phase: "retired", runId: row.id, runType: "destroy_apply" };
      }
      if (row.status === "queued" || row.status === "running") {
        return {
          phase: "terminating",
          runId: row.id,
          runType: "destroy_apply",
        };
      }
      return { phase: "unknown", runId: row.id, runType: "destroy_apply" };
    }
    return row.status === "succeeded"
      ? { phase: "safe", runId: row.id, runType: "apply" }
      : { phase: "unknown", runId: row.id, runType: "apply" };
  }
  return row.status === "succeeded"
    ? { phase: "safe", runId: row.id, runType: "restore" }
    : { phase: "unknown", runId: row.id, runType: "restore" };
}

/**
 * True while a destructive Run can still mutate the Capsule after every
 * already-terminal Run in the ledger. Creation time cannot order this case: a
 * restore may wait for approval, then become queued long after a newer apply
 * succeeded. An in-flight restore/destroy therefore always wins the safety
 * projection until it reaches a terminal status.
 */
export function runtimeSafetyCandidateIsInFlight(row: ApplyRun | Run): boolean {
  if ("planRunId" in row) {
    return (
      row.operation === "destroy" &&
      (row.status === "queued" || row.status === "running")
    );
  }
  return (
    row.type === "restore" &&
    (row.status === "queued" || row.status === "running")
  );
}

/**
 * Timestamp of the decisive safety EFFECT, rather than immutable Run creation.
 * Apply-family rows maintain numeric updated/finished timestamps. Restore rows
 * use an ISO finished/started time plus the numeric heartbeat stamped by the
 * fenced claim/terminal transition. Legacy rows fall back to createdAt.
 */
export function runtimeSafetyCandidateEffectTimestamp(
  row: ApplyRun | Run,
): number {
  if ("planRunId" in row) {
    return (
      runTimestampValue(row.finishedAt) ??
      runTimestampValue(row.updatedAt) ??
      runTimestampValue(row.heartbeatAt) ??
      runTimestampValue(row.startedAt) ??
      runTimestampValue(row.createdAt) ??
      0
    );
  }
  return (
    runTimestampValue(row.finishedAt) ??
    runTimestampValue(row.heartbeatAt) ??
    runTimestampValue(row.startedAt) ??
    runTimestampValue(row.createdAt) ??
    0
  );
}

/** Fail-closed tie breaker when two effects share the same clock tick. */
export function runtimeSafetyCandidateRiskRank(row: ApplyRun | Run): number {
  const phase = capsuleRuntimeSafetyFromRun(row).phase;
  if (phase === "retired") return 3;
  if (phase === "terminating") return 2;
  if (phase === "unknown") return 1;
  return 0;
}

/**
 * Shared newest-decisive-first ordering used by the in-memory backend and
 * mirrored by the PostgreSQL/D1 ORDER BY expressions.
 */
export function compareRuntimeSafetyCandidatesDesc(
  a: ApplyRun | Run,
  b: ApplyRun | Run,
): number {
  return (
    Number(runtimeSafetyCandidateIsInFlight(b)) -
      Number(runtimeSafetyCandidateIsInFlight(a)) ||
    runtimeSafetyCandidateEffectTimestamp(b) -
      runtimeSafetyCandidateEffectTimestamp(a) ||
    runtimeSafetyCandidateRiskRank(b) - runtimeSafetyCandidateRiskRank(a) ||
    b.id.localeCompare(a.id)
  );
}

/** Newest-first sort across internal numeric timestamps and ISO public rows. */
export function compareStoredRunRecordsDesc(
  a: StoredRunRecord,
  b: StoredRunRecord,
): number {
  return (
    storedRunRecordTimestamp(b) - storedRunRecordTimestamp(a) ||
    b.id.localeCompare(a.id)
  );
}

/** Oldest-first sort across internal numeric timestamps and ISO public rows. */
export function compareStoredRunRecordsAsc(
  a: StoredRunRecord,
  b: StoredRunRecord,
): number {
  return (
    storedRunRecordTimestamp(a) - storedRunRecordTimestamp(b) ||
    a.id.localeCompare(b.id)
  );
}

export function isRecoverableOpenTofuRunRecord(
  row: StoredRunRecord,
  options: RecoverableOpenTofuRunListOptions,
): boolean {
  if (
    isApplyRunRecord(row) &&
    (row.status === "succeeded" || row.status === "failed") &&
    applyRunBillingCapturePending(row)
  ) {
    const committedAt =
      runTimestampValue(row.finishedAt) ??
      runTimestampValue(row.updatedAt) ??
      storedRunRecordTimestamp(row);
    return (
      Number.isFinite(committedAt) &&
      committedAt > 0 &&
      committedAt <= options.staleQueuedBeforeMs
    );
  }
  if (row.status !== "queued" && row.status !== "running") return false;
  if (!isDispatchableOpenTofuRunRecord(row)) return false;
  const createdAt = storedRunRecordTimestamp(row);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  if (row.status === "queued") {
    return createdAt <= options.staleQueuedBeforeMs;
  }
  const reference =
    typeof row.heartbeatAt === "number" && Number.isFinite(row.heartbeatAt)
      ? row.heartbeatAt
      : (runTimestampValue(row.startedAt) ?? createdAt);
  return reference <= options.staleRunningBeforeMs;
}

export function storedRunRecordTimestamp(row: StoredRunRecord): number {
  return runTimestampValue(row.createdAt) ?? 0;
}

function runTimestampValue(
  value: number | string | undefined,
): number | undefined {
  if (typeof value === "number") return value;
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isDispatchableOpenTofuRunRecord(row: StoredRunRecord): boolean {
  if (isPlanRunRecord(row)) return true;
  if (isApplyRunRecord(row)) return true;
  if (isSourceSyncRunRecord(row)) return true;
  return isRestoreRunRecord(row);
}

export function isPlanRunRecord(row: StoredRunRecord): row is PlanRun {
  return "sourceDigest" in row && "variablesDigest" in row;
}

export function isApplyRunRecord(row: StoredRunRecord): row is ApplyRun {
  return "planRunId" in row && "expected" in row;
}

function isSourceSyncRunRecord(row: StoredRunRecord): row is SourceSyncRun {
  return "kind" in row && row.kind === "source_sync";
}

function isPublicRunRecord(row: StoredRunRecord): row is Run {
  return (
    !isPlanRunRecord(row) &&
    !isApplyRunRecord(row) &&
    !isSourceSyncRunRecord(row)
  );
}

function isRestoreRunRecord(row: StoredRunRecord): row is Run {
  return isPublicRunRecord(row) && row.type === "restore";
}

function transitionKindForRun(
  row: StoredRunRecord,
): TransitionRunInput["kind"] | undefined {
  if (isPlanRunRecord(row)) return "plan";
  if (isApplyRunRecord(row)) return "apply";
  if (isSourceSyncRunRecord(row)) return "source_sync";
  return isRestoreRunRecord(row) ? "restore" : undefined;
}

function resolvedHeartbeat(
  input: Pick<TransitionRunInput, "heartbeatAt" | "run">,
): { readonly heartbeatAt?: number } {
  const heartbeatAt = input.heartbeatAt ?? input.run.heartbeatAt;
  return heartbeatAt === undefined ? {} : { heartbeatAt };
}

function stripRunHeartbeat<R extends PlanRun | ApplyRun | SourceSyncRun | Run>(
  run: R,
): R {
  const { heartbeatAt, ...withoutHeartbeat } = run;
  void heartbeatAt;
  return withoutHeartbeat as R;
}

export function normalizeCapsule(capsule: Capsule): Capsule {
  if (capsule.compatibilityStatus !== undefined) {
    normalizeStoredCapsuleCompatibilityLevel(capsule.compatibilityStatus);
  }
  return capsule;
}

export function normalizeSourceSnapshot(
  snapshot: SourceSnapshot,
): SourceSnapshot {
  if (snapshot.origin !== "git" || !snapshot.sourceId?.trim()) {
    throw new TypeError(
      "SourceSnapshot must originate from a registered Git Source",
    );
  }
  return snapshot;
}

function normalizeUsageEvent(event: UsageEvent): UsageEvent {
  const usdMicros = usageEventUsdMicros(event);
  return {
    ...event,
    workspaceId: event.workspaceId,
    usdMicros,
  };
}

function workspaceMemberKey(workspaceId: string, accountId: string): string {
  return `${workspaceId}\u0000${accountId}`;
}

function maybeWarnInMemoryStore(storeName: string): void {
  if (!shouldWarnInMemoryStore()) return;
  log.warn("service.deploy_control.in_memory_store", {
    store: storeName,
    detail:
      "OpenTofu Run, Capsule, StateVersion, and Output records will NOT persist " +
      "across restart or isolate recycle. Inject a durable store for " +
      "production/staging.",
  });
}

function shouldWarnInMemoryStore(): boolean {
  const env = readEnvMap();
  if (env === undefined) return true;
  if (env.get("PRODUCTION")) return true;
  const nodeEnv = env.get("NODE_ENV");
  if (typeof nodeEnv === "string" && nodeEnv.toLowerCase() === "production") {
    return true;
  }
  return false;
}

function readEnvMap(): { get(name: string): string | undefined } | undefined {
  const runtime = currentRuntime();
  if (runtime.kind === "workers" || runtime.kind === "unknown") {
    return undefined;
  }
  return runtime.env;
}
