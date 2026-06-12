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
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { ConnectionVault } from "../../adapters/vault/mod.ts";
import type { SourcesService } from "../sources/mod.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
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
  readonly sourcesService?: SourcesService;
  readonly runner?: OpenTofuRunner;
  /** Resolves the wired vault, throwing `not_implemented` when none is configured. */
  readonly requireVault: () => ConnectionVault;
  /** Shared run-heartbeat idempotency predicate (queued, or running-but-stale). */
  readonly shouldProcessRun: (
    status: RunStatus,
    heartbeatAt: number | undefined,
  ) => boolean;
}

/**
 * Collaborator owning the `source_sync` consumer + finalization. Behavior is
 * identical to the prior inline controller methods.
 */
export class SourceLifecycleService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #now: () => number;
  readonly #newId: (prefix: string) => string;
  readonly #sourcesService?: SourcesService;
  readonly #runner?: OpenTofuRunner;
  readonly #requireVault: () => ConnectionVault;
  readonly #shouldProcessRun: (
    status: RunStatus,
    heartbeatAt: number | undefined,
  ) => boolean;

  constructor(dependencies: SourceLifecycleServiceDependencies) {
    this.#store = dependencies.store;
    this.#now = dependencies.now;
    this.#newId = dependencies.newId;
    this.#sourcesService = dependencies.sourcesService;
    this.#runner = dependencies.runner;
    this.#requireVault = dependencies.requireVault;
    this.#shouldProcessRun = dependencies.shouldProcessRun;
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
    const startedAtMs = this.#now();
    const running: SourceSyncRun = {
      ...run,
      status: "running",
      startedAt: new Date(startedAtMs).toISOString(),
      heartbeatAt: startedAtMs,
      updatedAt: new Date(startedAtMs).toISOString(),
    };
    await this.#store.putSourceSyncRun(running);

    let stored;
    try {
      stored = await sources.getStoredSource(run.sourceId);
    } catch (error) {
      await this.#failSourceSyncRun(running, error);
      return await this.#store.getSourceSyncRun(runId);
    }

    let credentials;
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
      await this.#failSourceSyncRun(running, mapVaultError(error));
      return await this.#store.getSourceSyncRun(runId);
    }

    try {
      const result = await this.#runner.sourceSync({
        runId: run.id,
        spaceId: run.spaceId,
        sourceId: run.sourceId,
        source: { url: run.url, ref: run.ref, path: run.path },
        archiveObjectKey: run.archiveObjectKey,
        ...(credentials ? { credentials } : {}),
      });
      return await this.#succeedSourceSyncRun(running, result);
    } catch (error) {
      await this.#failSourceSyncRun(running, error);
      return await this.#store.getSourceSyncRun(runId);
    }
  }

  async #succeedSourceSyncRun(
    running: SourceSyncRun,
    result: OpenTofuSourceSyncResult,
  ): Promise<SourceSyncRun> {
    const finishedAtMs = this.#now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();
    const snapshotId = running.snapshotId ?? this.#newId("snap");
    const snapshot: SourceSnapshot = {
      id: snapshotId,
      origin: "git",
      spaceId: running.spaceId,
      sourceId: running.sourceId,
      url: running.url,
      ref: running.ref,
      resolvedCommit: result.resolvedCommit,
      path: running.path,
      archiveObjectKey: running.archiveObjectKey,
      archiveDigest: result.archiveDigest,
      archiveSizeBytes: result.archiveSizeBytes,
      fetchedByRunId: running.id,
      fetchedAt: finishedAtIso,
    };
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
    };
    await this.#store.putSourceSyncRun(succeeded);
    return succeeded;
  }

  async #failSourceSyncRun(
    running: SourceSyncRun,
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
    await this.#store.putSourceSyncRun(failed);
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
      spaceId: input.spaceId,
      sourceId: input.sourceId,
      connectionId: input.connectionId,
      phase: "source",
      capabilities: ["source"],
      createdAt: new Date(this.#now()).toISOString(),
    });
  }
}
