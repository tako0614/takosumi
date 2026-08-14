import type {
  ServiceDataArtifactPointer,
  ServiceDataBackupRunner,
  ServiceDataBackupRunnerInput,
  ServiceDataBackupRunnerResult,
} from "../../core/domains/backups/mod.ts";
import type {
  OpenTofuApplyJob,
  OpenTofuApplyResult,
  OpenTofuCapsuleSourceFile,
  OpenTofuCapsuleSourceFilesJob,
  OpenTofuDestroyJob,
  OpenTofuDestroyResult,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRestoreJob,
  OpenTofuRestoreResult,
  OpenTofuRunner,
  RunExecutionControl,
  OpenTofuSourceSyncJob,
  OpenTofuSourceSyncResult,
  OpenTofuStableSourceTagResolutionJob,
  OpenTofuStableSourceTagResolutionResult,
  OpenTofuSourceSnapshotPresentationFileJob,
  OpenTofuSourceSnapshotPresentationFile,
  ReleaseCommandRunJob,
  ReleaseCommandRunResult,
} from "../../core/domains/deploy-control/mod.ts";
import {
  OpenTofuRunnerExecutionError,
  OpenTofuRunnerInfrastructureError,
} from "../../core/domains/deploy-control/mod.ts";
import type {
  CloudflareWorkerEnv,
  OpenTofuRunAction,
} from "./bindings.ts";
import { redactString } from "takosumi-contract/redaction";
import { normalizePlanResourceScope } from "takosumi-contract";
import { parseRepositoryManifestSnapshot } from "takosumi-contract/sources";
import { recordWorkerMetric, type WorkerMetricSink } from "./metrics.ts";
import { RUNNER_MUTATION_INDETERMINATE_CODE } from "./runner_protocol.ts";

/**
 * Implements {@link OpenTofuRunner} over the RUNNER Durable Object: each
 * plan/apply/destroy/source_sync run POSTs its job to the OpenTofu Container
 * runner DO and parses the DO's JSON result back into the controller's result
 * shape. Credential values and run bodies are never logged.
 */
const DEFAULT_COMPATIBILITY_CHECK_TIMEOUT_MS = 45_000;
const DEFAULT_RUNNER_CAPACITY_RETRY_ATTEMPTS = 5;
const DEFAULT_RUNNER_CAPACITY_RETRY_BASE_MS = 2_000;
const MAX_RUNNER_CAPACITY_RETRY_ATTEMPTS = 10;
const MAX_RUNNER_CAPACITY_RETRY_DELAY_MS = 10_000;
const RUNNER_CAPACITY_EXCEEDED_PATTERN =
  /maximum number of running container instances exceeded/i;
const RUNNER_SUBSTRATE_RESET_PATTERN =
  /durable object reset because its code was updated/i;
const RUNNER_ARTIFACT_RELAY_AMBIGUOUS_CODE =
  "runner_artifact_relay_ambiguous";
const RUNNER_REJECTED_CODE = "runner_rejected";
const RUNNER_PLAN_EXECUTION_FAILURE_CODES = new Set([
  "provider_source_invalid",
  "provider_package_unavailable",
  "provider_platform_binary_unavailable",
  "provider_protocol_mismatch",
  "provider_policy_denied",
  "runner_capability_missing",
  "provider_checksum_mismatch",
  "opentofu_init_failed",
]);
const RUNNER_TRANSPORT_FAILED_CODE = "runner_transport_failed";
const RUNNER_REQUEST_ABORTED_CODE = "runner_request_aborted";
const RUNNER_TIMEOUT_CODE = "runner_timeout";
const RUNNER_PROVIDER_EXECUTION_FAILED_CODE = "provider_execution_failed";
const RUNNER_PROVIDER_FAILURE_CODES = new Set([
  "apply_failed",
  RUNNER_PROVIDER_EXECUTION_FAILED_CODE,
]);
const RUNNER_STARTUP_SECONDS_HEADER = "x-takosumi-runner-startup-seconds";
type ContainerRunnerAction =
  | OpenTofuRunAction
  | "release"
  | "stable_semver_tag"
  | "source_snapshot_file";

export class CloudflareContainerOpenTofuRunner
  implements OpenTofuRunner, ServiceDataBackupRunner
{
  readonly #activeRunsByAction = new Map<ContainerRunnerAction, number>();

  constructor(
    private readonly env: CloudflareWorkerEnv,
    private readonly options: {
      readonly observability?: WorkerMetricSink;
    } = {},
  ) {}

  async plan(
    job: OpenTofuPlanJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuPlanResult> {
    const result = await this.#runContainer("plan", job.planRun.id, job, {
      signal: control?.signal,
    });
    const planDigest =
      stringFromRecord(result, "planDigest") ??
      (await digestJson({
        action: "plan",
        runId: job.planRun.id,
        stdout: stringFromRecord(result, "stdout") ?? "",
        stderr: stringFromRecord(result, "stderr") ?? "",
      }));
    const planArtifact = planArtifactFromContainerResult(result, planDigest);
    const planResourceChanges = planResourceChangesFromContainerResult(result);
    const plannedOutputs = plannedOutputsFromContainerResult(result);
    return {
      planDigest,
      planArtifact,
      ...(stringArrayFromRecord(result, "requiredProviders")
        ? {
            requiredProviders: stringArrayFromRecord(
              result,
              "requiredProviders",
            ),
          }
        : {}),
      ...(stringFromRecord(result, "sourceCommit")
        ? { sourceCommit: stringFromRecord(result, "sourceCommit") }
        : {}),
      ...(stringFromRecord(result, "providerLockDigest")
        ? {
            providerLockDigest: stringFromRecord(result, "providerLockDigest"),
          }
        : {}),
      ...(providerInstallationFromContainerResult(result)
        ? {
            providerInstallation:
              providerInstallationFromContainerResult(result),
          }
        : {}),
      ...(recordFromRecord(result, "summary")
        ? {
            summary: recordFromRecord(
              result,
              "summary",
            ) as OpenTofuPlanResult["summary"],
          }
        : {}),
      ...(planResourceChanges ? { planResourceChanges } : {}),
      ...(plannedOutputs ? { plannedOutputs } : {}),
      diagnostics: diagnosticsFromContainerResult(result),
    };
  }

  async apply(
    job: OpenTofuApplyJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuApplyResult> {
    const result = await this.#runContainer(
      "apply",
      runnerRunIdFromPlanArtifact(job.planArtifact) ?? job.planRun.id,
      job,
      { signal: control?.signal },
    );
    // The DO echoes the persisted state digest and opaque raw-output ref. Thread
    // both onto the result so the controller
    // records them on the StateVersion / Output.
    const state = recordFromRecord(result, "state");
    const providerExecutionFailure =
      providerExecutionFailureFromContainerResult(result);
    if (providerExecutionFailure) {
      const stateDigest = state ? stringFromRecord(state, "digest") : undefined;
      if (
        (providerExecutionFailure.statePersistence === "persisted") !==
        Boolean(stateDigest)
      ) {
        throw new Error("runner failed-state persistence evidence is inconsistent");
      }
      return {
        providerExecutionFailure,
        ...(stateDigest ? { stateDigest } : {}),
        ...(providerInstallationFromContainerResult(result)
          ? {
              providerInstallation:
                providerInstallationFromContainerResult(result),
            }
          : {}),
        diagnostics: diagnosticsFromContainerResult(result),
      };
    }
    return {
      ...(recordFromRecord(result, "outputs")
        ? {
            outputs: recordFromRecord(
              result,
              "outputs",
            ) as OpenTofuApplyResult["outputs"],
          }
        : {}),
      ...(state && stringFromRecord(state, "digest")
        ? { stateDigest: stringFromRecord(state, "digest") }
        : {}),
      ...(stringFromRecord(result, "rawOutputRef")
        ? { rawOutputRef: stringFromRecord(result, "rawOutputRef") }
        : {}),
      ...(providerInstallationFromContainerResult(result)
        ? {
            providerInstallation:
              providerInstallationFromContainerResult(result),
          }
        : {}),
      diagnostics: diagnosticsFromContainerResult(result),
    };
  }

  async destroy(
    job: OpenTofuDestroyJob,
    control?: RunExecutionControl,
  ): Promise<OpenTofuDestroyResult> {
    const result = await this.#runContainer(
      "destroy",
      runnerRunIdFromPlanArtifact(job.planArtifact) ?? job.planRun.id,
      job,
      { signal: control?.signal },
    );
    const state = recordFromRecord(result, "state");
    return {
      ...(state && stringFromRecord(state, "digest")
        ? { stateDigest: stringFromRecord(state, "digest") }
        : {}),
      ...(providerInstallationFromContainerResult(result)
        ? {
            providerInstallation:
              providerInstallationFromContainerResult(result),
          }
        : {}),
      diagnostics: diagnosticsFromContainerResult(result),
    };
  }

  async restore(job: OpenTofuRestoreJob): Promise<OpenTofuRestoreResult> {
    const result = await this.#runContainer("restore", job.runId, {
      stateScope: job.stateScope,
      restoreState: job.sourceState,
    });
    const state = recordFromRecord(result, "state");
    const generation = state?.generation;
    const stateRef = state ? stringFromRecord(state, "stateRef") : undefined;
    const digest = state ? stringFromRecord(state, "digest") : undefined;
    if (typeof generation !== "number" || !stateRef || !digest) {
      throw new Error("runner restore returned an incomplete state result");
    }
    return {
      state: { generation, stateRef, digest },
      diagnostics: diagnosticsFromContainerResult(result),
    };
  }

  async release(
    job: ReleaseCommandRunJob,
    control?: RunExecutionControl,
  ): Promise<ReleaseCommandRunResult> {
    const result = await this.#runContainer("release", job.runId, {
      release: {
        commands: job.commands.map((command) => ({
          id: command.id,
          command: [...command.command],
          ...(command.workingDirectory
            ? { workingDirectory: command.workingDirectory }
            : {}),
          ...(command.env ? { env: command.env } : {}),
          ...(command.timeoutSeconds
            ? { timeoutSeconds: command.timeoutSeconds }
            : {}),
        })),
        ...(job.sourceBuild ? { sourceBuild: job.sourceBuild } : {}),
      },
      sourceArchive: {
        ref: job.sourceSnapshot.archiveRef,
        digest: job.sourceSnapshot.archiveDigest,
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
    }, { signal: control?.signal });
    const status = stringFromRecord(result, "status");
    if (status !== "succeeded") {
      throw new Error(
        `release command runner returned ${status ?? "unknown"} status`,
      );
    }
    return {
      status: "succeeded",
      runId: job.runId,
      commandCount:
        typeof result.commandCount === "number"
          ? result.commandCount
          : job.commands.length,
      ...(stringFromRecord(result, "stdout")
        ? { stdout: stringFromRecord(result, "stdout") }
        : {}),
    };
  }

  async sourceSync(
    job: OpenTofuSourceSyncJob,
  ): Promise<OpenTofuSourceSyncResult> {
    // The runner resolves the ref, fetches a shallow checkout, builds the
    // deterministic archive, and PUTs its bytes to the source-archive route on
    // the DO (which persists them through the allocated archiveRef). It then
    // returns only the resolved commit + archive metadata. The request carries
    // the source-phase mint result (git env + files); never logged.
    const result = await this.#runContainer("source_sync", job.runId, {
      action: "source_sync",
      runId: job.runId,
      source: job.source,
      archiveRef: job.archiveRef,
      ...(job.reuseSnapshot ? { reuseSnapshot: job.reuseSnapshot } : {}),
      ...(job.credentials ? { credentials: job.credentials } : {}),
    });
    // The DO persists the archive to R2_SOURCE and rewrites `sourceArchive` to
    // the object-storage form ({ digest, sizeBytes }); `resolvedCommit` stays at
    // the top level. Read both top-level and `sourceArchive` so either shape is
    // accepted.
    const archive = recordFromRecord(result, "sourceArchive");
    const resolvedCommit = stringFromRecord(result, "resolvedCommit");
    const archiveDigest =
      stringFromRecord(result, "archiveDigest") ??
      (archive ? stringFromRecord(archive, "digest") : undefined);
    const archiveSizeBytes =
      typeof result.archiveSizeBytes === "number"
        ? result.archiveSizeBytes
        : archive && typeof archive.sizeBytes === "number"
          ? archive.sizeBytes
          : undefined;
    const archiveRef =
      stringFromRecord(result, "archiveRef") ??
      (archive ? stringFromRecord(archive, "ref") : undefined);
    const repositoryInstallMetadata =
      repositoryInstallMetadataFromContainerResult(result);
    const repositoryManifest = parseRepositoryManifestSnapshot(
      result.repositoryManifest,
    );
    if (!resolvedCommit || !archiveDigest || archiveSizeBytes === undefined) {
      throw new Error("runner source sync returned an incomplete result");
    }
    const phaseTimings = phaseTimingsFromContainerResult(result);
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
    const result = await this.#runContainer(
      "compatibility_check",
      job.runId,
      {
        sourceArchive: {
          ref: job.sourceSnapshot.archiveRef,
          digest: job.sourceSnapshot.archiveDigest,
        },
        source: {
          ...(job.modulePath ? { modulePath: job.modulePath } : {}),
        },
      },
      {
        timeoutMs: compatibilityCheckTimeoutMs(this.env),
      },
    );
    const files = result.files;
    if (!Array.isArray(files)) {
      throw new Error("runner compatibility check returned no files");
    }
    return files.map((entry) => {
      if (!isRecord(entry)) {
        throw new Error("compatibility_check file entry must be an object");
      }
      const path = stringFromRecord(entry, "path");
      const text = stringFromRecord(entry, "text");
      if (!path || text === undefined) {
        throw new Error(
          "compatibility_check file entry requires path and text",
        );
      }
      return { path, text };
    });
  }

  async resolveStableSourceTag(
    job: OpenTofuStableSourceTagResolutionJob,
  ): Promise<OpenTofuStableSourceTagResolutionResult> {
    const result = await this.#runContainer("stable_semver_tag", job.runId, {
      action: "stable_semver_tag",
      url: job.url,
    });
    const tag = stringFromRecord(result, "tag");
    const commit = stringFromRecord(result, "commit");
    if (!tag || !commit) {
      throw new Error("stable_semver_tag returned an incomplete result");
    }
    return { tag, commit };
  }

  async readSourceSnapshotPresentationFile(
    job: OpenTofuSourceSnapshotPresentationFileJob,
  ): Promise<OpenTofuSourceSnapshotPresentationFile> {
    const result = await this.#runContainer(
      "source_snapshot_file",
      job.runId,
      {
        sourceArchive: {
          ref: job.sourceSnapshot.archiveRef,
          digest: job.sourceSnapshot.archiveDigest,
        },
        action: "source_snapshot_file",
        path: job.path,
      },
      { timeoutMs: compatibilityCheckTimeoutMs(this.env) },
    );
    const path = stringFromRecord(result, "path");
    const text = stringFromRecord(result, "text");
    const digest = stringFromRecord(result, "digest");
    const sizeBytes = result.sizeBytes;
    if (
      !path ||
      text === undefined ||
      !digest ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes)
    ) {
      throw new Error("source_snapshot_file returned an incomplete result");
    }
    return { path, text, digest, sizeBytes };
  }

  async run(
    input: ServiceDataBackupRunnerInput,
  ): Promise<ServiceDataBackupRunnerResult> {
    const runId = `backup_${crypto.randomUUID().replaceAll("-", "")}`;
    if (input.mode === "custom_command" && !input.sourceSnapshot) {
      return {
        status: "missing",
        runId,
        reason:
          "custom_command backup requires a SourceSnapshot archive to restore into the runner",
      };
    }
    const result = await this.#runContainer("backup", runId, {
      backup: {
        mode: input.mode,
        outputPath: input.outputPath,
        ...(input.adapterId ? { adapterId: input.adapterId } : {}),
        ...(input.command ? { command: input.command } : {}),
      },
      ...(input.sourceSnapshot
        ? {
            sourceArchive: {
              ref: input.sourceSnapshot.archiveRef,
              digest: input.sourceSnapshot.archiveDigest,
            },
          }
        : {}),
    });
    const status = stringFromRecord(result, "status");
    if (status === "succeeded" || status === "exported") {
      const artifact = artifactPointerFromContainerResult(result);
      if (artifact) {
        return { status: "exported", runId, artifact };
      }
      return {
        status: "missing",
        runId,
        reason: "backup runner did not return an artifact pointer",
      };
    }
    const reason =
      status === "unsupported"
        ? "backup_unsupported"
        : "backup_artifact_unavailable";
    return {
      status: status === "unsupported" ? "unsupported" : "missing",
      runId,
      reason,
    };
  }

  async #runContainer(
    action: ContainerRunnerAction,
    runId: string,
    request: unknown,
    options: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.env.RUNNER) {
      throw new Error("RUNNER binding is not configured");
    }
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    const id = this.env.RUNNER.idFromName(runId);
    const timeoutMs = positiveTimeoutMs(options.timeoutMs);
    const controller =
      timeoutMs || options.signal ? new AbortController() : undefined;
    const abortFromCaller = (): void => {
      controller?.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (controller && timeoutMs) {
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      await this.#recordActiveRuns(action, 1);
      const attempts = runnerCapacityRetryAttempts(this.env);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await this.env.RUNNER.get(id).fetch(
            new Request(
              `https://opentofu-runner.internal/runs/${encodeURIComponent(runId)}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  kind: "takosumi.opentofu-run@v1",
                  action,
                  runId,
                  requestedAt: new Date().toISOString(),
                  request,
                }),
                ...(controller ? { signal: controller.signal } : {}),
              },
            ),
          );
          const { payload, redactedText } =
            await readResponseJsonObject(response);
          const startupSeconds = positiveNumberHeader(
            response.headers.get(RUNNER_STARTUP_SECONDS_HEADER),
          );
          if (startupSeconds !== undefined) {
            await recordWorkerMetric({
              observability: this.options.observability,
              env: this.env,
              name: "takosumi_runner_container_startup_seconds",
              kind: "histogram",
              value: startupSeconds,
              tags: { operation_kind: action, status: "ready" },
            });
          }
          if (!response.ok) {
            if (
              action === "apply" &&
              providerExecutionFailureFromContainerResult(payload)
            ) {
              return failedProviderExecutionResult(payload);
            }
            const failure = runnerFailureEnvelope(
              payload,
              redactedText,
              response.status,
              action,
            );
            const executionError = runnerExecutionErrorFromPayload(payload);
            if (executionError) throw executionError;
            const relayInfrastructureError =
              runnerInfrastructureErrorFromPayload(payload);
            if (relayInfrastructureError) {
              throw relayInfrastructureError;
            }
            if (
              attempt < attempts &&
              failure.code === "capacity_exhausted"
            ) {
              await sleepBeforeCapacityRetry(this.env, attempt, controller);
              continue;
            }
            throw runnerErrorFromFailureEnvelope(failure);
          }
          return payload;
        } catch (error) {
          if (options.signal?.aborted) {
            throw abortReason(options.signal);
          }
          if (controller?.signal.aborted && timeoutMs) {
            throw new OpenTofuRunnerInfrastructureError(
              "runner request timed out",
              { reason: RUNNER_TIMEOUT_CODE },
            );
          }
          if (attempt < attempts && isRunnerCapacityExceededError(error)) {
            await sleepBeforeCapacityRetry(this.env, attempt, controller);
            continue;
          }
          throw runnerErrorFromUnknown(error);
        }
      }
      throw new OpenTofuRunnerInfrastructureError(
        "runner capacity retries exhausted",
        { reason: "capacity_exhausted" },
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
      await this.#recordActiveRuns(action, -1);
    }
  }

  async #recordActiveRuns(
    action: ContainerRunnerAction,
    delta: 1 | -1,
  ): Promise<void> {
    const next = Math.max(
      0,
      (this.#activeRunsByAction.get(action) ?? 0) + delta,
    );
    this.#activeRunsByAction.set(action, next);
    await recordWorkerMetric({
      observability: this.options.observability,
      env: this.env,
      name: "takosumi_runner_active_runs",
      kind: "gauge",
      value: next,
      tags: { operation_kind: action, status: "running" },
    });
  }
}

function providerExecutionFailureFromContainerResult(
  result: Record<string, unknown>,
): OpenTofuApplyResult["providerExecutionFailure"] | undefined {
  const failure = recordFromRecord(result, "providerExecutionFailure");
  if (
    !failure ||
    stringFromRecord(failure, "kind") !== "provider_execution_failed"
  ) {
    return undefined;
  }
  const statePersistence = stringFromRecord(failure, "statePersistence");
  if (
    statePersistence !== "persisted" &&
    statePersistence !== "unavailable"
  ) {
    return undefined;
  }
  const errorCode = stringFromRecord(result, "errorCode");
  return {
    kind: "provider_execution_failed",
    statePersistence,
    errorCode:
      errorCode && RUNNER_PROVIDER_FAILURE_CODES.has(errorCode)
        ? errorCode
        : RUNNER_PROVIDER_EXECUTION_FAILED_CODE,
  };
}

function failedProviderExecutionResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const failure = providerExecutionFailureFromContainerResult(result);
  const state = recordFromRecord(result, "state");
  const stateDigest = state ? stringFromRecord(state, "digest") : undefined;
  return {
    status: "failed",
    errorCode: failure?.errorCode ?? RUNNER_PROVIDER_EXECUTION_FAILED_CODE,
    providerExecutionFailure: {
      kind: "provider_execution_failed",
      statePersistence: failure?.statePersistence ?? "unavailable",
    },
    ...(stateDigest ? { state: { digest: stateDigest } } : {}),
  };
}

async function sleepBeforeCapacityRetry(
  env: CloudflareWorkerEnv,
  attempt: number,
  controller: AbortController | undefined,
): Promise<void> {
  await abortableSleep(
    runnerCapacityRetryDelayMs(env, attempt),
    controller?.signal,
  );
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(_signal: AbortSignal): Error {
  return new DOMException(RUNNER_REQUEST_ABORTED_CODE, "AbortError");
}

function runnerCapacityRetryAttempts(env: CloudflareWorkerEnv): number {
  const configured = positiveTimeoutMs(
    env.TAKOSUMI_RUNNER_CAPACITY_RETRY_ATTEMPTS,
  );
  const attempts = configured ?? DEFAULT_RUNNER_CAPACITY_RETRY_ATTEMPTS;
  return Math.min(MAX_RUNNER_CAPACITY_RETRY_ATTEMPTS, Math.max(1, attempts));
}

function runnerCapacityRetryDelayMs(
  env: CloudflareWorkerEnv,
  attempt: number,
): number {
  const base =
    positiveTimeoutMs(env.TAKOSUMI_RUNNER_CAPACITY_RETRY_BASE_MS) ??
    DEFAULT_RUNNER_CAPACITY_RETRY_BASE_MS;
  return Math.min(
    MAX_RUNNER_CAPACITY_RETRY_DELAY_MS,
    base * 2 ** (attempt - 1),
  );
}

function isRunnerCapacityExceededError(error: unknown): boolean {
  return (
    error instanceof OpenTofuRunnerInfrastructureError &&
    error.reason === "capacity_exhausted"
  ) || (error instanceof Error && isRunnerCapacityExceededMessage(error.message));
}

function isRunnerCapacityExceededMessage(message: string): boolean {
  return RUNNER_CAPACITY_EXCEEDED_PATTERN.test(message);
}

function runnerErrorFromUnknown(error: unknown): Error {
  if (error instanceof OpenTofuRunnerExecutionError) {
    const reason = finiteRunnerReason(error.reason, RUNNER_REJECTED_CODE);
    return new OpenTofuRunnerExecutionError(
      runnerFailureMessage(reason),
      { reason, originalError: error },
    );
  }
  if (error instanceof OpenTofuRunnerInfrastructureError) {
    const reason = finiteRunnerReason(error.reason, RUNNER_TRANSPORT_FAILED_CODE);
    return new OpenTofuRunnerInfrastructureError(
      runnerFailureMessage(reason),
      { reason, originalError: error },
    );
  }
  if (error instanceof Error) {
    const reason = RUNNER_CAPACITY_EXCEEDED_PATTERN.test(error.message)
      ? "capacity_exhausted"
      : RUNNER_SUBSTRATE_RESET_PATTERN.test(error.message)
        ? "substrate_reset"
        : RUNNER_TRANSPORT_FAILED_CODE;
    return new OpenTofuRunnerInfrastructureError(
      runnerFailureMessage(reason),
      { reason, originalError: error },
    );
  }
  return new OpenTofuRunnerInfrastructureError(
    runnerFailureMessage(RUNNER_TRANSPORT_FAILED_CODE),
    { reason: RUNNER_TRANSPORT_FAILED_CODE },
  );
}

type RunnerFailureEnvelope = Readonly<{
  readonly code:
    | typeof RUNNER_REJECTED_CODE
    | typeof RUNNER_TRANSPORT_FAILED_CODE
    | "capacity_exhausted"
    | "substrate_reset";
  readonly status: number;
  readonly phase: ContainerRunnerAction;
}>;

function runnerFailureEnvelope(
  payload: Record<string, unknown>,
  redactedText: string,
  status: number,
  phase: ContainerRunnerAction,
): RunnerFailureEnvelope {
  const errorCode = stringFromRecord(payload, "errorCode");
  const code =
    errorCode === "runner_artifact_relay_ambiguous"
      ? "runner_rejected"
      : RUNNER_CAPACITY_EXCEEDED_PATTERN.test(redactedText) ||
          RUNNER_CAPACITY_EXCEEDED_PATTERN.test(
            stringFromRecord(payload, "error") ?? "",
          )
        ? "capacity_exhausted"
        : RUNNER_SUBSTRATE_RESET_PATTERN.test(redactedText)
          ? "substrate_reset"
          : RUNNER_REJECTED_CODE;
  return { code, status, phase };
}

function runnerErrorFromFailureEnvelope(
  failure: RunnerFailureEnvelope,
): OpenTofuRunnerInfrastructureError {
  return new OpenTofuRunnerInfrastructureError(
    runnerFailureMessage(failure.code),
    { reason: failure.code },
  );
}

function runnerFailureMessage(reason: string): string {
  return `runner request failed (${reason})`;
}

function finiteRunnerReason(
  reason: string | undefined,
  fallback: string,
): string {
  return reason && /^[a-z][a-z0-9_]{0,63}$/u.test(reason) ? reason : fallback;
}

function runnerInfrastructureErrorFromPayload(
  payload: Record<string, unknown>,
): OpenTofuRunnerInfrastructureError | undefined {
  const errorCode = stringFromRecord(payload, "errorCode");
  if (
    payload.retryable === true &&
    errorCode === RUNNER_ARTIFACT_RELAY_AMBIGUOUS_CODE
  ) {
    return new OpenTofuRunnerInfrastructureError(runnerFailureMessage(errorCode), {
      reason: errorCode,
    });
  }
  return undefined;
}

function runnerExecutionErrorFromPayload(
  payload: Record<string, unknown>,
): OpenTofuRunnerExecutionError | undefined {
  const errorCode = stringFromRecord(payload, "errorCode");
  if (errorCode && RUNNER_PLAN_EXECUTION_FAILURE_CODES.has(errorCode)) {
    return new OpenTofuRunnerExecutionError(runnerFailureMessage(errorCode), {
      reason: errorCode,
    });
  }
  if (
    payload.retryable === false &&
    errorCode === RUNNER_MUTATION_INDETERMINATE_CODE
  ) {
    return new OpenTofuRunnerExecutionError(
      runnerFailureMessage(RUNNER_MUTATION_INDETERMINATE_CODE),
      {
      reason: RUNNER_MUTATION_INDETERMINATE_CODE,
      },
    );
  }
  return undefined;
}

function compatibilityCheckTimeoutMs(env: CloudflareWorkerEnv): number {
  return (
    positiveTimeoutMs(env.TAKOSUMI_COMPATIBILITY_CHECK_TIMEOUT_MS) ??
    DEFAULT_COMPATIBILITY_CHECK_TIMEOUT_MS
  );
}

function positiveTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function positiveNumberHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function artifactPointerFromContainerResult(
  result: Record<string, unknown>,
): ServiceDataArtifactPointer | undefined {
  const artifact = recordFromRecord(result, "artifact");
  if (!artifact) return undefined;
  const ref = stringFromRecord(artifact, "ref");
  if (!ref) return undefined;
  const pointer: ServiceDataArtifactPointer = { ref };
  const digest = stringFromRecord(artifact, "digest");
  if (digest) (pointer as { digest?: string }).digest = digest;
  if (
    typeof artifact.sizeBytes === "number" &&
    Number.isInteger(artifact.sizeBytes) &&
    artifact.sizeBytes >= 0
  ) {
    (pointer as { sizeBytes?: number }).sizeBytes = artifact.sizeBytes;
  }
  const contentType = stringFromRecord(artifact, "contentType");
  if (contentType) {
    (pointer as { contentType?: string }).contentType = contentType;
  }
  const metadata = recordFromRecord(artifact, "metadata");
  if (metadata) {
    (pointer as { metadata?: Readonly<Record<string, unknown>> }).metadata =
      metadata;
  }
  return pointer;
}

async function readResponseJsonObject(response: Response): Promise<{
  readonly payload: Record<string, unknown>;
  readonly redactedText: string;
}> {
  const text = await response.text();
  if (text.length === 0) return { payload: {}, redactedText: "" };
  const redactedText = redactRunnerDiagnosticText(text);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (!response.ok) return { payload: {}, redactedText };
    throw error;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { payload: value as Record<string, unknown>, redactedText };
  }
  if (!response.ok) return { payload: {}, redactedText };
  throw new Error("OpenTofu runner response must be a JSON object");
}

function repositoryInstallMetadataFromContainerResult(
  result: Record<string, unknown>,
): OpenTofuSourceSyncResult["repositoryInstallMetadata"] | undefined {
  const value = recordFromRecord(result, "repositoryInstallMetadata");
  if (!value) return undefined;
  const status = stringFromRecord(value, "status");
  if (status === "absent") return { status };
  if (status === "present") {
    const text = stringFromRecord(value, "text");
    return text === undefined ? undefined : { status, text };
  }
  if (status === "invalid") {
    const reason = stringFromRecord(value, "reason");
    if (reason === "not_regular_file" || reason === "too_large") {
      return { status, reason };
    }
  }
  return undefined;
}

function tailText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `...${text.slice(text.length - maxLength)}`;
}

function diagnosticsFromContainerResult(
  result: Record<string, unknown>,
): OpenTofuPlanResult["diagnostics"] {
  const diagnostics: Array<
    NonNullable<OpenTofuPlanResult["diagnostics"]>[number]
  > = [];
  const stderr = stringFromRecord(result, "stderr");
  if (stderr && stderr.trim().length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "runner_diagnostics_redacted",
      message: "runner provider diagnostics omitted",
    });
  }
  const phaseTimingDetail = phaseTimingDetailFromContainerResult(result);
  if (phaseTimingDetail) {
    diagnostics.push({
      severity: "info",
      message: "runner phase timings recorded",
      detail: phaseTimingDetail,
    });
  }
  return diagnostics;
}

function phaseTimingDetailFromContainerResult(
  result: Record<string, unknown>,
): string | undefined {
  const timings =
    phaseTimingsFromContainerResult(result)?.map(
      (entry) => `${entry.phase}=${Math.round(entry.durationMs)}ms`,
    ) ?? [];
  return timings.length > 0 ? timings.join(", ") : undefined;
}

function phaseTimingsFromContainerResult(
  result: Record<string, unknown>,
): NonNullable<OpenTofuSourceSyncResult["phaseTimings"]> | undefined {
  const value = result.phaseTimings;
  if (!Array.isArray(value)) return undefined;
  const timings = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const phase = stringFromRecord(entry, "phase");
    const startedAt = stringFromRecord(entry, "startedAt");
    const finishedAt = stringFromRecord(entry, "finishedAt");
    const durationMs = entry.durationMs;
    if (!phase || !/^[a-z][a-z0-9_]{0,63}$/u.test(phase)) return [];
    if (!startedAt || !isIsoLikeDate(startedAt)) return [];
    if (!finishedAt || !isIsoLikeDate(finishedAt)) return [];
    if (
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      return [];
    }
    return [{ phase, startedAt, finishedAt, durationMs }];
  });
  return timings.length > 0 ? timings : undefined;
}

function isIsoLikeDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function planResourceChangesFromContainerResult(
  result: Record<string, unknown>,
): OpenTofuPlanResult["planResourceChanges"] | undefined {
  const value = result.planResourceChanges;
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const address = stringFromRecord(entry, "address");
    const type = stringFromRecord(entry, "type");
    const actions = stringArrayFromRecord(entry, "actions");
    if (!address || !type || !actions) return [];
    const scope = recordFromRecord(entry, "scope");
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

function plannedOutputsFromContainerResult(
  result: Record<string, unknown>,
): OpenTofuPlanResult["plannedOutputs"] | undefined {
  const value = recordFromRecord(result, "plannedOutputs");
  if (!value) return undefined;
  const outputs: Record<
    string,
    { sensitive: false; value: import("takosumi-contract").JsonValue }
  > = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry) || entry.sensitive !== false) continue;
    if (!isJsonValue(entry.value)) continue;
    outputs[name] = { sensitive: false, value: entry.value };
  }
  return Object.keys(outputs).length > 0 ? outputs : undefined;
}

function isJsonValue(
  value: unknown,
): value is import("takosumi-contract").JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function redactRunnerDiagnosticText(text: string): string {
  return redactString(text, { redactedValue: "[redacted]" });
}

function planArtifactFromContainerResult(
  result: Record<string, unknown>,
  planDigest: string,
): OpenTofuPlanResult["planArtifact"] {
  const artifact = recordFromRecord(result, "planArtifact");
  if (!artifact) {
    throw new Error("runner plan did not return a planArtifact");
  }
  const kind = stringFromRecord(artifact, "kind");
  const ref = stringFromRecord(artifact, "ref");
  const digest = stringFromRecord(artifact, "digest");
  if (!kind || !ref || !digest) {
    throw new Error("runner plan returned an incomplete planArtifact");
  }
  if (digest !== planDigest) {
    throw new Error("runner plan artifact digest does not match planDigest");
  }
  return {
    kind,
    ref,
    digest,
    ...(stringFromRecord(artifact, "contentType")
      ? { contentType: stringFromRecord(artifact, "contentType") }
      : {}),
    ...(typeof artifact?.sizeBytes === "number"
      ? { sizeBytes: artifact.sizeBytes }
      : {}),
    ...(typeof artifact?.createdAt === "number"
      ? { createdAt: artifact.createdAt }
      : {}),
  };
}

function runnerRunIdFromPlanArtifact(
  artifact: OpenTofuPlanResult["planArtifact"],
): string | undefined {
  const runnerLocal = /^runner-local:\/\/([^/]+)\/tfplan$/.exec(artifact.ref);
  if (runnerLocal?.[1]) return runnerLocal[1];
  const r2Plan = /^r2:\/\/[^/]+\/opentofu-plan-runs\/([^/]+)\/tfplan$/.exec(
    artifact.ref,
  );
  if (r2Plan?.[1]) return r2Plan[1];
  const canonicalPlan =
    /^r2:\/\/[^/]+\/spaces\/[^/]+\/installations\/[^/]+\/runs\/([^/]+)\/plan\.bin$/.exec(
      artifact.ref,
    );
  return canonicalPlan?.[1];
}

function providerInstallationFromContainerResult(
  result: Record<string, unknown>,
): OpenTofuPlanResult["providerInstallation"] | undefined {
  const value = result.providerInstallation;
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const provider = stringFromRecord(entry, "provider");
    const rawMethod = stringFromRecord(entry, "installationMethod");
    if (
      !provider ||
      (rawMethod !== "filesystem_mirror" &&
        rawMethod !== "direct" &&
        rawMethod !== "unknown")
    ) {
      return [];
    }
    // `rawMethod` is `string | undefined` so TS does not narrow it to the
    // literal union through the negative guard above; re-bind it as the
    // already-validated literal so the row matches `ProviderInstallationEvidence`.
    const installationMethod: "filesystem_mirror" | "direct" | "unknown" =
      rawMethod;
    return [
      {
        provider,
        mirrored: entry.mirrored === true,
        installationMethod,
        ...(stringFromRecord(entry, "mirrorPath")
          ? { mirrorPath: stringFromRecord(entry, "mirrorPath") }
          : {}),
        ...(entry.attested === true ? { attested: true } : {}),
        ...(stringFromRecord(entry, "attestationMethod") ===
        "forced_filesystem_mirror_init"
          ? { attestationMethod: "forced_filesystem_mirror_init" as const }
          : {}),
        ...(stringFromRecord(entry, "cliConfigDigest")
          ? { cliConfigDigest: stringFromRecord(entry, "cliConfigDigest") }
          : {}),
        ...(stringFromRecord(entry, "installedPath")
          ? { installedPath: stringFromRecord(entry, "installedPath") }
          : {}),
        ...(stringFromRecord(entry, "installedDigest")
          ? { installedDigest: stringFromRecord(entry, "installedDigest") }
          : {}),
      },
    ];
  });
  return rows.length > 0 ? rows : undefined;
}

function stringArrayFromRecord(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function stringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordFromRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? true
    : false;
}

async function digestJson(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
