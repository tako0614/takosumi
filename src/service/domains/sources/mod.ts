/**
 * Source domain service (Core Specification §6 / §7).
 *
 * Owns the Source lifecycle (register / list / get / patch), the per-source
 * webhook secret (generate once, store hashed), and SourceSyncRun creation +
 * enqueue. Resolution itself never runs here: registration validates shape +
 * URL policy and stores the Source `active`; the archive fetch / `git ls-remote`
 * happens in the untrusted Runner Container via the queued `source_sync` run.
 */

import type {
  CreateSourceRequest,
  CreateSourceResponse,
  CreateSourceSyncResponse,
  ListSourcesResponse,
  ListSourceSnapshotsResponse,
  PatchSourceRequest,
  Source,
  SourceResponse,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type {
  CapsuleCompatibilityReport,
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type {
  OpenTofuDeploymentStore,
  StoredSource,
} from "../deploy-control/store.ts";
import {
  StaticHclCapsuleCompatibilityAnalyzer,
  type CapsuleCompatibilityAnalyzer,
  type CapsuleSourceFile,
} from "./capsule_compatibility.ts";
import { evaluateSourceUrl } from "./url-policy.ts";

const DEFAULT_REF = "main";
const DEFAULT_PATH = ".";

/**
 * Out-of-process source-sync dispatch seam. Mirrors the deploy-control
 * `EnqueueRun`: the create path persists the run `queued` and hands the run
 * identity to the enqueuer; the actual resolution runs later in the queue
 * consumer. Defaults to a no-op so callers without a queue keep the run queued
 * (the inline/local path drives it differently in M2).
 */
export type EnqueueSourceSync = (dispatch: {
  readonly action: "source_sync";
  readonly runId: string;
  readonly spaceId: string;
  readonly sourceId: string;
}) => Promise<void>;

export type ReadCapsuleSourceFiles = (
  snapshot: SourceSnapshot,
) => Promise<readonly CapsuleSourceFile[]>;

export interface SourcesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly enqueueSourceSync?: EnqueueSourceSync;
  readonly compatibilityAnalyzer?: CapsuleCompatibilityAnalyzer;
  readonly readCapsuleSourceFiles?: ReadCapsuleSourceFiles;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
  /** Per-source webhook secret generator. Defaults to a random URL-safe token. */
  readonly newHookSecret?: () => string;
}

export class SourcesService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #enqueue: EnqueueSourceSync;
  readonly #compatibilityAnalyzer: CapsuleCompatibilityAnalyzer;
  readonly #readCapsuleSourceFiles: ReadCapsuleSourceFiles;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  readonly #newHookSecret: () => string;

  constructor(deps: SourcesServiceDependencies) {
    this.#store = deps.store;
    this.#enqueue = deps.enqueueSourceSync ?? (() => Promise.resolve());
    this.#compatibilityAnalyzer =
      deps.compatibilityAnalyzer ?? new StaticHclCapsuleCompatibilityAnalyzer();
    this.#readCapsuleSourceFiles =
      deps.readCapsuleSourceFiles ?? (() => Promise.resolve([]));
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
    this.#newHookSecret = deps.newHookSecret ?? defaultHookSecret;
  }

  /**
   * Registers a Source. Validates the URL policy (§7.1) and, when an
   * `authConnectionId` is supplied, checks the connection exists in the same
   * space. Generates and returns the hook secret EXACTLY ONCE; stores its hash.
   * Does NOT perform ls-remote (that is a queued source_sync); status is
   * `active`.
   */
  async createSource(
    request: CreateSourceRequest,
  ): Promise<CreateSourceResponse> {
    requireNonEmptyString(request.spaceId, "spaceId");
    requireNonEmptyString(request.name, "name");
    requireNonEmptyString(request.url, "url");
    const policy = evaluateSourceUrl(request.url);
    if (!policy.ok) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `source url is not allowed (${policy.reason})`,
      );
    }
    const defaultRef = nonEmpty(request.defaultRef) ?? DEFAULT_REF;
    const defaultPath = nonEmpty(request.defaultPath) ?? DEFAULT_PATH;
    if (request.authConnectionId !== undefined) {
      requireNonEmptyString(request.authConnectionId, "authConnectionId");
      await this.#requireConnectionInSpace(
        request.authConnectionId,
        request.spaceId,
      );
    }

    const id = this.#newId("src");
    const hookSecret = this.#newHookSecret();
    const hookSecretHash = await sha256HexOfStringAsync(hookSecret);
    const nowIso = this.#now().toISOString();
    const stored: StoredSource = {
      id,
      spaceId: request.spaceId,
      name: request.name,
      url: request.url.trim(),
      defaultRef,
      defaultPath,
      ...(request.authConnectionId
        ? { authConnectionId: request.authConnectionId }
        : {}),
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
      hookSecretHash,
      autoSync: false,
    };
    await this.#store.putSource(stored);
    return { source: toPublicSource(stored), hookSecret };
  }

  async listSources(spaceId: string): Promise<ListSourcesResponse> {
    requireNonEmptyString(spaceId, "spaceId");
    const rows = await this.#store.listSources(spaceId);
    return { sources: rows.map(toPublicSource) };
  }

  async getSource(id: string): Promise<SourceResponse> {
    const stored = await this.#requireSource(id);
    return { source: toPublicSource(stored) };
  }

  /** Internal: the stored source (with hook hash / autoSync). Not projected. */
  async getStoredSource(id: string): Promise<StoredSource> {
    return await this.#requireSource(id);
  }

  async patchSource(
    id: string,
    patch: PatchSourceRequest,
  ): Promise<SourceResponse> {
    const stored = await this.#requireSource(id);
    const next: StoredSource = { ...stored };
    if (patch.name !== undefined) {
      requireNonEmptyString(patch.name, "name");
      (next as { name: string }).name = patch.name;
    }
    if (patch.defaultRef !== undefined) {
      (next as { defaultRef: string }).defaultRef =
        nonEmpty(patch.defaultRef) ?? DEFAULT_REF;
    }
    if (patch.defaultPath !== undefined) {
      (next as { defaultPath: string }).defaultPath =
        nonEmpty(patch.defaultPath) ?? DEFAULT_PATH;
    }
    if (patch.authConnectionId !== undefined) {
      if (patch.authConnectionId === null) {
        delete (next as { authConnectionId?: string }).authConnectionId;
      } else {
        requireNonEmptyString(patch.authConnectionId, "authConnectionId");
        await this.#requireConnectionInSpace(
          patch.authConnectionId,
          stored.spaceId,
        );
        (next as { authConnectionId?: string }).authConnectionId =
          patch.authConnectionId;
      }
    }
    if (patch.status !== undefined) {
      (next as { status: StoredSource["status"] }).status = patch.status;
    }
    (next as { updatedAt: string }).updatedAt = this.#now().toISOString();
    await this.#store.putSource(next);
    return { source: toPublicSource(next) };
  }

  async listSnapshots(sourceId: string): Promise<ListSourceSnapshotsResponse> {
    await this.#requireSource(sourceId);
    return { snapshots: await this.#store.listSourceSnapshots(sourceId) };
  }

  /**
   * Scheduler scan: active sources whose autoSync flag is set, capped at
   * `limit`. Returns the public Source records (the scheduler only needs the id).
   */
  async listAutoSyncSources(limit: number): Promise<readonly Source[]> {
    const rows = await this.#store.listSources();
    const out: Source[] = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      if (row.status === "active" && row.autoSync) {
        out.push(toPublicSource(row));
      }
    }
    return out;
  }

  /**
   * Creates a source_sync run for the source's default ref and enqueues it. The
   * archive object key is precomputed per the agreed R2_SOURCE layout. Dedup:
   * when a run is already `queued`/`running` for this source, returns it instead
   * of creating a duplicate (used by the webhook / scheduler).
   */
  async createSync(
    sourceId: string,
    options: { readonly dedupe?: boolean } = {},
  ): Promise<CreateSourceSyncResponse> {
    const stored = await this.#requireSource(sourceId);
    if (options.dedupe) {
      const existing = await this.#activeSyncRun(sourceId);
      if (existing) return { run: existing };
    }
    const runId = this.#newId("ssr");
    const snapshotId = this.#newId("snap");
    const archiveObjectKey = sourceArchiveObjectKey(
      stored.spaceId,
      sourceId,
      snapshotId,
    );
    const nowIso = this.#now().toISOString();
    const run: SourceSyncRun = {
      id: runId,
      kind: "source_sync",
      spaceId: stored.spaceId,
      sourceId,
      url: stored.url,
      ref: stored.defaultRef,
      path: stored.defaultPath,
      archiveObjectKey,
      status: "queued",
      createdAt: nowIso,
      updatedAt: nowIso,
      snapshotId,
    };
    await this.#store.putSourceSyncRun(run);
    await this.#enqueue({
      action: "source_sync",
      runId,
      spaceId: stored.spaceId,
      sourceId,
    });
    return { run };
  }

  async createCompatibilityCheck(
    sourceId: string,
    request: CreateSourceCompatibilityCheckRequest = {},
  ): Promise<CapsuleCompatibilityReportResponse> {
    const stored = await this.#requireSource(sourceId);
    const snapshot = await this.#resolveCompatibilitySnapshot(
      sourceId,
      request.sourceSnapshotId,
    );
    const files = await this.#readCapsuleSourceFiles(snapshot);
    const analysis = await this.#compatibilityAnalyzer.analyze({
      sourceId,
      sourceSnapshot: snapshot,
      files,
    });
    const id = this.#newId("caprep");
    const report: CapsuleCompatibilityReport = {
      id,
      sourceId,
      ...(request.installationId
        ? { installationId: request.installationId }
        : {}),
      sourceSnapshotId: snapshot.id,
      level: analysis.level,
      findings: analysis.findings,
      providers: analysis.providers,
      resources: analysis.resources,
      dataSources: analysis.dataSources,
      provisioners: analysis.provisioners,
      normalizedObjectKey: analysis.normalizedObjectKey,
      normalizedDigest: analysis.normalizedDigest,
      createdAt: this.#now().toISOString(),
    };
    await this.#store.putCapsuleCompatibilityReport(report);
    void stored;
    return { report };
  }

  async getCompatibilityReport(
    id: string,
  ): Promise<CapsuleCompatibilityReportResponse> {
    requireNonEmptyString(id, "reportId");
    const report = await this.#store.getCapsuleCompatibilityReport(id);
    if (!report) {
      throw new OpenTofuControllerError(
        "not_found",
        `compatibility report ${id} not found`,
      );
    }
    return { report };
  }

  async getSyncRun(id: string): Promise<SourceSyncRun> {
    requireNonEmptyString(id, "runId");
    const run = await this.#store.getSourceSyncRun(id);
    if (!run) {
      throw new OpenTofuControllerError(
        "not_found",
        `source sync run ${id} not found`,
      );
    }
    return run;
  }

  async #resolveCompatibilitySnapshot(
    sourceId: string,
    requestedSnapshotId: string | undefined,
  ): Promise<SourceSnapshot> {
    const snapshots = await this.#store.listSourceSnapshots(sourceId);
    if (requestedSnapshotId !== undefined) {
      requireNonEmptyString(requestedSnapshotId, "sourceSnapshotId");
      const snapshot = snapshots.find((row) => row.id === requestedSnapshotId);
      if (!snapshot) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `sourceSnapshotId ${requestedSnapshotId} does not exist for source ${sourceId}`,
        );
      }
      return snapshot;
    }
    const latest = snapshots.at(-1);
    if (!latest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source_sync_required: source ${sourceId} has no SourceSnapshot; run a source sync first`,
      );
    }
    return latest;
  }

  /**
   * Verifies a webhook bearer against the source's stored hook-secret hash
   * (constant-time on the hex compare). Returns true when valid.
   */
  async verifyHookSecret(
    sourceId: string,
    presentedSecret: string,
  ): Promise<boolean> {
    const stored = await this.#store.getSource(sourceId);
    if (!stored) return false;
    if (typeof presentedSecret !== "string" || presentedSecret.length === 0) {
      return false;
    }
    const presentedHash = await sha256HexOfStringAsync(presentedSecret);
    return timingSafeHexEquals(presentedHash, stored.hookSecretHash);
  }

  async #activeSyncRun(sourceId: string): Promise<SourceSyncRun | undefined> {
    const runs = await this.#store.listSourceSyncRuns(sourceId);
    return runs.find(
      (run) => run.status === "queued" || run.status === "running",
    );
  }

  async #requireSource(id: string): Promise<StoredSource> {
    requireNonEmptyString(id, "sourceId");
    const stored = await this.#store.getSource(id);
    if (!stored) {
      throw new OpenTofuControllerError("not_found", `source ${id} not found`);
    }
    return stored;
  }

  async #requireConnectionInSpace(
    connectionId: string,
    spaceId: string,
  ): Promise<void> {
    const connection = await this.#store.getConnection(connectionId);
    if (!connection || connection.spaceId !== spaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `authConnectionId ${connectionId} does not exist in space ${spaceId}`,
      );
    }
  }
}

/** Strips the internal fields off a stored source for the public API. */
export function toPublicSource(stored: StoredSource): Source {
  const {
    hookSecretHash: _hookSecretHash,
    lastSeenCommit: _lastSeenCommit,
    autoSync: _autoSync,
    ...rest
  } = stored;
  return rest;
}

/** R2_SOURCE archive key layout (agreed contract). */
export function sourceArchiveObjectKey(
  spaceId: string,
  sourceId: string,
  snapshotId: string,
): string {
  return `spaces/${spaceId}/sources/${sourceId}/snapshots/${snapshotId}/source.tar.zst`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function defaultHookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `whk_${hex}`;
}

function timingSafeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
