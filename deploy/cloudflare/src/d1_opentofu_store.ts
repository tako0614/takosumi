import type {
  ApplyRun,
  Connection,
  Deployment,
  Installation,
  PlanRun,
  RunnerProfile,
} from "../../../src/contract/deploy-control-api.ts";
import type {
  SourceSnapshot,
  SourceSyncRun,
} from "../../../src/contract/sources.ts";
import type {
  App,
  DeploymentProfile,
  Environment,
  InstallProfile,
} from "../../../src/contract/lanes.ts";
import type {
  InstallationPatchGuard,
  OpenTofuDeploymentStore,
  PlanRunInputs,
  StoredSecretBlob,
  StoredSource,
} from "../../../src/service/domains/deploy-control/store.ts";
import { InstallationPatchGuardConflict } from "../../../src/service/domains/deploy-control/store.ts";
import type { D1Database } from "./bindings.ts";

const TABLE = "takosumi_cf_opentofu_ledger";

type Namespace =
  | "runner-profile"
  | "plan-run"
  | "plan-run-inputs"
  | "apply-run"
  | "installation"
  | "deployment"
  | "connection"
  | "secret-blob"
  | "source"
  | "source-snapshot"
  | "source-sync-run"
  | "app"
  | "environment"
  | "install-profile"
  | "deployment-profile";

export class CloudflareD1OpenTofuDeploymentStore
  implements OpenTofuDeploymentStore {
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {}

  async putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    await this.#put("runner-profile", profile.id, profile, {
      createdAt: profile.createdAt,
      updatedAt: profile.createdAt,
    });
    return profile;
  }

  async getRunnerProfile(id: string): Promise<RunnerProfile | undefined> {
    return await this.#get("runner-profile", id);
  }

  async listRunnerProfiles(): Promise<readonly RunnerProfile[]> {
    return await this.#list<RunnerProfile>("runner-profile");
  }

  async putPlanRun(run: PlanRun): Promise<PlanRun> {
    await this.#put("plan-run", run.id, run, {
      spaceId: run.spaceId,
      installationId: run.installationId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    return await this.#get("plan-run", id);
  }

  async putPlanRunInputs(inputs: PlanRunInputs): Promise<void> {
    // Internal sidecar: never list-indexed, so omit space_id/status columns.
    await this.#put("plan-run-inputs", inputs.planRunId, inputs, {
      createdAt: 0,
      updatedAt: 0,
    });
  }

  async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    return await this.#get("plan-run-inputs", planRunId);
  }

  async deletePlanRunInputs(planRunId: string): Promise<void> {
    await this.#delete("plan-run-inputs", planRunId);
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#put("apply-run", run.id, run, {
      spaceId: run.spaceId,
      installationId: run.installationId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    return await this.#get("apply-run", id);
  }

  async putInstallation(installation: Installation): Promise<Installation> {
    await this.#put("installation", installation.id, installation, {
      spaceId: installation.spaceId,
      installationId: installation.id,
      status: installation.status,
      createdAt: installation.createdAt,
      updatedAt: installation.updatedAt,
    });
    return installation;
  }

  async getInstallation(id: string): Promise<Installation | undefined> {
    return await this.#get("installation", id);
  }

  async listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    return await this.#list<Installation>("installation", { spaceId });
  }

  async patchInstallation(
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
    const existing = await this.getInstallation(id);
    if (!existing) return undefined;
    if (
      guard !== undefined &&
      (existing.currentDeploymentId !== guard.currentDeploymentId ||
        (guard.status !== undefined && existing.status !== guard.status))
    ) {
      throw new InstallationPatchGuardConflict({
        id,
        expectedCurrentDeploymentId: guard.currentDeploymentId,
        actualCurrentDeploymentId: existing.currentDeploymentId,
        expectedStatus: guard.status,
        actualStatus: existing.status,
      });
    }
    const updated: Installation = { ...existing, ...patch };
    if (!guard) return await this.putInstallation(updated);
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `update ${TABLE} set
        space_id = ?,
        installation_id = ?,
        status = ?,
        record_json = ?,
        created_at = ?,
        updated_at = ?
       where namespace = ?
         and key = ?
         and json_extract(record_json, '$.currentDeploymentId') is ?
         and (? is null or status = ?)`,
    ).bind(
      updated.spaceId,
      updated.id,
      updated.status,
      JSON.stringify(updated),
      updated.createdAt,
      updated.updatedAt,
      "installation",
      id,
      guard.currentDeploymentId,
      guard.status ?? null,
      guard.status ?? null,
    ).run();
    if ((result.meta?.changes ?? 0) > 0) return updated;
    const actual = await this.getInstallation(id);
    if (!actual) return undefined;
    throw new InstallationPatchGuardConflict({
      id,
      expectedCurrentDeploymentId: guard.currentDeploymentId,
      actualCurrentDeploymentId: actual.currentDeploymentId,
      expectedStatus: guard.status,
      actualStatus: actual.status,
    });
  }

  async putDeployment(deployment: Deployment): Promise<Deployment> {
    await this.#put("deployment", deployment.id, deployment, {
      spaceId: undefined,
      installationId: deployment.installationId,
      status: deployment.status,
      createdAt: deployment.createdAt,
      updatedAt: deployment.completedAt ?? deployment.createdAt,
    });
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    return await this.#get("deployment", id);
  }

  async listDeployments(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    return await this.#list<Deployment>("deployment", { installationId });
  }

  async putConnection(connection: Connection): Promise<Connection> {
    await this.#put("connection", connection.id, connection, {
      spaceId: connection.spaceId,
      status: connection.status,
      createdAt: epochMillis(connection.createdAt),
      updatedAt: epochMillis(connection.updatedAt),
    });
    return connection;
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    return await this.#get("connection", id);
  }

  async listConnections(spaceId: string): Promise<readonly Connection[]> {
    return await this.#list<Connection>("connection", { spaceId });
  }

  async deleteConnection(id: string): Promise<boolean> {
    return await this.#delete("connection", id);
  }

  async putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob> {
    // The secret blob carries ciphertext only; the metadata columns intentionally
    // omit space_id/status so the ciphertext blob is never list-indexable.
    await this.#put("secret-blob", blob.connectionId, blob, {
      createdAt: 0,
      updatedAt: 0,
    });
    return blob;
  }

  async getSecretBlob(
    connectionId: string,
  ): Promise<StoredSecretBlob | undefined> {
    return await this.#get("secret-blob", connectionId);
  }

  async deleteSecretBlob(connectionId: string): Promise<boolean> {
    return await this.#delete("secret-blob", connectionId);
  }

  async putSource(source: StoredSource): Promise<StoredSource> {
    await this.#put("source", source.id, source, {
      spaceId: source.spaceId,
      status: source.status,
      createdAt: epochMillis(source.createdAt),
      updatedAt: epochMillis(source.updatedAt),
    });
    return source;
  }

  async getSource(id: string): Promise<StoredSource | undefined> {
    return await this.#get("source", id);
  }

  async listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    return await this.#list<StoredSource>("source", { spaceId });
  }

  async deleteSource(id: string): Promise<boolean> {
    return await this.#delete("source", id);
  }

  async putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    // The snapshot is indexed by sourceId via the installation_id column so the
    // shared #list helper can scan snapshots for a source.
    await this.#put("source-snapshot", snapshot.id, snapshot, {
      installationId: snapshot.sourceId,
      createdAt: epochMillis(snapshot.fetchedAt),
      updatedAt: epochMillis(snapshot.fetchedAt),
    });
    return snapshot;
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined> {
    return await this.#get("source-snapshot", id);
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<readonly SourceSnapshot[]> {
    return await this.#list<SourceSnapshot>("source-snapshot", {
      installationId: sourceId,
    });
  }

  async putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    await this.#put("source-sync-run", run.id, run, {
      spaceId: run.spaceId,
      installationId: run.sourceId,
      status: run.status,
      createdAt: epochMillis(run.createdAt),
      updatedAt: epochMillis(run.updatedAt),
    });
    return run;
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    return await this.#get("source-sync-run", id);
  }

  async listSourceSyncRuns(
    sourceId: string,
  ): Promise<readonly SourceSyncRun[]> {
    return await this.#list<SourceSyncRun>("source-sync-run", {
      installationId: sourceId,
    });
  }

  async putApp(app: App): Promise<App> {
    await this.#put("app", app.id, app, {
      spaceId: app.spaceId,
      createdAt: epochMillis(app.createdAt),
      updatedAt: epochMillis(app.updatedAt),
    });
    return app;
  }

  async getApp(id: string): Promise<App | undefined> {
    return await this.#get("app", id);
  }

  async listApps(spaceId?: string): Promise<readonly App[]> {
    return await this.#list<App>("app", { spaceId });
  }

  async deleteApp(id: string): Promise<boolean> {
    return await this.#delete("app", id);
  }

  async putEnvironment(environment: Environment): Promise<Environment> {
    // Indexed by appId via the installation_id column so #list can scan an
    // App's environments.
    await this.#put("environment", environment.id, environment, {
      installationId: environment.appId,
      createdAt: epochMillis(environment.createdAt),
      updatedAt: epochMillis(environment.updatedAt),
    });
    return environment;
  }

  async getEnvironment(id: string): Promise<Environment | undefined> {
    return await this.#get("environment", id);
  }

  async listEnvironments(appId: string): Promise<readonly Environment[]> {
    return await this.#list<Environment>("environment", {
      installationId: appId,
    });
  }

  async deleteEnvironment(id: string): Promise<boolean> {
    return await this.#delete("environment", id);
  }

  async putInstallProfile(profile: InstallProfile): Promise<InstallProfile> {
    await this.#put("install-profile", profile.id, profile, {
      status: profile.trustLevel,
      createdAt: epochMillis(profile.createdAt),
      updatedAt: epochMillis(profile.updatedAt),
    });
    return profile;
  }

  async getInstallProfile(id: string): Promise<InstallProfile | undefined> {
    return await this.#get("install-profile", id);
  }

  async listInstallProfiles(): Promise<readonly InstallProfile[]> {
    return await this.#list<InstallProfile>("install-profile");
  }

  async putDeploymentProfile(
    profile: DeploymentProfile,
  ): Promise<DeploymentProfile> {
    // One profile per environment: drop any stale row that referenced the same
    // environment under a different id before upserting (the env id is indexed
    // via the installation_id column).
    const existing = await this.listDeploymentProfilesForEnvironment(
      profile.environmentId,
    );
    for (const stale of existing) {
      if (stale.id !== profile.id) await this.#delete("deployment-profile", stale.id);
    }
    await this.#put("deployment-profile", profile.id, profile, {
      installationId: profile.environmentId,
      createdAt: epochMillis(profile.createdAt),
      updatedAt: epochMillis(profile.updatedAt),
    });
    return profile;
  }

  async getDeploymentProfileByEnvironment(
    environmentId: string,
  ): Promise<DeploymentProfile | undefined> {
    const rows = await this.listDeploymentProfilesForEnvironment(environmentId);
    return rows[rows.length - 1];
  }

  async listDeploymentProfilesForEnvironment(
    environmentId: string,
  ): Promise<readonly DeploymentProfile[]> {
    return await this.#list<DeploymentProfile>("deployment-profile", {
      installationId: environmentId,
    });
  }

  async #delete(namespace: Namespace, key: string): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `delete from ${TABLE} where namespace = ? and key = ?`,
    ).bind(namespace, key).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async #put(
    namespace: Namespace,
    key: string,
    record: unknown,
    metadata: {
      readonly spaceId?: string;
      readonly installationId?: string;
      readonly status?: string;
      readonly createdAt: number;
      readonly updatedAt: number;
    },
  ): Promise<void> {
    await this.#ensureSchema();
    await this.db.prepare(
      `insert into ${TABLE}
        (namespace, key, space_id, installation_id, status, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (namespace, key) do update set
        space_id = excluded.space_id,
        installation_id = excluded.installation_id,
        status = excluded.status,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
    ).bind(
      namespace,
      key,
      metadata.spaceId ?? null,
      metadata.installationId ?? null,
      metadata.status ?? null,
      JSON.stringify(record),
      metadata.createdAt,
      metadata.updatedAt,
    ).run();
  }

  async #get<T>(namespace: Namespace, key: string): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.db.prepare(
      `select record_json from ${TABLE} where namespace = ? and key = ?`,
    ).bind(namespace, key).first<{ record_json: string }>();
    return row ? JSON.parse(row.record_json) as T : undefined;
  }

  async #list<T>(
    namespace: Namespace,
    filter: {
      readonly spaceId?: string;
      readonly installationId?: string;
    } = {},
  ): Promise<readonly T[]> {
    await this.#ensureSchema();
    if (filter.spaceId !== undefined) {
      const result = await this.db.prepare(
        `select record_json from ${TABLE}
         where namespace = ? and space_id = ?
         order by created_at asc, key asc`,
      ).bind(namespace, filter.spaceId).all<{ record_json: string }>();
      return (result.results ?? []).map((row) =>
        JSON.parse(row.record_json) as T
      );
    }
    if (filter.installationId !== undefined) {
      const result = await this.db.prepare(
        `select record_json from ${TABLE}
         where namespace = ? and installation_id = ?
         order by created_at asc, key asc`,
      ).bind(namespace, filter.installationId).all<{ record_json: string }>();
      return (result.results ?? []).map((row) =>
        JSON.parse(row.record_json) as T
      );
    }
    const result = await this.db.prepare(
      `select record_json from ${TABLE}
       where namespace = ?
       order by created_at asc, key asc`,
    ).bind(namespace).all<{ record_json: string }>();
    return (result.results ?? []).map((row) => JSON.parse(row.record_json) as T);
  }

  async #ensureSchema(): Promise<void> {
    this.#initialized ??= ensureD1OpenTofuLedgerSchema(this.db);
    await this.#initialized;
  }
}

export function createCloudflareD1OpenTofuDeploymentStore(
  db: D1Database,
): OpenTofuDeploymentStore {
  return new CloudflareD1OpenTofuDeploymentStore(db);
}

function epochMillis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function ensureD1OpenTofuLedgerSchema(
  db: D1Database,
): Promise<void> {
  await db.prepare(
    `create table if not exists ${TABLE} (
      namespace text not null,
      key text not null,
      space_id text,
      installation_id text,
      status text,
      record_json text not null,
      created_at integer not null,
      updated_at integer not null,
      primary key (namespace, key)
    )`,
  ).run();
  await db.prepare(
    `create index if not exists ${TABLE}_space_idx
      on ${TABLE} (namespace, space_id, created_at)`,
  ).run();
  await db.prepare(
    `create index if not exists ${TABLE}_installation_idx
      on ${TABLE} (namespace, installation_id, created_at)`,
  ).run();
  await db.prepare(
    `create index if not exists ${TABLE}_status_idx
      on ${TABLE} (namespace, status, updated_at)`,
  ).run();
}
