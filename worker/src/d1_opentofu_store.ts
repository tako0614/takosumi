/**
 * D1-backed control-plane ledger (core-spec.md §27) — Space-direct Installation
 * model.
 *
 * This is the Cloudflare D1 backend of {@link OpenTofuDeploymentStore}. It
 * materializes the §27 logical schema as real per-entity tables (`spaces`,
 * `sources`, `source_snapshots`, `connections`, `secret_blobs`,
 * `operator_connection_defaults`, `install_configs`, `installations`,
 * `deployment_profiles`, `runs`, `state_snapshots`, `deployments`) created lazily
 * with `CREATE TABLE IF NOT EXISTS` on first use (the schema-init promise is
 * memoized per store instance).
 *
 * Several contract types carry more fields than the §27 columns (the internal
 * PlanRun / ApplyRun records especially, plus Connection / Source which extend
 * the public row with internal-only data). For those rows the store populates
 * the §27-named indexed columns it filters/sorts on AND a `record_json` /
 * `run_json` TEXT column holding the full contract shape, so a put/get round-trip
 * is exact while list/read paths stay column-indexed. The store never stores
 * secret plaintext: the sealed `secret_blobs` ciphertext is the only credential
 * material, kept off every list path.
 *
 * worker/ is outside the tsc include scope; this file is exercised by
 * `src/service/domains/deploy-control/store_{sources,connections}_test.ts`
 * through the shared {@link OpenTofuDeploymentStore} contract and bundled by the
 * worker build.
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
  Source,
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
} from "../../src/service/domains/deploy-control/store.ts";
import { InstallationPatchGuardConflict } from "../../src/service/domains/deploy-control/store.ts";
import type { D1Database, D1Result } from "./bindings.ts";

/**
 * Discriminator stored in the single §27 `runs.type` column. PlanRun rows use
 * `plan`/`destroy_plan` (the OpenTofu operation decides which), ApplyRun rows use
 * `apply`/`destroy_apply`, and SourceSyncRun rows use `source_sync`. The typed
 * accessors filter on these so the controller keeps its internal shapes.
 */
const RUN_KIND_PLAN = "plan" as const;
const RUN_KIND_APPLY = "apply" as const;
const RUN_KIND_SOURCE_SYNC = "source_sync" as const;

export class CloudflareD1OpenTofuDeploymentStore
  implements OpenTofuDeploymentStore {
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {}

  // -- RunnerProfile ----------------------------------------------------------

  async putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    await this.#run(
      `insert into runner_profiles (id, record_json, created_at)
       values (?, ?, ?)
       on conflict (id) do update set
        record_json = excluded.record_json,
        created_at = excluded.created_at`,
      [profile.id, JSON.stringify(profile), profile.createdAt],
    );
    return profile;
  }

  async getRunnerProfile(id: string): Promise<RunnerProfile | undefined> {
    return await this.#first<RunnerProfile>(
      "select record_json from runner_profiles where id = ?",
      [id],
    );
  }

  async listRunnerProfiles(): Promise<readonly RunnerProfile[]> {
    return await this.#many<RunnerProfile>(
      "select record_json from runner_profiles order by id asc",
      [],
    );
  }

  // -- Runs (PlanRun / ApplyRun / SourceSyncRun share the §27 `runs` table) ----

  async putPlanRun(run: PlanRun): Promise<PlanRun> {
    await this.#putRun({
      id: run.id,
      runGroupId: null,
      spaceId: run.spaceId,
      installationId: run.installationId ?? null,
      environment: run.installationContext?.environment ?? null,
      type: planRunType(run),
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    return await this.#getRun<PlanRun>(id, [RUN_KIND_PLAN, "destroy_plan"]);
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#putRun({
      id: run.id,
      runGroupId: null,
      spaceId: run.spaceId,
      installationId: run.installationId ?? null,
      environment: null,
      type: applyRunType(run),
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    return await this.#getRun<ApplyRun>(id, [RUN_KIND_APPLY, "destroy_apply"]);
  }

  async putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    await this.#putRun({
      id: run.id,
      runGroupId: null,
      spaceId: run.spaceId,
      // SourceSyncRun is Source-scoped: the source id rides the
      // installation_id column so listSourceSyncRuns can scan it.
      installationId: run.sourceId,
      environment: null,
      type: RUN_KIND_SOURCE_SYNC,
      status: run.status,
      runJson: JSON.stringify(run),
    });
    return run;
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined> {
    return await this.#getRun<SourceSyncRun>(id, [RUN_KIND_SOURCE_SYNC]);
  }

  async listSourceSyncRuns(
    sourceId: string,
  ): Promise<readonly SourceSyncRun[]> {
    return await this.#many<SourceSyncRun>(
      `select run_json as record_json from runs
       where type = ? and installation_id = ?
       order by created_at asc, id asc`,
      [RUN_KIND_SOURCE_SYNC, sourceId],
    );
  }

  // -- PlanRunInputs sidecar (internal; never projected) ----------------------

  async putPlanRunInputs(inputs: PlanRunInputs): Promise<void> {
    await this.#run(
      `insert into runs_inputs (plan_run_id, inputs_json)
       values (?, ?)
       on conflict (plan_run_id) do update set inputs_json = excluded.inputs_json`,
      [inputs.planRunId, JSON.stringify(inputs)],
    );
  }

  async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    return await this.#first<PlanRunInputs>(
      "select inputs_json as record_json from runs_inputs where plan_run_id = ?",
      [planRunId],
    );
  }

  async deletePlanRunInputs(planRunId: string): Promise<void> {
    await this.#run(
      "delete from runs_inputs where plan_run_id = ?",
      [planRunId],
    );
  }

  // -- Space ------------------------------------------------------------------

  async putSpace(space: Space): Promise<Space> {
    await this.#run(
      `insert into spaces (id, handle, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict (id) do update set
        handle = excluded.handle,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      [space.id, space.handle, JSON.stringify(space), space.createdAt, space.updatedAt],
    );
    return space;
  }

  async getSpace(id: string): Promise<Space | undefined> {
    return await this.#first<Space>(
      "select record_json from spaces where id = ?",
      [id],
    );
  }

  async getSpaceByHandle(handle: string): Promise<Space | undefined> {
    return await this.#first<Space>(
      "select record_json from spaces where handle = ?",
      [handle],
    );
  }

  async listSpaces(): Promise<readonly Space[]> {
    return await this.#many<Space>(
      "select record_json from spaces order by created_at asc, id asc",
      [],
    );
  }

  // -- InstallConfig ----------------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    await this.#run(
      `insert into install_configs
        (id, space_id, install_type, trust_level, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        install_type = excluded.install_type,
        trust_level = excluded.trust_level,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
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
    return await this.#first<InstallConfig>(
      "select record_json from install_configs where id = ?",
      [id],
    );
  }

  async listInstallConfigs(spaceId?: string): Promise<readonly InstallConfig[]> {
    if (spaceId === undefined) {
      return await this.#many<InstallConfig>(
        "select record_json from install_configs order by created_at asc, id asc",
        [],
      );
    }
    return await this.#many<InstallConfig>(
      `select record_json from install_configs
       where space_id = ? order by created_at asc, id asc`,
      [spaceId],
    );
  }

  // -- Installation -----------------------------------------------------------

  async putInstallation(installation: Installation): Promise<Installation> {
    await this.#run(
      `insert into installations
        (id, space_id, name, slug, source_id, install_type, install_config_id,
         environment, current_deployment_id, current_state_generation,
         current_output_snapshot_id, status, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        name = excluded.name,
        slug = excluded.slug,
        source_id = excluded.source_id,
        install_type = excluded.install_type,
        install_config_id = excluded.install_config_id,
        environment = excluded.environment,
        current_deployment_id = excluded.current_deployment_id,
        current_state_generation = excluded.current_state_generation,
        current_output_snapshot_id = excluded.current_output_snapshot_id,
        status = excluded.status,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      [
        installation.id,
        installation.spaceId,
        installation.name,
        installation.slug,
        installation.sourceId,
        installation.installType,
        installation.installConfigId,
        installation.environment,
        installation.currentDeploymentId ?? null,
        installation.currentStateGeneration,
        installation.currentOutputSnapshotId ?? null,
        installation.status,
        JSON.stringify(installation),
        installation.createdAt,
        installation.updatedAt,
      ],
    );
    return installation;
  }

  async getInstallation(id: string): Promise<Installation | undefined> {
    return await this.#first<Installation>(
      "select record_json from installations where id = ?",
      [id],
    );
  }

  async getInstallationByName(
    spaceId: string,
    name: string,
    environment: string,
  ): Promise<Installation | undefined> {
    return await this.#first<Installation>(
      `select record_json from installations
       where space_id = ? and name = ? and environment = ?`,
      [spaceId, name, environment],
    );
  }

  async listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    if (spaceId === undefined) {
      return await this.#many<Installation>(
        "select record_json from installations order by created_at asc, id asc",
        [],
      );
    }
    return await this.#many<Installation>(
      `select record_json from installations
       where space_id = ? order by created_at asc, id asc`,
      [spaceId],
    );
  }

  async patchInstallation(
    id: string,
    patch: InstallationPatch,
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
    // Guarded path: a single conditional UPDATE so a concurrent writer that
    // moved currentDeploymentId/status loses the race deterministically.
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `update installations set
        current_deployment_id = ?,
        current_state_generation = ?,
        current_output_snapshot_id = ?,
        status = ?,
        record_json = ?,
        updated_at = ?
       where id = ?
         and current_deployment_id is ?
         and (? is null or status = ?)`,
    ).bind(
      updated.currentDeploymentId ?? null,
      updated.currentStateGeneration,
      updated.currentOutputSnapshotId ?? null,
      updated.status,
      JSON.stringify(updated),
      updated.updatedAt,
      id,
      guard.currentDeploymentId ?? null,
      guard.status ?? null,
      guard.status ?? null,
    ).run();
    if (changes(result) > 0) return updated;
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

  // -- Deployment -------------------------------------------------------------

  async putDeployment(deployment: Deployment): Promise<Deployment> {
    await this.#run(
      `insert into deployments
        (id, space_id, installation_id, environment, apply_run_id,
         source_snapshot_id, dependency_snapshot_id, state_generation,
         output_snapshot_id, outputs_public_json, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        installation_id = excluded.installation_id,
        environment = excluded.environment,
        apply_run_id = excluded.apply_run_id,
        source_snapshot_id = excluded.source_snapshot_id,
        dependency_snapshot_id = excluded.dependency_snapshot_id,
        state_generation = excluded.state_generation,
        output_snapshot_id = excluded.output_snapshot_id,
        outputs_public_json = excluded.outputs_public_json,
        status = excluded.status,
        created_at = excluded.created_at`,
      [
        deployment.id,
        deployment.spaceId,
        deployment.installationId,
        deployment.environment,
        deployment.applyRunId,
        deployment.sourceSnapshotId ?? null,
        deployment.dependencySnapshotId ?? null,
        deployment.stateGeneration,
        deployment.outputSnapshotId ?? null,
        JSON.stringify(deployment.outputsPublic),
        deployment.status,
        deployment.createdAt,
      ],
    );
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    return await this.#firstDeployment(
      "select * from deployments where id = ?",
      [id],
    );
  }

  async listDeployments(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `select * from deployments
       where installation_id = ? order by created_at asc, id asc`,
    ).bind(installationId).all<DeploymentRow>();
    return (result.results ?? []).map(deploymentFromRow);
  }

  // -- Connection (+ sealed secret blob) --------------------------------------

  async putConnection(connection: Connection): Promise<Connection> {
    await this.#run(
      `insert into connections
        (id, space_id, status, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        status = excluded.status,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      [
        connection.id,
        connection.spaceId,
        connection.status,
        JSON.stringify(connection),
        connection.createdAt,
        connection.updatedAt,
      ],
    );
    return connection;
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    return await this.#first<Connection>(
      "select record_json from connections where id = ?",
      [id],
    );
  }

  async listConnections(spaceId: string): Promise<readonly Connection[]> {
    return await this.#many<Connection>(
      `select record_json from connections
       where space_id = ? order by created_at asc, id asc`,
      [spaceId],
    );
  }

  async deleteConnection(id: string): Promise<boolean> {
    return await this.#delete("delete from connections where id = ?", [id]);
  }

  async putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob> {
    // Sealed ciphertext only; keyed by connection id and intentionally NOT on
    // any list path so the blob is never list-indexable.
    await this.#run(
      `insert into secret_blobs (connection_id, blob_json)
       values (?, ?)
       on conflict (connection_id) do update set blob_json = excluded.blob_json`,
      [blob.connectionId, JSON.stringify(blob)],
    );
    return blob;
  }

  async getSecretBlob(
    connectionId: string,
  ): Promise<StoredSecretBlob | undefined> {
    return await this.#first<StoredSecretBlob>(
      "select blob_json as record_json from secret_blobs where connection_id = ?",
      [connectionId],
    );
  }

  async deleteSecretBlob(connectionId: string): Promise<boolean> {
    return await this.#delete(
      "delete from secret_blobs where connection_id = ?",
      [connectionId],
    );
  }

  // -- OperatorConnectionDefault ----------------------------------------------

  async putOperatorConnectionDefault(
    record: OperatorConnectionDefault,
  ): Promise<OperatorConnectionDefault> {
    // One default per capability: drop any stale row under a different id for
    // the same capability before upserting.
    await this.#run(
      "delete from operator_connection_defaults where capability = ? and id <> ?",
      [record.capability, record.id],
    );
    await this.#run(
      `insert into operator_connection_defaults
        (id, capability, provider, connection_id, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        capability = excluded.capability,
        provider = excluded.provider,
        connection_id = excluded.connection_id,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
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
    return await this.#first<OperatorConnectionDefault>(
      "select record_json from operator_connection_defaults where capability = ?",
      [capability],
    );
  }

  async listOperatorConnectionDefaults(): Promise<
    readonly OperatorConnectionDefault[]
  > {
    return await this.#many<OperatorConnectionDefault>(
      "select record_json from operator_connection_defaults order by capability asc",
      [],
    );
  }

  // -- Source (+ snapshots) ---------------------------------------------------

  async putSource(source: StoredSource): Promise<StoredSource> {
    await this.#run(
      `insert into sources
        (id, space_id, status, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        status = excluded.status,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
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
    return await this.#first<StoredSource>(
      "select record_json from sources where id = ?",
      [id],
    );
  }

  async listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    if (spaceId === undefined) {
      return await this.#many<StoredSource>(
        "select record_json from sources order by created_at asc, id asc",
        [],
      );
    }
    return await this.#many<StoredSource>(
      "select record_json from sources where space_id = ? order by created_at asc, id asc",
      [spaceId],
    );
  }

  async deleteSource(id: string): Promise<boolean> {
    return await this.#delete("delete from sources where id = ?", [id]);
  }

  async putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    await this.#run(
      `insert into source_snapshots
        (id, source_id, record_json, fetched_at)
       values (?, ?, ?, ?)
       on conflict (id) do update set
        source_id = excluded.source_id,
        record_json = excluded.record_json,
        fetched_at = excluded.fetched_at`,
      [snapshot.id, snapshot.sourceId, JSON.stringify(snapshot), snapshot.fetchedAt],
    );
    return snapshot;
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined> {
    return await this.#first<SourceSnapshot>(
      "select record_json from source_snapshots where id = ?",
      [id],
    );
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<readonly SourceSnapshot[]> {
    return await this.#many<SourceSnapshot>(
      `select record_json from source_snapshots
       where source_id = ? order by fetched_at asc, id asc`,
      [sourceId],
    );
  }

  // -- DeploymentProfile ------------------------------------------------------

  async putDeploymentProfile(
    profile: DeploymentProfile,
  ): Promise<DeploymentProfile> {
    // One profile per (installation, environment): drop any stale row for the
    // same pair under a different id before upserting.
    await this.#run(
      `delete from deployment_profiles
       where installation_id = ? and environment = ? and id <> ?`,
      [profile.installationId, profile.environment, profile.id],
    );
    await this.#run(
      `insert into deployment_profiles
        (id, space_id, installation_id, environment, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        installation_id = excluded.installation_id,
        environment = excluded.environment,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
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
    return await this.#first<DeploymentProfile>(
      `select record_json from deployment_profiles
       where installation_id = ? and environment = ?
       order by created_at desc, id desc limit 1`,
      [installationId, environment],
    );
  }

  // -- StateSnapshot ----------------------------------------------------------

  async putStateSnapshot(snapshot: StateSnapshot): Promise<StateSnapshot> {
    await this.#run(
      `insert into state_snapshots
        (id, space_id, installation_id, environment, generation, object_key,
         digest, created_by_run_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (installation_id, environment, generation) do update set
        id = excluded.id,
        space_id = excluded.space_id,
        object_key = excluded.object_key,
        digest = excluded.digest,
        created_by_run_id = excluded.created_by_run_id,
        created_at = excluded.created_at`,
      [
        snapshot.id,
        snapshot.spaceId,
        snapshot.installationId,
        snapshot.environment,
        snapshot.generation,
        snapshot.objectKey,
        snapshot.digest,
        snapshot.createdByRunId,
        snapshot.createdAt,
      ],
    );
    return snapshot;
  }

  async getLatestStateSnapshot(
    installationId: string,
    environment: string,
  ): Promise<StateSnapshot | undefined> {
    await this.#ensureSchema();
    const row = await this.db.prepare(
      `select * from state_snapshots
       where installation_id = ? and environment = ?
       order by generation desc limit 1`,
    ).bind(installationId, environment).first<StateSnapshotRow>();
    return row ? stateSnapshotFromRow(row) : undefined;
  }

  async listStateSnapshots(
    installationId: string,
    environment: string,
  ): Promise<readonly StateSnapshot[]> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `select * from state_snapshots
       where installation_id = ? and environment = ?
       order by generation asc`,
    ).bind(installationId, environment).all<StateSnapshotRow>();
    return (result.results ?? []).map(stateSnapshotFromRow);
  }

  // -- Dependency DAG (§14 / §15 / §27 installation_dependencies) --------------

  async putDependency(dependency: Dependency): Promise<Dependency> {
    await this.#run(
      `insert into installation_dependencies
        (id, space_id, producer_installation_id, consumer_installation_id,
         record_json, created_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        producer_installation_id = excluded.producer_installation_id,
        consumer_installation_id = excluded.consumer_installation_id,
        record_json = excluded.record_json,
        created_at = excluded.created_at`,
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
    return await this.#first<Dependency>(
      "select record_json from installation_dependencies where id = ?",
      [id],
    );
  }

  async listDependenciesBySpace(
    spaceId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#many<Dependency>(
      `select record_json from installation_dependencies
       where space_id = ? order by created_at asc, id asc`,
      [spaceId],
    );
  }

  async listDependenciesForConsumer(
    consumerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#many<Dependency>(
      `select record_json from installation_dependencies
       where consumer_installation_id = ? order by created_at asc, id asc`,
      [consumerInstallationId],
    );
  }

  async listDependenciesForProducer(
    producerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#many<Dependency>(
      `select record_json from installation_dependencies
       where producer_installation_id = ? order by created_at asc, id asc`,
      [producerInstallationId],
    );
  }

  async deleteDependency(id: string): Promise<boolean> {
    return await this.#delete(
      "delete from installation_dependencies where id = ?",
      [id],
    );
  }

  // -- DependencySnapshot (§17 / §27 dependency_snapshots) ---------------------

  async putDependencySnapshot(
    snapshot: DependencySnapshot,
  ): Promise<DependencySnapshot> {
    await this.#run(
      `insert into dependency_snapshots (id, run_id, record_json, created_at)
       values (?, ?, ?, ?)
       on conflict (id) do update set
        run_id = excluded.run_id,
        record_json = excluded.record_json,
        created_at = excluded.created_at`,
      [snapshot.id, snapshot.runId, JSON.stringify(snapshot), snapshot.createdAt],
    );
    return snapshot;
  }

  async getDependencySnapshot(
    id: string,
  ): Promise<DependencySnapshot | undefined> {
    return await this.#first<DependencySnapshot>(
      "select record_json from dependency_snapshots where id = ?",
      [id],
    );
  }

  // -- OutputSnapshot (§16 / §27 output_snapshots) -----------------------------

  async putOutputSnapshot(snapshot: OutputSnapshot): Promise<OutputSnapshot> {
    await this.#run(
      `insert into output_snapshots
        (id, space_id, installation_id, state_generation, record_json, created_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        installation_id = excluded.installation_id,
        state_generation = excluded.state_generation,
        record_json = excluded.record_json,
        created_at = excluded.created_at`,
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
    return await this.#first<OutputSnapshot>(
      "select record_json from output_snapshots where id = ?",
      [id],
    );
  }

  async getLatestOutputSnapshot(
    installationId: string,
  ): Promise<OutputSnapshot | undefined> {
    return await this.#first<OutputSnapshot>(
      `select record_json from output_snapshots
       where installation_id = ?
       order by state_generation desc, created_at desc, id desc limit 1`,
      [installationId],
    );
  }

  // -- RunGroup (§19 / §24 / §27 run_groups) -----------------------------------

  async putRunGroup(group: RunGroup): Promise<RunGroup> {
    await this.#run(
      `insert into run_groups (id, space_id, type, record_json, created_at)
       values (?, ?, ?, ?, ?)
       on conflict (id) do update set
        space_id = excluded.space_id,
        type = excluded.type,
        record_json = excluded.record_json,
        created_at = excluded.created_at`,
      [group.id, group.spaceId, group.type, JSON.stringify(group), group.createdAt],
    );
    return group;
  }

  async getRunGroup(id: string): Promise<RunGroup | undefined> {
    return await this.#first<RunGroup>(
      "select record_json from run_groups where id = ?",
      [id],
    );
  }

  async listRunGroups(spaceId: string): Promise<readonly RunGroup[]> {
    return await this.#many<RunGroup>(
      `select record_json from run_groups
       where space_id = ? order by created_at asc, id asc`,
      [spaceId],
    );
  }

  // -- shared D1 helpers ------------------------------------------------------

  async #putRun(row: {
    readonly id: string;
    readonly runGroupId: string | null;
    readonly spaceId: string;
    readonly installationId: string | null;
    readonly environment: string | null;
    readonly type: string;
    readonly status: string;
    readonly runJson: string;
  }): Promise<void> {
    // The §27 `runs` table physically stores PlanRun / ApplyRun / SourceSyncRun
    // rows discriminated by `type`; the full internal record lives in `run_json`.
    // created_at is the internal record's createdAt (epoch number for plan/apply
    // runs, ISO string for source_sync) — stored verbatim so the typed get round
    // trips, and used only for stable list ordering.
    await this.#ensureSchema();
    const createdAt = JSON.parse(row.runJson).createdAt ?? 0;
    await this.db.prepare(
      `insert into runs
        (id, run_group_id, space_id, installation_id, environment, type, status,
         run_json, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
        run_group_id = excluded.run_group_id,
        space_id = excluded.space_id,
        installation_id = excluded.installation_id,
        environment = excluded.environment,
        type = excluded.type,
        status = excluded.status,
        run_json = excluded.run_json,
        created_at = excluded.created_at`,
    ).bind(
      row.id,
      row.runGroupId,
      row.spaceId,
      row.installationId,
      row.environment,
      row.type,
      row.status,
      row.runJson,
      createdAt,
    ).run();
  }

  async #getRun<T>(
    id: string,
    types: readonly string[],
  ): Promise<T | undefined> {
    await this.#ensureSchema();
    const placeholders = types.map(() => "?").join(", ");
    const row = await this.db.prepare(
      `select run_json from runs where id = ? and type in (${placeholders})`,
    ).bind(id, ...types).first<{ run_json: string }>();
    return row ? (JSON.parse(row.run_json) as T) : undefined;
  }

  async #firstDeployment(
    sql: string,
    params: readonly unknown[],
  ): Promise<Deployment | undefined> {
    await this.#ensureSchema();
    const row = await this.db.prepare(sql).bind(...params).first<DeploymentRow>();
    return row ? deploymentFromRow(row) : undefined;
  }

  async #run(sql: string, params: readonly unknown[]): Promise<void> {
    await this.#ensureSchema();
    await this.db.prepare(sql).bind(...params).run();
  }

  async #delete(sql: string, params: readonly unknown[]): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.db.prepare(sql).bind(...params).run();
    return changes(result) > 0;
  }

  async #first<T>(
    sql: string,
    params: readonly unknown[],
  ): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.db.prepare(sql).bind(...params).first<
      { record_json: string }
    >();
    return row ? (JSON.parse(row.record_json) as T) : undefined;
  }

  async #many<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
    await this.#ensureSchema();
    const result = await this.db.prepare(sql).bind(...params).all<
      { record_json: string }
    >();
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

// -- run-kind discriminators ---------------------------------------------------

function planRunType(run: PlanRun): string {
  return run.operation === "destroy" ? "destroy_plan" : RUN_KIND_PLAN;
}

function applyRunType(run: ApplyRun): string {
  return run.operation === "destroy" ? "destroy_apply" : RUN_KIND_APPLY;
}

// -- Deployment / StateSnapshot row mapping ------------------------------------
//
// The columnar deployments / state_snapshots tables carry every contract field
// in §27 columns (no record_json), so the rows are reconstructed field-by-field.

interface DeploymentRow {
  readonly id: string;
  readonly space_id: string;
  readonly installation_id: string;
  readonly environment: string;
  readonly apply_run_id: string;
  readonly source_snapshot_id: string | null;
  readonly dependency_snapshot_id: string | null;
  readonly state_generation: number;
  readonly output_snapshot_id: string | null;
  readonly outputs_public_json: string;
  readonly status: string;
  readonly created_at: string;
}

function deploymentFromRow(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    spaceId: row.space_id,
    installationId: row.installation_id,
    environment: row.environment,
    applyRunId: row.apply_run_id,
    ...(row.source_snapshot_id !== null
      ? { sourceSnapshotId: row.source_snapshot_id }
      : {}),
    ...(row.dependency_snapshot_id !== null
      ? { dependencySnapshotId: row.dependency_snapshot_id }
      : {}),
    stateGeneration: row.state_generation,
    ...(row.output_snapshot_id !== null
      ? { outputSnapshotId: row.output_snapshot_id }
      : {}),
    outputsPublic: JSON.parse(row.outputs_public_json) as Record<
      string,
      unknown
    >,
    status: row.status as Deployment["status"],
    createdAt: row.created_at,
  };
}

interface StateSnapshotRow {
  readonly id: string;
  readonly space_id: string;
  readonly installation_id: string;
  readonly environment: string;
  readonly generation: number;
  readonly object_key: string;
  readonly digest: string;
  readonly created_by_run_id: string;
  readonly created_at: string;
}

function stateSnapshotFromRow(row: StateSnapshotRow): StateSnapshot {
  return {
    id: row.id,
    spaceId: row.space_id,
    installationId: row.installation_id,
    environment: row.environment,
    generation: row.generation,
    objectKey: row.object_key,
    digest: row.digest,
    createdByRunId: row.created_by_run_id,
    createdAt: row.created_at,
  };
}

function changes(result: D1Result): number {
  return result.meta?.changes ?? 0;
}

/**
 * Lazily create the §27 control-plane tables. Idempotent (`IF NOT EXISTS`);
 * called once per store instance via the memoized init promise. Rich internal
 * records (runner profiles, runs, install configs, connections, sources,
 * snapshots, deployment profiles, spaces, operator defaults) keep a `record_json`
 * / `run_json` TEXT column carrying the full contract shape alongside the §27
 * indexed columns; the columnar `deployments` / `state_snapshots` tables carry
 * every field in §27 columns directly. `runs_inputs` is the internal PlanRun
 * inputs sidecar (never projected); `secret_blobs` holds sealed ciphertext only.
 */
export async function ensureD1OpenTofuLedgerSchema(
  db: D1Database,
): Promise<void> {
  const statements = [
    `create table if not exists spaces (
      id text primary key,
      handle text not null unique,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create table if not exists sources (
      id text primary key,
      space_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists sources_space_idx
      on sources (space_id, created_at)`,
    `create table if not exists source_snapshots (
      id text primary key,
      source_id text not null,
      record_json text not null,
      fetched_at text not null
    )`,
    `create index if not exists source_snapshots_source_idx
      on source_snapshots (source_id, fetched_at)`,
    `create table if not exists connections (
      id text primary key,
      space_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists connections_space_idx
      on connections (space_id, created_at)`,
    `create table if not exists secret_blobs (
      connection_id text primary key,
      blob_json text not null
    )`,
    `create table if not exists operator_connection_defaults (
      id text primary key,
      capability text not null,
      provider text not null,
      connection_id text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists operator_connection_defaults_capability_idx
      on operator_connection_defaults (capability)`,
    `create table if not exists install_configs (
      id text primary key,
      space_id text,
      install_type text not null,
      trust_level text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists install_configs_space_idx
      on install_configs (space_id, created_at)`,
    `create table if not exists installations (
      id text primary key,
      space_id text not null,
      name text not null,
      slug text not null,
      source_id text not null,
      install_type text not null,
      install_config_id text not null,
      environment text not null,
      current_deployment_id text,
      current_state_generation integer not null default 0,
      current_output_snapshot_id text,
      status text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null,
      unique (space_id, name, environment)
    )`,
    `create index if not exists installations_space_idx
      on installations (space_id, created_at)`,
    `create table if not exists deployment_profiles (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      record_json text not null,
      created_at text not null,
      updated_at text not null
    )`,
    `create unique index if not exists deployment_profiles_installation_env_idx
      on deployment_profiles (installation_id, environment)`,
    `create table if not exists runs (
      id text primary key,
      run_group_id text,
      space_id text not null,
      installation_id text,
      environment text,
      type text not null,
      status text not null,
      run_json text not null,
      created_at text not null default ""
    )`,
    `create index if not exists runs_installation_idx
      on runs (type, installation_id, created_at)`,
    `create table if not exists runs_inputs (
      plan_run_id text primary key,
      inputs_json text not null
    )`,
    `create table if not exists state_snapshots (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      generation integer not null,
      object_key text not null,
      digest text not null,
      created_by_run_id text not null,
      created_at text not null,
      unique (installation_id, environment, generation)
    )`,
    `create table if not exists deployments (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      apply_run_id text not null,
      source_snapshot_id text,
      dependency_snapshot_id text,
      state_generation integer not null,
      output_snapshot_id text,
      outputs_public_json text not null,
      status text not null,
      created_at text not null
    )`,
    `create index if not exists deployments_installation_idx
      on deployments (installation_id, created_at)`,
    `create table if not exists runner_profiles (
      id text primary key,
      record_json text not null,
      created_at text not null default ""
    )`,
    `create table if not exists installation_dependencies (
      id text primary key,
      space_id text not null,
      producer_installation_id text not null,
      consumer_installation_id text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists installation_dependencies_space_idx
      on installation_dependencies (space_id, created_at)`,
    `create index if not exists installation_dependencies_consumer_idx
      on installation_dependencies (consumer_installation_id, created_at)`,
    `create index if not exists installation_dependencies_producer_idx
      on installation_dependencies (producer_installation_id, created_at)`,
    `create table if not exists dependency_snapshots (
      id text primary key,
      run_id text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists dependency_snapshots_run_idx
      on dependency_snapshots (run_id)`,
    `create table if not exists output_snapshots (
      id text primary key,
      space_id text not null,
      installation_id text not null,
      state_generation integer not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists output_snapshots_installation_idx
      on output_snapshots (installation_id, state_generation, created_at)`,
    `create table if not exists run_groups (
      id text primary key,
      space_id text not null,
      type text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists run_groups_space_idx
      on run_groups (space_id, created_at)`,
  ];
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}
