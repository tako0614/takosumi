/**
 * Control-backup domain service (Core Specification §33 layer 1 "Control
 * backup" + §26 R2_BACKUPS object layout).
 *
 * Produces a single sealed bundle that captures a Space's CONTROL ledger — the
 * information Takosumi manages about a Space — so an operator can export /
 * archive / migrate it. The bundle is the JSON of the Space's ledger rows, gzip
 * compressed, then sealed with the same at-rest secret-boundary crypto the
 * state / secret lanes use, and written to R2_BACKUPS under the §26 key
 * `spaces/{spaceId}/backups/{backupId}/control.json.gz.enc`. A {@link
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
 * Spec §33 layer 2 ("service data backup": messages / files / posts / …) is out
 * of scope here — that is per-Installation data owned by the Installation and
 * driven by `BackupConfig.mode` (the control plane's mode is `none`).
 *
 * DIVERGENCE (spec §26 names `control.json.zst.enc`): zstd has no streaming
 * primitive in workerd, so the bundle is gzip-compressed
 * (`CompressionStream("gzip")`) and the object key ends `.gz.enc`. The seal is
 * the same secret-boundary AES-GCM; `digest` is the SHA-256 over the SEALED
 * bytes written to R2.
 */

import {
  type BackupRecord,
  CONTROL_BACKUP_CONTENT_TYPE,
  CONTROL_BACKUP_OBJECT_KEY,
} from "takosumi-contract/backups";
import type { Connection } from "takosumi-contract/deploy-control-api";
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
 * local/dev fallback). The service hands it the PLAINTEXT gzip bytes; the store
 * seals them and writes the sealed object to its backing bucket.
 */
export interface BackupArtifactStore {
  /**
   * Seals `compressed` (the gzip-compressed bundle JSON) and writes the sealed
   * object to backup storage at `objectKey`. Returns the digest over the SEALED
   * bytes and their length, which become the {@link BackupRecord} pointer.
   */
  put(input: {
    readonly objectKey: string;
    readonly compressed: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }>;
}

export interface CreateBackupRequest {
  readonly spaceId: string;
  /** Optional run id that triggered the backup (operator / scheduled flows). */
  readonly createdByRunId?: string;
}

export interface BackupsServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  /**
   * The seal + object-storage seam. When omitted the service is DISABLED and
   * `createBackup` throws `not_implemented` (a host that did not wire
   * R2_BACKUPS + crypto must not silently drop backups).
   */
  readonly artifactStore?: BackupArtifactStore;
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
  readonly #activity: ActivityRecorder;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  readonly #activityLimit: number;

  constructor(deps: BackupsServiceDependencies) {
    this.#store = deps.store;
    this.#artifactStore = deps.artifactStore;
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
   * material, gzips + seals + writes the bundle to backup storage, records the
   * pointer, and emits a Space Activity event. Returns the {@link BackupRecord}.
   */
  async createBackup(request: CreateBackupRequest): Promise<BackupRecord> {
    const spaceId = request.spaceId.trim();
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

    const backupId = this.#newId("bkp");
    const createdAt = this.#now().toISOString();
    const bundle = await this.#collectControlBundle(spaceId, createdAt);
    const json = JSON.stringify(bundle);
    const compressed = await gzip(new TextEncoder().encode(json));
    const objectKey = CONTROL_BACKUP_OBJECT_KEY(spaceId, backupId);
    const { digest, sizeBytes } = await this.#artifactStore.put({
      objectKey,
      compressed,
      contentType: CONTROL_BACKUP_CONTENT_TYPE,
    });

    const record: BackupRecord = {
      id: backupId,
      spaceId,
      objectKey,
      digest,
      sizeBytes,
      ...(request.createdByRunId ? { createdByRunId: request.createdByRunId } : {}),
      createdAt,
    };
    await this.#store.putBackupRecord(record);

    // Activity (§27 / §34): a control backup was created. Pointer metadata only
    // (ids / digest / size) — never bundle contents.
    await this.#activity.record({
      spaceId,
      action: "backup.created",
      targetType: "backup",
      targetId: backupId,
      metadata: {
        objectKey,
        digest,
        sizeBytes,
        ...(request.createdByRunId ? { runId: request.createdByRunId } : {}),
      },
    });

    return record;
  }

  /** Lists a Space's control backups, newest first. */
  async listBackups(spaceId: string): Promise<readonly BackupRecord[]> {
    const id = spaceId.trim();
    if (id.length === 0) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "spaceId is required",
      );
    }
    return await this.#store.listBackupRecords(id);
  }

  /**
   * Reads every control-ledger row for the Space and assembles the bundle,
   * stripping internal fields + secret material. Read-only: uses existing store
   * list methods (no new store reads were added for the export).
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
    const runGroups = await this.#store.listRunGroups(spaceId);
    const activity = await this.#store.listActivityEvents(spaceId, {
      limit: this.#activityLimit,
    });

    // Per-installation fan-out: source snapshots (by source), deployments,
    // state-snapshot metadata, and output-snapshot projections.
    const sourceSnapshots: BundleSourceSnapshot[] = [];
    for (const source of sources) {
      for (const snapshot of await this.#store.listSourceSnapshots(source.id)) {
        sourceSnapshots.push({
          id: snapshot.id,
          sourceId: snapshot.sourceId,
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

    const deployments: unknown[] = [];
    const stateSnapshots: BundleStateSnapshot[] = [];
    const outputSnapshots: BundleOutputSnapshot[] = [];
    for (const installation of installations) {
      for (const deployment of await this.#store.listDeployments(installation.id)) {
        deployments.push(deployment);
      }
      for (
        const snapshot of await this.#store.listStateSnapshots(
          installation.id,
          installation.environment,
        )
      ) {
        // METADATA only — the encrypted state bytes are NOT copied (objectKey is
        // the pointer to the R2_STATE object).
        stateSnapshots.push({
          id: snapshot.id,
          spaceId: snapshot.spaceId,
          installationId: snapshot.installationId,
          environment: snapshot.environment,
          generation: snapshot.generation,
          objectKey: snapshot.objectKey,
          digest: snapshot.digest,
          createdByRunId: snapshot.createdByRunId,
          createdAt: snapshot.createdAt,
        });
      }
      const output = await this.#store.getLatestOutputSnapshot(installation.id);
      if (output) {
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
      dependencies: [...dependencies],
      deployments,
      stateSnapshots,
      outputSnapshots,
      runGroups: [...runGroups],
      activity: [...activity],
      connections: connections.map(publicConnection),
    };
  }
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
  readonly dependencies: readonly unknown[];
  readonly deployments: readonly unknown[];
  readonly stateSnapshots: readonly BundleStateSnapshot[];
  readonly outputSnapshots: readonly BundleOutputSnapshot[];
  readonly runGroups: readonly unknown[];
  readonly activity: readonly unknown[];
  readonly connections: readonly Connection[];
}

/** SourceSnapshot metadata as captured in a control bundle. */
export interface BundleSourceSnapshot {
  readonly id: string;
  readonly sourceId: string;
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
  const { hookSecretHash: _h, lastSeenCommit: _l, autoSync: _a, ...rest } =
    source;
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

/** gzip-compresses bytes via the platform `CompressionStream` (workerd / Bun). */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(
    new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(
      new CompressionStream("gzip"),
    ),
  );
  return new Uint8Array(await stream.arrayBuffer());
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
    readonly compressed: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    // The in-memory fallback does NOT encrypt (no crypto seam in dev); it stores
    // the compressed bytes verbatim and digests them. Production wires a sealing
    // store (see the worker `backupArtifactStore` seam).
    this.#objects.set(input.objectKey, input.compressed);
    return {
      digest: await digestBytes(input.compressed),
      sizeBytes: input.compressed.byteLength,
    };
  }

  /** Test/dev accessor: the stored bytes at a key (sealed in production). */
  get(objectKey: string): Uint8Array | undefined {
    return this.#objects.get(objectKey);
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}
