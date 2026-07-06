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
  CapsuleProviderRequirement,
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import type { PolicyConfig } from "takosumi-contract/install-configs";
import type { PageParams } from "takosumi-contract/pagination";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import { errorMessage } from "../deploy-control/projection.ts";
import type {
  OpenTofuDeploymentStore,
  StoredSource,
} from "../deploy-control/store.ts";
import type { Run } from "takosumi-contract/runs";
import type { ObjectStoragePort } from "../../adapters/object-storage/mod.ts";
import {
  normalizedCapsuleArtifactBody,
  normalizedModuleObjectKey,
  parseNormalizedCapsuleArtifactBody,
  StaticHclCapsuleCompatibilityAnalyzer,
  type CapsuleCompatibilityAnalysis,
  type CapsuleCompatibilityAnalyzer,
  type CapsuleSourceFile,
} from "./capsule_compatibility.ts";
import { evaluateSourceUrl } from "./url-policy.ts";
import { canonicalProviderAddress } from "@takosumi/providers";

const DEFAULT_REF = "main";
const DEFAULT_PATH = ".";
const NORMALIZED_CAPSULE_ARTIFACT_BUCKET = "takos-artifacts";
const SOURCE_SYNC_REQUEUE_STALE_MS = 10 * 60 * 1000;

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
  options?: { readonly modulePath?: string },
) => Promise<readonly CapsuleSourceFile[]>;

export interface SourcesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly enqueueSourceSync?: EnqueueSourceSync;
  readonly compatibilityAnalyzer?: CapsuleCompatibilityAnalyzer;
  readonly readCapsuleSourceFiles?: ReadCapsuleSourceFiles;
  readonly normalizedArtifactStorage?: ObjectStoragePort;
  readonly normalizedArtifactBucket?: string;
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
  readonly #sourceFilesCache = new Map<
    string,
    Promise<readonly CapsuleSourceFile[]>
  >();
  readonly #normalizedArtifactStorage?: ObjectStoragePort;
  readonly #normalizedArtifactBucket: string;
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
    this.#normalizedArtifactStorage = deps.normalizedArtifactStorage;
    this.#normalizedArtifactBucket =
      deps.normalizedArtifactBucket ?? NORMALIZED_CAPSULE_ARTIFACT_BUCKET;
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
      workspaceId: request.spaceId,
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
      autoSync: request.autoSync === true,
    };
    await this.#store.putSource(stored);
    return { source: toPublicSource(stored), hookSecret };
  }

  async listSources(
    spaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse> {
    requireNonEmptyString(spaceId, "spaceId");
    const { items, nextCursor } = await this.#store.listSourcesPage(
      spaceId,
      params ?? {},
    );
    return {
      sources: items.map(toPublicSource),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async getSource(id: string): Promise<SourceResponse> {
    const stored = await this.#requireSource(id);
    return { source: toPublicSource(stored) };
  }

  /** Internal: the stored source includes hook hash and lastSeenCommit. */
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
    if (patch.autoSync !== undefined) {
      (next as { autoSync: boolean }).autoSync = patch.autoSync === true;
    }
    (next as { updatedAt: string }).updatedAt = this.#now().toISOString();
    await this.#store.putSource(next);
    return { source: toPublicSource(next) };
  }

  async listSnapshots(
    sourceId: string,
    params?: PageParams,
  ): Promise<ListSourceSnapshotsResponse> {
    await this.#requireSource(sourceId);
    const { items, nextCursor } = await this.#store.listSourceSnapshotsPage(
      sourceId,
      params ?? {},
    );
    return {
      snapshots: items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot> {
    requireNonEmptyString(id, "sourceSnapshotId");
    const snapshot = await this.#store.getSourceSnapshot(id);
    if (!snapshot) {
      throw new OpenTofuControllerError(
        "not_found",
        `source snapshot ${id} not found`,
      );
    }
    return snapshot;
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
      if (existing) {
        if (existing.status === "queued") {
          await this.#enqueue({
            action: "source_sync",
            runId: existing.id,
            spaceId: existing.spaceId,
            sourceId: existing.sourceId,
          });
          return { run: existing };
        }
        if (shouldReplaceStaleRunningSyncRun(existing, this.#now().getTime())) {
          const replaced = await this.#failStaleSyncRun(existing);
          if (!replaced) {
            const current = await this.#activeSyncRun(sourceId);
            return { run: current ?? existing };
          }
          // Fall through and create a fresh run. A per-run owner Durable Object
          // may have terminal state for the old run id, so replacing is more
          // reliable than trying to revive the same id.
        } else {
          return { run: existing };
        }
      }
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
      workspaceId: stored.spaceId,
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
    // Policy precedence: an existing Installation's own InstallConfig wins; only
    // when none is supplied does a curated `installConfigId` (the catalog
    // deep-link path) gate the pre-install check against its bounded policy.
    const context = request.installationId
      ? {
          policy: await this.#compatibilityPolicyForInstallation(
            stored,
            request.installationId,
          ),
        }
      : await this.#compatibilityContextForInstallConfig(
          stored.spaceId,
          request.installConfigId,
        );
    return await this.#runCompatibilityAnalysis({
      snapshot,
      spaceId: stored.spaceId,
      sourceId,
      ...(request.installationId
        ? { installationId: request.installationId }
        : {}),
      ...(request.modulePath ?? context.modulePath
        ? { modulePath: request.modulePath ?? context.modulePath }
        : {}),
      ...(context.policy ? { policy: context.policy } : {}),
    });
  }

  /**
   * Compatibility check for a no-Source {@link SourceSnapshot} (upload or
   * prepared artifact). The snapshot already carries its owning Space, and
   * policy comes from the consumer Installation's InstallConfig (plus the Space
   * policy) rather than from a Source. The Capsule Gate / Normalizer run exactly
   * as they do for a git snapshot.
   */
  async createCompatibilityCheckForSnapshot(
    snapshot: SourceSnapshot,
    options: {
      readonly installationId?: string;
      readonly modulePath?: string;
    } = {},
  ): Promise<CapsuleCompatibilityReportResponse> {
    const policy = await this.#compatibilityPolicyForSnapshot(
      snapshot.spaceId,
      options.installationId,
    );
    return await this.#runCompatibilityAnalysis({
      snapshot,
      spaceId: snapshot.spaceId,
      ...(options.installationId
        ? { installationId: options.installationId }
        : {}),
      ...(options.modulePath ? { modulePath: options.modulePath } : {}),
      ...(policy ? { policy } : {}),
    });
  }

  /**
   * Shared Capsule Gate / Normalizer core used by both the git-Source and the
   * no-Source compatibility paths. `sourceId` is recorded on the run/report only
   * when the snapshot came from a registered Source.
   */
  async #runCompatibilityAnalysis(input: {
    readonly snapshot: SourceSnapshot;
    readonly spaceId: string;
    readonly sourceId?: string;
    readonly installationId?: string;
    readonly modulePath?: string;
    readonly policy?: PolicyConfig;
  }): Promise<CapsuleCompatibilityReportResponse> {
    const { snapshot, spaceId } = input;
    const runId = this.#newId("ccr");
    const nowIso = this.#now().toISOString();
    const runningRun: Run = {
      id: runId,
      workspaceId: spaceId,
      spaceId,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      type: "compatibility_check",
      status: "running",
      sourceSnapshotId: snapshot.id,
      createdBy: "system",
      createdAt: nowIso,
      startedAt: nowIso,
    };
    await this.#store.putCompatibilityCheckRun(runningRun);
    const analysisAttempt =
      await this.#compatibilityAnalysisOrUnsupportedReport(
        snapshot,
        input.modulePath,
        async (files) =>
          await this.#compatibilityAnalyzer.analyze({
            ...(input.sourceId ? { sourceId: input.sourceId } : {}),
            sourceSnapshot: snapshot,
            files,
            ...(input.policy ? { policy: input.policy } : {}),
          }),
      );
    const analysis = analysisAttempt.analysis;
    const normalizedArtifact = await this.#persistNormalizedArtifact(
      snapshot,
      analysis.normalizedFiles,
    );
    const id = this.#newId("caprep");
    const normalizedObjectKey =
      normalizedArtifact?.objectKey ??
      (analysis.normalizedFiles ? undefined : analysis.normalizedObjectKey);
    const normalizedDigest =
      normalizedArtifact?.digest ??
      (analysis.normalizedFiles ? undefined : analysis.normalizedDigest);
    const report: CapsuleCompatibilityReport = {
      id,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.installationId ? { installationId: input.installationId } : {}),
      sourceSnapshotId: snapshot.id,
      level: analysis.level,
      findings: analysis.findings,
      providers: analysis.providers,
      resources: analysis.resources,
      dataSources: analysis.dataSources,
      provisioners: analysis.provisioners,
      rootModuleVariables: analysis.rootModuleVariables,
      rootModuleOutputs: analysis.rootModuleOutputs,
      ...(normalizedObjectKey ? { normalizedObjectKey } : {}),
      ...(normalizedDigest ? { normalizedDigest } : {}),
      createdAt: this.#now().toISOString(),
    };
    await this.#store.putCapsuleCompatibilityReport(report);
    const succeededRun: Run = {
      ...runningRun,
      status: "succeeded",
      compatibilityReportId: report.id,
      ...(analysisAttempt.diagnosticMessage
        ? { errorCode: analysisAttempt.diagnosticMessage }
        : {}),
      finishedAt: this.#now().toISOString(),
    };
    await this.#store.putCompatibilityCheckRun(succeededRun);
    return { report, run: succeededRun };
  }

  async #compatibilityAnalysisOrUnsupportedReport(
    snapshot: SourceSnapshot,
    modulePath: string | undefined,
    analyze: (
      files: readonly CapsuleSourceFile[],
    ) => Promise<CapsuleCompatibilityAnalysis>,
  ): Promise<{
    readonly analysis: CapsuleCompatibilityAnalysis;
    readonly diagnosticMessage?: string;
  }> {
    try {
      const files = await this.#readCapsuleSourceFilesCached(
        snapshot,
        modulePath ? { modulePath } : undefined,
      );
      return { analysis: await analyze(files) };
    } catch (error) {
      return {
        analysis: compatibilityCheckFailureAnalysis(snapshot, error),
        diagnosticMessage: errorMessage(error),
      };
    }
  }

  /**
   * Records an upload-origin {@link SourceSnapshot}: the archive bytes are
   * already in R2_SOURCE (written by the upload route); this only persists the
   * ledger row. No Source, no Runner git clone. `resolvedCommit` is the bare
   * 64-hex digest so the downstream plan module-source descriptor validates as
   * a content-pinned source, and `url` is a self-describing upload origin.
   */
  async recordUploadSnapshot(input: {
    readonly spaceId: string;
    readonly archiveObjectKey: string;
    readonly archiveDigest: string;
    readonly archiveSizeBytes: number;
    readonly path?: string;
    /** Pre-generated id so the caller can key the R2 archive before recording. */
    readonly snapshotId?: string;
  }): Promise<SourceSnapshot> {
    requireNonEmptyString(input.spaceId, "spaceId");
    requireNonEmptyString(input.archiveObjectKey, "archiveObjectKey");
    requireNonEmptyString(input.archiveDigest, "archiveDigest");
    const snapshotId = nonEmpty(input.snapshotId) ?? this.#newId("snap");
    const hexDigest = snapshotDigestHex(input.archiveDigest);
    const snapshot: SourceSnapshot = {
      id: snapshotId,
      origin: "upload",
      workspaceId: input.spaceId,
      spaceId: input.spaceId,
      url: `https://uploads.takosumi.com/${input.spaceId}`,
      ref: "upload",
      resolvedCommit: hexDigest.toLowerCase(),
      path: safeSnapshotPath(input.path),
      archiveObjectKey: input.archiveObjectKey,
      archiveDigest: input.archiveDigest,
      archiveSizeBytes: input.archiveSizeBytes,
      fetchedByRunId: "upload",
      fetchedAt: this.#now().toISOString(),
    };
    await this.#store.putSourceSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Records a digest-pinned legacy prepared source archive as a SourceSnapshot.
   * The archive bytes are already verified and stored in R2_SOURCE by the
   * API/facade route. This is compatibility ingest for already-archived
   * OpenTofu source bytes, not a deployable app artifact or build contract.
   */
  async recordArtifactSnapshot(input: {
    readonly spaceId: string;
    readonly url: string;
    readonly archiveObjectKey: string;
    readonly archiveDigest: string;
    readonly archiveSizeBytes: number;
    readonly path?: string;
    readonly snapshotId?: string;
  }): Promise<SourceSnapshot> {
    requireNonEmptyString(input.spaceId, "spaceId");
    requireNonEmptyString(input.url, "url");
    requireNonEmptyString(input.archiveObjectKey, "archiveObjectKey");
    requireNonEmptyString(input.archiveDigest, "archiveDigest");
    const snapshotId = nonEmpty(input.snapshotId) ?? this.#newId("snap");
    const hexDigest = snapshotDigestHex(input.archiveDigest);
    const snapshot: SourceSnapshot = {
      id: snapshotId,
      origin: "artifact",
      workspaceId: input.spaceId,
      spaceId: input.spaceId,
      url: input.url.trim(),
      ref: "artifact",
      resolvedCommit: hexDigest,
      path: safeSnapshotPath(input.path),
      archiveObjectKey: input.archiveObjectKey,
      archiveDigest: input.archiveDigest,
      archiveSizeBytes: input.archiveSizeBytes,
      fetchedByRunId: "artifact",
      fetchedAt: this.#now().toISOString(),
    };
    await this.#store.putSourceSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Capsule Gate policy for a no-Source snapshot. Same merge of Space
   * policy + InstallConfig policy as {@link #compatibilityPolicyForInstallation}
   * but without the Source-id match (upload/artifact installations have no
   * Source).
   */
  async #compatibilityPolicyForSnapshot(
    spaceId: string,
    installationId: string | undefined,
  ): Promise<PolicyConfig | undefined> {
    if (!installationId) return undefined;
    const installation = await this.#store.getInstallation(installationId);
    if (!installation) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${installationId} does not exist`,
      );
    }
    if (installation.spaceId !== spaceId) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `installation ${installationId} is not in space ${spaceId}`,
      );
    }
    const [space, config] = await Promise.all([
      this.#store.getSpace(installation.spaceId),
      this.#store.getInstallConfig(installation.installConfigId),
    ]);
    return mergePolicyConfigs(space?.policy, config?.policy);
  }

  async #compatibilityPolicyForInstallation(
    source: StoredSource,
    installationId: string | undefined,
  ): Promise<PolicyConfig | undefined> {
    if (!installationId) return undefined;
    const installation = await this.#store.getInstallation(installationId);
    if (!installation) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${installationId} does not exist`,
      );
    }
    if (installation.spaceId !== source.spaceId) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `installation ${installationId} is not in source space ${source.spaceId}`,
      );
    }
    if (installation.sourceId !== source.id) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `installation ${installationId} does not use source ${source.id}`,
      );
    }
    const [space, config] = await Promise.all([
      this.#store.getSpace(installation.spaceId),
      this.#store.getInstallConfig(installation.installConfigId),
    ]);
    return mergePolicyConfigs(space?.policy, config?.policy);
  }

  /**
   * Resolves the Capsule Gate policy for a pre-install compatibility check that
   * carries a curated `installConfigId` but no Installation yet (the catalog
   * "選んで入れる" deep-link). The InstallConfig's bounded policy is merged with
   * the Space policy as a ceiling, exactly as {@link
   * #compatibilityPolicyForInstallation} does for an existing Installation. The
   * instance-wide default allowlist is never touched: the analyzer UNIONs this
   * bounded policy with the default, so the extra allowance is scoped to this
   * single vetted config and the SAME policy is enforced again at plan/apply.
   * A built-in `official` config (no `spaceId`) is usable from any Space; a
   * Space-scoped config must belong to this Space.
   */
  async #compatibilityPolicyForInstallConfig(
    spaceId: string,
    installConfigId: string | undefined,
  ): Promise<PolicyConfig | undefined> {
    return (
      await this.#compatibilityContextForInstallConfig(spaceId, installConfigId)
    ).policy;
  }

  async #compatibilityContextForInstallConfig(
    spaceId: string,
    installConfigId: string | undefined,
  ): Promise<{
    readonly policy?: PolicyConfig;
    readonly modulePath?: string;
  }> {
    if (!installConfigId) return {};
    const config = await this.#store.getInstallConfig(installConfigId);
    if (!config) {
      throw new OpenTofuControllerError(
        "not_found",
        `install config ${installConfigId} does not exist`,
      );
    }
    if (config.spaceId !== undefined && config.spaceId !== spaceId) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `install config ${installConfigId} is not available in space ${spaceId}`,
      );
    }
    const space = await this.#store.getSpace(spaceId);
    return {
      policy: mergePolicyConfigs(space?.policy, config.policy),
      ...(config.modulePath ? { modulePath: config.modulePath } : {}),
    };
  }

  async #persistNormalizedArtifact(
    snapshot: SourceSnapshot,
    files: readonly CapsuleSourceFile[] | undefined,
  ): Promise<
    { readonly objectKey: string; readonly digest: string } | undefined
  > {
    if (!files || files.length === 0 || !this.#normalizedArtifactStorage) {
      return undefined;
    }
    const objectKey = normalizedModuleObjectKey(snapshot);
    const body = normalizedCapsuleArtifactBody({
      sourceSnapshot: snapshot,
      files,
    });
    const head = await this.#normalizedArtifactStorage.putObject({
      bucket: this.#normalizedArtifactBucket,
      key: objectKey,
      body,
      contentType: "application/json; charset=utf-8",
      metadata: {
        "takosumi-kind": "normalized-capsule",
        "takosumi-source-snapshot-id": snapshot.id,
      },
    });
    return { objectKey, digest: head.digest };
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

  async readNormalizedCapsuleArtifact(input: {
    readonly sourceSnapshot: SourceSnapshot;
    readonly objectKey: string;
    readonly digest: `sha256:${string}`;
  }): Promise<readonly CapsuleSourceFile[]> {
    if (!this.#normalizedArtifactStorage) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "normalized capsule artifact storage is not configured",
      );
    }
    const object = await this.#normalizedArtifactStorage.getObject({
      bucket: this.#normalizedArtifactBucket,
      key: input.objectKey,
      expectedDigest: input.digest,
    });
    if (!object) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `normalized_capsule_artifact_missing: ${input.objectKey}`,
      );
    }
    let artifact;
    try {
      artifact = parseNormalizedCapsuleArtifactBody(
        new TextDecoder().decode(object.body),
      );
    } catch (error) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `normalized_capsule_artifact_invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      artifact.sourceSnapshotId !== input.sourceSnapshot.id ||
      artifact.resolvedCommit !== input.sourceSnapshot.resolvedCommit ||
      artifact.path !== input.sourceSnapshot.path
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `normalized_capsule_artifact_snapshot_mismatch: artifact ${input.objectKey} ` +
          `does not match SourceSnapshot ${input.sourceSnapshot.id}`,
      );
    }
    return artifact.files;
  }

  /**
   * Expands a SourceSnapshot archive through the same runner boundary used by
   * compatibility checks. Callers use this for source-derived execution wiring
   * that must not require a Takosumi-specific manifest in the user repo.
   */
  readCapsuleSourceFiles(
    sourceSnapshot: SourceSnapshot,
    options?: { readonly modulePath?: string },
  ): Promise<readonly CapsuleSourceFile[]> {
    return this.#readCapsuleSourceFilesCached(sourceSnapshot, options);
  }

  #readCapsuleSourceFilesCached(
    sourceSnapshot: SourceSnapshot,
    options?: { readonly modulePath?: string },
  ): Promise<readonly CapsuleSourceFile[]> {
    const modulePath = modulePathWithinSnapshotArchive(
      sourceSnapshot,
      options?.modulePath,
    );
    const normalizedOptions = modulePath ? { modulePath } : undefined;
    const key = `${sourceSnapshot.id}\0${modulePath ?? ""}`;
    const existing = this.#sourceFilesCache.get(key);
    if (existing) return existing;
    const pending = this.#readCapsuleSourceFiles(
      sourceSnapshot,
      normalizedOptions,
    ).catch((error: unknown) => {
      this.#sourceFilesCache.delete(key);
      throw error;
    });
    this.#sourceFilesCache.set(key, pending);
    return pending;
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

  async #failStaleSyncRun(run: SourceSyncRun): Promise<boolean> {
    const now = this.#now();
    const failed: SourceSyncRun = {
      ...run,
      status: "failed",
      updatedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      heartbeatAt: now.getTime(),
      error: "stale_source_sync_replaced",
    };
    const result = await this.#store.transitionRun({
      id: run.id,
      kind: "source_sync",
      expectFrom: ["running"],
      expectHeartbeatAt: run.heartbeatAt ?? null,
      run: failed,
      clearLeaseToken: true,
      heartbeatAt: failed.heartbeatAt,
    });
    return result.won;
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

/**
 * R2_SOURCE archive key layout for an upload-origin snapshot (no Source id).
 * Internal/operator upload-compat ingest writes the Capsule archive here before
 * recording the upload {@link SourceSnapshot}.
 */
export function uploadArchiveObjectKey(
  spaceId: string,
  snapshotId: string,
): string {
  return `spaces/${spaceId}/uploads/${snapshotId}/source.tar.zst`;
}

/**
 * R2_SOURCE archive key layout for a digest-pinned prepared artifact snapshot.
 */
export function artifactArchiveObjectKey(
  spaceId: string,
  snapshotId: string,
): string {
  return `spaces/${spaceId}/artifact-snapshots/${snapshotId}/source.tar.zst`;
}

export { normalizedModuleObjectKey };

function snapshotDigestHex(digest: string): string {
  return (
    digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest
  ).toLowerCase();
}

function safeSnapshotPath(path: string | undefined): string {
  const value = nonEmpty(path) ?? DEFAULT_PATH;
  if (
    value.startsWith("/") ||
    value.split(/[\\/]+/).some((part) => part === "..") ||
    value.includes("\0")
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "SourceSnapshot path must be a safe relative path",
    );
  }
  return value;
}

function modulePathWithinSnapshotArchive(
  snapshot: SourceSnapshot,
  modulePath: string | undefined,
): string | undefined {
  const requested = normalizeRelativeModulePath(modulePath);
  if (!requested) return undefined;
  const snapshotPath = normalizeRelativeModulePath(snapshot.path);
  if (!snapshotPath) return requested;
  if (requested === snapshotPath) return undefined;
  const prefix = `${snapshotPath}/`;
  if (requested.startsWith(prefix)) {
    return requested.slice(prefix.length) || undefined;
  }
  return requested;
}

function normalizeRelativeModulePath(
  path: string | undefined,
): string | undefined {
  const value = nonEmpty(path);
  if (!value || value === ".") return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === ".") return undefined;
  return normalized.replace(/\/+$/g, "");
}

function compatibilityCheckFailureAnalysis(
  snapshot: SourceSnapshot,
  _error: unknown,
): CapsuleCompatibilityAnalysis {
  return {
    level: "unsupported",
    findings: [
      {
        severity: "error",
        code: "capsule_compatibility_check_failed",
        message: "Takosumi could not inspect this Capsule before installation.",
        path: snapshot.path,
        suggestion:
          "Retry the check after source sync finishes. If it still fails, ask the operator to inspect the compatibility_check runner.",
      },
    ],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: [],
    rootModuleOutputs: [],
    normalizedObjectKey: snapshot.archiveObjectKey,
    normalizedDigest: snapshot.archiveDigest,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function shouldReplaceStaleRunningSyncRun(
  run: SourceSyncRun,
  nowMs: number,
): boolean {
  if (run.status !== "running") return false;
  return nowMs - (run.heartbeatAt ?? 0) > SOURCE_SYNC_REQUEUE_STALE_MS;
}

function defaultHookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `whk_${hex}`;
}

function mergePolicyConfigs(
  spacePolicy: PolicyConfig | undefined,
  installPolicy: PolicyConfig | undefined,
): PolicyConfig | undefined {
  if (!spacePolicy && !installPolicy) return undefined;
  return {
    allowedProviders: intersectOptionalLists(
      spacePolicy?.allowedProviders,
      installPolicy?.allowedProviders,
    ),
    allowedResourceTypes: intersectOptionalLists(
      spacePolicy?.allowedResourceTypes,
      installPolicy?.allowedResourceTypes,
    ),
    allowedDataSourceTypes: intersectOptionalLists(
      spacePolicy?.allowedDataSourceTypes,
      installPolicy?.allowedDataSourceTypes,
    ),
    allowedProvisionerTypes: intersectOptionalLists(
      spacePolicy?.allowedProvisionerTypes,
      installPolicy?.allowedProvisionerTypes,
    ),
    destructiveChanges:
      installPolicy?.destructiveChanges ?? spacePolicy?.destructiveChanges,
    providerLockfile:
      installPolicy?.providerLockfile ?? spacePolicy?.providerLockfile,
    providerInstallation:
      installPolicy?.providerInstallation ?? spacePolicy?.providerInstallation,
    scopeBoundary: installPolicy?.scopeBoundary ?? spacePolicy?.scopeBoundary,
    quota: { ...(spacePolicy?.quota ?? {}), ...(installPolicy?.quota ?? {}) },
  };
}

function intersectOptionalLists(
  ceiling: readonly string[] | undefined,
  local: readonly string[] | undefined,
): readonly string[] | undefined {
  if (ceiling === undefined) return local;
  if (local === undefined) return ceiling;
  const allowed = new Set(ceiling);
  return local.filter((entry) => allowed.has(entry)).sort();
}

function timingSafeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
