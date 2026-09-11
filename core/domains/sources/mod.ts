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
  CreateSourceSyncRequest,
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
  Capsule,
  CapsuleCompatibilityReport,
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import { normalizeCompatibilityReportModulePath } from "takosumi-contract/capsules";
import type { PolicyConfig } from "takosumi-contract/install-configs";
import { timingSafeEqualHex } from "takosumi-contract/internal/crypto";
import {
  MAX_PAGE_LIMIT,
  type Page,
  type PageParams,
} from "takosumi-contract/pagination";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
  sourceSyncRequiredError,
} from "../deploy-control/errors.ts";
import type {
  OpenTofuControlStore,
  SourceConfigurationWriteInput,
  StoredSource,
  WorkspaceManagementAuthority,
} from "../deploy-control/store.ts";
import {
  assertWorkspaceManagementAuthorityInput,
  WorkspaceManagementAdmissionConflictError,
} from "../deploy-control/store.ts";
import type { Run } from "takosumi-contract/runs";
import {
  StaticHclCapsuleCompatibilityAnalyzer,
  type CapsuleCompatibilityAnalysis,
  type CapsuleCompatibilityAnalyzer,
  type CapsuleSourceFile,
} from "./capsule_compatibility.ts";
import { evaluateSourceUrl } from "./url-policy.ts";
import { mergePolicyConfigs } from "../deploy-control/provider_policy.ts";
import type { ArtifactReferenceAllocator } from "../../adapters/storage/artifact-references.ts";
import { stableStringify } from "../../adapters/source/digest.ts";
import { getCapsuleAdoptedSourceSnapshot } from "../deploy-control/capsule_source_revision.ts";

// Git already has a provider-neutral spelling for the remote's configured
// default branch. Do not guess `main`/`master`: an omitted ref means HEAD,
// while an explicitly supplied branch remains exact.
const DEFAULT_REF = "HEAD";
const DEFAULT_PATH = ".";
const REPOSITORY_INSTALL_METADATA_PATH = ".well-known/tcs.json";
const SOURCE_SYNC_REQUEUE_STALE_MS = 10 * 60 * 1000;
const IMMUTABLE_SOURCE_REVISION = /^[0-9a-f]{40}$/iu;
const MAX_SOURCE_RECONCILIATION_CAPSULES = 1_000;

function isImmutableSourceRevision(value: string): boolean {
  return IMMUTABLE_SOURCE_REVISION.test(value);
}

function shouldScheduleAutoSync(source: StoredSource): boolean {
  if (source.status !== "active" || !source.autoSync) return false;
  if (!isImmutableSourceRevision(source.defaultRef)) return true;
  return !sameGitRef(source.defaultRef, source.lastSeenCommit);
}

function sameGitRef(left: unknown, right: unknown): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

/**
 * Out-of-process source-sync dispatch seam. Mirrors the deploy-control
 * `EnqueueRun`: the create path persists the run `queued` and hands the run
 * identity to the enqueuer; the actual resolution runs later in the queue
 * dispatcher. Defaults to a no-op so callers without an executor keep the run queued
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

/**
 * In-process identity supplied only by a durable Git lifecycle coordinator or
 * an authority-guarded Capsule configuration transition.
 * The Accounts HTTP parser never forwards these fields. Both ids are derived
 * from the exact coordinator/request/source/snapshot/base/module digest so a
 * lost acknowledgement can recover one canonical read-only analysis.
 */
export interface InstallPlanCompatibilityIdentity {
  readonly runId: string;
  readonly reportId: string;
  readonly createdBy: string;
}

/** Internal authority only; never accepted from the public request body. */
export type CompatibilityCheckManagementContext =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "captured";
      /** Missing original authority permits only exact terminal evidence reads. */
      readonly authority: WorkspaceManagementAuthority | null;
    };

export type InstallPlanCompatibilityCheckRequest =
  CreateSourceCompatibilityCheckRequest & {
    readonly installPlanIdentity: InstallPlanCompatibilityIdentity;
  };

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
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
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
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        request.workspaceId,
      );
    }
    const workspaceManagementAuthority =
      expectedWorkspaceManagementAuthority ??
      (await this.#captureWorkspaceManagementAuthority(request.workspaceId));
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
    const persisted = await this.#writeSourceConfiguration({
      source: stored,
      expectedWorkspaceManagementAuthority: workspaceManagementAuthority,
    });
    return { source: toPublicSource(persisted), hookSecret };
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
    const shouldValidateAuthConnection =
      patch.authConnectionId !== undefined && patch.authConnectionId !== null;
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
    // A same-row PATCH is a read-only replay and remains observable while a
    // Workspace drains. The store still validates the full expected row.
    if (stableStringify(next) === stableStringify(stored)) {
      const persisted = await this.#writeSourceConfiguration({
        source: next,
        expectedSource: stored,
      });
      return { source: toPublicSource(persisted) };
    }
    const workspaceManagementAuthority =
      await this.#captureWorkspaceManagementAuthority(stored.workspaceId);
    if (shouldValidateAuthConnection) {
      await this.#requireConnectionInWorkspace(
        patch.authConnectionId as string,
        stored.workspaceId,
      );
    }
    const persisted = await this.#writeSourceConfiguration({
      source: next,
      expectedSource: stored,
      expectedWorkspaceManagementAuthority: workspaceManagementAuthority,
    });
    return { source: toPublicSource(persisted) };
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
   * `limit`. An exact commit remains eligible until one successful sync records
   * that same commit; after that, polling could not discover a newer revision.
   * Returns the public Source records (the scheduler only needs the id).
   */
  async listAutoSyncSources(limit: number): Promise<readonly Source[]> {
    const rows = await this.#store.listSources();
    const out: Source[] = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      if (shouldScheduleAutoSync(row)) {
        out.push(toPublicSource(row));
      }
    }
    return out;
  }

  /**
   * Bounded cross-Workspace scheduler page. The cursor advances across every
   * row so sparse autoSync populations cannot cause an unbounded cron scan.
   */
  async listAutoSyncSourcesPage(params: PageParams): Promise<Page<Source>> {
    const page = await this.#store.listAllSourcesPage(params);
    return {
      items: page.items
        .filter(shouldScheduleAutoSync)
        .map(toPublicSource),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  /**
   * Creates a source_sync run for the source's default ref and enqueues it. The
   * archive reference is allocated by the host storage adapter. Dedup:
   * when a run is already `queued`/`running` for this source, returns it instead
   * of creating a duplicate (used by the webhook / scheduler).
   */
  async createSync(
    sourceId: string,
    options: CreateSourceSyncRequest & { readonly dedupe?: boolean } = {},
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<CreateSourceSyncResponse> {
    return await this.#createSync(
      sourceId,
      options,
      undefined,
      expectedWorkspaceManagementAuthority,
    );
  }

  /**
   * Enqueues observation runs for the shared Source default and every distinct
   * Git ref/path lane currently adopted by one of its Capsules. The addresses
   * are derived from applied StateVersion provenance; this never rewrites the
   * Source defaults and is intentionally not exposed as caller-controlled HTTP
   * input.
   */
  async createReconciliationSyncs(
    sourceId: string,
  ): Promise<readonly CreateSourceSyncResponse[]> {
    const stored = await this.#requireSource(sourceId);
    // Capture one immutable authority before asynchronous Capsule/lane
    // enumeration. Every reconciliation lane must use this original tuple;
    // taking a fresh epoch after a drain/resume could admit only a subset of
    // the lanes from an obsolete reconciliation request.
    const workspaceManagementAuthority =
      await this.#captureWorkspaceManagementAuthority(stored.workspaceId);
    const addresses = new Map<string, { readonly ref: string; readonly path: string }>();
    const addAddress = (ref: string, path: string) => {
      addresses.set(JSON.stringify([ref, path]), { ref, path });
    };
    addAddress(stored.defaultRef, stored.defaultPath);

    const capsules = await this.#listReconciliationCapsules(
      stored.workspaceId,
    );
    for (const capsule of capsules) {
      if (
        capsule.sourceId !== stored.id ||
        capsule.status === "destroyed" ||
        capsule.status === "disabled" ||
        !capsule.currentStateVersionId
      ) {
        continue;
      }
      const adopted = await getCapsuleAdoptedSourceSnapshot(
        this.#store,
        capsule,
      );
      if (!adopted) continue;
      // An exact commit cannot advance. Its already-adopted immutable snapshot
      // remains sufficient until the Capsule deliberately changes lane.
      if (
        isImmutableSourceRevision(adopted.ref) &&
        sameGitRef(adopted.ref, adopted.resolvedCommit)
      ) {
        continue;
      }
      addAddress(adopted.ref, adopted.path);
    }

    const runs: CreateSourceSyncResponse[] = [];
    for (const address of addresses.values()) {
      runs.push(
        await this.#createSync(
          sourceId,
          { intent: "observe", dedupe: true },
          address,
          workspaceManagementAuthority,
        ),
      );
    }
    return runs;
  }

  async #listReconciliationCapsules(
    workspaceId: string,
  ): Promise<readonly Capsule[]> {
    const capsules: Capsule[] = [];
    let cursor: string | undefined;
    for (;;) {
      const remaining = MAX_SOURCE_RECONCILIATION_CAPSULES - capsules.length;
      const page = await this.#store.listCapsulesPage(workspaceId, {
        limit: Math.min(MAX_PAGE_LIMIT, remaining),
        ...(cursor ? { cursor } : {}),
        includeDestroyed: false,
      });
      capsules.push(...page.items);
      if (!page.nextCursor) return capsules;
      if (capsules.length >= MAX_SOURCE_RECONCILIATION_CAPSULES) {
        throw new OpenTofuControllerError(
          "resource_exhausted",
          `Source reconciliation exceeds ${MAX_SOURCE_RECONCILIATION_CAPSULES} Capsules in one Workspace`,
          { reason: "source_reconciliation_capsule_limit" },
        );
      }
      cursor = page.nextCursor;
    }
  }

  async #createSync(
    sourceId: string,
    options: CreateSourceSyncRequest & { readonly dedupe?: boolean },
    trackedAddress?: { readonly ref: string; readonly path: string },
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<CreateSourceSyncResponse> {
    const stored = await this.#requireSource(sourceId);
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        stored.workspaceId,
      );
    }
    // Capture the private Workspace authority before any asynchronous source
    // preparation. This exact snapshot is the admission fence for a new row;
    // do not refresh it later after dedupe/stale observations, or a drain could
    // be erased by a late read. Existing exact rows remain read-only probes.
    let workspaceManagementAuthority: WorkspaceManagementAuthority | undefined;
    let workspaceManagementAdmissionError: OpenTofuControllerError | undefined;
    if (expectedWorkspaceManagementAuthority !== undefined) {
      workspaceManagementAuthority = expectedWorkspaceManagementAuthority;
    } else {
      try {
        workspaceManagementAuthority =
          await this.#captureWorkspaceManagementAuthority(stored.workspaceId);
      } catch (error) {
        if (!isWorkspaceManagementAdmissionConflict(error)) throw error;
        workspaceManagementAdmissionError = workspaceManagementAdmissionErrorFor();
      }
    }
    const intent = options.intent ?? "observe";
    if (intent !== "observe" && intent !== "manual_plan") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "intent must be observe or manual_plan",
      );
    }
    if (
      options.expectedRef !== undefined &&
      typeof options.expectedRef !== "string"
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "expectedRef must be a string when provided",
        { reason: "invalid_source_revision" },
      );
    }
    const expectedRef = options.expectedRef?.trim();
    if (expectedRef !== undefined && !isImmutableSourceRevision(expectedRef)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "expectedRef must be an exact 40-character hexadecimal commit.",
        { reason: "invalid_source_revision" },
      );
    }
    if (
      expectedRef !== undefined &&
      !sameGitRef(stored.defaultRef, expectedRef)
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "Source defaultRef changed before the requested sync was dispatched.",
        { reason: "source_revision_mismatch" },
      );
    }
    const coordinator = parseSourceSyncCoordinator(options.coordinator);
    const tracked = trackedAddress
      ? parseTrackedSourceAddress(trackedAddress)
      : undefined;
    if (
      (options.coordinator !== undefined && !coordinator) ||
      (coordinator !== undefined && intent !== "manual_plan") ||
      (coordinator !== undefined && expectedRef !== undefined) ||
      (trackedAddress !== undefined && !tracked) ||
      (tracked !== undefined &&
        (intent !== "observe" ||
          coordinator !== undefined ||
          expectedRef !== undefined))
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "coordinator must contain one safe manual-plan Git address and deterministic identities and cannot be combined with expectedRef",
        { reason: "invalid_source_revision" },
      );
    }
    const runRef =
      tracked?.ref ?? coordinator?.ref ?? expectedRef ?? stored.defaultRef;
    const runPath = tracked?.path ?? coordinator?.path ?? stored.defaultPath;
    if (coordinator) {
      const existing = await this.#store.getSourceSyncRun(coordinator.runId);
      if (existing) {
        if (!sourceSyncMatchesCoordinator(existing, stored, coordinator)) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "source-sync coordinator identity is already bound to different evidence",
            { reason: "source_sync_identity_conflict" },
          );
        }
        if (
          await this.#canReenqueueExistingSourceSyncRun(
            existing,
            workspaceManagementAuthority,
          )
        ) {
          await this.#enqueue({
            action: "source_sync",
            runId: existing.id,
            workspaceId: existing.workspaceId,
            sourceId: existing.sourceId,
          });
        }
        return { run: existing };
      }
    }
    if (options.dedupe && !coordinator) {
      const existing = await this.#activeSyncRun(
        sourceId,
        intent,
        runRef,
        runPath,
      );
      if (existing) {
        if (
          await this.#canReenqueueExistingSourceSyncRun(
            existing,
            workspaceManagementAuthority,
          )
        ) {
          await this.#enqueue({
            action: "source_sync",
            runId: existing.id,
            workspaceId: existing.workspaceId,
            sourceId: existing.sourceId,
          });
          return { run: existing };
        }
        if (
          workspaceManagementAuthority &&
          shouldReplaceStaleRunningSyncRun(existing, this.#now().getTime())
        ) {
          const replaced = await this.#failStaleSyncRun(
            existing,
            workspaceManagementAuthority,
          );
          if (!replaced) {
            const current = await this.#activeSyncRun(
              sourceId,
              intent,
              runRef,
              runPath,
            );
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
    if (!workspaceManagementAuthority) {
      // A known draining/released Workspace may still return exact existing
      // rows above, but must never allocate or enqueue new management work.
      throw workspaceManagementAdmissionError ??
        workspaceManagementAdmissionErrorFor();
    }
    const runId = coordinator?.runId ?? this.#newId("ssr");
    const snapshotId = coordinator?.snapshotId ?? this.#newId("snap");
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
      ref: runRef,
      path: runPath,
      archiveRef,
      intent,
      status: "queued",
      createdAt: nowIso,
      updatedAt: nowIso,
      snapshotId,
    };
    let begun;
    try {
      begun = await this.#store.beginSourceSyncRun(
        run,
        workspaceManagementAuthority,
      );
    } catch (error) {
      if (error instanceof WorkspaceManagementAdmissionConflictError) {
        throw workspaceManagementAdmissionErrorFor();
      }
      throw error;
    }
    if (begun.status === "conflict") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "source-sync identity is already bound to different evidence",
        { reason: "source_sync_identity_conflict" },
      );
    }
    const persisted = begun.run;
    if (begun.status === "existing") {
      if (
        await this.#canReenqueueExistingSourceSyncRun(
          persisted,
          workspaceManagementAuthority,
        )
      ) {
        await this.#enqueue({
          action: "source_sync",
          runId: persisted.id,
          workspaceId: persisted.workspaceId,
          sourceId: persisted.sourceId,
        });
      }
      return { run: persisted };
    }
    await this.#enqueue({
      action: "source_sync",
      runId: persisted.id,
      workspaceId: persisted.workspaceId,
      sourceId: persisted.sourceId,
    });
    return { run: persisted };
  }

  async createCompatibilityCheck(
    sourceId: string,
    request: CreateSourceCompatibilityCheckRequest,
    managementContext: CompatibilityCheckManagementContext,
  ): Promise<CapsuleCompatibilityReportResponse> {
    managementContext = structuredClone(managementContext);
    if (managementContext.kind !== "fresh" && managementContext.kind !== "captured") {
      throw new TypeError("Compatibility analysis requires an explicit management context");
    }
    const installPlanIdentity = installPlanCompatibilityIdentity(request);
    const stored = await this.#requireSource(sourceId);
    // Capture before snapshot/policy preparation. An existing workflow must
    // explicitly carry its original tuple; absence must never refresh it.
    let authority: WorkspaceManagementAuthority | undefined;
    if (managementContext.kind === "captured") {
      if (managementContext.authority !== null) {
        assertWorkspaceManagementAuthorityInput(managementContext.authority, stored.workspaceId);
        authority = structuredClone(managementContext.authority);
      }
    } else {
      try {
        authority = await this.#captureWorkspaceManagementAuthority(stored.workspaceId);
      } catch (error) {
        // Exact terminal evidence remains readable while stopped. Other
        // storage errors are not converted into management admission failure.
        if (!isWorkspaceManagementAdmissionConflict(error)) throw error;
      }
    }
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
      ...(installPlanIdentity ? { installPlanIdentity } : {}),
      authority,
      allowRunningRecovery: managementContext.kind === "captured" && installPlanIdentity !== undefined,
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
    readonly installPlanIdentity?: InstallPlanCompatibilityIdentity;
    readonly authority: WorkspaceManagementAuthority | undefined;
    readonly allowRunningRecovery: boolean;
  }): Promise<CapsuleCompatibilityReportResponse> {
    const { snapshot, workspaceId } = input;
    const runId = input.installPlanIdentity?.runId ?? this.#newId("ccr");
    const reportId = input.installPlanIdentity?.reportId ?? this.#newId("caprep");
    const recover = async () => input.installPlanIdentity
      ? await this.#recoverInstallPlanCompatibilityEvidence({
          ...input,
          runId,
          reportId,
          createdBy: input.installPlanIdentity.createdBy,
        })
      : undefined;
    const recovered = await recover();
    if (recovered) return recovered;
    if (!input.authority) throw workspaceManagementAdmissionErrorFor();

    const nowIso = this.#now().toISOString();
    const runningRun: Run = {
      id: runId,
      workspaceId,
      sourceId: input.sourceId,
      ...(input.capsuleId ? { capsuleId: input.capsuleId } : {}),
      type: "compatibility_check",
      status: "running",
      sourceSnapshotId: snapshot.id,
      createdBy: input.installPlanIdentity?.createdBy ?? "system",
      createdAt: nowIso,
      startedAt: nowIso,
    };
    let admission;
    try {
      admission = await this.#store.beginCompatibilityCheckRun(runningRun, input.authority);
    } catch (error) {
      if (error instanceof WorkspaceManagementAdmissionConflictError) {
        throw workspaceManagementAdmissionErrorFor();
      }
      throw error;
    }
    if (admission.status === "conflict" ||
      (admission.status === "existing" && !input.allowRunningRecovery)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "compatibility analysis identity cannot be started or resumed",
        { reason: "compatibility_evidence_identity_conflict" },
      );
    }
    const activeRun = admission.run;
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
    const report: CapsuleCompatibilityReport = {
      id: reportId,
      sourceId: input.sourceId,
      ...(input.capsuleId ? { capsuleId: input.capsuleId } : {}),
      sourceSnapshotId: snapshot.id,
      // Record which module the Capsule Gate actually looked at. A plan
      // executes InstallConfig.modulePath, so without this a report for a
      // reviewed module could gate an unreviewed sibling in the same snapshot.
      modulePath: normalizeCompatibilityReportModulePath(input.modulePath),
      level: analysis.level,
      findings: analysis.findings,
      providerPackages: analysis.providerPackages,
      rootProviderRequirements: analysis.rootProviderRequirements,
      resources: analysis.resources,
      dataSources: analysis.dataSources,
      provisioners: analysis.provisioners,
      rootModuleVariables: analysis.rootModuleVariables,
      rootModuleVariableDeclarations: analysis.rootModuleVariableDeclarations,
      rootModuleOutputs: analysis.rootModuleOutputs,
      createdAt: this.#now().toISOString(),
    };
    const succeededRun: Run = {
      ...activeRun,
      status: analysisAttempt.errorCode ? "failed" : "succeeded",
      compatibilityReportId: report.id,
      ...(analysisAttempt.errorCode
        ? { errorCode: analysisAttempt.errorCode }
        : {}),
      finishedAt: this.#now().toISOString(),
    };
    let settlement;
    try {
      settlement = await this.#store.commitCompatibilityCheckRun({
        expectedRunningRun: activeRun,
        terminalRun: succeededRun,
        report,
      });
    } catch (error) {
      // A lost commit acknowledgement is not a failed analysis. Only exact
      // deterministic terminal evidence may resolve it; otherwise retain the
      // original storage error without writing a second outcome.
      try {
        const committed = await recover();
        if (committed) return committed;
      } catch {
        // An incomplete or unavailable readback cannot resolve the commit.
      }
      throw error;
    }
    if (settlement.status === "conflict") {
      // Concurrent analyses can finish with different timestamps or results.
      // Return the already-committed canonical pair, never rewrite it using
      // this attempt's report or make unequal candidates into store replays.
      const committed = await recover();
      if (committed) return committed;
      throw new OpenTofuControllerError(
        "failed_precondition",
        "compatibility analysis result could not be committed",
        { reason: "compatibility_evidence_identity_conflict" },
      );
    }
    return { report: settlement.report, run: settlement.run };
  }

  async #recoverInstallPlanCompatibilityEvidence(input: {
    readonly snapshot: SourceSnapshot;
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly capsuleId?: string;
    readonly modulePath?: string;
    readonly runId: string;
    readonly reportId: string;
    readonly createdBy: string;
  }): Promise<CapsuleCompatibilityReportResponse | undefined> {
    const [run, report] = await Promise.all([
      this.#store.getCompatibilityCheckRun(input.runId),
      this.#store.getCapsuleCompatibilityReport(input.reportId),
    ]);
    if (!run && !report) return undefined;
    if (
      (run && !compatibilityRunMatchesInstallPlanIdentity(run, input)) ||
      (report && !compatibilityReportMatchesInstallPlanIdentity(report, input))
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "install-plan compatibility identity is already bound to different evidence",
        { reason: "compatibility_evidence_identity_conflict" },
      );
    }
    if (!run || !report) {
      if (report || run?.status !== "running") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "install-plan compatibility evidence is incomplete",
          { reason: "compatibility_evidence_incomplete" },
        );
      }
      // A running exact record may be resumed only after the store verifies
      // its original authority. This read alone does not grant continuation.
      return undefined;
    }
    if (run.status === "running") {
      // Retained partial evidence is not permission to repeat the analysis
      // or replace its report. A concurrent terminal commit can also make
      // these independent reads temporarily incomplete; a later exact replay
      // may observe it, but this invocation must not repair either record.
      throw new OpenTofuControllerError(
        "failed_precondition",
        "install-plan compatibility evidence is incomplete",
        { reason: "compatibility_evidence_incomplete" },
      );
    }
    if (
      (run.status !== "succeeded" && run.status !== "failed") ||
      run.compatibilityReportId !== report.id
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "install-plan compatibility evidence is not terminal and exact",
        { reason: "compatibility_evidence_incomplete" },
      );
    }
    return { report, run };
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
    // The selected module path is already relative to the immutable snapshot
    // archive. `sourceSnapshot.path` identifies the captured subtree but is not
    // another coordinate prefix to strip from the execution path.
    const modulePath = normalizeRelativeModulePath(options?.modulePath);
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

  async #failStaleSyncRun(
    run: SourceSyncRun,
    expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority,
  ): Promise<boolean> {
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
      expectedWorkspaceManagementAuthority,
      requireStoredManagementAuthority: true,
    });
    return result.won;
  }

  async #captureWorkspaceManagementAuthority(
    workspaceId: string,
  ): Promise<WorkspaceManagementAuthority> {
    const management = await this.#store.getWorkspaceManagement(workspaceId);
    if (
      !management ||
      management.workspaceId !== workspaceId ||
      management.managementState !== "active"
    ) {
      throw workspaceManagementAdmissionErrorFor();
    }
    return {
      workspaceId: management.workspaceId,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    };
  }

  async #writeSourceConfiguration(
    input: SourceConfigurationWriteInput,
  ): Promise<StoredSource> {
    try {
      const result = await this.#store.writeSourceConfiguration(input);
      if (result.status === "conflict") {
        throw sourceConfigurationConflictError();
      }
      return result.source;
    } catch (error) {
      if (error instanceof WorkspaceManagementAdmissionConflictError) {
        throw workspaceManagementAdmissionErrorFor();
      }
      throw error;
    }
  }

  /**
   * Existing queued rows may be repaired only while the Workspace still holds
   * the exact authority captured for this request. This is deliberately not
   * used for NEW admission; beginSourceSyncRun owns that CAS with the same
   * captured authority.
   */
  async #workspaceManagementIsActive(
    workspaceId: string,
    expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority,
  ): Promise<boolean> {
    const management = await this.#store.getWorkspaceManagement(workspaceId);
    return (
      management?.workspaceId === workspaceId &&
      management.managementState === "active" &&
      expectedWorkspaceManagementAuthority.workspaceId === workspaceId &&
      management.managementEpoch ===
        expectedWorkspaceManagementAuthority.managementEpoch
    );
  }

  /**
   * Existing queued rows may be repaired only when their original private
   * admission tuple exactly matches this request's captured active tuple.
   * Missing/corrupt legacy metadata is observation-only: return the row but
   * never turn it into a new queue dispatch. Coordinator replay, ordinary
   * dedupe, and an insert-race adoption all share this gate.
   */
  async #canReenqueueExistingSourceSyncRun(
    run: SourceSyncRun,
    expectedWorkspaceManagementAuthority:
      | WorkspaceManagementAuthority
      | undefined,
  ): Promise<boolean> {
    if (run.status !== "queued") return false;
    const original = await this.#store.getRunManagementAuthority({
      id: run.id,
      workspaceId: run.workspaceId,
      kind: "source_sync",
    });
    if (
      expectedWorkspaceManagementAuthority === undefined ||
      original === undefined ||
      original.workspaceId !== expectedWorkspaceManagementAuthority.workspaceId ||
      original.managementState !== "active" ||
      original.managementEpoch !==
        expectedWorkspaceManagementAuthority.managementEpoch
    ) {
      return false;
    }
    return await this.#workspaceManagementIsActive(
      run.workspaceId,
      expectedWorkspaceManagementAuthority,
    );
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
    ref: string,
    path: string,
  ): Promise<SourceSyncRun | undefined> {
    const runs = await this.#store.listSourceSyncRuns(sourceId);
    return runs.find(
      (run) =>
        (run.status === "queued" || run.status === "running") &&
        (run.intent ?? "observe") === intent &&
        sameGitRef(run.ref, ref) &&
        run.path === path,
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

const WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_REASON =
  "workspace_management_admission_conflict";
const WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_MESSAGE =
  "Workspace is not accepting this management operation.";
const SOURCE_CONFIGURATION_CONFLICT_MESSAGE =
  "Source configuration changed before it could be persisted.";

function workspaceManagementAdmissionErrorFor(): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "failed_precondition",
    WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_MESSAGE,
    { reason: WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_REASON },
  );
}

function sourceConfigurationConflictError(): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "failed_precondition",
    SOURCE_CONFIGURATION_CONFLICT_MESSAGE,
    { reason: "source_configuration_conflict" },
  );
}

function isWorkspaceManagementAdmissionConflict(error: unknown): boolean {
  if (!(error instanceof OpenTofuControllerError)) return false;
  const details = error.details;
  return (
    error.code === "failed_precondition" &&
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { readonly reason?: unknown }).reason ===
      WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_REASON
  );
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
    providerPackages: [],
    rootProviderRequirements: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: [],
    rootModuleVariableDeclarations: [],
    rootModuleOutputs: [],
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function boundedRequestedGitRef(value: string | undefined): string | undefined {
  const ref = nonEmpty(value);
  return ref &&
      new TextEncoder().encode(ref).byteLength <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(ref)
    ? ref
    : undefined;
}

function safeRequestedSourcePath(
  value: string | undefined,
): string | undefined {
  const path = nonEmpty(value);
  if (!path || path.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(path)) {
    return undefined;
  }
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/g, "");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return undefined;
  }
  return normalized && normalized !== "." ? normalized : ".";
}

type SourceSyncCoordinator = NonNullable<CreateSourceSyncRequest["coordinator"]>;

function parseTrackedSourceAddress(value: {
  readonly ref: string;
  readonly path: string;
}): { readonly ref: string; readonly path: string } | undefined {
  const ref = boundedRequestedGitRef(value.ref);
  const path = safeRequestedSourcePath(value.path);
  return ref && path ? { ref, path } : undefined;
}

function parseSourceSyncCoordinator(
  value: CreateSourceSyncRequest["coordinator"],
): SourceSyncCoordinator | undefined {
  if (!value) return undefined;
  const ref = boundedRequestedGitRef(value.ref);
  const path = safeRequestedSourcePath(value.path);
  if (
    !ref ||
    !path ||
    !/^ssr_[0-9A-Za-z]{8,64}$/u.test(value.runId) ||
    !/^snap_[0-9A-Za-z]{8,64}$/u.test(value.snapshotId)
  ) {
    return undefined;
  }
  return { ref, path, runId: value.runId, snapshotId: value.snapshotId };
}

function sourceSyncMatchesCoordinator(
  run: SourceSyncRun,
  source: StoredSource,
  coordinator: SourceSyncCoordinator,
): boolean {
  return (
    run.id === coordinator.runId &&
    run.snapshotId === coordinator.snapshotId &&
    run.workspaceId === source.workspaceId &&
    run.sourceId === source.id &&
    run.url === source.url &&
    run.ref === coordinator.ref &&
    run.path === coordinator.path &&
    run.intent === "manual_plan"
  );
}

interface InstallPlanCompatibilityScope {
  readonly snapshot: SourceSnapshot;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly capsuleId?: string;
  readonly modulePath?: string;
  readonly runId: string;
  readonly reportId: string;
  readonly createdBy: string;
}

function installPlanCompatibilityIdentity(
  request: CreateSourceCompatibilityCheckRequest,
): InstallPlanCompatibilityIdentity | undefined {
  const raw = (
    request as CreateSourceCompatibilityCheckRequest & {
      readonly installPlanIdentity?: unknown;
    }
  ).installPlanIdentity;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invalid install-plan compatibility identity",
    );
  }
  const value = raw as Record<string, unknown>;
  const runId = value.runId;
  const reportId = value.reportId;
  const createdBy = value.createdBy;
  const runSuffix =
    typeof runId === "string" ? /^ccr_([0-9a-f]{16})$/u.exec(runId)?.[1] : undefined;
  const reportSuffix =
    typeof reportId === "string"
      ? /^caprep_([0-9a-f]{16})$/u.exec(reportId)?.[1]
      : undefined;
  const actorSuffix =
    typeof createdBy === "string"
      ? /^(?:git-install-plan:gip_[0-9a-f]{16}|git-revision-plan:grp_[0-9a-f]{16}|capsule-configuration-plan:icfg_[0-9a-f]{16}):([0-9a-f]{16})$/u.exec(
          createdBy,
        )?.[1]
      : undefined;
  if (
    Object.keys(value).length !== 3 ||
    !runSuffix ||
    runSuffix !== reportSuffix ||
    runSuffix !== actorSuffix
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "invalid install-plan compatibility identity",
    );
  }
  return {
    runId: runId as string,
    reportId: reportId as string,
    createdBy: createdBy as string,
  };
}

function compatibilityRunMatchesInstallPlanIdentity(
  run: Run,
  expected: InstallPlanCompatibilityScope,
): boolean {
  return (
    run.id === expected.runId &&
    run.workspaceId === expected.workspaceId &&
    run.sourceId === expected.sourceId &&
    (run.capsuleId ?? undefined) === (expected.capsuleId ?? undefined) &&
    run.type === "compatibility_check" &&
    run.sourceSnapshotId === expected.snapshot.id &&
    run.createdBy === expected.createdBy &&
    (run.compatibilityReportId === undefined ||
      run.compatibilityReportId === expected.reportId)
  );
}

function compatibilityReportMatchesInstallPlanIdentity(
  report: CapsuleCompatibilityReport,
  expected: InstallPlanCompatibilityScope,
): boolean {
  return (
    report.id === expected.reportId &&
    report.sourceId === expected.sourceId &&
    report.sourceSnapshotId === expected.snapshot.id &&
    normalizeCompatibilityReportModulePath(report.modulePath) ===
      normalizeCompatibilityReportModulePath(expected.modulePath) &&
    (report.capsuleId ?? undefined) === (expected.capsuleId ?? undefined)
  );
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
