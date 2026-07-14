/**
 * Control-backup domain service (Core Specification §33 layer 1 "Control
 * backup" + §26 backup artifact layout).
 *
 * Produces a sealed bundle that captures a Workspace's CONTROL ledger — the
 * information Takosumi manages about a Workspace — so an operator can export /
 * archive / migrate it. The bundle is the JSON of the Workspace's ledger rows,
 * compressed, then sealed with the same at-rest secret-boundary crypto the
 * state / secret lanes use, and written to a host-allocated opaque reference. A
 * {@link BackupRecord} ledger pointer (`ref` / digest / sizeBytes) is recorded and
 * a Workspace Activity event is emitted.
 *
 * SECURITY (spec §9 / §16, invariants 11/12): the bundle NEVER contains secret
 * material. Specifically it strips / omits:
 *   - Source `hookSecretHash` / `lastSeenCommit` (private fields);
 *   - ProviderConnection sealed blobs (only the PUBLIC ProviderConnection record is included —
 *     names / provider / scope / envNames, never values);
 *   - raw state bytes (only StateVersion METADATA — ref / digest / generation);
 *   - raw output VALUES (only the projected `publicOutputs` / `workspaceOutputs` +
 *     the raw artifact ref is included — the encrypted raw envelope is not copied).
 *
 * Spec §33 layer 2 ("service data backup": messages / files / posts / …)
 * records a sealed manifest of service-owned backup pointers. Takosumi does
 * not fetch provider data, run arbitrary commands, or copy raw service bytes in
 * the control backup path. `provider_snapshot` and `custom_command` may be
 * delegated to an injected isolated backup runner; otherwise the control path
 * captures the pointer the Capsule already projected at
 * `BackupConfig.outputPath`.
 *
 * Backup sidecars use the canonical artifact names from the spec:
 * `state.tar.zst.enc`, `artifacts.manifest.json`, and
 * `service-data.tar.zst.enc`.
 */

import {
  type BackupArtifactPointer,
  type BackupRecord,
  type BackupRestoreTarget,
  CONTROL_BACKUP_CONTENT_TYPE,
  type ListBackupsResponse,
} from "takosumi-contract/backups";
import type { PageParams } from "takosumi-contract/pagination";
import type {
  Capsule,
  ProviderConnection,
  InstallConfig,
} from "@takosumi/internal/deploy-control-api";
import type { Output as Output } from "takosumi-contract/outputs";
import type { Run } from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type {
  OpenTofuControlStore,
  StoredSource,
} from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";
import type { ArtifactReferenceAllocator } from "../../adapters/storage/artifact-references.ts";

/**
 * Narrow injected seam for sealing + persisting a control-backup bundle. The
 * host worker supplies an implementation backed by artifact storage + the at-rest
 * secret-boundary crypto (see {@link InMemoryBackupArtifactStore} for the
 * local/dev fallback). The service hands it the PLAINTEXT payload bytes; the store
 * seals them and writes the sealed object to its backing bucket.
 */
export interface BackupArtifactStore {
  /**
   * Seals `payload` (already encoded/compressed where applicable) and writes the sealed
   * object to backup storage at `ref`. Returns the digest over the SEALED
   * bytes and their length, which become the {@link BackupRecord} pointer.
   */
  put(input: {
    readonly ref: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }>;
  /**
   * Writes a non-secret public backup sidecar, such as
   * `artifacts.manifest.json`. Stores that cannot expose plain objects may omit
   * this; the service then falls back to `put`.
   */
  putPlain?(input: {
    readonly ref: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }>;
}

export interface BackupObjectReader {
  get(ref: string): Promise<Uint8Array | undefined>;
}

export interface ServiceDataBackupRunner {
  run(
    input: ServiceDataBackupRunnerInput,
  ): Promise<ServiceDataBackupRunnerResult>;
}

export interface ServiceDataBackupRunnerInput {
  readonly workspaceId: string;
  readonly capturedAt: string;
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
  readonly sourceSnapshot?: SourceSnapshot;
  readonly mode: "provider_snapshot" | "custom_command";
  readonly outputPath: string;
  readonly adapterId?: string;
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
  /** Optional run id that triggered the backup (operator / scheduled flows). */
  readonly createdByRunId?: string;
  /** Optional Capsule context for Capsule-scoped backup Runs. */
  readonly capsuleId?: string;
  readonly environment?: string;
}

export interface BackupsServiceDependencies {
  readonly store: OpenTofuControlStore;
  /**
   * The seal + object-storage seam. When omitted the service is DISABLED and
   * `createBackup` throws `not_implemented` (a host that did not wire
   * backup artifact storage + crypto must not silently drop backups).
   */
  readonly artifactStore?: BackupArtifactStore;
  /** Allocates opaque destinations; required whenever artifactStore is wired. */
  readonly artifactReferenceAllocator?: ArtifactReferenceAllocator;
  /**
   * Reader for immutable state objects. Required when exporting a backup that
   * includes StateVersion rows, because `state.tar.zst.enc` contains the sealed
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
  readonly #store: OpenTofuControlStore;
  readonly #artifactStore: BackupArtifactStore | undefined;
  readonly #artifactReferenceAllocator: ArtifactReferenceAllocator | undefined;
  readonly #stateObjectReader: BackupObjectReader | undefined;
  readonly #serviceDataRunner: ServiceDataBackupRunner | undefined;
  readonly #activity: ActivityRecorder;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  readonly #activityLimit: number;

  constructor(deps: BackupsServiceDependencies) {
    this.#store = deps.store;
    this.#artifactStore = deps.artifactStore;
    this.#artifactReferenceAllocator = deps.artifactReferenceAllocator;
    this.#stateObjectReader = deps.stateObjectReader;
    this.#serviceDataRunner = deps.serviceDataRunner;
    this.#activity = deps.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
    this.#activityLimit = deps.activityLimit ?? CONTROL_BACKUP_ACTIVITY_LIMIT;
  }

  /** Whether a usable artifact store is wired (drives the route 501 vs 201). */
  get enabled(): boolean {
    return (
      this.#artifactStore !== undefined &&
      this.#artifactReferenceAllocator !== undefined
    );
  }

  async #allocateBackupRef(
    kind:
      | "backup_control"
      | "backup_state"
      | "backup_artifacts_manifest"
      | "backup_service_data",
    workspaceId: string,
    backupId: string,
  ): Promise<string> {
    const allocator = this.#artifactReferenceAllocator;
    if (!allocator) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "backup artifact-reference allocator is not wired",
      );
    }
    const ref = await allocator.allocate({ kind, workspaceId, backupId });
    if (!ref.trim()) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `artifact-reference allocator returned an empty ${kind} ref`,
      );
    }
    return ref;
  }

  /**
   * Creates one control backup for a Workspace: gathers the ledger, strips secret
   * material, zstd-compresses + seals + writes the bundle to backup storage,
   * records the pointer, and emits a Workspace Activity event. Returns the
   * {@link BackupRecord}.
   */
  async createBackup(request: CreateBackupRequest): Promise<BackupRecord> {
    const workspaceId = request.workspaceId.trim();
    if (workspaceId.length === 0) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "workspaceId is required",
      );
    }
    if (!this.#artifactStore || !this.#artifactReferenceAllocator) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "control backups are not wired (backup artifact storage + crypto unavailable)",
      );
    }
    const workspace = await this.#store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new OpenTofuControllerError("not_found", "workspace not found");
    }

    const createdAt = this.#now().toISOString();
    const backupId = this.#newId("bkp");
    const runId = request.createdByRunId ?? this.#newId("backup");
    if (!request.createdByRunId) {
      await this.#putBackupRun({
        request,
        runId,
        workspaceId,
        status: "running",
        createdAt,
        startedAt: createdAt,
      });
    }

    try {
      const bundle = await this.#collectControlBundle(workspaceId, createdAt);
      const payload = zstdCompressRaw(jsonBytes(bundle));
      const ref = await this.#allocateBackupRef(
        "backup_control",
        workspaceId,
        backupId,
      );
      const { digest, sizeBytes } = await this.#artifactStore.put({
        ref,
        payload,
        contentType: CONTROL_BACKUP_CONTENT_TYPE,
      });
      const stateArchive = await this.#writeStateArchive({
        backupId,
        workspaceId,
        stateVersions: bundle.stateVersions,
      });
      const serviceData = await this.#writeServiceDataArchive({
        backupId,
        workspaceId,
        capturedAt: createdAt,
      });
      const artifactsManifest = await this.#writeArtifactsManifest({
        backupId,
        workspaceId,
        control: { ref, digest, sizeBytes },
        ...(stateArchive ? { stateArchive } : {}),
        ...(serviceData ? { serviceData } : {}),
      });

      const record: BackupRecord = {
        id: backupId,
        workspaceId,
        ...(request.capsuleId ? { capsuleId: request.capsuleId } : {}),
        ...(request.environment ? { environment: request.environment } : {}),
        ...restoreTargetFromBundle(bundle.stateVersions, request),
        ref,
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
          workspaceId,
          status: "succeeded",
          createdAt,
          startedAt: createdAt,
          finishedAt: this.#now().toISOString(),
        });
      }

      // Activity (§27 / §34): a control backup was created. Pointer metadata only
      // (ids / digest / size) — never bundle contents.
      await this.#activity.record({
        workspaceId,
        action: "backup.created",
        targetType: "backup",
        targetId: backupId,
        metadata: {
          ref,
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
          workspaceId,
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
    readonly workspaceId: string;
    readonly status: Run["status"];
    readonly errorCode?: string;
    readonly createdAt: string;
    readonly startedAt?: string;
    readonly finishedAt?: string;
  }): Promise<void> {
    await this.#store.putBackupRun({
      id: input.runId,
      workspaceId: input.workspaceId,
      ...(input.request.capsuleId
        ? { capsuleId: input.request.capsuleId }
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

  /** Lists a Workspace's control backups, newest first (keyset-paged, spec §30). */
  async listBackups(
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListBackupsResponse> {
    const id = workspaceId.trim();
    if (id.length === 0) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "workspaceId is required",
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
   * Reads the public-safe control-ledger projection for the Workspace and assembles
   * the bundle, stripping internal fields + secret material. Object bytes stay
   * in state/artifact stores; this bundle carries ledger rows and pointers.
   */
  async #collectControlBundle(
    workspaceId: string,
    capturedAt: string,
  ): Promise<ControlBackupBundle> {
    const workspace = await this.#store.getWorkspace(workspaceId);
    const sources = await this.#store.listSources(workspaceId);
    const installConfigs = await this.#store.listInstallConfigs(workspaceId);
    const capsules = await this.#store.listCapsules(workspaceId);
    const dependencies =
      await this.#store.listDependenciesByWorkspace(workspaceId);
    const connections = await this.#store.listConnections(workspaceId);
    const outputSharesGranted =
      await this.#store.listOutputSharesFromWorkspace(workspaceId);
    const outputSharesReceived =
      await this.#store.listOutputSharesToWorkspace(workspaceId);
    const runGroups = await this.#store.listRunGroups(workspaceId);
    const activity = await this.#store.listActivityEvents(workspaceId, {
      limit: this.#activityLimit,
    });
    const securityFindings = await this.#store.listSecurityFindings(
      workspaceId,
      {
        limit: this.#activityLimit,
      },
    );
    const usageEvents = await this.#store.listUsageEvents(workspaceId);
    const backupRecords = await this.#store.listBackupRecords(workspaceId);

    // Per-Capsule fan-out: source snapshots (by Source), StateVersion metadata,
    // and Output projections.
    //
    // Read efficiency (Core Spec §33): rather than one store round-trip per
    // Source / Capsule, fetch each resource for the whole Workspace (or the
    // already-loaded Source id batch) in a single query, group the result by the
    // id the loop keys on, then iterate the same `sources` / `capsules`
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
          workspaceId: snapshot.workspaceId,
          sourceId: snapshot.sourceId,
          url: snapshot.url,
          ref: snapshot.ref,
          resolvedCommit: snapshot.resolvedCommit,
          path: snapshot.path,
          archiveRef: snapshot.archiveRef,
          archiveDigest: snapshot.archiveDigest,
          archiveSizeBytes: snapshot.archiveSizeBytes,
          fetchedByRunId: snapshot.fetchedByRunId,
          fetchedAt: snapshot.fetchedAt,
        });
      }
    }

    const stateVersionsByCapsule = groupBy(
      await this.#store.listStateVersionsByWorkspace(workspaceId),
      (snapshot) => snapshot.capsuleId,
    );
    const outputsByCapsule = groupBy(
      await this.#store.listOutputsByWorkspace(workspaceId),
      (snapshot) => snapshot.capsuleId,
    );

    const providerBindingSets: unknown[] = [];
    const stateVersions: BundleStateVersion[] = [];
    const outputs: BundleOutput[] = [];
    for (const capsule of capsules) {
      const profile = await this.#store.getProviderBindingSetByCapsule(
        capsule.id,
        capsule.environment,
      );
      if (profile) {
        providerBindingSets.push(profile);
      }
      const capsuleStateVersions = (
        stateVersionsByCapsule.get(capsule.id) ?? []
      )
        .filter((snapshot) => snapshot.environment === capsule.environment)
        .sort((a, b) => a.generation - b.generation);
      for (const snapshot of capsuleStateVersions) {
        // METADATA only — the encrypted state bytes are NOT copied (`stateRef`
        // is the opaque pointer to the immutable state object).
        stateVersions.push({
          id: snapshot.id,
          workspaceId: snapshot.workspaceId,
          capsuleId: snapshot.capsuleId,
          environment: snapshot.environment,
          generation: snapshot.generation,
          stateRef: snapshot.stateRef,
          digest: snapshot.digest,
          createdByRunId: snapshot.createdByRunId,
          createdAt: snapshot.createdAt,
        });
      }
      const capsuleOutputs = (outputsByCapsule.get(capsule.id) ?? [])
        .slice()
        .sort(
          (a, b) =>
            a.stateGeneration - b.stateGeneration ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      for (const output of capsuleOutputs) {
        // publicOutputs + workspaceOutputs PROJECTIONS only — raw output VALUES are
        // never copied; the raw artifact ref is listed but the bytes are not.
        outputs.push({
          id: output.id,
          workspaceId: output.workspaceId,
          capsuleId: output.capsuleId,
          stateGeneration: output.stateGeneration,
          rawArtifactRef: output.rawArtifactRef,
          publicOutputs: output.publicOutputs,
          workspaceOutputs: output.workspaceOutputs,
          outputDigest: output.outputDigest,
          createdAt: output.createdAt,
        });
      }
    }

    return {
      bundleVersion: 2,
      kind: "control",
      workspaceId,
      capturedAt,
      workspace: workspace ?? null,
      sources: sources.map(stripSource),
      sourceSnapshots,
      installConfigs: [...installConfigs],
      capsules: [...capsules],
      providerBindingSets,
      dependencies: [...dependencies],
      outputSharesGranted: [...outputSharesGranted],
      outputSharesReceived: [...outputSharesReceived],
      stateVersions,
      outputs,
      runGroups: [...runGroups],
      activity: [...activity],
      connections: connections.map(publicConnection),
      securityFindings: [...securityFindings],
      usageEvents: [...usageEvents],
      backupRecords: [...backupRecords],
    };
  }

  async #writeStateArchive(input: {
    readonly backupId: string;
    readonly workspaceId: string;
    readonly stateVersions: readonly BundleStateVersion[];
  }): Promise<BackupArtifactPointer | undefined> {
    if (!this.#artifactStore || input.stateVersions.length === 0) {
      return undefined;
    }
    if (!this.#stateObjectReader) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "state backup export requires a state-object reader",
      );
    }
    const entries: TarEntry[] = [
      {
        name: "state.json",
        body: jsonBytes({
          bundleVersion: 1,
          kind: "state-backup-archive",
          workspaceId: input.workspaceId,
          stateVersions: input.stateVersions,
        }),
      },
    ];
    for (const snapshot of input.stateVersions) {
      const bytes = await this.#stateObjectReader.get(snapshot.stateRef);
      if (!bytes) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `state snapshot ref ${snapshot.stateRef} is missing`,
        );
      }
      entries.push({
        name: `states/${snapshot.capsuleId}/${snapshot.environment}/${formatStateGeneration(snapshot.generation)}.tfstate.enc`,
        body: bytes,
      });
    }
    const ref = await this.#allocateBackupRef(
      "backup_state",
      input.workspaceId,
      input.backupId,
    );
    const payload = zstdCompressRaw(tarArchive(entries));
    const { digest, sizeBytes } = await this.#artifactStore.put({
      ref,
      payload,
      contentType: CONTROL_BACKUP_CONTENT_TYPE,
    });
    return { ref, digest, sizeBytes };
  }

  async #writeArtifactsManifest(input: {
    readonly backupId: string;
    readonly workspaceId: string;
    readonly control: BackupArtifactPointer;
    readonly stateArchive?: BackupArtifactPointer;
    readonly serviceData?: BackupArtifactPointer;
  }): Promise<BackupArtifactPointer | undefined> {
    if (!this.#artifactStore) return undefined;
    const ref = await this.#allocateBackupRef(
      "backup_artifacts_manifest",
      input.workspaceId,
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
          workspaceId: input.workspaceId,
          backupId: input.backupId,
          artifacts,
        },
        null,
        2,
      ) + "\n",
    );
    const writer = this.#artifactStore.putPlain ?? this.#artifactStore.put;
    const { digest, sizeBytes } = await writer.call(this.#artifactStore, {
      ref,
      payload,
      contentType: "application/json",
    });
    return { ref, digest, sizeBytes };
  }

  async #writeServiceDataArchive(input: {
    readonly backupId: string;
    readonly workspaceId: string;
    readonly capturedAt: string;
  }): Promise<BackupRecord["serviceData"] | undefined> {
    if (!this.#artifactStore) return undefined;
    const manifest = await this.#collectServiceDataManifest(
      input.workspaceId,
      input.capturedAt,
    );
    if (manifest.entries.length === 0) return undefined;

    const ref = await this.#allocateBackupRef(
      "backup_service_data",
      input.workspaceId,
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
      ref,
      payload,
      contentType: CONTROL_BACKUP_CONTENT_TYPE,
    });
    return {
      ref,
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
    workspaceId: string,
    capturedAt: string,
  ): Promise<ServiceDataBackupManifest> {
    const installConfigs = new Map(
      (await this.#store.listInstallConfigs(workspaceId)).map((config) => [
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
    for (const capsule of await this.#store.listCapsules(workspaceId)) {
      const config = installConfigs.get(capsule.installConfigId);
      if (!config) continue;
      const backup = config.backup;
      if (!backup?.enabled || backup.mode === "none") continue;

      if (backup.mode === "custom_command") {
        const command = backup.command?.filter(
          (part) => part.trim().length > 0,
        );
        if (!command || command.length === 0) {
          entries.push(
            serviceDataEntry(capsule, config, {
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
          serviceDataEntry(capsule, config, {
            status: "missing",
            mode: backup.mode,
            reason: `${backup.mode} requires BackupConfig.outputPath`,
          }),
        );
        continue;
      }

      const adapterId = backup.adapterId?.trim();
      if (backup.mode === "provider_snapshot" && !adapterId) {
        entries.push(
          serviceDataEntry(capsule, config, {
            status: "missing",
            mode: backup.mode,
            outputPath,
            reason:
              "provider_snapshot requires an explicit BackupConfig.adapterId",
          }),
        );
        continue;
      }

      if (
        (backup.mode === "provider_snapshot" ||
          backup.mode === "custom_command") &&
        this.#serviceDataRunner
      ) {
        // Historical records may predate the Git-only Capsule invariant. New
        // Capsule execution always has a registered Source.
        const sourceSnapshot = capsule.sourceId
          ? await latestSourceSnapshot(this.#store, capsule.sourceId)
          : undefined;
        const produced = await this.#serviceDataRunner.run({
          workspaceId,
          capturedAt,
          capsule,
          installConfig: config,
          ...(sourceSnapshot ? { sourceSnapshot } : {}),
          mode: backup.mode,
          outputPath,
          ...(adapterId ? { adapterId } : {}),
          ...(backup.command ? { command: backup.command } : {}),
        });
        if (produced.status === "exported") {
          entries.push(
            exportedServiceDataEntry({
              capsule,
              config,
              mode: backup.mode,
              outputPath,
              artifact: produced.artifact,
              backupRunId: produced.runId,
            }),
          );
        } else {
          entries.push(
            serviceDataEntry(capsule, config, {
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

      const output = await this.#store.getLatestOutput(capsule.id);
      if (!output) {
        entries.push(
          serviceDataEntry(capsule, config, {
            status: "missing",
            mode: backup.mode,
            outputPath,
            reason: "Capsule has no Output to read artifact pointer from",
          }),
        );
        continue;
      }

      const value = lookupOutputValue(output, outputPath);
      const artifact = parseArtifactPointer(value);
      if (!artifact) {
        entries.push(
          serviceDataEntry(capsule, config, {
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
        exportedServiceDataEntry({
          capsule,
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
      workspaceId,
      capturedAt,
      entries,
    };
  }
}

async function latestSourceSnapshot(
  store: OpenTofuControlStore,
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
  readonly bundleVersion: 2;
  readonly kind: "control";
  readonly workspaceId: string;
  readonly capturedAt: string;
  readonly workspace: unknown;
  readonly sources: readonly PublicSource[];
  readonly sourceSnapshots: readonly BundleSourceSnapshot[];
  readonly installConfigs: readonly unknown[];
  readonly capsules: readonly unknown[];
  readonly providerBindingSets: readonly unknown[];
  readonly dependencies: readonly unknown[];
  readonly outputSharesGranted: readonly unknown[];
  readonly outputSharesReceived: readonly unknown[];
  readonly stateVersions: readonly BundleStateVersion[];
  readonly outputs: readonly BundleOutput[];
  readonly runGroups: readonly unknown[];
  readonly activity: readonly unknown[];
  readonly connections: readonly ProviderConnection[];
  readonly securityFindings: readonly unknown[];
  readonly usageEvents: readonly unknown[];
  readonly backupRecords: readonly unknown[];
}

/** Sealed tar entry manifest for §33 service-data backup durable artifacts. */
export interface ServiceDataBackupManifest {
  readonly bundleVersion: 1;
  readonly kind: "service-data-backup-manifest";
  readonly workspaceId: string;
  readonly capturedAt: string;
  readonly entries: readonly ServiceDataBackupEntry[];
}

function exportedServiceDataEntry(input: {
  readonly capsule: Capsule;
  readonly config: InstallConfig;
  readonly mode: "artifact_export" | "provider_snapshot" | "custom_command";
  readonly outputPath: string;
  readonly artifact: ServiceDataArtifactPointer;
  readonly backupRunId?: string;
}): ServiceDataBackupEntry {
  if (!isSafeArtifactRef(input.artifact.ref)) {
    return serviceDataEntry(input.capsule, input.config, {
      status: "missing",
      mode: input.mode,
      outputPath: input.outputPath,
      reason: "service-data producer returned an invalid opaque artifact ref",
      ...(input.backupRunId ? { backupRunId: input.backupRunId } : {}),
    });
  }
  return serviceDataEntry(input.capsule, input.config, {
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
  readonly capsuleId: string;
  readonly capsuleName: string;
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
 * Service-owned backup pointer published by a Capsule output. Depending
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
  readonly origin: "git";
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly url: string;
  readonly ref: string;
  readonly resolvedCommit: string;
  readonly path: string;
  readonly archiveRef: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
  readonly fetchedByRunId: string;
  readonly fetchedAt: string;
}

/** StateVersion METADATA (no raw state bytes) as captured in a bundle. */
export interface BundleStateVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly digest: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
}

/** Output projection (no raw output VALUES) as captured in a bundle. */
export interface BundleOutput {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly stateGeneration: number;
  readonly rawArtifactRef: string;
  readonly publicOutputs: Readonly<Record<string, unknown>>;
  readonly workspaceOutputs: Readonly<Record<string, unknown>>;
  readonly outputDigest: string;
  readonly createdAt: string;
}

/** A Source with private hook-secret / sync bookkeeping fields removed. */
export type PublicSource = Omit<
  StoredSource,
  "hookSecretHash" | "lastSeenCommit"
>;

/** Strips the internal {@link StoredSource} fields, keeping the public Source. */
function stripSource(source: StoredSource): PublicSource {
  const { hookSecretHash: _h, lastSeenCommit: _l, ...rest } = source;
  return rest;
}

/**
 * The PUBLIC ProviderConnection record is already secret-free (the sealed blob lives in
 * a separate store namespace and is never read here). This is an identity
 * passthrough documenting that ONLY the public record enters a bundle.
 */
function publicConnection(connection: ProviderConnection): ProviderConnection {
  return connection;
}

function serviceDataEntry(
  capsule: Capsule,
  config: InstallConfig | undefined,
  rest:
    | ServiceDataBackupEntryRest<ServiceDataBackupExportedEntry>
    | ServiceDataBackupEntryRest<ServiceDataBackupUnsupportedEntry>
    | ServiceDataBackupEntryRest<ServiceDataBackupMissingEntry>,
): ServiceDataBackupEntry {
  return {
    capsuleId: capsule.id,
    capsuleName: capsule.name,
    environment: capsule.environment,
    installConfigId: capsule.installConfigId,
    ...(config ? { installConfigName: config.name } : {}),
    ...rest,
  } as ServiceDataBackupEntry;
}

type ServiceDataBackupEntryRest<T extends ServiceDataBackupEntry> = Omit<
  T,
  | "capsuleId"
  | "capsuleName"
  | "environment"
  | "installConfigId"
  | "installConfigName"
>;

function lookupOutputValue(output: Output, path: string): unknown {
  const segments = path.split(".").filter((part) => part.length > 0);
  if (segments.length === 0) return undefined;
  const fromWorkspace = getPath(output.workspaceOutputs, segments);
  if (fromWorkspace !== undefined) return fromWorkspace;
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
  if (!isRecord(value)) return undefined;
  const refValue = value.ref;
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
  return (
    ref.length > 0 &&
    !ref.includes("\0") &&
    !ref.includes("..") &&
    /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/u.test(ref)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Groups `items` into a Map keyed by `key(item)`, preserving insertion order
 * within each group. Used to turn a single Workspace-scoped (or id-batched) store
 * read into the per-Source / per-Capsule buckets the bundle loops iterate,
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
  stateVersions: readonly BundleStateVersion[],
  request: CreateBackupRequest,
): { readonly restoreTarget?: BackupRestoreTarget } {
  if (!request.capsuleId || !request.environment) return {};
  const latest = stateVersions
    .filter(
      (snapshot) =>
        snapshot.capsuleId === request.capsuleId &&
        snapshot.environment === request.environment,
    )
    .at(-1);
  if (!latest) return {};
  return {
    restoreTarget: {
      capsuleId: latest.capsuleId,
      environment: latest.environment,
      stateGeneration: latest.generation,
      stateVersionId: latest.id,
    },
  };
}

/**
 * Local/dev fallback {@link BackupArtifactStore}: keeps sealed objects in memory
 * and computes the digest over the bytes it stores. A host that wires
 * backup artifact storage + at-rest crypto supplies a real implementation;
 * this keeps the service usable in tests / single-process dev without object storage.
 */
export class InMemoryBackupArtifactStore implements BackupArtifactStore {
  readonly #objects = new Map<string, Uint8Array>();

  async put(input: {
    readonly ref: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    // The in-memory fallback does NOT encrypt (no crypto seam in dev); it stores
    // the payload bytes verbatim and digests them. Production wires a sealing
    // store (see the worker `backupArtifactStore` seam).
    this.#objects.set(input.ref, input.payload);
    return {
      digest: await digestBytes(input.payload),
      sizeBytes: input.payload.byteLength,
    };
  }

  async putPlain(input: {
    readonly ref: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    this.#objects.set(input.ref, input.payload);
    return {
      digest: await digestBytes(input.payload),
      sizeBytes: input.payload.byteLength,
    };
  }

  /** Test/dev accessor for bytes stored at an opaque reference. */
  get(ref: string): Uint8Array | undefined {
    return this.#objects.get(ref);
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
