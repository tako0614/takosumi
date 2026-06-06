/**
 * SQL-backed OpenTofu deployment-control-plane ledger (core-spec.md §27).
 *
 * The store keeps searchable columns for common list/read paths and persists
 * the contract object as JSON so the public run ledger can evolve without a
 * schema migration for every non-indexed field.
 *
 * Logical schema is the Space-direct Installation model: spaces, install_configs,
 * operator_connection_defaults, installations (UNIQUE(space_id, name,
 * environment)), deployment_profiles (keyed (installation_id, environment)),
 * state_snapshots (keyed (installation_id, environment, generation) UNIQUE),
 * deployments (new shape), and a SINGLE `runs` table — the internal PlanRun
 * (kind `plan`), ApplyRun (kind `apply`), and SourceSyncRun (kind `source_sync`)
 * records persist as rows discriminated by `kind`; the typed accessors verify the
 * row kind before parsing.
 */
import type {
  ApplyRun,
  Connection,
  Deployment,
  InstallConfig,
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
import type { Space } from "takosumi-contract/spaces";
import type {
  Capability,
  OperatorConnectionDefault,
} from "takosumi-contract/capability-bindings";
import type { DeploymentProfile } from "takosumi-contract/installations";
import type { Dependency, DependencySnapshot } from "takosumi-contract/dependencies";
import type { OutputSnapshot } from "takosumi-contract/output-snapshots";
import type { RunGroup } from "takosumi-contract/runs";
import type {
  InstallationPatch,
  InstallationPatchGuard,
  OpenTofuDeploymentStore,
  PlanRunInputs,
  StoredSecretBlob,
  StoredSource,
} from "./store.ts";
import { InstallationPatchGuardConflict } from "./store.ts";

/** Discriminator stored in the single `runs` table (§27). */
// §27 runs.type values. Destroy runs persist their own discriminator
// (destroy_plan / destroy_apply) so the raw table matches the spec enum and
// the D1 backend; the typed accessors read both kinds of their family.
const RUN_KINDS_PLAN = ["plan", "destroy_plan"] as const;
const RUN_KINDS_APPLY = ["apply", "destroy_apply"] as const;
const RUN_KIND_SOURCE_SYNC = "source_sync";

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

  // --- runs (single §27 table; rows discriminated by kind) -----------------

  async putPlanRun(run: PlanRun): Promise<PlanRun> {
    await this.#putRun(run.operation === "destroy" ? "destroy_plan" : "plan", {
      id: run.id,
      spaceId: run.spaceId,
      installationId: run.installationId ?? null,
      createdAt: run.createdAt,
      json: JSON.stringify(run),
    });
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    return await this.#getRun<PlanRun>(id, RUN_KINDS_PLAN);
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#putRun(
      run.operation === "destroy" ? "destroy_apply" : "apply",
      {
        id: run.id,
        spaceId: run.spaceId,
        installationId: run.installationId ?? null,
        createdAt: run.createdAt,
        json: JSON.stringify(run),
      },
    );
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    return await this.#getRun<ApplyRun>(id, RUN_KINDS_APPLY);
  }

  async putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    await this.#putRun(RUN_KIND_SOURCE_SYNC, {
      id: run.id,
      spaceId: run.spaceId,
      // SourceSyncRun is Source-scoped; carry the source id in the indexed
      // installation_id slot so listSourceSyncRuns can filter without a JSON scan.
      installationId: run.sourceId,
      createdAt: run.createdAt,
      json: JSON.stringify(run),
    });
    return run;
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    return await this.#getRun<SourceSyncRun>(id, RUN_KIND_SOURCE_SYNC);
  }

  async listSourceSyncRuns(
    sourceId: string,
  ): Promise<readonly SourceSyncRun[]> {
    const result = await this.#query<JsonRow>(
      "select run_json as json from takosumi_runs " +
        "where kind = $1 and installation_id = $2 " +
        "order by created_at asc, id asc",
      [RUN_KIND_SOURCE_SYNC, sourceId],
    );
    return result.rows.map((row) => parseRow(row) as SourceSyncRun);
  }

  async #putRun(
    kind: string,
    fields: {
      readonly id: string;
      readonly spaceId: string;
      readonly installationId: string | null;
      readonly createdAt: number | string;
      readonly json: string;
    },
  ): Promise<void> {
    await this.#query(
      "insert into takosumi_runs " +
        "(id, kind, space_id, installation_id, created_at, run_json) " +
        "values ($1, $2, $3, $4, $5, $6::jsonb) " +
        "on conflict (id) do update set " +
        "kind = excluded.kind, " +
        "space_id = excluded.space_id, " +
        "installation_id = excluded.installation_id, " +
        "created_at = excluded.created_at, " +
        "run_json = excluded.run_json",
      [
        fields.id,
        kind,
        fields.spaceId,
        fields.installationId,
        // created_at is TEXT so it can hold both the internal epoch-number runs
        // and the ISO-string SourceSyncRun without a per-kind column.
        String(fields.createdAt),
        fields.json,
      ],
    );
  }

  async #getRun<T>(
    id: string,
    kinds: string | readonly string[],
  ): Promise<T | undefined> {
    const list = typeof kinds === "string" ? [kinds] : kinds;
    const placeholders = list.map((_, i) => `$${i + 2}`).join(", ");
    const result = await this.#query<JsonRow>(
      `select run_json as json from takosumi_runs where id = $1 and kind in (${placeholders})`,
      [id, ...list],
    );
    return parseRow(result.rows[0]) as T | undefined;
  }

  // --- plan-run inputs sidecar (never projected into the public ledger) -----

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

  // --- spaces (§4) ----------------------------------------------------------

  async putSpace(space: Space): Promise<Space> {
    await this.#query(
      "insert into takosumi_spaces " +
        "(id, handle, space_json, created_at, updated_at) " +
        "values ($1, $2, $3::jsonb, $4, $5) " +
        "on conflict (id) do update set " +
        "handle = excluded.handle, " +
        "space_json = excluded.space_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        space.id,
        space.handle,
        JSON.stringify(space),
        space.createdAt,
        space.updatedAt,
      ],
    );
    return space;
  }

  async getSpace(id: string): Promise<Space | undefined> {
    const result = await this.#query<JsonRow>(
      "select space_json as json from takosumi_spaces where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as Space | undefined;
  }

  async getSpaceByHandle(handle: string): Promise<Space | undefined> {
    const result = await this.#query<JsonRow>(
      "select space_json as json from takosumi_spaces where handle = $1",
      [handle],
    );
    return parseRow(result.rows[0]) as Space | undefined;
  }

  async listSpaces(): Promise<readonly Space[]> {
    const result = await this.#query<JsonRow>(
      "select space_json as json from takosumi_spaces " +
        "order by created_at asc, id asc",
    );
    return result.rows.map((row) => parseRow(row) as Space);
  }

  // --- install_configs (§11) ------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    await this.#query(
      "insert into takosumi_install_configs " +
        "(id, space_id, install_type, trust_level, config_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5::jsonb, $6, $7) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "install_type = excluded.install_type, " +
        "trust_level = excluded.trust_level, " +
        "config_json = excluded.config_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        config.id,
        config.spaceId ?? null,
        config.installType,
        config.trustLevel,
        JSON.stringify(config),
        config.createdAt,
        config.updatedAt,
      ],
    );
    return config;
  }

  async getInstallConfig(id: string): Promise<InstallConfig | undefined> {
    const result = await this.#query<JsonRow>(
      "select config_json as json from takosumi_install_configs where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as InstallConfig | undefined;
  }

  async listInstallConfigs(
    spaceId?: string,
  ): Promise<readonly InstallConfig[]> {
    const result = spaceId === undefined
      ? await this.#query<JsonRow>(
        "select config_json as json from takosumi_install_configs " +
          "order by created_at asc, id asc",
      )
      : await this.#query<JsonRow>(
        "select config_json as json from takosumi_install_configs " +
          "where space_id = $1 order by created_at asc, id asc",
        [spaceId],
      );
    return result.rows.map((row) => parseRow(row) as InstallConfig);
  }

  // --- installations (§5 / §27, UNIQUE(space_id, name, environment)) --------

  async putInstallation(installation: Installation): Promise<Installation> {
    await this.#query(
      "insert into takosumi_opentofu_installations " +
        "(id, space_id, name, environment, source_id, install_config_id, " +
        "current_deployment_id, status, installation_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "name = excluded.name, " +
        "environment = excluded.environment, " +
        "source_id = excluded.source_id, " +
        "install_config_id = excluded.install_config_id, " +
        "current_deployment_id = excluded.current_deployment_id, " +
        "status = excluded.status, " +
        "installation_json = excluded.installation_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        installation.id,
        installation.spaceId,
        installation.name,
        installation.environment,
        installation.sourceId,
        installation.installConfigId,
        installation.currentDeploymentId ?? null,
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

  async getInstallationByName(
    spaceId: string,
    name: string,
    environment: string,
  ): Promise<Installation | undefined> {
    const result = await this.#query<JsonRow>(
      "select installation_json as json from takosumi_opentofu_installations " +
        "where space_id = $1 and name = $2 and environment = $3",
      [spaceId, name, environment],
    );
    return parseRow(result.rows[0]) as Installation | undefined;
  }

  async listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    const result = spaceId === undefined
      ? await this.#query<JsonRow>(
        "select installation_json as json from takosumi_opentofu_installations " +
          "order by created_at asc, id asc",
      )
      : await this.#query<JsonRow>(
        "select installation_json as json from takosumi_opentofu_installations " +
          "where space_id = $1 order by created_at asc, id asc",
        [spaceId],
      );
    return result.rows.map((row) => parseRow(row) as Installation);
  }

  async patchInstallation(
    id: string,
    patch: InstallationPatch,
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
    // Guarded path: fence on current_deployment_id (and optionally status) in the
    // UPDATE predicate so a concurrent writer cannot win the race between read and
    // write. `is not distinct from` matches NULL == NULL for the unset cursor.
    const result = await this.#query<JsonRow>(
      "update takosumi_opentofu_installations set " +
        "space_id = $2, " +
        "name = $3, " +
        "environment = $4, " +
        "source_id = $5, " +
        "install_config_id = $6, " +
        "current_deployment_id = $7, " +
        "status = $8, " +
        "installation_json = $9::jsonb, " +
        "updated_at = $10 " +
        "where id = $1 and current_deployment_id is not distinct from $11 " +
        "and ($12::text is null or status = $12) " +
        "returning installation_json as json",
      [
        updated.id,
        updated.spaceId,
        updated.name,
        updated.environment,
        updated.sourceId,
        updated.installConfigId,
        updated.currentDeploymentId ?? null,
        updated.status,
        JSON.stringify(updated),
        updated.updatedAt,
        guard.currentDeploymentId ?? null,
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

  // --- deployments (§21, new shape) -----------------------------------------

  async putDeployment(deployment: Deployment): Promise<Deployment> {
    await this.#query(
      "insert into takosumi_opentofu_deployments " +
        "(id, space_id, installation_id, environment, apply_run_id, " +
        "state_generation, status, deployment_json, created_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "installation_id = excluded.installation_id, " +
        "environment = excluded.environment, " +
        "apply_run_id = excluded.apply_run_id, " +
        "state_generation = excluded.state_generation, " +
        "status = excluded.status, " +
        "deployment_json = excluded.deployment_json, " +
        "created_at = excluded.created_at",
      [
        deployment.id,
        deployment.spaceId,
        deployment.installationId,
        deployment.environment,
        deployment.applyRunId,
        deployment.stateGeneration,
        deployment.status,
        JSON.stringify(deployment),
        deployment.createdAt,
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
      "select deployment_json as json from takosumi_opentofu_deployments " +
        "where installation_id = $1 order by created_at asc, id asc",
      [installationId],
    );
    return result.rows.map((row) => parseRow(row) as Deployment);
  }

  // --- connections + sealed secret blobs ------------------------------------

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

  // --- operator_connection_defaults (§9) ------------------------------------

  async putOperatorConnectionDefault(
    record: OperatorConnectionDefault,
  ): Promise<OperatorConnectionDefault> {
    // One default per capability: drop any stale row for the same capability under
    // a different id before upserting (the capability is the natural upsert key).
    await this.#query(
      "delete from takosumi_operator_connection_defaults " +
        "where capability = $1 and id <> $2",
      [record.capability, record.id],
    );
    await this.#query(
      "insert into takosumi_operator_connection_defaults " +
        "(id, capability, provider, connection_id, default_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5::jsonb, $6, $7) " +
        "on conflict (id) do update set " +
        "capability = excluded.capability, " +
        "provider = excluded.provider, " +
        "connection_id = excluded.connection_id, " +
        "default_json = excluded.default_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        record.id,
        record.capability,
        record.provider,
        record.connectionId,
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  async getOperatorConnectionDefault(
    capability: Capability,
  ): Promise<OperatorConnectionDefault | undefined> {
    const result = await this.#query<JsonRow>(
      "select default_json as json from takosumi_operator_connection_defaults " +
        "where capability = $1 limit 1",
      [capability],
    );
    return parseRow(result.rows[0]) as OperatorConnectionDefault | undefined;
  }

  async listOperatorConnectionDefaults(): Promise<
    readonly OperatorConnectionDefault[]
  > {
    const result = await this.#query<JsonRow>(
      "select default_json as json from takosumi_operator_connection_defaults " +
        "order by capability asc",
    );
    return result.rows.map((row) =>
      parseRow(row) as OperatorConnectionDefault
    );
  }

  // --- sources (public + internal hook-secret hash / lastSeenCommit) --------

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

  // --- deployment_profiles (§9, keyed (installation_id, environment)) -------

  async putDeploymentProfile(
    profile: DeploymentProfile,
  ): Promise<DeploymentProfile> {
    // One profile per (installation, environment): delete any stale row for the
    // same pair under a different id before upserting.
    await this.#query(
      "delete from takosumi_deployment_profiles " +
        "where installation_id = $1 and environment = $2 and id <> $3",
      [profile.installationId, profile.environment, profile.id],
    );
    await this.#query(
      "insert into takosumi_deployment_profiles " +
        "(id, space_id, installation_id, environment, profile_json, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5::jsonb, $6, $7) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "installation_id = excluded.installation_id, " +
        "environment = excluded.environment, " +
        "profile_json = excluded.profile_json, " +
        "created_at = excluded.created_at, " +
        "updated_at = excluded.updated_at",
      [
        profile.id,
        profile.spaceId,
        profile.installationId,
        profile.environment,
        JSON.stringify(profile),
        profile.createdAt,
        profile.updatedAt,
      ],
    );
    return profile;
  }

  async getDeploymentProfileByInstallation(
    installationId: string,
    environment: string,
  ): Promise<DeploymentProfile | undefined> {
    const result = await this.#query<JsonRow>(
      "select profile_json as json from takosumi_deployment_profiles " +
        "where installation_id = $1 and environment = $2 " +
        "order by created_at desc, id desc limit 1",
      [installationId, environment],
    );
    return parseRow(result.rows[0]) as DeploymentProfile | undefined;
  }

  // --- state_snapshots (§20, keyed (installation_id, environment, generation)) -

  async putStateSnapshot(snapshot: StateSnapshot): Promise<StateSnapshot> {
    await this.#query(
      "insert into takosumi_state_snapshots " +
        "(id, space_id, installation_id, environment, generation, snapshot_json, created_at) " +
        "values ($1, $2, $3, $4, $5, $6::jsonb, $7) " +
        "on conflict (installation_id, environment, generation) do update set " +
        "id = excluded.id, " +
        "space_id = excluded.space_id, " +
        "snapshot_json = excluded.snapshot_json, " +
        "created_at = excluded.created_at",
      [
        snapshot.id,
        snapshot.spaceId,
        snapshot.installationId,
        snapshot.environment,
        snapshot.generation,
        JSON.stringify(snapshot),
        snapshot.createdAt,
      ],
    );
    return snapshot;
  }

  async getLatestStateSnapshot(
    installationId: string,
    environment: string,
  ): Promise<StateSnapshot | undefined> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_state_snapshots " +
        "where installation_id = $1 and environment = $2 " +
        "order by generation desc limit 1",
      [installationId, environment],
    );
    return parseRow(result.rows[0]) as StateSnapshot | undefined;
  }

  async listStateSnapshots(
    installationId: string,
    environment: string,
  ): Promise<readonly StateSnapshot[]> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_state_snapshots " +
        "where installation_id = $1 and environment = $2 order by generation asc",
      [installationId, environment],
    );
    return result.rows.map((row) => parseRow(row) as StateSnapshot);
  }

  // --- installation_dependencies (§14 / §15) --------------------------------

  async putDependency(dependency: Dependency): Promise<Dependency> {
    await this.#query(
      "insert into takosumi_installation_dependencies " +
        "(id, space_id, producer_installation_id, consumer_installation_id, " +
        "dependency_json, created_at) " +
        "values ($1, $2, $3, $4, $5::jsonb, $6) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "producer_installation_id = excluded.producer_installation_id, " +
        "consumer_installation_id = excluded.consumer_installation_id, " +
        "dependency_json = excluded.dependency_json, " +
        "created_at = excluded.created_at",
      [
        dependency.id,
        dependency.spaceId,
        dependency.producerInstallationId,
        dependency.consumerInstallationId,
        JSON.stringify(dependency),
        dependency.createdAt,
      ],
    );
    return dependency;
  }

  async getDependency(id: string): Promise<Dependency | undefined> {
    const result = await this.#query<JsonRow>(
      "select dependency_json as json from takosumi_installation_dependencies where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as Dependency | undefined;
  }

  async listDependenciesBySpace(
    spaceId: string,
  ): Promise<readonly Dependency[]> {
    const result = await this.#query<JsonRow>(
      "select dependency_json as json from takosumi_installation_dependencies " +
        "where space_id = $1 order by created_at asc, id asc",
      [spaceId],
    );
    return result.rows.map((row) => parseRow(row) as Dependency);
  }

  async listDependenciesForConsumer(
    consumerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    const result = await this.#query<JsonRow>(
      "select dependency_json as json from takosumi_installation_dependencies " +
        "where consumer_installation_id = $1 order by created_at asc, id asc",
      [consumerInstallationId],
    );
    return result.rows.map((row) => parseRow(row) as Dependency);
  }

  async listDependenciesForProducer(
    producerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    const result = await this.#query<JsonRow>(
      "select dependency_json as json from takosumi_installation_dependencies " +
        "where producer_installation_id = $1 order by created_at asc, id asc",
      [producerInstallationId],
    );
    return result.rows.map((row) => parseRow(row) as Dependency);
  }

  async deleteDependency(id: string): Promise<boolean> {
    const result = await this.#query(
      "delete from takosumi_installation_dependencies where id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  // --- dependency_snapshots (§17) -------------------------------------------

  async putDependencySnapshot(
    snapshot: DependencySnapshot,
  ): Promise<DependencySnapshot> {
    await this.#query(
      "insert into takosumi_dependency_snapshots " +
        "(id, run_id, snapshot_json, created_at) " +
        "values ($1, $2, $3::jsonb, $4) " +
        "on conflict (id) do update set " +
        "run_id = excluded.run_id, " +
        "snapshot_json = excluded.snapshot_json, " +
        "created_at = excluded.created_at",
      [snapshot.id, snapshot.runId, JSON.stringify(snapshot), snapshot.createdAt],
    );
    return snapshot;
  }

  async getDependencySnapshot(
    id: string,
  ): Promise<DependencySnapshot | undefined> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_dependency_snapshots where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as DependencySnapshot | undefined;
  }

  // --- output_snapshots (§16) -----------------------------------------------

  async putOutputSnapshot(snapshot: OutputSnapshot): Promise<OutputSnapshot> {
    await this.#query(
      "insert into takosumi_output_snapshots " +
        "(id, space_id, installation_id, state_generation, snapshot_json, created_at) " +
        "values ($1, $2, $3, $4, $5::jsonb, $6) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "installation_id = excluded.installation_id, " +
        "state_generation = excluded.state_generation, " +
        "snapshot_json = excluded.snapshot_json, " +
        "created_at = excluded.created_at",
      [
        snapshot.id,
        snapshot.spaceId,
        snapshot.installationId,
        snapshot.stateGeneration,
        JSON.stringify(snapshot),
        snapshot.createdAt,
      ],
    );
    return snapshot;
  }

  async getOutputSnapshot(id: string): Promise<OutputSnapshot | undefined> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_output_snapshots where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as OutputSnapshot | undefined;
  }

  async getLatestOutputSnapshot(
    installationId: string,
  ): Promise<OutputSnapshot | undefined> {
    const result = await this.#query<JsonRow>(
      "select snapshot_json as json from takosumi_output_snapshots " +
        "where installation_id = $1 " +
        "order by state_generation desc, created_at desc, id desc limit 1",
      [installationId],
    );
    return parseRow(result.rows[0]) as OutputSnapshot | undefined;
  }

  // --- run_groups (§19 / §24) -----------------------------------------------

  async putRunGroup(group: RunGroup): Promise<RunGroup> {
    await this.#query(
      "insert into takosumi_run_groups " +
        "(id, space_id, type, group_json, created_at) " +
        "values ($1, $2, $3, $4::jsonb, $5) " +
        "on conflict (id) do update set " +
        "space_id = excluded.space_id, " +
        "type = excluded.type, " +
        "group_json = excluded.group_json, " +
        "created_at = excluded.created_at",
      [group.id, group.spaceId, group.type, JSON.stringify(group), group.createdAt],
    );
    return group;
  }

  async getRunGroup(id: string): Promise<RunGroup | undefined> {
    const result = await this.#query<JsonRow>(
      "select group_json as json from takosumi_run_groups where id = $1",
      [id],
    );
    return parseRow(result.rows[0]) as RunGroup | undefined;
  }

  async listRunGroups(spaceId: string): Promise<readonly RunGroup[]> {
    const result = await this.#query<JsonRow>(
      "select group_json as json from takosumi_run_groups " +
        "where space_id = $1 order by created_at asc, id asc",
      [spaceId],
    );
    return result.rows.map((row) => parseRow(row) as RunGroup);
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
