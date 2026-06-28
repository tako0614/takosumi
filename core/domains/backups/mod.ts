/**
 * Control-backup domain service (Core Specification §33 layer 1 "Control
 * backup" + §26 R2_BACKUPS object layout).
 *
 * Produces a sealed bundle that captures a Space's CONTROL ledger — the
 * information Takosumi manages about a Space — so an operator can export /
 * archive / migrate it. The bundle is the JSON of the Space's ledger rows,
 * compressed, then sealed with the same at-rest secret-boundary crypto the
 * state / secret lanes use, and written to R2_BACKUPS under the §26 key
 * `spaces/{spaceId}/backups/{backupId}/control.json.zst.enc`. A {@link
 * BackupRecord} ledger pointer (objectKey / digest / sizeBytes) is recorded and
 * a Space Activity event is emitted.
 *
 * SECURITY (spec §9 / §16, invariants 11/12): the bundle NEVER contains secret
 * material. Specifically it strips / omits:
 *   - Source `hookSecretHash` / `lastSeenCommit` / `autoSync` (internal fields);
 *   - Connection sealed blobs (only the PUBLIC Connection record is included —
 *     names / provider / scope / envNames, never values);
 *   - raw state bytes (only StateSnapshot METADATA — objectKey / digest / generation);
 *   - raw output VALUES (only the projected `publicOutputs` / `spaceOutputs` +
 *     the raw artifact KEY are included — the encrypted raw envelope is not copied).
 *
 * Spec §33 layer 2 ("service data backup": messages / files / posts / …)
 * records a sealed manifest of service-owned backup pointers. Takosumi does
 * not fetch provider data, run arbitrary commands, or copy raw service bytes in
 * the control backup path. `provider_snapshot` and `custom_command` may be
 * delegated to an injected isolated backup runner; otherwise the control path
 * captures the pointer the Installation already projected at
 * `BackupConfig.outputPath`.
 *
 * Backup sidecars use the canonical R2_BACKUPS names from the spec:
 * `state.tar.zst.enc`, `artifacts.manifest.json`, and
 * `service-data.tar.zst.enc`.
 */

import {
  ARTIFACTS_MANIFEST_OBJECT_KEY,
  type BackupArtifactPointer,
  type BackupRecord,
  type BackupRestoreTarget,
  CONTROL_BACKUP_CONTENT_TYPE,
  CONTROL_BACKUP_OBJECT_KEY,
  type ListBackupsResponse,
  SERVICE_DATA_BACKUP_OBJECT_KEY,
  STATE_BACKUP_OBJECT_KEY,
} from "takosumi-contract/backups";
import type { PageParams } from "takosumi-contract/pagination";
import type {
  Connection,
  InstallConfig,
  Installation,
} from "@takosumi/internal/deploy-control-api";
import type { Output as OutputSnapshot } from "takosumi-contract/outputs";
import type { Run } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type {
  OpenTofuDeploymentStore,
  StoredSource,
} from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";

/**
 * Narrow injected seam for sealing + persisting a control-backup bundle. The
 * host worker supplies an implementation backed by R2_BACKUPS + the at-rest
 * secret-boundary crypto (see {@link InMemoryBackupArtifactStore} for the
 * local/dev fallback). The service hands it the PLAINTEXT payload bytes; the store
 * seals them and writes the sealed object to its backing bucket.
 */
export interface BackupArtifactStore {
  /**
   * Seals `payload` (already encoded/compressed where applicable) and writes the sealed
   * object to backup storage at `objectKey`. Returns the digest over the SEALED
   * bytes and their length, which become the {@link BackupRecord} pointer.
   */
  put(input: {
    readonly objectKey: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }>;
  /**
   * Writes a non-secret public backup sidecar, such as
   * `artifacts.manifest.json`. Stores that cannot expose plain objects may omit
   * this; the service then falls back to `put`.
   */
  putPlain?(input: {
    readonly objectKey: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }>;
}

export interface BackupObjectReader {
  get(objectKey: string): Promise<Uint8Array | undefined>;
}

export interface ServiceDataBackupRunner {
  run(
    input: ServiceDataBackupRunnerInput,
  ): Promise<ServiceDataBackupRunnerResult>;
}

export interface ServiceDataBackupRunnerInput {
  readonly spaceId: string;
  readonly capturedAt: string;
  readonly installation: Installation;
  readonly installConfig: InstallConfig;
  readonly sourceSnapshot?: SourceSnapshot;
  readonly mode: "provider_snapshot" | "custom_command";
  readonly outputPath: string;
  readonly provider?: string;
  readonly command?: readonly string[];
}

export type ServiceDataBackupRunnerResult =
  | {
      readonly status: "exported";
      readonly runId: string;
      readonly artifact: ServiceDataArtifactPointer;
    }
  | {
      readonly status: "missing" | "unsupported";
      readonly runId?: string;
      readonly reason: string;
    };

export interface CreateBackupRequest {
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  /** Optional run id that triggered the backup (operator / scheduled flows). */
  readonly createdByRunId?: string;
  /** Optional Capsule context for Capsule-scoped backup Runs. */
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly environment?: string;
}

export interface BackupsServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  /**
   * The seal + object-storage seam. When omitted the service is DISABLED and
   * `createBackup` throws `not_implemented` (a host that did not wire
   * R2_BACKUPS + crypto must not silently drop backups).
   */
  readonly artifactStore?: BackupArtifactStore;
  /**
   * Reader for immutable R2_STATE objects. Required when exporting a backup that
   * includes StateSnapshot rows, because `state.tar.zst.enc` contains the sealed
   * state objects, not only their ledger metadata.
   */
  readonly stateObjectReader?: BackupObjectReader;
  /**
   * Isolated execution seam for service-data producer work. Hosts wire this to
   * a backup Run / Runner Container flow for `provider_snapshot` and
   * `custom_command`. The control-backup path only consumes the returned
   * pointer/evidence.
   */
  readonly serviceDataRunner?: ServiceDataBackupRunner;
  readonly activity?: ActivityRecorder;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
  /** Activity (latest N) cap included in the bundle (spec binding: 500). */
  readonly activityLimit?: number;
}

/** The default Activity tail captured in a control bundle (newest N). */
export const CONTROL_BACKUP_ACTIVITY_LIMIT = 500;

export class BackupsService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #artifactStore: BackupArtifactStore | undefined;
  readonly #stateObjectReader: BackupObjectReader | undefined;
  readonly #serviceDataRunner: ServiceDataBackupRunner | undefined;
  readonly #activity: ActivityRecorder;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  readonly #activityLimit: number;

  constructor(deps: BackupsServiceDependencies) {
    this.#store = deps.store;
    this.#artifactStore = deps.artifactStore;
    this.#stateObjectReader = deps.stateObjectReader;
    this.#serviceDataRunner = deps.serviceDataRunner;
    this.#activity = deps.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
    this.#activityLimit = deps.activityLimit ?? CONTROL_BACKUP_ACTIVITY_LIMIT;
  }

  /** Whether a usable artifact store is wired (drives the route 501 vs 201). */
  get enabled(): boolean {
    return this.#artifactStore !== undefined;
  }

  /**
   * Creates one control backup for a Space: gathers the ledger, strips secret
   * material, zstd-compresses + seals + writes the bundle to backup storage,
   * records the pointer, and emits a Space Activity event. Returns the
   * {@link BackupRecord}.
   */
  async createBackup(rawRequest: CreateBackupRequest): Promise<BackupRecord> {
    // Accept both the new Workspace/Capsule field names and the transient
    // deprecated Space/Installation names until the rename converges.
    const workspaceId = (rawRequest.workspaceId ?? rawRequest.spaceId ?? "")
      .trim();
    const capsuleId = rawRequest.capsuleId ?? rawRequest.installationId;
    const request: CreateBackupRequest = {
      ...rawRequest,
      workspaceId,
      spaceId: workspaceId,
      ...(capsuleId ? { capsuleId, installationId: capsuleId } : {}),
    };
    const spaceId = workspaceId;
    if (spaceId.length === 0) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "spaceId is required",
      );
    }
    if (!this.#artifactStore) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "control backups are not wired (R2_BACKUPS object storage + crypto unavailable)",
      );
    }
    const space = await this.#store.getSpace(spaceId);
    if (!space) {
      throw new OpenTofuControllerError(
        "not_found",
        `space ${spaceId} not found`,
      );
    }

    const createdAt = this.#now().toISOString();
    const backupId = this.#newId("bkp");
    const runId = request.createdByRunId ?? this.#newId("backup");
    if (!request.createdByRunId) {
      await this.#putBackupRun({
        request,
        runId,
        spaceId,
        status: "running",
        createdAt,
        startedAt: createdAt,
      });
    }

    try {
      const bundle = await this.#collectControlBundle(spaceId, createdAt);
      const payload = zstdCompressRaw(jsonBytes(bundle));
      const objectKey = CONTROL_BACKUP_OBJECT_KEY(spaceId, backupId);
      const { digest, sizeBytes } = await this.#artifactStore.put({
        objectKey,
        payload,
        contentType: CONTROL_BACKUP_CONTENT_TYPE,
      });
      const stateArchive = await this.#writeStateArchive({
        backupId,
        spaceId,
        stateSnapshots: bundle.stateSnapshots,
      });
      const serviceData = await this.#writeServiceDataArchive({
        backupId,
        spaceId,
        capturedAt: createdAt,
      });
      const artifactsManifest = await this.#writeArtifactsManifest({
        backupId,
        spaceId,
        control: { objectKey, digest, sizeBytes },
        ...(stateArchive ? { stateArchive } : {}),
        ...(serviceData ? { serviceData } : {}),
      });

      const record: BackupRecord = {
        id: backupId,
        workspaceId: spaceId,
        spaceId,
        ...(request.installationId
          ? { installationId: request.installationId }
          : {}),
        ...(request.environment ? { environment: request.environment } : {}),
        ...restoreTargetFromBundle(bundle.stateSnapshots, request),
        objectKey,
        digest,
        sizeBytes,
        ...(stateArchive ? { stateArchive } : {}),
        ...(artifactsManifest ? { artifactsManifest } : {}),
        ...(serviceData ? { serviceData } : {}),
        createdByRunId: runId,
        createdAt,
      };
      await this.#store.putBackupRecord(record);

      if (!request.createdByRunId) {
        await this.#putBackupRun({
          request,
          runId,
          spaceId,
          status: "succeeded",
          createdAt,
          startedAt: createdAt,
          finishedAt: this.#now().toISOString(),
        });
      }

      // Activity (§27 / §34): a control backup was created. Pointer metadata only
      // (ids / digest / size) — never bundle contents.
      await this.#activity.record({
        workspaceId: spaceId,
        spaceId,
        action: "backup.created",
        targetType: "backup",
        targetId: backupId,
        metadata: {
          objectKey,
          digest,
          sizeBytes,
          ...(stateArchive ? { stateArchive } : {}),
          ...(artifactsManifest ? { artifactsManifest } : {}),
          ...(serviceData ? { serviceData } : {}),
          runId,
        },
      });

      return record;
    } catch (error) {
      if (!request.createdByRunId) {
        await this.#putBackupRun({
          request,
          runId,
          spaceId,
          status: "failed",
          errorCode: "backup_failed",
          createdAt,
          startedAt: createdAt,
          finishedAt: this.#now().toISOString(),
        });
      }
      throw error;
    }
  }

  async #putBackupRun(input: {
    readonly request: CreateBackupRequest;
    readonly runId: string;
    readonly spaceId: string;
    readonly status: Run["status"];
    readonly errorCode?: string;
    readonly createdAt: string;
    readonly startedAt?: string;
    readonly finishedAt?: string;
  }): Promise<void> {
    await this.#store.putBackupRun({
      id: input.runId,
      workspaceId: input.spaceId,
      spaceId: input.spaceId,
      ...(input.request.installationId
        ? { installationId: input.request.installationId }
        : {}),
      ...(input.request.environment
        ? { environment: input.request.environment }
        : {}),
      type: "backup",
      status: input.status,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      createdBy: "system",
      createdAt: input.createdAt,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    });
  }

  /** Lists a Space's control backups, newest first (keyset-paged, spec §30). */
  async listBackups(
    spaceId: string,
    params?: PageParams,
  ): Promise<ListBackupsResponse> {
    const id = spaceId.trim();
    if (id.length === 0) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "spaceId is required",
      );
    }
    const { items, nextCursor } = await this.#store.listBackupRecordsPage(
      id,
      params ?? {},
    );
    return {
      backups: items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  /**
   * Reads the public-safe control-ledger projection for the Space and assembles
   * the bundle, stripping internal fields + secret material. Object bytes stay
   * in R2/state/artifact stores; this bundle carries ledger rows and pointers.
   */
  async #collectControlBundle(
    spaceId: string,
    capturedAt: string,
  ): Promise<ControlBackupBundle> {
    const space = await this.#store.getSpace(spaceId);
    const sources = await this.#store.listSources(spaceId);
    const installConfigs = await this.#store.listInstallConfigs(spaceId);
    const installations = await this.#store.listInstallations(spaceId);
    const dependencies = await this.#store.listDependenciesBySpace(spaceId);
    const connections = await this.#store.listConnections(spaceId);
    const outputSharesGranted =
      await this.#store.listOutputSharesFromSpace(spaceId);
    const outputSharesReceived =
      await this.#store.listOutputSharesToSpace(spaceId);
    const runGroups = await this.#store.listRunGroups(spaceId);
    const activity = await this.#store.listActivityEvents(spaceId, {
      limit: this.#activityLimit,
    });
    const securityFindings = await this.#store.listSecurityFindings(spaceId, {
      limit: this.#activityLimit,
    });
    const billingAccount =
      space &&
      typeof (space as { billingAccountId?: unknown }).billingAccountId ===
        "string"
        ? await this.#store.getBillingAccount(
            (space as { billingAccountId: string }).billingAccountId,
          )
        : undefined;
    const spaceSubscription = await this.#store.getSpaceSubscription(spaceId);
    const creditBalance = await this.#store.getCreditBalance(spaceId);
    const creditReservations =
      await this.#store.listCreditReservations(spaceId);
    const autoRechargeAttempts =
      await this.#store.listBillingAutoRechargeAttempts(spaceId);
    const usageEvents = await this.#store.listUsageEvents(spaceId);
    const backupRecords = await this.#store.listBackupRecords(spaceId);

    // Per-installation fan-out: source snapshots (by source), deployments,
    // state-snapshot metadata, and output-snapshot projections.
    //
    // Read efficiency (Core Spec §33): rather than one store round-trip per
    // Source / Installation, fetch each resource for the whole Space (or the
    // already-loaded Source id batch) in a single query, group the result by the
    // id the loop keys on, then iterate the SAME `sources` / `installations`
    // loops over the in-memory groups. The produced bundle is byte-identical:
    // groups are sorted exactly as the per-item store methods sorted, and the
    // outer loop order is unchanged.
    const sourceSnapshotsBySource = groupBy(
      await this.#store.listSourceSnapshotsBySourceIds(
        sources.map((source) => source.id),
      ),
      (snapshot) => snapshot.sourceId,
    );
    const sourceSnapshots: BundleSourceSnapshot[] = [];
    for (const source of sources) {
      const group = (sourceSnapshotsBySource.get(source.id) ?? [])
        .slice()
        .sort(
          (a, b) =>
            a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id),
        );
      for (const snapshot of group) {
        sourceSnapshots.push({
          id: snapshot.id,
          origin: snapshot.origin,
          spaceId: snapshot.spaceId,
          ...(snapshot.sourceId ? { sourceId: snapshot.sourceId } : {}),
          url: snapshot.url,
          ref: snapshot.ref,
          resolvedCommit: snapshot.resolvedCommit,
          path: snapshot.path,
          archiveObjectKey: snapshot.archiveObjectKey,
          archiveDigest: snapshot.archiveDigest,
          archiveSizeBytes: snapshot.archiveSizeBytes,
          fetchedByRunId: snapshot.fetchedByRunId,
          fetchedAt: snapshot.fetchedAt,
        });
      }
    }

    const deploymentsByInstallation = groupBy(
      await this.#store.listDeploymentsBySpace(spaceId),
      (deployment) => deployment.installationId,
    );
    const stateSnapshotsByInstallation = groupBy(
      await this.#store.listStateSnapshotsBySpace(spaceId),
      (snapshot) => snapshot.installationId,
    );
    const outputSnapshotsByInstallation = groupBy(
      await this.#store.listOutputSnapshotsBySpace(spaceId),
      (snapshot) => snapshot.installationId,
    );

    const deployments: unknown[] = [];
    const providerEnvBindingSets: unknown[] = [];
    const stateSnapshots: BundleStateSnapshot[] = [];
    const outputSnapshots: BundleOutputSnapshot[] = [];
    for (const installation of installations) {
      const profile =
        await this.#store.getInstallationProviderEnvBindingSetByInstallation(
          installation.id,
          installation.environment,
        );
      if (profile) {
        providerEnvBindingSets.push(profile);
      }
      const installationDeployments = (
        deploymentsByInstallation.get(installation.id) ?? []
      )
        .slice()
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
      for (const deployment of installationDeployments) {
        deployments.push(deployment);
      }
      const installationStateSnapshots = (
        stateSnapshotsByInstallation.get(installation.id) ?? []
      )
        .filter((snapshot) => snapshot.environment === installation.environment)
        .sort((a, b) => a.generation - b.generation);
      for (const snapshot of installationStateSnapshots) {
        // METADATA only — the encrypted state bytes are NOT copied (objectKey is
        // the pointer to the R2_STATE object).
        stateSnapshots.push({
          id: snapshot.id,
          spaceId: (snapshot.workspaceId ?? snapshot.spaceId),
          installationId: (snapshot.capsuleId ?? snapshot.installationId),
          environment: snapshot.environment,
          generation: snapshot.generation,
          objectKey: snapshot.objectKey,
          digest: snapshot.digest,
          createdByRunId: snapshot.createdByRunId,
          createdAt: snapshot.createdAt,
        });
      }
      const installationOutputSnapshots = (
        outputSnapshotsByInstallation.get(installation.id) ?? []
      )
        .slice()
        .sort(
          (a, b) =>
            a.stateGeneration - b.stateGeneration ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      for (const output of installationOutputSnapshots) {
        // publicOutputs + spaceOutputs PROJECTIONS only — raw output VALUES are
        // never copied; the raw artifact KEY is listed but the bytes are not.
        outputSnapshots.push({
          id: output.id,
          spaceId: output.spaceId,
          installationId: output.installationId,
          stateGeneration: output.stateGeneration,
          rawOutputArtifactKey: output.rawOutputArtifactKey,
          publicOutputs: output.publicOutputs,
          spaceOutputs: output.spaceOutputs,
          outputDigest: output.outputDigest,
          createdAt: output.createdAt,
        });
      }
    }

    return {
      bundleVersion: 1,
      kind: "control",
      spaceId,
      capturedAt,
      space: space ?? null,
      sources: sources.map(stripSource),
      sourceSnapshots,
      installConfigs: [...installConfigs],
      installations: [...installations],
      providerEnvBindingSets,
      dependencies: [...dependencies],
      outputSharesGranted: [...outputSharesGranted],
      outputSharesReceived: [...outputSharesReceived],
      deployments,
      stateSnapshots,
      outputSnapshots,
      runGroups: [...runGroups],
      activity: [...activity],
      connections: connections.map(publicConnection),
      securityFindings: [...securityFindings],
      billing: {
        account: billingAccount ?? null,
        subscription: spaceSubscription ?? null,
        creditBalance: creditBalance ?? null,
        creditReservations: [...creditReservations],
        autoRechargeAttempts: [...autoRechargeAttempts],
        usageEvents: [...usageEvents],
      },
      backupRecords: [...backupRecords],
    };
  }

  async #writeStateArchive(input: {
    readonly backupId: string;
    readonly spaceId: string;
    readonly stateSnapshots: readonly BundleStateSnapshot[];
  }): Promise<BackupArtifactPointer | undefined> {
    if (!this.#artifactStore || input.stateSnapshots.length === 0) {
      return undefined;
    }
    if (!this.#stateObjectReader) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "state backup export requires an R2_STATE object reader",
      );
    }
    const entries: TarEntry[] = [
      {
        name: "state.json",
        body: jsonBytes({
          bundleVersion: 1,
          kind: "state-backup-archive",
          spaceId: input.spaceId,
          stateSnapshots: input.stateSnapshots,
        }),
      },
    ];
    for (const snapshot of input.stateSnapshots) {
      const bytes = await this.#stateObjectReader.get(snapshot.objectKey);
      if (!bytes) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `state snapshot object ${snapshot.objectKey} is missing`,
        );
      }
      entries.push({
        name: `states/${snapshot.installationId}/${snapshot.environment}/${formatStateGeneration(snapshot.generation)}.tfstate.enc`,
        body: bytes,
      });
    }
    const objectKey = STATE_BACKUP_OBJECT_KEY(input.spaceId, input.backupId);
    const payload = zstdCompressRaw(tarArchive(entries));
    const { digest, sizeBytes } = await this.#artifactStore.put({
      objectKey,
      payload,
      contentType: CONTROL_BACKUP_CONTENT_TYPE,
    });
    return { objectKey, digest, sizeBytes };
  }

  async #writeArtifactsManifest(input: {
    readonly backupId: string;
    readonly spaceId: string;
    readonly control: BackupArtifactPointer;
    readonly stateArchive?: BackupArtifactPointer;
    readonly serviceData?: BackupArtifactPointer;
  }): Promise<BackupArtifactPointer | undefined> {
    if (!this.#artifactStore) return undefined;
    const objectKey = ARTIFACTS_MANIFEST_OBJECT_KEY(
      input.spaceId,
      input.backupId,
    );
    const artifacts = [
      { kind: "control", ...input.control },
      ...(input.stateArchive ? [{ kind: "state", ...input.stateArchive }] : []),
      ...(input.serviceData
        ? [{ kind: "service_data", ...input.serviceData }]
        : []),
    ];
    const payload = new TextEncoder().encode(
      JSON.stringify(
        {
          bundleVersion: 1,
          kind: "backup-artifacts-manifest",
          spaceId: input.spaceId,
          backupId: input.backupId,
          artifacts,
        },
        null,
        2,
      ) + "\n",
    );
    const writer = this.#artifactStore.putPlain ?? this.#artifactStore.put;
    const { digest, sizeBytes } = await writer.call(this.#artifactStore, {
      objectKey,
      payload,
      contentType: "application/json",
    });
    return { objectKey, digest, sizeBytes };
  }

  async #writeServiceDataArchive(input: {
    readonly backupId: string;
    readonly spaceId: string;
    readonly capturedAt: string;
  }): Promise<BackupRecord["serviceData"] | undefined> {
    if (!this.#artifactStore) return undefined;
    const manifest = await this.#collectServiceDataManifest(
      input.spaceId,
      input.capturedAt,
    );
    if (manifest.entries.length === 0) return undefined;

    const objectKey = SERVICE_DATA_BACKUP_OBJECT_KEY(
      input.spaceId,
      input.backupId,
    );
    const payload = zstdCompressRaw(
      tarArchive([
        {
          name: "service-data.json",
          body: jsonBytes(manifest),
        },
      ]),
    );
    const { digest, sizeBytes } = await this.#artifactStore.put({
      objectKey,
      payload,
      contentType: CONTROL_BACKUP_CONTENT_TYPE,
    });
    return {
      objectKey,
      digest,
      sizeBytes,
      exportedCount: manifest.entries.filter((e) => e.status === "exported")
        .length,
      unsupportedCount: manifest.entries.filter(
        (e) => e.status === "unsupported",
      ).length,
      missingCount: manifest.entries.filter((e) => e.status === "missing")
        .length,
    };
  }

  async #collectServiceDataManifest(
    spaceId: string,
    capturedAt: string,
  ): Promise<ServiceDataBackupManifest> {
    const installConfigs = new Map(
      (await this.#store.listInstallConfigs(spaceId)).map((config) => [
        config.id,
        config,
      ]),
    );
    for (const config of await this.#store.listInstallConfigs()) {
      if (!installConfigs.has(config.id)) {
        installConfigs.set(config.id, config);
      }
    }

    const entries: ServiceDataBackupEntry[] = [];
    for (const installation of await this.#store.listInstallations(spaceId)) {
      const config = installConfigs.get(installation.installConfigId);
      if (!config) continue;
      const backup = config.backup;
      if (!backup?.enabled || backup.mode === "none") continue;

      if (backup.mode === "custom_command") {
        const command = backup.command?.filter(
          (part) => part.trim().length > 0,
        );
        if (!command || command.length === 0) {
          entries.push(
            serviceDataEntry(installation, config, {
              status: "missing",
              mode: backup.mode,
              reason:
                "custom_command requires BackupConfig.command so the backup artifact producer is auditable",
            }),
          );
          continue;
        }
      }

      const outputPath = backup.outputPath?.trim();
      if (!outputPath) {
        entries.push(
          serviceDataEntry(installation, config, {
            status: "missing",
            mode: backup.mode,
            reason: `${backup.mode} requires BackupConfig.outputPath`,
          }),
        );
        continue;
      }

      if (
        (backup.mode === "provider_snapshot" ||
          backup.mode === "custom_command") &&
        this.#serviceDataRunner
      ) {
        // Upload-origin installations have no git Source to resolve a "latest"
        // snapshot from; their snapshot lineage comes from deploy uploads.
        const sourceSnapshot = installation.sourceId
          ? await latestSourceSnapshot(this.#store, installation.sourceId)
          : undefined;
        const produced = await this.#serviceDataRunner.run({
          spaceId,
          capturedAt,
          installation,
          installConfig: config,
          ...(sourceSnapshot ? { sourceSnapshot } : {}),
          mode: backup.mode,
          outputPath,
          ...(backup.mode === "provider_snapshot"
            ? { provider: primaryBackupProvider(config) }
            : {}),
          ...(backup.command ? { command: backup.command } : {}),
        });
        if (produced.status === "exported") {
          entries.push(
            durableServiceDataEntry({
              installation,
              config,
              mode: backup.mode,
              outputPath,
              artifact: produced.artifact,
              backupRunId: produced.runId,
            }),
          );
        } else {
          entries.push(
            serviceDataEntry(installation, config, {
              status: produced.status,
              mode: backup.mode,
              outputPath,
              reason: produced.reason,
              ...(produced.runId ? { backupRunId: produced.runId } : {}),
            }),
          );
        }
        continue;
      }

      const output = await this.#store.getLatestOutputSnapshot(installation.id);
      if (!output) {
        entries.push(
          serviceDataEntry(installation, config, {
            status: "missing",
            mode: backup.mode,
            outputPath,
            reason:
              "installation has no OutputSnapshot to read artifact pointer from",
          }),
        );
        continue;
      }

      const value = lookupOutputValue(output, outputPath);
      const artifact = parseArtifactPointer(value);
      if (!artifact) {
        entries.push(
          serviceDataEntry(installation, config, {
            status: "missing",
            mode: backup.mode,
            outputPath,
            reason:
              "outputPath did not resolve to an artifact pointer string/object in projected outputs",
          }),
        );
        continue;
      }

      entries.push(
        durableServiceDataEntry({
          installation,
          config,
          mode: backup.mode,
          outputPath,
          artifact,
        }),
      );
    }

    return {
      bundleVersion: 1,
      kind: "service-data-backup-manifest",
      spaceId,
      capturedAt,
      entries,
    };
  }
}

async function latestSourceSnapshot(
  store: OpenTofuDeploymentStore,
  sourceId: string,
): Promise<SourceSnapshot | undefined> {
  const snapshots = [...(await store.listSourceSnapshots(sourceId))].sort(
    (a, b) =>
      b.fetchedAt.localeCompare(a.fetchedAt) || b.id.localeCompare(a.id),
  );
  return snapshots[0];
}

/**
 * The control-backup bundle shape (the decoded JSON inside the sealed object).
 * Every field is a public ledger projection; no secret material is present.
 */
export interface ControlBackupBundle {
  readonly bundleVersion: 1;
  readonly kind: "control";
  readonly spaceId: string;
  readonly capturedAt: string;
  readonly space: unknown;
  readonly sources: readonly PublicSource[];
  readonly sourceSnapshots: readonly BundleSourceSnapshot[];
  readonly installConfigs: readonly unknown[];
  readonly installations: readonly unknown[];
  readonly providerEnvBindingSets: readonly unknown[];
  readonly dependencies: readonly unknown[];
  readonly outputSharesGranted: readonly unknown[];
  readonly outputSharesReceived: readonly unknown[];
  readonly deployments: readonly unknown[];
  readonly stateSnapshots: readonly BundleStateSnapshot[];
  readonly outputSnapshots: readonly BundleOutputSnapshot[];
  readonly runGroups: readonly unknown[];
  readonly activity: readonly unknown[];
  readonly connections: readonly Connection[];
  readonly securityFindings: readonly unknown[];
  readonly billing: {
    readonly account: unknown;
    readonly subscription: unknown;
    readonly creditBalance: unknown;
    readonly creditReservations: readonly unknown[];
    readonly autoRechargeAttempts: readonly unknown[];
    readonly usageEvents: readonly unknown[];
  };
  readonly backupRecords: readonly unknown[];
}

/** Sealed tar entry manifest for §33 service-data backup durable artifacts. */
export interface ServiceDataBackupManifest {
  readonly bundleVersion: 1;
  readonly kind: "service-data-backup-manifest";
  readonly spaceId: string;
  readonly capturedAt: string;
  readonly entries: readonly ServiceDataBackupEntry[];
}

function durableServiceDataEntry(input: {
  readonly installation: Installation;
  readonly config: InstallConfig;
  readonly mode: "artifact_export" | "provider_snapshot" | "custom_command";
  readonly outputPath: string;
  readonly artifact: ServiceDataArtifactPointer;
  readonly backupRunId?: string;
}): ServiceDataBackupEntry {
  if (!isDurableServiceDataRef(input.artifact.ref)) {
    return serviceDataEntry(input.installation, input.config, {
      status: "missing",
      mode: input.mode,
      outputPath: input.outputPath,
      reason: `service-data artifact ref ${input.artifact.ref} is not durable outside the runner`,
      ...(input.backupRunId ? { backupRunId: input.backupRunId } : {}),
    });
  }
  return serviceDataEntry(input.installation, input.config, {
    status: "exported",
    mode: input.mode,
    outputPath: input.outputPath,
    artifact: input.artifact,
    ...(input.backupRunId ? { backupRunId: input.backupRunId } : {}),
  });
}

export type ServiceDataBackupEntry =
  | ServiceDataBackupExportedEntry
  | ServiceDataBackupUnsupportedEntry
  | ServiceDataBackupMissingEntry;

interface ServiceDataBackupEntryBase {
  readonly installationId: string;
  readonly installationName: string;
  readonly environment: string;
  readonly installConfigId: string;
  readonly installConfigName?: string;
  readonly mode: "artifact_export" | "provider_snapshot" | "custom_command";
  readonly outputPath?: string;
  /** Isolated backup Run that produced the pointer, when generated by Takosumi. */
  readonly backupRunId?: string;
}

export interface ServiceDataBackupExportedEntry extends ServiceDataBackupEntryBase {
  readonly status: "exported";
  readonly mode: "artifact_export" | "provider_snapshot" | "custom_command";
  readonly artifact: ServiceDataArtifactPointer;
}

export interface ServiceDataBackupUnsupportedEntry extends ServiceDataBackupEntryBase {
  readonly status: "unsupported";
  readonly reason: string;
}

export interface ServiceDataBackupMissingEntry extends ServiceDataBackupEntryBase {
  readonly status: "missing";
  readonly reason: string;
}

/**
 * Service-owned backup pointer published by an Installation output. Depending
 * on `mode`, this can be an exported artifact, a provider-native snapshot
 * reference, or an artifact produced by a backup command. Takosumi records the
 * pointer only; it does not read provider data or include service bytes in the
 * control ledger.
 */
export interface ServiceDataArtifactPointer {
  readonly ref: string;
  readonly digest?: string;
  readonly sizeBytes?: number;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** SourceSnapshot metadata as captured in a control bundle. */
export interface BundleSourceSnapshot {
  readonly id: string;
  readonly origin: "git" | "upload" | "artifact";
  readonly spaceId: string;
  /** Present for git-origin snapshots; absent for no-Source snapshots. */
  readonly sourceId?: string;
  readonly url: string;
  readonly ref: string;
  readonly resolvedCommit: string;
  readonly path: string;
  readonly archiveObjectKey: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
  readonly fetchedByRunId: string;
  readonly fetchedAt: string;
}

/** StateSnapshot METADATA (no raw state bytes) as captured in a bundle. */
export interface BundleStateSnapshot {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly generation: number;
  readonly objectKey: string;
  readonly digest: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
}

/** OutputSnapshot projection (no raw output VALUES) as captured in a bundle. */
export interface BundleOutputSnapshot {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly stateGeneration: number;
  readonly rawOutputArtifactKey: string;
  readonly publicOutputs: Readonly<Record<string, unknown>>;
  readonly spaceOutputs: Readonly<Record<string, unknown>>;
  readonly outputDigest: string;
  readonly createdAt: string;
}

/** A Source with the internal hook-secret / sync bookkeeping fields removed. */
export type PublicSource = Omit<
  StoredSource,
  "hookSecretHash" | "lastSeenCommit" | "autoSync"
>;

/** Strips the internal {@link StoredSource} fields, keeping the public Source. */
function stripSource(source: StoredSource): PublicSource {
  const {
    hookSecretHash: _h,
    lastSeenCommit: _l,
    autoSync: _a,
    ...rest
  } = source;
  return rest;
}

/**
 * The PUBLIC Connection record is already secret-free (the sealed blob lives in
 * a separate store namespace and is never read here). This is an identity
 * passthrough documenting that ONLY the public record enters a bundle.
 */
function publicConnection(connection: Connection): Connection {
  return connection;
}

function serviceDataEntry(
  installation: Installation,
  config: InstallConfig | undefined,
  rest:
    | ServiceDataBackupEntryRest<ServiceDataBackupExportedEntry>
    | ServiceDataBackupEntryRest<ServiceDataBackupUnsupportedEntry>
    | ServiceDataBackupEntryRest<ServiceDataBackupMissingEntry>,
): ServiceDataBackupEntry {
  return {
    installationId: installation.id,
    installationName: installation.name,
    environment: installation.environment,
    installConfigId: installation.installConfigId,
    ...(config ? { installConfigName: config.name } : {}),
    ...rest,
  } as ServiceDataBackupEntry;
}

type ServiceDataBackupEntryRest<T extends ServiceDataBackupEntry> = Omit<
  T,
  | "installationId"
  | "installationName"
  | "environment"
  | "installConfigId"
  | "installConfigName"
>;

function lookupOutputValue(output: OutputSnapshot, path: string): unknown {
  const segments = path.split(".").filter((part) => part.length > 0);
  if (segments.length === 0) return undefined;
  const fromSpace = getPath(output.spaceOutputs, segments);
  if (fromSpace !== undefined) return fromSpace;
  return getPath(output.publicOutputs, segments);
}

function getPath(
  root: Readonly<Record<string, unknown>>,
  path: readonly string[],
): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function parseArtifactPointer(
  value: unknown,
): ServiceDataArtifactPointer | undefined {
  if (typeof value === "string") {
    const ref = value.trim();
    return isSafeArtifactRef(ref) ? { ref } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const refValue =
    value.ref ?? value.objectKey ?? value.artifactKey ?? value.key;
  if (typeof refValue !== "string") return undefined;
  const ref = refValue.trim();
  if (!isSafeArtifactRef(ref)) return undefined;
  const pointer: ServiceDataArtifactPointer = { ref };
  if (typeof value.digest === "string" && value.digest.trim().length > 0) {
    (pointer as { digest?: string }).digest = value.digest.trim();
  }
  if (
    typeof value.sizeBytes === "number" &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes >= 0
  ) {
    (pointer as { sizeBytes?: number }).sizeBytes = value.sizeBytes;
  }
  if (
    typeof value.contentType === "string" &&
    value.contentType.trim().length > 0
  ) {
    (pointer as { contentType?: string }).contentType =
      value.contentType.trim();
  }
  if (isRecord(value.metadata)) {
    (pointer as { metadata?: Readonly<Record<string, unknown>> }).metadata =
      value.metadata;
  }
  return pointer;
}

function isSafeArtifactRef(ref: string): boolean {
  if (ref.length === 0 || ref.includes("\0")) return false;
  if (/^https?:\/\//i.test(ref)) return false;
  if (/^r2:\/\/[A-Za-z0-9._-]+\/[^\s]+$/u.test(ref)) return true;
  return /^[A-Za-z0-9._/@:+-]+$/u.test(ref) && !ref.includes("..");
}

function isDurableServiceDataRef(ref: string): boolean {
  if (/^runner-local:\/\//u.test(ref)) return false;
  if (/^r2:\/\/[A-Za-z0-9._-]+\/[^\s]+$/u.test(ref)) return true;
  return (
    /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9._/@:+-]+$/u.test(ref) &&
    !ref.includes("..")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Groups `items` into a Map keyed by `key(item)`, preserving insertion order
 * within each group. Used to turn a single space-scoped (or id-batched) store
 * read into the per-Source / per-Installation buckets the bundle loops iterate,
 * replacing the N+1 per-item store reads. Items whose key is `undefined` are
 * skipped.
 */
function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string | undefined,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    const bucket = groups.get(k);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(k, [item]);
    }
  }
  return groups;
}

function primaryBackupProvider(config: InstallConfig): string | undefined {
  const provider = config.policy.allowedProviders?.find(
    (value) => value.trim().length > 0,
  );
  return provider?.trim();
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

interface TarEntry {
  readonly name: string;
  readonly body: Uint8Array;
}

function tarArchive(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    assertSafeTarPath(entry.name);
    chunks.push(tarHeader(entry.name, entry.body.byteLength));
    chunks.push(entry.body);
    const padding = (512 - (entry.body.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return concatBytes(chunks);
}

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarOctal(header, 148, 8, checksum);
  return header;
}

function writeTarString(
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `tar path is too long: ${value}`,
    );
  }
  header.set(bytes, offset);
}

function writeTarOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeTarString(header, offset, length - 1, encoded);
  header[offset + length - 1] = 0;
}

function assertSafeTarPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `unsafe backup tar path: ${path}`,
    );
  }
}

function formatStateGeneration(generation: number): string {
  return String(generation).padStart(8, "0");
}

function zstdCompressRaw(input: Uint8Array): Uint8Array {
  if (input.byteLength > 0xffffffff) {
    throw new OpenTofuControllerError(
      "resource_exhausted",
      "backup payload exceeds the portable zstd encoder limit",
    );
  }
  const chunks: Uint8Array[] = [];
  chunks.push(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]));
  chunks.push(new Uint8Array([0xa0]));
  chunks.push(uint32le(input.byteLength));
  const maxBlockSize = 128 * 1024;
  for (
    let offset = 0;
    offset < input.byteLength || offset === 0;
    offset += maxBlockSize
  ) {
    const end = Math.min(offset + maxBlockSize, input.byteLength);
    const block = input.slice(offset, end);
    const last = end >= input.byteLength ? 1 : 0;
    chunks.push(uint24le((block.byteLength << 3) | last));
    chunks.push(block);
    if (input.byteLength === 0) break;
  }
  return concatBytes(chunks);
}

function uint32le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function uint24le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
  ]);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function restoreTargetFromBundle(
  stateSnapshots: readonly BundleStateSnapshot[],
  request: CreateBackupRequest,
): { readonly restoreTarget?: BackupRestoreTarget } {
  if (!request.installationId || !request.environment) return {};
  const latest = stateSnapshots
    .filter(
      (snapshot) =>
        snapshot.installationId === request.installationId &&
        snapshot.environment === request.environment,
    )
    .at(-1);
  if (!latest) return {};
  return {
    restoreTarget: {
      capsuleId: latest.installationId,
      installationId: latest.installationId,
      environment: latest.environment,
      stateGeneration: latest.generation,
      stateVersionId: latest.id,
      stateSnapshotId: latest.id,
    },
  };
}

/**
 * Local/dev fallback {@link BackupArtifactStore}: keeps sealed objects in memory
 * and computes the digest over the bytes it stores. A host that wires
 * R2_BACKUPS + the at-rest crypto supplies a real implementation; this keeps the
 * service usable in tests / single-process dev without object storage.
 */
export class InMemoryBackupArtifactStore implements BackupArtifactStore {
  readonly #objects = new Map<string, Uint8Array>();

  async put(input: {
    readonly objectKey: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    // The in-memory fallback does NOT encrypt (no crypto seam in dev); it stores
    // the payload bytes verbatim and digests them. Production wires a sealing
    // store (see the worker `backupArtifactStore` seam).
    this.#objects.set(input.objectKey, input.payload);
    return {
      digest: await digestBytes(input.payload),
      sizeBytes: input.payload.byteLength,
    };
  }

  async putPlain(input: {
    readonly objectKey: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    this.#objects.set(input.objectKey, input.payload);
    return {
      digest: await digestBytes(input.payload),
      sizeBytes: input.payload.byteLength,
    };
  }

  /** Test/dev accessor: the stored bytes at a key (sealed in production). */
  get(objectKey: string): Uint8Array | undefined {
    return this.#objects.get(objectKey);
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
