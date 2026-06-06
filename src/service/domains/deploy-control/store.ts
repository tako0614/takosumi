/**
 * Persistence boundary for the OpenTofu deployment-control-plane ledger.
 *
 * The in-memory implementation is for dev/test only. Production/staging hosts
 * should inject the SQL store (or another durable store) so PlanRun and
 * ApplyRun records, Installation records, Deployment records, and runner profiles survive
 * restarts and Worker isolate recycling.
 */
import type {
  ApplyRun,
  Connection,
  Deployment,
  DispatchBuildSpec,
  DispatchGeneratedRoot,
  DispatchTemplateRef,
  Installation,
  PlanRun,
  RunnerProfile,
} from "takosumi-contract/deploy-control-api";
import type {
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type {
  App,
  DeploymentProfile,
  Environment,
  InstallProfile,
} from "takosumi-contract/lanes";
import type { JsonValue } from "takosumi-contract";
import { currentRuntime } from "../../shared/runtime/index.ts";

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
   * Template dispatch data (Phase 1C). Present for template-backed PlanRuns: the
   * resolved template reference (baked-in module path), the Takosumi-generated
   * root module, and the optional build phase. The queue consumer re-reads this
   * sidecar and threads it onto the runner dispatch payload (`request.template` /
   * `request.generatedRoot` / `request.build`). Never projected into the public
   * ledger.
   */
  readonly template?: DispatchTemplateRef;
  readonly generatedRoot?: DispatchGeneratedRoot;
  readonly build?: DispatchBuildSpec;
}

/**
 * Sealed credential blob persisted alongside (but separate from) the public
 * Connection record. The plaintext is the JSON of `{ [envName]: value }`
 * encrypted as ONE blob via the secret-boundary crypto. The store only ever
 * sees ciphertext; it never decrypts.
 */
export interface StoredSecretBlob {
  readonly connectionId: string;
  /** Base64 of the sealed bytes (the crypto prepends the IV to the ciphertext). */
  readonly ciphertext: string;
  /** Base64 of the IV (also embedded in `ciphertext`); kept for blob clarity. */
  readonly iv: string;
  /** Secret-boundary crypto key/version label (the cloud partition + scheme). */
  readonly keyVersion: string;
  /** Additional-authenticated-data fields bound into the seal (cloud family). */
  readonly aad: {
    readonly cloudPartition: string;
    readonly spaceId: string;
    readonly provider: string;
  };
}

/**
 * Persisted Source record. Extends the public {@link Source} with internal fields
 * that are NEVER projected into the public API:
 *   - `hookSecretHash` — SHA-256 of the per-source webhook bearer (the plaintext
 *     is returned exactly once at creation and never stored).
 *   - `lastSeenCommit` — last commit the scheduler/webhook observed via a
 *     `source_sync`; used to skip re-syncing when the ref has not moved.
 *   - `autoSync` — whether the scheduler should poll this source (M1: default
 *     false; flips true when an Environment with autoSync references it in M2+).
 */
export interface StoredSource extends Source {
  readonly hookSecretHash: string;
  readonly lastSeenCommit?: string;
  readonly autoSync: boolean;
}

export interface InstallationPatchGuard {
  readonly currentDeploymentId: string | null;
  readonly status?: Installation["status"];
}

export class InstallationPatchGuardConflict extends Error {
  readonly expectedCurrentDeploymentId: string | null;
  readonly actualCurrentDeploymentId: string | null;
  readonly expectedStatus?: Installation["status"];
  readonly actualStatus?: Installation["status"];

  constructor(input: {
    readonly id: string;
    readonly expectedCurrentDeploymentId: string | null;
    readonly actualCurrentDeploymentId: string | null;
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

export interface OpenTofuDeploymentStore {
  putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile>;
  getRunnerProfile(id: string): Promise<RunnerProfile | undefined>;
  listRunnerProfiles(): Promise<readonly RunnerProfile[]>;

  putPlanRun(run: PlanRun): Promise<PlanRun>;
  getPlanRun(id: string): Promise<PlanRun | undefined>;

  // Internal (non-public) plan inputs for the queue consumer. Never projected.
  putPlanRunInputs(inputs: PlanRunInputs): Promise<void>;
  getPlanRunInputs(planRunId: string): Promise<PlanRunInputs | undefined>;
  deletePlanRunInputs(planRunId: string): Promise<void>;

  putApplyRun(run: ApplyRun): Promise<ApplyRun>;
  getApplyRun(id: string): Promise<ApplyRun | undefined>;

  putInstallation(installation: Installation): Promise<Installation>;
  getInstallation(id: string): Promise<Installation | undefined>;
  listInstallations(spaceId?: string): Promise<readonly Installation[]>;
  patchInstallation(
    id: string,
    patch: Partial<
      Pick<
        Installation,
        | "currentDeploymentId"
        | "status"
        | "updatedAt"
        | "runnerProfileId"
        | "source"
        | "stateGeneration"
      >
    >,
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
  deleteConnection(id: string): Promise<boolean>;

  putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob>;
  getSecretBlob(connectionId: string): Promise<StoredSecretBlob | undefined>;
  deleteSecretBlob(connectionId: string): Promise<boolean>;

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

  // SourceSyncRun ledger records.
  putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun>;
  getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined>;
  listSourceSyncRuns(sourceId: string): Promise<readonly SourceSyncRun[]>;

  // App records (spec §6.3). Space-scoped; bind a Source to one install type.
  putApp(app: App): Promise<App>;
  getApp(id: string): Promise<App | undefined>;
  listApps(spaceId?: string): Promise<readonly App[]>;
  deleteApp(id: string): Promise<boolean>;

  // Environment records (spec §6.4). One execution target per App lane.
  putEnvironment(environment: Environment): Promise<Environment>;
  getEnvironment(id: string): Promise<Environment | undefined>;
  listEnvironments(appId: string): Promise<readonly Environment[]>;
  deleteEnvironment(id: string): Promise<boolean>;

  // InstallProfile records (spec §6.6). Seeded from the official template
  // catalog at bootstrap with trustLevel "official".
  putInstallProfile(profile: InstallProfile): Promise<InstallProfile>;
  getInstallProfile(id: string): Promise<InstallProfile | undefined>;
  listInstallProfiles(): Promise<readonly InstallProfile[]>;

  // DeploymentProfile records (spec §6.7). One per Environment; the upsert key
  // is the environmentId.
  putDeploymentProfile(profile: DeploymentProfile): Promise<DeploymentProfile>;
  getDeploymentProfileByEnvironment(
    environmentId: string,
  ): Promise<DeploymentProfile | undefined>;
}

export class InMemoryOpenTofuDeploymentStore
  implements OpenTofuDeploymentStore {
  readonly #runnerProfiles = new Map<string, RunnerProfile>();
  readonly #planRuns = new Map<string, PlanRun>();
  readonly #planRunInputs = new Map<string, PlanRunInputs>();
  readonly #applyRuns = new Map<string, ApplyRun>();
  readonly #installations = new Map<string, Installation>();
  readonly #deployments = new Map<string, Deployment>();
  readonly #connections = new Map<string, Connection>();
  readonly #secretBlobs = new Map<string, StoredSecretBlob>();
  readonly #sources = new Map<string, StoredSource>();
  readonly #sourceSnapshots = new Map<string, SourceSnapshot>();
  readonly #sourceSyncRuns = new Map<string, SourceSyncRun>();
  readonly #apps = new Map<string, App>();
  readonly #environments = new Map<string, Environment>();
  readonly #installProfiles = new Map<string, InstallProfile>();
  readonly #deploymentProfiles = new Map<string, DeploymentProfile>();

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
        a.id.localeCompare(b.id)
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

  putInstallation(installation: Installation): Promise<Installation> {
    this.#installations.set(installation.id, installation);
    return Promise.resolve(installation);
  }

  getInstallation(id: string): Promise<Installation | undefined> {
    return Promise.resolve(this.#installations.get(id));
  }

  listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    const rows = Array.from(this.#installations.values());
    const filtered = spaceId === undefined
      ? rows
      : rows.filter((row) => row.spaceId === spaceId);
    return Promise.resolve(filtered.sort((a, b) => a.createdAt - b.createdAt));
  }

  patchInstallation(
    id: string,
    patch: Partial<
      Pick<
        Installation,
        | "currentDeploymentId"
        | "status"
        | "updatedAt"
        | "runnerProfileId"
        | "source"
        | "stateGeneration"
      >
    >,
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
        .sort((a, b) => a.createdAt - b.createdAt),
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
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
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

  listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    const rows = Array.from(this.#sources.values());
    const filtered = spaceId === undefined
      ? rows
      : rows.filter((row) => row.spaceId === spaceId);
    return Promise.resolve(
      filtered.sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
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
        .sort((a, b) =>
          a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id)
        ),
    );
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
        .sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
        ),
    );
  }

  putApp(app: App): Promise<App> {
    this.#apps.set(app.id, app);
    return Promise.resolve(app);
  }

  getApp(id: string): Promise<App | undefined> {
    return Promise.resolve(this.#apps.get(id));
  }

  listApps(spaceId?: string): Promise<readonly App[]> {
    const rows = Array.from(this.#apps.values());
    const filtered = spaceId === undefined
      ? rows
      : rows.filter((row) => row.spaceId === spaceId);
    return Promise.resolve(
      filtered.sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      ),
    );
  }

  deleteApp(id: string): Promise<boolean> {
    return Promise.resolve(this.#apps.delete(id));
  }

  putEnvironment(environment: Environment): Promise<Environment> {
    this.#environments.set(environment.id, environment);
    return Promise.resolve(environment);
  }

  getEnvironment(id: string): Promise<Environment | undefined> {
    return Promise.resolve(this.#environments.get(id));
  }

  listEnvironments(appId: string): Promise<readonly Environment[]> {
    return Promise.resolve(
      Array.from(this.#environments.values())
        .filter((row) => row.appId === appId)
        .sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
        ),
    );
  }

  deleteEnvironment(id: string): Promise<boolean> {
    return Promise.resolve(this.#environments.delete(id));
  }

  putInstallProfile(profile: InstallProfile): Promise<InstallProfile> {
    this.#installProfiles.set(profile.id, profile);
    return Promise.resolve(profile);
  }

  getInstallProfile(id: string): Promise<InstallProfile | undefined> {
    return Promise.resolve(this.#installProfiles.get(id));
  }

  listInstallProfiles(): Promise<readonly InstallProfile[]> {
    return Promise.resolve(
      Array.from(this.#installProfiles.values()).sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
    );
  }

  putDeploymentProfile(
    profile: DeploymentProfile,
  ): Promise<DeploymentProfile> {
    // The environmentId is the natural upsert key (one profile per env). Drop a
    // stale row that referenced the same environment under a different id.
    for (const [key, existing] of this.#deploymentProfiles) {
      if (existing.environmentId === profile.environmentId && key !== profile.id) {
        this.#deploymentProfiles.delete(key);
      }
    }
    this.#deploymentProfiles.set(profile.id, profile);
    return Promise.resolve(profile);
  }

  getDeploymentProfileByEnvironment(
    environmentId: string,
  ): Promise<DeploymentProfile | undefined> {
    return Promise.resolve(
      Array.from(this.#deploymentProfiles.values()).find(
        (row) => row.environmentId === environmentId,
      ),
    );
  }
}

function maybeWarnInMemoryStore(storeName: string): void {
  if (!shouldWarnInMemoryStore()) return;
  console.warn(
    `[takosumi-service] WARNING: ${storeName} is in-memory; OpenTofu run, ` +
      `Installation, and Deployment records will NOT persist across restart ` +
      `or isolate recycle. Inject a durable store for production/staging.`,
  );
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
