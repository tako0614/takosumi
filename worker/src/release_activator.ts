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
  const fetcher = options.fetcher ?? fetch;
  return {
    async activate(input) {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(releaseActivationWebhookPayload(input)),
      });
      if (!response.ok) {
        throw new Error(`release activator request failed: ${response.status}`);
      }
      if (response.status === 204) {
        return { status: "succeeded" };
      }
      return parseReleaseActivatorResponse(await response.json());
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

function releaseActivatorInsecureAllowed(
  env: CloudflareWorkerEnv,
  runtimeEnv: Record<string, string | undefined>,
): boolean {
  return (
    env.LOCAL_SUBSTRATE_TEST_BED === "1" || runtimeEnv.TAKOSUMI_DEV_MODE === "1"
  );
}

function releaseActivationWebhookPayload(input: ReleaseActivationInput) {
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

function releaseCommandRunId(applyRunId: string): string {
  return `release_${applyRunId.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
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
