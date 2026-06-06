/**
 * SQL-backed OpenTofu deployment-control-plane ledger.
 *
 * The store keeps searchable columns for common list/read paths and persists
 * the contract object as JSON so the public run ledger can evolve without a
 * schema migration for every non-indexed field.
 */
import type {
  ApplyRun,
  Connection,
  Deployment,
  Installation,
  PlanRun,
  RunnerProfile,
  StateSnapshot,
} from "takosumi-contract/deploy-control-api";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import type {
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type {
  App,
  DeploymentProfile,
  Environment,
  InstallProfile,
} from "takosumi-contract/lanes";
import type {
  InstallationPatchGuard,
  OpenTofuDeploymentStore,
  PlanRunInputs,
  StoredSecretBlob,
  StoredSource,
} from "./store.ts";
import { InstallationPatchGuardConflict } from "./store.ts";

export class SqlOpenTofuDeploymentStore implements OpenTofuDeploymentStore {
  readonly #client: SqlClient;

  constructor(input: { readonly client: SqlClient }) {
    this.#client = input.client;
  }

  async putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    await this.#query(
      "insert into takosumi_runner_profiles " +
        "(id, profile_json, created_at) values ($1, $2::jsonb, $3) " +
        "on conflict (id) do update set " +
        "profile_json = excluded.profile_json, created_at = excluded.created_at",
      [profile.id, JSON.stringify(profile), profile.createdAt],
    );
    return profile;
  }

  async getRunnerProfile(id: string): Promise<RunnerProfile | undefined> {
    const result = await this.#query<JsonRow>(
      "select profile_json as json from takosumi_runner_profiles where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as RunnerProfile | undefined;
  }

  async listRunnerProfiles(): Promise<readonly RunnerProfile[]> {
    const result = await this.#query<JsonRow>(
      "select profile_json as json from takosumi_runner_profiles order by id asc",
    );
    return result.rows.map((row) => parseRow(row) as RunnerProfile);
  }

  async putPlanRun(run: PlanRun): Promise<PlanRun> {
    await this.#query(
      "insert into takosumi_plan_runs " +
        "(id, space_id, installation_id, runner_profile_id, status, run_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "installation_id = excluded.installation_id, " +
        "runner_profile_id = excluded.runner_profile_id, " +
        "status = excluded.status, " +
        "run_json = excluded.run_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        run.id,
        run.spaceId,
        run.installationId ?? null,
        run.runnerProfileId,
        run.status,
        JSON.stringify(run),
        run.createdAt,
        run.updatedAt,
      ],
    );
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    const result = await this.#query<JsonRow>(
      "select run_json as json from takosumi_plan_runs where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as PlanRun | undefined;
  }

  async putPlanRunInputs(inputs: PlanRunInputs): Promise<void> {
    await this.#query(
      "insert into takosumi_plan_run_inputs (plan_run_id, inputs_json) " +
        "values ($1, $2::jsonb) " +
        "on conflict (plan_run_id) do update set inputs_json = excluded.inputs_json",
      [inputs.planRunId, JSON.stringify(inputs)],
    );
  }

  async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    const result = await this.#query<JsonRow>(
      "select inputs_json as json from takosumi_plan_run_inputs where plan_run_id = $1",
      [planRunId],
    );
    return parseRow(result.rows[0]) as PlanRunInputs | undefined;
  }

  async deletePlanRunInputs(planRunId: string): Promise<void> {
    await this.#query(
      "delete from takosumi_plan_run_inputs where plan_run_id = $1",
      [planRunId],
    );
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#query(
      "insert into takosumi_apply_runs " +
        "(id, plan_run_id, space_id, installation_id, deployment_id, runner_profile_id, status, run_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) " +
        "on conflict (id) do update set " +
        "plan_run_id = excluded.plan_run_id, " +
        "space_id = excluded.space_id, " +
        "installation_id = excluded.installation_id, " +
        "deployment_id = excluded.deployment_id, " +
        "runner_profile_id = excluded.runner_profile_id, " +
        "status = excluded.status, " +
        "run_json = excluded.run_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        run.id,
        run.planRunId,
        run.spaceId,
        run.installationId ?? null,
        run.deploymentId ?? null,
        run.runnerProfileId,
        run.status,
        JSON.stringify(run),
        run.createdAt,
        run.updatedAt,
      ],
    );
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    const result = await this.#query<JsonRow>(
      "select run_json as json from takosumi_apply_runs where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as ApplyRun | undefined;
  }

  async putInstallation(installation: Installation): Promise<Installation> {
    await this.#query(
      "insert into takosumi_opentofu_installations " +
        "(id, space_id, app_id, current_deployment_id, runner_profile_id, status, installation_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "app_id = excluded.app_id, " +
        "current_deployment_id = excluded.current_deployment_id, " +
        "runner_profile_id = excluded.runner_profile_id, " +
        "status = excluded.status, " +
        "installation_json = excluded.installation_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        installation.id,
        installation.spaceId,
        installation.appId,
        installation.currentDeploymentId,
        installation.runnerProfileId,
        installation.status,
        JSON.stringify(installation),
        installation.createdAt,
        installation.updatedAt,
      ],
    );
    return installation;
  }

  async getInstallation(id: string): Promise<Installation | undefined> {
    const result = await this.#query<JsonRow>(
      "select installation_json as json from takosumi_opentofu_installations where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as Installation | undefined;
  }

  async listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    const result = spaceId === undefined
      ? await this.#query<JsonRow>(
        "select installation_json as json from takosumi_opentofu_installations order by created_at asc",
      )
      : await this.#query<JsonRow>(
        "select installation_json as json from takosumi_opentofu_installations where space_id = $1 order by created_at asc",
        [spaceId],
      );
    return result.rows.map((row) => parseRow(row) as Installation);
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
    const current = await this.getInstallation(id);
    if (!current) return undefined;
    if (
      guard !== undefined &&
      (current.currentDeploymentId !== guard.currentDeploymentId ||
        (guard.status !== undefined && current.status !== guard.status))
    ) {
      throw new InstallationPatchGuardConflict({
        id,
        expectedCurrentDeploymentId: guard.currentDeploymentId,
        actualCurrentDeploymentId: current.currentDeploymentId,
        expectedStatus: guard.status,
        actualStatus: current.status,
      });
    }
    const updated: Installation = { ...current, ...patch };
    if (!guard) return await this.putInstallation(updated);
    const result = await this.#query<JsonRow>(
      "update takosumi_opentofu_installations set " +
        "space_id = $2, " +
        "app_id = $3, " +
        "current_deployment_id = $4, " +
        "runner_profile_id = $5, " +
        "status = $6, " +
        "installation_json = $7::jsonb, " +
        "updated_at = $8 " +
        "where id = $1 and current_deployment_id is not distinct from $9 " +
        "and ($10::text is null or status = $10) " +
        "returning installation_json as json",
      [
        updated.id,
        updated.spaceId,
        updated.appId,
        updated.currentDeploymentId,
        updated.runnerProfileId,
        updated.status,
        JSON.stringify(updated),
        updated.updatedAt,
        guard.currentDeploymentId,
        guard.status ?? null,
      ],
    );
    const patched = parseRow(result.rows[0]) as Installation | undefined;
    if (patched) return patched;
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
    await this.#query(
      "insert into takosumi_opentofu_deployments " +
        "(id, installation_id, plan_run_id, apply_run_id, runner_profile_id, status, deployment_json, created_at, completed_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) " +
        "on conflict (id) do update set " +
        "installation_id = excluded.installation_id, " +
        "plan_run_id = excluded.plan_run_id, " +
        "apply_run_id = excluded.apply_run_id, " +
        "runner_profile_id = excluded.runner_profile_id, " +
        "status = excluded.status, " +
        "deployment_json = excluded.deployment_json, " +
        "created_at = excluded.created_at, " +
        "completed_at = excluded.completed_at",
      [
        deployment.id,
        deployment.installationId,
        deployment.planRunId,
        deployment.applyRunId,
        deployment.runnerProfileId,
        deployment.status,
        JSON.stringify(deployment),
        deployment.createdAt,
        deployment.completedAt ?? null,
      ],
    );
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    const result = await this.#query<JsonRow>(
      "select deployment_json as json from takosumi_opentofu_deployments where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as Deployment | undefined;
  }

  async listDeployments(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    const result = await this.#query<JsonRow>(
      "select deployment_json as json from takosumi_opentofu_deployments where installation_id = $1 order by created_at asc",
      [installationId],
    );
    return result.rows.map((row) => parseRow(row) as Deployment);
  }

  async putConnection(connection: Connection): Promise<Connection> {
    await this.#query(
      "insert into takosumi_connections " +
        "(id, space_id, provider, status, connection_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5::jsonb, $6, $7) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "provider = excluded.provider, " +
        "status = excluded.status, " +
        "connection_json = excluded.connection_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        connection.id,
        connection.spaceId,
        connection.provider,
        connection.status,
        JSON.stringify(connection),
        connection.createdAt,
        connection.updatedAt,
      ],
    );
    return connection;
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    const result = await this.#query<JsonRow>(
      "select connection_json as json from takosumi_connections where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as Connection | undefined;
  }

  async listConnections(spaceId: string): Promise<readonly Connection[]> {
    const result = await this.#query<JsonRow>(
      "select connection_json as json from takosumi_connections " +
        "where space_id = $1 order by created_at asc, id asc",
      [spaceId],
    );
    return result.rows.map((row) => parseRow(row) as Connection);
  }

  async deleteConnection(id: string): Promise<boolean> {
    const result = await this.#query(
      "delete from takosumi_connections where id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  async putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob> {
    await this.#query(
      "insert into takosumi_connection_secret_blobs (connection_id, blob_json) " +
        "values ($1, $2::jsonb) " +
        "on conflict (connection_id) do update set blob_json = excluded.blob_json",
      [blob.connectionId, JSON.stringify(blob)],
    );
    return blob;
  }

  async getSecretBlob(
    connectionId: string,
  ): Promise<StoredSecretBlob | undefined> {
    const result = await this.#query<JsonRow>(
      "select blob_json as json from takosumi_connection_secret_blobs where connection_id = $1",
      [connectionId],
    );
    return parseRow(result.rows[0]) as StoredSecretBlob | undefined;
  }

  async deleteSecretBlob(connectionId: string): Promise<boolean> {
    const result = await this.#query(
      "delete from takosumi_connection_secret_blobs where connection_id = $1",
      [connectionId],
    );
    return result.rowCount > 0;
  }

  async putSource(source: StoredSource): Promise<StoredSource> {
    await this.#query(
      "insert into takosumi_sources " +
        "(id, space_id, status, source_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4::jsonb, $5, $6) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "status = excluded.status, " +
        "source_json = excluded.source_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        source.id,
        source.spaceId,
        source.status,
        JSON.stringify(source),
        source.createdAt,
        source.updatedAt,
      ],
    );
    return source;
  }

  async getSource(id: string): Promise<StoredSource | undefined> {
    const result = await this.#query<JsonRow>(
      "select source_json as json from takosumi_sources where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as StoredSource | undefined;
  }

  async listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    const result = spaceId === undefined
      ? await this.#query<JsonRow>(
        "select source_json as json from takosumi_sources order by created_at asc, id asc",
      )
      : await this.#query<JsonRow>(
        "select source_json as json from takosumi_sources where space_id = $1 order by created_at asc, id asc",
        [spaceId],
      );
    return result.rows.map((row) => parseRow(row) as StoredSource);
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await this.#query(
      "delete from takosumi_sources where id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  async putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    await this.#query(
      "insert into takosumi_source_snapshots " +
        "(id, source_id, snapshot_json, fetched_at) " +
        "values ($1, $2, $3::jsonb, $4) " +
        "on conflict (id) do update set " +
        "source_id = excluded.source_id, " +
        "snapshot_json = excluded.snapshot_json, " +
        "fetched_at = excluded.fetched_at",
      [
        snapshot.id,
        snapshot.sourceId,
        JSON.stringify(snapshot),
        snapshot.fetchedAt,
      ],
    );
    return snapshot;
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_source_snapshots where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as SourceSnapshot | undefined;
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<readonly SourceSnapshot[]> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_source_snapshots " +
        "where source_id = $1 order by fetched_at asc, id asc",
      [sourceId],
    );
    return result.rows.map((row) => parseRow(row) as SourceSnapshot);
  }

  async putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    await this.#query(
      "insert into takosumi_source_sync_runs " +
        "(id, source_id, space_id, status, run_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5::jsonb, $6, $7) " +
        "on conflict (id) do update set " +
        "source_id = excluded.source_id, " +
        "space_id = excluded.space_id, " +
        "status = excluded.status, " +
        "run_json = excluded.run_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        run.id,
        run.sourceId,
        run.spaceId,
        run.status,
        JSON.stringify(run),
        run.createdAt,
        run.updatedAt,
      ],
    );
    return run;
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    const result = await this.#query<JsonRow>(
      "select run_json as json from takosumi_source_sync_runs where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as SourceSyncRun | undefined;
  }

  async listSourceSyncRuns(
    sourceId: string,
  ): Promise<readonly SourceSyncRun[]> {
    const result = await this.#query<JsonRow>(
      "select run_json as json from takosumi_source_sync_runs " +
        "where source_id = $1 order by created_at asc, id asc",
      [sourceId],
    );
    return result.rows.map((row) => parseRow(row) as SourceSyncRun);
  }

  async putApp(app: App): Promise<App> {
    await this.#query(
      "insert into takosumi_apps " +
        "(id, space_id, source_id, install_type, install_profile_id, app_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "source_id = excluded.source_id, " +
        "install_type = excluded.install_type, " +
        "install_profile_id = excluded.install_profile_id, " +
        "app_json = excluded.app_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        app.id,
        app.spaceId,
        app.sourceId,
        app.installType,
        app.installProfileId ?? null,
        JSON.stringify(app),
        app.createdAt,
        app.updatedAt,
      ],
    );
    return app;
  }

  async getApp(id: string): Promise<App | undefined> {
    const result = await this.#query<JsonRow>(
      "select app_json as json from takosumi_apps where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as App | undefined;
  }

  async listApps(spaceId?: string): Promise<readonly App[]> {
    const result = spaceId === undefined
      ? await this.#query<JsonRow>(
        "select app_json as json from takosumi_apps order by created_at asc, id asc",
      )
      : await this.#query<JsonRow>(
        "select app_json as json from takosumi_apps where space_id = $1 order by created_at asc, id asc",
        [spaceId],
      );
    return result.rows.map((row) => parseRow(row) as App);
  }

  async deleteApp(id: string): Promise<boolean> {
    const result = await this.#query(
      "delete from takosumi_apps where id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  async putEnvironment(environment: Environment): Promise<Environment> {
    await this.#query(
      "insert into takosumi_environments " +
        "(id, app_id, name, environment_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4::jsonb, $5, $6) " +
        "on conflict (id) do update set " +
        "app_id = excluded.app_id, " +
        "name = excluded.name, " +
        "environment_json = excluded.environment_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        environment.id,
        environment.appId,
        environment.name,
        JSON.stringify(environment),
        environment.createdAt,
        environment.updatedAt,
      ],
    );
    return environment;
  }

  async getEnvironment(id: string): Promise<Environment | undefined> {
    const result = await this.#query<JsonRow>(
      "select environment_json as json from takosumi_environments where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as Environment | undefined;
  }

  async listEnvironments(appId: string): Promise<readonly Environment[]> {
    const result = await this.#query<JsonRow>(
      "select environment_json as json from takosumi_environments " +
        "where app_id = $1 order by created_at asc, id asc",
      [appId],
    );
    return result.rows.map((row) => parseRow(row) as Environment);
  }

  async deleteEnvironment(id: string): Promise<boolean> {
    const result = await this.#query(
      "delete from takosumi_environments where id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  async putInstallProfile(profile: InstallProfile): Promise<InstallProfile> {
    await this.#query(
      "insert into takosumi_install_profiles " +
        "(id, install_type, trust_level, profile_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4::jsonb, $5, $6) " +
        "on conflict (id) do update set " +
        "install_type = excluded.install_type, " +
        "trust_level = excluded.trust_level, " +
        "profile_json = excluded.profile_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        profile.id,
        profile.installType,
        profile.trustLevel,
        JSON.stringify(profile),
        profile.createdAt,
        profile.updatedAt,
      ],
    );
    return profile;
  }

  async getInstallProfile(id: string): Promise<InstallProfile | undefined> {
    const result = await this.#query<JsonRow>(
      "select profile_json as json from takosumi_install_profiles where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as InstallProfile | undefined;
  }

  async listInstallProfiles(): Promise<readonly InstallProfile[]> {
    const result = await this.#query<JsonRow>(
      "select profile_json as json from takosumi_install_profiles order by id asc",
    );
    return result.rows.map((row) => parseRow(row) as InstallProfile);
  }

  async putDeploymentProfile(
    profile: DeploymentProfile,
  ): Promise<DeploymentProfile> {
    // One profile per environment: delete any stale row that referenced the
    // same environment under a different id before upserting.
    await this.#query(
      "delete from takosumi_deployment_profiles where environment_id = $1 and id <> $2",
      [profile.environmentId, profile.id],
    );
    await this.#query(
      "insert into takosumi_deployment_profiles " +
        "(id, environment_id, profile_json, created_at, updated_at) " +
        "values ($1, $2, $3::jsonb, $4, $5) " +
        "on conflict (id) do update set " +
        "environment_id = excluded.environment_id, " +
        "profile_json = excluded.profile_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        profile.id,
        profile.environmentId,
        JSON.stringify(profile),
        profile.createdAt,
        profile.updatedAt,
      ],
    );
    return profile;
  }

  async getDeploymentProfileByEnvironment(
    environmentId: string,
  ): Promise<DeploymentProfile | undefined> {
    const result = await this.#query<JsonRow>(
      "select profile_json as json from takosumi_deployment_profiles " +
        "where environment_id = $1 order by created_at desc, id desc limit 1",
      [environmentId],
    );
    return parseRow(result.rows[0]) as DeploymentProfile | undefined;
  }

  async putStateSnapshot(snapshot: StateSnapshot): Promise<StateSnapshot> {
    await this.#query(
      "insert into takosumi_state_snapshots " +
        "(id, environment_id, generation, snapshot_json, created_at) " +
        "values ($1, $2, $3, $4::jsonb, $5) " +
        "on conflict (environment_id, generation) do update set " +
        "id = excluded.id, " +
        "snapshot_json = excluded.snapshot_json, " +
        "created_at = excluded.created_at",
      [
        snapshot.id,
        snapshot.environmentId,
        snapshot.generation,
        JSON.stringify(snapshot),
        snapshot.createdAt,
      ],
    );
    return snapshot;
  }

  async listStateSnapshots(
    environmentId: string,
  ): Promise<readonly StateSnapshot[]> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_state_snapshots " +
        "where environment_id = $1 order by generation asc",
      [environmentId],
    );
    return result.rows.map((row) => parseRow(row) as StateSnapshot);
  }

  async getLatestStateSnapshot(
    environmentId: string,
  ): Promise<StateSnapshot | undefined> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_state_snapshots " +
        "where environment_id = $1 order by generation desc limit 1",
      [environmentId],
    );
    return parseRow(result.rows[0]) as StateSnapshot | undefined;
  }

  #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.#client.query<Row>(sql, parameters);
  }
}

interface JsonRow extends Record<string, unknown> {
  readonly json: unknown;
}

function parseRow(row: JsonRow | undefined): unknown {
  if (!row) return undefined;
  return parseJson(row.json);
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "") return null;
    return JSON.parse(value);
  }
  return value;
}
