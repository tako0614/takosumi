#!/usr/bin/env bun
/**
 * Hosted Takosumi Layer-2 smoke.
 *
 * This proves the product control-plane loop, not only the raw provider/module:
 * signed-in Account session -> Space ProviderConnection -> upload Capsule ->
 * plan/apply -> Deployment ->
 * Cloudflare verification -> destroy-plan/approval/destroy-apply.
 *
 * Secret values are read only from the operator environment or files and are
 * never printed in the result.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const PLATFORM_CONTROL_PLANE_SMOKE_KIND =
  "takosumi.platform-control-plane-smoke@v1" as const;

const TAKOSUMI_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CAPSULE_DIR = resolve(
  TAKOSUMI_ROOT,
  "providers/cloudflare/modules/cloudflare-hello-worker/module",
);
const API_PREFIX = "/api/v1";
const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "waiting_approval",
]);
type SmokeCheckStatus = "passed" | "denied" | "not_reached";

export interface PlatformControlPlaneSmokeOptions {
  readonly url: string;
  readonly accountSessionToken: string;
  readonly accountSessionTokenSource: "env" | "file";
  readonly cloudflareApiToken: string;
  readonly cloudflareApiTokenSource: "env" | "file";
  readonly cloudflareAccountId: string;
  readonly cloudflareAccountIdSource: "env" | "file" | "arg";
  readonly space: string;
  readonly appName: string;
  readonly environment: string;
  readonly capsuleDir: string;
  readonly timeoutSeconds: number;
  readonly pollIntervalMs: number;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly keepConnection: boolean;
  readonly ensureSpace: boolean;
  readonly spaceDisplayName?: string;
}

export interface PlatformControlPlaneSmokeResult {
  readonly kind: typeof PLATFORM_CONTROL_PLANE_SMOKE_KIND;
  readonly status: "passed" | "dry_run" | "failed";
  readonly generatedAt: string;
  readonly serviceUrl: string;
  readonly scratchSpaceId: string;
  readonly capsuleModule: "cloudflare-hello-worker";
  readonly credentialPath: "space_scoped_provider_connection";
  readonly steps: readonly string[];
  readonly appName: string;
  readonly environment: string;
  readonly connectionId?: string;
  readonly providerConnectionId?: string;
  readonly installationId?: string;
  readonly planRunId?: string;
  readonly applyRunId?: string;
  readonly destroyPlanRunId?: string;
  readonly destroyApplyRunId?: string;
  readonly capsuleGateStatus: SmokeCheckStatus;
  readonly policyStatus: SmokeCheckStatus;
  readonly deploymentVerified: boolean;
  readonly destroyVerified: boolean;
  readonly connectionRevoked?: boolean;
  readonly error?: string;
  readonly nextAction?: string;
  readonly inputs: {
    readonly accountSessionTokenSource: "env" | "file";
    readonly cloudflareApiTokenSource: "env" | "file";
    readonly cloudflareAccountIdSource: "env" | "file" | "arg";
    readonly cloudflareAccountIdDigest: string;
    readonly capsuleDir: string;
  };
}

interface CliArgs {
  readonly help?: boolean;
  readonly selfTest?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly keepConnection?: boolean;
  readonly ensureSpace?: boolean;
  readonly url?: string;
  readonly sessionTokenFile?: string;
  readonly cloudflareApiTokenFile?: string;
  readonly cloudflareAccountId?: string;
  readonly cloudflareAccountIdFile?: string;
  readonly space?: string;
  readonly spaceDisplayName?: string;
  readonly appName?: string;
  readonly environment?: string;
  readonly capsuleDir?: string;
  readonly timeoutSeconds?: string;
  readonly pollIntervalMs?: string;
}

interface RequestOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly binary?: Uint8Array;
  readonly allowEmpty?: boolean;
}

interface RunRecord {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly policyStatus?: string;
}

interface DeployResponse {
  readonly installation: { readonly id: string; readonly name?: string };
  readonly run: RunRecord;
  readonly planRun?: RunRecord;
  readonly applyRun?: RunRecord;
  readonly created?: boolean;
}

interface InstallationRecord {
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
  readonly currentStateGeneration?: number;
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
    writeResult(result, options);
    return 0;
  }

  const result = await runPlatformControlPlaneSmoke(options);
  writeResult(result, options);
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
  const space = args.space ?? env.TAKOSUMI_SMOKE_SPACE;
  if (!space) {
    throw new Error("--space or TAKOSUMI_SMOKE_SPACE is required");
  }
  const cloudflareAccountId = await readNonSecretInput({
    file: args.cloudflareAccountIdFile ?? env.CLOUDFLARE_ACCOUNT_ID_FILE,
    value: args.cloudflareAccountId,
    envValue: env.CLOUDFLARE_ACCOUNT_ID,
    envName: "CLOUDFLARE_ACCOUNT_ID",
    label: "Cloudflare account id",
    dryRun: args.dryRun === true,
  });
  const accountSessionToken = await readSecret({
    file: args.sessionTokenFile ?? env.TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE,
    envValue: env.TAKOSUMI_ACCOUNT_SESSION_TOKEN,
    envName: "TAKOSUMI_ACCOUNT_SESSION_TOKEN",
    label: "account session token",
    dryRun: args.dryRun === true,
  });
  const cloudflareApiToken = await readSecret({
    file: args.cloudflareApiTokenFile ?? env.CLOUDFLARE_API_TOKEN_FILE,
    envValue: env.CLOUDFLARE_API_TOKEN,
    envName: "CLOUDFLARE_API_TOKEN",
    label: "Cloudflare API token",
    dryRun: args.dryRun === true,
  });
  const capsuleDir = resolve(args.capsuleDir ?? DEFAULT_CAPSULE_DIR);
  if (args.dryRun !== true) {
    await access(capsuleDir);
  }
  return {
    url: normalizeBaseUrl(url),
    accountSessionToken: accountSessionToken.value,
    accountSessionTokenSource: accountSessionToken.source,
    cloudflareApiToken: cloudflareApiToken.value,
    cloudflareApiTokenSource: cloudflareApiToken.source,
    cloudflareAccountId: cloudflareAccountId.value,
    cloudflareAccountIdSource: cloudflareAccountId.source,
    space,
    appName: args.appName ?? defaultAppName(),
    environment: args.environment ?? defaultSmokeEnvironment(url),
    capsuleDir,
    timeoutSeconds: parsePositiveInteger(
      args.timeoutSeconds,
      "--timeout-seconds",
      600,
    ),
    pollIntervalMs: parsePositiveInteger(
      args.pollIntervalMs,
      "--poll-interval-ms",
      2_000,
    ),
    dryRun: args.dryRun === true,
    json: args.json === true,
    keepConnection: args.keepConnection === true,
    ensureSpace: args.ensureSpace === true,
    ...(args.spaceDisplayName
      ? { spaceDisplayName: args.spaceDisplayName }
      : {}),
  };
}

export function dryRunResult(
  options: PlatformControlPlaneSmokeOptions,
): PlatformControlPlaneSmokeResult {
  return {
    kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
    status: "dry_run",
    generatedAt: new Date().toISOString(),
    serviceUrl: options.url,
    scratchSpaceId: options.space,
    capsuleModule: "cloudflare-hello-worker",
    credentialPath: "space_scoped_provider_connection",
    steps: requiredSteps(),
    appName: options.appName,
    environment: options.environment,
    capsuleGateStatus: "passed",
    policyStatus: "passed",
    deploymentVerified: true,
    destroyVerified: true,
    inputs: publicInputSummary(options),
  };
}

export async function runPlatformControlPlaneSmoke(
  options: PlatformControlPlaneSmokeOptions,
): Promise<PlatformControlPlaneSmokeResult> {
  const spaceId = await resolveSpaceId(options);
  let connectionId: string | undefined;
  let providerConnectionId: string | undefined;
  let connectionRevoked = false;
  let installationId: string | undefined;
  let planRunId: string | undefined;
  let applyRunId: string | undefined;
  let destroyPlanRunId: string | undefined;
  let destroyApplyRunId: string | undefined;
  let capsuleGateStatus: SmokeCheckStatus = "not_reached";
  let policyStatus: SmokeCheckStatus = "not_reached";
  let failure: unknown;

  try {
    const connection = await createSpaceCloudflareConnection(options, spaceId);
    connectionId = connection.rawConnectionId;
    providerConnectionId = connection.providerConnectionId;
    const snapshot = await uploadCapsule(options, spaceId);
    const deploy = await deploySnapshot(options, {
      spaceId,
      snapshotId: snapshot.id,
      providerConnectionId,
    });
    installationId = deploy.installation.id;
    planRunId = deploy.planRun?.id ?? deploy.run.id;
    capsuleGateStatus = "passed";
    const completedPlan = await ensurePlanReadyForApply(options, planRunId);
    policyStatus = publicPolicyStatus(completedPlan);
    assertRunSucceeded(completedPlan, "plan");
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
    await assertCloudflareWorkerExists(options);

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
    await assertCloudflareWorkerGone(options);

    if (!options.keepConnection) {
      connectionRevoked = await revokeConnection(options, connectionId);
    }
    return {
      kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
      status: "passed",
      generatedAt: new Date().toISOString(),
      serviceUrl: options.url,
      scratchSpaceId: spaceId,
      capsuleModule: "cloudflare-hello-worker",
      credentialPath: "space_scoped_provider_connection",
      steps: requiredSteps(),
      appName: options.appName,
      environment: options.environment,
      connectionId,
      providerConnectionId,
      installationId,
      planRunId,
      applyRunId,
      destroyPlanRunId,
      destroyApplyRunId,
      capsuleGateStatus: "passed",
      policyStatus:
        completedApply.policyStatus === "deny" ||
        completedDestroy.policyStatus === "deny"
          ? failPolicy()
          : "passed",
      deploymentVerified: true,
      destroyVerified: true,
      connectionRevoked,
      inputs: publicInputSummary(options),
    };
  } catch (error) {
    await markPendingSmokeInstallationError(options, {
      spaceId,
      installationId,
    }).catch(() => undefined);
    failure = error;
  } finally {
    if (connectionId && !options.keepConnection && !connectionRevoked) {
      connectionRevoked = await revokeConnection(options, connectionId);
    }
  }
  return failedResult(options, {
    spaceId,
    connectionId,
    providerConnectionId,
    installationId,
    planRunId,
    applyRunId,
    destroyPlanRunId,
    destroyApplyRunId,
    capsuleGateStatus,
    policyStatus,
    connectionRevoked,
    error: failure,
  });
}

function failedResult(
  options: PlatformControlPlaneSmokeOptions,
  input: {
    readonly spaceId: string;
    readonly connectionId?: string;
    readonly providerConnectionId?: string;
    readonly installationId?: string;
    readonly planRunId?: string;
    readonly applyRunId?: string;
    readonly destroyPlanRunId?: string;
    readonly destroyApplyRunId?: string;
    readonly capsuleGateStatus: SmokeCheckStatus;
    readonly policyStatus: SmokeCheckStatus;
    readonly connectionRevoked?: boolean;
    readonly error: unknown;
  },
): PlatformControlPlaneSmokeResult {
  return {
    kind: PLATFORM_CONTROL_PLANE_SMOKE_KIND,
    status: "failed",
    generatedAt: new Date().toISOString(),
    serviceUrl: options.url,
    scratchSpaceId: input.spaceId,
    capsuleModule: "cloudflare-hello-worker",
    credentialPath: "space_scoped_provider_connection",
    steps: requiredSteps(),
    appName: options.appName,
    environment: options.environment,
    connectionId: input.connectionId,
    providerConnectionId: input.providerConnectionId,
    installationId: input.installationId,
    planRunId: input.planRunId,
    applyRunId: input.applyRunId,
    destroyPlanRunId: input.destroyPlanRunId,
    destroyApplyRunId: input.destroyApplyRunId,
    capsuleGateStatus: input.capsuleGateStatus,
    policyStatus: input.policyStatus,
    deploymentVerified: false,
    destroyVerified: false,
    connectionRevoked: input.connectionRevoked,
    error: publicErrorMessage(input.error),
    nextAction:
      "Inspect the recorded run and installation ids, confirm any temporary Cloudflare resources are destroyed, then rerun the smoke after the blocking run reaches a terminal state.",
    inputs: publicInputSummary(options),
  };
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
      `space @${normalized} was not found; pass --ensure-space or create the scratch Space first`,
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
    body: {
      spaceId,
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

async function lookupPublicProviderConnectionId(
  options: PlatformControlPlaneSmokeOptions,
  spaceId: string,
  displayName: string,
): Promise<string> {
  const response = await requestJson<{
    readonly providerConnections?: readonly {
      readonly id?: string;
      readonly providerSource?: string;
      readonly displayName?: string;
    }[];
  }>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    path: `${API_PREFIX}/provider-connections?spaceId=${encodeURIComponent(spaceId)}`,
  });
  const match = (response.providerConnections ?? []).find(
    (connection) =>
      connection.providerSource === "cloudflare" &&
      connection.displayName === displayName &&
      typeof connection.id === "string",
  );
  if (!match?.id) {
    throw new Error(
      "created connection did not appear in provider-connections",
    );
  }
  return match.id;
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
    readonly providerConnectionId: string;
  },
): Promise<DeployResponse> {
  return await requestJson<DeployResponse>({
    baseUrl: options.url,
    token: options.accountSessionToken,
    method: "POST",
    path: `${API_PREFIX}/deploy`,
    body: {
      spaceId: input.spaceId,
      name: options.appName,
      environment: options.environment,
      snapshotId: input.snapshotId,
      vars: {
        accountId: options.cloudflareAccountId,
        appName: options.appName,
      },
      providerConnections: [
        {
          provider: "cloudflare",
          alias: "main",
          connectionId: input.providerConnectionId,
        },
      ],
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
  throw new Error(`run ${runId} did not reach a terminal state`);
}

function assertRunSucceeded(run: RunRecord, phase: string): void {
  if (run.status !== "succeeded") {
    throw new Error(`${phase} run ${run.id} ended as ${run.status}`);
  }
  if (run.policyStatus === "deny") {
    throw new Error(`${phase} run ${run.id} was denied by policy`);
  }
}

async function assertCloudflareWorkerExists(
  options: PlatformControlPlaneSmokeOptions,
): Promise<void> {
  const response = await cloudflareScriptRequest(options, "GET");
  if (response.status !== 200) {
    throw new Error(
      `Cloudflare Worker ${options.appName} was not readable after apply (HTTP ${response.status})`,
    );
  }
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

async function cloudflareScriptRequest(
  options: PlatformControlPlaneSmokeOptions,
  method: "GET",
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
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${options.token}`,
  };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.binary !== undefined) {
    headers["content-type"] = "application/zstd";
    init.body = options.binary as unknown as BodyInit;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${options.baseUrl}${options.path}`, init);
  const text = await response.text();
  const body = text.trim().length > 0 ? JSON.parse(text) : undefined;
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

function tarZstd(dir: string): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["--zstd", "-cf", "-", "-C", dir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  throw new Error(
    `${input.label} is required: pass --cloudflare-account-id-file, --cloudflare-account-id, or set ${input.envName}`,
  );
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

function defaultAppName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `takosumi-smoke-${suffix}`;
}

function publicInputSummary(options: PlatformControlPlaneSmokeOptions): {
  readonly accountSessionTokenSource: "env" | "file";
  readonly cloudflareApiTokenSource: "env" | "file";
  readonly cloudflareAccountIdSource: "env" | "file" | "arg";
  readonly cloudflareAccountIdDigest: string;
  readonly capsuleDir: string;
} {
  return {
    accountSessionTokenSource: options.accountSessionTokenSource,
    cloudflareApiTokenSource: options.cloudflareApiTokenSource,
    cloudflareAccountIdSource: options.cloudflareAccountIdSource,
    cloudflareAccountIdDigest: sha256(options.cloudflareAccountId),
    capsuleDir: options.capsuleDir,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requiredSteps(): readonly string[] {
  return [
    "spaceScopedProviderConnection",
    "connectionVerified",
    "scratchInstall",
    "plan",
    "apply",
    "deploymentVerified",
    "destroy",
  ];
}

function writeResult(
  result: PlatformControlPlaneSmokeResult,
  options: PlatformControlPlaneSmokeOptions,
): void {
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
  console.log(`space: ${result.scratchSpaceId}`);
  console.log(`capsule: ${result.capsuleModule}`);
  console.log(`app: ${result.appName}`);
  if (result.installationId)
    console.log(`installation: ${result.installationId}`);
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

async function runSelfTest(): Promise<void> {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      space: "space_selftest",
      cloudflareAccountIdFile: "/private/cloudflare-account-id",
      appName: "takosumi-smoke-selftest",
      ensureSpace: true,
      sessionTokenFile: "/private/account-session-token",
      cloudflareApiTokenFile: "/private/cloudflare-token",
    },
    {},
  );
  const result = dryRunResult(options);
  const serialized = JSON.stringify(result);
  if (serialized.includes("account-session-token")) {
    throw new Error("self-test leaked account session token file name");
  }
  if (serialized.includes("cloudflare-token")) {
    throw new Error("self-test leaked Cloudflare token file name");
  }
  if (serialized.includes("cloudflare-account-id")) {
    throw new Error("self-test leaked Cloudflare account id file name");
  }
  if (serialized.includes("acc_selftest")) {
    throw new Error("self-test leaked Cloudflare account id");
  }
  if (!result.steps.includes("destroy")) {
    throw new Error("self-test result is missing destroy step");
  }
  const failed = failedResult(options, {
    spaceId: "space_selftest",
    connectionId: "conn_selftest",
    connectionRevoked: true,
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
  console.log("platform control-plane smoke self-test passed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function printHelp(): void {
  console.log(`Usage:
  bun run smoke:platform-control-plane -- --url <origin> --space <space_...|@handle> --cloudflare-api-token-file <path> --cloudflare-account-id-file <path>

Required inputs:
  --url <origin>                         or TAKOSUMI_PLATFORM_URL
  --space <space_...|@handle>            or TAKOSUMI_SMOKE_SPACE
  --session-token-file <path>            or TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE / TAKOSUMI_ACCOUNT_SESSION_TOKEN
  --cloudflare-api-token-file <path>     or CLOUDFLARE_API_TOKEN_FILE / CLOUDFLARE_API_TOKEN
  --cloudflare-account-id-file <path>    or CLOUDFLARE_ACCOUNT_ID_FILE
  --cloudflare-account-id <id>           or CLOUDFLARE_ACCOUNT_ID

Options:
  --app-name <name>                      default takosumi-smoke-<random>
  --environment <name>                   default inferred from --url
  --ensure-space                         create @handle scratch Space when missing; validates space_... ids
  --space-display-name <name>            display name used with --ensure-space
  --capsule-dir <path>                   default cloudflare-hello-worker module
  --timeout-seconds <n>                  default 600
  --poll-interval-ms <n>                 default 2000
  --keep-connection                      keep the temporary Space ProviderConnection
  --dry-run                              validate shape and print redacted plan
  --json                                 print JSON only
  --self-test                            run offline redaction/shape self-test
`);
}

function defaultSmokeEnvironment(url: string): string {
  const hostname = new URL(normalizeBaseUrl(url)).hostname;
  if (hostname === "app.takosumi.com") return "production-smoke";
  if (hostname === "app-staging.takosumi.com") return "staging-smoke";
  return "smoke";
}
