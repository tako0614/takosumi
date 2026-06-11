/**
 * Persistence boundary for the control-plane ledger (core-spec.md §27).
 *
 * The logical schema is the Space-direct OpenTofu Capsule DAG model: spaces,
 * sources(+snapshots), connections(+secret blobs), install_configs,
 * installations (UNIQUE(space_id, name, environment)), deployment_profiles,
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
  InstallConfig,
  Installation,
  PlanRun,
  RunnerProfile,
  StateSnapshot,
} from "@takosumi/internal/deploy-control-api";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { Space } from "takosumi-contract/spaces";
import type { OperatorConnectionDefault } from "takosumi-contract/provider-bindings";
import type {
  DeploymentProfile,
  OutputAllowlistEntry,
} from "takosumi-contract/installations";
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
import type {
  OutputShare,
  OutputSnapshot,
} from "takosumi-contract/output-snapshots";
import type { ArtifactRecord, Run, RunGroup } from "takosumi-contract/runs";
import type { BackupRecord } from "takosumi-contract/backups";
import type {
  BillingAccount,
  BillingPlan,
  CreditBalance,
  CreditReservation,
  SpaceSubscription,
  UsageEvent,
} from "takosumi-contract/billing";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "takosumi-contract/security";
import type { ProviderTemplate } from "takosumi-contract/providers";
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
  /**
   * At-rest seal of the SENSITIVE-bearing sidecar payload (spec §11 / §18). A
   * sensitive `published_output` value injected into a plan flows into
   * `variables` AND is baked as a literal into the generic Capsule's generated
   * `main.tf`; either would persist as a cleartext ledger value here. When a
   * sensitive value was injected, the controller seals `{ variables,
   * generatedRoot, outputAllowlist, build }` into this blob with the SAME
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

  // SourceSyncRun ledger records (rows of `runs` with kind source_sync).
  putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun>;
  getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined>;
  listSourceSyncRuns(sourceId: string): Promise<readonly SourceSyncRun[]>;
  putCompatibilityCheckRun(run: Run): Promise<Run>;
  getCompatibilityCheckRun(id: string): Promise<Run | undefined>;
  putBackupRun(run: Run): Promise<Run>;
  getBackupRun(id: string): Promise<Run | undefined>;

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
  patchInstallation(
    id: string,
    patch: InstallationPatch,
    guard?: InstallationPatchGuard,
  ): Promise<Installation | undefined>;

  putDeployment(deployment: Deployment): Promise<Deployment>;
  getDeployment(id: string): Promise<Deployment | undefined>;
  listDeployments(installationId: string): Promise<readonly Deployment[]>;

  // Connection records (public fields) + their sealed secret blobs. The blob is
  // stored in a separate namespace so the public Connection can be listed
  // without ever touching ciphertext.
  putConnection(connection: Connection): Promise<Connection>;
  getConnection(id: string): Promise<Connection | undefined>;
  listConnections(spaceId: string): Promise<readonly Connection[]>;
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

  // Operator default connections (spec §9 / §27 operator_connection_defaults).
  putOperatorConnectionDefault(
    record: OperatorConnectionDefault,
  ): Promise<OperatorConnectionDefault>;
  getOperatorConnectionDefault(
    provider: string,
  ): Promise<OperatorConnectionDefault | undefined>;
  listOperatorConnectionDefaults(): Promise<
    readonly OperatorConnectionDefault[]
  >;

  putProviderTemplate(entry: ProviderTemplate): Promise<ProviderTemplate>;
  getProviderTemplate(id: string): Promise<ProviderTemplate | undefined>;
  listProviderTemplates(): Promise<readonly ProviderTemplate[]>;

  // Source records (public fields + internal hook-secret hash / lastSeenCommit /
  // autoSync). The hook secret plaintext is NEVER stored.
  putSource(source: StoredSource): Promise<StoredSource>;
  getSource(id: string): Promise<StoredSource | undefined>;
  listSources(spaceId?: string): Promise<readonly StoredSource[]>;
  deleteSource(id: string): Promise<boolean>;

  // SourceSnapshot records (immutable archive snapshots).
  putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot>;
  getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined>;
  listSourceSnapshots(sourceId: string): Promise<readonly SourceSnapshot[]>;

  // CapsuleCompatibilityReport records (spec §12 / §27).
  putCapsuleCompatibilityReport(
    report: CapsuleCompatibilityReport,
  ): Promise<CapsuleCompatibilityReport>;
  getCapsuleCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReport | undefined>;

  // Internal Installation provider-binding records. DeploymentProfile is a
  // compatibility store type, not a public Takosumi concept; one row per
  // (installation, environment), with that pair as the upsert key.
  putDeploymentProfile(profile: DeploymentProfile): Promise<DeploymentProfile>;
  getDeploymentProfileByInstallation(
    installationId: string,
    environment: string,
  ): Promise<DeploymentProfile | undefined>;

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

  // Billing credit ledger (§28). Plan creates reservations in showback/enforce;
  // apply confirms/captures them before provider credential mint.
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
    input: { readonly credits: number; readonly updatedAt: string },
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

  // Control-backup ledger pointers (spec §33 layer 1 / §26 R2_BACKUPS). One row
  // per sealed control-backup bundle written to R2_BACKUPS. The bundle bytes
  // live in object storage; only the pointer (objectKey / digest / sizeBytes)
  // enters the ledger. Listing orders newest first (createdAt desc, id desc).
  putBackupRecord(record: BackupRecord): Promise<BackupRecord>;
  listBackupRecords(spaceId: string): Promise<readonly BackupRecord[]>;
}

export class InMemoryOpenTofuDeploymentStore implements OpenTofuDeploymentStore {
  readonly #runnerProfiles = new Map<string, RunnerProfile>();
  readonly #planRuns = new Map<string, PlanRun>();
  readonly #planRunInputs = new Map<string, PlanRunInputs>();
  readonly #applyRuns = new Map<string, ApplyRun>();
  readonly #sourceSyncRuns = new Map<string, SourceSyncRun>();
  readonly #backupRuns = new Map<string, Run>();
  readonly #spaces = new Map<string, Space>();
  readonly #installConfigs = new Map<string, InstallConfig>();
  readonly #installations = new Map<string, Installation>();
  readonly #deployments = new Map<string, Deployment>();
  readonly #connections = new Map<string, Connection>();
  readonly #secretBlobs = new Map<string, StoredSecretBlob>();
  readonly #operatorDefaults = new Map<string, OperatorConnectionDefault>();
  readonly #providerTemplates = new Map<string, ProviderTemplate>();
  readonly #sources = new Map<string, StoredSource>();
  readonly #sourceSnapshots = new Map<string, SourceSnapshot>();
  readonly #capsuleCompatibilityReports = new Map<
    string,
    CapsuleCompatibilityReport
  >();
  readonly #deploymentProfiles = new Map<string, DeploymentProfile>();
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
    return Promise.resolve(this.#planRuns.get(id));
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
    return Promise.resolve(this.#applyRuns.get(id));
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
    if (run.type !== "backup") {
      return Promise.reject(new Error("putBackupRun only accepts backup runs"));
    }
    this.#backupRuns.set(run.id, run);
    return Promise.resolve(run);
  }

  getBackupRun(id: string): Promise<Run | undefined> {
    return Promise.resolve(this.#backupRuns.get(id));
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

  putOperatorConnectionDefault(
    record: OperatorConnectionDefault,
  ): Promise<OperatorConnectionDefault> {
    // One default per provider: the provider source is the natural upsert key.
    for (const [key, existing] of this.#operatorDefaults) {
      if (existing.provider === record.provider && key !== record.id) {
        this.#operatorDefaults.delete(key);
      }
    }
    this.#operatorDefaults.set(record.id, record);
    return Promise.resolve(record);
  }

  getOperatorConnectionDefault(
    provider: string,
  ): Promise<OperatorConnectionDefault | undefined> {
    return Promise.resolve(
      Array.from(this.#operatorDefaults.values()).find(
        (row) => row.provider === provider,
      ),
    );
  }

  listOperatorConnectionDefaults(): Promise<
    readonly OperatorConnectionDefault[]
  > {
    return Promise.resolve(
      Array.from(this.#operatorDefaults.values()).sort((a, b) =>
        a.provider.localeCompare(b.provider),
      ),
    );
  }

  putProviderTemplate(entry: ProviderTemplate): Promise<ProviderTemplate> {
    this.#providerTemplates.set(entry.id, entry);
    return Promise.resolve(entry);
  }

  getProviderTemplate(
    id: string,
  ): Promise<ProviderTemplate | undefined> {
    return Promise.resolve(this.#providerTemplates.get(id));
  }

  listProviderTemplates(): Promise<readonly ProviderTemplate[]> {
    return Promise.resolve(
      Array.from(this.#providerTemplates.values()).sort(
        (a, b) =>
          a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
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

  putDeploymentProfile(profile: DeploymentProfile): Promise<DeploymentProfile> {
    // One profile per (installation, environment): drop a stale row under a
    // different id for the same pair.
    for (const [key, existing] of this.#deploymentProfiles) {
      if (
        existing.installationId === profile.installationId &&
        existing.environment === profile.environment &&
        key !== profile.id
      ) {
        this.#deploymentProfiles.delete(key);
      }
    }
    this.#deploymentProfiles.set(profile.id, profile);
    return Promise.resolve(profile);
  }

  getDeploymentProfileByInstallation(
    installationId: string,
    environment: string,
  ): Promise<DeploymentProfile | undefined> {
    return Promise.resolve(
      Array.from(this.#deploymentProfiles.values()).find(
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

  listOutputSnapshots(installationId: string): Promise<readonly OutputSnapshot[]> {
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
    this.#creditBalances.set(balance.spaceId, balance);
    return Promise.resolve(balance);
  }

  putBillingPlan(plan: BillingPlan): Promise<BillingPlan> {
    this.#billingPlans.set(plan.id, plan);
    return Promise.resolve(plan);
  }

  getBillingPlan(id: string): Promise<BillingPlan | undefined> {
    return Promise.resolve(this.#billingPlans.get(id));
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
    return Promise.resolve(this.#creditBalances.get(spaceId));
  }

  reserveCredits(
    spaceId: string,
    input: { readonly credits: number; readonly updatedAt: string },
  ): Promise<CreditBalance | undefined> {
    const balance = this.#creditBalances.get(spaceId);
    if (!balance || balance.availableCredits < input.credits) {
      return Promise.resolve(undefined);
    }
    const next = {
      ...balance,
      availableCredits: balance.availableCredits - input.credits,
      reservedCredits: balance.reservedCredits + input.credits,
      updatedAt: input.updatedAt,
    };
    this.#creditBalances.set(spaceId, next);
    return Promise.resolve(next);
  }

  putCreditReservation(
    reservation: CreditReservation,
  ): Promise<CreditReservation> {
    this.#creditReservations.set(reservation.id, reservation);
    return Promise.resolve(reservation);
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
    return Promise.resolve(reservations[0]);
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
    return Promise.resolve(reservations);
  }

  putUsageEvent(event: UsageEvent): Promise<UsageEvent> {
    const existing = Array.from(this.#usageEvents.values()).find(
      (row) => row.idempotencyKey === event.idempotencyKey,
    );
    if (existing) return Promise.resolve(existing);
    this.#usageEvents.set(event.id, event);
    return Promise.resolve(event);
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

  putBackupRecord(record: BackupRecord): Promise<BackupRecord> {
    this.#backupRecords.set(record.id, record);
    return Promise.resolve(record);
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
