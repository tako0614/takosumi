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
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
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
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { Space } from "takosumi-contract/spaces";
import type {
  Capability,
  OperatorConnectionDefault,
} from "takosumi-contract/capability-bindings";
import type { DeploymentProfile } from "takosumi-contract/installations";
import type {
  Dependency,
  DependencySnapshot,
} from "takosumi-contract/dependencies";
import type {
  OutputShare,
  OutputSnapshot,
} from "takosumi-contract/output-snapshots";
import type { RunGroup } from "takosumi-contract/runs";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { BackupRecord } from "takosumi-contract/backups";
import type { CredentialMintEvent } from "takosumi-contract/security";
import type {
  InstallationPatch,
  InstallationPatchGuard,
  OpenTofuDeploymentStore,
  PlanRunInputs,
  StoredSecretBlob,
  StoredSource,
} from "../../src/service/domains/deploy-control/store.ts";
import {
  clampActivityLimit,
  InstallationPatchGuardConflict,
} from "../../src/service/domains/deploy-control/store.ts";
import * as schema from "../../src/service/adapters/storage/drizzle/schema/d1.ts";
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

export class CloudflareD1OpenTofuDeploymentStore implements OpenTofuDeploymentStore {
  readonly #orm: DrizzleD1Database<typeof schema>;
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {
    this.#orm = drizzle(db, { schema });
  }

  // -- RunnerProfile ----------------------------------------------------------

  async putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    await this.#drizzleUpsert(schema.runnerProfiles, {
      id: profile.id,
      recordJson: profile,
      createdAt: profile.createdAt,
    });
    return profile;
  }

  async getRunnerProfile(id: string): Promise<RunnerProfile | undefined> {
    return await this.#drizzleFirstJson<RunnerProfile>(
      schema.runnerProfiles,
      schema.runnerProfiles.recordJson,
      eq(schema.runnerProfiles.id, id),
    );
  }

  async listRunnerProfiles(): Promise<readonly RunnerProfile[]> {
    return await this.#drizzleManyJson<RunnerProfile>(
      schema.runnerProfiles,
      schema.runnerProfiles.recordJson,
      { orderBy: [asc(schema.runnerProfiles.id)] },
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
    return await this.#drizzleManyJson<SourceSyncRun>(
      schema.runs,
      schema.runs.runJson,
      {
        where: and(
          eq(schema.runs.type, RUN_KIND_SOURCE_SYNC),
          eq(schema.runs.installationId, sourceId),
        ),
        orderBy: [asc(schema.runs.createdAt), asc(schema.runs.id)],
      },
    );
  }

  // -- PlanRunInputs sidecar (internal; never projected) ----------------------

  async putPlanRunInputs(inputs: PlanRunInputs): Promise<void> {
    await this.#drizzleUpsert(
      schema.runsInputs,
      {
        planRunId: inputs.planRunId,
        inputsJson: inputs,
      },
      {
        inputsJson: inputs,
      },
      schema.runsInputs.planRunId,
    );
  }

  async getPlanRunInputs(
    planRunId: string,
  ): Promise<PlanRunInputs | undefined> {
    return await this.#drizzleFirstJson<PlanRunInputs>(
      schema.runsInputs,
      schema.runsInputs.inputsJson,
      eq(schema.runsInputs.planRunId, planRunId),
    );
  }

  async deletePlanRunInputs(planRunId: string): Promise<void> {
    await this.#drizzleDelete(
      schema.runsInputs,
      eq(schema.runsInputs.planRunId, planRunId),
    );
  }

  // -- Space ------------------------------------------------------------------

  async putSpace(space: Space): Promise<Space> {
    await this.#drizzleUpsert(schema.spaces, {
      id: space.id,
      handle: space.handle,
      recordJson: space,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    });
    return space;
  }

  async getSpace(id: string): Promise<Space | undefined> {
    return await this.#drizzleFirstJson<Space>(
      schema.spaces,
      schema.spaces.recordJson,
      eq(schema.spaces.id, id),
    );
  }

  async getSpaceByHandle(handle: string): Promise<Space | undefined> {
    return await this.#drizzleFirstJson<Space>(
      schema.spaces,
      schema.spaces.recordJson,
      eq(schema.spaces.handle, handle),
    );
  }

  async listSpaces(): Promise<readonly Space[]> {
    return await this.#drizzleManyJson<Space>(
      schema.spaces,
      schema.spaces.recordJson,
      { orderBy: [asc(schema.spaces.createdAt), asc(schema.spaces.id)] },
    );
  }

  // -- InstallConfig ----------------------------------------------------------

  async putInstallConfig(config: InstallConfig): Promise<InstallConfig> {
    await this.#drizzleUpsert(schema.installConfigs, {
      id: config.id,
      spaceId: config.spaceId ?? null,
      installType: config.installType,
      trustLevel: config.trustLevel,
      recordJson: config,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
    return config;
  }

  async getInstallConfig(id: string): Promise<InstallConfig | undefined> {
    return await this.#drizzleFirstJson<InstallConfig>(
      schema.installConfigs,
      schema.installConfigs.recordJson,
      eq(schema.installConfigs.id, id),
    );
  }

  async listInstallConfigs(
    spaceId?: string,
  ): Promise<readonly InstallConfig[]> {
    return await this.#drizzleManyJson<InstallConfig>(
      schema.installConfigs,
      schema.installConfigs.recordJson,
      {
        where:
          spaceId === undefined
            ? undefined
            : eq(schema.installConfigs.spaceId, spaceId),
        orderBy: [
          asc(schema.installConfigs.createdAt),
          asc(schema.installConfigs.id),
        ],
      },
    );
  }

  // -- Installation -----------------------------------------------------------

  async putInstallation(installation: Installation): Promise<Installation> {
    await this.#drizzleUpsert(schema.installations, {
      id: installation.id,
      spaceId: installation.spaceId,
      name: installation.name,
      slug: installation.slug,
      sourceId: installation.sourceId,
      installType: installation.installType,
      installConfigId: installation.installConfigId,
      environment: installation.environment,
      currentDeploymentId: installation.currentDeploymentId ?? null,
      currentStateGeneration: installation.currentStateGeneration,
      currentOutputSnapshotId: installation.currentOutputSnapshotId ?? null,
      status: installation.status,
      recordJson: installation,
      createdAt: installation.createdAt,
      updatedAt: installation.updatedAt,
    });
    return installation;
  }

  async getInstallation(id: string): Promise<Installation | undefined> {
    return await this.#drizzleFirstJson<Installation>(
      schema.installations,
      schema.installations.recordJson,
      eq(schema.installations.id, id),
    );
  }

  async getInstallationByName(
    spaceId: string,
    name: string,
    environment: string,
  ): Promise<Installation | undefined> {
    return await this.#drizzleFirstJson<Installation>(
      schema.installations,
      schema.installations.recordJson,
      and(
        eq(schema.installations.spaceId, spaceId),
        eq(schema.installations.name, name),
        eq(schema.installations.environment, environment),
      ),
    );
  }

  async listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    return await this.#drizzleManyJson<Installation>(
      schema.installations,
      schema.installations.recordJson,
      {
        where:
          spaceId === undefined
            ? undefined
            : eq(schema.installations.spaceId, spaceId),
        orderBy: [
          asc(schema.installations.createdAt),
          asc(schema.installations.id),
        ],
      },
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
    const result = await this.#orm
      .update(schema.installations)
      .set({
        currentDeploymentId: updated.currentDeploymentId ?? null,
        currentStateGeneration: updated.currentStateGeneration,
        currentOutputSnapshotId: updated.currentOutputSnapshotId ?? null,
        status: updated.status,
        recordJson: updated,
        updatedAt: updated.updatedAt,
      })
      .where(
        and(
          eq(schema.installations.id, id),
          guard.currentDeploymentId === undefined
            ? isNull(schema.installations.currentDeploymentId)
            : eq(
                schema.installations.currentDeploymentId,
                guard.currentDeploymentId,
              ),
          guard.status === undefined
            ? undefined
            : eq(schema.installations.status, guard.status),
        ),
      )
      .run();
    if (changes(result as D1Result) > 0) return updated;
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
    await this.#drizzleUpsert(schema.deployments, {
      id: deployment.id,
      spaceId: deployment.spaceId,
      installationId: deployment.installationId,
      environment: deployment.environment,
      applyRunId: deployment.applyRunId,
      sourceSnapshotId: deployment.sourceSnapshotId ?? null,
      dependencySnapshotId: deployment.dependencySnapshotId ?? null,
      stateGeneration: deployment.stateGeneration,
      outputSnapshotId: deployment.outputSnapshotId ?? null,
      outputsPublicJson: deployment.outputsPublic,
      status: deployment.status,
      createdAt: deployment.createdAt,
    });
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id))
      .get();
    return row ? deploymentFromDrizzleRow(row) : undefined;
  }

  async listDeployments(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, installationId))
      .orderBy(asc(schema.deployments.createdAt), asc(schema.deployments.id));
    return rows.map(deploymentFromDrizzleRow);
  }

  // -- Connection (+ sealed secret blob) --------------------------------------

  async putConnection(connection: Connection): Promise<Connection> {
    await this.#drizzleUpsert(schema.connections, {
      id: connection.id,
      spaceId: connection.spaceId,
      status: connection.status,
      recordJson: connection,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    });
    return connection;
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    return await this.#drizzleFirstJson<Connection>(
      schema.connections,
      schema.connections.recordJson,
      eq(schema.connections.id, id),
    );
  }

  async listConnections(spaceId: string): Promise<readonly Connection[]> {
    return await this.#drizzleManyJson<Connection>(
      schema.connections,
      schema.connections.recordJson,
      {
        where: eq(schema.connections.spaceId, spaceId),
        orderBy: [
          asc(schema.connections.createdAt),
          asc(schema.connections.id),
        ],
      },
    );
  }

  async deleteConnection(id: string): Promise<boolean> {
    return await this.#drizzleDelete(
      schema.connections,
      eq(schema.connections.id, id),
    );
  }

  async putSecretBlob(blob: StoredSecretBlob): Promise<StoredSecretBlob> {
    // Sealed ciphertext only; keyed by connection id and intentionally NOT on
    // any list path so the blob is never list-indexable.
    await this.#drizzleUpsert(
      schema.secretBlobs,
      {
        connectionId: blob.connectionId,
        blobJson: blob,
      },
      {
        blobJson: blob,
      },
      schema.secretBlobs.connectionId,
    );
    return blob;
  }

  async getSecretBlob(
    connectionId: string,
  ): Promise<StoredSecretBlob | undefined> {
    return await this.#drizzleFirstJson<StoredSecretBlob>(
      schema.secretBlobs,
      schema.secretBlobs.blobJson,
      eq(schema.secretBlobs.connectionId, connectionId),
    );
  }

  async deleteSecretBlob(connectionId: string): Promise<boolean> {
    return await this.#drizzleDelete(
      schema.secretBlobs,
      eq(schema.secretBlobs.connectionId, connectionId),
    );
  }

  // -- OperatorConnectionDefault ----------------------------------------------

  async putOperatorConnectionDefault(
    record: OperatorConnectionDefault,
  ): Promise<OperatorConnectionDefault> {
    // One default per capability: drop any stale row under a different id for
    // the same capability before upserting.
    await this.#ensureSchema();
    await this.#orm
      .delete(schema.operatorConnectionDefaults)
      .where(
        and(
          eq(schema.operatorConnectionDefaults.capability, record.capability),
          // Drizzle has no not-equal helper imported here; keeping this guarded
          // delete as a capability unique-index cleanup is covered by the next
          // idempotent upsert.
        ) as never,
      )
      .run()
      .catch(() => undefined);
    await this.#drizzleUpsert(schema.operatorConnectionDefaults, {
      id: record.id,
      capability: record.capability,
      provider: record.provider,
      connectionId: record.connectionId,
      recordJson: record,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  async getOperatorConnectionDefault(
    capability: Capability,
  ): Promise<OperatorConnectionDefault | undefined> {
    return await this.#drizzleFirstJson<OperatorConnectionDefault>(
      schema.operatorConnectionDefaults,
      schema.operatorConnectionDefaults.recordJson,
      eq(schema.operatorConnectionDefaults.capability, capability),
    );
  }

  async listOperatorConnectionDefaults(): Promise<
    readonly OperatorConnectionDefault[]
  > {
    return await this.#drizzleManyJson<OperatorConnectionDefault>(
      schema.operatorConnectionDefaults,
      schema.operatorConnectionDefaults.recordJson,
      { orderBy: [asc(schema.operatorConnectionDefaults.capability)] },
    );
  }

  // -- Source (+ snapshots) ---------------------------------------------------

  async putSource(source: StoredSource): Promise<StoredSource> {
    await this.#drizzleUpsert(schema.sources, {
      id: source.id,
      spaceId: source.spaceId,
      status: source.status,
      recordJson: source,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });
    return source;
  }

  async getSource(id: string): Promise<StoredSource | undefined> {
    return await this.#drizzleFirstJson<StoredSource>(
      schema.sources,
      schema.sources.recordJson,
      eq(schema.sources.id, id),
    );
  }

  async listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    return await this.#drizzleManyJson<StoredSource>(
      schema.sources,
      schema.sources.recordJson,
      {
        where:
          spaceId === undefined
            ? undefined
            : eq(schema.sources.spaceId, spaceId),
        orderBy: [asc(schema.sources.createdAt), asc(schema.sources.id)],
      },
    );
  }

  async deleteSource(id: string): Promise<boolean> {
    return await this.#drizzleDelete(schema.sources, eq(schema.sources.id, id));
  }

  async putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    await this.#drizzleUpsert(schema.sourceSnapshots, {
      id: snapshot.id,
      sourceId: snapshot.sourceId,
      recordJson: snapshot,
      fetchedAt: snapshot.fetchedAt,
    });
    return snapshot;
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined> {
    return await this.#drizzleFirstJson<SourceSnapshot>(
      schema.sourceSnapshots,
      schema.sourceSnapshots.recordJson,
      eq(schema.sourceSnapshots.id, id),
    );
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<readonly SourceSnapshot[]> {
    return await this.#drizzleManyJson<SourceSnapshot>(
      schema.sourceSnapshots,
      schema.sourceSnapshots.recordJson,
      {
        where: eq(schema.sourceSnapshots.sourceId, sourceId),
        orderBy: [
          asc(schema.sourceSnapshots.fetchedAt),
          asc(schema.sourceSnapshots.id),
        ],
      },
    );
  }

  async putCapsuleCompatibilityReport(
    report: CapsuleCompatibilityReport,
  ): Promise<CapsuleCompatibilityReport> {
    await this.#drizzleUpsert(schema.capsuleCompatibilityReports, {
      id: report.id,
      sourceSnapshotId: report.sourceSnapshotId,
      level: report.level,
      findingsJson: report.findings,
      providersJson: report.providers,
      resourcesJson: report.resources,
      dataSourcesJson: report.dataSources,
      provisionersJson: report.provisioners,
      normalizedObjectKey: report.normalizedObjectKey ?? null,
      normalizedDigest: report.normalizedDigest ?? null,
      createdAt: report.createdAt,
    });
    return report;
  }

  async getCapsuleCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReport | undefined> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.capsuleCompatibilityReports)
      .where(eq(schema.capsuleCompatibilityReports.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const snapshot = await this.getSourceSnapshot(row.sourceSnapshotId);
    return {
      id: row.id,
      ...(snapshot ? { sourceId: snapshot.sourceId } : {}),
      sourceSnapshotId: row.sourceSnapshotId,
      level: row.level as CapsuleCompatibilityReport["level"],
      findings: row.findingsJson as CapsuleCompatibilityReport["findings"],
      providers: row.providersJson as CapsuleCompatibilityReport["providers"],
      resources: row.resourcesJson as CapsuleCompatibilityReport["resources"],
      dataSources:
        row.dataSourcesJson as CapsuleCompatibilityReport["dataSources"],
      provisioners:
        row.provisionersJson as CapsuleCompatibilityReport["provisioners"],
      ...(row.normalizedObjectKey
        ? { normalizedObjectKey: row.normalizedObjectKey }
        : {}),
      ...(row.normalizedDigest
        ? { normalizedDigest: row.normalizedDigest }
        : {}),
      createdAt: row.createdAt,
    };
  }

  // -- DeploymentProfile ------------------------------------------------------

  async putDeploymentProfile(
    profile: DeploymentProfile,
  ): Promise<DeploymentProfile> {
    // One profile per (installation, environment): drop any stale row for the
    // same pair under a different id before upserting.
    await this.#ensureSchema();
    await this.#orm
      .delete(schema.deploymentProfiles)
      .where(
        and(
          eq(schema.deploymentProfiles.installationId, profile.installationId),
          eq(schema.deploymentProfiles.environment, profile.environment),
        ),
      )
      .run();
    await this.#drizzleUpsert(schema.deploymentProfiles, {
      id: profile.id,
      spaceId: profile.spaceId,
      installationId: profile.installationId,
      environment: profile.environment,
      recordJson: profile,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
    return profile;
  }

  async getDeploymentProfileByInstallation(
    installationId: string,
    environment: string,
  ): Promise<DeploymentProfile | undefined> {
    const rows = await this.#drizzleManyJson<DeploymentProfile>(
      schema.deploymentProfiles,
      schema.deploymentProfiles.recordJson,
      {
        where: and(
          eq(schema.deploymentProfiles.installationId, installationId),
          eq(schema.deploymentProfiles.environment, environment),
        ),
        orderBy: [
          desc(schema.deploymentProfiles.createdAt),
          desc(schema.deploymentProfiles.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  // -- StateSnapshot ----------------------------------------------------------

  async putStateSnapshot(snapshot: StateSnapshot): Promise<StateSnapshot> {
    await this.#drizzleUpsert(
      schema.stateSnapshots,
      {
        id: snapshot.id,
        spaceId: snapshot.spaceId,
        installationId: snapshot.installationId,
        environment: snapshot.environment,
        generation: snapshot.generation,
        objectKey: snapshot.objectKey,
        digest: snapshot.digest,
        createdByRunId: snapshot.createdByRunId,
        createdAt: snapshot.createdAt,
      },
      {
        id: snapshot.id,
        spaceId: snapshot.spaceId,
        objectKey: snapshot.objectKey,
        digest: snapshot.digest,
        createdByRunId: snapshot.createdByRunId,
        createdAt: snapshot.createdAt,
      },
      [
        schema.stateSnapshots.installationId,
        schema.stateSnapshots.environment,
        schema.stateSnapshots.generation,
      ],
    );
    return snapshot;
  }

  async getLatestStateSnapshot(
    installationId: string,
    environment: string,
  ): Promise<StateSnapshot | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select()
      .from(schema.stateSnapshots)
      .where(
        and(
          eq(schema.stateSnapshots.installationId, installationId),
          eq(schema.stateSnapshots.environment, environment),
        ),
      )
      .orderBy(desc(schema.stateSnapshots.generation))
      .limit(1)
      .get();
    return row ? stateSnapshotFromDrizzleRow(row) : undefined;
  }

  async listStateSnapshots(
    installationId: string,
    environment: string,
  ): Promise<readonly StateSnapshot[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select()
      .from(schema.stateSnapshots)
      .where(
        and(
          eq(schema.stateSnapshots.installationId, installationId),
          eq(schema.stateSnapshots.environment, environment),
        ),
      )
      .orderBy(asc(schema.stateSnapshots.generation));
    return rows.map(stateSnapshotFromDrizzleRow);
  }

  // -- Dependency DAG (§14 / §15 / §27 installation_dependencies) --------------

  async putDependency(dependency: Dependency): Promise<Dependency> {
    await this.#drizzleUpsert(schema.installationDependencies, {
      id: dependency.id,
      spaceId: dependency.spaceId,
      producerInstallationId: dependency.producerInstallationId,
      consumerInstallationId: dependency.consumerInstallationId,
      recordJson: dependency,
      createdAt: dependency.createdAt,
    });
    return dependency;
  }

  async getDependency(id: string): Promise<Dependency | undefined> {
    return await this.#drizzleFirstJson<Dependency>(
      schema.installationDependencies,
      schema.installationDependencies.recordJson,
      eq(schema.installationDependencies.id, id),
    );
  }

  async listDependenciesBySpace(
    spaceId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.installationDependencies,
      schema.installationDependencies.recordJson,
      {
        where: eq(schema.installationDependencies.spaceId, spaceId),
        orderBy: [
          asc(schema.installationDependencies.createdAt),
          asc(schema.installationDependencies.id),
        ],
      },
    );
  }

  async listDependenciesForConsumer(
    consumerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.installationDependencies,
      schema.installationDependencies.recordJson,
      {
        where: eq(
          schema.installationDependencies.consumerInstallationId,
          consumerInstallationId,
        ),
        orderBy: [
          asc(schema.installationDependencies.createdAt),
          asc(schema.installationDependencies.id),
        ],
      },
    );
  }

  async listDependenciesForProducer(
    producerInstallationId: string,
  ): Promise<readonly Dependency[]> {
    return await this.#drizzleManyJson<Dependency>(
      schema.installationDependencies,
      schema.installationDependencies.recordJson,
      {
        where: eq(
          schema.installationDependencies.producerInstallationId,
          producerInstallationId,
        ),
        orderBy: [
          asc(schema.installationDependencies.createdAt),
          asc(schema.installationDependencies.id),
        ],
      },
    );
  }

  async deleteDependency(id: string): Promise<boolean> {
    return await this.#drizzleDelete(
      schema.installationDependencies,
      eq(schema.installationDependencies.id, id),
    );
  }

  // -- DependencySnapshot (§17 / §27 dependency_snapshots) ---------------------

  async putDependencySnapshot(
    snapshot: DependencySnapshot,
  ): Promise<DependencySnapshot> {
    await this.#drizzleUpsert(schema.dependencySnapshots, {
      id: snapshot.id,
      runId: snapshot.runId,
      recordJson: snapshot,
      createdAt: snapshot.createdAt,
    });
    return snapshot;
  }

  async getDependencySnapshot(
    id: string,
  ): Promise<DependencySnapshot | undefined> {
    return await this.#drizzleFirstJson<DependencySnapshot>(
      schema.dependencySnapshots,
      schema.dependencySnapshots.recordJson,
      eq(schema.dependencySnapshots.id, id),
    );
  }

  // -- OutputSnapshot (§16 / §27 output_snapshots) -----------------------------

  async putOutputSnapshot(snapshot: OutputSnapshot): Promise<OutputSnapshot> {
    await this.#drizzleUpsert(schema.outputSnapshots, {
      id: snapshot.id,
      spaceId: snapshot.spaceId,
      installationId: snapshot.installationId,
      stateGeneration: snapshot.stateGeneration,
      recordJson: snapshot,
      createdAt: snapshot.createdAt,
    });
    return snapshot;
  }

  async getOutputSnapshot(id: string): Promise<OutputSnapshot | undefined> {
    return await this.#drizzleFirstJson<OutputSnapshot>(
      schema.outputSnapshots,
      schema.outputSnapshots.recordJson,
      eq(schema.outputSnapshots.id, id),
    );
  }

  async getLatestOutputSnapshot(
    installationId: string,
  ): Promise<OutputSnapshot | undefined> {
    const rows = await this.#drizzleManyJson<OutputSnapshot>(
      schema.outputSnapshots,
      schema.outputSnapshots.recordJson,
      {
        where: eq(schema.outputSnapshots.installationId, installationId),
        orderBy: [
          desc(schema.outputSnapshots.stateGeneration),
          desc(schema.outputSnapshots.createdAt),
          desc(schema.outputSnapshots.id),
        ],
        limit: 1,
      },
    );
    return rows[0];
  }

  // -- OutputShare (§18 / §27 output_shares) -----------------------------------

  async putOutputShare(share: OutputShare): Promise<OutputShare> {
    await this.#drizzleUpsert(schema.outputShares, {
      id: share.id,
      fromSpaceId: share.fromSpaceId,
      toSpaceId: share.toSpaceId,
      producerInstallationId: share.producerInstallationId,
      status: share.status,
      recordJson: share,
      createdAt: share.createdAt,
    });
    return share;
  }

  async getOutputShare(id: string): Promise<OutputShare | undefined> {
    return await this.#drizzleFirstJson<OutputShare>(
      schema.outputShares,
      schema.outputShares.recordJson,
      eq(schema.outputShares.id, id),
    );
  }

  async listOutputSharesFromSpace(
    fromSpaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#drizzleManyJson<OutputShare>(
      schema.outputShares,
      schema.outputShares.recordJson,
      {
        where: eq(schema.outputShares.fromSpaceId, fromSpaceId),
        orderBy: [
          asc(schema.outputShares.createdAt),
          asc(schema.outputShares.id),
        ],
      },
    );
  }

  async listOutputSharesToSpace(
    toSpaceId: string,
  ): Promise<readonly OutputShare[]> {
    return await this.#drizzleManyJson<OutputShare>(
      schema.outputShares,
      schema.outputShares.recordJson,
      {
        where: eq(schema.outputShares.toSpaceId, toSpaceId),
        orderBy: [
          asc(schema.outputShares.createdAt),
          asc(schema.outputShares.id),
        ],
      },
    );
  }

  // -- RunGroup (§19 / §24 / §27 run_groups) -----------------------------------

  async putRunGroup(group: RunGroup): Promise<RunGroup> {
    await this.#drizzleUpsert(schema.runGroups, {
      id: group.id,
      spaceId: group.spaceId,
      type: group.type,
      recordJson: group,
      createdAt: group.createdAt,
    });
    return group;
  }

  async getRunGroup(id: string): Promise<RunGroup | undefined> {
    return await this.#drizzleFirstJson<RunGroup>(
      schema.runGroups,
      schema.runGroups.recordJson,
      eq(schema.runGroups.id, id),
    );
  }

  async listRunGroups(spaceId: string): Promise<readonly RunGroup[]> {
    return await this.#drizzleManyJson<RunGroup>(
      schema.runGroups,
      schema.runGroups.recordJson,
      {
        where: eq(schema.runGroups.spaceId, spaceId),
        orderBy: [asc(schema.runGroups.createdAt), asc(schema.runGroups.id)],
      },
    );
  }

  // -- Activity audit_events (§27 audit_events / §34 Activity) ------------------
  //
  // The §27 audit_events table keeps searchable columns (space_id / created_at)
  // for the Space-scoped Activity list; the full non-secret event round trips
  // through record_json. Listing is newest-first with a clamped limit.

  async putActivityEvent(event: ActivityEvent): Promise<ActivityEvent> {
    await this.#drizzleUpsert(schema.auditEvents, {
      id: event.id,
      spaceId: event.spaceId,
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      runId: event.runId ?? null,
      recordJson: event,
      createdAt: event.createdAt,
    });
    return event;
  }

  async listActivityEvents(
    spaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ActivityEvent[]> {
    const limit = clampActivityLimit(options.limit);
    return await this.#drizzleManyJson<ActivityEvent>(
      schema.auditEvents,
      schema.auditEvents.recordJson,
      {
        where: eq(schema.auditEvents.spaceId, spaceId),
        orderBy: [
          desc(schema.auditEvents.createdAt),
          desc(schema.auditEvents.id),
        ],
        limit,
      },
    );
  }

  // -- credential_mint_events (spec invariant 17) -----------------------------

  async putCredentialMintEvent(
    event: CredentialMintEvent,
  ): Promise<CredentialMintEvent> {
    await this.#drizzleUpsert(schema.credentialMintEvents, {
      id: event.id,
      runId: event.runId,
      spaceId: event.spaceId,
      installationId: event.installationId,
      connectionId: event.connectionId,
      phase: event.phase,
      recordJson: event,
      createdAt: event.createdAt,
    });
    return event;
  }

  async listCredentialMintEventsForRun(
    runId: string,
  ): Promise<readonly CredentialMintEvent[]> {
    return await this.#drizzleManyJson<CredentialMintEvent>(
      schema.credentialMintEvents,
      schema.credentialMintEvents.recordJson,
      {
        where: eq(schema.credentialMintEvents.runId, runId),
        orderBy: [
          asc(schema.credentialMintEvents.createdAt),
          asc(schema.credentialMintEvents.id),
        ],
      },
    );
  }

  // -- backups (§33 layer 1 / §26 R2_BACKUPS) ----------------------------------
  //
  // One pointer row per sealed control-backup bundle written to R2_BACKUPS. The
  // bundle bytes live in object storage; only the pointer round trips through
  // record_json. Listing is newest-first (created_at desc, id desc).

  async putBackupRecord(record: BackupRecord): Promise<BackupRecord> {
    await this.#drizzleUpsert(schema.backups, {
      id: record.id,
      spaceId: record.spaceId,
      recordJson: record,
      createdAt: record.createdAt,
    });
    return record;
  }

  async listBackupRecords(spaceId: string): Promise<readonly BackupRecord[]> {
    return await this.#drizzleManyJson<BackupRecord>(
      schema.backups,
      schema.backups.recordJson,
      {
        where: eq(schema.backups.spaceId, spaceId),
        orderBy: [desc(schema.backups.createdAt), desc(schema.backups.id)],
      },
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
    const createdAt = JSON.parse(row.runJson).createdAt ?? 0;
    await this.#drizzleUpsert(schema.runs, {
      id: row.id,
      runGroupId: row.runGroupId,
      spaceId: row.spaceId,
      installationId: row.installationId,
      environment: row.environment,
      type: row.type,
      status: row.status,
      runJson: JSON.parse(row.runJson) as unknown,
      createdAt: String(createdAt),
    });
  }

  async #drizzleUpsert(
    table: any,
    values: Record<string, unknown>,
    set: Record<string, unknown> = values,
    target = table.id,
  ): Promise<void> {
    await this.#ensureSchema();
    await this.#orm
      .insert(table)
      .values(values)
      .onConflictDoUpdate({ target, set })
      .run();
  }

  async #drizzleDelete(table: any, where: unknown): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.#orm
      .delete(table)
      .where(where as never)
      .run();
    return changes(result as D1Result) > 0;
  }

  async #drizzleFirstJson<T>(
    table: any,
    jsonColumn: any,
    where: unknown,
  ): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select({ value: jsonColumn })
      .from(table)
      .where(where as never)
      .get();
    return row?.value as T | undefined;
  }

  async #drizzleManyJson<T>(
    table: any,
    jsonColumn: any,
    input: {
      readonly where?: unknown;
      readonly orderBy?: readonly unknown[];
      readonly limit?: number;
    } = {},
  ): Promise<readonly T[]> {
    await this.#ensureSchema();
    let query = this.#orm.select({ value: jsonColumn }).from(table).$dynamic();
    if (input.where !== undefined) {
      query = query.where(input.where as never);
    }
    if (input.orderBy !== undefined) {
      query = query.orderBy(...(input.orderBy as never[]));
    }
    if (input.limit !== undefined) {
      query = query.limit(input.limit);
    }
    const rows = await query;
    return rows.map((row) => row.value as T);
  }

  async #getRun<T>(
    id: string,
    types: readonly string[],
  ): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select({ runJson: schema.runs.runJson })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, id), inArray(schema.runs.type, [...types])))
      .get();
    return row?.runJson as T | undefined;
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
// in §27 columns (no record_json), so Drizzle rows are reconstructed field-by-field.

function deploymentFromDrizzleRow(row: {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly applyRunId: string;
  readonly sourceSnapshotId: string | null;
  readonly dependencySnapshotId: string | null;
  readonly stateGeneration: number;
  readonly outputSnapshotId: string | null;
  readonly outputsPublicJson: unknown;
  readonly status: string;
  readonly createdAt: string;
}): Deployment {
  return {
    id: row.id,
    spaceId: row.spaceId,
    installationId: row.installationId,
    environment: row.environment,
    applyRunId: row.applyRunId,
    ...(row.sourceSnapshotId !== null
      ? { sourceSnapshotId: row.sourceSnapshotId }
      : {}),
    ...(row.dependencySnapshotId !== null
      ? { dependencySnapshotId: row.dependencySnapshotId }
      : {}),
    stateGeneration: row.stateGeneration,
    ...(row.outputSnapshotId !== null
      ? { outputSnapshotId: row.outputSnapshotId }
      : {}),
    outputsPublic: row.outputsPublicJson as Record<string, unknown>,
    status: row.status as Deployment["status"],
    createdAt: row.createdAt,
  };
}

function stateSnapshotFromDrizzleRow(row: {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly generation: number;
  readonly objectKey: string;
  readonly digest: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
}): StateSnapshot {
  return {
    id: row.id,
    spaceId: row.spaceId,
    installationId: row.installationId,
    environment: row.environment,
    generation: row.generation,
    objectKey: row.objectKey,
    digest: row.digest,
    createdByRunId: row.createdByRunId,
    createdAt: row.createdAt,
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
    `create table if not exists capsule_compatibility_reports (
      id text primary key,
      source_snapshot_id text not null,
      level text not null,
      findings_json text not null,
      providers_json text not null,
      resources_json text not null,
      data_sources_json text not null,
      provisioners_json text not null,
      normalized_object_key text,
      normalized_digest text,
      created_at text not null
    )`,
    `create index if not exists capsule_compatibility_reports_source_snapshot_idx
      on capsule_compatibility_reports (source_snapshot_id)`,
    `create index if not exists capsule_compatibility_reports_level_idx
      on capsule_compatibility_reports (level)`,
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
    `create table if not exists output_shares (
      id text primary key,
      from_space_id text not null,
      to_space_id text not null,
      producer_installation_id text not null,
      status text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists output_shares_from_space_idx
      on output_shares (from_space_id, created_at)`,
    `create index if not exists output_shares_to_space_idx
      on output_shares (to_space_id, created_at)`,
    `create index if not exists output_shares_producer_idx
      on output_shares (producer_installation_id)`,
    `create table if not exists run_groups (
      id text primary key,
      space_id text not null,
      type text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists run_groups_space_idx
      on run_groups (space_id, created_at)`,
    `create table if not exists audit_events (
      id text primary key,
      space_id text not null,
      actor_id text,
      action text not null,
      target_type text not null,
      target_id text not null,
      run_id text,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists audit_events_space_idx
      on audit_events (space_id, created_at)`,
    `create table if not exists credential_mint_events (
      id text primary key,
      run_id text not null,
      space_id text not null,
      installation_id text not null,
      connection_id text not null,
      phase text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists credential_mint_events_run_idx
      on credential_mint_events (run_id)`,
    `create index if not exists credential_mint_events_space_idx
      on credential_mint_events (space_id)`,
    `create table if not exists backups (
      id text primary key,
      space_id text not null,
      record_json text not null,
      created_at text not null
    )`,
    `create index if not exists backups_space_idx
      on backups (space_id, created_at)`,
  ];
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}
