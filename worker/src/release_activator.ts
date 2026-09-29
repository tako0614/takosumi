import type {
  ReleaseActivationInput,
  ReleaseActivationCommand,
  ReleaseActivationJob,
  ReleaseActivationResult,
  ReleaseActivationStep,
  ReleaseActivator,
  ReleaseActivationStatus,
  ReleaseCommandRunJob,
  ReleaseCommandRunResult,
  OpenTofuReleaseMutationProgress,
  OpenTofuReleaseObservationSelector,
  RunExecutionControl,
  OpenTofuRunner,
} from "../../core/domains/deploy-control/mod.ts";
import type { JsonValue } from "takosumi-contract/reference/compat";
import { redactString } from "takosumi-contract/redaction";
import type { CloudflareWorkerEnv } from "./bindings.ts";

const RELEASE_ACTIVATOR_KIND = "takosumi.operator.release-activation@v2";
const ALLOWED_STATUSES = [
  "skipped",
  "pending",
  "succeeded",
  "failed",
] as const satisfies readonly ReleaseActivationStatus[];

export interface WebhookReleaseActivatorOptions {
  readonly url: string;
  readonly token: string;
  readonly sourceArchiveBucket?: string;
  readonly fetcher?: typeof fetch;
  readonly allowInsecure?: boolean;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export type DurableReleaseActivationJob = ReleaseActivationJob;
export type DurableReleaseActivationStep = ReleaseActivationStep;

export interface DurableWebhookReleaseActivator {
  submit(
    input: ReleaseActivationInput,
    control?: RunExecutionControl,
  ): Promise<DurableReleaseActivationStep>;
  observe(
    job: DurableReleaseActivationJob,
    control?: RunExecutionControl,
  ): Promise<DurableReleaseActivationStep>;
}

/**
 * Submission can be accepted remotely even when the caller loses the HTTP
 * acknowledgement. Callers must record this state and must not resubmit.
 */
export class ReleaseActivationIndeterminateError extends Error {
  readonly code = "release_activation_indeterminate";

  constructor(message: string) {
    super(message);
    this.name = "ReleaseActivationIndeterminateError";
  }
}

/**
 * Creates a one-request-at-a-time webhook bridge for durable orchestration.
 * The caller owns scheduling and persistence; submit never retries POST and
 * observe performs exactly one GET.
 */
export function createDurableWebhookReleaseActivator(
  options: WebhookReleaseActivatorOptions,
): DurableWebhookReleaseActivator {
  const endpoint = parseReleaseActivatorUrl(
    options.url,
    options.allowInsecure === true,
  );
  const token = options.token.trim();
  if (!token) throw new Error("release activator token is required");
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  return {
    async submit(input, control) {
      throwIfAborted(control?.signal);
      const operatorCommands = input.commands.filter(
        (command) => command.executor === "operator",
      );
      if (operatorCommands.length === 0) {
        const result: ReleaseActivationResult = {
          status: input.commands.length === 0 ? "skipped" : "pending",
          kind: RELEASE_ACTIVATOR_KIND,
          message:
            "operator release activator only accepts executor=operator commands",
          metadata: {
            commandCount: input.commands.length,
            runnerCommandCount: input.commands.length,
          },
        };
        return { kind: "settled", result };
      }

      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(
            releaseActivationWebhookPayload(
              { ...input, commands: operatorCommands },
              { sourceArchiveBucket: options.sourceArchiveBucket },
            ),
          ),
          ...(control?.signal ? { signal: control.signal } : {}),
        });
      } catch {
        throw new ReleaseActivationIndeterminateError(
          "release activator submission outcome is unknown; do not resubmit",
        );
      }
      if (response.status === 204) {
        return { kind: "settled", result: { status: "succeeded" } };
      }
      if (!response.ok) {
        const detail = await releaseActivatorFailureDetail(response);
        const message = `release activator request failed: ${response.status}${detail ? `: ${detail}` : ""}`;
        if (response.status >= 500) {
          throw new ReleaseActivationIndeterminateError(
            "release activator submission outcome is unknown; do not resubmit",
          );
        }
        throw new Error(message);
      }

      let rawResponse: unknown;
      try {
        rawResponse = await response.json();
      } catch {
        throw new ReleaseActivationIndeterminateError(
          "release activator submission returned no usable acknowledgement; do not resubmit",
        );
      }
      let result: ReleaseActivationResult;
      try {
        result = parseReleaseActivatorResponse(rawResponse);
      } catch {
        throw new ReleaseActivationIndeterminateError(
          "release activator submission returned an invalid acknowledgement; do not resubmit",
        );
      }
      if (result.status !== "pending") {
        return { kind: "settled", result };
      }
      const job = durableReleaseActivatorJobReference(rawResponse, endpoint);
      if (!job) {
        throw new ReleaseActivationIndeterminateError(
          "release activator returned pending without a valid job reference; do not resubmit",
        );
      }
      return { kind: "pending", job };
    },
    async observe(job, control) {
      throwIfAborted(control?.signal);
      const safeJob = validateDurableReleaseActivatorJob(job, endpoint);
      const response = await fetcher(
        safeJob.statusUrl ?? statusUrlForJob(endpoint, safeJob.jobId),
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
          },
          ...(control?.signal ? { signal: control.signal } : {}),
        },
      );
      if (response.status === 204) {
        return { kind: "settled", result: { status: "succeeded" } };
      }
      if (!response.ok) {
        const detail = await releaseActivatorFailureDetail(response);
        throw new Error(
          `release activator job status failed: ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      const result = parseReleaseActivatorResponse(await response.json());
      return result.status === "pending"
        ? { kind: "pending", job: safeJob }
        : { kind: "settled", result };
    },
  };
}

/**
 * Builds the operator/Cloud release activation bridge. The platform Worker
 * stays generic: it posts minimal, non-secret apply evidence to an external
 * materializer that owns product-specific publication outside the OpenTofu
 * apply ledger.
 */
export function createWebhookReleaseActivator(
  options: WebhookReleaseActivatorOptions,
): ReleaseActivator {
  const endpoint = parseReleaseActivatorUrl(
    options.url,
    options.allowInsecure === true,
  );
  const token = options.token.trim();
  if (!token) throw new Error("release activator token is required");
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 3000);
  const timeoutMs = Math.max(pollIntervalMs, options.timeoutMs ?? 45 * 60_000);
  const durableActivator = createDurableWebhookReleaseActivator(options);
  return {
    async activate(input, control) {
      throwIfAborted(control?.signal);
      const operatorCommands = input.commands.filter(
        (command) => command.executor === "operator",
      );
      if (operatorCommands.length === 0) {
        const metadata: Readonly<Record<string, JsonValue>> = {
          commandCount: input.commands.length,
          runnerCommandCount: input.commands.length,
        };
        return {
          status: input.commands.length === 0 ? "skipped" : "pending",
          kind: RELEASE_ACTIVATOR_KIND,
          message:
            "operator release activator only accepts executor=operator commands",
          metadata,
        };
      }
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(
          releaseActivationWebhookPayload(
            {
              ...input,
              commands: operatorCommands,
            },
            {
              sourceArchiveBucket: options.sourceArchiveBucket,
            },
          ),
        ),
        ...(control?.signal ? { signal: control.signal } : {}),
      });
      if (!response.ok) {
        const detail = await releaseActivatorFailureDetail(response);
        throw new Error(
          `release activator request failed: ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      if (response.status === 204) {
        return { status: "succeeded" };
      }
      const rawResponse = await response.json();
      const result = parseReleaseActivatorResponse(rawResponse);
      const job = releaseActivatorJobReference(rawResponse, endpoint);
      if (result.status === "pending" && job) {
        return await pollReleaseActivatorJob({
          endpoint,
          token,
          fetcher,
          job,
          pollIntervalMs,
          timeoutMs,
          signal: control?.signal,
        });
      }
      return result;
    },
    async submitOperator(input, control) {
      const operatorCommands = input.commands.filter(
        (command) => command.executor === "operator",
      );
      return await durableActivator.submit(
        operatorActivationInput(input, operatorCommands),
        control,
      );
    },
    async observeOperator(job, control) {
      return await durableActivator.observe(job, control);
    },
  };
}

export function createCompositeReleaseActivator(options: {
  readonly runner?: ReleaseActivator;
  readonly operator?: ReleaseActivator;
}): ReleaseActivator | undefined {
  if (!options.runner && !options.operator) return undefined;
  return {
    async activate(input, control) {
      throwIfAborted(control?.signal);
      if (input.commands.length === 0) return { status: "skipped" };
      const runnerCommands = input.commands.filter(
        isRunnerExecutableCommand,
      );
      const operatorCommands = input.commands.filter(
        (command) => command.executor === "operator",
      );
      const runnerResult =
        runnerCommands.length > 0
          ? options.runner
            ? await options.runner.activate(
                {
                  ...input,
                  commands: runnerCommands,
                },
                control,
              )
            : missingReleaseActivatorResult("runner", runnerCommands.length)
          : undefined;
      throwIfAborted(control?.signal);
      const operatorResult =
        operatorCommands.length > 0
          ? options.operator
            ? await options.operator.activate(
                operatorActivationInput(input, operatorCommands),
                control,
              )
            : missingReleaseActivatorResult("operator", operatorCommands.length)
          : undefined;
      return combineActivationResults({
        runnerCommands,
        operatorCommands,
        runnerResult,
        operatorResult,
      });
    },
    ...(options.runner?.submitRunner
      ? {
          async submitRunner(input: ReleaseActivationInput, control?: RunExecutionControl) {
            const runnerCommands = input.commands.filter(isRunnerExecutableCommand);
            if (runnerCommands.length === 0) {
              return { kind: "settled" as const, result: { status: "skipped" as const } };
            }
            return await options.runner!.submitRunner!(
              { ...input, commands: runnerCommands },
              control,
            );
          },
        }
      : {}),
    ...(options.runner?.observeRunner
      ? {
          async observeRunner(input: ReleaseActivationInput, control?: RunExecutionControl) {
            const runnerCommands = input.commands.filter(isRunnerExecutableCommand);
            if (runnerCommands.length === 0) {
              return { kind: "settled" as const, result: { status: "skipped" as const } };
            }
            return await options.runner!.observeRunner!(
              { ...input, commands: runnerCommands },
              control,
            );
          },
        }
      : {}),
    ...(options.operator?.submitOperator
      ? {
          async submitOperator(input: ReleaseActivationInput, control?: RunExecutionControl) {
            const operatorCommands = input.commands.filter(
              (command) => command.executor === "operator",
            );
            if (operatorCommands.length === 0) {
              return { kind: "settled" as const, result: { status: "skipped" as const } };
            }
            return await options.operator!.submitOperator!(
              operatorActivationInput(input, operatorCommands),
              control,
            );
          },
        }
      : {}),
    ...(options.operator?.observeOperator
      ? {
          async observeOperator(job: ReleaseActivationJob, control?: RunExecutionControl) {
            return await options.operator!.observeOperator!(job, control);
          },
        }
      : {}),
  };
}

function operatorActivationInput(
  input: ReleaseActivationInput,
  commands: ReleaseActivationInput["commands"],
): ReleaseActivationInput {
  const operatorInput = { ...input, commands };
  // Provider credentials are minted only for runner-executed commands. A
  // composite phase may also contain operator commands, but that boundary must
  // never expose the runner's dispatch-only bundle to the operator adapter.
  delete operatorInput.credentials;
  delete operatorInput.runtimeSecretFileBundle;
  return operatorInput;
}

function missingReleaseActivatorResult(
  executor: "runner" | "operator",
  commandCount: number,
): ReleaseActivationResult {
  return {
    status: "pending",
    kind: RELEASE_ACTIVATOR_KIND,
    message: `${executor} release commands require a configured ${executor} release activator`,
    metadata: {
      commandCount,
      missingExecutor: executor,
    },
  };
}

export function createRunnerReleaseActivator(
  runner: Pick<
    OpenTofuRunner,
    "release" | "submitRelease" | "observeRelease"
  >,
): ReleaseActivator | undefined {
  const supportsDurableRelease =
    typeof runner.submitRelease === "function" &&
    typeof runner.observeRelease === "function";
  if (typeof runner.release !== "function" && !supportsDurableRelease) {
    return undefined;
  }
  return {
    async activate(input, control) {
      throwIfAborted(control?.signal);
      const prepared = prepareRunnerReleaseJob(input);
      if (prepared.kind === "settled") return prepared.result;
      if (typeof runner.release !== "function") {
        return {
          status: "pending",
          kind: "takosumi.release-commands@v1",
          message: `${prepared.phase} release requires durable runner support`,
        };
      }
      const result = await runner.release(prepared.job, control);
      return runnerReleaseActivationResult(result, prepared.phase);
    },
    ...(supportsDurableRelease
      ? {
          async submitRunner(input: ReleaseActivationInput, control?: RunExecutionControl) {
            throwIfAborted(control?.signal);
            const prepared = prepareRunnerReleaseJob(input);
            if (prepared.kind === "settled") {
              return { kind: "settled" as const, result: prepared.result };
            }
            const progress = await runner.submitRelease!(prepared.job, control);
            return runnerReleaseActivationStep(progress, prepared.phase);
          },
          async observeRunner(input: ReleaseActivationInput, control?: RunExecutionControl) {
            throwIfAborted(control?.signal);
            const prepared = prepareRunnerReleaseObservation(input);
            if (prepared.kind === "settled") {
              return { kind: "settled" as const, result: prepared.result };
            }
            const progress = await runner.observeRelease!(prepared.selector, control);
            return runnerReleaseActivationStep(progress, prepared.phase);
          },
        }
      : {}),
  };
}

type PreparedRunnerReleaseJob =
  | { readonly kind: "settled"; readonly result: ReleaseActivationResult }
  | {
      readonly kind: "ready";
      readonly phase: ReturnType<typeof releaseCommandPhaseLabel>;
      readonly job: ReleaseCommandRunJob;
    };

function prepareRunnerReleaseJob(
  input: ReleaseActivationInput,
): PreparedRunnerReleaseJob {
  const validated = validateRunnerReleaseCommands(input);
  if (validated.kind === "settled") return validated;
  const { phase, commands } = validated;
  return {
    kind: "ready",
    phase,
    job: {
      runId: releaseCommandRunId(input.applyRun.id),
      commands,
      sourceSnapshot: input.sourceSnapshot!,
      nonSensitiveOutputs: input.nonSensitiveOutputs,
      providerConfigurations: input.providerConfigurations,
      ...(input.credentials ? { credentials: input.credentials } : {}),
      ...(input.runtimeSecretFileBundle
        ? {
            runtimeSecrets: input.runtimeSecretFileBundle.toRunnerDispatch(),
          }
        : {}),
      ...(input.sourceBuild ? { sourceBuild: input.sourceBuild } : {}),
      applyRunId: input.applyRun.id,
      workspaceId: input.applyRun.workspaceId,
      capsuleId: input.capsule.id,
      stateVersionId: input.stateVersion.id,
    },
  };
}

type ValidatedRunnerReleaseCommands =
  | { readonly kind: "settled"; readonly result: ReleaseActivationResult }
  | {
      readonly kind: "ready";
      readonly phase: ReturnType<typeof releaseCommandPhaseLabel>;
      readonly commands: readonly ReleaseActivationCommand[];
    };

function validateRunnerReleaseCommands(
  input: ReleaseActivationInput,
): ValidatedRunnerReleaseCommands {
  if (input.commands.length === 0) {
    return { kind: "settled", result: { status: "skipped" } };
  }
  const phase = releaseCommandPhaseLabel(input.commands);
  const operatorCommands = input.commands.filter(
    (command) => command.executor === "operator",
  );
  if (operatorCommands.length > 0) {
    return {
      kind: "settled",
      result: {
        status: "pending",
        kind: RELEASE_ACTIVATOR_KIND,
        message: `${phase} release commands require an operator release activator`,
        metadata: {
          commandCount: input.commands.length,
          operatorCommandCount: operatorCommands.length,
        },
      },
    };
  }
  if (!input.sourceSnapshot) {
    return {
      kind: "settled",
      result: {
        status: "pending",
        kind: "takosumi.release-commands@v1",
        message: `${phase} release commands require a source snapshot archive`,
      },
    };
  }
  if (
    input.runtimeSecretFileBundle &&
    input.commands.some((command) => command.phase !== "post_apply")
  ) {
    throw new TypeError(
      "runtime secret files are available only to post-apply runner commands",
    );
  }
  const runnerCommands = input.commands.filter(isRunnerExecutableCommand);
  if (runnerCommands.length !== input.commands.length) {
    return {
      kind: "settled",
      result: {
        status: "pending",
        kind: RELEASE_ACTIVATOR_KIND,
        message: `${phase} typed operator actions require an operator release activator`,
      },
    };
  }
  return {
    kind: "ready",
    phase,
    commands: runnerCommands,
  };
}

type PreparedRunnerReleaseObservation =
  | { readonly kind: "settled"; readonly result: ReleaseActivationResult }
  | {
      readonly kind: "ready";
      readonly phase: ReturnType<typeof releaseCommandPhaseLabel>;
      readonly selector: OpenTofuReleaseObservationSelector;
    };

function prepareRunnerReleaseObservation(
  input: ReleaseActivationInput,
): PreparedRunnerReleaseObservation {
  const validated = validateRunnerReleaseCommands(input);
  if (validated.kind === "settled") return validated;
  return {
    kind: "ready",
    phase: validated.phase,
    selector: {
      kind: "takosumi.runner-release-observation@v1",
      releaseRunId: releaseCommandRunId(input.applyRun.id),
      applyRunId: input.applyRun.id,
      actionIds: validated.commands.map((command) => command.id),
    },
  };
}

function runnerReleaseActivationStep(
  progress: OpenTofuReleaseMutationProgress,
  phase: ReturnType<typeof releaseCommandPhaseLabel>,
): ReleaseActivationStep {
  if (progress.kind === "pending") return { kind: "pending" };
  if (progress.kind === "indeterminate") {
    throw new ReleaseActivationIndeterminateError(
      "runner release dispatch outcome is indeterminate; do not resubmit",
    );
  }
  return {
    kind: "settled",
    result: runnerReleaseActivationResult(progress.result, phase),
  };
}

function runnerReleaseActivationResult(
  result: ReleaseCommandRunResult,
  phase: ReturnType<typeof releaseCommandPhaseLabel>,
): ReleaseActivationResult {
  return {
    status: "succeeded",
    kind: "takosumi.release-commands@v1",
    message: `ran ${result.commandCount} ${phase} release command(s)`,
    metadata: {
      releaseRunId: result.runId,
      commandCount: result.commandCount,
    },
  };
}

function isRunnerExecutableCommand(
  action: ReleaseActivationInput["commands"][number],
): action is ReleaseActivationCommand {
  return action.kind !== "resource_migration" && action.executor !== "operator";
}

function releaseCommandPhaseLabel(
  commands: ReleaseActivationInput["commands"],
): "post-apply" | "pre-destroy" | "mixed-phase" {
  const phases = new Set(commands.map((command) => command.phase));
  if (phases.size === 1 && phases.has("pre_destroy")) return "pre-destroy";
  if (phases.size === 1 && phases.has("post_apply")) return "post-apply";
  return "mixed-phase";
}

export function releaseActivatorFromEnv(
  env: CloudflareWorkerEnv,
  runtimeEnv: Record<string, string | undefined>,
): ReleaseActivator | undefined {
  const url = stringEnv(env.TAKOSUMI_RELEASE_ACTIVATOR_URL);
  if (!url) return undefined;
  const token = stringEnv(env.TAKOSUMI_RELEASE_ACTIVATOR_TOKEN);
  if (!token) {
    throw new Error(
      "TAKOSUMI_RELEASE_ACTIVATOR_TOKEN is required when TAKOSUMI_RELEASE_ACTIVATOR_URL is set",
    );
  }
  return createWebhookReleaseActivator({
    url,
    token,
    sourceArchiveBucket: stringEnv(env.TAKOSUMI_RELEASE_SOURCE_BUCKET),
    allowInsecure: releaseActivatorInsecureAllowed(env, runtimeEnv),
  });
}

function combineActivationResults(input: {
  readonly runnerCommands: readonly unknown[];
  readonly operatorCommands: readonly unknown[];
  readonly runnerResult?: ReleaseActivationResult;
  readonly operatorResult?: ReleaseActivationResult;
}): ReleaseActivationResult {
  const results = [input.runnerResult, input.operatorResult].filter(
    (result): result is ReleaseActivationResult => result !== undefined,
  );
  if (results.length === 0) return { status: "skipped" };
  if (results.length === 1) return results[0]!;
  const status = combinedStatus(results);
  const metadata: Record<string, JsonValue> = {
    runnerCommandCount: input.runnerCommands.length,
    operatorCommandCount: input.operatorCommands.length,
    runnerStatus: input.runnerResult?.status ?? "skipped",
    operatorStatus: input.operatorResult?.status ?? "skipped",
  };
  const messages = results
    .map((result) => result.message)
    .filter((message): message is string => Boolean(message));
  return {
    status,
    kind: "takosumi.release-activation.composite@v1",
    ...(messages.length > 0 ? { message: messages.join("; ") } : {}),
    metadata,
  };
}

function combinedStatus(
  results: readonly ReleaseActivationResult[],
): ReleaseActivationStatus {
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "pending")) return "pending";
  if (results.some((result) => result.status === "succeeded")) {
    return "succeeded";
  }
  return "skipped";
}

function releaseActivatorInsecureAllowed(
  env: CloudflareWorkerEnv,
  runtimeEnv: Record<string, string | undefined>,
): boolean {
  return (
    env.LOCAL_SUBSTRATE_TEST_BED === "1" || runtimeEnv.TAKOSUMI_DEV_MODE === "1"
  );
}

function releaseActivationWebhookPayload(
  input: ReleaseActivationInput,
  options: { readonly sourceArchiveBucket?: string } = {},
) {
  const workspaceId = input.applyRun.workspaceId;
  const sourceArchiveBucket = options.sourceArchiveBucket?.trim();
  return {
    kind: RELEASE_ACTIVATOR_KIND,
    planRunId: input.planRun.id,
    applyRunId: input.applyRun.id,
    workspaceId,
    capsule: {
      id: input.capsule.id,
      name: input.capsule.name,
      environment: input.capsule.environment,
      sourceId: input.capsule.sourceId,
      installConfigId: input.capsule.installConfigId,
    },
    stateVersion: {
      id: input.stateVersion.id,
      generation: input.stateVersion.generation,
      digest: input.stateVersion.digest,
      createdByRunId: input.stateVersion.createdByRunId,
    },
    output: {
      id: input.output.id,
      stateGeneration: input.output.stateGeneration,
      outputDigest: input.output.outputDigest,
    },
    ...(input.sourceSnapshot
      ? {
          sourceSnapshot: {
            id: input.sourceSnapshot.id,
            origin: input.sourceSnapshot.origin,
            ...(sourceArchiveBucket
              ? { archiveBucket: sourceArchiveBucket }
              : {}),
            archiveRef: input.sourceSnapshot.archiveRef,
            archiveDigest: input.sourceSnapshot.archiveDigest,
            resolvedCommit: input.sourceSnapshot.resolvedCommit,
            path: input.sourceSnapshot.path,
          },
        }
      : {}),
    nonSensitiveOutputs: input.nonSensitiveOutputs,
    providerConfigurations: input.providerConfigurations,
    ...(input.sourceBuild ? { sourceBuild: input.sourceBuild } : {}),
    commands: input.commands,
  };
}

function releaseCommandRunId(applyRunId: string): string {
  return `release_${applyRunId.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
}

async function releaseActivatorFailureDetail(
  response: Response,
): Promise<string> {
  try {
    const body = await response.text();
    return redactFailureDetail(body).slice(0, 1200);
  } catch {
    return "";
  }
}

/**
 * The activator is an operator-side process that runs operator argv and puts
 * its stdout/stderr tails into failure bodies and result messages. Everything
 * crossing this boundary lands in workspace-visible Run activity, so it goes
 * through the shared secret heuristics before flattening — the operator's own
 * value substitution only covers env it already knows about.
 */
function redactFailureDetail(value: string): string {
  return redactString(value)
    .replace(/[\0\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function parseReleaseActivatorResponse(
  value: unknown,
): ReleaseActivationResult {
  if (!isRecord(value)) {
    throw new Error("release activator response must be a JSON object");
  }
  const status = value.status;
  if (!isReleaseActivationStatus(status)) {
    throw new Error("release activator response status is invalid");
  }
  return {
    status,
    ...(stringField(value, "kind") ? { kind: stringField(value, "kind") } : {}),
    ...(stringField(value, "message")
      ? { message: redactFailureDetail(stringField(value, "message")!) }
      : {}),
    ...(stringField(value, "healthUrl")
      ? { healthUrl: stringField(value, "healthUrl") }
      : {}),
    ...(isJsonRecord(value.metadata)
      ? { metadata: value.metadata as Readonly<Record<string, JsonValue>> }
      : {}),
  };
}

async function pollReleaseActivatorJob(input: {
  readonly endpoint: string;
  readonly token: string;
  readonly fetcher: typeof fetch;
  readonly job: ReleaseActivatorJobReference;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ReleaseActivationResult> {
  const deadline = Date.now() + input.timeoutMs;
  const fetcher = input.fetcher;
  while (Date.now() <= deadline) {
    await sleep(input.pollIntervalMs, input.signal);
    throwIfAborted(input.signal);
    const response = await fetcher(
      input.job.statusUrl ?? statusUrlForJob(input.endpoint, input.job.jobId),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.token}`,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (!response.ok) {
      const detail = await releaseActivatorFailureDetail(response);
      throw new Error(
        `release activator job status failed: ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    const result = parseReleaseActivatorResponse(await response.json());
    if (result.status !== "pending") return result;
  }
  throw new Error(
    `release activator job ${input.job.jobId} did not finish within ${input.timeoutMs}ms`,
  );
}

interface ReleaseActivatorJobReference {
  readonly jobId: string;
  readonly statusUrl?: string;
}

function durableReleaseActivatorJobReference(
  value: unknown,
  endpoint: string,
): DurableReleaseActivationJob | undefined {
  if (!isRecord(value)) return undefined;
  const rawJobId =
    typeof value.jobId === "string"
      ? value.jobId
      : isRecord(value.metadata) && typeof value.metadata.jobId === "string"
        ? value.metadata.jobId
        : undefined;
  const jobId = rawJobId?.trim();
  if (!jobId) return undefined;

  if (value.statusUrl !== undefined) {
    if (typeof value.statusUrl !== "string") return undefined;
    const statusUrl = sameOriginStatusUrl(value.statusUrl, endpoint);
    if (!statusUrl) return undefined;
    return { jobId, statusUrl };
  }
  return { jobId };
}

function validateDurableReleaseActivatorJob(
  value: DurableReleaseActivationJob,
  endpoint: string,
): DurableReleaseActivationJob {
  if (!isRecord(value) || typeof value.jobId !== "string" || !value.jobId.trim()) {
    throw new TypeError("release activator job reference is invalid");
  }
  const jobId = value.jobId.trim();
  if (value.statusUrl === undefined) return { jobId };
  if (typeof value.statusUrl !== "string") {
    throw new TypeError("release activator job status URL is invalid");
  }
  const statusUrl = sameOriginStatusUrl(value.statusUrl, endpoint);
  if (!statusUrl) {
    throw new TypeError("release activator job status URL must be same-origin");
  }
  return { jobId, statusUrl };
}

function releaseActivatorJobReference(
  value: unknown,
  endpoint: string,
): ReleaseActivatorJobReference | undefined {
  if (!isRecord(value)) return undefined;
  const jobId =
    typeof value.jobId === "string"
      ? value.jobId
      : isRecord(value.metadata) && typeof value.metadata.jobId === "string"
        ? value.metadata.jobId
        : undefined;
  if (!jobId) return undefined;
  const statusUrl =
    typeof value.statusUrl === "string"
      ? sameOriginStatusUrl(value.statusUrl, endpoint)
      : undefined;
  return { jobId, ...(statusUrl ? { statusUrl } : {}) };
}

function sameOriginStatusUrl(
  value: string,
  endpoint: string,
): string | undefined {
  try {
    const parsed = parseReleaseActivatorUrl(
      value,
      endpoint.startsWith("http:"),
    );
    if (new URL(parsed).origin !== new URL(endpoint).origin) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function statusUrlForJob(endpoint: string, jobId: string): string {
  const url = new URL(endpoint);
  url.search = "";
  url.searchParams.set("jobId", jobId);
  return url.toString();
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Release activation aborted", "AbortError");
}

function isReleaseActivationStatus(
  value: unknown,
): value is ReleaseActivationStatus {
  return (
    typeof value === "string" &&
    ALLOWED_STATUSES.includes(value as ReleaseActivationStatus)
  );
}

function parseReleaseActivatorUrl(url: string, allowInsecure: boolean): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !allowInsecure) {
    throw new Error("release activator URL must use https");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("release activator URL must use http or https");
  }
  return parsed.toString();
}

function stringEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}
