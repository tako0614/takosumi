import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import type {
  OpenTofuApplyJob,
  OpenTofuApplyResult,
  OpenTofuCapsuleSourceFile,
  OpenTofuCapsuleSourceFilesJob,
  OpenTofuDestroyJob,
  OpenTofuDestroyResult,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
  OpenTofuSourceSyncJob,
  OpenTofuSourceSyncResult,
  OpenTofuStableSourceTagResolutionJob,
  OpenTofuStableSourceTagResolutionResult,
  OpenTofuSourceSnapshotPresentationFileJob,
  OpenTofuSourceSnapshotPresentationFile,
  ProviderInstallationEvidence,
  ReleaseCommandRunJob,
  ReleaseCommandRunResult,
  RunExecutionControl,
} from "../../../core/domains/deploy-control/mod.ts";
import { DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID } from "../../../core/domains/deploy-control/mod.ts";
import {
  OpenTofuRunnerExecutionError,
  OpenTofuRunnerInfrastructureError,
} from "../../../core/domains/deploy-control/errors.ts";
import type { SecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { normalizePlanResourceScope } from "takosumi-contract";
import { parseRepositoryManifestSnapshot } from "takosumi-contract/sources";
import type {
  DispatchPriorState,
  DispatchStateScope,
  OpenTofuOutputEnvelope,
  DispatchStateAdoption,
  OpenTofuPlanArtifact,
  PlanResourceChange,
  RunnerProfile,
  RunDiagnostic,
} from "@takosumi/internal/deploy-control-api";
import { handleRunnerRequest } from "../../../runner/entrypoint.ts";

export const LOCAL_OPENTOFU_RUNNER_PROFILE_ID = "local-opentofu";

interface RunnerTransport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface SourceArchiveStore {
  write(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
}

export interface LocalOpenTofuStateArtifact {
  readonly stateRef: string;
  readonly workspaceId: string;
  readonly subject: NonNullable<DispatchStateScope["subject"]>;
  readonly environment: string;
  readonly generation: number;
  readonly createdByRunId: string;
  readonly action: "apply" | "destroy";
  readonly stateDigest: string;
  readonly stateBytes: Uint8Array;
  readonly result: OpenTofuApplyResult | OpenTofuDestroyResult;
}

export interface LocalOpenTofuRawOutputArtifact {
  readonly rawOutputRef: string;
  readonly workspaceId: string;
  readonly subject: NonNullable<DispatchStateScope["subject"]>;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly stateDigest: string;
  readonly createdByRunId: string;
  readonly action: "apply";
  readonly outputDigest: string;
  readonly outputs: OpenTofuOutputEnvelope;
}

/**
 * Durable exact-key authority for local-substrate OpenTofu state. A target ref
 * is immutable: replay by the same ApplyRun adopts it, while a different run
 * is fenced before OpenTofu can execute provider side effects.
 */
export interface LocalOpenTofuStateArtifactStore {
  read(stateRef: string): Promise<LocalOpenTofuStateArtifact | undefined>;
  commit(
    artifact: LocalOpenTofuStateArtifact,
  ): Promise<LocalOpenTofuStateArtifact>;
  readRawOutput(
    rawOutputRef: string,
  ): Promise<LocalOpenTofuRawOutputArtifact | undefined>;
  commitRawOutput(
    artifact: LocalOpenTofuRawOutputArtifact,
  ): Promise<LocalOpenTofuRawOutputArtifact>;
}

export function createFileSourceArchiveStore(root: string): SourceArchiveStore {
  const normalizedRoot = resolve(root);
  return {
    write: async (key, bytes) => {
      const path = archivePath(normalizedRoot, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    read: async (key) =>
      new Uint8Array(await readFile(archivePath(normalizedRoot, key))),
  };
}

export function createFileOpenTofuStateArtifactStore(
  root: string,
  cryptoBoundary: SecretBoundaryCrypto,
): LocalOpenTofuStateArtifactStore {
  const normalizedRoot = resolve(root);
  const read = async (
    stateRef: string,
  ): Promise<LocalOpenTofuStateArtifact | undefined> => {
    const path = await stateArtifactPath(normalizedRoot, stateRef);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    return await parseStateArtifactEnvelope(text, stateRef, cryptoBoundary);
  };
  const readRawOutput = async (
    rawOutputRef: string,
  ): Promise<LocalOpenTofuRawOutputArtifact | undefined> => {
    const path = await rawOutputArtifactPath(normalizedRoot, rawOutputRef);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    return await parseRawOutputArtifactEnvelope(
      text,
      rawOutputRef,
      cryptoBoundary,
    );
  };
  return {
    read,
    commit: async (artifact) => {
      await assertLocalStateArtifact(artifact);
      const path = await stateArtifactPath(normalizedRoot, artifact.stateRef);
      const artifactDirectory = dirname(path);
      await mkdir(normalizedRoot, { recursive: true });
      await syncDirectory(dirname(normalizedRoot));
      await mkdir(artifactDirectory, { recursive: true });
      await syncDirectory(normalizedRoot);
      const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
      const metadata = {
        version: 2,
        stateRef: artifact.stateRef,
        workspaceId: artifact.workspaceId,
        subject: artifact.subject,
        environment: artifact.environment,
        generation: artifact.generation,
        createdByRunId: artifact.createdByRunId,
        action: artifact.action,
        stateDigest: artifact.stateDigest,
      } as const;
      const sealed = await cryptoBoundary.seal(
        JSON.stringify({
          stateBase64: Buffer.from(artifact.stateBytes).toString("base64"),
          result: artifact.result,
        }),
        "global",
        localStateArtifactAad(metadata),
      );
      const envelope = `${JSON.stringify({
        ...metadata,
        ciphertextBase64: Buffer.from(sealed).toString("base64"),
      })}\n`;
      try {
        const temporary = await open(temporaryPath, "wx", 0o600);
        try {
          await temporary.writeFile(envelope);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        try {
          // link(2) gives us an atomic, no-replace publication fence. rename(2)
          // would silently overwrite a different ApplyRun's committed state.
          await link(temporaryPath, path);
          await syncDirectory(artifactDirectory);
          return artifact;
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
          const existing = await read(artifact.stateRef);
          if (!existing) {
            throw new Error(
              `local OpenTofu state ${artifact.stateRef} disappeared during immutable commit`,
            );
          }
          assertSameStateMutation(existing, artifact);
          return existing;
        }
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }
    },
    readRawOutput,
    commitRawOutput: async (artifact) => {
      await assertLocalRawOutputArtifact(artifact);
      const path = await rawOutputArtifactPath(
        normalizedRoot,
        artifact.rawOutputRef,
      );
      const rawOutputRoot = resolve(normalizedRoot, "raw-output");
      const artifactDirectory = dirname(path);
      await mkdir(normalizedRoot, { recursive: true });
      await syncDirectory(dirname(normalizedRoot));
      await mkdir(rawOutputRoot, { recursive: true });
      await syncDirectory(normalizedRoot);
      await mkdir(artifactDirectory, { recursive: true });
      await syncDirectory(rawOutputRoot);
      const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
      const metadata = {
        version: 1,
        kind: "raw_output" as const,
        rawOutputRef: artifact.rawOutputRef,
        workspaceId: artifact.workspaceId,
        subject: artifact.subject,
        environment: artifact.environment,
        generation: artifact.generation,
        stateRef: artifact.stateRef,
        stateDigest: artifact.stateDigest,
        createdByRunId: artifact.createdByRunId,
        action: artifact.action,
        outputDigest: artifact.outputDigest,
      } as const;
      const sealed = await cryptoBoundary.seal(
        JSON.stringify({ outputs: artifact.outputs }),
        "global",
        localRawOutputArtifactAad(metadata),
      );
      const envelope = `${JSON.stringify({
        ...metadata,
        ciphertextBase64: Buffer.from(sealed).toString("base64"),
      })}\n`;
      try {
        const temporary = await open(temporaryPath, "wx", 0o600);
        try {
          await temporary.writeFile(envelope);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        try {
          await link(temporaryPath, path);
          await syncDirectory(artifactDirectory);
          return artifact;
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
          const existing = await readRawOutput(artifact.rawOutputRef);
          if (!existing) {
            throw new Error(
              `local OpenTofu raw output ${artifact.rawOutputRef} disappeared during immutable commit`,
            );
          }
          assertSameRawOutputMutation(existing, artifact);
          return existing;
        }
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }
    },
  };
}

export function createLocalOpenTofuRunner(input: {
  readonly archiveStore: SourceArchiveStore;
  readonly stateStore: LocalOpenTofuStateArtifactStore;
}): OpenTofuRunner {
  return new LocalOpenTofuRunner(
    input.archiveStore,
    input.stateStore,
    inProcessRunnerTransport,
  );
}

export function createHttpOpenTofuRunner(input: {
  readonly archiveStore: SourceArchiveStore;
  readonly stateStore: LocalOpenTofuStateArtifactStore;
  readonly baseUrl: string;
}): OpenTofuRunner {
  return new LocalOpenTofuRunner(
    input.archiveStore,
    input.stateStore,
    httpRunnerTransport(input.baseUrl),
  );
}

export function createLocalOpenTofuRunnerProfile(
  now = Date.now(),
): RunnerProfile {
  return {
    id: LOCAL_OPENTOFU_RUNNER_PROFILE_ID,
    name: "Local OpenTofu",
    substrate: "local",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    description:
      "Local-substrate OpenTofu runner for provider-free smoke deployments.",
    tofuVersion: "operator-managed",
    stateBackend: {
      kind: "local",
      ref: "state://local-substrate/opentofu",
      lock: { kind: "operator", ref: "lock://local-substrate/opentofu" },
    },
    allowedProviders: [],
    resourceLimits: {
      maxRunSeconds: 300,
      maxSourceArchiveBytes: 64 * 1024 * 1024,
      maxSourceDecompressedBytes: 512 * 1024 * 1024,
      cpu: "1",
      memoryMb: 1024,
    },
    networkPolicy: { mode: "default-deny" },
    secretExposurePolicy: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
    labels: { environment: "local-substrate" },
    createdAt: now,
  };
}

class LocalOpenTofuRunner implements OpenTofuRunner {
  constructor(
    private readonly archiveStore: SourceArchiveStore,
    private readonly stateStore: LocalOpenTofuStateArtifactStore,
    private readonly transport: RunnerTransport,
  ) {}

  async plan(
    job: OpenTofuPlanJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuPlanResult> {
    await this.restoreSourceArchive(
      job.planRun.id,
      job.sourceArchive,
      control?.signal,
    );
    await this.restorePriorState(
      job.planRun.id,
      "plan",
      job,
      control?.signal,
    );
    const result = await runRunner(
      this.transport,
      "plan",
      job.planRun.id,
      job,
      control?.signal,
    );
    const planDigest = requiredString(result, "planDigest");
    return {
      planDigest,
      planArtifact: parsePlanArtifact(result, job.planRun.id, planDigest),
      ...(stringArray(result, "requiredProviders")
        ? { requiredProviders: stringArray(result, "requiredProviders") }
        : {}),
      ...(stringValue(result, "sourceCommit")
        ? { sourceCommit: stringValue(result, "sourceCommit") }
        : {}),
      ...(stringValue(result, "providerLockDigest")
        ? { providerLockDigest: stringValue(result, "providerLockDigest") }
        : {}),
      ...(providerInstallation(result)
        ? { providerInstallation: providerInstallation(result) }
        : {}),
      ...(recordValue(result, "summary")
        ? {
            summary: recordValue(
              result,
              "summary",
            ) as OpenTofuPlanResult["summary"],
          }
        : {}),
      ...(planResourceChanges(result)
        ? { planResourceChanges: planResourceChanges(result) }
        : {}),
      diagnostics: diagnostics(result),
    };
  }

  async apply(
    job: OpenTofuApplyJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuApplyResult> {
    const replay = await this.adoptCommittedStateMutation(
      job.applyRun.id,
      "apply",
      job.stateScope,
    );
    if (replay) {
      const replayResult = replay.result as OpenTofuApplyResult;
      if (replayResult.providerExecutionFailure) return replayResult;
      return await this.confirmRawOutput(job, replay);
    }
    await this.restoreSourceArchive(
      job.applyRun.id,
      job.sourceArchive,
      control?.signal,
    );
    await this.restorePriorState(
      job.applyRun.id,
      "apply",
      job,
      control?.signal,
    );
    await copyRunnerLocalPlanArtifact(
      this.transport,
      job.applyRun.id,
      job.planRun.id,
      job.planArtifact,
      control?.signal,
    );
    const result = await runRunner(
      this.transport,
      "apply",
      job.applyRun.id,
      job,
      control?.signal,
    );
    if (runnerProviderExecutionFailed(result)) {
      const stateBytes = await fetchRunnerArtifactIfPresent(
        this.transport,
        job.applyRun.id,
        `/runs/${encodeURIComponent(job.applyRun.id)}/artifacts/tfstate`,
        control?.signal,
      );
      const normalizedFailure = failedProviderExecutionResult(
        result,
        stateBytes ? "persisted" : "unavailable",
        stateBytes ? await digestBytes(stateBytes) : undefined,
        "apply",
      );
      if (!stateBytes) return normalizedFailure;
      const committed = await this.commitStateMutation(
        job.applyRun.id,
        "apply",
        job.stateScope,
        stateBytes,
        normalizedFailure,
      );
      return committed.result as OpenTofuApplyResult;
    }
    const stateBytes = await fetchRunnerArtifact(
      this.transport,
      job.applyRun.id,
      `/runs/${encodeURIComponent(job.applyRun.id)}/artifacts/tfstate`,
      control?.signal,
    );
    const stateDigest = await digestBytes(stateBytes);
    const normalizedResult: OpenTofuApplyResult = {
      ...(recordValue(result, "outputs")
        ? {
            outputs: recordValue(
              result,
              "outputs",
            ) as OpenTofuApplyResult["outputs"],
          }
        : {}),
      stateDigest,
      ...(providerInstallation(result)
        ? { providerInstallation: providerInstallation(result) }
        : {}),
      diagnostics: diagnostics(result),
    };
    const committed = await this.commitStateMutation(
      job.applyRun.id,
      "apply",
      job.stateScope,
      stateBytes,
      normalizedResult,
    );
    return await this.confirmRawOutput(job, committed);
  }

  async destroy(
    job: OpenTofuDestroyJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuDestroyResult> {
    const replay = await this.adoptCommittedStateMutation(
      job.applyRun.id,
      "destroy",
      job.stateScope,
    );
    if (replay) return replay.result as OpenTofuDestroyResult;
    await this.restoreSourceArchive(
      job.applyRun.id,
      job.sourceArchive,
      control?.signal,
    );
    await this.restorePriorState(
      job.applyRun.id,
      "destroy",
      job,
      control?.signal,
    );
    await copyRunnerLocalPlanArtifact(
      this.transport,
      job.applyRun.id,
      job.planRun.id,
      job.planArtifact,
      control?.signal,
    );
    const result = await runRunner(
      this.transport,
      "destroy",
      job.applyRun.id,
      job,
      control?.signal,
    );
    if (runnerProviderExecutionFailed(result)) {
      const stateBytes = await fetchRunnerArtifactIfPresent(
        this.transport,
        job.applyRun.id,
        `/runs/${encodeURIComponent(job.applyRun.id)}/artifacts/tfstate`,
        control?.signal,
      );
      const normalizedFailure = failedProviderExecutionResult(
        result,
        stateBytes ? "persisted" : "unavailable",
        stateBytes ? await digestBytes(stateBytes) : undefined,
        "destroy",
      );
      if (!stateBytes) return normalizedFailure as OpenTofuDestroyResult;
      const committed = await this.commitStateMutation(
        job.applyRun.id,
        "destroy",
        job.stateScope,
        stateBytes,
        normalizedFailure,
      );
      return committed.result as OpenTofuDestroyResult;
    }
    const stateBytes = await fetchRunnerArtifact(
      this.transport,
      job.applyRun.id,
      `/runs/${encodeURIComponent(job.applyRun.id)}/artifacts/tfstate`,
      control?.signal,
    );
    const stateDigest = await digestBytes(stateBytes);
    const normalizedResult: OpenTofuDestroyResult = {
      ...(providerInstallation(result)
        ? { providerInstallation: providerInstallation(result) }
        : {}),
      diagnostics: diagnostics(result),
      stateDigest,
    };
    const committed = await this.commitStateMutation(
      job.applyRun.id,
      "destroy",
      job.stateScope,
      stateBytes,
      normalizedResult,
    );
    return committed.result as OpenTofuDestroyResult;
  }

  async release(
    job: ReleaseCommandRunJob,
    control?: RunExecutionControl,
  ): Promise<ReleaseCommandRunResult> {
    await this.restoreSourceArchive(
      job.runId,
      {
        ref: job.sourceSnapshot.archiveRef,
        digest: job.sourceSnapshot.archiveDigest,
      },
      control?.signal,
    );
    const result = await runRunner(
      this.transport,
      "release",
      job.runId,
      {
        release: {
          commands: job.commands,
          ...(job.sourceBuild ? { sourceBuild: job.sourceBuild } : {}),
        },
        outputs: job.nonSensitiveOutputs,
        providerConfigurations: job.providerConfigurations,
        ...(job.credentials ? { credentials: job.credentials } : {}),
        activation: {
          applyRunId: job.applyRunId,
          ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
          capsuleId: job.capsuleId,
          stateVersionId: job.stateVersionId,
          sourceSnapshotId: job.sourceSnapshot.id,
          sourceCommit: job.sourceSnapshot.resolvedCommit,
        },
      },
      control?.signal,
    );
    return {
      status: "succeeded",
      runId: stringValue(result, "runId") ?? job.runId,
      commandCount: numberValue(result, "commandCount") ?? job.commands.length,
      ...(stringValue(result, "stdout")
        ? { stdout: stringValue(result, "stdout") }
        : {}),
    };
  }

  async sourceSync(
    job: OpenTofuSourceSyncJob,
  ): Promise<OpenTofuSourceSyncResult> {
    const result = await runRunner(this.transport, "source_sync", job.runId, {
      action: "source_sync",
      runId: job.runId,
      source: job.source,
      archiveRef: job.archiveRef,
      ...(job.reuseSnapshot ? { reuseSnapshot: job.reuseSnapshot } : {}),
      ...(job.credentials ? { credentials: job.credentials } : {}),
    });
    const archive = recordValue(result, "sourceArchive");
    const archiveDigest =
      stringValue(result, "archiveDigest") ??
      (archive ? stringValue(archive, "digest") : undefined);
    const archiveSizeBytes =
      numberValue(result, "archiveSizeBytes") ??
      (archive ? numberValue(archive, "sizeBytes") : undefined);
    const archiveRef =
      stringValue(result, "archiveRef") ??
      (archive ? stringValue(archive, "ref") : undefined);
    const repositoryInstallMetadata =
      repositoryInstallMetadataFromRunnerResult(result);
    const repositoryManifest = parseRepositoryManifestSnapshot(
      result.repositoryManifest,
    );
    const resolvedCommit = requiredString(result, "resolvedCommit");
    if (!archiveDigest || archiveSizeBytes === undefined) {
      throw new Error(`source_sync ${job.runId} returned no archive metadata`);
    }
    if (archive && stringValue(archive, "kind") === "object-storage") {
      assertMatchingReusedSourceArchive(
        result,
        archive,
        job.reuseSnapshot,
        resolvedCommit,
      );
    } else {
      const bytes = await fetchRunnerArtifact(
        this.transport,
        job.runId,
        `/runs/${encodeURIComponent(job.runId)}/artifacts/source-archive`,
      );
      await assertDigest(bytes, archiveDigest, "source_sync archive");
      await this.archiveStore.write(job.archiveRef, bytes);
    }
    const phaseTimings = phaseTimingsFromRunnerResult(result);
    return {
      resolvedCommit,
      archiveDigest,
      archiveSizeBytes,
      ...(repositoryInstallMetadata ? { repositoryInstallMetadata } : {}),
      ...(repositoryManifest ? { repositoryManifest } : {}),
      ...(archiveRef ? { archiveRef } : {}),
      ...(phaseTimings ? { phaseTimings } : {}),
    };
  }

  async readCapsuleSourceFiles(
    job: OpenTofuCapsuleSourceFilesJob,
  ): Promise<readonly OpenTofuCapsuleSourceFile[]> {
    await this.restoreSourceArchive(job.runId, {
      ref: job.sourceSnapshot.archiveRef,
      digest: job.sourceSnapshot.archiveDigest,
    });
    const result = await runRunner(
      this.transport,
      "compatibility_check",
      job.runId,
      {
        source: {
          ...(job.modulePath ? { modulePath: job.modulePath } : {}),
        },
      },
    );
    const files = result.files;
    if (!Array.isArray(files)) {
      throw new Error(`compatibility_check ${job.runId} returned no files`);
    }
    return files.map((entry) => {
      if (!isRecord(entry)) {
        throw new Error("compatibility_check file entry must be an object");
      }
      const path = requiredString(entry, "path");
      const text = requiredString(entry, "text");
      return { path, text };
    });
  }

  async resolveStableSourceTag(
    job: OpenTofuStableSourceTagResolutionJob,
  ): Promise<OpenTofuStableSourceTagResolutionResult> {
    const result = await runRunner(
      this.transport,
      "stable_semver_tag",
      job.runId,
      { action: "stable_semver_tag", url: job.url },
    );
    return {
      tag: requiredString(result, "tag"),
      commit: requiredString(result, "commit"),
    };
  }

  async readSourceSnapshotPresentationFile(
    job: OpenTofuSourceSnapshotPresentationFileJob,
  ): Promise<OpenTofuSourceSnapshotPresentationFile> {
    await this.restoreSourceArchive(job.runId, {
      ref: job.sourceSnapshot.archiveRef,
      digest: job.sourceSnapshot.archiveDigest,
    });
    const result = await runRunner(
      this.transport,
      "source_snapshot_file",
      job.runId,
      { action: "source_snapshot_file", path: job.path },
    );
    const sizeBytes = result.sizeBytes;
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes)) {
      throw new Error("source_snapshot_file returned an invalid sizeBytes");
    }
    return {
      path: requiredString(result, "path"),
      text: requiredString(result, "text"),
      digest: requiredString(result, "digest"),
      sizeBytes,
    };
  }

  private async restoreSourceArchive(
    runId: string,
    sourceArchive: OpenTofuPlanJob["sourceArchive"],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!sourceArchive) return;
    const bytes = await this.archiveStore.read(sourceArchive.ref);
    await assertDigest(bytes, sourceArchive.digest, "source archive");
    const response = await this.transport.fetch(
      `/runs/${encodeURIComponent(runId)}/source-archive/restore`,
      {
        method: "PUT",
        headers: { "content-type": "application/zstd" },
        body: arrayBufferFromBytes(bytes),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(
        `OpenTofu runner failed to restore source archive for ${runId}: ${await response.text()}`,
      );
    }
  }

  private async restorePriorState(
    runId: string,
    action: "plan" | "apply" | "destroy",
    job: {
      readonly stateScope?: OpenTofuPlanJob["stateScope"];
      readonly priorState?: DispatchPriorState;
      readonly stateAdoption?: DispatchStateAdoption;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const prior = canonicalLocalPriorState(job);
    const expectedGeneration =
      action === "plan"
        ? (job.stateScope?.generation ?? 0)
        : Math.max(0, (job.stateScope?.generation ?? 0) - 1);
    if (!prior) {
      if (expectedGeneration > 0) {
        throw new Error(
          `local OpenTofu run ${runId} has generation ${expectedGeneration} without an exact prior state descriptor`,
        );
      }
      return;
    }
    if (prior.generation !== expectedGeneration) {
      throw new Error(
        `local OpenTofu exact prior state generation mismatch: expected ${expectedGeneration}`,
      );
    }
    const artifact = await this.stateStore.read(prior.stateRef);
    if (!artifact) {
      throw new Error(
        `local OpenTofu exact prior state ${prior.stateRef} was not found`,
      );
    }
    if (
      artifact.generation !== prior.generation ||
      (prior.digest !== undefined &&
        artifact.stateDigest !== prior.digest) ||
      (prior.createdByRunId !== undefined &&
        artifact.createdByRunId !== prior.createdByRunId)
    ) {
      throw new Error(
        `local OpenTofu exact prior state ${prior.stateRef} does not match its ledger descriptor`,
      );
    }
    if (job.stateScope) {
      assertLocalMutationScope(
        artifact,
        {
          ...job.stateScope,
          generation: prior.generation,
          stateRef: prior.stateRef,
        },
        artifact.createdByRunId,
        artifact.action,
      );
    }
    const response = await this.transport.fetch(
      `/runs/${encodeURIComponent(runId)}/artifacts/tfstate`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: arrayBufferFromBytes(artifact.stateBytes),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(
        `OpenTofu runner failed to restore exact state for ${runId}: ${await response.text()}`,
      );
    }
  }

  private async adoptCommittedStateMutation(
    runId: string,
    action: "apply" | "destroy",
    scope: OpenTofuApplyJob["stateScope"],
  ): Promise<LocalOpenTofuStateArtifact | undefined> {
    if (!scope) {
      throw new Error(
        `local OpenTofu ${action} ${runId} requires a durable stateScope`,
      );
    }
    const existing = await this.stateStore.read(scope.stateRef);
    if (!existing) return undefined;
    if (
      existing.createdByRunId !== runId ||
      existing.generation !== scope.generation ||
      existing.action !== action
    ) {
      throw new Error(
        `local OpenTofu state target ${scope.stateRef} is already owned by ApplyRun ${existing.createdByRunId}`,
      );
    }
    assertLocalMutationScope(existing, scope, runId, action);
    return existing;
  }

  private async commitStateMutation(
    runId: string,
    action: "apply" | "destroy",
    scope: OpenTofuApplyJob["stateScope"],
    stateBytes: Uint8Array,
    result: OpenTofuApplyResult | OpenTofuDestroyResult,
  ): Promise<LocalOpenTofuStateArtifact> {
    if (!scope) {
      throw new Error(
        `local OpenTofu ${action} ${runId} requires a durable stateScope`,
      );
    }
    const stateDigest = await digestBytes(stateBytes);
    return await this.stateStore.commit({
      stateRef: scope.stateRef,
      workspaceId: scope.workspaceId,
      subject: requiredStateSubject(scope, runId),
      environment: scope.environment,
      generation: scope.generation,
      createdByRunId: runId,
      action,
      stateDigest,
      stateBytes,
      result,
    });
  }

  private async confirmRawOutput(
    job: OpenTofuApplyJob,
    state: LocalOpenTofuStateArtifact,
  ): Promise<OpenTofuApplyResult> {
    const scope = job.stateScope;
    const rawOutputRef = job.rawOutputRef?.trim();
    if (!scope || !rawOutputRef) {
      throw new Error(
        `local OpenTofu apply ${job.applyRun.id} requires a durable rawOutputRef`,
      );
    }
    assertLocalMutationScope(state, scope, job.applyRun.id, "apply");
    const result = state.result as OpenTofuApplyResult;
    const outputs = result.outputs ?? {};
    const outputDigest = await digestBytes(
      new TextEncoder().encode(JSON.stringify(outputs)),
    );
    let confirmed: LocalOpenTofuRawOutputArtifact;
    try {
      confirmed = await this.stateStore.commitRawOutput({
        rawOutputRef,
        workspaceId: scope.workspaceId,
        subject: requiredStateSubject(scope, job.applyRun.id),
        environment: scope.environment,
        generation: scope.generation,
        stateRef: state.stateRef,
        stateDigest: state.stateDigest,
        createdByRunId: job.applyRun.id,
        action: "apply",
        outputDigest,
        outputs,
      });
    } catch (error) {
      // State and the replay result are already durable. Mark only this tail as
      // retryable so the consumer redelivers the SAME ApplyRun; replay adopts
      // state and repairs/adopts the exact raw-output coordinate without
      // repeating provider work.
      throw new OpenTofuRunnerInfrastructureError(
        `local OpenTofu apply ${job.applyRun.id} could not confirm durable raw output`,
        {
          reason: "runner_artifact_relay_ambiguous",
          originalError: error,
        },
      );
    }
    return {
      ...result,
      rawOutputRef: confirmed.rawOutputRef,
    };
  }
}

const inProcessRunnerTransport: RunnerTransport = {
  fetch: async (path, init) =>
    await handleRunnerRequest(
      new Request(`https://local-opentofu-runner${path}`, init),
    ),
};

function httpRunnerTransport(baseUrl: string): RunnerTransport {
  const endpoint = normalizeRunnerBaseUrl(baseUrl);
  return {
    fetch: async (path, init) => await fetch(new URL(path, endpoint), init),
  };
}

function normalizeRunnerBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("OpenTofu runner base URL must not be empty");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `unsupported OpenTofu runner URL protocol: ${url.protocol}`,
    );
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

async function copyRunnerLocalPlanArtifact(
  transport: RunnerTransport,
  applyRunId: string,
  planRunId: string,
  artifact: OpenTofuPlanArtifact,
  signal?: AbortSignal,
): Promise<void> {
  const sourceRunId = runnerLocalPlanRunId(artifact) ?? planRunId;
  const bytes = await fetchRunnerArtifact(
    transport,
    sourceRunId,
    `/runs/${encodeURIComponent(sourceRunId)}/artifacts/tfplan`,
    signal,
  );
  await assertDigest(bytes, artifact.digest, "plan artifact");
  const response = await transport.fetch(
    `/runs/${encodeURIComponent(applyRunId)}/artifacts/tfplan`,
    {
      method: "PUT",
      headers: { "content-type": "application/vnd.opentofu.plan" },
      body: arrayBufferFromBytes(bytes),
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(
      `OpenTofu runner failed to restore plan artifact for ${applyRunId}: ${await response.text()}`,
    );
  }
}

function runnerLocalPlanRunId(
  artifact: OpenTofuPlanArtifact,
): string | undefined {
  return /^runner-local:\/\/([^/]+)\/tfplan$/.exec(artifact.ref)?.[1];
}

async function runRunner(
  transport: RunnerTransport,
  action:
    | "plan"
    | "apply"
    | "destroy"
    | "compatibility_check"
    | "source_sync"
    | "stable_semver_tag"
    | "source_snapshot_file"
    | "release",
  runId: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await transport.fetch(`/runs/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action,
      runId,
      requestedAt: new Date().toISOString(),
      request,
    }),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  const body = text.trim().length > 0 ? parseObject(text) : {};
  if (
    !response.ok &&
    !((action === "apply" || action === "destroy") &&
      runnerProviderExecutionFailed(body))
  ) {
    const reason = stringValue(body, "errorCode");
    const detail =
      stringValue(body, "detail") ??
      stringValue(body, "error") ??
      stringValue(body, "stderr") ??
      text.slice(0, 500);
    throw new OpenTofuRunnerExecutionError(
      `OpenTofu runner rejected ${action} run ${runId}: ${response.status}${detail ? ` (${detail})` : ""}`,
      { ...(reason ? { reason } : {}) },
    );
  }
  return body;
}

function runnerProviderExecutionFailed(
  result: Record<string, unknown>,
): boolean {
  const failure = recordValue(result, "providerExecutionFailure");
  return (
    failure !== undefined &&
    stringValue(failure, "kind") === "provider_execution_failed"
  );
}

function failedProviderExecutionResult(
  result: Record<string, unknown>,
  statePersistence: "persisted" | "unavailable",
  stateDigest: string | undefined,
  action: "apply" | "destroy",
): OpenTofuApplyResult | OpenTofuDestroyResult {
  const errorCode = stringValue(result, "errorCode");
  const failure = {
    providerExecutionFailure: {
      kind: "provider_execution_failed",
      statePersistence,
      ...(errorCode && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(errorCode)
        ? { errorCode }
        : {}),
    },
    ...(stateDigest ? { stateDigest } : {}),
    ...(providerInstallation(result)
      ? { providerInstallation: providerInstallation(result) }
      : {}),
    diagnostics: diagnostics(result),
  } as const;
  return action === "apply"
    ? failure
    : {
        ...failure,
      };
}

async function fetchRunnerArtifact(
  transport: RunnerTransport,
  runId: string,
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await transport.fetch(path, {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `OpenTofu runner artifact fetch failed for ${runId}: ${response.status} ${await response.text()}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchRunnerArtifactIfPresent(
  transport: RunnerTransport,
  runId: string,
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const response = await transport.fetch(path, {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `OpenTofu runner artifact fetch failed for ${runId}: ${response.status} ${await response.text()}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function parsePlanArtifact(
  result: Record<string, unknown>,
  runId: string,
  planDigest: string,
): OpenTofuPlanArtifact {
  const artifact = recordValue(result, "planArtifact");
  if (!artifact) {
    throw new Error(`OpenTofu runner plan ${runId} returned no planArtifact`);
  }
  const kind = requiredString(artifact, "kind");
  const ref = requiredString(artifact, "ref");
  const digest = requiredString(artifact, "digest");
  if (digest !== planDigest) {
    throw new Error(
      `OpenTofu runner plan ${runId} returned a planArtifact digest that does not match planDigest`,
    );
  }
  return {
    kind,
    ref,
    digest,
    ...(stringValue(artifact, "contentType")
      ? { contentType: stringValue(artifact, "contentType") }
      : {}),
    ...(numberValue(artifact, "sizeBytes") !== undefined
      ? { sizeBytes: numberValue(artifact, "sizeBytes") }
      : {}),
    ...(numberValue(artifact, "createdAt") !== undefined
      ? { createdAt: numberValue(artifact, "createdAt") }
      : {}),
  };
}

function providerInstallation(
  result: Record<string, unknown>,
): OpenTofuPlanResult["providerInstallation"] | undefined {
  const value = result.providerInstallation;
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((entry): ProviderInstallationEvidence[] => {
    if (!isRecord(entry)) return [];
    const provider = stringValue(entry, "provider");
    const method = stringValue(entry, "installationMethod");
    if (
      !provider ||
      (method !== "filesystem_mirror" &&
        method !== "direct" &&
        method !== "unknown")
    ) {
      return [];
    }
    return [
      {
        provider,
        mirrored: entry.mirrored === true,
        installationMethod: method,
        ...(stringValue(entry, "mirrorPath")
          ? { mirrorPath: stringValue(entry, "mirrorPath") }
          : {}),
        ...(entry.attested === true ? { attested: true } : {}),
        ...(stringValue(entry, "attestationMethod") ===
        "forced_filesystem_mirror_init"
          ? { attestationMethod: "forced_filesystem_mirror_init" as const }
          : {}),
        ...(stringValue(entry, "cliConfigDigest")
          ? { cliConfigDigest: stringValue(entry, "cliConfigDigest") }
          : {}),
        ...(stringValue(entry, "installedPath")
          ? { installedPath: stringValue(entry, "installedPath") }
          : {}),
        ...(stringValue(entry, "installedDigest")
          ? { installedDigest: stringValue(entry, "installedDigest") }
          : {}),
      },
    ];
  });
  return rows.length > 0 ? rows : undefined;
}

function planResourceChanges(
  result: Record<string, unknown>,
): readonly PlanResourceChange[] | undefined {
  const value = result.planResourceChanges;
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((entry): PlanResourceChange[] => {
    if (!isRecord(entry)) return [];
    const address = stringValue(entry, "address");
    const type = stringValue(entry, "type");
    const actions = stringArray(entry, "actions");
    if (!address || !type || !actions) return [];
    const scope = recordValue(entry, "scope");
    const projectedScope = normalizePlanResourceScope(scope);
    return [
      {
        address,
        type,
        actions,
        ...(projectedScope ? { scope: projectedScope } : {}),
      },
    ];
  });
  return rows.length > 0 ? rows : undefined;
}

function diagnostics(
  result: Record<string, unknown>,
): readonly RunDiagnostic[] {
  const stderr = stringValue(result, "stderr");
  return stderr && stderr.trim().length > 0
    ? [{ severity: "warning", message: stderr }]
    : [];
}

function repositoryInstallMetadataFromRunnerResult(
  result: Record<string, unknown>,
): OpenTofuSourceSyncResult["repositoryInstallMetadata"] | undefined {
  const value = recordValue(result, "repositoryInstallMetadata");
  if (!value) return undefined;
  const status = stringValue(value, "status");
  if (status === "absent") return { status };
  if (status === "present") {
    const text = stringValue(value, "text");
    return text === undefined ? undefined : { status, text };
  }
  if (status === "invalid") {
    const reason = stringValue(value, "reason");
    if (reason === "not_regular_file" || reason === "too_large") {
      return { status, reason };
    }
  }
  return undefined;
}

function assertMatchingReusedSourceArchive(
  result: Record<string, unknown>,
  archive: Record<string, unknown>,
  reuseSnapshot: OpenTofuSourceSyncJob["reuseSnapshot"],
  resolvedCommit: string,
): void {
  if (
    !reuseSnapshot ||
    resolvedCommit !== reuseSnapshot.resolvedCommit ||
    stringValue(archive, "reusedFromSnapshotId") !== reuseSnapshot.id ||
    stringValue(archive, "ref") !== reuseSnapshot.archiveRef ||
    stringValue(archive, "digest") !== reuseSnapshot.archiveDigest ||
    numberValue(archive, "sizeBytes") !== reuseSnapshot.archiveSizeBytes ||
    stringValue(result, "archiveDigest") !== reuseSnapshot.archiveDigest ||
    numberValue(result, "archiveSizeBytes") !== reuseSnapshot.archiveSizeBytes
  ) {
    throw new Error("source archive reuse does not match reuseSnapshot");
  }
}

function phaseTimingsFromRunnerResult(
  result: Record<string, unknown>,
): NonNullable<OpenTofuSourceSyncResult["phaseTimings"]> | undefined {
  const value = result.phaseTimings;
  if (!Array.isArray(value)) return undefined;
  const timings = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const phase = stringValue(entry, "phase");
    const startedAt = stringValue(entry, "startedAt");
    const finishedAt = stringValue(entry, "finishedAt");
    const durationMs = numberValue(entry, "durationMs");
    if (!phase || !/^[a-z][a-z0-9_]{0,63}$/u.test(phase)) return [];
    if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return [];
    if (!finishedAt || !Number.isFinite(Date.parse(finishedAt))) return [];
    if (durationMs === undefined || durationMs < 0) return [];
    return [{ phase, startedAt, finishedAt, durationMs }];
  });
  return timings.length > 0 ? timings : undefined;
}

async function assertDigest(
  bytes: Uint8Array,
  expected: string,
  label: string,
): Promise<void> {
  const digest = await digestBytes(bytes);
  if (digest !== expected) {
    throw new Error(
      `${label} digest mismatch: expected ${expected}, got ${digest}`,
    );
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    arrayBufferFromBytes(bytes),
  );
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function archivePath(root: string, key: string): string {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.split("/").some((segment) => segment === "..") ||
    key.startsWith("workspaces/") === false
  ) {
    throw new Error(`unsafe source archive key: ${key}`);
  }
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`source archive key escapes root: ${key}`);
  }
  return path;
}

async function stateArtifactPath(
  root: string,
  stateRef: string,
): Promise<string> {
  if (!stateRef.trim() || stateRef.includes("\0")) {
    throw new Error("local OpenTofu stateRef must not be empty");
  }
  const key = (await digestBytes(new TextEncoder().encode(stateRef))).slice(
    "sha256:".length,
  );
  return resolve(root, key.slice(0, 2), `${key}.json`);
}

async function rawOutputArtifactPath(
  root: string,
  rawOutputRef: string,
): Promise<string> {
  if (!rawOutputRef.trim() || rawOutputRef.includes("\0")) {
    throw new Error("local OpenTofu rawOutputRef must not be empty");
  }
  const key = (await digestBytes(new TextEncoder().encode(rawOutputRef))).slice(
    "sha256:".length,
  );
  return resolve(root, "raw-output", key.slice(0, 2), `${key}.json`);
}

async function parseStateArtifactEnvelope(
  text: string,
  expectedStateRef: string,
  cryptoBoundary: SecretBoundaryCrypto,
): Promise<LocalOpenTofuStateArtifact> {
  const envelope = parseObject(text);
  if (
    envelope.version !== 2 ||
    stringValue(envelope, "stateRef") !== expectedStateRef ||
    !stringValue(envelope, "workspaceId") ||
    !parseStateSubject(envelope.subject) ||
    !stringValue(envelope, "environment") ||
    !Number.isSafeInteger(envelope.generation) ||
    (envelope.generation as number) < 0 ||
    !stringValue(envelope, "createdByRunId") ||
    (envelope.action !== "apply" && envelope.action !== "destroy") ||
    !stringValue(envelope, "stateDigest") ||
    !stringValue(envelope, "ciphertextBase64")
  ) {
    throw new Error(
      `local OpenTofu state artifact ${expectedStateRef} is malformed`,
    );
  }
  const metadata = {
    version: 2,
    stateRef: expectedStateRef,
    workspaceId: requiredString(envelope, "workspaceId"),
    subject: parseStateSubject(envelope.subject)!,
    environment: requiredString(envelope, "environment"),
    generation: envelope.generation as number,
    createdByRunId: requiredString(envelope, "createdByRunId"),
    action: envelope.action,
    stateDigest: requiredString(envelope, "stateDigest"),
  } as const;
  const ciphertext = decodeCanonicalBase64(
    requiredString(envelope, "ciphertextBase64"),
    `local OpenTofu state artifact ${expectedStateRef} ciphertext`,
  );
  const protectedPayload = parseObject(
    await cryptoBoundary.open(
      ciphertext,
      "global",
      localStateArtifactAad(metadata),
    ),
  );
  const stateBytes = decodeCanonicalBase64(
    requiredString(protectedPayload, "stateBase64"),
    `local OpenTofu state artifact ${expectedStateRef} state`,
  );
  const result = recordValue(protectedPayload, "result");
  if (!result) {
    throw new Error(
      `local OpenTofu state artifact ${expectedStateRef} has no protected result`,
    );
  }
  const artifact: LocalOpenTofuStateArtifact = {
    stateRef: expectedStateRef,
    workspaceId: metadata.workspaceId,
    subject: metadata.subject,
    environment: metadata.environment,
    generation: metadata.generation,
    createdByRunId: metadata.createdByRunId,
    action: metadata.action,
    stateDigest: metadata.stateDigest,
    stateBytes,
    result: result as unknown as
      | OpenTofuApplyResult
      | OpenTofuDestroyResult,
  };
  await assertLocalStateArtifact(artifact);
  return artifact;
}

function localStateArtifactAad(metadata: {
  readonly version: 2;
  readonly stateRef: string;
  readonly workspaceId: string;
  readonly subject: NonNullable<DispatchStateScope["subject"]>;
  readonly environment: string;
  readonly generation: number;
  readonly createdByRunId: string;
  readonly action: "apply" | "destroy";
  readonly stateDigest: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata));
}

async function parseRawOutputArtifactEnvelope(
  text: string,
  expectedRawOutputRef: string,
  cryptoBoundary: SecretBoundaryCrypto,
): Promise<LocalOpenTofuRawOutputArtifact> {
  const envelope = parseObject(text);
  const subject = parseStateSubject(envelope.subject);
  if (
    envelope.version !== 1 ||
    envelope.kind !== "raw_output" ||
    stringValue(envelope, "rawOutputRef") !== expectedRawOutputRef ||
    !stringValue(envelope, "workspaceId") ||
    !subject ||
    !stringValue(envelope, "environment") ||
    !Number.isSafeInteger(envelope.generation) ||
    (envelope.generation as number) < 0 ||
    !stringValue(envelope, "stateRef") ||
    !stringValue(envelope, "stateDigest") ||
    !stringValue(envelope, "createdByRunId") ||
    envelope.action !== "apply" ||
    !stringValue(envelope, "outputDigest") ||
    !stringValue(envelope, "ciphertextBase64")
  ) {
    throw new Error(
      `local OpenTofu raw output artifact ${expectedRawOutputRef} is malformed`,
    );
  }
  const metadata = {
    version: 1,
    kind: "raw_output" as const,
    rawOutputRef: expectedRawOutputRef,
    workspaceId: requiredString(envelope, "workspaceId"),
    subject,
    environment: requiredString(envelope, "environment"),
    generation: envelope.generation as number,
    stateRef: requiredString(envelope, "stateRef"),
    stateDigest: requiredString(envelope, "stateDigest"),
    createdByRunId: requiredString(envelope, "createdByRunId"),
    action: "apply" as const,
    outputDigest: requiredString(envelope, "outputDigest"),
  } as const;
  const protectedPayload = parseObject(
    await cryptoBoundary.open(
      decodeCanonicalBase64(
        requiredString(envelope, "ciphertextBase64"),
        `local OpenTofu raw output artifact ${expectedRawOutputRef} ciphertext`,
      ),
      "global",
      localRawOutputArtifactAad(metadata),
    ),
  );
  const outputs = recordValue(protectedPayload, "outputs");
  if (!outputs) {
    throw new Error(
      `local OpenTofu raw output artifact ${expectedRawOutputRef} has no protected outputs`,
    );
  }
  const artifact: LocalOpenTofuRawOutputArtifact = {
    ...metadata,
    outputs: outputs as OpenTofuOutputEnvelope,
  };
  await assertLocalRawOutputArtifact(artifact);
  return artifact;
}

function localRawOutputArtifactAad(metadata: {
  readonly version: 1;
  readonly kind: "raw_output";
  readonly rawOutputRef: string;
  readonly workspaceId: string;
  readonly subject: NonNullable<DispatchStateScope["subject"]>;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly stateDigest: string;
  readonly createdByRunId: string;
  readonly action: "apply";
  readonly outputDigest: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata));
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) {
    throw new Error(`${label} has invalid base64`);
  }
  return bytes;
}

async function assertLocalStateArtifact(
  artifact: LocalOpenTofuStateArtifact,
): Promise<void> {
  if (
    !artifact.stateRef.trim() ||
    !artifact.workspaceId.trim() ||
    !artifact.environment.trim() ||
    !parseStateSubject(artifact.subject) ||
    !Number.isSafeInteger(artifact.generation) ||
    artifact.generation < 0 ||
    !artifact.createdByRunId.trim() ||
    !artifact.stateDigest.trim()
  ) {
    throw new Error("local OpenTofu state artifact metadata is invalid");
  }
  if (artifact.result.stateDigest !== artifact.stateDigest) {
    throw new Error(
      `local OpenTofu state artifact ${artifact.stateRef} result digest does not match its state`,
    );
  }
  await assertDigest(
    artifact.stateBytes,
    artifact.stateDigest,
    `local OpenTofu state ${artifact.stateRef}`,
  );
}

async function assertLocalRawOutputArtifact(
  artifact: LocalOpenTofuRawOutputArtifact,
): Promise<void> {
  if (
    !artifact.rawOutputRef.trim() ||
    !artifact.workspaceId.trim() ||
    !artifact.environment.trim() ||
    !parseStateSubject(artifact.subject) ||
    !Number.isSafeInteger(artifact.generation) ||
    artifact.generation < 0 ||
    !artifact.stateRef.trim() ||
    !artifact.stateDigest.trim() ||
    !artifact.createdByRunId.trim() ||
    !artifact.outputDigest.trim()
  ) {
    throw new Error("local OpenTofu raw output artifact metadata is invalid");
  }
  const digest = await digestBytes(
    new TextEncoder().encode(JSON.stringify(artifact.outputs)),
  );
  if (digest !== artifact.outputDigest) {
    throw new Error(
      `local OpenTofu raw output artifact ${artifact.rawOutputRef} digest mismatch`,
    );
  }
}

function assertSameStateMutation(
  existing: LocalOpenTofuStateArtifact,
  candidate: LocalOpenTofuStateArtifact,
): void {
  if (
    existing.createdByRunId !== candidate.createdByRunId ||
    existing.workspaceId !== candidate.workspaceId ||
    !sameStateSubject(existing.subject, candidate.subject) ||
    existing.environment !== candidate.environment ||
    existing.generation !== candidate.generation ||
    existing.action !== candidate.action ||
    existing.stateDigest !== candidate.stateDigest
  ) {
    throw new Error(
      `local OpenTofu state target ${candidate.stateRef} is already committed by a different mutation`,
    );
  }
}

function assertSameRawOutputMutation(
  existing: LocalOpenTofuRawOutputArtifact,
  candidate: LocalOpenTofuRawOutputArtifact,
): void {
  if (
    existing.createdByRunId !== candidate.createdByRunId ||
    existing.workspaceId !== candidate.workspaceId ||
    !sameStateSubject(existing.subject, candidate.subject) ||
    existing.environment !== candidate.environment ||
    existing.generation !== candidate.generation ||
    existing.stateRef !== candidate.stateRef ||
    existing.stateDigest !== candidate.stateDigest ||
    existing.action !== candidate.action ||
    existing.outputDigest !== candidate.outputDigest
  ) {
    throw new Error(
      `local OpenTofu raw output target ${candidate.rawOutputRef} is already committed by a different mutation`,
    );
  }
}

function requiredStateSubject(
  scope: DispatchStateScope,
  runId: string,
): NonNullable<DispatchStateScope["subject"]> {
  const subject = parseStateSubject(scope.subject);
  if (!subject) {
    throw new Error(
      `local OpenTofu run ${runId} requires an exact state subject`,
    );
  }
  return subject;
}

function parseStateSubject(
  value: unknown,
): NonNullable<DispatchStateScope["subject"]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const subject = value as { readonly kind?: unknown; readonly id?: unknown };
  if (
    (subject.kind !== "capsule" && subject.kind !== "resource") ||
    typeof subject.id !== "string" ||
    subject.id.trim().length === 0
  ) {
    return undefined;
  }
  return { kind: subject.kind, id: subject.id };
}

function sameStateSubject(
  left: NonNullable<DispatchStateScope["subject"]>,
  right: NonNullable<DispatchStateScope["subject"]>,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function assertLocalMutationScope(
  artifact: LocalOpenTofuStateArtifact,
  scope: DispatchStateScope,
  runId: string,
  action: "apply" | "destroy",
): void {
  const subject = requiredStateSubject(scope, runId);
  if (
    artifact.stateRef !== scope.stateRef ||
    artifact.workspaceId !== scope.workspaceId ||
    !sameStateSubject(artifact.subject, subject) ||
    artifact.environment !== scope.environment ||
    artifact.generation !== scope.generation ||
    artifact.createdByRunId !== runId ||
    artifact.action !== action
  ) {
    throw new Error(
      `local OpenTofu state ${scope.stateRef} does not match its exact workspace, subject, environment, action, generation, and ApplyRun authority`,
    );
  }
}

function canonicalLocalPriorState(job: {
  readonly stateScope?: OpenTofuPlanJob["stateScope"];
  readonly priorState?: DispatchPriorState;
  readonly stateAdoption?: DispatchStateAdoption;
}):
  | {
      readonly stateRef: string;
      readonly generation: number;
      readonly digest?: string;
      readonly legacyDigestMissing?: true;
      readonly createdByRunId?: string;
    }
  | undefined {
  const scoped = job.stateScope?.priorState;
  const direct = job.priorState;
  if (scoped && direct && !samePriorStateDescriptor(scoped, direct)) {
    throw new Error("local OpenTofu prior state descriptors disagree");
  }
  const prior = scoped ?? direct;
  if (prior) {
    if (job.stateAdoption) {
      throw new Error(
        "local OpenTofu state adoption cannot replace canonical prior state",
      );
    }
    if (Boolean(prior.digest?.trim()) === (prior.legacyDigestMissing === true)) {
      throw new Error(
        "local OpenTofu prior state requires exactly one of digest or legacyDigestMissing",
      );
    }
    return prior;
  }
  const adoption = job.stateAdoption;
  return adoption
    ? {
        stateRef: adoption.stateRef,
        generation: adoption.stateGeneration,
        digest: adoption.stateDigest,
      }
    : undefined;
}

function samePriorStateDescriptor(
  left: DispatchPriorState,
  right: DispatchPriorState,
): boolean {
  return (
    left.generation === right.generation &&
    left.stateRef === right.stateRef &&
    left.digest === right.digest &&
    left.legacyDigestMissing === right.legacyDigestMissing &&
    left.createdByRunId === right.createdByRunId
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("runner response must be an object");
  return value;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const out = stringValue(value, key);
  if (!out) throw new Error(`${key} is required`);
  return out;
}

function stringValue(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberValue(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function recordValue(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) return undefined;
  const strings = field.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
