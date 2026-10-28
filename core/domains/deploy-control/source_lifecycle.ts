/**
 * Source-sync consumer + finalization facade (Core Specification §6).
 *
 * A cohesive collaborator pulled out of `OpenTofuController`: it owns
 * the `source_sync` run consumer path — the idempotency guard, the transition to
 * `running`, the source-phase credential mint (git-only; never provider), the
 * runner dispatch, and the terminal finalization that records the immutable
 * {@link SourceSnapshot} + updates the Source's `lastSeenCommit` on success, or
 * records the failure. It also owns the source-phase credential-mint audit event.
 *
 * This path is entirely self-contained on the Source side: a `source_sync` IS a
 * run, but it never touches the plan/apply run-engine mutation core. The seams it
 * shares with the controller (the public {@link SourcesService}, the
 * {@link OpenTofuRunner}, the {@link ConnectionVault}, the run-heartbeat
 * idempotency predicate, the id/clock) are injected as ports so the SAME
 * instances are used here as on the controller. A missing Source service or
 * `sourceSync` runner capability terminally fails the claimed Run; the ledger
 * never uses an indefinitely queued row as an implicit capability fallback.
 * The controller keeps
 * `runQueuedSourceSync` as a thin delegating wrapper, so the RunOwner and
 * the inline dispatcher keep calling the controller surface unchanged.
 *
 * Behavior is identical to the prior inline controller methods: exact signatures,
 * error codes, ordering, and run/state semantics are preserved. Credential
 * material is never logged.
 */

import type { RunStatus } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type {
  MintResponse,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { ConnectionVault } from "../../adapters/vault/mod.ts";
import type { SourcesService } from "../sources/mod.ts";
import type {
  FreezeWorkspaceManagementExpectation,
  OpenTofuControlStore,
  StoredSource,
  WorkspaceManagementAuthority,
} from "./store.ts";
import {
  assertWorkspaceFreezeExpectation,
  sourceSyncRunForDrainFailure,
} from "./store.ts";
import type { OpenTofuRunner, OpenTofuSourceSyncResult } from "./mod.ts";
import { NON_TERMINAL_RUN_STATUSES } from "./mod.ts";
import {
  mapVaultError,
  OpenTofuControllerError,
  structuredErrorReason,
} from "./errors.ts";
import { errorMessage } from "./projection.ts";

/**
 * Ports the controller injects into {@link SourceLifecycleService}. `store` /
 * `now` / `newId` mirror the controller's own handles; `sourcesService` and
 * `runner` are optional composition ports, but an absent port is an explicit
 * terminal capability error once a source-sync Run is dispatched;
 * `requireVault` resolves the wired {@link ConnectionVault} (the SAME
 * `not_implemented` fail-closed as the controller); `shouldProcessRun` is the
 * shared run-heartbeat idempotency predicate (also used by the plan/apply
 * consumers, so it stays owned by the controller and is passed in).
 */
export interface SourceLifecycleServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
  readonly runRenewalIntervalMs: number;
  readonly sourcesService?: SourcesService;
  readonly runner?: OpenTofuRunner;
  /** Resolves the wired vault, throwing `not_implemented` when none is configured. */
  readonly requireVault: () => ConnectionVault;
  /** Shared run-heartbeat idempotency predicate (queued, or running-but-stale). */
  readonly shouldProcessRun: (
    status: RunStatus,
    heartbeatAt: number | undefined,
  ) => boolean;
  /**
   * Invoked after a Capsule is marked `stale` because its Source resolved a
   * new snapshot. The controller wires this to the auto-update pipeline
   * (create an update plan that auto-applies when clean). Failures are the
   * callee's to swallow — a broken hook must never fail the source sync.
   */
  readonly onCapsuleStaleForNewSnapshot?: (input: {
    readonly capsule: Capsule;
    readonly snapshot: SourceSnapshot;
    /**
     * Private authority captured when the exact SourceSync Run was admitted.
     * A stale callback may complete after a drain/resume, so this must never
     * be replaced with a current Workspace read.
     */
    readonly expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority;
  }) => Promise<void>;
}

/**
 * Collaborator owning the `source_sync` consumer + finalization. Behavior is
 * identical to the prior inline controller methods.
 */
export class SourceLifecycleService {
  readonly #store: OpenTofuControlStore;
  readonly #now: () => number;
  readonly #newId: (prefix: string) => string;
  readonly #runRenewalIntervalMs: number;
  readonly #sourcesService?: SourcesService;
  readonly #runner?: OpenTofuRunner;
  readonly #requireVault: () => ConnectionVault;
  readonly #shouldProcessRun: (
    status: RunStatus,
    heartbeatAt: number | undefined,
  ) => boolean;
  readonly #onCapsuleStaleForNewSnapshot?: (input: {
    readonly capsule: Capsule;
    readonly snapshot: SourceSnapshot;
    readonly expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority;
  }) => Promise<void>;

  constructor(dependencies: SourceLifecycleServiceDependencies) {
    this.#store = dependencies.store;
    this.#now = dependencies.now;
    this.#newId = dependencies.newId;
    this.#runRenewalIntervalMs = dependencies.runRenewalIntervalMs;
    this.#sourcesService = dependencies.sourcesService;
    this.#runner = dependencies.runner;
    this.#requireVault = dependencies.requireVault;
    this.#shouldProcessRun = dependencies.shouldProcessRun;
    this.#onCapsuleStaleForNewSnapshot =
      dependencies.onCapsuleStaleForNewSnapshot;
  }

  /** Internal convergence: no credentials, source cursor, snapshot, or runner effects. */
  async settleDuringDrain(
    runId: string,
    management: FreezeWorkspaceManagementExpectation,
  ): Promise<SourceSyncRun> {
    assertWorkspaceFreezeExpectation(management);
    management = structuredClone(management);
    const run = await this.#store.getSourceSyncRun(runId);
    if (!run) {
      throw new OpenTofuControllerError("not_found", `source sync run ${runId} not found`);
    }
    const failed = sourceSyncRunForDrainFailure(run, new Date(this.#now()).toISOString());
    if (!failed) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source sync run ${runId} cannot be settled by management drain`,
      );
    }
    const result = await this.#store.transitionRun({
      id: runId,
      kind: "source_sync",
      expectFrom: ["queued"],
      expectStartedAt: null,
      clearLeaseToken: true,
      expectDrainSettlement: { management, expectedRun: run },
      run: failed,
    });
    if (!result.won) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `source sync run ${runId} or its management drain changed before settlement`,
      );
    }
    return failed;
  }

  /**
   * Source-sync consumer (Core Specification §6). Idempotency guard, transition
   * to `running`, mint source-phase credentials NOW (git-only; never provider),
   * dispatch to the runner, and on success record the SourceSnapshot + update the
   * Source's `lastSeenCommit`. Never logs credential material.
   */
  async runQueuedSourceSync(runId: string): Promise<SourceSyncRun | undefined> {
    const run = await this.#store.getSourceSyncRun(runId);
    if (!run) {
      throw new OpenTofuControllerError(
        "not_found",
        `source sync run ${runId} not found`,
      );
    }
    if (!this.#shouldProcessRun(run.status, run.heartbeatAt)) {
      if (run.status === "succeeded") await this.#cleanupUnusedSourceArchive(run);
      return run;
    }
    const claim = await this.#claimSourceSyncRun(run);
    if (!claim.won) {
      return claim.run;
    }
    const { running, leaseToken } = claim;

    const sources = this.#sourcesService;
    const sourceSync = this.#runner?.sourceSync;
    if (!sources || !sourceSync) {
      await this.#failSourceSyncRun(
        running,
        leaseToken,
        new OpenTofuControllerError(
          "not_implemented",
          "the selected runner does not provide the source-sync capability",
          { reason: "runner_capability_missing" },
        ),
      );
      return await this.#store.getSourceSyncRun(runId);
    }

    let stored;
    try {
      stored = await sources.getStoredSource(run.sourceId);
    } catch (error) {
      await this.#failSourceSyncRun(running, leaseToken, error);
      return await this.#store.getSourceSyncRun(runId);
    }

    let credentials: MintResponse | undefined;
    try {
      if (stored.authConnectionId) {
        const bundle = await this.#requireVault().mintForPhase({
          workspaceId: run.workspaceId,
          phase: "source",
          sourceConnectionId: stored.authConnectionId,
          // The vault refuses to mint a git token for a host the connection is
          // not bound to, so the Source URL is part of the mint request.
          sourceUrl: stored.url,
        });
        await this.#recordSourceCredentialMintEvent({
          runId: run.id,
          workspaceId: run.workspaceId,
          sourceId: run.sourceId,
          connectionId: stored.authConnectionId,
        });
        credentials = bundle.toMintResponse();
      }
    } catch (error) {
      await this.#failSourceSyncRun(running, leaseToken, mapVaultError(error));
      return await this.#store.getSourceSyncRun(runId);
    }

    try {
      const reuseSnapshot = await this.#latestReusableSourceSnapshot(running);
      const result = await this.#withSourceSyncRenewal(
        running,
        leaseToken,
        () =>
          sourceSync.call(this.#runner, {
            runId: run.id,
            workspaceId: run.workspaceId,
            sourceId: run.sourceId,
            source: { url: run.url, ref: run.ref, path: run.path },
            archiveRef: run.archiveRef,
            ...(reuseSnapshot
              ? {
                  reuseSnapshot: {
                    id: reuseSnapshot.id,
                    resolvedCommit: reuseSnapshot.resolvedCommit,
                    archiveRef: reuseSnapshot.archiveRef,
                    archiveDigest: reuseSnapshot.archiveDigest,
                    archiveSizeBytes: reuseSnapshot.archiveSizeBytes,
                  },
                }
              : {}),
            ...(credentials ? { credentials } : {}),
          }, { runLease: { runId: running.id, leaseToken } }),
      );
      return await this.#succeedSourceSyncRun(
        running,
        leaseToken,
        result,
        reuseSnapshot,
      );
    } catch (error) {
      await this.#failSourceSyncRun(running, leaseToken, error);
      return await this.#store.getSourceSyncRun(runId);
    }
  }

  async #claimSourceSyncRun(run: SourceSyncRun): Promise<
    | {
        readonly won: true;
        readonly running: SourceSyncRun;
        readonly leaseToken: string;
      }
    | { readonly won: false; readonly run: SourceSyncRun }
  > {
    const startedAtMs = this.#now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    const leaseToken = this.#newId("lease");
    const running: SourceSyncRun = {
      ...run,
      status: "running",
      startedAt: run.startedAt ?? startedAtIso,
      heartbeatAt: startedAtMs,
      updatedAt: startedAtIso,
    };
    const claim = await this.#store.transitionRun({
      id: run.id,
      kind: "source_sync",
      expectFrom: [run.status],
      ...(run.status === "running"
        ? { expectHeartbeatAt: run.heartbeatAt ?? null }
        : {}),
      run: running,
      setLeaseToken: leaseToken,
      heartbeatAt: startedAtMs,
    });
    if (!claim.won) {
      return {
        won: false,
        run: (claim.run ?? run) as SourceSyncRun,
      };
    }
    return { won: true, running: claim.run as SourceSyncRun, leaseToken };
  }

  async #succeedSourceSyncRun(
    running: SourceSyncRun,
    leaseToken: string,
    result: OpenTofuSourceSyncResult,
    reuseSnapshot: SourceSnapshot | undefined,
  ): Promise<SourceSyncRun | undefined> {
    const finishedAtMs = this.#now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    // A manual Workload review may pin the Source to an immutable commit. The
    // runner is untrusted with respect to that authority: never persist a
    // succeeded Run or Snapshot when it resolves a different (or malformed)
    // commit. Throwing here is caught by the consumer and records the existing
    // Run as failed before any Snapshot write occurs.
    if (
      isExactImmutableGitCommit(running.ref) &&
      (!isExactImmutableGitCommit(result.resolvedCommit) ||
        normalizeGitObjectId(result.resolvedCommit) !==
          normalizeGitObjectId(running.ref))
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "source_sync resolved a commit different from the requested immutable Source revision",
        { reason: "source_revision_mismatch" },
      );
    }
    const snapshotId = running.snapshotId ?? this.#newId("snap");
    const archiveRef = this.#verifiedSourceArchiveRef(
      running,
      result,
      reuseSnapshot,
    );
    const repositoryInstallMetadata =
      result.repositoryInstallMetadata ??
      (reuseSnapshot && archiveRef === reuseSnapshot.archiveRef
        ? reuseSnapshot.repositoryInstallMetadata
        : undefined);
    const repositoryManifest =
      result.repositoryManifest ??
      (reuseSnapshot && archiveRef === reuseSnapshot.archiveRef
        ? reuseSnapshot.repositoryManifest
        : undefined);
    const repositoryModules = result.repositoryModules;
    if (!repositoryInstallMetadata) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "source_sync did not observe repository install metadata",
      );
    }
    if (!repositoryManifest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "source_sync did not observe the repository manifest",
      );
    }
    if (!repositoryModules) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "source_sync did not observe repository OpenTofu modules",
      );
    }
    const snapshot: SourceSnapshot = {
      id: snapshotId,
      origin: "git",
      workspaceId: running.workspaceId,
      sourceId: running.sourceId,
      url: running.url,
      ref: running.ref,
      resolvedCommit: result.resolvedCommit,
      path: running.path,
      archiveRef,
      archiveDigest: result.archiveDigest,
      archiveSizeBytes: result.archiveSizeBytes,
      repositoryInstallMetadata,
      repositoryManifest,
      repositoryModules,
      fetchedByRunId: running.id,
      fetchedAt: finishedAtIso,
    };
    const succeeded: SourceSyncRun = {
      ...running,
      status: "succeeded",
      heartbeatAt: finishedAtMs,
      finishedAt: finishedAtIso,
      updatedAt: finishedAtIso,
      resolvedCommit: result.resolvedCommit,
      archiveDigest: result.archiveDigest,
      archiveSizeBytes: result.archiveSizeBytes,
      snapshotId,
      ...(result.phaseTimings?.length
        ? { phaseTimings: result.phaseTimings }
        : {}),
    };
    const terminal = await this.#store.commitSourceSyncSuccess({
      terminalRun: succeeded,
      leaseToken,
      snapshot,
    });
    if (!terminal.won) {
      // A vanished/lost Run is not a successfully committed observation.
      return terminal.run;
    }
    const terminalRun = terminal.run ?? succeeded;
    const canonicalSnapshot =
      terminal.snapshot ??
      (terminalRun.snapshotId === snapshot.id
        ? snapshot
        : terminalRun.snapshotId
          ? await this.#store.getSourceSnapshot(terminalRun.snapshotId)
          : undefined);
    if (!canonicalSnapshot) return terminalRun;
    await this.#cleanupUnusedSourceArchive(terminalRun);
    await this.#notifySourceCapsulesStaleForNewSnapshot({
      running,
      snapshot: canonicalSnapshot,
      capsules: terminal.staleCapsules ?? [],
    });
    return terminalRun;
  }

  async #notifySourceCapsulesStaleForNewSnapshot(input: {
    readonly running: SourceSyncRun;
    readonly snapshot: SourceSnapshot;
    readonly capsules: readonly Capsule[];
  }): Promise<void> {
    // The SourceSync Run's original admission tuple is the only authority a
    // post-drain completion may forward to automatic follow-up. Public Run
    // projections strip this metadata, so ask the exact internal identity
    // seam before iterating Capsules. A missing/corrupt historical tuple is
    // fail-closed for the follow-up only; stale projection and Activity were
    // already committed atomically with the SourceSync result.
    let expectedWorkspaceManagementAuthority:
      | WorkspaceManagementAuthority
      | undefined;
    if (input.running.intent !== "manual_plan") {
      try {
        expectedWorkspaceManagementAuthority =
          await this.#store.getRunManagementAuthority({
            id: input.running.id,
            workspaceId: input.running.workspaceId,
            kind: "source_sync",
          });
      } catch {
        expectedWorkspaceManagementAuthority = undefined;
      }
    }
    for (const staleCapsule of input.capsules) {
      // Auto-update hook: the controller decides (autoUpdate opt-in +
      // one-attempt-per-snapshot backoff) and enqueues the update plan.
      if (input.running.intent !== "manual_plan") {
        if (expectedWorkspaceManagementAuthority === undefined) continue;
        // Source finalization is allowed to converge after a drain, but a
        // known-stopped Workspace must not start a new auto-update side effect.
        // This read is only an optimization: the durable auto-update claim and
        // any new Plan admission remain the storage/controller authority for a
        // race that flips management state after this observation.
        try {
          const management = await this.#store.getWorkspaceManagement(
            input.running.workspaceId,
          );
          if (
            management?.workspaceId !==
              expectedWorkspaceManagementAuthority.workspaceId ||
            management.managementState !== "active" ||
            management.managementEpoch !==
              expectedWorkspaceManagementAuthority.managementEpoch
          ) continue;
        } catch {
          // A transient management read leaves the Workspace state unknown;
          // skip this Capsule's auto-update attempt without undoing any
          // committed projection or suppressing the other callbacks.
          continue;
        }
        await this.#onCapsuleStaleForNewSnapshot?.({
          capsule: staleCapsule,
          snapshot: input.snapshot,
          expectedWorkspaceManagementAuthority,
        });
      }
    }
  }

  #verifiedSourceArchiveRef(
    running: SourceSyncRun,
    result: OpenTofuSourceSyncResult,
    reuseSnapshot: SourceSnapshot | undefined,
  ): string {
    const archiveRef = result.archiveRef ?? running.archiveRef;
    if (archiveRef === running.archiveRef) return archiveRef;
    if (
      reuseSnapshot &&
      reuseSnapshot.sourceId === running.sourceId &&
      archiveRef === reuseSnapshot.archiveRef &&
      result.resolvedCommit === reuseSnapshot.resolvedCommit &&
      result.archiveDigest === reuseSnapshot.archiveDigest &&
      result.archiveSizeBytes === reuseSnapshot.archiveSizeBytes
    ) {
      return archiveRef;
    }
    throw new OpenTofuControllerError(
      "failed_precondition",
      "source_sync returned archive metadata outside the requested SourceSnapshot boundary",
    );
  }

  async #latestReusableSourceSnapshot(
    running: SourceSyncRun,
  ): Promise<SourceSnapshot | undefined> {
    const snapshot = await this.#store.getLatestSourceSnapshotForLane({
      sourceId: running.sourceId,
      workspaceId: running.workspaceId,
      url: running.url,
      ref: running.ref,
      path: running.path,
    });
    return snapshot && sourceSnapshotMatchesRun(snapshot, running)
      ? snapshot
      : undefined;
  }

  async #cleanupUnusedSourceArchive(run: SourceSyncRun): Promise<void> {
    if (run.status !== "succeeded" || !run.snapshotId) return;
    try {
      // Re-read after settlement, including redeliveries. The allocated key is
      // unique to this Run; a reused snapshot may point at another key.
      const terminal = await this.#store.getSourceSyncRun(run.id);
      if (terminal?.status !== "succeeded" ||
        terminal.snapshotId !== run.snapshotId ||
        terminal.archiveRef !== run.archiveRef ||
        !terminal.requestedSnapshotId ||
        terminal.requestedSnapshotId === terminal.snapshotId) return;
      const canonical = await this.#store.getSourceSnapshot(run.snapshotId);
      if (!canonical || canonical.archiveRef === run.archiveRef) return;
      if (canonical.workspaceId !== run.workspaceId ||
        canonical.sourceId !== run.sourceId ||
        canonical.id !== run.snapshotId) return;
      // A historical/sibling snapshot may retain this exact key. The local
      // archive adapter cannot consult the ledger itself, so Core fences the
      // deletion before invoking either host's custody path.
      if (await this.#store.hasSourceSnapshotArchiveReference(run.archiveRef, run.sourceId)) return;
      if (await this.#store.hasForeignSourceArchiveReference(run.archiveRef, run.sourceId)) return;
      const cleanup = this.#runner?.cleanupUnusedSourceArchive;
      if (!cleanup) throw new Error("runner source archive cleanup capability is unavailable");
      await cleanup.call(this.#runner, {
        runId: run.id,
        workspaceId: run.workspaceId,
        sourceId: run.sourceId,
        archiveRef: run.archiveRef,
        canonicalSnapshotId: canonical.id,
      });
    } catch (error) {
      // Cleanup is retryable by redelivering the already-terminal Run. It must
      // not change a committed SourceSync success or stale projection.
      console.error("SourceSync unused archive cleanup failed; redeliver the terminal Run to retry", {
        runId: run.id,
        error: errorMessage(error),
      });
    }
  }

  async #failSourceSyncRun(
    running: SourceSyncRun,
    leaseToken: string,
    error: unknown,
  ): Promise<void> {
    const finishedAtMs = this.#now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    const failed: SourceSyncRun = {
      ...running,
      status: "failed",
      heartbeatAt: finishedAtMs,
      finishedAt: finishedAtIso,
      updatedAt: finishedAtIso,
      error: errorMessage(error),
      errorCode: sourceSyncErrorCode(error),
    };
    await this.#persistTerminalSourceSyncRun(failed, leaseToken);
  }

  async #withSourceSyncRenewal<T>(
    run: SourceSyncRun,
    leaseToken: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const intervalMs = this.#runRenewalIntervalMs;
    if (intervalMs <= 0) {
      return await work();
    }
    const tick = async (): Promise<void> => {
      try {
        await this.#heartbeatRunningSourceSyncRun(run, leaseToken);
      } catch {
        // Best-effort: a stale/lost renewal is observed by a sibling worker via
        // the lease fence; the runner result itself should not be rejected here.
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  async #heartbeatRunningSourceSyncRun(
    run: SourceSyncRun,
    leaseToken: string,
  ): Promise<void> {
    const now = this.#now();
    const updatedAt = new Date(now).toISOString();
    await this.#store.transitionRun({
      id: run.id,
      kind: "source_sync",
      expectFrom: ["running"],
      expectLeaseToken: leaseToken,
      run: { ...run, status: "running", heartbeatAt: now, updatedAt },
      heartbeatAt: now,
    });
  }

  async #persistTerminalSourceSyncRun(
    terminal: SourceSyncRun,
    leaseToken: string,
  ): Promise<{ readonly won: boolean; readonly run: SourceSyncRun }> {
    const result = await this.#store.transitionRun({
      id: terminal.id,
      kind: "source_sync",
      expectFrom: NON_TERMINAL_RUN_STATUSES,
      expectLeaseToken: leaseToken,
      run: terminal,
      clearLeaseToken: true,
    });
    return {
      won: result.won,
      run: (result.won ? terminal : (result.run ?? terminal)) as SourceSyncRun,
    };
  }

  async #recordSourceCredentialMintEvent(input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly connectionId: string;
  }): Promise<void> {
    await this.#store.putCredentialMintEvent({
      id: this.#newId("credmint"),
      runId: input.runId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      connectionId: input.connectionId,
      phase: "source",
      capabilities: ["source"],
      createdAt: new Date(this.#now()).toISOString(),
    });
  }
}

function sourceSyncErrorCode(error: unknown): string {
  const reason = structuredErrorReason(error);
  if (reason && /^[a-z][a-z0-9_]{2,63}$/u.test(reason)) {
    return reason;
  }
  return "source_sync_failed";
}

function sourceSnapshotMatchesRun(
  snapshot: SourceSnapshot,
  running: SourceSyncRun,
): boolean {
  return (
    snapshot.origin === "git" &&
    snapshot.sourceId === running.sourceId &&
    snapshot.workspaceId === running.workspaceId &&
    snapshot.url === running.url &&
    snapshot.ref === running.ref &&
    snapshot.path === running.path
  );
}

function isExactImmutableGitCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/iu.test(value);
}

function normalizeGitObjectId(value: string): string {
  return value.toLowerCase();
}
