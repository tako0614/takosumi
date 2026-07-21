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
  SourceSyncIntent,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type {
  CapsuleCompatibilityReport,
  CapsuleProviderRequirement,
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import { normalizeCompatibilityReportModulePath } from "takosumi-contract/capsules";
import type { PolicyConfig } from "takosumi-contract/install-configs";
import { normalizeScopeBoundaryPolicy } from "takosumi-contract";
import { timingSafeEqualHex } from "takosumi-contract/internal/crypto";
import type { PageParams } from "takosumi-contract/pagination";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
  sourceSyncRequiredError,
} from "../deploy-control/errors.ts";
import type {
  OpenTofuControlStore,
  StoredSource,
} from "../deploy-control/store.ts";
import type { Run } from "takosumi-contract/runs";
import {
  StaticHclCapsuleCompatibilityAnalyzer,
  type CapsuleCompatibilityAnalysis,
  type CapsuleCompatibilityAnalyzer,
  type CapsuleSourceFile,
} from "./capsule_compatibility.ts";
import { evaluateSourceUrl } from "./url-policy.ts";
import { canonicalProviderAddress } from "@takosumi/providers";
import type { ArtifactReferenceAllocator } from "../../adapters/storage/artifact-references.ts";

// Git already has a provider-neutral spelling for the remote's configured
// default branch. Do not guess `main`/`master`: an omitted ref means HEAD,
// while an explicitly supplied branch remains exact.
const DEFAULT_REF = "HEAD";
const DEFAULT_PATH = ".";
const REPOSITORY_INSTALL_METADATA_PATH = ".well-known/tcs.json";
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
  readonly workspaceId: string;
  readonly sourceId: string;
}) => Promise<void>;

export type ReadCapsuleSourceFiles = (
  snapshot: SourceSnapshot,
  options?: { readonly modulePath?: string; readonly runId?: string },
) => Promise<readonly CapsuleSourceFile[]>;

export interface SourcesServiceDependencies {
  readonly store: OpenTofuControlStore;
  /** Host authority for opaque durable source-archive references. */
  readonly artifactReferenceAllocator?: ArtifactReferenceAllocator;
  readonly enqueueSourceSync?: EnqueueSourceSync;
  readonly compatibilityAnalyzer?: CapsuleCompatibilityAnalyzer;
  readonly readCapsuleSourceFiles?: ReadCapsuleSourceFiles;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
  /** Per-source webhook secret generator. Defaults to a random URL-safe token. */
  readonly newHookSecret?: () => string;
}

export class SourcesService {
  readonly #store: OpenTofuControlStore;
  readonly #artifactReferenceAllocator?: ArtifactReferenceAllocator;
  readonly #enqueue: EnqueueSourceSync;
  readonly #compatibilityAnalyzer: CapsuleCompatibilityAnalyzer;
  readonly #readCapsuleSourceFiles: ReadCapsuleSourceFiles;
  readonly #sourceFilesCache = new Map<
    string,
    Promise<readonly CapsuleSourceFile[]>
  >();
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  readonly #newHookSecret: () => string;

  constructor(deps: SourcesServiceDependencies) {
    this.#store = deps.store;
    this.#artifactReferenceAllocator = deps.artifactReferenceAllocator;
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
   * Workspace. Generates and returns the hook secret EXACTLY ONCE; stores its hash.
   * Does NOT perform ls-remote (that is a queued source_sync); status is
   * `active`.
   */
  async createSource(
    request: CreateSourceRequest,
  ): Promise<CreateSourceResponse> {
    requireNonEmptyString(request.workspaceId, "workspaceId");
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
      await this.#requireConnectionInWorkspace(
        request.authConnectionId,
        request.workspaceId,
      );
    }

    const id = this.#newId("src");
    const hookSecret = this.#newHookSecret();
    const hookSecretHash = await sha256HexOfStringAsync(hookSecret);
    const nowIso = this.#now().toISOString();
    const stored: StoredSource = {
      id,
      workspaceId: request.workspaceId,
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
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const { items, nextCursor } = await this.#store.listSourcesPage(
      workspaceId,
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
        await this.#requireConnectionInWorkspace(
          patch.authConnectionId,
          stored.workspaceId,
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
   * archive reference is allocated by the host storage adapter. Dedup:
   * when a run is already `queued`/`running` for this source, returns it instead
   * of creating a duplicate (used by the webhook / scheduler).
   */
  async createSync(
    sourceId: string,
    options: {
      readonly dedupe?: boolean;
      readonly intent?: SourceSyncIntent;
    } = {},
  ): Promise<CreateSourceSyncResponse> {
    const stored = await this.#requireSource(sourceId);
    const intent = options.intent ?? "observe";
    if (options.dedupe) {
      const existing = await this.#activeSyncRun(sourceId, intent);
      if (existing) {
        if (existing.status === "queued") {
          await this.#enqueue({
            action: "source_sync",
            runId: existing.id,
            workspaceId: existing.workspaceId,
            sourceId: existing.sourceId,
          });
          return { run: existing };
        }
        if (shouldReplaceStaleRunningSyncRun(existing, this.#now().getTime())) {
          const replaced = await this.#failStaleSyncRun(existing);
          if (!replaced) {
            const current = await this.#activeSyncRun(sourceId, intent);
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
    if (!this.#artifactReferenceAllocator) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "source sync requires an artifact-reference allocator",
      );
    }
    const archiveRef = await this.#artifactReferenceAllocator.allocate({
      kind: "source_archive",
      workspaceId: stored.workspaceId,
      sourceId,
      snapshotId,
    });
    requireNonEmptyString(archiveRef, "archiveRef");
    const nowIso = this.#now().toISOString();
    const run: SourceSyncRun = {
      id: runId,
      kind: "source_sync",
      workspaceId: stored.workspaceId,
      sourceId,
      url: stored.url,
      ref: stored.defaultRef,
      path: stored.defaultPath,
      archiveRef,
      intent,
      status: "queued",
      createdAt: nowIso,
      updatedAt: nowIso,
      snapshotId,
    };
    await this.#store.putSourceSyncRun(run);
    await this.#enqueue({
      action: "source_sync",
      runId,
      workspaceId: stored.workspaceId,
      sourceId,
    });
    return { run };
  }

  async createCompatibilityCheck(
    sourceId: string,
    request: CreateSourceCompatibilityCheckRequest = {},
  ): Promise<CapsuleCompatibilityReportResponse> {
    const stored = await this.#requireSource(sourceId);
    const capsuleId = request.capsuleId;
    const snapshot = await this.#resolveCompatibilitySnapshot(
      sourceId,
      request.sourceSnapshotId,
    );
    // Policy precedence: an existing Capsule's own InstallConfig wins. Before a
    // Capsule exists, the service-side InstallConfig only gates the
    // pre-install check against bounded policy/module-path hints; Store
    // listings themselves are discovery/presentation metadata, not execution
    // authority.
    const context = capsuleId
      ? await this.#compatibilityContextForCapsule(stored, capsuleId)
      : await this.#compatibilityContextForInstallConfig(
          stored.workspaceId,
          request.installConfigId,
        );
    // Module path precedence mirrors policy precedence: an existing Capsule
    // executes its own InstallConfig path, so a caller-supplied path must not
    // be able to produce a Capsule-scoped report that describes a different
    // module than the one the Capsule will actually plan.
    const modulePath = capsuleId
      ? context.modulePath
      : (request.modulePath ?? context.modulePath);
    return await this.#runCompatibilityAnalysis({
      snapshot,
      workspaceId: stored.workspaceId,
      sourceId,
      ...(capsuleId ? { capsuleId } : {}),
      ...(modulePath ? { modulePath } : {}),
      ...(context.policy ? { policy: context.policy } : {}),
    });
  }

  /** Shared read-only Capsule compatibility analysis for a Git SourceSnapshot. */
  async #runCompatibilityAnalysis(input: {
    readonly snapshot: SourceSnapshot;
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly capsuleId?: string;
    readonly modulePath?: string;
    readonly policy?: PolicyConfig;
  }): Promise<CapsuleCompatibilityReportResponse> {
    const { snapshot, workspaceId } = input;
    const runId = this.#newId("ccr");
    const nowIso = this.#now().toISOString();
    const runningRun: Run = {
      id: runId,
      workspaceId,
      sourceId: input.sourceId,
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
        runId,
        async (files) =>
          await this.#compatibilityAnalyzer.analyze({
            sourceId: input.sourceId,
            sourceSnapshot: snapshot,
            files,
            ...(input.policy ? { policy: input.policy } : {}),
          }),
      );
    const analysis = analysisAttempt.analysis;
    const id = this.#newId("caprep");
    const report: CapsuleCompatibilityReport = {
      id,
      sourceId: input.sourceId,
      ...(input.capsuleId ? { capsuleId: input.capsuleId } : {}),
      sourceSnapshotId: snapshot.id,
      // Record which module the Capsule Gate actually looked at. A plan
      // executes InstallConfig.modulePath, so without this a report for a
      // reviewed module could gate an unreviewed sibling in the same snapshot.
      modulePath: normalizeCompatibilityReportModulePath(input.modulePath),
      level: analysis.level,
      findings: analysis.findings,
      providers: analysis.providers,
      resources: analysis.resources,
      dataSources: analysis.dataSources,
      provisioners: analysis.provisioners,
      rootModuleVariables: analysis.rootModuleVariables,
      rootModuleOutputs: analysis.rootModuleOutputs,
      createdAt: this.#now().toISOString(),
    };
    await this.#store.putCapsuleCompatibilityReport(report);
    const succeededRun: Run = {
      ...runningRun,
      status: analysisAttempt.errorCode ? "failed" : "succeeded",
      compatibilityReportId: report.id,
      ...(analysisAttempt.errorCode
        ? { errorCode: analysisAttempt.errorCode }
        : {}),
      finishedAt: this.#now().toISOString(),
    };
    await this.#store.putCompatibilityCheckRun(succeededRun);
    return { report, run: succeededRun };
  }

  async #compatibilityAnalysisOrUnsupportedReport(
    snapshot: SourceSnapshot,
    modulePath: string | undefined,
    runId: string,
    analyze: (
      files: readonly CapsuleSourceFile[],
    ) => Promise<CapsuleCompatibilityAnalysis>,
  ): Promise<{
    readonly analysis: CapsuleCompatibilityAnalysis;
    readonly errorCode?: string;
  }> {
    try {
      const files = await this.#readCapsuleSourceFilesCached(snapshot, {
        runId,
        ...(modulePath ? { modulePath } : {}),
      });
      return {
        analysis: await analyze(
          files.filter(
            (file) => file.path !== REPOSITORY_INSTALL_METADATA_PATH,
          ),
        ),
      };
    } catch (error) {
      return {
        analysis: compatibilityCheckFailureAnalysis(snapshot, error),
        errorCode: "capsule_compatibility_check_failed",
      };
    }
  }

  async #compatibilityContextForCapsule(
    source: StoredSource,
    capsuleId: string | undefined,
  ): Promise<{
    readonly policy?: PolicyConfig;
    readonly modulePath?: string;
  }> {
    if (!capsuleId) return {};
    const capsule = await this.#store.getCapsule(capsuleId);
    if (!capsule) {
      throw new OpenTofuControllerError(
        "not_found",
        `capsule ${capsuleId} does not exist`,
      );
    }
    if (capsule.workspaceId !== source.workspaceId) {
      throw new OpenTofuControllerError(
        "permission_denied",
        "capsule is not available to this source workspace",
      );
    }
    if (capsule.sourceId !== source.id) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `capsule ${capsuleId} does not use source ${source.id}`,
      );
    }
    const [workspace, config] = await Promise.all([
      this.#store.getWorkspace(capsule.workspaceId),
      this.#store.getInstallConfig(capsule.installConfigId),
    ]);
    return {
      policy: mergePolicyConfigs(workspace?.policy, config?.policy),
      ...(config?.modulePath ? { modulePath: config.modulePath } : {}),
    };
  }

  /**
   * Resolves the Capsule Gate policy for a pre-install compatibility check that
   * carries a service-side `installConfigId` but no Capsule yet. The
   * InstallConfig's bounded policy is merged with
   * the Workspace policy as a ceiling, exactly as {@link
   * #compatibilityContextForCapsule} does for an existing Capsule. The
   * instance-wide default allowlist is never touched: the analyzer UNIONs this
   * bounded policy with the default, so the extra allowance is scoped to this
   * single vetted config and the SAME policy is enforced again at plan/apply.
   * A Workspace-neutral config is usable from any Workspace; a
   * Workspace-scoped config must belong to the requesting Workspace.
   */
  async #compatibilityPolicyForInstallConfig(
    workspaceId: string,
    installConfigId: string | undefined,
  ): Promise<PolicyConfig | undefined> {
    return (
      await this.#compatibilityContextForInstallConfig(
        workspaceId,
        installConfigId,
      )
    ).policy;
  }

  async #compatibilityContextForInstallConfig(
    workspaceId: string,
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
    if (
      config.workspaceId !== undefined &&
      config.workspaceId !== workspaceId
    ) {
      throw new OpenTofuControllerError(
        "permission_denied",
        "install config is not available to this workspace",
      );
    }
    const workspace = await this.#store.getWorkspace(workspaceId);
    return {
      policy: mergePolicyConfigs(workspace?.policy, config.policy),
      ...(config.modulePath ? { modulePath: config.modulePath } : {}),
    };
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

  /**
   * Expands a SourceSnapshot archive through the same runner boundary used by
   * compatibility checks. Callers use this for source-derived execution wiring
   * that must not require a Takosumi-specific manifest in the user repo.
   */
  readCapsuleSourceFiles(
    sourceSnapshot: SourceSnapshot,
    options?: { readonly modulePath?: string; readonly runId?: string },
  ): Promise<readonly CapsuleSourceFile[]> {
    return this.#readCapsuleSourceFilesCached(sourceSnapshot, options);
  }

  #readCapsuleSourceFilesCached(
    sourceSnapshot: SourceSnapshot,
    options?: { readonly modulePath?: string; readonly runId?: string },
  ): Promise<readonly CapsuleSourceFile[]> {
    const modulePath = modulePathWithinSnapshotArchive(
      sourceSnapshot,
      options?.modulePath,
    );
    const normalizedOptions =
      modulePath || options?.runId
        ? {
            ...(modulePath ? { modulePath } : {}),
            ...(options?.runId ? { runId: options.runId } : {}),
          }
        : undefined;
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
      throw sourceSyncRequiredError(
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
    return timingSafeEqualHex(presentedHash, stored.hookSecretHash);
  }

  async #activeSyncRun(
    sourceId: string,
    intent: SourceSyncIntent,
  ): Promise<SourceSyncRun | undefined> {
    const runs = await this.#store.listSourceSyncRuns(sourceId);
    return runs.find(
      (run) =>
        (run.status === "queued" || run.status === "running") &&
        (run.intent ?? "observe") === intent,
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

  async #requireConnectionInWorkspace(
    connectionId: string,
    workspaceId: string,
  ): Promise<void> {
    const connection = await this.#store.getConnection(connectionId);
    if (!connection || connection.workspaceId !== workspaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "auth connection does not exist in this workspace",
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
        compatibilityImpact: "unsupported",
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
    scopeBoundary: normalizeScopeBoundaryPolicy(
      installPolicy?.scopeBoundary ?? spacePolicy?.scopeBoundary,
    ),
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
