#!/usr/bin/env bun
/**
 * Hosted Takosumi Layer-2 smoke.
 *
 * This proves the product control-plane loop, not only the raw provider/module:
 * signed-in Account session -> Workspace ProviderConnection -> upload Capsule ->
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
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalProviderSource } from "../contract/provider-env-rules.ts";

export const PLATFORM_CONTROL_PLANE_SMOKE_KIND =
  "takosumi.platform-control-plane-smoke@v1" as const;

const TAKOSUMI_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CAPSULE_DIR = resolve(
  TAKOSUMI_ROOT,
  "providers/cloudflare/modules/cloudflare-hello-worker/module",
);
const DEFAULT_PROVIDERLESS_CAPSULE_DIR = resolve(
  TAKOSUMI_ROOT,
  "examples/opentofu-basic",
);
const DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID = "generic-opentofu-provider";
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
      finish({
        ok: false,
        name: error instanceof Error ? error.name : "Error",
        message,
        timeout:
          controller?.signal.aborted === true ||
          /(?:timed?\s*out|timeout|aborted)/iu.test(message),
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
type SmokeOutputAllowlist = Readonly<
  Record<
    string,
    {
      readonly from: string;
      readonly type?: string;
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
  readonly space: string;
  readonly appName: string;
  readonly environment: string;
  readonly sourceMode: "upload" | "git";
  readonly capsuleDir: string;
  readonly verificationMode: SmokeVerificationMode;
  readonly vars: Readonly<Record<string, JsonSmokeValue>>;
  readonly outputAllowlist: SmokeOutputAllowlist;
  readonly publicUrlChecks: readonly PublicUrlCheck[];
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
  readonly modulePath?: string;
  readonly sourceName?: string;
  readonly timeoutSeconds: number;
  readonly deployTimeoutSeconds: number;
  readonly pollIntervalMs: number;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly outFile?: string;
  readonly requireReleaseActivation?: ReleaseActivationRequirement;
  readonly keepConnection: boolean;
  readonly ensureSpace: boolean;
  readonly backupRestoreRehearsal: boolean;
  readonly spaceDisplayName?: string;
}

export interface PlatformControlPlaneSmokeResult {
  readonly kind: typeof PLATFORM_CONTROL_PLANE_SMOKE_KIND;
  readonly status: "passed" | "dry_run" | "failed";
  readonly generatedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly serviceUrl: string;
  readonly scratchSpaceId: string;
  readonly capsuleModule: string;
  readonly verificationMode: SmokeVerificationMode;
  readonly credentialPath: "space_scoped_provider_connection" | "none";
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
  readonly installationId?: string;
  readonly planRunId?: string;
  readonly applyRunId?: string;
  readonly destroyPlanRunId?: string;
  readonly destroyApplyRunId?: string;
  readonly backupRestoreRehearsal?: BackupRestoreRehearsalResult;
  readonly deploymentLedger?: DeploymentLedgerVerificationResult;
  readonly releaseActivation?: ReleaseActivationVerificationResult;
  readonly cloudflareResourcePreflight?: CloudflareResourcePreflightResult;
  readonly publicUrlChecks?: readonly PublicUrlCheckResult[];
  readonly capsuleGateStatus: SmokeCheckStatus;
  readonly policyStatus: SmokeCheckStatus;
  readonly workerUrl: string;
  readonly opentofuApplyVerified: boolean;
  readonly deploymentVerified: boolean;
  readonly publicUrlVerified: boolean;
  readonly deploymentLedgerVerified: boolean;
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
    readonly sourceMode: "upload" | "git";
    readonly verificationMode: SmokeVerificationMode;
    readonly varsDigest: string;
    readonly outputAllowlistNames: readonly string[];
    readonly publicUrlCheckNames: readonly string[];
    readonly capsuleDir?: string;
    readonly sourceGitUrlDigest?: string;
    readonly sourceRef?: string;
    readonly sourcePath?: string;
    readonly modulePath?: string;
  };
}

interface CliArgs {
  readonly help?: boolean;
  readonly selfTest?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly outFile?: string;
  readonly keepConnection?: boolean;
  readonly ensureWorkspace?: boolean;
  readonly ensureSpace?: boolean;
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
  readonly space?: string;
  readonly workspace?: string;
  readonly spaceDisplayName?: string;
  readonly workspaceDisplayName?: string;
  readonly appName?: string;
  readonly environment?: string;
  readonly capsuleDir?: string;
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
  readonly modulePath?: string;
  readonly sourceName?: string;
  readonly verificationMode?: string;
  readonly varsJson?: string;
  readonly varsJsonFile?: string;
  readonly outputAllowlistJson?: string;
  readonly outputAllowlistJsonFile?: string;
  readonly publicUrlChecksJson?: string;
  readonly publicUrlChecksJsonFile?: string;
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

interface RunRecord {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly sourceSnapshotId?: string;
  readonly policyStatus?: string;
  readonly backupId?: string;
  readonly restoreStateGeneration?: number;
  readonly restoredStateSnapshotId?: string;
  readonly restoredFromStateSnapshotId?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

interface DeployResponse {
  readonly installation: { readonly id: string; readonly name?: string };
  readonly run: RunRecord;
  readonly planRun?: RunRecord;
  readonly applyRun?: RunRecord;
  readonly created?: boolean;
}

interface InstallConfigRecord {
  readonly id?: string;
  readonly sourceKind?: string;
  readonly name?: string;
}

export interface SmokeProviderConnectionListEntry {
  readonly id?: string;
  readonly providerSource?: string;
  readonly displayName?: string;
}

interface InstallationRecord {
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
  readonly currentStateGeneration?: number;
}

interface BackupRecord {
  readonly id: string;
  readonly digest: string;
  readonly createdByRunId?: string;
  readonly createdAt: string;
}

interface DeploymentRecord {
  readonly id: string;
  readonly installationId: string;
  readonly environment: string;
  readonly stateGeneration: number;
  readonly status: string;
  readonly createdAt: string;
}

interface DeploymentLedgerVerificationResult {
  readonly installationStatus: string;
  readonly deploymentId: string;
  readonly stateGeneration: number;
  readonly applyRunId: string;
  readonly publicOutputNames: readonly string[];
  readonly publicOutputDigest: string;
  readonly outputsPublic?: Readonly<Record<string, unknown>>;
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
] as const;

interface BackupRestoreRehearsalResult {
  readonly backupId: string;
  readonly backupRunId?: string;
  readonly backupDigest: string;
  readonly backupCreatedAt: string;
  readonly stateGeneration: number;
  readonly deploymentId: string;
  readonly restoreRunId: string;
  readonly restoredFromStateSnapshotId?: string;
  readonly restoredStateSnapshotId?: string;
  readonly restoreCreatedAt?: string;
  readonly restoreStartedAt?: string;
  readonly restoreFinishedAt?: string;
  readonly restoreTargetSmoke: "passed";
}

interface FailureCleanupResult {
  readonly attempted: true;
  readonly cloudflareWorkerGone: boolean;
  readonly installationMarkedError: boolean;
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
  const space =
    args.workspace ??
    args.space ??
    env.TAKOSUMI_SMOKE_WORKSPACE ??
    env.TAKOSUMI_SMOKE_SPACE;
  if (!space) {
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
  if (!args.dryRun) {
    assertAccountAuthTokenKind(accountAuthTokenKind, accountSessionToken.value);
  }
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
    args.sourceGitUrl ?? env.TAKOSUMI_SMOKE_SOURCE_GIT_URL;
  const sourceGitUrl =
    rawSourceGitUrl !== undefined
      ? normalizeSmokeSourceGitUrl(rawSourceGitUrl)
      : undefined;
  const sourceRef = args.sourceRef ?? env.TAKOSUMI_SMOKE_SOURCE_REF ?? "main";
  const sourcePath = args.sourcePath ?? env.TAKOSUMI_SMOKE_SOURCE_PATH ?? ".";
  const modulePath = args.modulePath ?? env.TAKOSUMI_SMOKE_MODULE_PATH;
  const sourceName =
    args.sourceName ?? env.TAKOSUMI_SMOKE_SOURCE_NAME ?? undefined;
  const sourceMode = sourceGitUrl ? "git" : "upload";
  const capsuleDir = resolve(
    args.capsuleDir ??
      (providerlessOpenTofuSmoke
        ? DEFAULT_PROVIDERLESS_CAPSULE_DIR
        : DEFAULT_CAPSULE_DIR),
  );
  if (args.dryRun !== true && sourceMode === "upload") {
    await access(capsuleDir);
  }
  const resolvedAppName = args.appName ?? defaultAppName();
  const vars = await readJsonRecordInput({
    inline: args.varsJson ?? env.TAKOSUMI_SMOKE_VARS_JSON,
    file: args.varsJsonFile ?? env.TAKOSUMI_SMOKE_VARS_JSON_FILE,
    label: "vars",
    fallback: defaultSmokeVars({
      accountId: cloudflareAccountId.value,
      appName: resolvedAppName,
      workersSubdomain: cloudflareWorkersSubdomain.value,
      providerless: providerlessOpenTofuSmoke,
    }),
  });
  const outputAllowlist = parseOutputAllowlist(
    await readJsonRecordInput({
      inline:
        args.outputAllowlistJson ?? env.TAKOSUMI_SMOKE_OUTPUT_ALLOWLIST_JSON,
      file:
        args.outputAllowlistJsonFile ??
        env.TAKOSUMI_SMOKE_OUTPUT_ALLOWLIST_JSON_FILE,
      label: "output allowlist",
      fallback: defaultSmokeOutputAllowlist(),
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
  const appName =
    args.appName ??
    stringRecordValue(vars, "appName") ??
    stringRecordValue(vars, "name") ??
    resolvedAppName;
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
    space,
    appName,
    environment: args.environment ?? defaultSmokeEnvironment(url),
    sourceMode,
    capsuleDir,
    verificationMode,
    vars,
    outputAllowlist,
    publicUrlChecks,
    ...(sourceGitUrl ? { sourceGitUrl } : {}),
    ...(sourceGitUrl ? { sourceRef } : {}),
    ...(sourceGitUrl ? { sourcePath } : {}),
    ...(modulePath ? { modulePath } : {}),
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
    json: args.json === true,
    ...(args.outFile ? { outFile: resolve(args.outFile) } : {}),
    ...(requireReleaseActivation ? { requireReleaseActivation } : {}),
    keepConnection: args.keepConnection === true,
    ensureSpace: args.ensureWorkspace === true || args.ensureSpace === true,
    backupRestoreRehearsal: args.backupRestoreRehearsal === true,
    ...((args.workspaceDisplayName ?? args.spaceDisplayName)
      ? { spaceDisplayName: args.workspaceDisplayName ?? args.spaceDisplayName }
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
    scratchSpaceId: options.space,
    capsuleModule: capsuleLabel(options),
    verificationMode: options.verificationMode,
    credentialPath:
      options.cloudflareConnectionMode === "none"
        ? "none"
        : "space_scoped_provider_connection",
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
            deploymentId: "dep_dry_run",
            restoreRunId: "restore_dry_run",
            restoreTargetSmoke: "passed",
          },
        }
      : {}),
    capsuleGateStatus: "passed",
    policyStatus: "passed",
    workerUrl:
      options.verificationMode === "cloudflare-worker"
        ? publicWorkerUrl(options)
        : "",
    opentofuApplyVerified: options.verificationMode === "opentofu",
    deploymentVerified: options.verificationMode === "cloudflare-worker",
    publicUrlVerified:
      options.verificationMode === "cloudflare-worker" ||
      options.publicUrlChecks.length > 0,
    deploymentLedgerVerified: true,
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
    deploymentLedger: {
      installationStatus: "active",
      deploymentId: "dep_dry_run",
      stateGeneration: 1,
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
  const spaceId = await resolveSpaceId(options);
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
  let installationId: string | undefined;
  let planRunId: string | undefined;
  let applyRunId: string | undefined;
  let destroyPlanRunId: string | undefined;
  let destroyApplyRunId: string | undefined;
  let backupRestoreRehearsal: BackupRestoreRehearsalResult | undefined;
  let deploymentLedger: DeploymentLedgerVerificationResult | undefined;
  let releaseActivation: ReleaseActivationVerificationResult | undefined;
  let publicUrlChecks: readonly PublicUrlCheckResult[] | undefined;
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
      beginStep("spaceScopedProviderConnection");
      beginStep("connectionVerified");
      const connection = await createSpaceCloudflareConnection(
        options,
        spaceId,
      );
      connectionId = connection.rawConnectionId;
      providerConnectionId = connection.providerConnectionId;
      completeStep("spaceScopedProviderConnection");
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
    if (options.sourceMode === "git") {
      beginStep("sourceRegistered");
      beginStep("sourceSynced");
    }
    beginStep("scratchInstall");
    beginStep("plan");
    const deploy =
      options.sourceMode === "git"
        ? await deployGitSourceCapsule(options, {
            spaceId,
            ...(providerConnectionId ? { providerConnectionId } : {}),
          })
        : await deployUploadedCapsule(options, {
            spaceId,
            ...(providerConnectionId ? { providerConnectionId } : {}),
          });
    sourceId = deploy.sourceId;
    sourceSyncRunId = deploy.sourceSyncRunId;
    sourceSnapshotId = deploy.sourceSnapshotId;
    installationId = deploy.installation.id;
    planRunId = deploy.planRun?.id ?? deploy.run.id;
    if (options.sourceMode === "git") {
      completeStep("sourceRegistered");
      completeStep("sourceSynced");
    }
    completeStep("scratchInstall");
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
    beginStep("deploymentLedgerVerified");
    if (options.verificationMode === "cloudflare-worker") {
      deploymentLedger = await assertDeploymentLedger(options, {
        spaceId,
        installationId,
        applyRunId,
      });
    } else {
      beginStep("opentofuApplyVerified");
      deploymentLedger = await assertGenericDeploymentLedger(options, {
        spaceId,
        installationId,
        applyRunId,
      });
      completeStep("opentofuApplyVerified");
    }
    completeStep("deploymentLedgerVerified");
    if (options.requireReleaseActivation) {
      beginStep("releaseActivationVerified");
      releaseActivation = await assertReleaseActivation(options, {
        spaceId,
        applyRunId,
        deploymentId: deploymentLedger.deploymentId,
      });
      completeStep("releaseActivationVerified");
    }
    if (options.verificationMode === "cloudflare-worker") {
      beginStep("deploymentVerified");
      await assertCloudflareWorkerExists(options);
      completeStep("deploymentVerified");
      beginStep("publicUrlVerified");
      if (options.publicUrlChecks.length > 0) {
        publicUrlChecks = await assertConfiguredPublicUrls(
          options,
          deploymentLedger.outputsPublic,
        );
      } else {
        await assertPublicWorkerUrl(options);
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
        deploymentLedger.outputsPublic,
      );
      completeStep("publicUrlVerified");
    }
    if (options.backupRestoreRehearsal) {
      beginStep("backupRestoreRehearsal");
      backupRestoreRehearsal = await runBackupRestoreRehearsal(options, {
        spaceId,
        installationId,
      });
      completeStep("backupRestoreRehearsal");
    }

    beginStep("destroy");
    const destroyPlan = await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "DELETE",
      path: `${API_PREFIX}/installations/${encodeURIComponent(installationId)}`,
    });
    destroyPlanRunId = destroyPlan.run.id;
    const reviewedDestroyPlan = await pollRun(options, destroyPlanRunId);
    if (reviewedDestroyPlan.status !== "waiting_approval") {
      throw new Error(
        `destroy plan ${destroyPlanRunId} ended as ${reviewedDestroyPlan.status}; expected waiting_approval`,
      );
    }
    runTimings.push(smokeRunTiming("destroy_plan", reviewedDestroyPlan));
    await requestJson({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/runs/${encodeURIComponent(destroyPlanRunId)}/approve`,
      body: { reason: "Layer-2 platform-control-plane smoke cleanup" },
    });
    const destroyApply = await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/runs/${encodeURIComponent(destroyPlanRunId)}/apply`,
      body: { confirmDestructive: true },
    });
    destroyApplyRunId = destroyApply.run.id;
    const completedDestroy = await pollRun(options, destroyApplyRunId);
    policyStatus = publicPolicyStatus(completedDestroy);
    assertRunSucceeded(completedDestroy, "destroy apply");
    runTimings.push(smokeRunTiming("destroy_apply", completedDestroy));
    if (options.verificationMode === "cloudflare-worker") {
      await assertCloudflareWorkerGone(options);
      await assertPublicWorkerUrlGone(options);
    }
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
      scratchSpaceId: spaceId,
      capsuleModule: capsuleLabel(options),
      verificationMode: options.verificationMode,
      credentialPath:
        options.cloudflareConnectionMode === "none"
          ? "none"
          : "space_scoped_provider_connection",
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
      installationId,
      planRunId,
      applyRunId,
      destroyPlanRunId,
      destroyApplyRunId,
      backupRestoreRehearsal,
      deploymentLedger,
      releaseActivation,
      cloudflareResourcePreflight,
      publicUrlChecks,
      capsuleGateStatus: "passed",
      policyStatus:
        completedApply.policyStatus === "deny" ||
        completedDestroy.policyStatus === "deny"
          ? failPolicy()
          : "passed",
      workerUrl:
        options.verificationMode === "cloudflare-worker"
          ? publicWorkerUrl(options)
          : "",
      opentofuApplyVerified: options.verificationMode === "opentofu",
      deploymentVerified: options.verificationMode === "cloudflare-worker",
      publicUrlVerified:
        options.verificationMode === "cloudflare-worker" ||
        options.publicUrlChecks.length > 0,
      publicUrlChecks,
      deploymentLedgerVerified: true,
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
    if (
      options.verificationMode === "cloudflare-worker" &&
      installationId &&
      applyRunId &&
      !destroyApplyRunId
    ) {
      failureCleanup = await cleanupAppliedSmokeFailure(options, {
        installationId,
      });
    } else {
      await markPendingSmokeInstallationError(options, {
        spaceId,
        installationId,
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
    spaceId,
    completedSteps,
    stepTimings,
    runTimings,
    connectionId,
    providerConnectionId,
    installationId,
    sourceId,
    sourceSyncRunId,
    sourceSnapshotId,
    planRunId,
    applyRunId,
    destroyPlanRunId,
    destroyApplyRunId,
    backupRestoreRehearsal,
    deploymentLedger,
    releaseActivation,
    cloudflareResourcePreflight,
    publicUrlChecks,
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
    readonly spaceId: string;
    readonly completedSteps: readonly string[];
    readonly stepTimings: readonly SmokeStepTiming[];
    readonly runTimings: readonly SmokeRunTiming[];
    readonly connectionId?: string;
    readonly providerConnectionId?: string;
    readonly sourceId?: string;
    readonly sourceSyncRunId?: string;
    readonly sourceSnapshotId?: string;
    readonly installationId?: string;
    readonly planRunId?: string;
    readonly applyRunId?: string;
    readonly destroyPlanRunId?: string;
    readonly destroyApplyRunId?: string;
    readonly backupRestoreRehearsal?: BackupRestoreRehearsalResult;
    readonly deploymentLedger?: DeploymentLedgerVerificationResult;
    readonly releaseActivation?: ReleaseActivationVerificationResult;
    readonly cloudflareResourcePreflight?: CloudflareResourcePreflightResult;
    readonly publicUrlChecks?: readonly PublicUrlCheckResult[];
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
    scratchSpaceId: input.spaceId,
    capsuleModule: capsuleLabel(options),
    verificationMode: options.verificationMode,
    credentialPath:
      options.cloudflareConnectionMode === "none"
        ? "none"
        : "space_scoped_provider_connection",
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
    installationId: input.installationId,
    planRunId: input.planRunId,
    applyRunId: input.applyRunId,
    destroyPlanRunId: input.destroyPlanRunId,
    destroyApplyRunId: input.destroyApplyRunId,
    backupRestoreRehearsal: input.backupRestoreRehearsal,
    deploymentLedger: input.deploymentLedger,
    releaseActivation: input.releaseActivation,
    cloudflareResourcePreflight: input.cloudflareResourcePreflight,
    publicUrlChecks: input.publicUrlChecks,
    capsuleGateStatus: input.capsuleGateStatus,
    policyStatus: input.policyStatus,
    workerUrl:
      options.verificationMode === "cloudflare-worker"
        ? publicWorkerUrl(options)
        : "",
    opentofuApplyVerified: input.completedSteps.includes(
      "opentofuApplyVerified",
    ),
    deploymentVerified: input.completedSteps.includes("deploymentVerified"),
    publicUrlVerified: input.completedSteps.includes("publicUrlVerified"),
    deploymentLedgerVerified: input.completedSteps.includes(
      "deploymentLedgerVerified",
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
  readonly installationId?: string;
  readonly planRunId?: string;
  readonly connectionRevokeSkippedReason?: string;
  readonly error: unknown;
}): string {
  if (
    input.error instanceof Error &&
    input.error.message.startsWith("cloudflare resource preflight failed:")
  ) {
    return "Update the operator Cloudflare API token so it can read and create the Cloudflare account resources required by the Capsule, or use a non-resource-creating Capsule smoke before rerunning this apply.";
  }
  if (
    input.error instanceof RequestTimeoutError &&
    input.error.method === "POST" &&
    input.error.path === `${API_PREFIX}/deploy`
  ) {
    return "The deploy request timed out before returning a plan run id. Check the scratch Workspace for a pending smoke Capsule run with this app name, verify the temporary Provider Connection is revoked, then inspect platform worker logs for the compatibility check or plan creation step that did not return.";
  }
  if (input.connectionRevokeSkippedReason !== undefined) {
    return "Inspect the timed-out run, confirm/cancel any active execution, revoke the recorded Provider Connection, and remove any temporary Cloudflare resources before rerunning the smoke.";
  }
  return "Inspect the recorded run and installation ids, confirm any temporary Cloudflare resources are destroyed, then rerun the smoke after the blocking run reaches a terminal state.";
}

function failPolicy(): never {
  throw new Error("policyStatus denied during platform-control-plane smoke");
}

function publicPolicyStatus(run: RunRecord): SmokeCheckStatus {
  return run.policyStatus === "deny" ? "denied" : "passed";
}

async function resolveSpaceId(
  options: PlatformControlPlaneSmokeOptions,
): Promise<string> {
  const normalized = options.space.replace(/^@/, "");
  if (normalized.startsWith("space_")) {
    if (options.ensureSpace) {
      await requestJson({
        baseUrl: options.url,
        token: options.accountSessionToken,
        path: `${API_PREFIX}/spaces/${encodeURIComponent(normalized)}`,
      });
    }
    return normalized;
  }
  const response = await requestJson<{
    readonly spaces?: readonly {
      readonly id: string;
      readonly handle: string;
    }[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/spaces`,
  });
  const match = (response.spaces ?? []).find(
    (space) => space.handle === normalized,
  );
  if (!match) {
    if (options.ensureSpace) {
      const created = await requestJson<{
        readonly space?: { readonly id?: string };
      }>({
        baseUrl: options.url,
        token: options.accountSessionToken,
        method: "POST",
        path: `${API_PREFIX}/spaces`,
        body: {
          handle: normalized,
          displayName: options.spaceDisplayName ?? normalized,
          type: "personal",
        },
      });
      const createdId = created.space?.id;
      if (!createdId) {
        throw new Error("space create response did not include space.id");
      }
      return createdId;
    }
    throw new Error(
      `workspace @${normalized} was not found; pass --ensure-workspace or create the scratch Workspace first`,
    );
  }
  return match.id;
}

async function createSpaceCloudflareConnection(
  options: PlatformControlPlaneSmokeOptions,
  spaceId: string,
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
            workspaceId: spaceId,
            provider: "cloudflare",
            kind: "generic_env_provider",
            credentialDriver: "generic_env",
            displayName,
            scopeHints: { accountId: options.cloudflareAccountId },
            values: {
              CLOUDFLARE_API_TOKEN: options.cloudflareApiToken,
              CLOUDFLARE_ACCOUNT_ID: options.cloudflareAccountId,
            },
          }
        : {
            workspaceId: spaceId,
            provider: "cloudflare",
            displayName,
            scopeHints: { accountId: options.cloudflareAccountId },
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
    spaceId,
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
      throw new Error(
        `cloudflare resource preflight request failed: ${check.label}: ${errorMessage(error)}`,
      );
    });
    const bodyText = await response.text();
    const body = parseResponseBody(
      bodyText,
      `cloudflare resource preflight ${check.id}`,
    );
    if (!response.ok || !cloudflareApiSuccess(body)) {
      throw new Error(
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
  spaceId: string,
  displayName: string,
): Promise<string> {
  const response = await requestJson<{
    readonly providerConnections?: readonly SmokeProviderConnectionListEntry[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/provider-connections?workspaceId=${encodeURIComponent(spaceId)}`,
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

async function uploadCapsule(
  options: PlatformControlPlaneSmokeOptions,
  spaceId: string,
): Promise<{ readonly id: string }> {
  const archive = await tarZstd(options.capsuleDir);
  const response = await requestJson<{
    readonly snapshot?: { readonly id?: string };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/spaces/${encodeURIComponent(spaceId)}/uploads`,
    binary: archive,
  });
  const id = response.snapshot?.id;
  if (!id) throw new Error("upload response did not include snapshot.id");
  return { id };
}

async function deployUploadedCapsule(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly providerConnectionId?: string;
  },
): Promise<
  DeployResponse & {
    readonly sourceSnapshotId: string;
  }
> {
  const snapshot = await uploadCapsule(options, input.spaceId);
  const deploy = await deploySnapshot(options, {
    spaceId: input.spaceId,
    snapshotId: snapshot.id,
    providerConnectionId: input.providerConnectionId,
  });
  return { ...deploy, sourceSnapshotId: snapshot.id };
}

async function deployGitSourceCapsule(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly providerConnectionId?: string;
  },
): Promise<
  DeployResponse & {
    readonly sourceId: string;
    readonly sourceSyncRunId: string;
    readonly sourceSnapshotId: string;
  }
> {
  if (!options.sourceGitUrl) {
    throw new Error("sourceGitUrl is required for git source smoke");
  }
  const source = await createSmokeSource(options, input.spaceId);
  const sourceSyncRun = await syncSmokeSource(options, source.id);
  const sourceSnapshotId = sourceSyncRun.sourceSnapshotId;
  if (!sourceSnapshotId) {
    throw new Error(
      `source sync run ${sourceSyncRun.id} succeeded without sourceSnapshotId`,
    );
  }
  const installConfigId = await findGenericCapsuleInstallConfigId(
    options,
    input.spaceId,
  );
  const installation = await createSourceInstallation(options, {
    spaceId: input.spaceId,
    sourceId: source.id,
    installConfigId,
  });
  if (input.providerConnectionId) {
    await putInstallationProviderConnections(options, {
      installationId: installation.id,
      providerConnectionId: input.providerConnectionId,
    });
  }
  const plan = await requestJson<{ readonly run: RunRecord }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/installations/${encodeURIComponent(
      installation.id,
    )}/plan`,
    timeoutMs: options.deployTimeoutSeconds * 1000,
    body: {
      ...(options.runnerProfileId
        ? { runnerProfileId: options.runnerProfileId }
        : {}),
    },
  });
  return {
    installation,
    run: plan.run,
    planRun: plan.run,
    created: true,
    sourceId: source.id,
    sourceSyncRunId: sourceSyncRun.id,
    sourceSnapshotId,
  };
}

async function createSmokeSource(
  options: PlatformControlPlaneSmokeOptions,
  spaceId: string,
): Promise<{ readonly id: string }> {
  const response = await requestJson<{
    readonly source?: { readonly id?: string };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/sources`,
    body: {
      workspaceId: spaceId,
      name: options.sourceName ?? `${options.appName}-source`,
      url: options.sourceGitUrl,
      defaultRef: options.sourceRef,
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

async function findGenericCapsuleInstallConfigId(
  options: PlatformControlPlaneSmokeOptions,
  spaceId: string,
): Promise<string> {
  const response = await requestJson<{
    readonly installConfigs?: readonly InstallConfigRecord[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/capsule-configs?workspaceId=${encodeURIComponent(
      spaceId,
    )}`,
  });
  const match = (response.installConfigs ?? []).find(
    (config) =>
      typeof config.id === "string" && config.sourceKind === "generic_capsule",
  );
  if (!match?.id) {
    throw new Error(
      "generic_capsule install config was not available to the scratch Workspace",
    );
  }
  return match.id;
}

async function createSourceInstallation(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly sourceId: string;
    readonly installConfigId: string;
  },
): Promise<{ readonly id: string; readonly name?: string }> {
  const response = await requestJson<{
    readonly installation?: { readonly id?: string; readonly name?: string };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/spaces/${encodeURIComponent(
      input.spaceId,
    )}/installations`,
    body: {
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
    },
  });
  const id = response.installation?.id;
  if (!id) {
    throw new Error("installation create response did not include id");
  }
  return {
    id,
    ...(response.installation?.name
      ? { name: response.installation.name }
      : {}),
  };
}

async function putInstallationProviderConnections(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly installationId: string;
    readonly providerConnectionId: string;
  },
): Promise<void> {
  await requestJson({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "PUT",
    path: `${API_PREFIX}/installations/${encodeURIComponent(
      input.installationId,
    )}/provider-connections`,
    body: {
      connections: [
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

async function deploySnapshot(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly snapshotId: string;
    readonly providerConnectionId?: string;
  },
): Promise<DeployResponse> {
  return await requestJson<DeployResponse>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/deploy`,
    timeoutMs: options.deployTimeoutSeconds * 1000,
    body: {
      workspaceId: input.spaceId,
      name: options.appName,
      environment: options.environment,
      snapshotId: input.snapshotId,
      ...(options.modulePath ? { modulePath: options.modulePath } : {}),
      ...(options.runnerProfileId
        ? { runnerProfileId: options.runnerProfileId }
        : {}),
      vars: options.vars,
      outputAllowlist: options.outputAllowlist,
      ...(input.providerConnectionId
        ? {
            providerConnections: [
              {
                provider: "cloudflare",
                alias: "main",
                connectionId: input.providerConnectionId,
              },
            ],
          }
        : {}),
      autoApprove: true,
    },
  });
}

export function shouldMarkPendingSmokeInstallationError(
  installation: InstallationRecord,
  appName: string,
): installation is InstallationRecord & { readonly id: string } {
  return (
    typeof installation.id === "string" &&
    installation.name === appName &&
    installation.status === "pending" &&
    (installation.currentStateGeneration ?? 0) === 0
  );
}

async function markPendingSmokeInstallationError(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly installationId?: string;
  },
): Promise<boolean> {
  const candidates = input.installationId
    ? [
        (
          await requestJson<{ readonly installation?: InstallationRecord }>({
            baseUrl: options.url,
            token: options.accountSessionToken,
            path: `${API_PREFIX}/installations/${encodeURIComponent(
              input.installationId,
            )}`,
          })
        ).installation,
      ]
    : ((
        await requestJson<{ readonly installations?: InstallationRecord[] }>({
          baseUrl: options.url,
          token: options.accountSessionToken,
          path: `${API_PREFIX}/spaces/${encodeURIComponent(
            input.spaceId,
          )}/installations`,
        })
      ).installations ?? []);

  const target = candidates
    .filter((item): item is InstallationRecord => item !== undefined)
    .find((item) =>
      shouldMarkPendingSmokeInstallationError(item, options.appName),
    );
  if (!target?.id) return false;
  await requestJson({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "PATCH",
    path: `${API_PREFIX}/installations/${encodeURIComponent(target.id)}`,
    body: { status: "error" },
  });
  return true;
}

async function cleanupAppliedSmokeFailure(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly installationId: string;
  },
): Promise<FailureCleanupResult> {
  let cloudflareWorkerGone = false;
  let installationMarkedError = false;
  let cleanupError: string | undefined;
  try {
    const deleted = await cloudflareScriptRequest(options, "DELETE");
    cloudflareWorkerGone = deleted.status === 404 || deleted.ok;
    if (!cloudflareWorkerGone) {
      await assertCloudflareWorkerGone(options);
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
      path: `${API_PREFIX}/installations/${encodeURIComponent(
        input.installationId,
      )}`,
      body: { status: "error" },
    });
    installationMarkedError = true;
  } catch (error) {
    cleanupError = cleanupError
      ? `${cleanupError}; ${publicErrorMessage(error)}`
      : publicErrorMessage(error);
  }
  return {
    attempted: true,
    cloudflareWorkerGone,
    installationMarkedError,
    ...(cleanupError ? { error: cleanupError } : {}),
  };
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
    readonly spaceId: string;
    readonly installationId: string;
  },
): Promise<BackupRestoreRehearsalResult> {
  const deployment = await latestDeploymentForInstallation(
    options,
    input.installationId,
  );
  const backup = (
    await requestJson<{ readonly backup: BackupRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/installations/${encodeURIComponent(
        input.installationId,
      )}/backups`,
    })
  ).backup;
  const restore = (
    await requestJson<{ readonly run: RunRecord }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      method: "POST",
      path: `${API_PREFIX}/spaces/${encodeURIComponent(
        input.spaceId,
      )}/backups/${encodeURIComponent(backup.id)}/restores`,
      body: {
        installationId: input.installationId,
        environment: deployment.environment,
        stateGeneration: deployment.stateGeneration,
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
    stateGeneration: deployment.stateGeneration,
    deploymentId: deployment.id,
    restoreRunId: completedRestore.id,
    restoredFromStateSnapshotId: completedRestore.restoredFromStateSnapshotId,
    restoredStateSnapshotId: completedRestore.restoredStateSnapshotId,
    restoreCreatedAt: completedRestore.createdAt ?? restore.createdAt,
    restoreStartedAt: completedRestore.startedAt,
    restoreFinishedAt: completedRestore.finishedAt,
    restoreTargetSmoke: "passed",
  };
}

async function latestDeploymentForInstallation(
  options: PlatformControlPlaneSmokeOptions,
  installationId: string,
): Promise<DeploymentRecord> {
  const response = await requestJson<{
    readonly deployments?: readonly DeploymentRecord[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/installations/${encodeURIComponent(
      installationId,
    )}/deployments`,
  });
  const deployments = [...(response.deployments ?? [])].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const deployment =
    deployments.find((candidate) => candidate.status === "active") ??
    deployments[0];
  if (!deployment) {
    throw new Error(
      `installation ${installationId} did not return a deployment for backup/restore rehearsal`,
    );
  }
  if (
    !Number.isInteger(deployment.stateGeneration) ||
    deployment.stateGeneration < 0
  ) {
    throw new Error(
      `deployment ${deployment.id} has invalid stateGeneration for backup/restore rehearsal`,
    );
  }
  return deployment;
}

async function assertCloudflareWorkerExists(
  options: PlatformControlPlaneSmokeOptions,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastStatus = 0;
  while (Date.now() <= deadline) {
    const response = await cloudflareScriptRequest(options, "GET");
    lastStatus = response.status;
    if (response.status === 200) return;
    await sleep(2_000);
  }
  throw new Error(
    `Cloudflare Worker ${options.appName} was not readable after apply (last HTTP ${lastStatus})`,
  );
}

function publicWorkerUrl(options: PlatformControlPlaneSmokeOptions): string {
  return `https://${options.appName}.${options.cloudflareWorkersSubdomain}.workers.dev`;
}

async function assertPublicWorkerUrl(
  options: PlatformControlPlaneSmokeOptions,
): Promise<void> {
  const url = publicWorkerUrl(options);
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
      if (
        response.ok &&
        lastBody.includes("<h1>It works</h1>") &&
        lastBody.includes("provisioned by a Takosumi Installation")
      ) {
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
  outputsPublic: Readonly<Record<string, unknown>> | undefined,
): Promise<readonly PublicUrlCheckResult[]> {
  if (!outputsPublic) {
    throw new Error(
      "deployment ledger did not expose outputsPublic for URL checks",
    );
  }
  const results: PublicUrlCheckResult[] = [];
  for (const check of options.publicUrlChecks) {
    const rawUrl = outputsPublic[check.output];
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      throw new Error(
        `public URL check ${check.name} expected string output ${check.output}`,
      );
    }
    const url = publicCheckUrl(rawUrl, check);
    const response = await fetch(url, { headers: { accept: "text/html,*/*" } });
    const body = await response.text();
    if (response.status !== check.expectedStatus) {
      throw new Error(
        `public URL check ${check.name} returned HTTP ${response.status}; expected ${check.expectedStatus}`,
      );
    }
    for (const marker of check.bodyIncludes) {
      if (!body.includes(marker)) {
        throw new Error(
          `public URL check ${check.name} response did not include marker ${JSON.stringify(
            marker,
          )}: ${redactResponseSnippet(body)}`,
        );
      }
    }
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

async function assertDeploymentLedger(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly applyRunId: string;
  },
): Promise<DeploymentLedgerVerificationResult> {
  const installationResponse = await requestJson<{
    readonly installation?: {
      readonly id?: string;
      readonly spaceId?: string;
      readonly status?: string;
      readonly currentDeploymentId?: string;
      readonly currentStateGeneration?: number;
    };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/installations/${encodeURIComponent(
      input.installationId,
    )}`,
  });
  const installation = installationResponse.installation;
  if (!installation) {
    throw new Error(
      "installation ledger response did not include installation",
    );
  }
  if (installation.id !== input.installationId) {
    throw new Error(
      "installation ledger returned an unexpected installation id",
    );
  }
  if (installation.spaceId !== input.spaceId) {
    throw new Error("installation ledger returned an unexpected Workspace id");
  }
  if (installation.status !== "active") {
    throw new Error(
      `installation ledger status was ${installation.status ?? "unknown"}; expected active`,
    );
  }
  if (
    !Number.isInteger(installation.currentStateGeneration) ||
    Number(installation.currentStateGeneration) < 1
  ) {
    throw new Error("installation ledger did not advance state generation");
  }
  if (!installation.currentDeploymentId) {
    throw new Error("installation ledger did not expose currentDeploymentId");
  }
  const currentDeploymentId = installation.currentDeploymentId;
  const currentStateGeneration = installation.currentStateGeneration;

  const deploymentsResponse = await requestJson<{
    readonly deployments?: readonly {
      readonly id?: string;
      readonly spaceId?: string;
      readonly installationId?: string;
      readonly environment?: string;
      readonly applyRunId?: string;
      readonly stateGeneration?: number;
      readonly outputsPublic?: Record<string, unknown>;
      readonly status?: string;
    }[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/installations/${encodeURIComponent(
      input.installationId,
    )}/deployments`,
  });
  const deployments = deploymentsResponse.deployments ?? [];
  const deployment =
    deployments.find((item) => item.id === currentDeploymentId) ??
    deployments.find((item) => item.applyRunId === input.applyRunId);
  if (!deployment) {
    throw new Error("deployment ledger did not include the applied deployment");
  }
  if (!deployment.id || deployment.id !== currentDeploymentId) {
    throw new Error("deployment ledger does not match currentDeploymentId");
  }
  const deploymentId = deployment.id;
  if (deployment.spaceId !== input.spaceId) {
    throw new Error("deployment ledger returned an unexpected Workspace id");
  }
  if (deployment.installationId !== input.installationId) {
    throw new Error("deployment ledger returned an unexpected installation id");
  }
  if (deployment.environment !== options.environment) {
    throw new Error(
      `deployment ledger environment was ${deployment.environment ?? "unknown"}; expected ${options.environment}`,
    );
  }
  if (deployment.applyRunId !== input.applyRunId) {
    throw new Error("deployment ledger returned an unexpected applyRunId");
  }
  if (deployment.status !== "active") {
    throw new Error(
      `deployment ledger status was ${deployment.status ?? "unknown"}; expected active`,
    );
  }
  if (
    !Number.isInteger(deployment.stateGeneration) ||
    deployment.stateGeneration !== currentStateGeneration
  ) {
    throw new Error(
      "deployment ledger state generation did not match installation",
    );
  }
  const stateGeneration = deployment.stateGeneration;
  const outputsPublic = deployment.outputsPublic;
  if (!isRecord(outputsPublic)) {
    throw new Error("deployment ledger did not expose outputsPublic");
  }
  if (outputsPublic.worker_name !== options.appName) {
    throw new Error(
      "deployment outputsPublic.worker_name did not match appName",
    );
  }
  if (outputsPublic.url !== publicWorkerUrl(options)) {
    throw new Error(
      "deployment outputsPublic.url did not match public Worker URL",
    );
  }
  const publicOutputNames = Object.keys(outputsPublic).sort();
  for (const required of ["url", "worker_name"]) {
    if (!publicOutputNames.includes(required)) {
      throw new Error(
        `deployment outputsPublic did not include required output ${required}`,
      );
    }
  }
  return {
    installationStatus: installation.status,
    deploymentId,
    stateGeneration,
    applyRunId: input.applyRunId,
    publicOutputNames,
    publicOutputDigest: digestJson(outputsPublic),
    outputsPublic,
  };
}

async function assertGenericDeploymentLedger(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly applyRunId: string;
  },
): Promise<DeploymentLedgerVerificationResult> {
  const installationResponse = await requestJson<{
    readonly installation?: {
      readonly id?: string;
      readonly spaceId?: string;
      readonly status?: string;
      readonly currentDeploymentId?: string;
      readonly currentStateGeneration?: number;
    };
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/installations/${encodeURIComponent(
      input.installationId,
    )}`,
  });
  const installation = installationResponse.installation;
  if (!installation) {
    throw new Error(
      "installation ledger response did not include installation",
    );
  }
  if (installation.id !== input.installationId) {
    throw new Error(
      "installation ledger returned an unexpected installation id",
    );
  }
  if (installation.spaceId !== input.spaceId) {
    throw new Error("installation ledger returned an unexpected Workspace id");
  }
  if (installation.status !== "active") {
    throw new Error(
      `installation ledger status was ${installation.status ?? "unknown"}; expected active`,
    );
  }
  if (
    !Number.isInteger(installation.currentStateGeneration) ||
    Number(installation.currentStateGeneration) < 1
  ) {
    throw new Error("installation ledger did not advance state generation");
  }
  if (!installation.currentDeploymentId) {
    throw new Error("installation ledger did not expose currentDeploymentId");
  }
  const currentDeploymentId = installation.currentDeploymentId;
  const currentStateGeneration = installation.currentStateGeneration;

  const deploymentsResponse = await requestJson<{
    readonly deployments?: readonly {
      readonly id?: string;
      readonly spaceId?: string;
      readonly installationId?: string;
      readonly environment?: string;
      readonly applyRunId?: string;
      readonly stateGeneration?: number;
      readonly outputsPublic?: Record<string, unknown>;
      readonly status?: string;
    }[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/installations/${encodeURIComponent(
      input.installationId,
    )}/deployments`,
  });
  const deployments = deploymentsResponse.deployments ?? [];
  const deployment =
    deployments.find((item) => item.id === currentDeploymentId) ??
    deployments.find((item) => item.applyRunId === input.applyRunId);
  if (!deployment) {
    throw new Error("deployment ledger did not include the applied deployment");
  }
  if (!deployment.id || deployment.id !== currentDeploymentId) {
    throw new Error("deployment ledger does not match currentDeploymentId");
  }
  const deploymentId = deployment.id;
  if (deployment.spaceId !== input.spaceId) {
    throw new Error("deployment ledger returned an unexpected Workspace id");
  }
  if (deployment.installationId !== input.installationId) {
    throw new Error("deployment ledger returned an unexpected installation id");
  }
  if (deployment.environment !== options.environment) {
    throw new Error(
      `deployment ledger environment was ${deployment.environment ?? "unknown"}; expected ${options.environment}`,
    );
  }
  if (deployment.applyRunId !== input.applyRunId) {
    throw new Error("deployment ledger returned an unexpected applyRunId");
  }
  if (deployment.status !== "active") {
    throw new Error(
      `deployment ledger status was ${deployment.status ?? "unknown"}; expected active`,
    );
  }
  if (
    !Number.isInteger(deployment.stateGeneration) ||
    deployment.stateGeneration !== currentStateGeneration
  ) {
    throw new Error(
      "deployment ledger state generation did not match installation",
    );
  }
  const outputsPublic = deployment.outputsPublic;
  if (!isRecord(outputsPublic)) {
    throw new Error("deployment ledger did not expose outputsPublic");
  }
  const publicOutputNames = Object.keys(outputsPublic).sort();
  const missingRequiredOutputs = Object.entries(options.outputAllowlist)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name)
    .filter((name) => !publicOutputNames.includes(name));
  if (missingRequiredOutputs.length > 0) {
    throw new Error(
      `deployment outputsPublic did not include required output(s): ${missingRequiredOutputs.join(
        ", ",
      )}`,
    );
  }
  return {
    installationStatus: installation.status,
    deploymentId,
    stateGeneration: deployment.stateGeneration,
    applyRunId: input.applyRunId,
    publicOutputNames,
    publicOutputDigest: digestJson(outputsPublic),
    outputsPublic,
  };
}

async function assertReleaseActivation(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly applyRunId: string;
    readonly deploymentId: string;
  },
): Promise<ReleaseActivationVerificationResult> {
  const deadline = Date.now() + options.deployTimeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const response = await requestJson<{
      readonly events?: readonly ActivityEventRecord[];
    }>({
      baseUrl: options.url,
      token: options.accountSessionToken,
      path: `${API_PREFIX}/spaces/${encodeURIComponent(input.spaceId)}/activity?limit=50`,
    });
    const event = (response.events ?? []).find((candidate) =>
      isReleaseActivationEvent(candidate, input),
    );
    if (event) {
      return releaseActivationVerificationResult(options, input, event);
    }
    await sleep(options.pollIntervalMs);
  }
  throw new Error(
    `apply run ${input.applyRunId} did not emit release_activation Activity for deployment ${input.deploymentId}`,
  );
}

function isReleaseActivationEvent(
  candidate: ActivityEventRecord,
  input: {
    readonly applyRunId: string;
    readonly deploymentId: string;
  },
): candidate is ActivityEventRecord & { readonly action: string } {
  if (!candidate.action?.startsWith("release_activation.")) return false;
  if (candidate.runId !== input.applyRunId) return false;
  if (candidate.targetId !== input.deploymentId) return false;
  return (
    candidate.targetType === undefined || candidate.targetType === "deployment"
  );
}

function releaseActivationVerificationResult(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly applyRunId: string;
    readonly deploymentId: string;
  },
  event: ActivityEventRecord & { readonly action: string },
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
    targetId: event.targetId ?? input.deploymentId,
    runId: event.runId ?? input.applyRunId,
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
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastStatus = 0;
  while (Date.now() <= deadline) {
    const response = await cloudflareScriptRequest(options, "GET");
    lastStatus = response.status;
    if (response.status === 404) return;
    await sleep(2_000);
  }
  throw new Error(
    `Cloudflare Worker ${options.appName} still existed after destroy (last HTTP ${lastStatus})`,
  );
}

async function assertPublicWorkerUrlGone(
  options: PlatformControlPlaneSmokeOptions,
): Promise<void> {
  const url = publicWorkerUrl(options);
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
        !(
          response.ok &&
          lastBody.includes("<h1>It works</h1>") &&
          lastBody.includes("provisioned by a Takosumi Installation")
        )
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
): Promise<Response> {
  return await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      options.cloudflareAccountId,
    )}/workers/scripts/${encodeURIComponent(options.appName)}`,
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
  return /(?:timed?\s*out|timeout|aborted)/iu.test(error.message);
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

function tarZstd(dir: string): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "tar",
      [
        "--zstd",
        "--exclude=.git",
        "--exclude=.terraform",
        "--exclude=.wrangler",
        "--exclude=node_modules",
        "-cf",
        "-",
        "-C",
        dir,
        ".",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `tar --zstd failed (exit ${code}): ${Buffer.concat(stderr)
              .toString()
              .trim()}`,
          ),
        );
        return;
      }
      resolvePromise(new Uint8Array(Buffer.concat(stdout)));
    });
  });
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
  if (value === undefined || value.trim() === "" || value === "guided") {
    return "guided";
  }
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

function assertAccountAuthTokenKind(
  kind: SmokeAuthTokenKind,
  token: string,
): void {
  if (kind === "pat" && !token.startsWith("takpat_")) {
    throw new Error("account personal access token must start with takpat_");
  }
  if (kind === "session" && !token.startsWith("sess_")) {
    throw new Error("account session token must start with sess_");
  }
}

function parseVerificationMode(
  value: string | undefined,
): SmokeVerificationMode {
  if (
    value === undefined ||
    value.trim() === "" ||
    value === "cloudflare-worker"
  ) {
    return "cloudflare-worker";
  }
  if (value === "opentofu") return "opentofu";
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
      base_url: `https://example.invalid/${input.appName}`,
    };
  }
  return {
    accountId: input.accountId,
    appName: input.appName,
    workersSubdomain: input.workersSubdomain,
  };
}

function defaultSmokeOutputAllowlist(): SmokeOutputAllowlist {
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
    { from: string; type?: string; required?: boolean }
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
    out[name] = {
      from: spec.from,
      ...(typeof spec.type === "string" ? { type: spec.type } : {}),
      ...(typeof spec.required === "boolean"
        ? { required: spec.required }
        : {}),
    };
  }
  return out;
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

function stringRecordValue(
  record: Readonly<Record<string, JsonSmokeValue>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function defaultAppName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `takosumi-smoke-${suffix}`;
}

function capsuleLabel(options: PlatformControlPlaneSmokeOptions): string {
  if (options.sourceMode === "git") return "git-opentofu-capsule";
  if (options.capsuleDir === DEFAULT_CAPSULE_DIR) {
    return "cloudflare-hello-worker";
  }
  if (options.capsuleDir === DEFAULT_PROVIDERLESS_CAPSULE_DIR) {
    return "opentofu-basic";
  }
  return "uploaded-opentofu-capsule";
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
  readonly sourceMode: "upload" | "git";
  readonly verificationMode: SmokeVerificationMode;
  readonly varsDigest: string;
  readonly outputAllowlistNames: readonly string[];
  readonly publicUrlCheckNames: readonly string[];
  readonly capsuleDir?: string;
  readonly sourceGitUrlDigest?: string;
  readonly sourceRef?: string;
  readonly sourcePath?: string;
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
    ...(options.sourceMode === "upload"
      ? {
          capsuleDir: options.capsuleDir,
          ...(options.modulePath ? { modulePath: options.modulePath } : {}),
        }
      : {}),
    ...(options.sourceMode === "git" && options.sourceGitUrl
      ? {
          sourceGitUrlDigest: sha256(options.sourceGitUrl),
          sourceRef: options.sourceRef ?? "main",
          sourcePath: options.sourcePath ?? ".",
          ...(options.modulePath ? { modulePath: options.modulePath } : {}),
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
  >,
): readonly string[] {
  const steps = [
    ...(options?.cloudflareConnectionMode === "none"
      ? ["providerConnectionNotRequired"]
      : ["spaceScopedProviderConnection"]),
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
    "plan",
    "apply",
    ...(options?.verificationMode === "opentofu"
      ? ["opentofuApplyVerified"]
      : ["deploymentVerified", "publicUrlVerified"]),
    "deploymentLedgerVerified",
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
  console.log(`workspace: ${result.scratchSpaceId}`);
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
  if (result.installationId)
    console.log(`installation: ${result.installationId}`);
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
      workspace: "space_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureSpace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
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
  if (result.sourceMode !== "upload") {
    throw new Error("self-test default source mode is not upload");
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
      workspace: "space_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureSpace: true,
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
      workspace: "space_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      capsuleDir: "/private/custom-opentofu-module",
      appName: "takosumi-smoke-selftest",
      ensureSpace: true,
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
      workspace: "space_selftest",
      capsuleDir: "/private/keyless-opentofu-module",
      appName: "takosumi-smoke-selftest",
      ensureSpace: true,
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
    providerlessResult.steps.includes("spaceScopedProviderConnection") ||
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
  const defaultProviderlessOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "space_selftest",
      appName: "takosumi-keyless-default-selftest",
      ensureSpace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    {},
  );
  const defaultProviderlessResult = dryRunResult(defaultProviderlessOptions);
  if (defaultProviderlessResult.capsuleModule !== "opentofu-basic") {
    throw new Error("providerless self-test did not default to opentofu-basic");
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
      "https://example.invalid/takosumi-keyless-default-selftest"
  ) {
    throw new Error("providerless self-test did not default keyless vars");
  }
  const gitOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "space_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureSpace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      sourceGitUrl: "https://github.example/takosumi-fixture.git",
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
    serializedGit.includes("github.example") ||
    serializedGit.includes("takosumi-fixture.git")
  ) {
    throw new Error("git self-test leaked source Git URL");
  }
  const rehearsalOptions = await resolveOptions(
    {
      dryRun: true,
      backupRestoreRehearsal: true,
      url: "https://app-staging.takosumi.com",
      workspace: "space_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureSpace: true,
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
      workspace: "space_selftest",
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
    spaceId: "space_selftest",
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
      "GET /api/v1/spaces failed with Bearer secret-token token=secret cookie=session",
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
    spaceId: "space_selftest",
    completedSteps: ["spaceScopedProviderConnection", "connectionVerified"],
    stepTimings: [
      {
        step: "spaceScopedProviderConnection",
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
    error: new RequestTimeoutError("POST", `${API_PREFIX}/deploy`, 1),
  });
  if (
    deployTimeout.status !== "failed" ||
    deployTimeout.installationId !== undefined ||
    deployTimeout.planRunId !== undefined ||
    !deployTimeout.nextAction?.includes("before returning a plan run id")
  ) {
    throw new Error("self-test deploy timeout failed result shape is wrong");
  }
  const timeoutOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "space_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      cloudflareWorkersSubdomainFile: "/private/cloudflare-workers-subdomain",
      appName: "takosumi-smoke-selftest",
      ensureSpace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
      deployTimeoutSeconds: "7",
    },
    {},
  );
  if (timeoutOptions.deployTimeoutSeconds !== 7) {
    throw new Error("self-test did not parse --deploy-timeout-seconds");
  }
  const originalFetch = globalThis.fetch;
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
      path: `${API_PREFIX}/deploy`,
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
    throw new Error("The operation timed out.");
  }) as typeof fetch;
  try {
    await requestJson({
      baseUrl: "https://app-staging.takosumi.com",
      token: "redacted",
      method: "POST",
      path: `${API_PREFIX}/deploy`,
      timeoutMs: 1,
      body: {},
      transport: "native",
    });
    throw new Error("self-test requestJson runtime timeout did not fire");
  } catch (error) {
    if (
      !(error instanceof RequestTimeoutError) ||
      error.path !== `${API_PREFIX}/deploy`
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
  bun run smoke:platform-control-plane -- --url <origin> --workspace <workspace_...|@handle> --cloudflare-api-token-file <path> --cloudflare-account-id-file <path>

Required inputs:
  --url <origin>                                  or TAKOSUMI_PLATFORM_URL
  --workspace <workspace_...|@handle>             or TAKOSUMI_SMOKE_WORKSPACE
  --session-token-file <path>                     or TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE / TAKOSUMI_ACCOUNT_SESSION_TOKEN
  --pat-token-file <path>                         or TAKOSUMI_ACCOUNT_PAT_TOKEN_FILE / TAKOSUMI_ACCOUNT_PAT_TOKEN
  --cloudflare-api-token-file <path>              or CLOUDFLARE_API_TOKEN_FILE / CLOUDFLARE_API_TOKEN; not required with --cloudflare-connection-mode none
  --cloudflare-account-id-file <path>             or CLOUDFLARE_ACCOUNT_ID_FILE; not required with --cloudflare-connection-mode none
  --cloudflare-account-id <id>                    or CLOUDFLARE_ACCOUNT_ID; not required with --cloudflare-connection-mode none
  --cloudflare-workers-subdomain-file <path>      or CLOUDFLARE_WORKERS_SUBDOMAIN_FILE; only required for cloudflare-worker verification
  --cloudflare-workers-subdomain <name>           or CLOUDFLARE_WORKERS_SUBDOMAIN; only required for cloudflare-worker verification

Options:
  --app-name <name>                               default takosumi-smoke-<random>
  --environment <name>                            default inferred from --url
  --ensure-workspace                              create @handle scratch Workspace when missing; validates existing workspace ids
  --workspace-display-name <name>                 display name used with --ensure-workspace
  --cloudflare-connection-mode <guided|generic-env|none> default guided; none verifies keyless OpenTofu Capsules with --verification-mode opentofu
  --cloudflare-resource-preflight <account-resources|d1|none>
                                                   verify the Cloudflare token can read account resources before resource-creating applies; account-resources checks D1, KV, R2, Queues, and Workflows
  --runner-profile-id <id>                         request an enabled runner profile for upload deploys; or TAKOSUMI_SMOKE_RUNNER_PROFILE_ID; providerless OpenTofu defaults to ${DEFAULT_PROVIDERLESS_RUNNER_PROFILE_ID}
  --auth-token-kind <session|pat>                 explicit bearer kind for validation; inferred from --pat-token-file when omitted
  --capsule-dir <path>                            default cloudflare-hello-worker module
  --source-git-url <url>                          use Git Source sync instead of upload archive (or TAKOSUMI_SMOKE_SOURCE_GIT_URL)
  --source-ref <ref>                              Git ref for --source-git-url, default main
  --source-path <path>                            Source archive path inside the Git repo, default .
  --module-path <path>                            OpenTofu Capsule module path inside the SourceSnapshot archive
  --source-name <name>                            Source display name, default <app-name>-source
  --verification-mode <cloudflare-worker|opentofu> default cloudflare-worker; opentofu verifies plan/apply/destroy without public Worker checks
  --vars-json <json>                              OpenTofu variable object passed to the generated root
  --vars-json-file <path>                         read OpenTofu variable object from a JSON file
  --output-allowlist-json <json>                  output projection object; default url + worker_name for the hello-worker smoke
  --output-allowlist-json-file <path>             read output projection object from a JSON file
  --public-url-checks-json <json>                 optional array of {output,path,expectedStatus,bodyIncludes[]} checks against allowlisted public URL outputs
  --public-url-checks-json-file <path>            read public URL checks from a JSON file
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

function defaultSmokeEnvironment(url: string): string {
  const hostname = new URL(normalizeBaseUrl(url)).hostname;
  if (hostname === "app.takosumi.com") return "production-smoke";
  if (hostname === "app-staging.takosumi.com") return "staging-smoke";
  return "smoke";
}
