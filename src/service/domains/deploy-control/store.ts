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
  Installation,
  PlanRun,
  RunnerProfile,
} from "takosumi-contract/deploy-control-api";
import { currentRuntime } from "../../shared/runtime/index.ts";

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
}

export class InMemoryOpenTofuDeploymentStore
  implements OpenTofuDeploymentStore {
  readonly #runnerProfiles = new Map<string, RunnerProfile>();
  readonly #planRuns = new Map<string, PlanRun>();
  readonly #applyRuns = new Map<string, ApplyRun>();
  readonly #installations = new Map<string, Installation>();
  readonly #deployments = new Map<string, Deployment>();
  readonly #connections = new Map<string, Connection>();
  readonly #secretBlobs = new Map<string, StoredSecretBlob>();

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
