/**
 * Persistence boundary for the control-plane ledger (core-spec.md §27).
 *
 * The logical schema is the Space-direct OpenTofu Capsule DAG model: spaces,
 * sources(+snapshots), connections(+secret blobs), install_configs,
 * installations (UNIQUE(space_id, name, environment)), provider_env_binding_sets,
 * a SINGLE `runs` table (internal PlanRun / ApplyRun / SourceSyncRun records
 * persist as rows discriminated by run kind; the public §19 Run is a
 * projection), state_snapshots, and deployments.
 *
 * The in-memory implementation is for dev/test only. Production/staging hosts
 * inject the SQL store or the D1 store, both of which materialize the §27
 * tables.
 */
import type {
  ApplyRun,
  Connection,
  Deployment,
  DispatchBuildSpec,
  DispatchGeneratedRoot,
  DispatchPrebuiltArtifactSpec,
  InstallConfig,
  Installation,
  PlanRun,
  RunnerProfile,
  RunStatus,
  StateSnapshot,
} from "@takosumi/internal/deploy-control-api";
import { coerceRunStatus } from "@takosumi/internal/deploy-control-api";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { Space } from "takosumi-contract/spaces";
import type {
  InstallationProviderEnvBindingSet,
  ProviderEnv,
} from "takosumi-contract/provider-envs";
import type { OutputAllowlistEntry } from "takosumi-contract/installations";
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
import type {
  OutputShare,
  OutputSnapshot,
} from "takosumi-contract/output-snapshots";
import {
  RUN_LIST_DEFAULT_LIMIT,
  RUN_LIST_MAX_LIMIT,
  type ArtifactRecord,
  type Run,
  type RunGroup,
} from "takosumi-contract/runs";
import type { BackupRecord } from "takosumi-contract/backups";
import type {
  BillingAccount,
  BillingPlan,
  CreditBalance,
  CreditReservation,
  SpaceSubscription,
  UsageEvent,
} from "takosumi-contract/billing";
import {
  creditBalanceAvailableUsdMicros,
  creditBalanceMonthlyIncludedUsdMicros,
  creditBalancePurchasedUsdMicros,
  creditBalanceReservedUsdMicros,
  billingPlanIncludedUsdMicros,
  legacyCreditsToUsdMicros,
  usageEventUsdMicros,
  usdMicrosToLegacyCredits,
} from "takosumi-contract/billing";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "takosumi-contract/security";
import type { ProviderCatalogEntry } from "takosumi-contract/providers";
import type { JsonValue } from "takosumi-contract";
import { currentRuntime } from "../../shared/runtime/index.ts";
import { log } from "../../shared/log.ts";

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
  /**
   * Generated-root dispatch data. New Capsule sidecars carry `generatedRoot`
   * for both built-in first-party modules and generic Capsules; bundled modules
   * are embedded as `generatedRoot.moduleFiles`. The queue consumer re-reads
   * this sidecar and threads it onto the runner dispatch payload. Never
   * projected into the public ledger.
   */
  readonly generatedRoot?: DispatchGeneratedRoot;
  readonly outputAllowlist?: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly build?: DispatchBuildSpec;
  readonly prebuiltArtifact?: DispatchPrebuiltArtifactSpec;
  /**
   * At-rest seal of the SENSITIVE-bearing sidecar payload (spec §11 / §18). A
   * sensitive `published_output` value injected into a plan flows into
   * `variables` AND is baked as a literal into the generic Capsule's generated
   * `main.tf`; either would persist as a cleartext ledger value here. When a
   * sensitive value was injected, the controller seals `{ variables,
   * generatedRoot, outputAllowlist, build, prebuiltArtifact }` into this blob with the SAME
   * AES-GCM envelope used for state / plan / dependency-value artifacts and
   * leaves the cleartext fields empty/absent on the row; it unseals
   * transparently at plan/apply dispatch. The store only ever sees the
   * ciphertext.
   */
  readonly sealed?: SealedDependencyValues;
}

/**
 * Sealed credential blob persisted alongside (but separate from) the public
 * Connection record. The plaintext is the JSON of `{ [envName]: value }`
 * encrypted as ONE blob via the secret-boundary crypto. The store only ever
 * sees ciphertext; it never decrypts.
 */
export type StoredSecretBlobKind =
  | "source_https_token"
  | "source_ssh_private_key"
  | "cloudflare_oauth_refresh_token"
  | "cloudflare_api_token"
  | "aws_external_id"
  | "gcp_oauth_refresh_token"
  | "static_secret";

export interface StoredSecretBlob {
  readonly id: string;
  readonly connectionId: string;
  readonly spaceId?: string;
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

export interface InstallationPatchGuard {
  readonly currentDeploymentId: string | undefined;
  readonly status?: Installation["status"];
}

export class InstallationPatchGuardConflict extends Error {
  readonly expectedCurrentDeploymentId: string | undefined;
  readonly actualCurrentDeploymentId: string | undefined;
  readonly expectedStatus?: Installation["status"];
  readonly actualStatus?: Installation["status"];

  constructor(input: {
    readonly id: string;
    readonly expectedCurrentDeploymentId: string | undefined;
    readonly actualCurrentDeploymentId: string | undefined;
    readonly expectedStatus?: Installation["status"];
    readonly actualStatus?: Installation["status"];
  }) {
    super(
      `installation ${input.id} currentDeploymentId guard lost the race: ` +
        `expected ${input.expectedCurrentDeploymentId ?? "<none>"} but row ` +
        `is now ${input.actualCurrentDeploymentId ?? "<none>"}` +
        (input.expectedStatus === undefined
          ? ""
          : `; status expected ${input.expectedStatus} but row is ${input.actualStatus}`),
    );
    this.name = "InstallationPatchGuardConflict";
    this.expectedCurrentDeploymentId = input.expectedCurrentDeploymentId;
    this.actualCurrentDeploymentId = input.actualCurrentDeploymentId;
    this.expectedStatus = input.expectedStatus;
    this.actualStatus = input.actualStatus;
  }
}

export class InstallationStateGenerationGuardConflict extends Error {
  readonly expectedCurrentStateGeneration: number;
  readonly actualCurrentStateGeneration: number;
  readonly expectedStatus?: Installation["status"];
  readonly actualStatus?: Installation["status"];

  constructor(input: {
    readonly id: string;
    readonly expectedCurrentStateGeneration: number;
    readonly actualCurrentStateGeneration: number;
    readonly expectedStatus?: Installation["status"];
    readonly actualStatus?: Installation["status"];
  }) {
    super(
      `installation ${input.id} currentStateGeneration guard lost the race: ` +
        `expected ${input.expectedCurrentStateGeneration} but row is ` +
        `${input.actualCurrentStateGeneration}` +
        (input.expectedStatus === undefined
          ? ""
          : `; status expected ${input.expectedStatus} but row is ${input.actualStatus}`),
    );
    this.name = "InstallationStateGenerationGuardConflict";
    this.expectedCurrentStateGeneration = input.expectedCurrentStateGeneration;
    this.actualCurrentStateGeneration = input.actualCurrentStateGeneration;
    this.expectedStatus = input.expectedStatus;
    this.actualStatus = input.actualStatus;
  }
}

export interface CommitAppliedDeploymentResult {
  readonly installation?: Installation;
  /**
   * The apply run no longer holds the expected lease fence. No commit writes were
   * applied; callers must treat this as a stale worker/no-op.
   */
  readonly applyRunLeaseLost?: true;
}

/** Fields a controller may patch on an Installation row. */
export type InstallationPatch = Partial<
  Pick<
    Installation,
    | "currentDeploymentId"
    | "currentStateGeneration"
    | "currentOutputSnapshotId"
    | "compatibilityReportId"
    | "compatibilityStatus"
    | "status"
    | "updatedAt"
  >
>;

/**
 * The all-or-nothing set of ledger writes that finalize a successful apply or
 * destroy-apply (core-spec.md §20 / §21 / §16). The controller READS the
 * previous-current Deployment (for the superseded / destroyed status flip) and
 * BUILDS every record up front, then hands the bundle to
 * {@link OpenTofuDeploymentStore.commitAppliedDeployment} so a crash mid-write
 * can no longer leave a Deployment without its StateSnapshot/OutputSnapshot, or
 * a state generation advanced without its Deployment.
 *
 * The unit is:
 *   - `newDeployment` — the new `active` Deployment (apply); absent for a
 *     destroy-apply, which records no new Deployment.
 *   - `supersededDeployment` — the previously-current Deployment with its status
 *     already flipped (apply → `superseded`, destroy → `destroyed`); absent when
 *     there was no prior current Deployment, or it was not in a flippable state.
 *   - `stateSnapshot` — the §20 StateSnapshot metadata for the persisted
 *     generation.
 *   - `outputSnapshot` — the §16 OutputSnapshot (apply only; absent for destroy).
 *   - `installationPatch` — the GUARDED Installation advance (currentDeploymentId
 *     / status / currentStateGeneration / currentOutputSnapshotId). When the
 *     guard would not match the current row, the installation patch is NOT
 *     applied and the result `installation` is `undefined` — the SAME
 *     guard-miss semantics as {@link OpenTofuDeploymentStore.patchInstallation}.
 *     A guard *conflict* (row moved out from under the writer) still throws
 *     {@link InstallationPatchGuardConflict}.
 *   - `applyRunTerminal` — the succeeded apply / destroy-apply ApplyRun, written
 *     into the SAME atomic unit so the run's terminal status can never tear from
 *     the Deployment it produced (a crash between the commit and a separate
 *     terminal write would otherwise leave a stuck `running` run over a finished
 *     Deployment). Its `lease_token` fence is CLEARED on the same write (mirrors
 *     {@link OpenTofuDeploymentStore.transitionRun} `clearLeaseToken`). Absent for
 *     the no-state-context fallback path (which has no atomic unit to join).
 *   - `planRunApplied` — the source PlanRun carrying its `appliedApplyRunId`
 *     marker (apply-once), written into the SAME atomic unit so the
 *     plan-was-applied fact lands with the Deployment + terminal ApplyRun. The
 *     PlanRun is already terminal (`succeeded`) and carries no lease fence, so it
 *     is a plain row write (no lease column change). Absent on the fallback path.
 */
export interface CommitAppliedDeploymentInput {
  readonly newDeployment?: Deployment;
  readonly supersededDeployment?: Deployment;
  readonly stateSnapshot: StateSnapshot;
  readonly outputSnapshot?: OutputSnapshot;
  readonly installationPatch: {
    readonly id: string;
    readonly patch: InstallationPatch;
    readonly guard: InstallationPatchGuard;
  };
  /**
   * Succeeded apply / destroy-apply ApplyRun, committed atomically with the
   * Deployment. Its lease fence token is cleared on the same write.
   */
  readonly applyRunTerminal?: ApplyRun;
  /**
   * Fence token held by the worker attempting to commit `applyRunTerminal`.
   * A mismatch means a stale worker lost ownership; stores return
   * `{ applyRunLeaseLost: true }` without writing any part of the apply ledger.
   */
  readonly applyRunLeaseToken?: string;
  /**
   * Source PlanRun with its `appliedApplyRunId` marker (apply-once), committed
   * atomically with the Deployment. Plain row write (no lease change).
   */
  readonly planRunApplied?: PlanRun;
}

export interface CommitRestoredStateResult {
  readonly installation?: Installation;
  /**
   * The restore run no longer holds the expected lease fence. No restore ledger
   * writes were applied; callers must treat this as a stale worker/no-op.
   */
  readonly restoreRunLeaseLost?: true;
}

export interface CommitRestoredStateInput {
  readonly stateSnapshot: StateSnapshot;
  readonly installationPatch: {
    readonly id: string;
    readonly patch: InstallationPatch;
    readonly guard: {
      readonly currentStateGeneration: number;
      readonly status?: Installation["status"];
    };
  };
  readonly restoreRunTerminal: Run;
  readonly restoreRunLeaseToken: string;
}

/**
 * Status-conditional, lease-fenced compare-and-set transition of a single run
 * row (the most correctness-critical primitive of the queue consumer). Unlike
 * {@link OpenTofuDeploymentStore.putPlanRun} / `putApplyRun` (which INSERT/upsert
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
 *   - `run` — the new run payload to persist on a win; its `status` is the SET
 *     target (the row's status column + run JSON both move to `run.status`).
 *   - `setLeaseToken` / `clearLeaseToken` — the lease column write on a win:
 *     `setLeaseToken` stamps a new fence token, `clearLeaseToken` nulls it.
 *     Mutually exclusive; omit both to leave the lease column unchanged.
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
  readonly run: PlanRun | ApplyRun | SourceSyncRun | Run;
  readonly setLeaseToken?: string;
  readonly clearLeaseToken?: boolean;
  readonly heartbeatAt?: number;
}

export interface TransitionRunResult {
  readonly won: boolean;
  readonly run?: PlanRun | ApplyRun | SourceSyncRun | Run;
}

export type StoredRunRecord = PlanRun | ApplyRun | SourceSyncRun | Run;

export interface CreditAmountInput {
  readonly usdMicros?: number;
  /**
   * @deprecated Use `usdMicros`. Legacy credits are interpreted as USD amounts.
   */
  readonly credits?: number;
}

export interface OpenTofuDeploymentStore {
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
  putBackupRun(run: Run): Promise<Run>;
  getBackupRun(id: string): Promise<Run | undefined>;
  listRunsBySpace(
    spaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly StoredRunRecord[]>;

  // Artifact ledger rows (spec §30 artifacts). Artifact bytes live in object
  // storage; these rows keep non-secret run-scoped pointers for audit and
  // backup/export manifests.
  putArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord>;
  listArtifactRecordsForRun(runId: string): Promise<readonly ArtifactRecord[]>;

  // Space records (spec §4). The owner namespace Installations live under.
  putSpace(space: Space): Promise<Space>;
  getSpace(id: string): Promise<Space | undefined>;
  getSpaceByHandle(handle: string): Promise<Space | undefined>;
  listSpaces(): Promise<readonly Space[]>;
  /**
   * Lists only the Spaces directly owned by `ownerUserId` (spec §4), same
   * `(createdAt, id)` sort as `listSpaces`. Used by the dashboard session
   * `GET /api/v1/spaces` to scope the read to the caller's spaces instead of
   * loading every tenant's Space and filtering in the route.
   */
  listSpacesByOwner(ownerUserId: string): Promise<readonly Space[]>;

  // InstallConfig records (spec §11). `spaceId` absent = built-in shared config.
  putInstallConfig(config: InstallConfig): Promise<InstallConfig>;
  getInstallConfig(id: string): Promise<InstallConfig | undefined>;
  listInstallConfigs(spaceId?: string): Promise<readonly InstallConfig[]>;

  // Installation records (spec §5 / §27, UNIQUE(space_id, name, environment)).
  putInstallation(installation: Installation): Promise<Installation>;
  getInstallation(id: string): Promise<Installation | undefined>;
  getInstallationByName(
    spaceId: string,
    name: string,
    environment: string,
  ): Promise<Installation | undefined>;
  listInstallations(spaceId?: string): Promise<readonly Installation[]>;
  /**
   * Keyset-paged Installation listing (spec §30 list route). Pages by the
   * existing `(createdAt, id)` sort; returns at most `params.limit` (default /
   * cap {@link MAX_PAGE_LIMIT}) rows plus an opaque `nextCursor` when more exist.
   */
  listInstallationsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<Installation>>;
  patchInstallation(
    id: string,
    patch: InstallationPatch,
    guard?: InstallationPatchGuard,
  ): Promise<Installation | undefined>;

  /**
   * Atomically commits the ledger writes that finalize a successful apply /
   * destroy-apply (spec §20 / §21 / §16): the new/superseded Deployment(s), the
   * StateSnapshot, the (apply-only) OutputSnapshot, and the GUARDED Installation
   * advance — all-or-nothing so a mid-sequence failure can never leave torn
   * state. Returns the patched Installation, or `{ installation: undefined }`
   * when the guard would not match (same guard-miss semantics as
   * {@link patchInstallation}); throws {@link InstallationPatchGuardConflict}
   * when the row moved out from under the writer. See
   * {@link CommitAppliedDeploymentInput} for how the controller builds the unit.
   */
  commitAppliedDeployment(
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult>;

  commitRestoredState(
    input: CommitRestoredStateInput,
  ): Promise<CommitRestoredStateResult>;

  putDeployment(deployment: Deployment): Promise<Deployment>;
  getDeployment(id: string): Promise<Deployment | undefined>;
  listDeployments(installationId: string): Promise<readonly Deployment[]>;
  /**
   * Lists ALL Deployments for a Space in one query (space-scoped read used by
   * the control-backup bundle to avoid a per-Installation round-trip). Backed by
   * the `space_id` column/index; the in-memory store filters. Order is not
   * contractual — callers that need per-Installation grouping/order re-group.
   */
  listDeploymentsBySpace(spaceId: string): Promise<readonly Deployment[]>;
  /** Keyset-paged Deployment listing for an Installation (spec §30). */
  listDeploymentsPage(
    installationId: string,
    params: PageParams,
  ): Promise<Page<Deployment>>;

  // Connection records (public fields) + their sealed secret blobs. The blob is
  // stored in a separate namespace so the public Connection can be listed
  // without ever touching ciphertext.
  putConnection(connection: Connection): Promise<Connection>;
  getConnection(id: string): Promise<Connection | undefined>;
  listConnections(spaceId: string): Promise<readonly Connection[]>;
  /** Keyset-paged Space Connection listing (spec §30 connection list route). */
  listConnectionsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<Connection>>;
  /**
   * Lists instance-wide `operator`-scoped Connections (no owning Space). Backs
   * the §30 operator-scope `GET /api/connections` listing for the unrestricted
   * bearer when `?spaceId` is omitted.
   */
  listOperatorConnections(): Promise<readonly Connection[]>;
  deleteConnection(id: string): Promise<boolean>;

  putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob>;
  getSecretBlob(connectionId: string): Promise<StoredSecretBlob | undefined>;
  deleteSecretBlob(connectionId: string): Promise<boolean>;

  putProviderCatalogEntry(
    entry: ProviderCatalogEntry,
  ): Promise<ProviderCatalogEntry>;
  getProviderCatalogEntry(
    id: string,
  ): Promise<ProviderCatalogEntry | undefined>;
  listProviderCatalogEntries(): Promise<readonly ProviderCatalogEntry[]>;

  putProviderEnv(env: ProviderEnv): Promise<ProviderEnv>;
  getProviderEnv(id: string): Promise<ProviderEnv | undefined>;
  listProviderEnvs(spaceId?: string): Promise<readonly ProviderEnv[]>;

  // Source records (public fields + internal hook-secret hash / lastSeenCommit /
  // autoSync). The hook secret plaintext is NEVER stored.
  putSource(source: StoredSource): Promise<StoredSource>;
  getSource(id: string): Promise<StoredSource | undefined>;
  listSources(spaceId?: string): Promise<readonly StoredSource[]>;
  /** Keyset-paged Source listing for a Space (spec §30 source list route). */
  listSourcesPage(
    spaceId: string,
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
   * rather than space-scoping; upload-origin snapshots (no `sourceId`) are not
   * returned. An empty `sourceIds` yields an empty result. Order is not
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
      readonly installationId?: string;
    },
  ): Promise<CapsuleCompatibilityReport | undefined>;

  // Installation provider env binding records, one row per
  // (installation, environment), with that pair as the upsert key.
  putInstallationProviderEnvBindingSet(
    profile: InstallationProviderEnvBindingSet,
  ): Promise<InstallationProviderEnvBindingSet>;
  getInstallationProviderEnvBindingSetByInstallation(
    installationId: string,
    environment: string,
  ): Promise<InstallationProviderEnvBindingSet | undefined>;

  // StateSnapshot records (spec §20). Immutable per-(installation, environment,
  // generation) metadata recorded after a successful apply/destroy state
  // persist. The encrypted state bytes live in R2_STATE; only the metadata
  // enters the ledger.
  putStateSnapshot(snapshot: StateSnapshot): Promise<StateSnapshot>;
  getLatestStateSnapshot(
    installationId: string,
    environment: string,
  ): Promise<StateSnapshot | undefined>;
  listStateSnapshots(
    installationId: string,
    environment: string,
  ): Promise<readonly StateSnapshot[]>;
  /**
   * Lists ALL StateSnapshots for a Space in one query (space-scoped read used by
   * the control-backup bundle to avoid a per-Installation round-trip). Backed by
   * the `space_id` column; the in-memory store filters. Spans all environments —
   * callers that need per-(installation, environment) grouping/order re-group.
   */
  listStateSnapshotsBySpace(spaceId: string): Promise<readonly StateSnapshot[]>;

  // Dependency DAG edges (spec §14 / §15 / §27 installation_dependencies). A
  // Dependency connects a producer Installation's outputs to a consumer
  // Installation's inputs within the SAME Space.
  putDependency(dependency: Dependency): Promise<Dependency>;
  getDependency(id: string): Promise<Dependency | undefined>;
  listDependenciesBySpace(spaceId: string): Promise<readonly Dependency[]>;
  listDependenciesForConsumer(
    consumerInstallationId: string,
  ): Promise<readonly Dependency[]>;
  listDependenciesForProducer(
    producerInstallationId: string,
  ): Promise<readonly Dependency[]>;
  deleteDependency(id: string): Promise<boolean>;

  // DependencySnapshot records (spec §17 / §27 dependency_snapshots). The plan
  // path pins one per run; the apply path re-reads it to verify producer state
  // generations / pinned values before applying (invariant 9).
  putDependencySnapshot(
    snapshot: DependencySnapshot,
  ): Promise<DependencySnapshot>;
  getDependencySnapshot(id: string): Promise<DependencySnapshot | undefined>;

  // OutputSnapshot records (spec §16 / §27 output_snapshots). Recorded after a
  // successful apply: the projected spaceOutputs / publicOutputs + digest; the
  // raw envelope stays an encrypted R2_ARTIFACTS artifact (rawOutputArtifactKey).
  putOutputSnapshot(snapshot: OutputSnapshot): Promise<OutputSnapshot>;
  getOutputSnapshot(id: string): Promise<OutputSnapshot | undefined>;
  getLatestOutputSnapshot(
    installationId: string,
  ): Promise<OutputSnapshot | undefined>;
  listOutputSnapshots(
    installationId: string,
  ): Promise<readonly OutputSnapshot[]>;
  /**
   * Lists ALL OutputSnapshots for a Space in one query (space-scoped read used by
   * the control-backup bundle to avoid a per-Installation round-trip). Backed by
   * the `space_id` column; the in-memory store filters. Order is not
   * contractual — callers that need per-Installation grouping/order re-group.
   */
  listOutputSnapshotsBySpace(
    spaceId: string,
  ): Promise<readonly OutputSnapshot[]>;

  // OutputShare records (spec §18 / §27 output_shares). A cross-Space grant from
  // a producer Installation's projected outputs (in fromSpace) to a consumer
  // Space (toSpace). The grant carries names + optional aliases only (sensitive
  // sharing is not supported, invariant 12); resolved output VALUES are never
  // stored on the share.
  putOutputShare(share: OutputShare): Promise<OutputShare>;
  getOutputShare(id: string): Promise<OutputShare | undefined>;
  /** Shares GRANTED BY a Space (the producer side; spaceId = fromSpaceId). */
  listOutputSharesFromSpace(
    fromSpaceId: string,
  ): Promise<readonly OutputShare[]>;
  /** Shares GRANTED TO a Space (the consumer side; spaceId = toSpaceId). */
  listOutputSharesToSpace(toSpaceId: string): Promise<readonly OutputShare[]>;

  // RunGroup records (spec §19 / §24 / §27 run_groups). Orders multiple Runs
  // across the dependency DAG (e.g. a Space update after stale propagation).
  putRunGroup(group: RunGroup): Promise<RunGroup>;
  getRunGroup(id: string): Promise<RunGroup | undefined>;
  listRunGroups(spaceId: string): Promise<readonly RunGroup[]>;

  // Activity audit-trail records (spec §27 audit_events / §34 Activity). The
  // Space-scoped audit ledger surfaced in the dashboard Activity view. Listing
  // orders newest first (createdAt desc, id desc) and defaults to 100 rows.
  putActivityEvent(event: ActivityEvent): Promise<ActivityEvent>;
  listActivityEvents(
    spaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly ActivityEvent[]>;

  // Credential mint audit rows (spec invariant 17). Values are never persisted;
  // this ledger records only run/space/installation/connection/phase metadata.
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
    spaceId: string,
    options?: { readonly runId?: string; readonly limit?: number },
  ): Promise<readonly SecurityFinding[]>;

  // Billing USD ledger (§28). Plan creates reservations in showback/enforce;
  // apply confirms/captures them before provider credential mint. Legacy
  // `credits` inputs are interpreted as whole-dollar compatibility aliases.
  putBillingPlan(plan: BillingPlan): Promise<BillingPlan>;
  getBillingPlan(id: string): Promise<BillingPlan | undefined>;
  putBillingAccount(account: BillingAccount): Promise<BillingAccount>;
  getBillingAccount(id: string): Promise<BillingAccount | undefined>;
  getBillingAccountForOwner(
    ownerType: BillingAccount["ownerType"],
    ownerId: string,
  ): Promise<BillingAccount | undefined>;
  putSpaceSubscription(
    subscription: SpaceSubscription,
  ): Promise<SpaceSubscription>;
  getSpaceSubscription(spaceId: string): Promise<SpaceSubscription | undefined>;
  putCreditBalance(balance: CreditBalance): Promise<CreditBalance>;
  getCreditBalance(spaceId: string): Promise<CreditBalance | undefined>;
  reserveCredits(
    spaceId: string,
    input: CreditAmountInput & { readonly updatedAt: string },
  ): Promise<CreditBalance | undefined>;
  /**
   * Atomically adds a credit GRANT (top-up / pack purchase / subscription
   * invoice grant) to a Space's available + purchased columns in a single
   * UPDATE — no read-modify-write — so concurrent webhook deliveries cannot
   * lose updates. Creates a zero balance row first when the Space has none, so
   * the first grant lands. `usdMicros` must be positive. Legacy `credits`
   * remains accepted as a whole-dollar compatibility alias. Returns the new
   * balance.
   */
  addCredits(
    spaceId: string,
    input: CreditAmountInput & { readonly updatedAt: string },
  ): Promise<CreditBalance>;
  /**
   * Atomically applies the monthly subscription RESET: carries over purchased
   * USD grant and resets the monthly allotment to full, in one conditional
   * UPDATE — `available = max(0, available - oldMonthly) + newMonthly`,
   * `monthlyIncludedUsdMicros = newMonthly` (all column-relative, no read). The
   * WHERE guard (`monthlyIncludedCredits != newMonthly OR updatedAt <
   * periodStartIso`) makes it idempotent per billing period so concurrent
   * reconciles cannot double-grant. Returns the balance when applied,
   * `undefined` when the guard skipped it (already reconciled) or the row is
   * absent.
   */
  reconcileMonthlyCredits(
    spaceId: string,
    input: {
      readonly newMonthly: number;
      readonly periodStartIso: string;
      readonly updatedAt: string;
    },
  ): Promise<CreditBalance | undefined>;
  putCreditReservation(
    reservation: CreditReservation,
  ): Promise<CreditReservation>;
  getCreditReservationForRun(
    runId: string,
  ): Promise<CreditReservation | undefined>;
  listCreditReservations(
    spaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly CreditReservation[]>;
  putUsageEvent(event: UsageEvent): Promise<UsageEvent>;
  listUsageEvents(spaceId: string): Promise<readonly UsageEvent[]>;
  /** Keyset-paged usage-event listing for a Space (spec §30 pagination). */
  listUsageEventsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<UsageEvent>>;

  // Control-backup ledger pointers (spec §33 layer 1 / §26 R2_BACKUPS). One row
  // per sealed control-backup bundle written to R2_BACKUPS. The bundle bytes
  // live in object storage; only the pointer (objectKey / digest / sizeBytes)
  // enters the ledger. Listing orders newest first (createdAt desc, id desc).
  putBackupRecord(record: BackupRecord): Promise<BackupRecord>;
  getBackupRecord(id: string): Promise<BackupRecord | undefined>;
  listBackupRecords(spaceId: string): Promise<readonly BackupRecord[]>;
  /**
   * Keyset-paged control-backup listing for a Space (spec §30 pagination).
   * Ordered newest-first (createdAt DESC, id DESC), so the keyset descends.
   */
  listBackupRecordsPage(
    spaceId: string,
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

export class InMemoryOpenTofuDeploymentStore implements OpenTofuDeploymentStore {
  readonly #runnerProfiles = new Map<string, RunnerProfile>();
  readonly #planRuns = new Map<string, PlanRun>();
  readonly #planRunInputs = new Map<string, PlanRunInputs>();
  readonly #applyRuns = new Map<string, ApplyRun>();
  /**
   * Per-run lease fence tokens. `leaseToken` is NOT a field of the public
   * PlanRun / ApplyRun JSON (it rides only the indexed `runs.lease_token`
   * column in the SQL / D1 backends), so the in-memory store keeps it in a
   * side map keyed by run id to mirror the same fence semantics in
   * {@link transitionRun}.
   */
  readonly #runLeases = new Map<string, string>();
  readonly #sourceSyncRuns = new Map<string, SourceSyncRun>();
  readonly #backupRuns = new Map<string, Run>();
  readonly #spaces = new Map<string, Space>();
  readonly #installConfigs = new Map<string, InstallConfig>();
  readonly #installations = new Map<string, Installation>();
  readonly #deployments = new Map<string, Deployment>();
  readonly #connections = new Map<string, Connection>();
  readonly #secretBlobs = new Map<string, StoredSecretBlob>();
  readonly #providerCatalog = new Map<string, ProviderCatalogEntry>();
  readonly #providerEnvs = new Map<string, ProviderEnv>();
  readonly #sources = new Map<string, StoredSource>();
  readonly #sourceSnapshots = new Map<string, SourceSnapshot>();
  readonly #capsuleCompatibilityReports = new Map<
    string,
    CapsuleCompatibilityReport
  >();
  readonly #providerEnvBindingSets = new Map<
    string,
    InstallationProviderEnvBindingSet
  >();
  readonly #stateSnapshots = new Map<string, StateSnapshot>();
  readonly #dependencies = new Map<string, Dependency>();
  readonly #dependencySnapshots = new Map<string, DependencySnapshot>();
  readonly #outputSnapshots = new Map<string, OutputSnapshot>();
  readonly #outputShares = new Map<string, OutputShare>();
  readonly #runGroups = new Map<string, RunGroup>();
  readonly #compatibilityCheckRuns = new Map<string, Run>();
  readonly #activityEvents = new Map<string, ActivityEvent>();
  readonly #credentialMintEvents = new Map<string, CredentialMintEvent>();
  readonly #securityFindings = new Map<string, SecurityFinding>();
  readonly #billingPlans = new Map<string, BillingPlan>();
  readonly #billingAccounts = new Map<string, BillingAccount>();
  readonly #spaceSubscriptions = new Map<string, SpaceSubscription>();
  readonly #creditBalances = new Map<string, CreditBalance>();
  readonly #creditReservations = new Map<string, CreditReservation>();
  readonly #usageEvents = new Map<string, UsageEvent>();
  readonly #backupRecords = new Map<string, BackupRecord>();
  readonly #artifactRecords = new Map<string, ArtifactRecord>();

  constructor() {
    maybeWarnInMemoryStore("InMemoryOpenTofuDeploymentStore");
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
    this.#planRuns.set(run.id, run);
    return Promise.resolve(run);
  }

  getPlanRun(id: string): Promise<PlanRun | undefined> {
    return Promise.resolve(coerceRunRowStatus(this.#planRuns.get(id)));
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
    this.#applyRuns.set(run.id, run);
    return Promise.resolve(run);
  }

  getApplyRun(id: string): Promise<ApplyRun | undefined> {
    return Promise.resolve(coerceRunRowStatus(this.#applyRuns.get(id)));
  }

  /**
   * In-memory compare-and-set. The store is single-threaded, so the read +
   * conditional write are already atomic with respect to other awaits; the JS
   * predicate is byte-identical in SEMANTICS to the SQL / D1 fenced UPDATE:
   * the transition fires only when the current status is in `expectFrom` AND
   * (when `expectLeaseToken` is set) the current lease token matches. A miss
   * re-reads (here: returns the unchanged in-memory row) with `won: false`.
   */
  transitionRun(input: TransitionRunInput): Promise<TransitionRunResult> {
    const map: Map<string, PlanRun | ApplyRun | SourceSyncRun | Run> =
      input.kind === "plan"
        ? this.#planRuns
        : input.kind === "apply"
          ? this.#applyRuns
          : input.kind === "source_sync"
            ? this.#sourceSyncRuns
            : this.#backupRuns;
    const current = map.get(input.id);
    if (!current) return Promise.resolve({ won: false });
    const currentLease = this.#runLeases.get(input.id);
    const statusMatches = input.expectFrom.includes(current.status);
    const leaseMatches =
      input.expectLeaseToken === undefined ||
      input.expectLeaseToken === currentLease;
    const currentHeartbeat = current.heartbeatAt ?? null;
    const heartbeatMatches =
      input.expectHeartbeatAt === undefined ||
      input.expectHeartbeatAt === currentHeartbeat;
    if (!statusMatches || !leaseMatches || !heartbeatMatches) {
      return Promise.resolve({ won: false, run: current });
    }
    // Resolve the heartbeat the same way the SQL / D1 legs do: the input's
    // explicit `heartbeatAt` wins, else the heartbeat carried on `run`.
    const heartbeatAt = input.heartbeatAt ?? input.run.heartbeatAt;
    const persisted: PlanRun | ApplyRun | SourceSyncRun | Run = {
      ...input.run,
      ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
    } as PlanRun | ApplyRun | SourceSyncRun | Run;
    map.set(input.id, persisted);
    if (input.clearLeaseToken) {
      this.#runLeases.delete(input.id);
    } else if (input.setLeaseToken !== undefined) {
      this.#runLeases.set(input.id, input.setLeaseToken);
    }
    return Promise.resolve({ won: true, run: persisted });
  }

  putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    this.#sourceSyncRuns.set(run.id, run);
    return Promise.resolve(run);
  }

  getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    return Promise.resolve(this.#sourceSyncRuns.get(id));
  }

  listSourceSyncRuns(sourceId: string): Promise<readonly SourceSyncRun[]> {
    return Promise.resolve(
      Array.from(this.#sourceSyncRuns.values())
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
    this.#compatibilityCheckRuns.set(run.id, run);
    return Promise.resolve(run);
  }

  getCompatibilityCheckRun(id: string): Promise<Run | undefined> {
    return Promise.resolve(this.#compatibilityCheckRuns.get(id));
  }

  putBackupRun(run: Run): Promise<Run> {
    if (run.type !== "backup" && run.type !== "restore") {
      return Promise.reject(
        new Error("putBackupRun only accepts backup/restore runs"),
      );
    }
    this.#backupRuns.set(run.id, run);
    return Promise.resolve(run);
  }

  getBackupRun(id: string): Promise<Run | undefined> {
    return Promise.resolve(this.#backupRuns.get(id));
  }

  listRunsBySpace(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly StoredRunRecord[]> {
    const limit = clampRunListLimit(options.limit);
    const rows: StoredRunRecord[] = [
      ...this.#planRuns.values(),
      ...this.#applyRuns.values(),
      ...this.#sourceSyncRuns.values(),
      ...this.#compatibilityCheckRuns.values(),
      ...this.#backupRuns.values(),
    ].filter((row) => row.spaceId === spaceId);
    return Promise.resolve(
      rows.sort(compareStoredRunRecordsDesc).slice(0, limit),
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

  putSpace(space: Space): Promise<Space> {
    this.#spaces.set(space.id, space);
    return Promise.resolve(space);
  }

  getSpace(id: string): Promise<Space | undefined> {
    return Promise.resolve(this.#spaces.get(id));
  }

  getSpaceByHandle(handle: string): Promise<Space | undefined> {
    return Promise.resolve(
      Array.from(this.#spaces.values()).find((row) => row.handle === handle),
    );
  }

  listSpaces(): Promise<readonly Space[]> {
    return Promise.resolve(
      Array.from(this.#spaces.values()).sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  listSpacesByOwner(ownerUserId: string): Promise<readonly Space[]> {
    return Promise.resolve(
      Array.from(this.#spaces.values())
        .filter((row) => row.ownerUserId === ownerUserId)
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

  listInstallConfigs(spaceId?: string): Promise<readonly InstallConfig[]> {
    const rows = Array.from(this.#installConfigs.values());
    const filtered =
      spaceId === undefined
        ? rows
        : rows.filter((row) => row.spaceId === spaceId);
    return Promise.resolve(
      filtered.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  putInstallation(installation: Installation): Promise<Installation> {
    for (const existing of this.#installations.values()) {
      if (
        existing.id !== installation.id &&
        existing.spaceId === installation.spaceId &&
        existing.name === installation.name &&
        existing.environment === installation.environment
      ) {
        return Promise.reject(
          new Error(
            `installation unique(space_id, name, environment) violated: ` +
              `@${installation.spaceId}/${installation.name} ` +
              `(${installation.environment})`,
          ),
        );
      }
    }
    this.#installations.set(installation.id, installation);
    return Promise.resolve(installation);
  }

  getInstallation(id: string): Promise<Installation | undefined> {
    return Promise.resolve(this.#installations.get(id));
  }

  getInstallationByName(
    spaceId: string,
    name: string,
    environment: string,
  ): Promise<Installation | undefined> {
    return Promise.resolve(
      Array.from(this.#installations.values()).find(
        (row) =>
          row.spaceId === spaceId &&
          row.name === name &&
          row.environment === environment,
      ),
    );
  }

  listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    const rows = Array.from(this.#installations.values());
    const filtered =
      spaceId === undefined
        ? rows
        : rows.filter((row) => row.spaceId === spaceId);
    return Promise.resolve(
      filtered.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  async listInstallationsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<Installation>> {
    return pageSorted(await this.listInstallations(spaceId), params);
  }

  patchInstallation(
    id: string,
    patch: InstallationPatch,
    guard?: InstallationPatchGuard,
  ): Promise<Installation | undefined> {
    const existing = this.#installations.get(id);
    if (!existing) return Promise.resolve(undefined);
    if (
      guard !== undefined &&
      (existing.currentDeploymentId !== guard.currentDeploymentId ||
        (guard.status !== undefined && existing.status !== guard.status))
    ) {
      return Promise.reject(
        new InstallationPatchGuardConflict({
          id,
          expectedCurrentDeploymentId: guard.currentDeploymentId,
          actualCurrentDeploymentId: existing.currentDeploymentId,
          expectedStatus: guard.status,
          actualStatus: existing.status,
        }),
      );
    }
    const updated: Installation = { ...existing, ...patch };
    this.#installations.set(id, updated);
    return Promise.resolve(updated);
  }

  /**
   * In-memory commit. The store is single-threaded, so the sequential writes are
   * already atomic with respect to other awaits — there is no concurrent writer
   * to interleave. There is, however, NO rollback: if a write throws partway
   * (e.g. the guarded patch hits a conflict), the Deployment / StateSnapshot /
   * OutputSnapshot already set into the maps stay set. The SQL and D1 backends
   * roll back / batch for true all-or-nothing; the in-memory store is dev/test
   * only and surfaces the error to the caller, which fails the run. To keep the
   * guard-conflict case torn-free even here, the GUARDED installation patch is
   * evaluated FIRST so a guard miss/conflict short-circuits before any
   * Deployment / snapshot write lands.
   */
  commitAppliedDeployment(
    input: CommitAppliedDeploymentInput,
  ): Promise<CommitAppliedDeploymentResult> {
    const { installationPatch } = input;
    if (
      input.applyRunTerminal &&
      input.applyRunLeaseToken !== undefined &&
      this.#runLeases.get(input.applyRunTerminal.id) !==
        input.applyRunLeaseToken
    ) {
      return Promise.resolve({ applyRunLeaseLost: true });
    }
    const existing = this.#installations.get(installationPatch.id);
    if (!existing) {
      return Promise.resolve({ installation: undefined });
    }
    const guard = installationPatch.guard;
    if (
      existing.currentDeploymentId !== guard.currentDeploymentId ||
      (guard.status !== undefined && existing.status !== guard.status)
    ) {
      return Promise.reject(
        new InstallationPatchGuardConflict({
          id: installationPatch.id,
          expectedCurrentDeploymentId: guard.currentDeploymentId,
          actualCurrentDeploymentId: existing.currentDeploymentId,
          expectedStatus: guard.status,
          actualStatus: existing.status,
        }),
      );
    }
    if (input.newDeployment) {
      this.#deployments.set(input.newDeployment.id, input.newDeployment);
    }
    if (input.supersededDeployment) {
      this.#deployments.set(
        input.supersededDeployment.id,
        input.supersededDeployment,
      );
    }
    this.#stateSnapshots.set(input.stateSnapshot.id, input.stateSnapshot);
    if (input.outputSnapshot) {
      this.#outputSnapshots.set(input.outputSnapshot.id, input.outputSnapshot);
    }
    // Commit-tail fold (S2): the terminal ApplyRun + the applied PlanRun land in
    // the SAME atomic unit as the Deployment so a crash can no longer tear them.
    // The apply terminal clears its lease fence (mirrors transitionRun
    // clearLeaseToken); the plan patch is a plain write (already terminal, no
    // lease).
    if (input.applyRunTerminal) {
      this.#applyRuns.set(input.applyRunTerminal.id, input.applyRunTerminal);
      this.#runLeases.delete(input.applyRunTerminal.id);
    }
    if (input.planRunApplied) {
      this.#planRuns.set(input.planRunApplied.id, input.planRunApplied);
    }
    const updated: Installation = { ...existing, ...installationPatch.patch };
    this.#installations.set(installationPatch.id, updated);
    return Promise.resolve({ installation: updated });
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
    const { installationPatch } = input;
    const existing = this.#installations.get(installationPatch.id);
    if (!existing) {
      return Promise.resolve({ installation: undefined });
    }
    const guard = installationPatch.guard;
    if (
      existing.currentStateGeneration !== guard.currentStateGeneration ||
      (guard.status !== undefined && existing.status !== guard.status)
    ) {
      return Promise.reject(
        new InstallationStateGenerationGuardConflict({
          id: installationPatch.id,
          expectedCurrentStateGeneration: guard.currentStateGeneration,
          actualCurrentStateGeneration: existing.currentStateGeneration,
          expectedStatus: guard.status,
          actualStatus: existing.status,
        }),
      );
    }
    const updated: Installation = { ...existing, ...installationPatch.patch };
    this.#stateSnapshots.set(input.stateSnapshot.id, input.stateSnapshot);
    this.#backupRuns.set(input.restoreRunTerminal.id, input.restoreRunTerminal);
    this.#runLeases.delete(input.restoreRunTerminal.id);
    this.#installations.set(installationPatch.id, updated);
    return Promise.resolve({ installation: updated });
  }

  putDeployment(deployment: Deployment): Promise<Deployment> {
    this.#deployments.set(deployment.id, deployment);
    return Promise.resolve(deployment);
  }

  getDeployment(id: string): Promise<Deployment | undefined> {
    return Promise.resolve(this.#deployments.get(id));
  }

  listDeployments(installationId: string): Promise<readonly Deployment[]> {
    return Promise.resolve(
      Array.from(this.#deployments.values())
        .filter((row) => row.installationId === installationId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listDeploymentsBySpace(spaceId: string): Promise<readonly Deployment[]> {
    return Promise.resolve(
      Array.from(this.#deployments.values()).filter(
        (row) => row.spaceId === spaceId,
      ),
    );
  }

  async listDeploymentsPage(
    installationId: string,
    params: PageParams,
  ): Promise<Page<Deployment>> {
    return pageSorted(await this.listDeployments(installationId), params);
  }

  putConnection(connection: Connection): Promise<Connection> {
    this.#connections.set(connection.id, connection);
    return Promise.resolve(connection);
  }

  getConnection(id: string): Promise<Connection | undefined> {
    return Promise.resolve(this.#connections.get(id));
  }

  listConnections(spaceId: string): Promise<readonly Connection[]> {
    return Promise.resolve(
      Array.from(this.#connections.values())
        .filter((row) => row.spaceId === spaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  async listConnectionsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<Connection>> {
    return pageSorted(await this.listConnections(spaceId), params);
  }

  listOperatorConnections(): Promise<readonly Connection[]> {
    return Promise.resolve(
      Array.from(this.#connections.values())
        .filter((row) => row.spaceId === undefined && row.scope === "operator")
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

  putProviderCatalogEntry(
    entry: ProviderCatalogEntry,
  ): Promise<ProviderCatalogEntry> {
    this.#providerCatalog.set(entry.id, entry);
    return Promise.resolve(entry);
  }

  getProviderCatalogEntry(
    id: string,
  ): Promise<ProviderCatalogEntry | undefined> {
    return Promise.resolve(this.#providerCatalog.get(id));
  }

  listProviderCatalogEntries(): Promise<readonly ProviderCatalogEntry[]> {
    return Promise.resolve(
      Array.from(this.#providerCatalog.values()).sort(
        (a, b) =>
          a.displayName.localeCompare(b.displayName) ||
          a.id.localeCompare(b.id),
      ),
    );
  }

  putProviderEnv(env: ProviderEnv): Promise<ProviderEnv> {
    assertProviderEnvGlobalBoundary(env);
    this.#providerEnvs.set(env.id, env);
    return Promise.resolve(env);
  }

  getProviderEnv(id: string): Promise<ProviderEnv | undefined> {
    return Promise.resolve(this.#providerEnvs.get(id));
  }

  listProviderEnvs(spaceId?: string): Promise<readonly ProviderEnv[]> {
    const rows = Array.from(this.#providerEnvs.values()).filter((env) =>
      spaceId === undefined ? true : env.spaceId === spaceId,
    );
    return Promise.resolve(
      rows.sort(
        (a, b) =>
          a.providerSource.localeCompare(b.providerSource) ||
          a.displayName.localeCompare(b.displayName) ||
          a.id.localeCompare(b.id),
      ),
    );
  }

  putSource(source: StoredSource): Promise<StoredSource> {
    this.#sources.set(source.id, source);
    return Promise.resolve(source);
  }

  getSource(id: string): Promise<StoredSource | undefined> {
    return Promise.resolve(this.#sources.get(id));
  }

  listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    const rows = Array.from(this.#sources.values());
    const filtered =
      spaceId === undefined
        ? rows
        : rows.filter((row) => row.spaceId === spaceId);
    return Promise.resolve(
      filtered.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  async listSourcesPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<StoredSource>> {
    return pageSorted(await this.listSources(spaceId), params);
  }

  deleteSource(id: string): Promise<boolean> {
    return Promise.resolve(this.#sources.delete(id));
  }

  putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    this.#sourceSnapshots.set(snapshot.id, snapshot);
    return Promise.resolve(snapshot);
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
    this.#capsuleCompatibilityReports.set(report.id, report);
    return Promise.resolve(report);
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
      readonly installationId?: string;
    } = {},
  ): Promise<CapsuleCompatibilityReport | undefined> {
    const candidates = [...this.#capsuleCompatibilityReports.values()]
      .filter(
        (report) =>
          report.sourceSnapshotId === sourceSnapshotId &&
          (options.sourceId === undefined ||
            report.sourceId === undefined ||
            report.sourceId === options.sourceId) &&
          (options.installationId === undefined ||
            report.installationId === undefined ||
            report.installationId === options.installationId),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
    return Promise.resolve(candidates[0]);
  }

  putInstallationProviderEnvBindingSet(
    profile: InstallationProviderEnvBindingSet,
  ): Promise<InstallationProviderEnvBindingSet> {
    // One profile per (installation, environment): drop a stale row under a
    // different id for the same pair.
    for (const [key, existing] of this.#providerEnvBindingSets) {
      if (
        existing.installationId === profile.installationId &&
        existing.environment === profile.environment &&
        key !== profile.id
      ) {
        this.#providerEnvBindingSets.delete(key);
      }
    }
    this.#providerEnvBindingSets.set(profile.id, profile);
    return Promise.resolve(profile);
  }

  getInstallationProviderEnvBindingSetByInstallation(
    installationId: string,
    environment: string,
  ): Promise<InstallationProviderEnvBindingSet | undefined> {
    return Promise.resolve(
      Array.from(this.#providerEnvBindingSets.values()).find(
        (row) =>
          row.installationId === installationId &&
          row.environment === environment,
      ),
    );
  }

  putStateSnapshot(snapshot: StateSnapshot): Promise<StateSnapshot> {
    this.#stateSnapshots.set(snapshot.id, snapshot);
    return Promise.resolve(snapshot);
  }

  listStateSnapshots(
    installationId: string,
    environment: string,
  ): Promise<readonly StateSnapshot[]> {
    return Promise.resolve(
      Array.from(this.#stateSnapshots.values())
        .filter(
          (row) =>
            row.installationId === installationId &&
            row.environment === environment,
        )
        .sort((a, b) => a.generation - b.generation),
    );
  }

  listStateSnapshotsBySpace(
    spaceId: string,
  ): Promise<readonly StateSnapshot[]> {
    return Promise.resolve(
      Array.from(this.#stateSnapshots.values()).filter(
        (row) => row.spaceId === spaceId,
      ),
    );
  }

  getLatestStateSnapshot(
    installationId: string,
    environment: string,
  ): Promise<StateSnapshot | undefined> {
    let latest: StateSnapshot | undefined;
    for (const row of this.#stateSnapshots.values()) {
      if (
        row.installationId !== installationId ||
        row.environment !== environment
      )
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

  listDependenciesBySpace(spaceId: string): Promise<readonly Dependency[]> {
    return Promise.resolve(
      Array.from(this.#dependencies.values())
        .filter((row) => row.spaceId === spaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listDependenciesForConsumer(
    consumerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return Promise.resolve(
      Array.from(this.#dependencies.values())
        .filter((row) => row.consumerInstallationId === consumerInstallationId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listDependenciesForProducer(
    producerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return Promise.resolve(
      Array.from(this.#dependencies.values())
        .filter((row) => row.producerInstallationId === producerInstallationId)
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

  putOutputSnapshot(snapshot: OutputSnapshot): Promise<OutputSnapshot> {
    this.#outputSnapshots.set(snapshot.id, snapshot);
    return Promise.resolve(snapshot);
  }

  getOutputSnapshot(id: string): Promise<OutputSnapshot | undefined> {
    return Promise.resolve(this.#outputSnapshots.get(id));
  }

  getLatestOutputSnapshot(
    installationId: string,
  ): Promise<OutputSnapshot | undefined> {
    let latest: OutputSnapshot | undefined;
    for (const row of this.#outputSnapshots.values()) {
      if (row.installationId !== installationId) continue;
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

  listOutputSnapshots(
    installationId: string,
  ): Promise<readonly OutputSnapshot[]> {
    return Promise.resolve(
      Array.from(this.#outputSnapshots.values())
        .filter((row) => row.installationId === installationId)
        .sort(
          (a, b) =>
            a.stateGeneration - b.stateGeneration ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        ),
    );
  }

  listOutputSnapshotsBySpace(
    spaceId: string,
  ): Promise<readonly OutputSnapshot[]> {
    return Promise.resolve(
      Array.from(this.#outputSnapshots.values()).filter(
        (row) => row.spaceId === spaceId,
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

  listOutputSharesFromSpace(
    fromSpaceId: string,
  ): Promise<readonly OutputShare[]> {
    return Promise.resolve(
      Array.from(this.#outputShares.values())
        .filter((row) => row.fromSpaceId === fromSpaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  listOutputSharesToSpace(toSpaceId: string): Promise<readonly OutputShare[]> {
    return Promise.resolve(
      Array.from(this.#outputShares.values())
        .filter((row) => row.toSpaceId === toSpaceId)
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

  listRunGroups(spaceId: string): Promise<readonly RunGroup[]> {
    return Promise.resolve(
      Array.from(this.#runGroups.values())
        .filter((row) => row.spaceId === spaceId)
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
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ActivityEvent[]> {
    const limit = clampActivityLimit(options.limit);
    const rows = Array.from(this.#activityEvents.values())
      .filter((row) => row.spaceId === spaceId)
      // Newest first: createdAt desc, then id desc as a stable tie-break.
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      )
      .slice(0, limit);
    return Promise.resolve(rows);
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
    spaceId: string,
    options: { readonly runId?: string; readonly limit?: number } = {},
  ): Promise<readonly SecurityFinding[]> {
    const limit = clampActivityLimit(options.limit);
    return Promise.resolve(
      Array.from(this.#securityFindings.values())
        .filter((row) => row.spaceId === spaceId)
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

  putCreditBalance(balance: CreditBalance): Promise<CreditBalance> {
    const normalized = normalizeCreditBalance(balance);
    this.#creditBalances.set(balance.spaceId, normalized);
    return Promise.resolve(normalized);
  }

  putBillingPlan(plan: BillingPlan): Promise<BillingPlan> {
    const normalized = normalizeBillingPlan(plan);
    this.#billingPlans.set(plan.id, normalized);
    return Promise.resolve(normalized);
  }

  getBillingPlan(id: string): Promise<BillingPlan | undefined> {
    const plan = this.#billingPlans.get(id);
    return Promise.resolve(plan ? normalizeBillingPlan(plan) : undefined);
  }

  putBillingAccount(account: BillingAccount): Promise<BillingAccount> {
    this.#billingAccounts.set(account.id, account);
    return Promise.resolve(account);
  }

  getBillingAccount(id: string): Promise<BillingAccount | undefined> {
    return Promise.resolve(this.#billingAccounts.get(id));
  }

  getBillingAccountForOwner(
    ownerType: BillingAccount["ownerType"],
    ownerId: string,
  ): Promise<BillingAccount | undefined> {
    const account = Array.from(this.#billingAccounts.values()).find(
      (row) => row.ownerType === ownerType && row.ownerId === ownerId,
    );
    return Promise.resolve(account);
  }

  putSpaceSubscription(
    subscription: SpaceSubscription,
  ): Promise<SpaceSubscription> {
    this.#spaceSubscriptions.set(subscription.id, subscription);
    return Promise.resolve(subscription);
  }

  getSpaceSubscription(
    spaceId: string,
  ): Promise<SpaceSubscription | undefined> {
    const subscriptions = Array.from(this.#spaceSubscriptions.values())
      .filter((row) => row.spaceId === spaceId)
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      );
    return Promise.resolve(subscriptions[0]);
  }

  getCreditBalance(spaceId: string): Promise<CreditBalance | undefined> {
    const balance = this.#creditBalances.get(spaceId);
    return Promise.resolve(
      balance ? normalizeCreditBalance(balance) : undefined,
    );
  }

  reserveCredits(
    spaceId: string,
    input: CreditAmountInput & { readonly updatedAt: string },
  ): Promise<CreditBalance | undefined> {
    const balance = normalizeCreditBalance(this.#creditBalances.get(spaceId));
    const usdMicros = creditAmountUsdMicros(input);
    if (!balance || creditBalanceAvailableUsdMicros(balance) < usdMicros) {
      return Promise.resolve(undefined);
    }
    const availableUsdMicros =
      creditBalanceAvailableUsdMicros(balance) - usdMicros;
    const reservedUsdMicros =
      creditBalanceReservedUsdMicros(balance) + usdMicros;
    const next = {
      ...balance,
      availableUsdMicros,
      reservedUsdMicros,
      availableCredits: usdMicrosToLegacyCredits(availableUsdMicros),
      reservedCredits: usdMicrosToLegacyCredits(reservedUsdMicros),
      updatedAt: input.updatedAt,
    };
    const normalized = normalizeCreditBalance(next);
    this.#creditBalances.set(spaceId, normalized);
    return Promise.resolve(normalized);
  }

  addCredits(
    spaceId: string,
    input: CreditAmountInput & { readonly updatedAt: string },
  ): Promise<CreditBalance> {
    const existing = normalizeCreditBalance(this.#creditBalances.get(spaceId));
    const usdMicros = creditAmountUsdMicros(input);
    const availableUsdMicros =
      creditBalanceAvailableUsdMicros(existing) + usdMicros;
    const purchasedUsdMicros =
      creditBalancePurchasedUsdMicros(existing) + usdMicros;
    const reservedUsdMicros = creditBalanceReservedUsdMicros(existing);
    const monthlyIncludedUsdMicros =
      creditBalanceMonthlyIncludedUsdMicros(existing);
    const next: CreditBalance = {
      spaceId,
      availableUsdMicros,
      reservedUsdMicros,
      monthlyIncludedUsdMicros,
      purchasedUsdMicros,
      availableCredits: usdMicrosToLegacyCredits(availableUsdMicros),
      reservedCredits: usdMicrosToLegacyCredits(reservedUsdMicros),
      monthlyIncludedCredits: usdMicrosToLegacyCredits(
        monthlyIncludedUsdMicros,
      ),
      purchasedCredits: usdMicrosToLegacyCredits(purchasedUsdMicros),
      updatedAt: input.updatedAt,
    };
    const normalized = normalizeCreditBalance(next);
    this.#creditBalances.set(spaceId, normalized);
    return Promise.resolve(normalized);
  }

  reconcileMonthlyCredits(
    spaceId: string,
    input: {
      readonly newMonthly: number;
      readonly periodStartIso: string;
      readonly updatedAt: string;
    },
  ): Promise<CreditBalance | undefined> {
    const balance = normalizeCreditBalance(this.#creditBalances.get(spaceId));
    if (!balance) return Promise.resolve(undefined);
    const balanceUpdatedAtMs = Date.parse(balance.updatedAt);
    const periodStartMs = Date.parse(input.periodStartIso);
    const alreadyReconciled =
      creditBalanceMonthlyIncludedUsdMicros(balance) ===
        legacyCreditsToUsdMicros(input.newMonthly) &&
      Number.isFinite(balanceUpdatedAtMs) &&
      Number.isFinite(periodStartMs) &&
      balanceUpdatedAtMs >= periodStartMs;
    if (alreadyReconciled) return Promise.resolve(undefined);
    const monthlyIncludedUsdMicros = legacyCreditsToUsdMicros(input.newMonthly);
    const availableUsdMicros =
      Math.max(
        0,
        creditBalanceAvailableUsdMicros(balance) -
          creditBalanceMonthlyIncludedUsdMicros(balance),
      ) + monthlyIncludedUsdMicros;
    const next: CreditBalance = {
      ...balance,
      availableUsdMicros,
      monthlyIncludedUsdMicros,
      availableCredits: usdMicrosToLegacyCredits(availableUsdMicros),
      monthlyIncludedCredits: input.newMonthly,
      updatedAt: input.updatedAt,
    };
    const normalized = normalizeCreditBalance(next);
    this.#creditBalances.set(spaceId, normalized);
    return Promise.resolve(normalized);
  }

  putCreditReservation(
    reservation: CreditReservation,
  ): Promise<CreditReservation> {
    const normalized = normalizeCreditReservation(reservation);
    this.#creditReservations.set(reservation.id, normalized);
    return Promise.resolve(normalized);
  }

  getCreditReservationForRun(
    runId: string,
  ): Promise<CreditReservation | undefined> {
    const reservations = Array.from(this.#creditReservations.values())
      .filter((row) => row.runId === runId)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
    return Promise.resolve(
      reservations[0] ? normalizeCreditReservation(reservations[0]) : undefined,
    );
  }

  listCreditReservations(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly CreditReservation[]> {
    const limit = options.limit ?? 100;
    const reservations = Array.from(this.#creditReservations.values())
      .filter((row) => row.spaceId === spaceId)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      )
      .slice(0, limit);
    return Promise.resolve(reservations.map(normalizeCreditReservation));
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

  listUsageEvents(spaceId: string): Promise<readonly UsageEvent[]> {
    return Promise.resolve(
      Array.from(this.#usageEvents.values())
        .filter((row) => row.spaceId === spaceId)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    );
  }

  async listUsageEventsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<UsageEvent>> {
    return pageSorted(await this.listUsageEvents(spaceId), params);
  }

  putBackupRecord(record: BackupRecord): Promise<BackupRecord> {
    this.#backupRecords.set(record.id, record);
    return Promise.resolve(record);
  }

  getBackupRecord(id: string): Promise<BackupRecord | undefined> {
    return Promise.resolve(this.#backupRecords.get(id));
  }

  listBackupRecords(spaceId: string): Promise<readonly BackupRecord[]> {
    return Promise.resolve(
      Array.from(this.#backupRecords.values())
        .filter((row) => row.spaceId === spaceId)
        // Newest first: createdAt desc, then id desc as a stable tie-break.
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        ),
    );
  }

  async listBackupRecordsPage(
    spaceId: string,
    params: PageParams,
  ): Promise<Page<BackupRecord>> {
    // Newest-first listing ⇒ descending keyset pager.
    return pageSortedDesc(await this.listBackupRecords(spaceId), params);
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

/** Newest-first sort across internal numeric timestamps and ISO public rows. */
export function compareStoredRunRecordsDesc(
  a: StoredRunRecord,
  b: StoredRunRecord,
): number {
  return (
    runRecordTimestamp(b) - runRecordTimestamp(a) || b.id.localeCompare(a.id)
  );
}

function runRecordTimestamp(row: StoredRunRecord): number {
  const value = row.createdAt;
  if (typeof value === "number") return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function creditAmountUsdMicros(input: CreditAmountInput): number {
  if (input.usdMicros !== undefined) {
    if (
      !Number.isSafeInteger(input.usdMicros) ||
      !Number.isFinite(input.usdMicros) ||
      input.usdMicros <= 0
    ) {
      throw new TypeError("usdMicros must be a positive integer");
    }
    return input.usdMicros;
  }
  if (
    input.credits === undefined ||
    !Number.isFinite(input.credits) ||
    input.credits <= 0
  ) {
    throw new TypeError("usdMicros must be a positive integer");
  }
  return legacyCreditsToUsdMicros(input.credits);
}

function normalizeBillingPlan(plan: BillingPlan): BillingPlan {
  const includedUsdMicros = billingPlanIncludedUsdMicros(plan);
  return {
    ...plan,
    includedUsdMicros,
    includedCredits: usdMicrosToLegacyCredits(includedUsdMicros),
  };
}

function normalizeCreditBalance(balance: CreditBalance): CreditBalance;
function normalizeCreditBalance(
  balance: CreditBalance | undefined,
): CreditBalance | undefined;
function normalizeCreditBalance(
  balance: CreditBalance | undefined,
): CreditBalance | undefined {
  if (!balance) return undefined;
  const availableUsdMicros = creditBalanceAvailableUsdMicros(balance);
  const reservedUsdMicros = creditBalanceReservedUsdMicros(balance);
  const monthlyIncludedUsdMicros =
    creditBalanceMonthlyIncludedUsdMicros(balance);
  const purchasedUsdMicros = creditBalancePurchasedUsdMicros(balance);
  return {
    ...balance,
    availableUsdMicros,
    reservedUsdMicros,
    monthlyIncludedUsdMicros,
    purchasedUsdMicros,
    availableCredits: usdMicrosToLegacyCredits(availableUsdMicros),
    reservedCredits: usdMicrosToLegacyCredits(reservedUsdMicros),
    monthlyIncludedCredits: usdMicrosToLegacyCredits(monthlyIncludedUsdMicros),
    purchasedCredits: usdMicrosToLegacyCredits(purchasedUsdMicros),
  };
}

function normalizeUsageEvent(event: UsageEvent): UsageEvent {
  const usdMicros = usageEventUsdMicros(event);
  return {
    ...event,
    usdMicros,
    credits: usdMicrosToLegacyCredits(usdMicros),
  };
}

function normalizeCreditReservation(
  reservation: CreditReservation,
): CreditReservation {
  const estimatedUsdMicros =
    reservation.estimatedUsdMicros ??
    legacyCreditsToUsdMicros(reservation.estimatedCredits);
  return {
    ...reservation,
    estimatedUsdMicros,
    estimatedCredits: usdMicrosToLegacyCredits(estimatedUsdMicros),
  };
}

function maybeWarnInMemoryStore(storeName: string): void {
  if (!shouldWarnInMemoryStore()) return;
  log.warn("service.deploy_control.in_memory_store", {
    store: storeName,
    detail:
      "OpenTofu run, Installation, and Deployment records will NOT persist " +
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

function assertProviderEnvGlobalBoundary(env: ProviderEnv): void {
  if (env.spaceId === undefined) {
    throw new Error(
      "global provider resolver records are not supported in OSS Takosumi",
    );
  }
}
