#!/usr/bin/env bun
/**
 * Takosumi control-plane Layer-2 smoke.
 *
 * This proves the product control-plane loop, not only the raw provider/module:
 * signed-in Account session -> Workspace ProviderConnection -> Git Source/Capsule ->
 * plan/apply -> Run / StateVersion / Output ledger ->
 * Cloudflare verification -> destroy-plan/approval/destroy-apply.
 *
 * Secret values are read only from the operator environment or files and are
 * never printed in the result.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalProviderSource } from "../contract/provider-env-rules.ts";

export const PLATFORM_CONTROL_PLANE_SMOKE_KIND =
  "takosumi.platform-control-plane-smoke@v2" as const;

const TAKOSUMI_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CAPSULE_DIR = resolve(
  TAKOSUMI_ROOT,
  "providers/cloudflare/modules/cloudflare-hello-worker/module",
);
const DEFAULT_PROVIDERLESS_CAPSULE_DIR = resolve(
  TAKOSUMI_ROOT,
  "examples/opentofu-basic",
);
const DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID = "opentofu-default";
const DEFAULT_DEPLOY_TIMEOUT_SECONDS = 300;
const API_PREFIX = "/api/v1";
const NODE_HTTP_TRANSPORT_SCRIPT = String.raw`
const chunks = [];
function finish(payload) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const headers = { ...(input.headers ?? {}) };
    const token = process.env.TAKOSUMI_SMOKE_HTTP_TOKEN;
    if (token) headers.authorization = "Bearer " + token;
    const controller =
      typeof input.timeoutMs === "number" && input.timeoutMs > 0
        ? new AbortController()
        : undefined;
    const timeout =
      controller !== undefined
        ? setTimeout(() => controller.abort(), input.timeoutMs)
        : undefined;
    const init = {
      method: input.method,
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    };
    if (typeof input.binaryBase64 === "string") {
      init.body = Buffer.from(input.binaryBase64, "base64");
    } else if (typeof input.bodyText === "string") {
      init.body = input.bodyText;
    }
    try {
      const response = await fetch(input.url, init);
      const bodyText = await response.text();
      finish({
        ok: true,
        status: response.status,
        bodyText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof Error ? error.name : "Error";
      finish({
        ok: false,
        name,
        message,
        timeout:
          controller?.signal.aborted === true ||
          name === "AbortError" ||
          name === "TimeoutError",
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } catch (error) {
    finish({
      ok: false,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      timeout: false,
    });
  }
});
`;
const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "waiting_approval",
]);
type SmokeCheckStatus = "passed" | "denied" | "not_reached";
type SmokeVerificationMode = "cloudflare-worker" | "opentofu";
type SmokeProviderConnectionMode = "guided" | "generic-env" | "none";
type SmokeAuthTokenKind = "session" | "pat";
type CloudflareResourcePreflightMode = "none" | "d1" | "account-resources";
type ReleaseActivationRequirement = "any" | "pending" | "succeeded" | "failed";
type SecretInputSource = "env" | "file" | "not_required";
type NonSecretInputSource = "env" | "file" | "arg" | "not_required";
type JsonSmokeValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonSmokeValue[]
  | { readonly [key: string]: JsonSmokeValue };
type SmokeOutputAllowlistType =
  "string" | "url" | "hostname" | "number" | "boolean" | "json";
type SmokeOutputAllowlist = Readonly<
  Record<
    string,
    {
      readonly from: string;
      readonly type: SmokeOutputAllowlistType;
      readonly required?: boolean;
    }
  >
>;
type PublicUrlCheck = {
  readonly name: string;
  readonly output: string;
  readonly path: string;
  readonly expectedStatus: number;
  readonly bodyIncludes: readonly string[];
};
type PublicUrlCheckResult = {
  readonly name: string;
  readonly output: string;
  readonly url: string;
  readonly status: number;
  readonly ok: true;
  readonly bodyIncludes: readonly string[];
  readonly bodyDigest: string;
};
type CapsuleFunctionalProbeResult = {
  readonly kind: "takosumi.capsule-functional-probe@v1";
  readonly status: "passed";
  readonly product: string;
  readonly checks: readonly {
    readonly name: string;
    readonly status: "passed";
  }[];
  readonly cleanupVerified?: boolean;
  readonly cleanupDelegatedToDestroy?: boolean;
};
type CapsuleFunctionalProbeEvidence = {
  readonly product: string;
  readonly checkNames: readonly string[];
  readonly cleanupVerified: boolean;
  readonly cleanupMode: "probe" | "opentofu-destroy";
  readonly resultDigest: string;
  readonly scriptDigest: string;
  readonly durationMs: number;
};
type SmokeStepTiming = {
  readonly step: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
};
type SmokeRunTiming = {
  readonly name: string;
  readonly runId: string;
  readonly type: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly queueMs?: number;
  readonly executionMs?: number;
  readonly totalMs?: number;
};

export interface PlatformControlPlaneSmokeOptions {
  readonly url: string;
  readonly accountSessionToken: string;
  readonly accountSessionTokenSource: "env" | "file";
  readonly accountAuthTokenKind: SmokeAuthTokenKind;
  readonly cloudflareApiToken: string;
  readonly cloudflareApiTokenSource: SecretInputSource;
  readonly cloudflareAccountId: string;
  readonly cloudflareAccountIdSource: NonSecretInputSource;
  readonly cloudflareWorkersSubdomain: string;
  readonly cloudflareWorkersSubdomainSource: NonSecretInputSource;
  readonly cloudflareConnectionMode: SmokeProviderConnectionMode;
  readonly cloudflareResourcePreflight: CloudflareResourcePreflightMode;
  readonly runnerProfileId?: string;
  readonly workspace: string;
  readonly appName: string;
  readonly environment: string;
  readonly sourceMode: "git";
  readonly capsuleDir: string;
  readonly verificationMode: SmokeVerificationMode;
  readonly vars: Readonly<Record<string, JsonSmokeValue>>;
  readonly outputAllowlist: SmokeOutputAllowlist;
  readonly publicUrlChecks: readonly PublicUrlCheck[];
  readonly cloudflareWorkerNameOutput?: string;
  readonly runtimePublicUrlOutput?: string;
  readonly functionalProbeScript?: string;
  readonly functionalProbeScriptDigest?: string;
  readonly functionalProbeEnvNames: readonly string[];
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
  readonly modulePath?: string;
  readonly installConfigId?: string;
  readonly storeMetadata?: Readonly<Record<string, JsonSmokeValue>>;
  readonly sourceName?: string;
  readonly timeoutSeconds: number;
  readonly deployTimeoutSeconds: number;
  readonly pollIntervalMs: number;
  readonly dryRun: boolean;
  readonly noDefaultVars: boolean;
  readonly json: boolean;
  readonly outFile?: string;
  readonly requireReleaseActivation?: ReleaseActivationRequirement;
  readonly keepConnection: boolean;
  readonly ensureWorkspace: boolean;
  readonly backupRestoreRehearsal: boolean;
  readonly workspaceDisplayName?: string;
}

export interface PlatformControlPlaneSmokeResult {
  readonly kind: typeof PLATFORM_CONTROL_PLANE_SMOKE_KIND;
  readonly status: "passed" | "dry_run" | "failed";
  readonly generatedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly serviceUrl: string;
  readonly scratchWorkspaceId: string;
  readonly capsuleModule: string;
  readonly verificationMode: SmokeVerificationMode;
  readonly credentialPath: "workspace_scoped_provider_connection" | "none";
  readonly providerConnectionMode: SmokeProviderConnectionMode;
  /** Required end-to-end checkpoints for this smoke shape. */
  readonly steps: readonly string[];
  /** Checkpoints that were actually completed before the result was written. */
  readonly completedSteps: readonly string[];
  /** Per-checkpoint wall-clock timings for deploy-speed regressions. */
  readonly stepTimings: readonly SmokeStepTiming[];
  /** Run-ledger timings split queue latency from OpenTofu execution time. */
  readonly runTimings: readonly SmokeRunTiming[];
  readonly appName: string;
  readonly environment: string;
  readonly connectionId?: string;
  readonly providerConnectionId?: string;
  readonly sourceId?: string;
  readonly sourceSyncRunId?: string;
  readonly sourceSnapshotId?: string;
  readonly installConfigId?: string;
  readonly compatibilityReportId?: string;
  readonly capsuleId?: string;
  readonly planRunId?: string;
  readonly applyRunId?: string;
  readonly destroyPlanRunId?: string;
  readonly destroyApplyRunId?: string;
  readonly backupRestoreRehearsal?: BackupRestoreRehearsalResult;
  readonly stateVersionLedger?: StateVersionLedgerVerificationResult;
  readonly releaseActivation?: ReleaseActivationVerificationResult;
  readonly cloudflareResourcePreflight?: CloudflareResourcePreflightResult;
  readonly publicUrlChecks?: readonly PublicUrlCheckResult[];
  readonly functionalProbe?: CapsuleFunctionalProbeEvidence;
  readonly capsuleGateStatus: SmokeCheckStatus;
  readonly policyStatus: SmokeCheckStatus;
  readonly workerUrl: string;
  readonly opentofuApplyVerified: boolean;
  readonly runtimeVerified: boolean;
  readonly publicUrlVerified: boolean;
  readonly stateVersionLedgerVerified: boolean;
  readonly destroyVerified: boolean;
  readonly connectionRevoked?: boolean;
  readonly timedOutRunId?: string;
  readonly runCancellationStatus?: "cancelled" | "already_terminal" | "failed";
  readonly runCancellationError?: string;
  readonly connectionRevokeSkippedReason?: string;
  readonly failureCleanup?: FailureCleanupResult;
  readonly error?: string;
  readonly nextAction?: string;
  readonly inputs: {
    readonly accountSessionTokenSource: "env" | "file";
    readonly accountAuthTokenKind: SmokeAuthTokenKind;
    readonly cloudflareApiTokenSource: SecretInputSource;
    readonly cloudflareAccountIdSource: NonSecretInputSource;
    readonly cloudflareAccountIdDigest: string;
    readonly cloudflareWorkersSubdomainSource: NonSecretInputSource;
    readonly cloudflareConnectionMode: SmokeProviderConnectionMode;
    readonly cloudflareResourcePreflight: CloudflareResourcePreflightMode;
    readonly runnerProfileId?: string;
    readonly sourceMode: "git";
    readonly verificationMode: SmokeVerificationMode;
    readonly varsDigest: string;
    readonly outputAllowlistNames: readonly string[];
    readonly publicUrlCheckNames: readonly string[];
    readonly cloudflareWorkerNameOutput?: string;
    readonly runtimePublicUrlOutput?: string;
    readonly functionalProbeScriptDigest?: string;
    readonly functionalProbeEnvNames: readonly string[];
    readonly capsuleDir?: string;
    readonly sourceGitUrlDigest?: string;
    readonly sourceRef?: string;
    readonly sourcePath?: string;
    readonly modulePath?: string;
    readonly installConfigId?: string;
    readonly storeMetadataDigest?: string;
  };
}

interface CliArgs {
  readonly help?: boolean;
  readonly selfTest?: boolean;
  readonly dryRun?: boolean;
  readonly noDefaultVars?: boolean;
  readonly json?: boolean;
  readonly outFile?: string;
  readonly keepConnection?: boolean;
  readonly ensureWorkspace?: boolean;
  readonly backupRestoreRehearsal?: boolean;
  readonly url?: string;
  readonly sessionTokenFile?: string;
  readonly patTokenFile?: string;
  readonly authTokenKind?: string;
  readonly cloudflareApiTokenFile?: string;
  readonly cloudflareAccountId?: string;
  readonly cloudflareAccountIdFile?: string;
  readonly cloudflareWorkersSubdomain?: string;
  readonly cloudflareWorkersSubdomainFile?: string;
  readonly cloudflareConnectionMode?: string;
  readonly cloudflareResourcePreflight?: string;
  readonly runnerProfileId?: string;
  readonly workspace?: string;
  readonly workspaceDisplayName?: string;
  readonly appName?: string;
  readonly environment?: string;
  readonly capsuleDir?: string;
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
  readonly modulePath?: string;
  readonly installConfigId?: string;
  readonly storeMetadataJson?: string;
  readonly storeMetadataJsonFile?: string;
  readonly sourceName?: string;
  readonly verificationMode?: string;
  readonly varsJson?: string;
  readonly varsJsonFile?: string;
  readonly outputAllowlistJson?: string;
  readonly outputAllowlistJsonFile?: string;
  readonly publicUrlChecksJson?: string;
  readonly publicUrlChecksJsonFile?: string;
  readonly cloudflareWorkerNameOutput?: string;
  readonly runtimePublicUrlOutput?: string;
  readonly functionalProbeScript?: string;
  readonly functionalProbeEnv?: string;
  readonly timeoutSeconds?: string;
  readonly deployTimeoutSeconds?: string;
  readonly pollIntervalMs?: string;
  readonly requireReleaseActivation?: string;
}

interface RequestOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly binary?: Uint8Array;
  readonly allowEmpty?: boolean;
  readonly timeoutMs?: number;
  readonly transport?: "native" | "node";
}

interface NodeHttpTransportInput {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText?: string;
  readonly binaryBase64?: string;
  readonly timeoutMs?: number;
}

interface NodeHttpTransportResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly bodyText?: string;
  readonly name?: string;
  readonly message?: string;
  readonly timeout?: boolean;
}

class RequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${path} did not return within ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

class RunPollTimeoutError extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} did not reach a terminal state`);
    this.name = "RunPollTimeoutError";
  }
}

class CloudflareResourcePreflightError extends Error {
  constructor(
    readonly reason: "request_failed" | "capability_denied",
    message: string,
  ) {
    super(message);
    this.name = "CloudflareResourcePreflightError";
  }
}

interface RunRecord {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly sourceSnapshotId?: string;
  readonly policyStatus?: string;
  readonly backupId?: string;
  readonly restoreStateGeneration?: number;
  readonly restoredStateVersionId?: string;
  readonly restoredFromStateVersionId?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

interface DeployResponse {
  readonly capsule: { readonly id: string; readonly name?: string };
  readonly run: RunRecord;
  readonly planRun?: RunRecord;
  readonly applyRun?: RunRecord;
  readonly created?: boolean;
}

export interface InstallConfigRecord {
  readonly id?: string;
  readonly name?: string;
  readonly workspaceId?: string;
  readonly internal?: { readonly reason?: string };
}

export interface SmokeProviderConnectionListEntry {
  readonly id?: string;
  readonly providerSource?: string;
  readonly displayName?: string;
}

interface CapsuleLedgerRecord {
  readonly id?: string;
  readonly name?: string;
  readonly workspaceId?: string;
  readonly status?: string;
  readonly currentStateVersionId?: string;
  readonly currentStateGeneration?: number;
}

interface CapsuleLedgerResponse {
  readonly capsule?: CapsuleLedgerRecord;
}

interface BackupRecord {
  readonly id: string;
  readonly digest: string;
  readonly createdByRunId?: string;
  readonly createdAt: string;
}

interface StateVersionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly createdByRunId: string;
  readonly generation: number;
  readonly createdAt: string;
}

interface OutputRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly stateGeneration: number;
  readonly publicOutputs: Readonly<Record<string, unknown>>;
  readonly outputDigest: string;
  readonly createdAt: string;
}

interface StateVersionLedgerVerificationResult {
  readonly capsuleStatus: string;
  readonly stateVersionId: string;
  readonly generation: number;
  readonly applyRunId: string;
  readonly publicOutputNames: readonly string[];
  readonly publicOutputDigest: string;
  readonly publicOutputs?: Readonly<Record<string, unknown>>;
}

interface ReleaseActivationVerificationResult {
  readonly eventId: string;
  readonly action: string;
  readonly status: Exclude<ReleaseActivationStatus, "skipped">;
  readonly targetId: string;
  readonly runId: string;
  readonly activationKind?: string;
  readonly commandCount?: number;
  readonly outputCount?: number;
  readonly metadataKeys: readonly string[];
}

interface CloudflareResourcePreflightResult {
  readonly mode: CloudflareResourcePreflightMode;
  readonly status: "passed";
  readonly checks: readonly string[];
}

const CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS = [
  {
    id: "cloudflare.d1.database.list",
    label: "D1 databases",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=1`,
  },
  {
    id: "cloudflare.kv.namespace.list",
    label: "KV namespaces",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?per_page=1`,
  },
  {
    id: "cloudflare.r2.bucket.list",
    label: "R2 buckets",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets?per_page=1`,
  },
  {
    id: "cloudflare.queue.list",
    label: "Queues",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/queues?per_page=1`,
  },
  {
    id: "cloudflare.workflow.list",
    label: "Workflows",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/workflows?per_page=1`,
  },
  {
    id: "cloudflare.vectorize.index.list",
    label: "Vectorize indexes",
    path: (accountId: string): string =>
      `/client/v4/accounts/${encodeURIComponent(accountId)}/vectorize/v2/indexes?per_page=1`,
  },
] as const;

interface BackupRestoreRehearsalResult {
  readonly backupId: string;
  readonly backupRunId?: string;
  readonly backupDigest: string;
  readonly backupCreatedAt: string;
  readonly stateGeneration: number;
  readonly stateVersionId: string;
  readonly restoreRunId: string;
  readonly restoredFromStateVersionId?: string;
  readonly restoredStateVersionId?: string;
  readonly restoreCreatedAt?: string;
  readonly restoreStartedAt?: string;
  readonly restoreFinishedAt?: string;
  readonly restoreTargetSmoke: "passed";
}

interface FailureCleanupResult {
  readonly attempted: true;
  readonly cloudflareWorkerGone: boolean;
  readonly capsuleMarkedError: boolean;
  readonly destroyAttempted?: boolean;
  readonly destroyPlanRunId?: string;
  readonly destroyApplyRunId?: string;
  readonly destroySucceeded?: boolean;
  readonly destroyError?: string;
  readonly error?: string;
}

interface ActivityEventRecord {
  readonly id?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly runId?: string;
  readonly metadata?: Record<string, unknown>;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(exitCode);
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.selfTest) {
    await runSelfTest();
    return 0;
  }

  const options = await resolveOptions(args, process.env);
  if (options.dryRun) {
    const result = dryRunResult(options);
    await writeResult(result, options);
    return 0;
  }

  const result = await runPlatformControlPlaneSmoke(options);
  await writeResult(result, options);
  return result.status === "failed" ? 1 : 0;
}

export async function resolveOptions(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): Promise<PlatformControlPlaneSmokeOptions> {
  const url = args.url ?? env.TAKOSUMI_PLATFORM_URL;
  if (!url) {
    throw new Error("--url or TAKOSUMI_PLATFORM_URL is required");
  }
  const workspace = args.workspace ?? env.TAKOSUMI_SMOKE_WORKSPACE;
  if (!workspace) {
    throw new Error("--workspace or TAKOSUMI_SMOKE_WORKSPACE is required");
  }
  const cloudflareConnectionMode = parseCloudflareConnectionMode(
    args.cloudflareConnectionMode ??
      env.TAKOSUMI_SMOKE_CLOUDFLARE_CONNECTION_MODE,
  );
  const verificationMode = parseVerificationMode(
    args.verificationMode ?? env.TAKOSUMI_SMOKE_VERIFICATION_MODE,
  );
  const cloudflareResourcePreflight = parseCloudflareResourcePreflight(
    args.cloudflareResourcePreflight ??
      env.TAKOSUMI_SMOKE_CLOUDFLARE_RESOURCE_PREFLIGHT,
  );
  if (
    cloudflareConnectionMode === "none" &&
    verificationMode === "cloudflare-worker"
  ) {
    throw new Error(
      "--cloudflare-connection-mode none requires --verification-mode opentofu",
    );
  }
  const cloudflareInputsRequired =
    cloudflareConnectionMode !== "none" ||
    verificationMode === "cloudflare-worker" ||
    cloudflareResourcePreflight !== "none";
  const providerlessOpenTofuSmoke =
    cloudflareConnectionMode === "none" && verificationMode === "opentofu";
  const cloudflareAccountId = cloudflareInputsRequired
    ? await readNonSecretInput({
        file: args.cloudflareAccountIdFile ?? env.CLOUDFLARE_ACCOUNT_ID_FILE,
        value: args.cloudflareAccountId,
        envValue: env.CLOUDFLARE_ACCOUNT_ID,
        envName: "CLOUDFLARE_ACCOUNT_ID",
        label: "Cloudflare account id",
        dryRun: args.dryRun === true,
        hint: "pass --cloudflare-account-id-file, --cloudflare-account-id, or set CLOUDFLARE_ACCOUNT_ID",
      })
    : ({ value: "", source: "not_required" } as const);
  const cloudflareWorkersSubdomain = cloudflareInputsRequired
    ? await readNonSecretInput({
        file:
          args.cloudflareWorkersSubdomainFile ??
          env.CLOUDFLARE_WORKERS_SUBDOMAIN_FILE,
        value: args.cloudflareWorkersSubdomain,
        envValue: env.CLOUDFLARE_WORKERS_SUBDOMAIN,
        envName: "CLOUDFLARE_WORKERS_SUBDOMAIN",
        label: "Cloudflare Workers subdomain",
        dryRun: args.dryRun === true,
        hint: "pass --cloudflare-workers-subdomain-file, --cloudflare-workers-subdomain, or set CLOUDFLARE_WORKERS_SUBDOMAIN",
      })
    : ({ value: "", source: "not_required" } as const);
  const patTokenFile = args.patTokenFile ?? env.TAKOSUMI_ACCOUNT_PAT_TOKEN_FILE;
  const patTokenValue = env.TAKOSUMI_ACCOUNT_PAT_TOKEN;
  const accountAuthTokenKind = parseAuthTokenKind(
    args.authTokenKind ??
      env.TAKOSUMI_ACCOUNT_AUTH_TOKEN_KIND ??
      (patTokenFile || patTokenValue ? "pat" : "session"),
  );
  const accountSessionToken = await readSecret({
    file:
      patTokenFile ??
      args.sessionTokenFile ??
      env.TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE,
    envValue: patTokenValue ?? env.TAKOSUMI_ACCOUNT_SESSION_TOKEN,
    envName: "TAKOSUMI_ACCOUNT_PAT_TOKEN or TAKOSUMI_ACCOUNT_SESSION_TOKEN",
    label:
      accountAuthTokenKind === "pat"
        ? "account personal access token"
        : "account session token",
    dryRun: args.dryRun === true,
  });
  const cloudflareApiToken = cloudflareInputsRequired
    ? await readSecret({
        file: args.cloudflareApiTokenFile ?? env.CLOUDFLARE_API_TOKEN_FILE,
        envValue: env.CLOUDFLARE_API_TOKEN,
        envName: "CLOUDFLARE_API_TOKEN",
        label: "Cloudflare API token",
        dryRun: args.dryRun === true,
      })
    : ({ value: "", source: "not_required" } as const);
  const rawSourceGitUrl =
    args.sourceGitUrl ??
    env.TAKOSUMI_SMOKE_SOURCE_GIT_URL ??
    (args.dryRun === true
      ? "https://git.example.test/example/smoke-fixture.git"
      : undefined);
  if (!rawSourceGitUrl) {
    throw new Error(
      "--source-git-url is required. Platform smoke uses Git URL Source/Capsule; public upload deploy is retired.",
    );
  }
  const sourceGitUrl =
    rawSourceGitUrl !== undefined
      ? normalizeSmokeSourceGitUrl(rawSourceGitUrl)
      : undefined;
  const sourceRef = args.sourceRef ?? env.TAKOSUMI_SMOKE_SOURCE_REF;
  const sourcePath = args.sourcePath ?? env.TAKOSUMI_SMOKE_SOURCE_PATH ?? ".";
  const modulePath = args.modulePath ?? env.TAKOSUMI_SMOKE_MODULE_PATH;
  const installConfigId =
    args.installConfigId ?? env.TAKOSUMI_SMOKE_INSTALL_CONFIG_ID;
  const storeMetadata = await readJsonRecordInput({
    inline: args.storeMetadataJson ?? env.TAKOSUMI_SMOKE_STORE_METADATA_JSON,
    file:
      args.storeMetadataJsonFile ?? env.TAKOSUMI_SMOKE_STORE_METADATA_JSON_FILE,
    label: "store metadata",
    fallback: {},
  });
  const sourceName =
    args.sourceName ?? env.TAKOSUMI_SMOKE_SOURCE_NAME ?? undefined;
  const sourceMode = "git" as const;
  const capsuleDir = resolve(
    args.capsuleDir ??
      (providerlessOpenTofuSmoke
        ? DEFAULT_PROVIDERLESS_CAPSULE_DIR
        : DEFAULT_CAPSULE_DIR),
  );
  const resolvedAppName = args.appName ?? defaultCapsuleName();
  const explicitVars = await readJsonRecordInput({
    inline: args.varsJson ?? env.TAKOSUMI_SMOKE_VARS_JSON,
    file: args.varsJsonFile ?? env.TAKOSUMI_SMOKE_VARS_JSON_FILE,
    label: "vars",
    fallback: {},
  });
  const defaultVars =
    args.noDefaultVars === true ||
    (providerlessOpenTofuSmoke && Object.keys(explicitVars).length > 0)
      ? {}
      : defaultSmokeVars({
          accountId: cloudflareAccountId.value,
          appName: resolvedAppName,
          workersSubdomain: cloudflareWorkersSubdomain.value,
          providerless: providerlessOpenTofuSmoke,
        });
  const vars = mergeJsonRecords(defaultVars, explicitVars);
  const outputAllowlist = parseOutputAllowlist(
    await readJsonRecordInput({
      inline:
        args.outputAllowlistJson ?? env.TAKOSUMI_SMOKE_OUTPUT_ALLOWLIST_JSON,
      file:
        args.outputAllowlistJsonFile ??
        env.TAKOSUMI_SMOKE_OUTPUT_ALLOWLIST_JSON_FILE,
      label: "output allowlist",
      fallback: defaultSmokeOutputAllowlist(providerlessOpenTofuSmoke),
    }),
  );
  const publicUrlChecks = parsePublicUrlChecks(
    await readJsonValueInput({
      inline:
        args.publicUrlChecksJson ?? env.TAKOSUMI_SMOKE_PUBLIC_URL_CHECKS_JSON,
      file:
        args.publicUrlChecksJsonFile ??
        env.TAKOSUMI_SMOKE_PUBLIC_URL_CHECKS_JSON_FILE,
      label: "public URL checks",
      fallback: [],
    }),
    outputAllowlist,
  );
  const cloudflareWorkerNameOutput = parseExplicitProjectedOutputName({
    raw:
      args.cloudflareWorkerNameOutput ??
      env.TAKOSUMI_SMOKE_CLOUDFLARE_WORKER_NAME_OUTPUT,
    label: "--cloudflare-worker-name-output",
    outputAllowlist,
    acceptedTypes: ["string"],
  });
  const runtimePublicUrlOutput = parseExplicitProjectedOutputName({
    raw:
      args.runtimePublicUrlOutput ??
      env.TAKOSUMI_SMOKE_RUNTIME_PUBLIC_URL_OUTPUT,
    label: "--runtime-public-url-output",
    outputAllowlist,
    acceptedTypes: ["url"],
  });
  const functionalProbeScriptInput =
    args.functionalProbeScript ?? env.TAKOSUMI_SMOKE_FUNCTIONAL_PROBE_SCRIPT;
  const functionalProbeScript = functionalProbeScriptInput
    ? resolve(functionalProbeScriptInput)
    : undefined;
  const functionalProbeScriptDigest = functionalProbeScript
    ? sha256(await readFile(functionalProbeScript, "utf8"))
    : undefined;
  const functionalProbeEnvNames = parseFunctionalProbeEnvNames(
    args.functionalProbeEnv ?? env.TAKOSUMI_SMOKE_FUNCTIONAL_PROBE_ENV,
  );
  if (functionalProbeEnvNames.length > 0 && !functionalProbeScript) {
    throw new Error(
      "--functional-probe-env requires --functional-probe-script",
    );
  }
  if (!args.dryRun) {
    for (const name of functionalProbeEnvNames) {
      if (!env[name]) {
        throw new Error(
          `functional probe environment variable ${name} is not set`,
        );
      }
    }
  }
  const appName = resolvedAppName;
  const explicitRunnerProfileId =
    args.runnerProfileId ?? env.TAKOSUMI_SMOKE_RUNNER_PROFILE_ID;
  const runnerProfileId =
    explicitRunnerProfileId ??
    (providerlessOpenTofuSmoke
      ? DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID
      : undefined);
  const requireReleaseActivation = parseReleaseActivationRequirement(
    args.requireReleaseActivation ??
      env.TAKOSUMI_SMOKE_REQUIRE_RELEASE_ACTIVATION,
  );
  return {
    url: normalizeBaseUrl(url),
    accountSessionToken: accountSessionToken.value,
    accountSessionTokenSource: accountSessionToken.source,
    accountAuthTokenKind,
    cloudflareApiToken: cloudflareApiToken.value,
    cloudflareApiTokenSource: cloudflareApiToken.source,
    cloudflareAccountId: cloudflareAccountId.value,
    cloudflareAccountIdSource: cloudflareAccountId.source,
    cloudflareWorkersSubdomain: cloudflareWorkersSubdomain.value,
    cloudflareWorkersSubdomainSource: cloudflareWorkersSubdomain.source,
    cloudflareConnectionMode,
    cloudflareResourcePreflight,
    ...(runnerProfileId ? { runnerProfileId } : {}),
    workspace,
    appName,
    environment: args.environment?.trim() || "smoke",
    sourceMode,
    capsuleDir,
    verificationMode,
    vars,
    outputAllowlist,
    publicUrlChecks,
    ...(cloudflareWorkerNameOutput ? { cloudflareWorkerNameOutput } : {}),
    ...(runtimePublicUrlOutput ? { runtimePublicUrlOutput } : {}),
    ...(functionalProbeScript ? { functionalProbeScript } : {}),
    ...(functionalProbeScriptDigest ? { functionalProbeScriptDigest } : {}),
    functionalProbeEnvNames,
    ...(sourceGitUrl ? { sourceGitUrl } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(sourceGitUrl ? { sourcePath } : {}),
    ...(modulePath ? { modulePath } : {}),
    ...(installConfigId ? { installConfigId } : {}),
    ...(Object.keys(storeMetadata).length > 0 ? { storeMetadata } : {}),
    ...(sourceGitUrl && sourceName ? { sourceName } : {}),
    timeoutSeconds: parsePositiveInteger(
      args.timeoutSeconds,
      "--timeout-seconds",
      600,
    ),
    deployTimeoutSeconds: parsePositiveInteger(
      args.deployTimeoutSeconds,
      "--deploy-timeout-seconds",
      DEFAULT_DEPLOY_TIMEOUT_SECONDS,
    ),
    pollIntervalMs: parsePositiveInteger(
      args.pollIntervalMs,
      "--poll-interval-ms",
      2_000,
    ),
    dryRun: args.dryRun === true,
    noDefaultVars: args.noDefaultVars === true,
    json: args.json === true,
    ...(args.outFile ? { outFile: resolve(args.outFile) } : {}),
    ...(requireReleaseActivation ? { requireReleaseActivation } : {}),
    keepConnection: args.keepConnection === true,
    ensureWorkspace: args.ensureWorkspace === true,
    backupRestoreRehearsal: args.backupRestoreRehearsal === true,
    ...(args.workspaceDisplayName
      ? { workspaceDisplayName: args.workspaceDisplayName }
      : {}),
  };
}

export function dryRunResult(
  options: PlatformControlPlaneSmokeOptions,
): PlatformControlPlaneSmokeResult {
  const generatedAt = new Date().toISOString();
  const steps = requiredSteps(options);
  return {
    kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
    status: "dry_run",
    generatedAt,
    startedAt: generatedAt,
    finishedAt: generatedAt,
    durationMs: 0,
    serviceUrl: options.url,
    scratchWorkspaceId: options.workspace,
    capsuleModule: capsuleLabel(options),
    verificationMode: options.verificationMode,
    credentialPath:
      options.cloudflareConnectionMode === "none"
        ? "none"
        : "workspace_scoped_provider_connection",
    providerConnectionMode: options.cloudflareConnectionMode,
    sourceMode: options.sourceMode,
    steps,
    completedSteps: steps,
    stepTimings: steps.map((step) => ({
      step,
      startedAt: generatedAt,
      finishedAt: generatedAt,
      durationMs: 0,
    })),
    runTimings: dryRunRunTimings(generatedAt),
    appName: options.appName,
    environment: options.environment,
    ...(options.backupRestoreRehearsal
      ? {
          backupRestoreRehearsal: {
            backupId: "bkp_dry_run",
            backupRunId: "backup_dry_run",
            backupDigest: `sha256:${"0".repeat(64)}`,
            backupCreatedAt: new Date(0).toISOString(),
            stateGeneration: 1,
            stateVersionId: "state_dry_run",
            restoreRunId: "restore_dry_run",
            restoreTargetSmoke: "passed",
          },
        }
      : {}),
    capsuleGateStatus: "passed",
    policyStatus: "passed",
    workerUrl: shouldVerifyCloudflareWorker(options)
      ? publicWorkerUrl(options)
      : "",
    opentofuApplyVerified: options.verificationMode === "opentofu",
    runtimeVerified: shouldVerifyCloudflareWorker(options),
    publicUrlVerified:
      options.verificationMode === "cloudflare-worker" ||
      options.publicUrlChecks.length > 0,
    stateVersionLedgerVerified: true,
    destroyVerified: true,
    ...(options.cloudflareResourcePreflight !== "none"
      ? {
          cloudflareResourcePreflight: {
            mode: options.cloudflareResourcePreflight,
            status: "passed",
            checks: cloudflareResourcePreflightChecks(
              options.cloudflareResourcePreflight,
            ),
          },
        }
      : {}),
    connectionRevoked:
      options.keepConnection || options.cloudflareConnectionMode === "none"
        ? undefined
        : true,
    stateVersionLedger: {
      capsuleStatus: "active",
      stateVersionId: "state_dry_run",
      generation: 1,
      applyRunId: "apply_dry_run",
      publicOutputNames: Object.keys(options.outputAllowlist).sort(),
      publicOutputDigest: `sha256:${"0".repeat(64)}`,
    },
    ...(options.publicUrlChecks.length > 0
      ? {
          publicUrlChecks: options.publicUrlChecks.map((check) => ({
            name: check.name,
            output: check.output,
            url: dryRunPublicUrl(check),
            status: check.expectedStatus,
            ok: true as const,
            bodyIncludes: check.bodyIncludes,
            bodyDigest: `sha256:${"0".repeat(64)}`,
          })),
        }
      : {}),
    ...(options.functionalProbeScript
      ? {
          functionalProbe: {
            product: options.appName,
            checkNames: ["dry-run"],
            cleanupVerified: true,
            cleanupMode: "probe" as const,
            resultDigest: `sha256:${"0".repeat(64)}`,
            scriptDigest:
              options.functionalProbeScriptDigest ?? `sha256:${"0".repeat(64)}`,
            durationMs: 0,
          },
        }
      : {}),
    ...(options.requireReleaseActivation
      ? {
          releaseActivation: {
            eventId: "evt_dry_run",
            action: `release_activation.${dryRunReleaseActivationStatus(
              options.requireReleaseActivation,
            )}`,
            status: dryRunReleaseActivationStatus(
              options.requireReleaseActivation,
            ),
            targetId: "dep_dry_run",
            runId: "apply_dry_run",
            activationKind: "takosumi.release-commands@v1",
            commandCount: 1,
            outputCount: Object.keys(options.outputAllowlist).length,
            metadataKeys: ["activationKind", "commandCount", "outputCount"],
          },
        }
      : {}),
    inputs: publicInputSummary(options),
  };
}

function dryRunRunTimings(timestamp: string): readonly SmokeRunTiming[] {
  return ["plan", "apply", "destroy_plan", "destroy_apply"].map((name) => ({
    name,
    runId: `${name}_dry_run`,
    type: name,
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    queueMs: 0,
    executionMs: 0,
    totalMs: 0,
  }));
}

function smokeRunTiming(name: string, run: RunRecord): SmokeRunTiming {
  const createdAtMs =
    typeof run.createdAt === "string" ? Date.parse(run.createdAt) : undefined;
  const startedAtMs =
    typeof run.startedAt === "string" ? Date.parse(run.startedAt) : undefined;
  const finishedAtMs =
    typeof run.finishedAt === "string" ? Date.parse(run.finishedAt) : undefined;
  return {
    name,
    runId: run.id,
    type: run.type,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(typeof createdAtMs === "number" &&
    Number.isFinite(createdAtMs) &&
    typeof startedAtMs === "number" &&
    Number.isFinite(startedAtMs)
      ? { queueMs: Math.max(0, startedAtMs - createdAtMs) }
      : {}),
    ...(typeof startedAtMs === "number" &&
    Number.isFinite(startedAtMs) &&
    typeof finishedAtMs === "number" &&
    Number.isFinite(finishedAtMs)
      ? { executionMs: Math.max(0, finishedAtMs - startedAtMs) }
      : {}),
    ...(typeof createdAtMs === "number" &&
    Number.isFinite(createdAtMs) &&
    typeof finishedAtMs === "number" &&
    Number.isFinite(finishedAtMs)
      ? { totalMs: Math.max(0, finishedAtMs - createdAtMs) }
      : {}),
  };
}

export async function runPlatformControlPlaneSmoke(
  options: PlatformControlPlaneSmokeOptions,
): Promise<PlatformControlPlaneSmokeResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const workspaceId = await resolveWorkspaceId(options);
  const completedSteps: string[] = [];
  const stepTimings: SmokeStepTiming[] = [];
  const runTimings: SmokeRunTiming[] = [];
  const stepStartedAtMs = new Map<string, number>();
  const stepStartedAt = new Map<string, string>();
  const beginStep = (step: string): void => {
    if (stepStartedAtMs.has(step)) return;
    const nowMs = Date.now();
    stepStartedAtMs.set(step, nowMs);
    stepStartedAt.set(step, new Date(nowMs).toISOString());
  };
  const completeStep = (step: string): void => {
    if (!completedSteps.includes(step)) completedSteps.push(step);
    if (stepTimings.some((timing) => timing.step === step)) return;
    const finishedAtMs = Date.now();
    const startedAtMsForStep = stepStartedAtMs.get(step) ?? finishedAtMs;
    stepTimings.push({
      step,
      startedAt:
        stepStartedAt.get(step) ?? new Date(startedAtMsForStep).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMsForStep),
    });
  };
  let connectionId: string | undefined;
  let providerConnectionId: string | undefined;
  let connectionRevoked = false;
  let sourceId: string | undefined;
  let sourceSyncRunId: string | undefined;
  let sourceSnapshotId: string | undefined;
  let installConfigId: string | undefined;
  let compatibilityReportId: string | undefined;
  let capsuleId: string | undefined;
  let planRunId: string | undefined;
  let applyRunId: string | undefined;
  let destroyPlanRunId: string | undefined;
  let destroyApplyRunId: string | undefined;
  let backupRestoreRehearsal: BackupRestoreRehearsalResult | undefined;
  let stateVersionLedger: StateVersionLedgerVerificationResult | undefined;
  let releaseActivation: ReleaseActivationVerificationResult | undefined;
  let publicUrlChecks: readonly PublicUrlCheckResult[] | undefined;
  let functionalProbe: CapsuleFunctionalProbeEvidence | undefined;
  let capsuleGateStatus: SmokeCheckStatus = "not_reached";
  let policyStatus: SmokeCheckStatus = "not_reached";
  let timedOutRunId: string | undefined;
  let runCancellationStatus:
    "cancelled" | "already_terminal" | "failed" | undefined;
  let runCancellationError: string | undefined;
  let connectionRevokeSkippedReason: string | undefined;
  let failureCleanup: FailureCleanupResult | undefined;
  let failure: unknown;
  let cloudflareResourcePreflight:
    CloudflareResourcePreflightResult | undefined;

  try {
    if (options.cloudflareConnectionMode !== "none") {
      beginStep("workspaceScopedProviderConnection");
      beginStep("connectionVerified");
      const connection = await createWorkspaceCloudflareConnection(
        options,
        workspaceId,
      );
      connectionId = connection.rawConnectionId;
      providerConnectionId = connection.providerConnectionId;
      completeStep("workspaceScopedProviderConnection");
      if (options.cloudflareConnectionMode === "generic-env") {
        beginStep("genericEnvProviderConnection");
        completeStep("genericEnvProviderConnection");
      }
      completeStep("connectionVerified");
    } else {
      beginStep("providerConnectionNotRequired");
      completeStep("providerConnectionNotRequired");
    }
    if (options.cloudflareResourcePreflight !== "none") {
      beginStep("cloudflareResourcePreflight");
      cloudflareResourcePreflight =
        await assertCloudflareResourcePreflight(options);
      completeStep("cloudflareResourcePreflight");
    }
    beginStep("sourceRegistered");
    beginStep("sourceSynced");
    beginStep("scratchInstall");
    beginStep("compatibilityChecked");
    beginStep("plan");
    const deploy = await deployGitSourceCapsule(options, {
      workspaceId,
      ...(providerConnectionId ? { providerConnectionId } : {}),
    });
    sourceId = deploy.sourceId;
    sourceSyncRunId = deploy.sourceSyncRunId;
    sourceSnapshotId = deploy.sourceSnapshotId;
    installConfigId = deploy.installConfigId;
    compatibilityReportId = deploy.compatibilityReportId;
    capsuleId = deploy.capsule.id;
    planRunId = deploy.planRun?.id ?? deploy.run.id;
    completeStep("sourceRegistered");
    completeStep("sourceSynced");
    completeStep("scratchInstall");
    completeStep("compatibilityChecked");
    capsuleGateStatus = "passed";
    const completedPlan = await ensurePlanReadyForApply(options, planRunId);
    policyStatus = publicPolicyStatus(completedPlan);
    assertRunSucceeded(completedPlan, "plan");
    runTimings.push(smokeRunTiming("plan", completedPlan));
    completeStep("plan");
    beginStep("apply");
    const applyRun =
      deploy.applyRun ??
      (
        await requestJson<{ readonly run: RunRecord }>({
          baseUrl: options.url,
          token: options.accountSessionToken,
          method: "POST",
          path: `${API_PREFIX}/runs/${encodeURIComponent(planRunId)}/apply`,
          body: {},
        })
      ).run;
    applyRunId = applyRun.id;
    const completedApply = await pollRun(options, applyRunId);
    policyStatus = publicPolicyStatus(completedApply);
    assertRunSucceeded(completedApply, "apply");
    runTimings.push(smokeRunTiming("apply", completedApply));
    completeStep("apply");
    beginStep("stateVersionLedgerVerified");
    if (options.verificationMode === "cloudflare-worker") {
      stateVersionLedger = await assertStateVersionLedger(options, {
        workspaceId,
        capsuleId,
        applyRunId,
      });
    } else {
      beginStep("opentofuApplyVerified");
      stateVersionLedger = await assertGenericStateVersionLedger(options, {
        workspaceId,
        capsuleId,
        applyRunId,
      });
      completeStep("opentofuApplyVerified");
    }
    completeStep("stateVersionLedgerVerified");
    if (options.requireReleaseActivation) {
      beginStep("releaseActivationVerified");
      releaseActivation = await assertReleaseActivation(options, {
        workspaceId,
        applyRunId,
        stateVersionId: stateVersionLedger.stateVersionId,
      });
      completeStep("releaseActivationVerified");
    }
    if (shouldVerifyCloudflareWorker(options)) {
      beginStep("runtimeVerified");
      await assertCloudflareWorkerExists(
        options,
        stateVersionLedger.publicOutputs,
      );
      completeStep("runtimeVerified");
    }
    if (options.verificationMode === "cloudflare-worker") {
      beginStep("publicUrlVerified");
      if (options.publicUrlChecks.length > 0) {
        publicUrlChecks = await assertConfiguredPublicUrls(
          options,
          stateVersionLedger.publicOutputs,
        );
      } else {
        await assertPublicWorkerUrl(options, stateVersionLedger.publicOutputs);
      }
      completeStep("publicUrlVerified");
    }
    if (
      options.verificationMode === "opentofu" &&
      options.publicUrlChecks.length > 0
    ) {
      beginStep("publicUrlVerified");
      publicUrlChecks = await assertConfiguredPublicUrls(
        options,
        stateVersionLedger.publicOutputs,
      );
      completeStep("publicUrlVerified");
    }
    if (options.functionalProbeScript) {
      beginStep("functionalProbe");
      functionalProbe = await runCapsuleFunctionalProbe(
        options,
        stateVersionLedger.publicOutputs ?? {},
      );
      completeStep("functionalProbe");
    }
    if (options.backupRestoreRehearsal) {
      beginStep("backupRestoreRehearsal");
      backupRestoreRehearsal = await runBackupRestoreRehearsal(options, {
        workspaceId,
        capsuleId,
      });
      completeStep("backupRestoreRehearsal");
    }

    beginStep("destroy");
    const destroyResult = await destroySmokeCapsule(options, {
      capsuleId,
      reason: "Layer-2 platform-control-plane smoke cleanup",
      verifyCloudflareWorkerGone: shouldVerifyCloudflareWorker(options),
      publicOutputs: stateVersionLedger.publicOutputs,
    });
    destroyPlanRunId = destroyResult.destroyPlanRun.id;
    destroyApplyRunId = destroyResult.destroyApplyRun.id;
    policyStatus = publicPolicyStatus(destroyResult.destroyApplyRun);
    runTimings.push(
      smokeRunTiming("destroy_plan", destroyResult.destroyPlanRun),
    );
    runTimings.push(
      smokeRunTiming("destroy_apply", destroyResult.destroyApplyRun),
    );
    functionalProbe = finalizeFunctionalProbeCleanup(functionalProbe);
    completeStep("destroy");

    if (connectionId && !options.keepConnection) {
      beginStep("connectionRevoked");
      connectionRevoked = await revokeConnection(options, connectionId);
      if (!connectionRevoked) {
        throw new Error(
          "temporary ProviderConnection revoke did not confirm success",
        );
      }
      completeStep("connectionRevoked");
    }
    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    return {
      kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
      status: "passed",
      generatedAt: finishedAt,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      serviceUrl: options.url,
      scratchWorkspaceId: workspaceId,
      capsuleModule: capsuleLabel(options),
      verificationMode: options.verificationMode,
      credentialPath:
        options.cloudflareConnectionMode === "none"
          ? "none"
          : "workspace_scoped_provider_connection",
      providerConnectionMode: options.cloudflareConnectionMode,
      sourceMode: options.sourceMode,
      steps: requiredSteps(options),
      completedSteps,
      stepTimings,
      runTimings,
      appName: options.appName,
      environment: options.environment,
      connectionId,
      providerConnectionId,
      sourceId,
      sourceSyncRunId,
      sourceSnapshotId,
      installConfigId,
      compatibilityReportId,
      capsuleId,
      planRunId,
      applyRunId,
      destroyPlanRunId,
      destroyApplyRunId,
      backupRestoreRehearsal,
      stateVersionLedger,
      releaseActivation,
      cloudflareResourcePreflight,
      publicUrlChecks,
      functionalProbe,
      capsuleGateStatus: "passed",
      policyStatus: policyStatus === "denied" ? failPolicy() : "passed",
      workerUrl: shouldVerifyCloudflareWorker(options)
        ? publicRuntimeUrl(options, stateVersionLedger.publicOutputs)
        : "",
      opentofuApplyVerified: options.verificationMode === "opentofu",
      runtimeVerified: shouldVerifyCloudflareWorker(options),
      publicUrlVerified:
        options.verificationMode === "cloudflare-worker" ||
        options.publicUrlChecks.length > 0,
      publicUrlChecks,
      stateVersionLedgerVerified: true,
      destroyVerified: true,
      ...(connectionId ? { connectionRevoked } : {}),
      inputs: publicInputSummary(options),
    };
  } catch (error) {
    if (error instanceof RunPollTimeoutError) {
      timedOutRunId = error.runId;
      const cancellation = await cancelRunAfterPollTimeout(
        options,
        error.runId,
      );
      runCancellationStatus = cancellation.status;
      runCancellationError = cancellation.error;
      if (cancellation.status === "failed") {
        connectionRevokeSkippedReason =
          "run did not reach a terminal state and cancel did not confirm terminal ownership";
      }
    }
    if (capsuleId && applyRunId && !destroyApplyRunId) {
      beginStep("destroy");
      const verifyCloudflareWorkerGone = shouldVerifyCloudflareWorker(options);
      try {
        const destroyResult = await destroySmokeCapsule(options, {
          capsuleId,
          reason:
            "Layer-2 platform-control-plane smoke cleanup after verification failure",
          verifyCloudflareWorkerGone,
          publicOutputs: stateVersionLedger?.publicOutputs,
        });
        destroyPlanRunId = destroyResult.destroyPlanRun.id;
        destroyApplyRunId = destroyResult.destroyApplyRun.id;
        runTimings.push(
          smokeRunTiming("destroy_plan", destroyResult.destroyPlanRun),
        );
        runTimings.push(
          smokeRunTiming("destroy_apply", destroyResult.destroyApplyRun),
        );
        functionalProbe = finalizeFunctionalProbeCleanup(functionalProbe);
        completeStep("destroy");
        failureCleanup = {
          attempted: true,
          cloudflareWorkerGone: verifyCloudflareWorkerGone
            ? await assertCloudflareWorkerGoneForCleanup(
                options,
                stateVersionLedger?.publicOutputs,
              )
            : false,
          capsuleMarkedError: false,
          destroyAttempted: true,
          destroyPlanRunId,
          destroyApplyRunId,
          destroySucceeded: true,
        };
      } catch (destroyError) {
        connectionRevokeSkippedReason =
          "post-apply cleanup destroy failed; keeping ProviderConnection so the Capsule can be destroyed after the blocker is fixed";
        const fallbackCleanup = await cleanupAppliedSmokeFailure(options, {
          capsuleId,
          publicOutputs: stateVersionLedger?.publicOutputs,
        });
        failureCleanup = {
          ...fallbackCleanup,
          destroyAttempted: true,
          destroySucceeded: false,
          destroyError:
            destroyError instanceof Error
              ? destroyError.message
              : String(destroyError),
        };
      }
    } else {
      await markPendingSmokeCapsuleError(options, {
        workspaceId,
        capsuleId,
      }).catch(() => undefined);
    }
    failure = error;
  } finally {
    if (
      connectionId &&
      !options.keepConnection &&
      !connectionRevoked &&
      !connectionRevokeSkippedReason
    ) {
      beginStep("connectionRevoked");
      connectionRevoked = await revokeConnection(options, connectionId);
      if (connectionRevoked) completeStep("connectionRevoked");
    }
  }
  return failedResult(options, {
    startedAt,
    startedAtMs,
    workspaceId,
    completedSteps,
    stepTimings,
    runTimings,
    connectionId,
    providerConnectionId,
    capsuleId,
    sourceId,
    sourceSyncRunId,
    sourceSnapshotId,
    installConfigId,
    compatibilityReportId,
    planRunId,
    applyRunId,
    destroyPlanRunId,
    destroyApplyRunId,
    backupRestoreRehearsal,
    stateVersionLedger,
    releaseActivation,
    cloudflareResourcePreflight,
    publicUrlChecks,
    functionalProbe,
    capsuleGateStatus,
    policyStatus,
    connectionRevoked,
    timedOutRunId,
    runCancellationStatus,
    runCancellationError,
    connectionRevokeSkippedReason,
    failureCleanup,
    error: failure,
  });
}

function failedResult(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly startedAt: string;
    readonly startedAtMs: number;
    readonly workspaceId: string;
    readonly completedSteps: readonly string[];
    readonly stepTimings: readonly SmokeStepTiming[];
    readonly runTimings: readonly SmokeRunTiming[];
    readonly connectionId?: string;
    readonly providerConnectionId?: string;
    readonly sourceId?: string;
    readonly sourceSyncRunId?: string;
    readonly sourceSnapshotId?: string;
    readonly installConfigId?: string;
    readonly compatibilityReportId?: string;
    readonly capsuleId?: string;
    readonly planRunId?: string;
    readonly applyRunId?: string;
    readonly destroyPlanRunId?: string;
    readonly destroyApplyRunId?: string;
    readonly backupRestoreRehearsal?: BackupRestoreRehearsalResult;
    readonly stateVersionLedger?: StateVersionLedgerVerificationResult;
    readonly releaseActivation?: ReleaseActivationVerificationResult;
    readonly cloudflareResourcePreflight?: CloudflareResourcePreflightResult;
    readonly publicUrlChecks?: readonly PublicUrlCheckResult[];
    readonly functionalProbe?: CapsuleFunctionalProbeEvidence;
    readonly capsuleGateStatus: SmokeCheckStatus;
    readonly policyStatus: SmokeCheckStatus;
    readonly connectionRevoked?: boolean;
    readonly timedOutRunId?: string;
    readonly runCancellationStatus?:
      "cancelled" | "already_terminal" | "failed";
    readonly runCancellationError?: string;
    readonly connectionRevokeSkippedReason?: string;
    readonly failureCleanup?: FailureCleanupResult;
    readonly error: unknown;
  },
): PlatformControlPlaneSmokeResult {
  const finishedAtMs = Date.now();
  const finishedAt = new Date(finishedAtMs).toISOString();
  return {
    kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
    status: "failed",
    generatedAt: finishedAt,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAtMs - input.startedAtMs),
    serviceUrl: options.url,
    scratchWorkspaceId: input.workspaceId,
    capsuleModule: capsuleLabel(options),
    verificationMode: options.verificationMode,
    credentialPath:
      options.cloudflareConnectionMode === "none"
        ? "none"
        : "workspace_scoped_provider_connection",
    providerConnectionMode: options.cloudflareConnectionMode,
    sourceMode: options.sourceMode,
    steps: requiredSteps(options),
    completedSteps: input.completedSteps,
    stepTimings: input.stepTimings,
    runTimings: input.runTimings,
    appName: options.appName,
    environment: options.environment,
    connectionId: input.connectionId,
    providerConnectionId: input.providerConnectionId,
    sourceId: input.sourceId,
    sourceSyncRunId: input.sourceSyncRunId,
    sourceSnapshotId: input.sourceSnapshotId,
    installConfigId: input.installConfigId,
    compatibilityReportId: input.compatibilityReportId,
    capsuleId: input.capsuleId,
    planRunId: input.planRunId,
    applyRunId: input.applyRunId,
    destroyPlanRunId: input.destroyPlanRunId,
    destroyApplyRunId: input.destroyApplyRunId,
    backupRestoreRehearsal: input.backupRestoreRehearsal,
    stateVersionLedger: input.stateVersionLedger,
    releaseActivation: input.releaseActivation,
    cloudflareResourcePreflight: input.cloudflareResourcePreflight,
    publicUrlChecks: input.publicUrlChecks,
    functionalProbe: input.functionalProbe,
    capsuleGateStatus: input.capsuleGateStatus,
    policyStatus: input.policyStatus,
    workerUrl:
      options.verificationMode === "cloudflare-worker"
        ? publicRuntimeUrl(options, input.stateVersionLedger?.publicOutputs)
        : "",
    opentofuApplyVerified: input.completedSteps.includes(
      "opentofuApplyVerified",
    ),
    runtimeVerified: input.completedSteps.includes("runtimeVerified"),
    publicUrlVerified: input.completedSteps.includes("publicUrlVerified"),
    stateVersionLedgerVerified: input.completedSteps.includes(
      "stateVersionLedgerVerified",
    ),
    destroyVerified: input.completedSteps.includes("destroy"),
    ...(input.connectionId
      ? { connectionRevoked: input.connectionRevoked }
      : {}),
    timedOutRunId: input.timedOutRunId,
    runCancellationStatus: input.runCancellationStatus,
    runCancellationError: input.runCancellationError,
    connectionRevokeSkippedReason: input.connectionRevokeSkippedReason,
    failureCleanup: input.failureCleanup,
    error: publicErrorMessage(input.error),
    nextAction: failedNextAction(input),
    inputs: publicInputSummary(options),
  };
}

function failedNextAction(input: {
  readonly capsuleId?: string;
  readonly planRunId?: string;
  readonly connectionRevokeSkippedReason?: string;
  readonly error: unknown;
}): string {
  if (input.error instanceof CloudflareResourcePreflightError) {
    return "Update the operator Cloudflare API token so it can read and create the Cloudflare account resources required by the Capsule, or use a non-resource-creating Capsule smoke before rerunning this apply.";
  }
  if (
    input.error instanceof RequestTimeoutError &&
    input.error.method === "POST" &&
    /\/capsules\/[^/]+\/plan$/u.test(input.error.path)
  ) {
    return "The Capsule plan request timed out before returning a plan run id. Check the scratch Workspace for a pending smoke Capsule run with this app name, verify the temporary Provider Connection is revoked, then inspect platform worker logs for the source sync, compatibility check, or plan creation step that did not return.";
  }
  if (input.connectionRevokeSkippedReason !== undefined) {
    return "Inspect the failed cleanup run, destroy the recorded Capsule after fixing the blocker, then revoke the retained ProviderConnection and rerun the smoke.";
  }
  return "Inspect the recorded Run and Capsule ids, confirm any temporary Cloudflare resources are destroyed, then rerun the smoke after the blocking Run reaches a terminal state.";
}

function failPolicy(): never {
  throw new Error("policyStatus denied during platform-control-plane smoke");
}

function publicPolicyStatus(run: RunRecord): SmokeCheckStatus {
  return run.policyStatus === "deny" ? "denied" : "passed";
}

async function resolveWorkspaceId(
  options: PlatformControlPlaneSmokeOptions,
): Promise<string> {
  const normalized = options.workspace.replace(/^@/, "");
  if (/^ws_[0-9a-zA-Z]{3,64}$/u.test(normalized)) {
    if (options.ensureWorkspace) {
      await requestJson({
        baseUrl: options.url,
        token: options.accountSessionToken,
        path: `${API_PREFIX}/workspaces/${encodeURIComponent(normalized)}`,
      });
    }
    return normalized;
  }
  const response = await requestJson<{
    readonly workspaces?: readonly {
      readonly id: string;
      readonly handle: string;
      readonly archivedAt?: string;
    }[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/workspaces?includeArchived=true`,
  });
  const listedWorkspaces = response.workspaces ?? [];
  const match = listedWorkspaces.find(
    (workspace) => workspace.handle === normalized,
  );
  if (match?.id) {
    if (typeof match.archivedAt === "string" && match.archivedAt.length > 0) {
      await requestJson({
        baseUrl: options.url,
        token: options.accountSessionToken,
        method: "PATCH",
        path: `${API_PREFIX}/workspaces/${encodeURIComponent(match.id)}`,
        body: { archived: false },
      });
    }
    return match.id;
  }
  if (!match) {
    if (options.ensureWorkspace) {
      const created = await requestJson<{
        readonly workspace?: { readonly id?: string };
      }>({
        baseUrl: options.url,
        token: options.accountSessionToken,
        method: "POST",
        path: `${API_PREFIX}/workspaces`,
        body: {
          handle: normalized,
          displayName: options.workspaceDisplayName ?? normalized,
          type: "personal",
        },
      });
      const createdId = created.workspace?.id;
      if (!createdId) {
        throw new Error(
          "Workspace create response did not include workspace.id",
        );
      }
      return createdId;
    }
    throw new Error(
      `workspace @${normalized} was not found; pass --ensure-workspace or create the scratch Workspace first`,
    );
  }
}

async function createWorkspaceCloudflareConnection(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
): Promise<{
  readonly rawConnectionId: string;
  readonly providerConnectionId: string;
}> {
  const displayName = `Layer-2 smoke ${options.appName}`;
  const response = await requestJson<{
    readonly connection?: { readonly id?: string };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/connections`,
    body:
      options.cloudflareConnectionMode === "generic-env"
        ? {
            workspaceId,
            provider: "cloudflare",
            kind: "generic_env_provider",
            credentialDriver: "generic_env",
            displayName,
            scopeHints: {
              accountId: options.cloudflareAccountId,
              workersSubdomain: options.cloudflareWorkersSubdomain,
            },
            values: {
              CLOUDFLARE_API_TOKEN: options.cloudflareApiToken,
              CLOUDFLARE_ACCOUNT_ID: options.cloudflareAccountId,
            },
          }
        : {
            workspaceId,
            provider: "cloudflare",
            displayName,
            scopeHints: {
              accountId: options.cloudflareAccountId,
              workersSubdomain: options.cloudflareWorkersSubdomain,
            },
            values: { CLOUDFLARE_API_TOKEN: options.cloudflareApiToken },
          },
  });
  const id = response.connection?.id;
  if (!id) {
    throw new Error("connection create response did not include connection.id");
  }
  await verifyConnection(options, id);
  const providerConnectionId = await lookupPublicProviderConnectionId(
    options,
    workspaceId,
    displayName,
  );
  return { rawConnectionId: id, providerConnectionId };
}

async function verifyConnection(
  options: PlatformControlPlaneSmokeOptions,
  connectionId: string,
): Promise<void> {
  const tested = await requestJson<{ readonly status?: string }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/connections/${encodeURIComponent(connectionId)}/test`,
  });
  if (tested.status !== "verified") {
    throw new Error(
      `connection ${connectionId} test ended as ${tested.status ?? "unknown"}`,
    );
  }
}

async function assertCloudflareResourcePreflight(
  options: PlatformControlPlaneSmokeOptions,
): Promise<CloudflareResourcePreflightResult> {
  if (options.cloudflareResourcePreflight === "none") {
    throw new Error("cloudflare resource preflight called with mode none");
  }
  const checks = cloudflareResourcePreflightDefinitions(
    options.cloudflareResourcePreflight,
  );
  for (const check of checks) {
    const path = check.path(options.cloudflareAccountId);
    const response = await fetch(`https://api.cloudflare.com${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.cloudflareApiToken}`,
        "content-type": "application/json",
      },
    }).catch((error) => {
      throw new CloudflareResourcePreflightError(
        "request_failed",
        `cloudflare resource preflight request failed: ${check.label}: ${errorMessage(error)}`,
      );
    });
    const bodyText = await response.text();
    const body = parseResponseBody(
      bodyText,
      `cloudflare resource preflight ${check.id}`,
    );
    if (!response.ok || !cloudflareApiSuccess(body)) {
      throw new CloudflareResourcePreflightError(
        "capability_denied",
        `cloudflare resource preflight failed: ${check.id} returned http ${
          response.status
        }: ${cloudflareApiErrorCode(body)}. The Cloudflare token is active but cannot read ${check.label} for the configured account; update CLOUDFLARE_API_TOKEN permissions or CLOUDFLARE_ACCOUNT_ID before applying resource-creating Capsules.`,
      );
    }
  }
  return {
    mode: options.cloudflareResourcePreflight,
    status: "passed",
    checks: checks.map((check) => check.id),
  };
}

function cloudflareResourcePreflightDefinitions(
  mode: Exclude<CloudflareResourcePreflightMode, "none">,
): readonly (typeof CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS)[number][] {
  if (mode === "d1") {
    return [CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS[0]!];
  }
  if (mode === "account-resources") {
    return CLOUDFLARE_ACCOUNT_RESOURCE_PREFLIGHT_CHECKS;
  }
  return assertNever(mode);
}

function cloudflareResourcePreflightChecks(
  mode: CloudflareResourcePreflightMode,
): readonly string[] {
  if (mode === "none") return [];
  return cloudflareResourcePreflightDefinitions(mode).map((check) => check.id);
}

async function lookupPublicProviderConnectionId(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
  displayName: string,
): Promise<string> {
  const response = await requestJson<{
    readonly providerConnections?: readonly SmokeProviderConnectionListEntry[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/provider-connections?workspaceId=${encodeURIComponent(workspaceId)}`,
  });
  const match = (response.providerConnections ?? []).find((connection) =>
    isSmokeProviderConnectionMatch(connection, {
      provider: "cloudflare",
      displayName,
    }),
  );
  if (!match?.id) {
    throw new Error(
      "created connection did not appear in provider-connections",
    );
  }
  return match.id;
}

export function isSmokeProviderConnectionMatch(
  connection: SmokeProviderConnectionListEntry,
  expected: { readonly provider: string; readonly displayName: string },
): boolean {
  return (
    typeof connection.id === "string" &&
    connection.displayName === expected.displayName &&
    connection.providerSource !== undefined &&
    canonicalProviderSource(connection.providerSource) ===
      canonicalProviderSource(expected.provider)
  );
}

async function deployGitSourceCapsule(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly providerConnectionId?: string;
  },
): Promise<
  DeployResponse & {
    readonly sourceId: string;
    readonly sourceSyncRunId: string;
    readonly sourceSnapshotId: string;
    readonly installConfigId: string;
  }
> {
  if (!options.sourceGitUrl) {
    throw new Error("sourceGitUrl is required for git source smoke");
  }
  const source = await createSmokeSource(options, input.workspaceId);
  const sourceSyncRun = await syncSmokeSource(options, source.id);
  const sourceSnapshotId = sourceSyncRun.sourceSnapshotId;
  if (!sourceSnapshotId) {
    throw new Error(
      `source sync run ${sourceSyncRun.id} succeeded without sourceSnapshotId`,
    );
  }
  const installConfigId = await findSmokeCapsuleInstallConfigId(
    options,
    input.workspaceId,
  );
  const capsule = await createSourceCapsule(options, {
    workspaceId: input.workspaceId,
    sourceId: source.id,
    installConfigId,
  });
  const compatibility = await createSmokeSourceCompatibilityCheck(options, {
    sourceId: source.id,
    sourceSnapshotId,
    capsuleId: capsule.id,
  });
  if (input.providerConnectionId) {
    await putCapsuleProviderBindings(options, {
      capsuleId: capsule.id,
      providerConnectionId: input.providerConnectionId,
    });
  }
  const plan = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/capsules/${encodeURIComponent(capsule.id)}/plan`,
    timeoutMs: options.deployTimeoutSeconds * 1000,
    body: {
      ...(options.runnerProfileId ? { runnerId: options.runnerProfileId } : {}),
      compatibilityReportId: compatibility.report.id,
    },
  });
  return {
    capsule,
    run: plan.run,
    planRun: plan.run,
    created: true,
    sourceId: source.id,
    sourceSyncRunId: sourceSyncRun.id,
    sourceSnapshotId,
    installConfigId,
    compatibilityReportId: compatibility.report.id,
  };
}

async function createSmokeSourceCompatibilityCheck(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly sourceId: string;
    readonly sourceSnapshotId: string;
    readonly capsuleId: string;
  },
): Promise<{
  readonly report: {
    readonly id: string;
    readonly level?: string;
  };
  readonly run?: RunRecord;
}> {
  const response = await requestJson<{
    readonly report?: {
      readonly id?: string;
      readonly level?: string;
    };
    readonly run?: RunRecord;
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/sources/${encodeURIComponent(
      input.sourceId,
    )}/compatibility-check`,
    body: smokeSourceCompatibilityCheckBody({
      sourceSnapshotId: input.sourceSnapshotId,
      capsuleId: input.capsuleId,
      modulePath: options.modulePath,
    }),
  });
  const reportId = response.report?.id;
  if (!reportId) {
    throw new Error(
      "source compatibility check response did not include report.id",
    );
  }
  return {
    report: {
      id: reportId,
      ...(response.report?.level ? { level: response.report.level } : {}),
    },
    ...(response.run ? { run: response.run } : {}),
  };
}

export function smokeSourceCompatibilityCheckBody(input: {
  readonly sourceSnapshotId: string;
  readonly capsuleId: string;
  readonly modulePath?: string;
}): {
  readonly sourceSnapshotId: string;
  readonly capsuleId: string;
  readonly modulePath?: string;
} {
  return {
    sourceSnapshotId: input.sourceSnapshotId,
    capsuleId: input.capsuleId,
    ...(input.modulePath ? { modulePath: input.modulePath } : {}),
  };
}

async function createSmokeSource(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
): Promise<{ readonly id: string }> {
  const response = await requestJson<{
    readonly source?: { readonly id?: string };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/sources`,
    body: {
      workspaceId,
      name: options.sourceName ?? `${options.appName}-source`,
      url: options.sourceGitUrl,
      ...(options.sourceRef ? { defaultRef: options.sourceRef } : {}),
      defaultPath: options.sourcePath,
    },
  });
  const id = response.source?.id;
  if (!id) throw new Error("source create response did not include source.id");
  return { id };
}

async function syncSmokeSource(
  options: PlatformControlPlaneSmokeOptions,
  sourceId: string,
): Promise<RunRecord & { readonly sourceSnapshotId: string }> {
  const created = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/sources/${encodeURIComponent(sourceId)}/sync`,
    body: {},
  });
  const completed = await pollRun(options, created.run.id);
  assertRunSucceeded(completed, "source sync");
  if (!completed.sourceSnapshotId) {
    throw new Error(
      `source sync run ${completed.id} did not expose sourceSnapshotId`,
    );
  }
  return completed as RunRecord & { readonly sourceSnapshotId: string };
}

async function findSmokeCapsuleInstallConfigId(
  options: PlatformControlPlaneSmokeOptions,
  workspaceId: string,
): Promise<string> {
  const response = await requestJson<{
    readonly installConfigs?: readonly InstallConfigRecord[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsule-configs?workspaceId=${encodeURIComponent(
      workspaceId,
    )}`,
  });
  const configs = response.installConfigs ?? [];
  return selectSmokeInstallConfigId(configs, options.installConfigId);
}

export function selectSmokeInstallConfigId(
  configs: readonly InstallConfigRecord[],
  requestedId?: string,
): string {
  const selectable = configs.filter(isSelectableCapsuleInstallConfig);
  if (requestedId) {
    const match = selectable.find((config) => config.id === requestedId);
    if (!match) {
      throw new Error(
        `install config ${requestedId} was not available to the scratch Workspace`,
      );
    }
    return match.id;
  }
  if (selectable.length === 0) {
    throw new Error(
      "selectable Capsule install config was not available to the scratch Workspace",
    );
  }
  if (selectable.length > 1) {
    throw new Error(
      "multiple selectable Capsule install configs are available; set --install-config-id explicitly",
    );
  }
  return selectable[0]!.id;
}

export function isSelectableCapsuleInstallConfig(
  config: InstallConfigRecord,
): config is InstallConfigRecord & { readonly id: string } {
  if (typeof config.id !== "string") return false;
  if (config.internal?.reason === "per_install_overrides") return false;
  return true;
}

async function createSourceCapsule(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly installConfigId: string;
  },
): Promise<{ readonly id: string; readonly name?: string }> {
  const response = await requestJson<CapsuleCreateSmokeResponse>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/workspaces/${encodeURIComponent(
      input.workspaceId,
    )}/capsules`,
    body: smokeSourceCapsuleCreateBody(options, input),
  });
  const created = createdCapsuleFromCreateResponse(response);
  const id = created.id;
  return {
    id,
    ...(created.name ? { name: created.name } : {}),
  };
}

export function smokeSourceCapsuleCreateBody(
  options: Pick<
    PlatformControlPlaneSmokeOptions,
    | "appName"
    | "environment"
    | "modulePath"
    | "runnerProfileId"
    | "outputAllowlist"
    | "vars"
    | "storeMetadata"
  >,
  input: {
    readonly sourceId: string;
    readonly installConfigId: string;
  },
): Readonly<Record<string, unknown>> {
  return {
    name: options.appName,
    environment: options.environment,
    sourceId: input.sourceId,
    installConfigId: input.installConfigId,
    ...(options.modulePath ? { modulePath: options.modulePath } : {}),
    ...(options.runnerProfileId
      ? { runnerProfileId: options.runnerProfileId }
      : {}),
    outputAllowlist: options.outputAllowlist,
    vars: options.vars,
    ...(options.storeMetadata ? { store: options.storeMetadata } : {}),
  };
}

export interface CapsuleCreateSmokeResponse {
  readonly capsule?: { readonly id?: string; readonly name?: string };
}

export function createdCapsuleFromCreateResponse(
  response: CapsuleCreateSmokeResponse,
): { readonly id: string; readonly name?: string } {
  const created = response.capsule;
  const id = created?.id;
  if (!id) {
    throw new Error("capsule create response did not include id");
  }
  return {
    id,
    ...(created?.name ? { name: created.name } : {}),
  };
}

export function capsuleFromLedgerResponse(
  response: CapsuleLedgerResponse,
): CapsuleLedgerRecord {
  const capsule = response.capsule;
  if (!capsule) {
    throw new Error("capsule ledger response did not include capsule");
  }
  return capsule;
}

function capsuleWorkspaceId(capsule: CapsuleLedgerRecord): string | undefined {
  return capsule.workspaceId;
}

function capsuleCurrentStateVersionId(
  capsule: CapsuleLedgerRecord,
): string | undefined {
  return capsule.currentStateVersionId;
}

async function putCapsuleProviderBindings(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly capsuleId: string;
    readonly providerConnectionId: string;
  },
): Promise<void> {
  await requestJson({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "PUT",
    path: `${API_PREFIX}/capsules/${encodeURIComponent(
      input.capsuleId,
    )}/provider-bindings`,
    body: {
      bindings: [
        {
          provider: "cloudflare",
          alias: "main",
          connectionId: input.providerConnectionId,
        },
      ],
    },
  });
}

async function ensurePlanReadyForApply(
  options: PlatformControlPlaneSmokeOptions,
  planRunId: string,
): Promise<RunRecord> {
  const plan = await pollRun(options, planRunId);
  if (plan.status !== "waiting_approval") return plan;
  const approved = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/runs/${encodeURIComponent(planRunId)}/approve`,
    body: { reason: "Layer-2 platform-control-plane smoke apply" },
  });
  if (TERMINAL_RUN_STATUSES.has(approved.run.status)) return approved.run;
  return await pollRun(options, planRunId);
}

async function destroySmokeCapsule(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly capsuleId: string;
    readonly reason: string;
    readonly verifyCloudflareWorkerGone: boolean;
    readonly publicOutputs?: Readonly<Record<string, unknown>>;
  },
): Promise<{
  readonly destroyPlanRun: RunRecord;
  readonly destroyApplyRun: RunRecord;
}> {
  const destroyPlan = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/capsules/${encodeURIComponent(
      input.capsuleId,
    )}/destroy-plan`,
    body: {
      ...(options.runnerProfileId
        ? { runnerProfileId: options.runnerProfileId }
        : {}),
    },
  });
  const reviewedDestroyPlan = await pollRun(options, destroyPlan.run.id);
  if (reviewedDestroyPlan.status !== "waiting_approval") {
    throw new Error(
      `destroy plan ${destroyPlan.run.id} ended as ${reviewedDestroyPlan.status}; expected waiting_approval`,
    );
  }
  await requestJson({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/runs/${encodeURIComponent(destroyPlan.run.id)}/approve`,
    body: { reason: input.reason },
  });
  const destroyApply = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/runs/${encodeURIComponent(destroyPlan.run.id)}/apply`,
    body: { confirmDestructive: true },
  });
  const completedDestroy = await pollRun(options, destroyApply.run.id);
  assertRunSucceeded(completedDestroy, "destroy apply");
  if (input.verifyCloudflareWorkerGone) {
    await assertCloudflareWorkerGone(options, input.publicOutputs);
    await assertPublicWorkerUrlGone(options, input.publicOutputs);
  }
  return {
    destroyPlanRun: reviewedDestroyPlan,
    destroyApplyRun: completedDestroy,
  };
}

export function shouldMarkPendingSmokeCapsuleError(
  capsule: CapsuleLedgerRecord,
  appName: string,
): capsule is CapsuleLedgerRecord & { readonly id: string } {
  return (
    typeof capsule.id === "string" &&
    capsule.name === appName &&
    capsule.status === "pending" &&
    (capsule.currentStateGeneration ?? 0) === 0
  );
}

async function markPendingSmokeCapsuleError(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId?: string;
  },
): Promise<boolean> {
  const candidates = input.capsuleId
    ? [
        (
          await requestJson<{ readonly capsule?: CapsuleLedgerRecord }>({
            baseUrl: options.url,
            token: options.accountSessionToken,
            path: `${API_PREFIX}/capsules/${encodeURIComponent(
              input.capsuleId,
            )}`,
          })
        ).capsule,
      ]
    : ((
        await requestJson<{ readonly capsules?: CapsuleLedgerRecord[] }>({
          baseUrl: options.url,
          token: options.accountSessionToken,
          path: `${API_PREFIX}/workspaces/${encodeURIComponent(
            input.workspaceId,
          )}/capsules`,
        })
      ).capsules ?? []);

  const target = candidates
    .filter((item): item is CapsuleLedgerRecord => item !== undefined)
    .find((item) => shouldMarkPendingSmokeCapsuleError(item, options.appName));
  if (!target?.id) return false;
  await requestJson({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "PATCH",
    path: `${API_PREFIX}/capsules/${encodeURIComponent(target.id)}`,
    body: { status: "error" },
  });
  return true;
}

async function cleanupAppliedSmokeFailure(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly capsuleId: string;
    readonly publicOutputs?: Readonly<Record<string, unknown>>;
  },
): Promise<FailureCleanupResult> {
  let cloudflareWorkerGone = false;
  let capsuleMarkedError = false;
  let cleanupError: string | undefined;
  try {
    const workerName = cloudflareWorkerName(options, input.publicOutputs);
    const deleted = await cloudflareScriptRequest(
      options,
      "DELETE",
      workerName,
    );
    cloudflareWorkerGone = deleted.status === 404 || deleted.ok;
    if (!cloudflareWorkerGone) {
      await assertCloudflareWorkerGone(options, input.publicOutputs);
      cloudflareWorkerGone = true;
    }
  } catch (error) {
    cleanupError = publicErrorMessage(error);
  }
  try {
    await requestJson({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "PATCH",
      path: `${API_PREFIX}/capsules/${encodeURIComponent(input.capsuleId)}`,
      body: { status: "error" },
    });
    capsuleMarkedError = true;
  } catch (error) {
    cleanupError = cleanupError
      ? `${cleanupError}; ${publicErrorMessage(error)}`
      : publicErrorMessage(error);
  }
  return {
    attempted: true,
    cloudflareWorkerGone,
    capsuleMarkedError,
    ...(cleanupError ? { error: cleanupError } : {}),
  };
}

async function assertCloudflareWorkerGoneForCleanup(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  try {
    const workerName = cloudflareWorkerName(options, publicOutputs);
    const deleted = await cloudflareScriptRequest(
      options,
      "DELETE",
      workerName,
    );
    if (deleted.status === 404 || deleted.ok) return true;
    await assertCloudflareWorkerGone(options, publicOutputs);
    return true;
  } catch {
    return false;
  }
}

async function pollRun(
  options: PlatformControlPlaneSmokeOptions,
  runId: string,
): Promise<RunRecord> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastStatus = "";
  while (Date.now() <= deadline) {
    const response = await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/runs/${encodeURIComponent(runId)}`,
    });
    if (response.run.status !== lastStatus && !options.json) {
      console.log(`run ${runId} ${response.run.status}`);
      lastStatus = response.run.status;
    }
    if (TERMINAL_RUN_STATUSES.has(response.run.status)) {
      return response.run;
    }
    await sleep(options.pollIntervalMs);
  }
  throw new RunPollTimeoutError(runId);
}

async function cancelRunAfterPollTimeout(
  options: PlatformControlPlaneSmokeOptions,
  runId: string,
): Promise<{
  readonly status: "cancelled" | "already_terminal" | "failed";
  readonly error?: string;
}> {
  try {
    const current = await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/runs/${encodeURIComponent(runId)}`,
    });
    if (TERMINAL_RUN_STATUSES.has(current.run.status)) {
      return { status: "already_terminal" };
    }
    const cancelled = await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/runs/${encodeURIComponent(runId)}/cancel`,
      body: {},
    });
    if (TERMINAL_RUN_STATUSES.has(cancelled.run.status)) {
      return { status: "cancelled" };
    }
    return {
      status: "failed",
      error: `cancel returned non-terminal status ${cancelled.run.status}`,
    };
  } catch (error) {
    return { status: "failed", error: publicErrorMessage(error) };
  }
}

function assertRunSucceeded(run: RunRecord, phase: string): void {
  if (run.status !== "succeeded") {
    throw new Error(`${phase} run ${run.id} ended as ${run.status}`);
  }
  if (run.policyStatus === "deny") {
    throw new Error(`${phase} run ${run.id} was denied by policy`);
  }
}

async function runBackupRestoreRehearsal(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
  },
): Promise<BackupRestoreRehearsalResult> {
  const stateVersion = await latestStateVersionForCapsule(
    options,
    input.capsuleId,
  );
  const backup = (
    await requestJson<{ readonly backup: BackupRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/capsules/${encodeURIComponent(
        input.capsuleId,
      )}/backups`,
    })
  ).backup;
  const restore = (
    await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/workspaces/${encodeURIComponent(
        input.workspaceId,
      )}/backups/${encodeURIComponent(backup.id)}/restores`,
      body: {
        capsuleId: input.capsuleId,
        environment: stateVersion.environment,
        stateGeneration: stateVersion.generation,
        expectedBackupDigest: backup.digest,
      },
    })
  ).run;
  if (restore.status !== "waiting_approval") {
    throw new Error(
      `restore run ${restore.id} ended as ${restore.status}; expected waiting_approval`,
    );
  }
  await requestJson({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/runs/${encodeURIComponent(restore.id)}/approve`,
    body: {
      reason: "Layer-2 platform-control-plane backup/restore rehearsal",
    },
  });
  const completedRestore = await pollRun(options, restore.id);
  assertRunSucceeded(completedRestore, "restore");
  return {
    backupId: backup.id,
    backupRunId: backup.createdByRunId,
    backupDigest: backup.digest,
    backupCreatedAt: backup.createdAt,
    stateGeneration: stateVersion.generation,
    stateVersionId: stateVersion.id,
    restoreRunId: completedRestore.id,
    restoredFromStateVersionId: completedRestore.restoredFromStateVersionId,
    restoredStateVersionId: completedRestore.restoredStateVersionId,
    restoreCreatedAt: completedRestore.createdAt ?? restore.createdAt,
    restoreStartedAt: completedRestore.startedAt,
    restoreFinishedAt: completedRestore.finishedAt,
    restoreTargetSmoke: "passed",
  };
}

async function latestStateVersionForCapsule(
  options: PlatformControlPlaneSmokeOptions,
  capsuleId: string,
): Promise<StateVersionRecord> {
  const response = await requestJson<{
    readonly stateVersions?: readonly StateVersionRecord[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsules/${encodeURIComponent(
      capsuleId,
    )}/state-versions`,
  });
  const stateVersions = [...(response.stateVersions ?? [])].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const stateVersion = stateVersions[0];
  if (!stateVersion) {
    throw new Error(
      `Capsule ${capsuleId} did not return a StateVersion for backup/restore rehearsal`,
    );
  }
  if (
    !Number.isInteger(stateVersion.generation) ||
    stateVersion.generation < 0
  ) {
    throw new Error(
      `StateVersion ${stateVersion.id} has invalid generation for backup/restore rehearsal`,
    );
  }
  return stateVersion;
}

async function assertCloudflareWorkerExists(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const workerName = cloudflareWorkerName(options, publicOutputs);
  const deadline = Date.now() + 60_000;
  let lastStatus = 0;
  while (Date.now() <= deadline) {
    const response = await cloudflareScriptRequest(options, "GET", workerName);
    lastStatus = response.status;
    if (response.status === 200) return;
    await sleep(2_000);
  }
  throw new Error(
    `Cloudflare Worker ${workerName} was not readable after apply (last HTTP ${lastStatus})`,
  );
}

function publicWorkerUrl(options: PlatformControlPlaneSmokeOptions): string {
  return publicWorkerUrlForName(options, options.appName);
}

function publicRuntimeUrl(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): string {
  if (options.runtimePublicUrlOutput) {
    return requiredProjectedStringOutput(
      publicOutputs,
      options.runtimePublicUrlOutput,
      "runtime public URL",
    );
  }
  return publicWorkerUrlForName(
    options,
    cloudflareWorkerName(options, publicOutputs),
  );
}

function publicWorkerUrlForName(
  options: PlatformControlPlaneSmokeOptions,
  workerName: string,
): string {
  return `https://${workerName}.${options.cloudflareWorkersSubdomain}.workers.dev`;
}

function cloudflareWorkerName(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): string {
  if (options.cloudflareWorkerNameOutput) {
    return requiredProjectedStringOutput(
      publicOutputs,
      options.cloudflareWorkerNameOutput,
      "Cloudflare Worker name",
    );
  }
  return options.appName;
}

function requiredProjectedStringOutput(
  publicOutputs: Readonly<Record<string, unknown>> | undefined,
  outputName: string,
  purpose: string,
): string {
  const value = publicOutputs?.[outputName];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `${purpose} output ${JSON.stringify(outputName)} is missing or is not a non-empty string`,
    );
  }
  return value.trim();
}

function isCurrentTakosumiHelloPage(body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    normalized.includes("hello from takosumi") &&
    normalized.includes("<h1>it works</h1>") &&
    normalized.includes("takosumi")
  );
}

async function assertPublicWorkerUrl(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const url = publicRuntimeUrl(options, publicOutputs);
  const deadline = Date.now() + 60_000;
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url, {
        headers: { accept: "text/html" },
      });
      lastStatus = response.status;
      lastBody = await response.text();
      if (response.ok && isCurrentTakosumiHelloPage(lastBody)) {
        return;
      }
    } catch (error) {
      lastBody = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_000);
  }
  throw new Error(
    `Cloudflare Worker public URL did not return the expected Takosumi page (last HTTP ${lastStatus}, body ${JSON.stringify(
      lastBody.slice(0, 120),
    )})`,
  );
}

function dryRunPublicUrl(check: PublicUrlCheck): string {
  const path = check.path === "/" ? "" : check.path;
  return `https://example.invalid${path}`;
}

async function assertConfiguredPublicUrls(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs: Readonly<Record<string, unknown>> | undefined,
): Promise<readonly PublicUrlCheckResult[]> {
  if (!publicOutputs) {
    throw new Error(
      "Output ledger did not expose publicOutputs for URL checks",
    );
  }
  const results: PublicUrlCheckResult[] = [];
  for (const check of options.publicUrlChecks) {
    const rawUrl = publicOutputs[check.output];
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      throw new Error(
        `public URL check ${check.name} expected string output ${check.output}`,
      );
    }
    const url = publicCheckUrl(rawUrl, check);
    const { response, body } = await fetchPublicUrlCheckWithRetry(url, check);
    results.push({
      name: check.name,
      output: check.output,
      url,
      status: response.status,
      ok: true,
      bodyIncludes: check.bodyIncludes,
      bodyDigest: sha256(body),
    });
  }
  return results;
}

async function fetchPublicUrlCheckWithRetry(
  url: string,
  check: PublicUrlCheck,
): Promise<{ readonly response: Response; readonly body: string }> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: "text/html,*/*" },
    });
    const body = await response.text();
    if (response.status === check.expectedStatus) {
      const missing = check.bodyIncludes.find(
        (marker) => !body.includes(marker),
      );
      if (!missing) return { response, body };
      lastError = new Error(
        `public URL check ${check.name} response did not include marker ${JSON.stringify(
          missing,
        )}: ${redactResponseSnippet(body)}`,
      );
    } else {
      lastError = new Error(
        `public URL check ${check.name} returned HTTP ${response.status}; expected ${check.expectedStatus}`,
      );
    }
    await sleep(Math.min(5_000, 500 + attempt * 500));
  }
  throw lastError ?? new Error(`public URL check ${check.name} failed`);
}

function publicCheckUrl(rawUrl: string, check: PublicUrlCheck): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `public URL check ${check.name} requires http(s) URL output`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `public URL check ${check.name} URL output must not contain credentials`,
    );
  }
  if (url.search) {
    throw new Error(
      `public URL check ${check.name} URL output must not contain a query string`,
    );
  }
  if (check.path !== "/") {
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${check.path.replace(
      /^\/+/u,
      "",
    )}`;
  }
  url.hash = "";
  return url.toString();
}

async function assertStateVersionLedger(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly applyRunId: string;
  },
): Promise<StateVersionLedgerVerificationResult> {
  const result = await readStateVersionAndOutputLedger(options, input);
  const outputUrl = result.publicOutputs?.url;
  if (typeof outputUrl !== "string" || !outputUrl.trim()) {
    throw new Error("Output publicOutputs.url was not a non-empty string");
  }
  return result;
}

async function assertGenericStateVersionLedger(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly applyRunId: string;
  },
): Promise<StateVersionLedgerVerificationResult> {
  const result = await readStateVersionAndOutputLedger(options, input);
  const missingRequiredOutputs = Object.entries(options.outputAllowlist)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name)
    .filter((name) => !result.publicOutputNames.includes(name));
  if (missingRequiredOutputs.length > 0) {
    throw new Error(
      `Output publicOutputs did not include required output(s): ${missingRequiredOutputs.join(
        ", ",
      )}`,
    );
  }
  return result;
}

async function readStateVersionAndOutputLedger(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly applyRunId: string;
  },
): Promise<StateVersionLedgerVerificationResult> {
  const capsuleResponse = await requestJson<CapsuleLedgerResponse>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsules/${encodeURIComponent(input.capsuleId)}`,
  });
  const capsule = capsuleFromLedgerResponse(capsuleResponse);
  if (capsule.id !== input.capsuleId) {
    throw new Error("capsule ledger returned an unexpected capsule id");
  }
  if (capsuleWorkspaceId(capsule) !== input.workspaceId) {
    throw new Error("capsule ledger returned an unexpected Workspace id");
  }
  if (capsule.status !== "active") {
    throw new Error(
      `capsule ledger status was ${capsule.status ?? "unknown"}; expected active`,
    );
  }
  if (
    !Number.isInteger(capsule.currentStateGeneration) ||
    Number(capsule.currentStateGeneration) < 1
  ) {
    throw new Error("capsule ledger did not advance state generation");
  }
  const currentStateVersionId = capsuleCurrentStateVersionId(capsule);
  if (!currentStateVersionId) {
    throw new Error("capsule ledger did not expose currentStateVersionId");
  }
  const currentStateGeneration = Number(capsule.currentStateGeneration);

  const stateVersionsResponse = await requestJson<{
    readonly stateVersions?: readonly StateVersionRecord[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsules/${encodeURIComponent(
      input.capsuleId,
    )}/state-versions`,
  });
  const stateVersion = (stateVersionsResponse.stateVersions ?? []).find(
    (item) => item.id === currentStateVersionId,
  );
  if (!stateVersion) {
    throw new Error(
      "StateVersion ledger did not include currentStateVersionId",
    );
  }
  if (stateVersion.workspaceId !== input.workspaceId) {
    throw new Error("StateVersion ledger returned an unexpected Workspace id");
  }
  if (stateVersion.capsuleId !== input.capsuleId) {
    throw new Error("StateVersion ledger returned an unexpected Capsule id");
  }
  if (stateVersion.environment !== options.environment) {
    throw new Error(
      `StateVersion environment was ${stateVersion.environment}; expected ${options.environment}`,
    );
  }
  if (stateVersion.createdByRunId !== input.applyRunId) {
    throw new Error(
      "StateVersion ledger returned an unexpected createdByRunId",
    );
  }
  if (
    !Number.isInteger(stateVersion.generation) ||
    stateVersion.generation !== currentStateGeneration
  ) {
    throw new Error("StateVersion generation did not match Capsule");
  }

  const outputResponse = await requestJson<{
    readonly output?: OutputRecord | null;
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsules/${encodeURIComponent(input.capsuleId)}/outputs`,
  });
  const output = outputResponse.output;
  if (!output) {
    throw new Error("Output ledger did not expose the Capsule current Output");
  }
  if (output.workspaceId !== input.workspaceId) {
    throw new Error("Output ledger returned an unexpected Workspace id");
  }
  if (output.capsuleId !== input.capsuleId) {
    throw new Error("Output ledger returned an unexpected Capsule id");
  }
  if (output.stateGeneration !== stateVersion.generation) {
    throw new Error(
      "Output stateGeneration did not match StateVersion generation",
    );
  }
  if (!isRecord(output.publicOutputs)) {
    throw new Error("Output ledger did not expose publicOutputs");
  }
  const publicOutputs = output.publicOutputs;
  const publicOutputNames = Object.keys(publicOutputs).sort();
  return {
    capsuleStatus: capsule.status,
    stateVersionId: stateVersion.id,
    generation: stateVersion.generation,
    applyRunId: input.applyRunId,
    publicOutputNames,
    publicOutputDigest: digestJson(publicOutputs),
    publicOutputs,
  };
}

async function assertReleaseActivation(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly workspaceId: string;
    readonly applyRunId: string;
    readonly stateVersionId: string;
  },
): Promise<ReleaseActivationVerificationResult> {
  const deadline = Date.now() + options.deployTimeoutSeconds * 1000;
  let lastObservedStatus: ReleaseActivationStatus | undefined;
  while (Date.now() <= deadline) {
    const response = await requestJson<{
      readonly events?: readonly ActivityEventRecord[];
    }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/workspaces/${encodeURIComponent(input.workspaceId)}/activity?limit=50`,
    });
    const events = (response.events ?? []).filter((candidate) =>
      isReleaseActivationEvent(candidate, input),
    );
    for (const event of events) {
      lastObservedStatus = releaseActivationStatusFromAction(event.action);
      if (
        options.requireReleaseActivation === "any" ||
        lastObservedStatus === options.requireReleaseActivation
      ) {
        return releaseActivationVerificationResult(options, input, event);
      }
    }
    const terminalMismatch = events.find(
      (event) => releaseActivationStatusFromAction(event.action) !== "pending",
    );
    if (terminalMismatch) {
      return releaseActivationVerificationResult(
        options,
        input,
        terminalMismatch,
      );
    }
    await sleep(options.pollIntervalMs);
  }
  if (lastObservedStatus) {
    throw new Error(
      `release activation for apply run ${input.applyRunId} remained ${lastObservedStatus}; expected ${options.requireReleaseActivation}`,
    );
  }
  throw new Error(
    `apply Run ${input.applyRunId} did not emit release_activation Activity for StateVersion ${input.stateVersionId}`,
  );
}

function isReleaseActivationEvent(
  candidate: ActivityEventRecord,
  input: {
    readonly applyRunId: string;
    readonly stateVersionId: string;
  },
): candidate is ActivityEventRecord & {
  readonly action: string;
  readonly runId: string;
  readonly targetId: string;
  readonly targetType: "state_version";
} {
  if (!candidate.action?.startsWith("release_activation.")) return false;
  if (candidate.runId !== input.applyRunId) return false;
  if (candidate.targetId !== input.stateVersionId) return false;
  return candidate.targetType === "state_version";
}

function releaseActivationVerificationResult(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly applyRunId: string;
    readonly stateVersionId: string;
  },
  event: ActivityEventRecord & {
    readonly action: string;
    readonly runId: string;
    readonly targetId: string;
    readonly targetType: "state_version";
  },
): ReleaseActivationVerificationResult {
  const status = releaseActivationStatusFromAction(event.action);
  if (
    options.requireReleaseActivation !== "any" &&
    status !== options.requireReleaseActivation
  ) {
    throw new Error(
      `release activation for apply run ${input.applyRunId} was ${status}; expected ${options.requireReleaseActivation}`,
    );
  }
  const metadata = event.metadata ?? {};
  return {
    eventId: event.id ?? "",
    action: event.action,
    status,
    targetId: event.targetId,
    runId: event.runId,
    ...(typeof metadata.activationKind === "string"
      ? { activationKind: metadata.activationKind }
      : {}),
    ...(typeof metadata.commandCount === "number"
      ? { commandCount: metadata.commandCount }
      : {}),
    ...(typeof metadata.outputCount === "number"
      ? { outputCount: metadata.outputCount }
      : {}),
    metadataKeys: Object.keys(metadata).sort(),
  };
}

function releaseActivationStatusFromAction(
  action: string,
): Exclude<ReleaseActivationStatus, "skipped"> {
  const status = action.replace(/^release_activation\./u, "");
  if (status === "pending" || status === "succeeded" || status === "failed") {
    return status;
  }
  throw new Error(`release activation action ${action} has invalid status`);
}

async function assertCloudflareWorkerGone(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const workerName = cloudflareWorkerName(options, publicOutputs);
  const deadline = Date.now() + 60_000;
  let lastStatus = 0;
  while (Date.now() <= deadline) {
    const response = await cloudflareScriptRequest(options, "GET", workerName);
    lastStatus = response.status;
    if (response.status === 404) return;
    await sleep(2_000);
  }
  throw new Error(
    `Cloudflare Worker ${workerName} still existed after destroy (last HTTP ${lastStatus})`,
  );
}

async function assertPublicWorkerUrlGone(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const url = publicRuntimeUrl(options, publicOutputs);
  const deadline = Date.now() + 120_000;
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url, {
        headers: { accept: "text/html" },
      });
      lastStatus = response.status;
      lastBody = await response.text();
      if (
        response.status === 404 ||
        !(response.ok && isCurrentTakosumiHelloPage(lastBody))
      ) {
        return;
      }
    } catch (error) {
      lastBody = error instanceof Error ? error.message : String(error);
      return;
    }
    await sleep(2_000);
  }
  throw new Error(
    `Cloudflare Worker public URL still served the Takosumi page after destroy (last HTTP ${lastStatus}, body ${JSON.stringify(
      lastBody.slice(0, 120),
    )})`,
  );
}

async function cloudflareScriptRequest(
  options: PlatformControlPlaneSmokeOptions,
  method: "GET" | "DELETE",
  workerName = options.appName,
): Promise<Response> {
  return await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      options.cloudflareAccountId,
    )}/workers/scripts/${encodeURIComponent(workerName)}`,
    {
      method,
      headers: {
        authorization: `Bearer ${options.cloudflareApiToken}`,
        accept: "application/json",
      },
    },
  );
}

async function revokeConnection(
  options: PlatformControlPlaneSmokeOptions,
  connectionId: string,
): Promise<boolean> {
  try {
    await requestJson({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/connections/${encodeURIComponent(
        connectionId,
      )}/revoke`,
      body: {},
      allowEmpty: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function requestJson<T = unknown>(options: RequestOptions): Promise<T> {
  if (shouldUseNodeHttpTransport(options)) {
    return await requestJsonWithNodeTransport<T>(options);
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${options.token}`,
  };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  const controller =
    options.timeoutMs && options.timeoutMs > 0
      ? new AbortController()
      : undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (controller) {
    init.signal = controller.signal;
    timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  }
  if (options.binary !== undefined) {
    headers["content-type"] = "application/zstd";
    init.body = options.binary as unknown as BodyInit;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${options.path}`, init);
  } catch (error) {
    if (
      controller?.signal.aborted ||
      (options.timeoutMs !== undefined && isFetchTimeoutError(error))
    ) {
      throw new RequestTimeoutError(
        options.method ?? "GET",
        options.path,
        options.timeoutMs ?? 0,
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const text = await response.text();
  const body = parseResponseBody(
    text,
    `${options.method ?? "GET"} ${options.path}`,
  );
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${options.path} failed (${response.status}): ${apiErrorMessage(
        body,
        `HTTP ${response.status}`,
      )}`,
    );
  }
  if (body === undefined) {
    if (options.allowEmpty) return {} as T;
    throw new Error(
      `${options.method ?? "GET"} ${options.path} returned empty response`,
    );
  }
  return body as T;
}

function shouldUseNodeHttpTransport(options: RequestOptions): boolean {
  if (options.transport === "native") return false;
  if (options.transport === "node") return true;
  return process.env.TAKOSUMI_SMOKE_HTTP_TRANSPORT === "node";
}

async function requestJsonWithNodeTransport<T = unknown>(
  options: RequestOptions,
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  const input: NodeHttpTransportInput = {
    url: `${options.baseUrl}${options.path}`,
    method,
    headers,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  };
  let transportInput: NodeHttpTransportInput;
  if (options.binary !== undefined) {
    transportInput = {
      ...input,
      headers: { ...headers, "content-type": "application/zstd" },
      binaryBase64: Buffer.from(options.binary).toString("base64"),
    };
  } else if (options.body !== undefined) {
    transportInput = {
      ...input,
      headers: { ...headers, "content-type": "application/json" },
      bodyText: JSON.stringify(options.body),
    };
  } else {
    transportInput = input;
  }
  const result = await runNodeHttpTransport(
    transportInput,
    options.token,
    method,
    options.path,
  );
  if (!result.ok) {
    if (result.timeout) {
      throw new RequestTimeoutError(
        method,
        options.path,
        options.timeoutMs ?? 0,
      );
    }
    throw new Error(
      `${method} ${options.path} failed in node HTTP transport: ${publicErrorMessage(
        result.message ?? result.name ?? "unknown error",
      )}`,
    );
  }
  const text = result.bodyText ?? "";
  const body = parseResponseBody(text, `${method} ${options.path}`);
  const status = result.status ?? 0;
  if (status < 200 || status >= 300) {
    throw new Error(
      `${method} ${options.path} failed (${status}): ${apiErrorMessage(
        body,
        `HTTP ${status}`,
      )}`,
    );
  }
  if (body === undefined) {
    if (options.allowEmpty) return {} as T;
    throw new Error(`${method} ${options.path} returned empty response`);
  }
  return body as T;
}

async function runNodeHttpTransport(
  input: NodeHttpTransportInput,
  token: string,
  method: string,
  path: string,
): Promise<NodeHttpTransportResult> {
  const nodeBinary = process.env.TAKOSUMI_NODE_BINARY ?? "node";
  const child = spawn(nodeBinary, ["-e", NODE_HTTP_TRANSPORT_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: nodeHttpTransportEnv(token),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const timeoutMs =
    input.timeoutMs !== undefined && input.timeoutMs > 0
      ? input.timeoutMs + 5_000
      : undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new RequestTimeoutError(method, path, input.timeoutMs ?? 0));
      }, timeoutMs);
    }
    child.stdin.end(`${JSON.stringify(input)}\n`);
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  const stderrText = Buffer.concat(stderr).toString("utf8").trim();
  if (exitCode !== 0) {
    throw new Error(
      `${method} ${path} node HTTP transport exited ${exitCode}: ${redactResponseSnippet(
        stderrText,
      )}`,
    );
  }
  const raw = Buffer.concat(stdout).toString("utf8");
  try {
    return parseJsonRecord(
      raw,
      "node HTTP transport result",
    ) as unknown as NodeHttpTransportResult;
  } catch (error) {
    throw new Error(
      `${method} ${path} node HTTP transport returned invalid result: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function nodeHttpTransportEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TAKOSUMI_SMOKE_HTTP_TOKEN: token };
  for (const name of [
    "PATH",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function isFetchTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function parseResponseBody(text: string, label: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `${label} returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return {
    message: `${label} returned non-JSON response: ${redactResponseSnippet(
      trimmed,
    )}`,
  };
}

function redactResponseSnippet(value: string): string {
  return publicErrorMessage(value.replace(/\s+/g, " ").slice(0, 240));
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === "string") return errorRecord.message;
    if (typeof errorRecord.code === "string") return errorRecord.code;
  }
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  return fallback;
}

function cloudflareApiSuccess(body: unknown): boolean {
  return isRecord(body) && body.success === true;
}

function cloudflareApiErrorCode(body: unknown): string {
  if (!isRecord(body)) return "unknown_error";
  const errors = body.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "unknown_error";
  const first = errors[0];
  if (!isRecord(first)) return "unknown_error";
  const code = typeof first.code === "number" ? String(first.code) : undefined;
  const message = typeof first.message === "string" ? first.message : undefined;
  return [code, message].filter(Boolean).join(": ") || "unknown_error";
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(
      /\b((?:token|secret|authorization|cookie)=)[^\s&]+/giu,
      "$1<redacted>",
    )
    .replace(/(takosumi_session=)[^;\s]+/giu, "$1<redacted>");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = camel(rawKey);
    if (inline !== undefined) {
      args[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args as CliArgs;
}

function camel(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

async function readSecret(input: {
  readonly file?: string;
  readonly envValue?: string;
  readonly envName: string;
  readonly label: string;
  readonly dryRun: boolean;
}): Promise<{ readonly value: string; readonly source: "env" | "file" }> {
  if (input.file) {
    if (input.dryRun) return { value: "<redacted>", source: "file" };
    const value = (await readFile(input.file, "utf8")).trim();
    if (!value) throw new Error(`${input.label} file is empty`);
    return { value, source: "file" };
  }
  if (input.envValue) {
    return {
      value: input.dryRun ? "<redacted>" : input.envValue,
      source: "env",
    };
  }
  throw new Error(
    `${input.label} is required: pass the matching --*-file option or set ${input.envName}`,
  );
}

async function readNonSecretInput(input: {
  readonly file?: string;
  readonly value?: string;
  readonly envValue?: string;
  readonly envName: string;
  readonly label: string;
  readonly dryRun: boolean;
  readonly hint: string;
}): Promise<{
  readonly value: string;
  readonly source: "env" | "file" | "arg";
}> {
  if (input.file) {
    if (input.dryRun) return { value: "<redacted>", source: "file" };
    const value = (await readFile(input.file, "utf8")).trim();
    if (!value) throw new Error(`${input.label} file is empty`);
    return { value, source: "file" };
  }
  if (input.value) {
    return {
      value: input.dryRun ? "<redacted>" : input.value,
      source: "arg",
    };
  }
  if (input.envValue) {
    return {
      value: input.dryRun ? "<redacted>" : input.envValue,
      source: "env",
    };
  }
  throw new Error(`${input.label} is required: ${input.hint}`);
}

function parsePositiveInteger(
  raw: string | undefined,
  label: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(raw);
}

function parseFunctionalProbeEnvNames(
  raw: string | undefined,
): readonly string[] {
  if (!raw?.trim()) return [];
  const names = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error(
        "--functional-probe-env must be a comma-separated list of uppercase environment variable names",
      );
    }
  }
  return names.sort();
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/g, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseCloudflareConnectionMode(
  value: string | undefined,
): SmokeProviderConnectionMode {
  if (value === undefined || value.trim() === "" || value === "none")
    return "none";
  if (value === "guided") return "guided";
  if (value === "generic-env") return "generic-env";
  if (value === "none") return "none";
  throw new Error(
    "--cloudflare-connection-mode must be guided, generic-env, or none",
  );
}

function parseAuthTokenKind(value: string | undefined): SmokeAuthTokenKind {
  if (value === undefined || value.trim() === "" || value === "session") {
    return "session";
  }
  if (value === "pat") return "pat";
  throw new Error("--auth-token-kind must be session or pat");
}

function parseVerificationMode(
  value: string | undefined,
): SmokeVerificationMode {
  if (value === undefined || value.trim() === "" || value === "opentofu")
    return "opentofu";
  if (value === "cloudflare-worker") return "cloudflare-worker";
  throw new Error("--verification-mode must be cloudflare-worker or opentofu");
}

function parseCloudflareResourcePreflight(
  value: string | undefined,
): CloudflareResourcePreflightMode {
  if (value === undefined || value.trim() === "" || value === "none") {
    return "none";
  }
  if (value === "d1") return "d1";
  if (value === "account-resources") return "account-resources";
  throw new Error(
    "--cloudflare-resource-preflight must be account-resources, d1, or none",
  );
}

function parseReleaseActivationRequirement(
  value: string | undefined,
): ReleaseActivationRequirement | undefined {
  if (value === undefined || value.trim() === "" || value === "none") {
    return undefined;
  }
  if (
    value === "any" ||
    value === "pending" ||
    value === "succeeded" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error(
    "--require-release-activation must be any, pending, succeeded, failed, or none",
  );
}

function dryRunReleaseActivationStatus(
  requirement: ReleaseActivationRequirement,
): Exclude<ReleaseActivationStatus, "skipped"> {
  return requirement === "any" ? "succeeded" : requirement;
}

function defaultSmokeVars(input: {
  readonly accountId: string;
  readonly appName: string;
  readonly workersSubdomain: string;
  readonly providerless?: boolean;
}): Readonly<Record<string, JsonSmokeValue>> {
  if (input.providerless) {
    return {
      name: input.appName,
      base_url: `https://${input.appName}.example.invalid`,
    };
  }
  return {
    target: "cloudflare",
    project_name: input.appName,
    cloudflare: {
      account_id: input.accountId,
      workers_subdomain: input.workersSubdomain,
    },
  };
}

function mergeJsonRecords(
  base: Readonly<Record<string, JsonSmokeValue>>,
  override: Readonly<Record<string, JsonSmokeValue>>,
): Readonly<Record<string, JsonSmokeValue>> {
  const merged: Record<string, JsonSmokeValue> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = merged[key];
    if (isPlainJsonObject(baseValue) && isPlainJsonObject(value)) {
      merged[key] = mergeJsonRecords(baseValue, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainJsonObject(
  value: JsonSmokeValue | undefined,
): value is Readonly<Record<string, JsonSmokeValue>> {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object"
  );
}

function defaultSmokeOutputAllowlist(
  providerless: boolean,
): SmokeOutputAllowlist {
  if (providerless) {
    return {
      example_label: {
        from: "example_label",
        type: "string",
        required: true,
      },
      example_endpoint: {
        from: "example_endpoint",
        type: "url",
        required: true,
      },
    };
  }
  return {
    worker_name: { from: "worker_name", type: "string", required: true },
    url: { from: "url", type: "url", required: true },
  };
}

async function readJsonRecordInput(input: {
  readonly inline?: string;
  readonly file?: string;
  readonly label: string;
  readonly fallback: Readonly<Record<string, JsonSmokeValue>>;
}): Promise<Readonly<Record<string, JsonSmokeValue>>> {
  if (input.inline !== undefined) {
    return parseJsonRecord(input.inline, input.label);
  }
  if (input.file !== undefined) {
    return parseJsonRecord(await readFile(input.file, "utf8"), input.label);
  }
  return input.fallback;
}

async function readJsonValueInput(input: {
  readonly inline?: string;
  readonly file?: string;
  readonly label: string;
  readonly fallback: JsonSmokeValue;
}): Promise<JsonSmokeValue> {
  if (input.inline !== undefined) {
    return parseJsonValue(input.inline, input.label);
  }
  if (input.file !== undefined) {
    return parseJsonValue(await readFile(input.file, "utf8"), input.label);
  }
  return input.fallback;
}

function parseJsonRecord(
  raw: string,
  label: string,
): Readonly<Record<string, JsonSmokeValue>> {
  const parsed = parseJsonValue(raw, label);
  if (!isJsonRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseJsonValue(raw: string, label: string): JsonSmokeValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isJsonSmokeValue(parsed)) {
    throw new Error(`${label} must be JSON-compatible`);
  }
  return parsed;
}

function parseOutputAllowlist(
  value: Readonly<Record<string, JsonSmokeValue>>,
): SmokeOutputAllowlist {
  const out: Record<
    string,
    {
      from: string;
      type: SmokeOutputAllowlistType;
      required?: boolean;
    }
  > = {};
  for (const [name, spec] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `output allowlist key ${JSON.stringify(name)} must be an OpenTofu identifier`,
      );
    }
    if (!isRecord(spec) || typeof spec.from !== "string" || !spec.from) {
      throw new Error(
        `output allowlist ${name} must include a non-empty string "from" field`,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.from)) {
      throw new Error(
        `output allowlist ${name}.from must be an OpenTofu output identifier`,
      );
    }
    if (!isOutputAllowlistType(spec.type)) {
      throw new Error(
        `output allowlist ${name}.type must be one of string, url, hostname, number, boolean, json`,
      );
    }
    out[name] = {
      from: spec.from,
      type: spec.type,
      ...(typeof spec.required === "boolean"
        ? { required: spec.required }
        : {}),
    };
  }
  return out;
}

function parseExplicitProjectedOutputName(input: {
  readonly raw?: string;
  readonly label: string;
  readonly outputAllowlist: SmokeOutputAllowlist;
  readonly acceptedTypes: readonly SmokeOutputAllowlistType[];
}): string | undefined {
  const name = input.raw?.trim();
  if (!name) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`${input.label} must be an OpenTofu output identifier`);
  }
  const projection = input.outputAllowlist[name];
  if (!projection) {
    throw new Error(`${input.label} must also be in the output allowlist`);
  }
  if (!input.acceptedTypes.includes(projection.type)) {
    throw new Error(
      `${input.label} must reference an output projected as ${input.acceptedTypes.join(" or ")}`,
    );
  }
  return name;
}

function isOutputAllowlistType(
  value: unknown,
): value is SmokeOutputAllowlistType {
  return (
    value === "string" ||
    value === "url" ||
    value === "hostname" ||
    value === "number" ||
    value === "boolean" ||
    value === "json"
  );
}

function parsePublicUrlChecks(
  value: JsonSmokeValue,
  outputAllowlist: SmokeOutputAllowlist,
): readonly PublicUrlCheck[] {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parsePublicUrlCheck(entry, index, outputAllowlist),
    );
  }
  if (isRecord(value) && Object.keys(value).length === 0) return [];
  throw new Error("public URL checks must be a JSON array");
}

function parsePublicUrlCheck(
  value: JsonSmokeValue,
  index: number,
  outputAllowlist: SmokeOutputAllowlist,
): PublicUrlCheck {
  if (!isRecord(value)) {
    throw new Error(`public URL checks[${index}] must be an object`);
  }
  const output = stringField(value, "output");
  if (!output || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(output)) {
    throw new Error(
      `public URL checks[${index}].output must be an output name`,
    );
  }
  if (!(output in outputAllowlist)) {
    throw new Error(
      `public URL checks[${index}].output must also be in the output allowlist`,
    );
  }
  const name = stringField(value, "name") ?? output;
  if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(name)) {
    throw new Error(`public URL checks[${index}].name is invalid`);
  }
  const path = stringField(value, "path") ?? "/";
  if (!path.startsWith("/") || /[\0\r\n]/u.test(path)) {
    throw new Error(`public URL checks[${index}].path must start with /`);
  }
  const expectedStatus = numberField(value, "expectedStatus") ?? 200;
  if (
    !Number.isInteger(expectedStatus) ||
    expectedStatus < 100 ||
    expectedStatus > 599
  ) {
    throw new Error(
      `public URL checks[${index}].expectedStatus must be an HTTP status`,
    );
  }
  const bodyIncludes = stringArrayField(value, "bodyIncludes");
  return {
    name,
    output,
    path,
    expectedStatus,
    bodyIncludes,
  };
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringArrayField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    return value;
  }
  throw new Error(`${key} must be a string array`);
}

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, JsonSmokeValue>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonSmokeValue);
}

function isJsonSmokeValue(value: unknown): value is JsonSmokeValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number";
  }
  if (Array.isArray(value)) return value.every(isJsonSmokeValue);
  return isJsonRecord(value);
}

function normalizeSmokeSourceGitUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error(
      "--source-git-url must not include embedded credentials; use a public fixture repo or a Source Git Connection",
    );
  }
  url.hash = "";
  return url.toString();
}

function defaultCapsuleName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `takosumi-smoke-${suffix}`;
}

function capsuleLabel(options: PlatformControlPlaneSmokeOptions): string {
  void options;
  return "git-opentofu-capsule";
}

function publicInputSummary(options: PlatformControlPlaneSmokeOptions): {
  readonly accountSessionTokenSource: "env" | "file";
  readonly accountAuthTokenKind: SmokeAuthTokenKind;
  readonly cloudflareApiTokenSource: SecretInputSource;
  readonly cloudflareAccountIdSource: NonSecretInputSource;
  readonly cloudflareAccountIdDigest: string;
  readonly cloudflareWorkersSubdomainSource: NonSecretInputSource;
  readonly cloudflareConnectionMode: SmokeProviderConnectionMode;
  readonly cloudflareResourcePreflight: CloudflareResourcePreflightMode;
  readonly runnerProfileId?: string;
  readonly sourceMode: "git";
  readonly verificationMode: SmokeVerificationMode;
  readonly varsDigest: string;
  readonly outputAllowlistNames: readonly string[];
  readonly publicUrlCheckNames: readonly string[];
  readonly cloudflareWorkerNameOutput?: string;
  readonly runtimePublicUrlOutput?: string;
  readonly functionalProbeScriptDigest?: string;
  readonly functionalProbeEnvNames: readonly string[];
  readonly capsuleDir?: string;
  readonly sourceGitUrlDigest?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
  readonly storeMetadataDigest?: string;
} {
  return {
    accountSessionTokenSource: options.accountSessionTokenSource,
    accountAuthTokenKind: options.accountAuthTokenKind,
    cloudflareApiTokenSource: options.cloudflareApiTokenSource,
    cloudflareAccountIdSource: options.cloudflareAccountIdSource,
    cloudflareAccountIdDigest:
      options.cloudflareAccountIdSource === "not_required"
        ? "not_required"
        : sha256(options.cloudflareAccountId),
    cloudflareWorkersSubdomainSource: options.cloudflareWorkersSubdomainSource,
    cloudflareConnectionMode: options.cloudflareConnectionMode,
    cloudflareResourcePreflight: options.cloudflareResourcePreflight,
    ...(options.runnerProfileId
      ? { runnerProfileId: options.runnerProfileId }
      : {}),
    sourceMode: options.sourceMode,
    verificationMode: options.verificationMode,
    varsDigest: digestJson(options.vars),
    outputAllowlistNames: Object.keys(options.outputAllowlist).sort(),
    publicUrlCheckNames: options.publicUrlChecks.map((check) => check.name),
    ...(options.cloudflareWorkerNameOutput
      ? { cloudflareWorkerNameOutput: options.cloudflareWorkerNameOutput }
      : {}),
    ...(options.runtimePublicUrlOutput
      ? { runtimePublicUrlOutput: options.runtimePublicUrlOutput }
      : {}),
    ...(options.functionalProbeScriptDigest
      ? { functionalProbeScriptDigest: options.functionalProbeScriptDigest }
      : {}),
    functionalProbeEnvNames: options.functionalProbeEnvNames,
    ...(options.sourceGitUrl
      ? {
          sourceGitUrlDigest: sha256(options.sourceGitUrl),
          ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
          sourcePath: options.sourcePath ?? ".",
          ...(options.modulePath ? { modulePath: options.modulePath } : {}),
          ...(options.installConfigId
            ? { installConfigId: options.installConfigId }
            : {}),
          ...(options.storeMetadata
            ? { storeMetadataDigest: digestJson(options.storeMetadata) }
            : {}),
        }
      : {}),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestJson(value: unknown): string {
  return sha256(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runCapsuleFunctionalProbe(
  options: PlatformControlPlaneSmokeOptions,
  publicOutputs: Readonly<Record<string, unknown>>,
): Promise<CapsuleFunctionalProbeEvidence> {
  const script = options.functionalProbeScript;
  if (!script) throw new Error("functional probe script is not configured");
  const startedAtMs = Date.now();
  const tempDir = await mkdtemp(resolve(tmpdir(), "takosumi-capsule-probe-"));
  const outputsFile = resolve(tempDir, "outputs.json");
  await writeFile(outputsFile, `${JSON.stringify(publicOutputs)}\n`, {
    mode: 0o600,
  });
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tempDir,
    TMPDIR: tempDir,
    TAKOSUMI_CAPSULE_OUTPUTS_FILE: outputsFile,
    TAKOSUMI_CAPSULE_APP_NAME: options.appName,
    TAKOSUMI_CAPSULE_WORKSPACE_ID: options.workspace,
  };
  for (const name of options.functionalProbeEnvNames) {
    const value = process.env[name];
    if (!value) {
      throw new Error(
        `functional probe environment variable ${name} is not set`,
      );
    }
    childEnv[name] = value;
  }

  try {
    const child = spawn(process.execPath, [script], {
      cwd: dirname(script),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let spawnError: Error | undefined;
    let timedOut = false;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.deployTimeoutSeconds * 1000);
    const exitCode = await new Promise<number>((resolveExit) => {
      child.on("close", (code) => resolveExit(code ?? 1));
    });
    clearTimeout(timeout);
    if (spawnError) throw spawnError;
    if (timedOut) {
      throw new Error(
        `functional probe did not finish within ${options.deployTimeoutSeconds}s`,
      );
    }
    if (outputBytes > 1024 * 1024) {
      throw new Error("functional probe output exceeded 1 MiB");
    }
    if (exitCode !== 0) {
      const detail = publicErrorMessage(
        Buffer.concat(stderr).toString("utf8").trim(),
      ).slice(0, 2_000);
      throw new Error(
        `functional probe exited with ${exitCode}${detail ? `: ${detail}` : ""}`,
      );
    }
    const raw = Buffer.concat(stdout).toString("utf8").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("functional probe stdout must be one JSON object");
    }
    const result = assertCapsuleFunctionalProbeResult(parsed);
    return {
      product: result.product,
      checkNames: result.checks.map((check) => check.name),
      cleanupVerified: result.cleanupVerified === true,
      cleanupMode:
        result.cleanupVerified === true ? "probe" : "opentofu-destroy",
      resultDigest: digestJson(result),
      scriptDigest:
        options.functionalProbeScriptDigest ??
        sha256(await readFile(script, "utf8")),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function assertCapsuleFunctionalProbeResult(
  value: unknown,
): CapsuleFunctionalProbeResult {
  if (!isRecord(value))
    throw new Error("functional probe result must be an object");
  if (value.kind !== "takosumi.capsule-functional-probe@v1") {
    throw new Error("functional probe result kind is invalid");
  }
  if (value.status !== "passed") {
    throw new Error("functional probe result did not pass");
  }
  if (typeof value.product !== "string" || !value.product.trim()) {
    throw new Error("functional probe result product is required");
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    throw new Error("functional probe result requires at least one check");
  }
  const checks = value.checks.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      entry.status !== "passed"
    ) {
      throw new Error(
        "functional probe checks must have a name and passed status",
      );
    }
    return { name: entry.name.trim(), status: "passed" as const };
  });
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    throw new Error("functional probe check names must be unique");
  }
  if (
    value.cleanupVerified !== true &&
    value.cleanupDelegatedToDestroy !== true
  ) {
    throw new Error(
      "functional probe must verify cleanup or delegate it to OpenTofu destroy",
    );
  }
  if (
    value.cleanupVerified === true &&
    value.cleanupDelegatedToDestroy === true
  ) {
    throw new Error(
      "functional probe cleanup cannot be both verified and delegated",
    );
  }
  return {
    kind: "takosumi.capsule-functional-probe@v1",
    status: "passed",
    product: value.product.trim(),
    checks,
    ...(value.cleanupVerified === true
      ? { cleanupVerified: true }
      : { cleanupDelegatedToDestroy: true }),
  };
}

function finalizeFunctionalProbeCleanup(
  evidence: CapsuleFunctionalProbeEvidence | undefined,
): CapsuleFunctionalProbeEvidence | undefined {
  if (!evidence || evidence.cleanupMode !== "opentofu-destroy") return evidence;
  return { ...evidence, cleanupVerified: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredSteps(
  options?: Pick<
    PlatformControlPlaneSmokeOptions,
    | "backupRestoreRehearsal"
    | "keepConnection"
    | "sourceMode"
    | "cloudflareConnectionMode"
    | "cloudflareResourcePreflight"
    | "verificationMode"
    | "requireReleaseActivation"
    | "publicUrlChecks"
    | "outputAllowlist"
    | "functionalProbeScript"
  >,
): readonly string[] {
  const steps = [
    ...(options?.cloudflareConnectionMode === "none"
      ? ["providerConnectionNotRequired"]
      : ["workspaceScopedProviderConnection"]),
    ...(options?.cloudflareConnectionMode === "generic-env"
      ? ["genericEnvProviderConnection"]
      : []),
    ...(options?.cloudflareConnectionMode === "none"
      ? []
      : ["connectionVerified"]),
    ...(options?.cloudflareResourcePreflight &&
    options.cloudflareResourcePreflight !== "none"
      ? ["cloudflareResourcePreflight"]
      : []),
    ...(options?.sourceMode === "git" ? ["sourceRegistered"] : []),
    ...(options?.sourceMode === "git" ? ["sourceSynced"] : []),
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    ...(options?.verificationMode === "opentofu"
      ? [
          "opentofuApplyVerified",
          ...(shouldVerifyCloudflareWorker(options) ? ["runtimeVerified"] : []),
        ]
      : ["runtimeVerified", "publicUrlVerified"]),
    "stateVersionLedgerVerified",
  ];
  if (options?.requireReleaseActivation) {
    steps.push("releaseActivationVerified");
  }
  if (
    options?.verificationMode === "opentofu" &&
    options.publicUrlChecks.length > 0
  ) {
    steps.push("publicUrlVerified");
  }
  if (options?.functionalProbeScript) {
    steps.push("functionalProbe");
  }
  if (options?.backupRestoreRehearsal) {
    steps.push("backupRestoreRehearsal");
  }
  steps.push("destroy");
  if (
    options &&
    !options.keepConnection &&
    options.cloudflareConnectionMode !== "none"
  ) {
    steps.push("connectionRevoked");
  }
  return steps;
}

function shouldVerifyCloudflareWorker(
  options?: Pick<
    PlatformControlPlaneSmokeOptions,
    "verificationMode"
  >,
): boolean {
  return options?.verificationMode === "cloudflare-worker";
}

async function writeResult(
  result: PlatformControlPlaneSmokeResult,
  options: PlatformControlPlaneSmokeOptions,
): Promise<void> {
  if (options.outFile) {
    await writeResultFile(options.outFile, result);
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label =
    result.status === "passed"
      ? "PASS"
      : result.status === "failed"
        ? "FAIL"
        : "DRY RUN";
  console.log(`${label} ${result.kind}`);
  console.log(`service: ${result.serviceUrl}`);
  console.log(`workspace: ${result.scratchWorkspaceId}`);
  console.log(`provider connection: ${result.providerConnectionMode}`);
  console.log(`source mode: ${result.sourceMode}`);
  console.log(`verification mode: ${result.verificationMode}`);
  console.log(`capsule: ${result.capsuleModule}`);
  console.log(`app: ${result.appName}`);
  if (result.verificationMode === "cloudflare-worker") {
    console.log(`worker URL: ${result.workerUrl}`);
  }
  console.log(
    `public URL verified: ${result.publicUrlVerified ? "yes" : "no"}`,
  );
  if (result.releaseActivation) {
    console.log(`release activation: ${result.releaseActivation.status}`);
  }
  if (result.capsuleId) console.log(`capsule id: ${result.capsuleId}`);
  if (result.sourceSyncRunId)
    console.log(`source sync run: ${result.sourceSyncRunId}`);
  if (result.applyRunId) console.log(`apply run: ${result.applyRunId}`);
  if (result.destroyApplyRunId) {
    console.log(`destroy apply run: ${result.destroyApplyRunId}`);
  }
  if (result.connectionRevoked !== undefined) {
    console.log(
      `connection revoked: ${result.connectionRevoked ? "yes" : "no"}`,
    );
  }
  if (result.error) console.log(`error: ${result.error}`);
  if (result.nextAction) console.log(`next: ${result.nextAction}`);
}

async function writeResultFile(
  outFile: string,
  result: PlatformControlPlaneSmokeResult,
): Promise<void> {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`);
}

async function runSelfTest(): Promise<void> {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
    },
    {},
  );
  const result = dryRunResult(options);
  const serialized = JSON.stringify(result);
  const tempRoot = await mkdtemp(resolve(tmpdir(), "takosumi-platform-smoke-"));
  try {
    const outFile = resolve(tempRoot, "nested/smoke.json");
    await writeResultFile(outFile, result);
    const saved = JSON.parse(await readFile(outFile, "utf8"));
    if (saved.kind !== PLATFORM_CONTROL_PLANE_SMOKE_KIND) {
      throw new Error("self-test did not write out-file JSON result");
    }
    if (JSON.stringify(saved).includes("account-session-token")) {
      throw new Error(
        "self-test out-file leaked account session token file name",
      );
    }
    const probeScript = resolve(tempRoot, "probe.ts");
    await writeFile(
      probeScript,
      `console.log(JSON.stringify({kind:"takosumi.capsule-functional-probe@v1",status:"passed",product:"self-test",checks:[{name:"round-trip",status:"passed"}],cleanupVerified:true}));\n`,
    );
    const probeEvidence = await runCapsuleFunctionalProbe(
      {
        ...options,
        functionalProbeScript: probeScript,
        functionalProbeScriptDigest: sha256(
          await readFile(probeScript, "utf8"),
        ),
        functionalProbeEnvNames: [],
      },
      { url: "https://example.test" },
    );
    if (
      probeEvidence.product !== "self-test" ||
      probeEvidence.checkNames.join(",") !== "round-trip" ||
      probeEvidence.cleanupVerified !== true ||
      probeEvidence.cleanupMode !== "probe"
    ) {
      throw new Error("self-test functional probe evidence is invalid");
    }
    const delegatedProbeScript = resolve(tempRoot, "delegated-probe.ts");
    await writeFile(
      delegatedProbeScript,
      `console.log(JSON.stringify({kind:"takosumi.capsule-functional-probe@v1",status:"passed",product:"delegated-self-test",checks:[{name:"leave-data",status:"passed"}],cleanupDelegatedToDestroy:true}));\n`,
    );
    const delegatedProbe = await runCapsuleFunctionalProbe(
      {
        ...options,
        functionalProbeScript: delegatedProbeScript,
        functionalProbeScriptDigest: sha256(
          await readFile(delegatedProbeScript, "utf8"),
        ),
        functionalProbeEnvNames: [],
      },
      { url: "https://example.test" },
    );
    const finalizedProbe = finalizeFunctionalProbeCleanup(delegatedProbe);
    if (
      delegatedProbe.cleanupVerified !== false ||
      delegatedProbe.cleanupMode !== "opentofu-destroy" ||
      finalizedProbe?.cleanupVerified !== true
    ) {
      throw new Error("self-test delegated cleanup evidence is invalid");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  if (options.deployTimeoutSeconds !== DEFAULT_DEPLOY_TIMEOUT_SECONDS) {
    throw new Error("self-test default deploy timeout is wrong");
  }
  if (serialized.includes("account-session-token")) {
    throw new Error("self-test leaked account session token file name");
  }
  if (serialized.includes("cloudflare-token")) {
    throw new Error("self-test leaked Cloudflare token file name");
  }
  if (serialized.includes("cloudflare-account-id")) {
    throw new Error("self-test leaked Cloudflare account id file name");
  }
  if (serialized.includes("cloudflare-workers-subdomain")) {
    throw new Error("self-test leaked Cloudflare Workers subdomain file name");
  }
  if (serialized.includes("acc_selftest")) {
    throw new Error("self-test leaked Cloudflare account id");
  }
  if (result.sourceMode !== "git") {
    throw new Error("self-test default source mode is not git");
  }
  if (result.providerConnectionMode !== "guided") {
    throw new Error("self-test default Provider Connection mode is not guided");
  }
  if (!result.steps.includes("destroy")) {
    throw new Error("self-test result is missing destroy step");
  }
  const genericEnvOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      cloudflareConnectionMode: "generic-env",
    },
    {},
  );
  const genericEnvResult = dryRunResult(genericEnvOptions);
  const serializedGenericEnv = JSON.stringify(genericEnvResult);
  if (genericEnvResult.providerConnectionMode !== "generic-env") {
    throw new Error("self-test did not enable generic-env connection mode");
  }
  if (!genericEnvResult.steps.includes("genericEnvProviderConnection")) {
    throw new Error("generic-env self-test result is missing connection step");
  }
  if (
    serializedGenericEnv.includes("cloudflare-token") ||
    serializedGenericEnv.includes("cloudflare-account-id")
  ) {
    throw new Error("generic-env self-test leaked secret file names");
  }
  const opentofuOnlyOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      capsuleDir: "/private/custom-opentofu-module",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      verificationMode: "opentofu",
      varsJson:
        '{"target":"cloudflare","project_name":"takosumi-smoke-selftest","environment":"selftest","cloudflare":{"account_id":"acc_selftest"}}',
      outputAllowlistJson:
        '{"target":{"from":"target","type":"string","required":true}}',
    },
    {},
  );
  const opentofuOnlyResult = dryRunResult(opentofuOnlyOptions);
  const serializedOpenTofuOnly = JSON.stringify(opentofuOnlyResult);
  if (opentofuOnlyResult.verificationMode !== "opentofu") {
    throw new Error("self-test did not enable OpenTofu-only verification");
  }
  if (!opentofuOnlyResult.steps.includes("opentofuApplyVerified")) {
    throw new Error("OpenTofu-only self-test result is missing apply proof");
  }
  if (opentofuOnlyResult.steps.includes("publicUrlVerified")) {
    throw new Error("OpenTofu-only self-test should not require public URL");
  }
  if (opentofuOnlyResult.publicUrlVerified !== false) {
    throw new Error("OpenTofu-only self-test should not report public URL");
  }
  if (serializedOpenTofuOnly.includes("acc_selftest")) {
    throw new Error("OpenTofu-only self-test leaked vars content");
  }
  const providerlessOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      capsuleDir: "/private/keyless-opentofu-module",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      varsJson:
        '{"name":"takosumi-keyless-selftest","base_url":"https://example.invalid/keyless"}',
      outputAllowlistJson:
        '{"url":{"from":"url","type":"url","required":true},"worker_name":{"from":"worker_name","type":"string","required":true}}',
    },
    {},
  );
  const providerlessResult = dryRunResult(providerlessOptions);
  const serializedProviderless = JSON.stringify(providerlessResult);
  if (providerlessResult.providerConnectionMode !== "none") {
    throw new Error("providerless self-test did not enable none mode");
  }
  if (providerlessResult.credentialPath !== "none") {
    throw new Error("providerless self-test should not report credentials");
  }
  if (!providerlessResult.steps.includes("providerConnectionNotRequired")) {
    throw new Error("providerless self-test is missing no-connection step");
  }
  if (
    providerlessResult.steps.includes("workspaceScopedProviderConnection") ||
    providerlessResult.steps.includes("connectionVerified") ||
    providerlessResult.steps.includes("connectionRevoked")
  ) {
    throw new Error("providerless self-test should not require connections");
  }
  if (providerlessResult.connectionRevoked !== undefined) {
    throw new Error("providerless self-test should not report revocation");
  }
  if (serializedProviderless.includes("keyless-selftest")) {
    throw new Error("providerless self-test leaked vars content");
  }
  const managedCompatOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      capsuleDir: "/private/takos-opentofu-module",
      appName: "takos-managed-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      varsJson:
        '{"target":"cloudflare","project_name":"takos-managed-selftest","environment":"selftest","cloudflare":{"account_id":"ts_acc_takosumi_cloud","api_base_url":"https://app.takosumi.com/compat/cloudflare/client/v4","workers_subdomain":"app.takos.jp"}}',
      outputAllowlistJson:
        '{"published_endpoint":{"from":"url","type":"url","required":true},"runtime_resource":{"from":"worker_name","type":"string","required":true}}',
      cloudflareWorkerNameOutput: "runtime_resource",
      runtimePublicUrlOutput: "published_endpoint",
    },
    {},
  );
  if (
    "name" in managedCompatOptions.vars ||
    "base_url" in managedCompatOptions.vars
  ) {
    throw new Error(
      "managed compat self-test should not inherit providerless default vars",
    );
  }
  const currentHelloHtml =
    '<!doctype html><meta charset="utf-8"><title>Hello from Takosumi</title>' +
    "<h1>It works</h1><p>This Worker was provisioned by a Takosumi Capsule.</p>";
  if (!isCurrentTakosumiHelloPage(currentHelloHtml)) {
    throw new Error(
      "self-test did not recognize the current hello Worker page",
    );
  }
  if (
    isCurrentTakosumiHelloPage(
      "<!doctype html><title>It works</title><h1>It works</h1>",
    )
  ) {
    throw new Error("self-test accepted a non-Takosumi hello page");
  }
  if (
    cloudflareWorkerName(managedCompatOptions, {
      runtime_resource: "portable-storage-runtime",
    }) !== "portable-storage-runtime"
  ) {
    throw new Error(
      "self-test did not resolve the explicitly mapped Worker name output",
    );
  }
  const {
    cloudflareWorkerNameOutput: _explicitWorkerNameOutput,
    ...configuredWorkerOptions
  } = managedCompatOptions;
  if (
    cloudflareWorkerName(configuredWorkerOptions) !==
    "takos-managed-selftest"
  ) {
    throw new Error("self-test did not use the explicit app name fallback");
  }
  if (
    publicRuntimeUrl(managedCompatOptions, {
      published_endpoint: "https://storage.example.test",
    }) !== "https://storage.example.test"
  ) {
    throw new Error(
      "self-test did not resolve the explicitly mapped runtime URL output",
    );
  }
  const defaultProviderlessOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      appName: "takosumi-keyless-default-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    {},
  );
  const defaultProviderlessResult = dryRunResult(defaultProviderlessOptions);
  if (
    defaultProviderlessResult.capsuleModule !== "git-opentofu-capsule" ||
    defaultProviderlessResult.sourceMode !== "git" ||
    !defaultProviderlessResult.steps.includes("compatibilityChecked")
  ) {
    throw new Error(
      "providerless self-test did not default to Git OpenTofu Capsule flow",
    );
  }
  if (
    defaultProviderlessResult.inputs.runnerProfileId !==
      DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID ||
    defaultProviderlessOptions.runnerProfileId !==
      DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID
  ) {
    throw new Error("providerless self-test did not default to generic runner");
  }
  if (
    defaultProviderlessResult.inputs.cloudflareApiTokenSource !== "not_required"
  ) {
    throw new Error(
      "providerless self-test should not require a Cloudflare token",
    );
  }
  if (
    defaultProviderlessOptions.vars.name !==
      "takosumi-keyless-default-selftest" ||
    defaultProviderlessOptions.vars.base_url !==
      "https://takosumi-keyless-default-selftest.example.invalid"
  ) {
    throw new Error("providerless self-test did not default keyless vars");
  }
  const takosModuleOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takos-release-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      sourceGitUrl: "https://github.com/tako0614/takos.git",
      sourcePath: ".",
      modulePath: "deploy/opentofu",
      varsJson: '{"runtime_options":{"mode":"smoke"}}',
      cloudflareConnectionMode: "guided",
      verificationMode: "opentofu",
    },
    {},
  );
  if (
    "appName" in takosModuleOptions.vars ||
    "accountId" in takosModuleOptions.vars ||
    "workersSubdomain" in takosModuleOptions.vars
  ) {
    throw new Error("Takos module defaults leaked legacy Cloudflare inputs");
  }
  if (takosModuleOptions.vars.project_name !== "takos-release-selftest") {
    throw new Error("Takos module defaults did not set project_name");
  }
  const takosCloudflareVars = takosModuleOptions.vars.cloudflare;
  if (
    !isPlainJsonObject(takosCloudflareVars) ||
    takosCloudflareVars.account_id !== "<redacted>" ||
    takosCloudflareVars.workers_subdomain !== "<redacted>"
  ) {
    throw new Error("Takos module defaults did not set cloudflare object");
  }
  const customModuleOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "custom-module-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      sourceGitUrl: "https://github.com/example/custom.git",
      sourcePath: ".",
      varsJson:
        '{"enable_cloudflare_resources":true,"cloudflare_account_id":"acc_selftest","project_name":"custom-module-selftest"}',
      noDefaultVars: true,
      verificationMode: "opentofu",
    },
    {},
  );
  if (
    "target" in customModuleOptions.vars ||
    "cloudflare" in customModuleOptions.vars
  ) {
    throw new Error("no-default-vars self-test leaked smoke defaults");
  }
  if (
    customModuleOptions.vars.project_name !== "custom-module-selftest" ||
    customModuleOptions.vars.enable_cloudflare_resources !== true
  ) {
    throw new Error("no-default-vars self-test lost explicit vars");
  }
  const gitOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      sourceGitUrl: "https://git.example.test/example/takosumi-fixture.git",
      sourceRef: "main",
      sourcePath: "providers/cloudflare/modules/cloudflare-hello-worker/module",
    },
    {},
  );
  const gitResult = dryRunResult(gitOptions);
  const serializedGit = JSON.stringify(gitResult);
  if (gitResult.sourceMode !== "git") {
    throw new Error("self-test did not enable git source mode");
  }
  if (
    !gitResult.steps.includes("sourceRegistered") ||
    !gitResult.steps.includes("sourceSynced")
  ) {
    throw new Error("git self-test result is missing source steps");
  }
  if (
    serializedGit.includes("git.example.test") ||
    serializedGit.includes("takosumi-fixture.git")
  ) {
    throw new Error("git self-test leaked source Git URL");
  }
  const rehearsalOptions = await resolveOptions(
    {
      dryRun: true,
      backupRestoreRehearsal: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
    },
    {},
  );
  const rehearsalResult = dryRunResult(rehearsalOptions);
  if (
    !rehearsalResult.steps.includes("backupRestoreRehearsal") ||
    !rehearsalResult.backupRestoreRehearsal
  ) {
    throw new Error("self-test result is missing backup/restore rehearsal");
  }
  const releaseOptions = await resolveOptions(
    {
      dryRun: true,
      requireReleaseActivation: "succeeded",
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      appName: "takosumi-release-selftest",
      sessionTokenFile: "/private/account-session-token",
    },
    {},
  );
  const releaseResult = dryRunResult(releaseOptions);
  if (
    !releaseResult.steps.includes("releaseActivationVerified") ||
    releaseResult.releaseActivation?.status !== "succeeded"
  ) {
    throw new Error("self-test result is missing release activation evidence");
  }
  const failedStartedAtMs = Date.now();
  const failedStartedAt = new Date(failedStartedAtMs).toISOString();
  const failed = failedResult(options, {
    startedAt: failedStartedAt,
    startedAtMs: failedStartedAtMs,
    workspaceId: "ws_selftest",
    completedSteps: [],
    stepTimings: [],
    runTimings: [],
    connectionId: "conn_selftest",
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    connectionRevoked: true,
    timedOutRunId: "run_selftest",
    runCancellationStatus: "cancelled",
    error: new Error(
      "GET /api/v1/workspaces failed with Bearer secret-token token=secret cookie=session",
    ),
  });
  const serializedFailed = JSON.stringify(failed);
  if (failed.status !== "failed" || failed.destroyVerified !== false) {
    throw new Error("self-test failed result shape is wrong");
  }
  if (
    serializedFailed.includes("secret-token") ||
    serializedFailed.includes("token=secret") ||
    serializedFailed.includes("cookie=session")
  ) {
    throw new Error("self-test leaked secret-looking failure details");
  }
  const deployTimeout = failedResult(options, {
    startedAt: failedStartedAt,
    startedAtMs: failedStartedAtMs,
    workspaceId: "ws_selftest",
    completedSteps: ["workspaceScopedProviderConnection", "connectionVerified"],
    stepTimings: [
      {
        step: "workspaceScopedProviderConnection",
        startedAt: failedStartedAt,
        finishedAt: failedStartedAt,
        durationMs: 0,
      },
      {
        step: "connectionVerified",
        startedAt: failedStartedAt,
        finishedAt: failedStartedAt,
        durationMs: 0,
      },
    ],
    runTimings: [],
    connectionId: "conn_selftest",
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    connectionRevoked: true,
    error: new RequestTimeoutError(
      "POST",
      `${API_PREFIX}/capsules/cap_selftest/plan`,
      1,
    ),
  });
  if (
    deployTimeout.status !== "failed" ||
    deployTimeout.capsuleId !== undefined ||
    deployTimeout.planRunId !== undefined ||
    !deployTimeout.nextAction?.includes("Capsule plan request timed out")
  ) {
    throw new Error("self-test deploy timeout failed result shape is wrong");
  }
  const originalFetch = globalThis.fetch;
  const originalSmokeTransport = process.env.TAKOSUMI_SMOKE_HTTP_TRANSPORT;
  delete process.env.TAKOSUMI_SMOKE_HTTP_TRANSPORT;
  const workspaceResolveCalls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    workspaceResolveCalls.push(
      `${init?.method ?? "GET"} ${new URL(url).pathname}`,
    );
    if (
      url ===
      "https://app-staging.takosumi.com/api/v1/workspaces?includeArchived=true"
    ) {
      return new Response(
        JSON.stringify({
          workspaces: [{ id: "ws_existing", handle: "existing-workspace" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected self-test workspace request: ${url}`);
  }) as typeof fetch;
  try {
    const resolved = await resolveWorkspaceId({
      ...options,
      workspace: "@existing-workspace",
      ensureWorkspace: true,
    });
    if (resolved !== "ws_existing") {
      throw new Error("self-test did not resolve existing Workspace id");
    }
    if (workspaceResolveCalls.some((call) => call.startsWith("POST "))) {
      throw new Error("self-test posted a duplicate Workspace");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSmokeTransport === undefined) {
      delete process.env.TAKOSUMI_SMOKE_HTTP_TRANSPORT;
    } else {
      process.env.TAKOSUMI_SMOKE_HTTP_TRANSPORT = originalSmokeTransport;
    }
  }
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (
      url ===
      "https://app-staging.takosumi.com/api/v1/workspaces?includeArchived=true"
    ) {
      return new Response(JSON.stringify({ workspaces: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://app-staging.takosumi.com/api/v1/workspaces") {
      return new Response(JSON.stringify({ workspace: { id: "ws_created" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected self-test workspace create request: ${url}`);
  }) as typeof fetch;
  try {
    const created = await resolveWorkspaceId({
      ...options,
      workspace: "@created-workspace",
      ensureWorkspace: true,
    });
    if (created !== "ws_created") {
      throw new Error("self-test did not accept workspace create response");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSmokeTransport === undefined) {
      delete process.env.TAKOSUMI_SMOKE_HTTP_TRANSPORT;
    } else {
      process.env.TAKOSUMI_SMOKE_HTTP_TRANSPORT = originalSmokeTransport;
    }
  }
  const timeoutOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureWorkspace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      deployTimeoutSeconds: "7",
    },
    {},
  );
  if (timeoutOptions.deployTimeoutSeconds !== 7) {
    throw new Error("self-test did not parse --deploy-timeout-seconds");
  }
  globalThis.fetch = ((_, init) =>
    new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  try {
    await requestJson({
      baseUrl: "https://app-staging.takosumi.com",
      token: "redacted",
      method: "POST",
      path: `${API_PREFIX}/capsules/cap_selftest/plan`,
      timeoutMs: 1,
      body: {},
    });
    throw new Error("self-test requestJson timeout did not fire");
  } catch (error) {
    if (!(error instanceof RequestTimeoutError)) {
      throw error;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  globalThis.fetch = (async () => {
    throw new DOMException("synthetic transport timeout", "TimeoutError");
  }) as typeof fetch;
  try {
    await requestJson({
      baseUrl: "https://app-staging.takosumi.com",
      token: "redacted",
      method: "POST",
      path: `${API_PREFIX}/capsules/cap_selftest/plan`,
      timeoutMs: 1,
      body: {},
      transport: "native",
    });
    throw new Error("self-test requestJson runtime timeout did not fire");
  } catch (error) {
    if (
      !(error instanceof RequestTimeoutError) ||
      error.path !== `${API_PREFIX}/capsules/cap_selftest/plan`
    ) {
      throw error;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("platform control-plane smoke self-test passed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function printHelp(): void {
  console.log(`Usage:
  bun run smoke:platform-control-plane -- --url <origin> --workspace <ws_...|@handle> --session-token-file <path> --source-git-url <url>

Required inputs:
  --url <origin>                                  or TAKOSUMI_PLATFORM_URL
  --workspace <ws_...|@handle>                    or TAKOSUMI_SMOKE_WORKSPACE
  --session-token-file <path>                     or TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE / TAKOSUMI_ACCOUNT_SESSION_TOKEN
  --pat-token-file <path>                         or TAKOSUMI_ACCOUNT_PAT_TOKEN_FILE / TAKOSUMI_ACCOUNT_PAT_TOKEN

Cloudflare reference contribution inputs (only when explicitly enabled):
  --cloudflare-api-token-file <path>              or CLOUDFLARE_API_TOKEN_FILE / CLOUDFLARE_API_TOKEN; not required with --cloudflare-connection-mode none
  --cloudflare-account-id-file <path>             or CLOUDFLARE_ACCOUNT_ID_FILE; not required with --cloudflare-connection-mode none
  --cloudflare-account-id <id>                    or CLOUDFLARE_ACCOUNT_ID; not required with --cloudflare-connection-mode none
  --cloudflare-workers-subdomain-file <path>      or CLOUDFLARE_WORKERS_SUBDOMAIN_FILE; only required for cloudflare-worker verification
  --cloudflare-workers-subdomain <name>           or CLOUDFLARE_WORKERS_SUBDOMAIN; only required for cloudflare-worker verification

Options:
  --app-name <name>                               default takosumi-smoke-<random>
  --environment <name>                            explicit evidence label, default smoke
  --ensure-workspace                              create @handle scratch Workspace when missing; validates existing workspace ids
  --workspace-display-name <name>                 display name used with --ensure-workspace
  --cloudflare-connection-mode <guided|generic-env|none> default none; guided/generic-env explicitly enable the Cloudflare reference contribution
  --cloudflare-resource-preflight <account-resources|d1|none>
                                                   verify the Cloudflare token can read account resources before resource-creating applies; account-resources checks D1, KV, R2, Queues, Workflows, and Vectorize
  --runner-profile-id <id>                         request an enabled runner profile for Capsule plans; or TAKOSUMI_SMOKE_RUNNER_PROFILE_ID; providerless OpenTofu defaults to ${DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID}
  --auth-token-kind <session|pat>                 evidence/source label; inferred from --pat-token-file when omitted and never inferred from token prefixes
  --source-git-url <url>                          Git Source URL to sync; required outside dry-run (or TAKOSUMI_SMOKE_SOURCE_GIT_URL)
  --source-ref <ref>                              optional Git ref for --source-git-url; omitted delegates HEAD resolution to Git
  --source-path <path>                            Source archive path inside the Git repo, default .
  --module-path <path>                            OpenTofu Capsule module path inside the SourceSnapshot archive
  --install-config-id <id>                        install config to use for the Capsule, default selectable generic Capsule
  --store-metadata-json <json>                    repository/store presentation metadata copied into Capsule creation
  --store-metadata-json-file <path>               read repository/store presentation metadata from JSON
  --source-name <name>                            Source display name, default <app-name>-source
  --verification-mode <cloudflare-worker|opentofu> default opentofu; cloudflare-worker explicitly enables Cloudflare script/public checks
  --vars-json <json>                              OpenTofu variable object passed to the generated root
  --vars-json-file <path>                         read OpenTofu variable object from a JSON file
  --no-default-vars                               do not merge smoke default variables into --vars-json
  --output-allowlist-json <json>                  explicit output projection object; defaults only to the selected bundled smoke fixture's exact ordinary Output names
  --output-allowlist-json-file <path>             read output projection object from a JSON file
  --public-url-checks-json <json>                 optional array of {output,path,expectedStatus,bodyIncludes[]} checks against allowlisted public URL outputs
  --public-url-checks-json-file <path>            read public URL checks from a JSON file
  --cloudflare-worker-name-output <name>          optional explicit projected Output name for Cloudflare script verification; otherwise --app-name is authoritative
  --runtime-public-url-output <name>              optional explicit projected URL Output name; otherwise the Cloudflare reference URL is derived from --app-name
  --functional-probe-script <path>                run a local Bun probe after apply/public checks and before destroy; ordinary projected Outputs are available through TAKOSUMI_CAPSULE_OUTPUTS_FILE and stdout must be takosumi.capsule-functional-probe@v1 JSON
  --functional-probe-env <NAME,...>               explicitly forward only these environment variables to the functional probe
  --require-release-activation <any|pending|succeeded|failed|none>
                                                   require a release_activation Activity event for the apply Run; default none
  --timeout-seconds <n>                           default 600
  --deploy-timeout-seconds <n>                    default ${DEFAULT_DEPLOY_TIMEOUT_SECONDS}
  --poll-interval-ms <n>                          default 2000
  --out-file <path>                               write the redacted result JSON to a private evidence file
  --backup-restore-rehearsal                      create a Capsule state backup, approve a restore Run, and verify it succeeds before cleanup
  --keep-connection                               keep the temporary Workspace ProviderConnection
  --dry-run                                       validate shape and print redacted plan
  --json                                          print JSON only
  --self-test                                     run offline redaction/shape self-test
`);
}
