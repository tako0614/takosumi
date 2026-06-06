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
} from "takosumi-contract/deploy-control-api";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import type {
  InstallationPatchGuard,
  OpenTofuDeploymentStore,
  PlanRunInputs,
  StoredSecretBlob,
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
