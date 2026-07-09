/**
 * Source-sync consumer + finalization facade (Core Specification §6).
 *
 * A cohesive collaborator pulled out of `OpenTofuDeploymentController`: it owns
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
 * instances are used here as on the controller. The controller keeps
 * `runQueuedSourceSync` as a thin delegating wrapper, so the queue consumer and
 * the inline dispatcher keep calling the controller surface unchanged.
 *
 * Behavior is identical to the prior inline controller methods: exact signatures,
 * error codes, ordering, and run/state semantics are preserved. Credential
 * material is never logged.
 */

import type { RunStatus } from "@takosumi/internal/deploy-control-api";
import type { Capsule as Installation } from "takosumi-contract/capsules";
import type {
  MintResponse,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { ConnectionVault } from "../../adapters/vault/mod.ts";
import type { SourcesService } from "../sources/mod.ts";
import type { OpenTofuDeploymentStore, StoredSource } from "./store.ts";
import type { OpenTofuRunner, OpenTofuSourceSyncResult } from "./mod.ts";
import { mapVaultError, OpenTofuControllerError } from "./errors.ts";
import { errorMessage } from "./projection.ts";

/**
 * Ports the controller injects into {@link SourceLifecycleService}. `store` /
 * `now` / `newId` mirror the controller's own handles; `sourcesService` and
 * `runner` are the optional source-sync collaborators (absent leaves runs
 * queued); `requireVault` resolves the wired {@link ConnectionVault} (the SAME
 * `not_implemented` fail-closed as the controller); `shouldProcessRun` is the
 * shared run-heartbeat idempotency predicate (also used by the plan/apply
 * consumers, so it stays owned by the controller and is passed in).
 */
export interface SourceLifecycleServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
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
    readonly capsule: Installation;
    readonly snapshot: SourceSnapshot;
  }) => Promise<void>;
}

/**
 * Collaborator owning the `source_sync` consumer + finalization. Behavior is
 * identical to the prior inline controller methods.
 */
export class SourceLifecycleService {
  readonly #store: OpenTofuDeploymentStore;
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
    readonly capsule: Installation;
    readonly snapshot: SourceSnapshot;
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

  /**
   * Source-sync consumer (Core Specification §6). Idempotency guard, transition
   * to `running`, mint source-phase credentials NOW (git-only; never provider),
   * dispatch to the runner, and on success record the SourceSnapshot + update the
   * Source's `lastSeenCommit`. Never logs credential material.
   */
  async runQueuedSourceSync(runId: string): Promise<SourceSyncRun | undefined> {
    const sources = this.#sourcesService;
    if (!sources || !this.#runner?.sourceSync) {
      return await this.#store.getSourceSyncRun(runId);
    }
    const run = await this.#store.getSourceSyncRun(runId);
    if (!run) {
      throw new OpenTofuControllerError(
        "not_found",
        `source sync run ${runId} not found`,
      );
    }
    if (!this.#shouldProcessRun(run.status, run.heartbeatAt)) {
      return run;
    }
    const claim = await this.#claimSourceSyncRun(run);
    if (!claim.won) {
      return claim.run;
    }
    const { running, leaseToken } = claim;

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
          spaceId: run.spaceId,
          phase: "source",
          sourceConnectionId: stored.authConnectionId,
        });
        await this.#recordSourceCredentialMintEvent({
          runId: run.id,
          spaceId: run.spaceId,
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
      const reuseSnapshot = await this.#latestReusableSourceSnapshot(
        running,
        stored,
      );
      if (
        reuseSnapshot &&
        canReusePinnedSourceSnapshotWithoutRunner(running, reuseSnapshot)
      ) {
        return await this.#succeedSourceSyncRun(
          running,
          leaseToken,
          sourceSyncResultFromSnapshot(reuseSnapshot),
          reuseSnapshot,
        );
      }
      const result = await this.#withSourceSyncRenewal(
        running,
        leaseToken,
        () =>
          this.#runner!.sourceSync!({
            runId: run.id,
            spaceId: run.spaceId,
            sourceId: run.sourceId,
            source: { url: run.url, ref: run.ref, path: run.path },
            archiveObjectKey: run.archiveObjectKey,
            ...(reuseSnapshot
              ? {
                  reuseSnapshot: {
                    id: reuseSnapshot.id,
                    resolvedCommit: reuseSnapshot.resolvedCommit,
                    archiveObjectKey: reuseSnapshot.archiveObjectKey,
                    archiveDigest: reuseSnapshot.archiveDigest,
                    archiveSizeBytes: reuseSnapshot.archiveSizeBytes,
                  },
                }
              : {}),
            ...(credentials ? { credentials } : {}),
          }),
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
  ): Promise<SourceSyncRun> {
    const finishedAtMs = this.#now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    const snapshotId = running.snapshotId ?? this.#newId("snap");
    const archiveObjectKey = this.#verifiedSourceArchiveObjectKey(
      running,
      result,
      reuseSnapshot,
    );
    const snapshot: SourceSnapshot = {
      id: snapshotId,
      origin: "git",
      workspaceId: running.workspaceId,
      spaceId: running.spaceId,
      sourceId: running.sourceId,
      url: running.url,
      ref: running.ref,
      resolvedCommit: result.resolvedCommit,
      path: running.path,
      archiveObjectKey,
      archiveDigest: result.archiveDigest,
      archiveSizeBytes: result.archiveSizeBytes,
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
    const terminal = await this.#persistTerminalSourceSyncRun(
      succeeded,
      leaseToken,
    );
    if (!terminal.won) {
      return terminal.run;
    }
    await this.#store.putSourceSnapshot(snapshot);
    // Record lastSeenCommit on the Source so the scheduler can skip an unchanged
    // ref. Read-modify-write through the store (internal field, never projected).
    const stored = await this.#store.getSource(running.sourceId);
    if (stored) {
      await this.#store.putSource({
        ...stored,
        lastSeenCommit: result.resolvedCommit,
        updatedAt: finishedAtIso,
      });
    }
    await this.#markSourceCapsulesStaleForNewSnapshot({
      running,
      snapshot,
      finishedAtIso,
    });
    return succeeded;
  }

  async #markSourceCapsulesStaleForNewSnapshot(input: {
    readonly running: SourceSyncRun;
    readonly snapshot: SourceSnapshot;
    readonly finishedAtIso: string;
  }): Promise<void> {
    const capsules = await this.#store.listInstallations(
      input.running.workspaceId,
    );
    for (const capsule of capsules) {
      if (
        capsule.sourceId !== input.running.sourceId ||
        capsule.status !== "active"
      ) {
        continue;
      }
      const currentDeploymentId = capsule.currentDeploymentId;
      if (!currentDeploymentId) continue;
      const deployment = await this.#store.getDeployment(currentDeploymentId);
      if (!deployment) continue;
      if (deployment.sourceSnapshotId === input.snapshot.id) continue;
      const deployedSnapshot = await this.#store.getSourceSnapshot(
        deployment.sourceSnapshotId,
      );
      if (
        deployedSnapshot &&
        sourceSnapshotsRepresentSameGitCommit(deployedSnapshot, input.snapshot)
      ) {
        continue;
      }
      await this.#store.patchInstallation(capsule.id, {
        status: "stale",
        updatedAt: input.finishedAtIso,
      });
      await this.#store.putActivityEvent({
        id: this.#newId("act"),
        workspaceId: capsule.workspaceId ?? capsule.spaceId,
        spaceId: capsule.workspaceId ?? capsule.spaceId,
        action: "installation.stale",
        targetType: "installation",
        targetId: capsule.id,
        metadata: {
          reason: "source_ref_changed",
          sourceId: input.running.sourceId,
          sourceSnapshotId: input.snapshot.id,
          previousSourceSnapshotId: deployment.sourceSnapshotId,
          resolvedCommit: input.snapshot.resolvedCommit,
          previousResolvedCommit: deployedSnapshot?.resolvedCommit ?? null,
          ref: input.running.ref,
          path: input.running.path,
        },
        createdAt: input.finishedAtIso,
      });
      // Auto-update hook: the controller decides (autoUpdate opt-in +
      // one-attempt-per-snapshot backoff) and enqueues the update plan.
      await this.#onCapsuleStaleForNewSnapshot?.({
        capsule,
        snapshot: input.snapshot,
      });
    }
  }

  #verifiedSourceArchiveObjectKey(
    running: SourceSyncRun,
    result: OpenTofuSourceSyncResult,
    reuseSnapshot: SourceSnapshot | undefined,
  ): string {
    const archiveObjectKey =
      result.archiveObjectKey ?? running.archiveObjectKey;
    if (archiveObjectKey === running.archiveObjectKey) return archiveObjectKey;
    if (
      reuseSnapshot &&
      archiveObjectKey === reuseSnapshot.archiveObjectKey &&
      result.resolvedCommit === reuseSnapshot.resolvedCommit &&
      result.archiveDigest === reuseSnapshot.archiveDigest &&
      result.archiveSizeBytes === reuseSnapshot.archiveSizeBytes
    ) {
      return archiveObjectKey;
    }
    throw new OpenTofuControllerError(
      "failed_precondition",
      "source_sync returned archive metadata outside the requested SourceSnapshot boundary",
    );
  }

  async #latestReusableSourceSnapshot(
    running: SourceSyncRun,
    stored: StoredSource,
  ): Promise<SourceSnapshot | undefined> {
    const snapshots = await this.#store.listSourceSnapshots(running.sourceId);
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index]!;
      if (sourceSnapshotMatchesRun(snapshot, running)) {
        return snapshot;
      }
    }
    if (stored.authConnectionId) return undefined;
    const siblingSources = (await this.#store.listSources(running.spaceId))
      .filter((source) => source.id !== running.sourceId)
      .filter((source) => !source.authConnectionId)
      .filter(
        (source) =>
          source.status === "active" &&
          source.url === running.url &&
          source.defaultRef === running.ref &&
          source.defaultPath === running.path,
      );
    if (siblingSources.length === 0) return undefined;
    const siblingSnapshots = await this.#store.listSourceSnapshotsBySourceIds(
      siblingSources.map((source) => source.id),
    );
    const reusable = siblingSnapshots
      .filter((snapshot) => sourceSnapshotMatchesRun(snapshot, running))
      .sort((a, b) => compareIso(a.fetchedAt, b.fetchedAt));
    return reusable.at(-1);
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
      expectFrom: ["queued", "running"],
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
    readonly spaceId: string;
    readonly sourceId: string;
    readonly connectionId: string;
  }): Promise<void> {
    await this.#store.putCredentialMintEvent({
      id: this.#newId("credmint"),
      runId: input.runId,
      workspaceId: input.spaceId,
      sourceId: input.sourceId,
      connectionId: input.connectionId,
      phase: "source",
      capabilities: ["source"],
      createdAt: new Date(this.#now()).toISOString(),
    });
  }
}

function sourceSnapshotMatchesRun(
  snapshot: SourceSnapshot,
  running: SourceSyncRun,
): boolean {
  return (
    snapshot.origin === "git" &&
    snapshot.spaceId === running.spaceId &&
    snapshot.url === running.url &&
    snapshot.ref === running.ref &&
    snapshot.path === running.path
  );
}

function sourceSnapshotsRepresentSameGitCommit(
  a: SourceSnapshot,
  b: SourceSnapshot,
): boolean {
  return (
    a.origin === "git" &&
    b.origin === "git" &&
    a.sourceId === b.sourceId &&
    a.url === b.url &&
    a.ref === b.ref &&
    a.path === b.path &&
    a.resolvedCommit === b.resolvedCommit
  );
}

function canReusePinnedSourceSnapshotWithoutRunner(
  running: SourceSyncRun,
  snapshot: SourceSnapshot,
): boolean {
  return (
    sourceSnapshotMatchesRun(snapshot, running) &&
    isPinnedGitCommit(running.ref) &&
    normalizeGitObjectId(running.ref) ===
      normalizeGitObjectId(snapshot.resolvedCommit)
  );
}

function sourceSyncResultFromSnapshot(
  snapshot: SourceSnapshot,
): OpenTofuSourceSyncResult {
  return {
    resolvedCommit: snapshot.resolvedCommit,
    archiveDigest: snapshot.archiveDigest,
    archiveSizeBytes: snapshot.archiveSizeBytes,
    archiveObjectKey: snapshot.archiveObjectKey,
  };
}

function isPinnedGitCommit(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value);
}

function normalizeGitObjectId(value: string): string {
  return value.toLowerCase();
}

function compareIso(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
