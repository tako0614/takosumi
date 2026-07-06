import type {
  ReleaseActivationInput,
  ReleaseActivationResult,
  ReleaseActivator,
  ReleaseActivationStatus,
  OpenTofuRunner,
} from "../../core/domains/deploy-control/mod.ts";
import type { JsonValue } from "takosumi-contract/reference/compat";
import type { CloudflareWorkerEnv } from "./bindings.ts";

const RELEASE_ACTIVATOR_KIND = "takosumi.operator.release-activation@v1";
const ALLOWED_STATUSES = [
  "skipped",
  "pending",
  "succeeded",
  "failed",
] as const satisfies readonly ReleaseActivationStatus[];

export interface WebhookReleaseActivatorOptions {
  readonly url: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
  readonly allowInsecure?: boolean;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
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
  return {
    async activate(input) {
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
          kind: "takosumi.operator.release-activation@v1",
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
          releaseActivationWebhookPayload({
            ...input,
            commands: operatorCommands,
          }),
        ),
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
        });
      }
      return result;
    },
  };
}

export function createCompositeReleaseActivator(options: {
  readonly runner?: ReleaseActivator;
  readonly operator?: ReleaseActivator;
}): ReleaseActivator | undefined {
  if (!options.runner) return options.operator;
  if (!options.operator) return options.runner;
  return {
    async activate(input) {
      if (input.commands.length === 0) return { status: "skipped" };
      const runnerCommands = input.commands.filter(
        (command) => command.executor !== "operator",
      );
      const operatorCommands = input.commands.filter(
        (command) => command.executor === "operator",
      );
      const runnerResult =
        runnerCommands.length > 0
          ? await options.runner!.activate({
              ...input,
              commands: runnerCommands,
            })
          : undefined;
      const operatorResult =
        operatorCommands.length > 0
          ? await options.operator!.activate({
              ...input,
              commands: operatorCommands,
            })
          : undefined;
      return combineActivationResults({
        runnerCommands,
        operatorCommands,
        runnerResult,
        operatorResult,
      });
    },
  };
}

export function createRunnerReleaseActivator(
  runner: Pick<OpenTofuRunner, "release">,
): ReleaseActivator | undefined {
  if (typeof runner.release !== "function") return undefined;
  return {
    async activate(input) {
      if (input.commands.length === 0) return { status: "skipped" };
      const operatorCommands = input.commands.filter(
        (command) => command.executor === "operator",
      );
      if (operatorCommands.length > 0) {
        const metadata: Readonly<Record<string, JsonValue>> = {
          commandCount: input.commands.length,
          operatorCommandCount: operatorCommands.length,
        };
        return {
          status: "pending",
          kind: "takosumi.operator.release-activation@v1",
          message:
            "post-apply release commands require an operator release activator",
          metadata,
        };
      }
      if (!input.sourceSnapshot) {
        return {
          status: "pending",
          kind: "takosumi.release-commands@v1",
          message:
            "post-apply release commands require a source snapshot archive",
        };
      }
      const result = await runner.release!({
        runId: releaseCommandRunId(input.applyRun.id),
        commands: input.commands,
        sourceSnapshot: input.sourceSnapshot,
        nonSensitiveOutputs: input.nonSensitiveOutputs,
        ...(input.credentials ? { credentials: input.credentials } : {}),
        applyRunId: input.applyRun.id,
        installationId: input.installation.id,
        deploymentId: input.deployment.id,
      });
      const metadata: Readonly<Record<string, JsonValue>> = {
        releaseRunId: result.runId,
        commandCount: result.commandCount,
      };
      return {
        status: "succeeded",
        kind: "takosumi.release-commands@v1",
        message: `ran ${result.commandCount} post-apply release command(s)`,
        metadata,
      };
    },
  };
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

function releaseActivationWebhookPayload(input: ReleaseActivationInput) {
  const credentialEnv = releaseActivationCredentialEnv(input.credentials);
  return {
    kind: RELEASE_ACTIVATOR_KIND,
    planRunId: input.planRun.id,
    applyRunId: input.applyRun.id,
    spaceId: input.applyRun.spaceId,
    installation: {
      id: input.installation.id,
      name: input.installation.name,
      environment: input.installation.environment,
      sourceId: input.installation.sourceId,
      installConfigId: input.installation.installConfigId,
    },
    deployment: {
      id: input.deployment.id,
      sourceSnapshotId: input.deployment.sourceSnapshotId,
      stateGeneration: input.deployment.stateGeneration,
      outputSnapshotId: input.deployment.outputSnapshotId,
      status: input.deployment.status,
    },
    outputSnapshot: {
      id: input.outputSnapshot.id,
      stateGeneration: input.outputSnapshot.stateGeneration,
      outputDigest: input.outputSnapshot.outputDigest,
    },
    ...(credentialEnv ? { credentials: { env: credentialEnv } } : {}),
    ...(input.sourceSnapshot
      ? {
          sourceSnapshot: {
            id: input.sourceSnapshot.id,
            origin: input.sourceSnapshot.origin,
            archiveObjectKey: input.sourceSnapshot.archiveObjectKey,
            archiveDigest: input.sourceSnapshot.archiveDigest,
            resolvedCommit: input.sourceSnapshot.resolvedCommit,
            path: input.sourceSnapshot.path,
          },
        }
      : {}),
    nonSensitiveOutputs: input.nonSensitiveOutputs,
    commands: input.commands,
  };
}

function releaseActivationCredentialEnv(
  credentials: ReleaseActivationInput["credentials"] | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!credentials) return undefined;
  const env =
    "env" in credentials && credentials.env && typeof credentials.env === "object"
      ? credentials.env
      : credentials;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

function redactFailureDetail(value: string): string {
  return value
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
      ? { message: stringField(value, "message") }
      : {}),
    ...(stringField(value, "launchUrl")
      ? { launchUrl: stringField(value, "launchUrl") }
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
}): Promise<ReleaseActivationResult> {
  const deadline = Date.now() + input.timeoutMs;
  const fetcher = input.fetcher;
  while (Date.now() <= deadline) {
    await sleep(input.pollIntervalMs);
    const response = await fetcher(
      input.job.statusUrl ?? statusUrlForJob(input.endpoint, input.job.jobId),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.token}`,
        },
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
