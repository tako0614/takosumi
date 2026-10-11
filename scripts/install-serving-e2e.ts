#!/usr/bin/env bun
/**
 * One-command install -> serving E2E for a Takosumi environment.
 *
 * The harness pins one known app profile (a Git module), drives the canonical
 * Source -> Install plan -> Plan -> Apply -> Output -> HTTP -> Destroy lifecycle
 * through the existing `smoke:platform-control-plane` Run authority, and turns a
 * non-serving outcome into one explicit `phase=... reason=...` line.
 *
 * Design rules:
 * - The product smoke stays the only Run authority; this file never talks to a
 *   provider directly and never repeats a mutation on its own.
 * - A failing Run is reported with the phase derived from the smoke's own step
 *   order plus the Run `errorCode` and the redacted Run diagnostic.
 * - Credential material is read from a file and never printed or persisted.
 *
 * Deliberately uncovered: production, container-based apps, and native actor
 * lifecycle. Those are separate surfaces with their own authorities.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const INSTALL_SERVING_E2E_KIND =
  "takosumi.install-serving-e2e@v1" as const;

const API_PREFIX = "/api/v1";
export const DEFAULT_ORIGIN = "https://app-staging.takosumi.com";
const TAKOSUMI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_ENTRY = "smoke:platform-control-plane";
const TAKOFORM_PROVIDER_SOURCE =
  "registry.terraform.io/tako0614/takoform" as const;
const TOKEN_FILE_ENV_NAMES = [
  "TAKOSUMI_INSTALL_E2E_TOKEN_FILE",
  "TAKOSUMI_ACCOUNT_PAT_TOKEN_FILE",
  "TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE",
] as const;
const WORKSPACE_ENV_NAMES = [
  "TAKOSUMI_INSTALL_E2E_WORKSPACE",
  "TAKOSUMI_SMOKE_WORKSPACE",
] as const;
const TOKEN_FILE_MAX_BYTES = 64 * 1024;
const HTTP_TIMEOUT_MS = 30_000;

type OutputAllowlistEntry = {
  readonly from: string;
  readonly type: "string" | "url" | "json";
  readonly required?: boolean;
};

type PublicUrlCheck = {
  readonly name: string;
  readonly output: string;
  readonly path: string;
  readonly expectedStatus: number;
  readonly bodyIncludes: readonly string[];
  readonly destroyExpectation: { readonly kind: "http-404" };
};

export type InstallServingProfile = {
  readonly id: string;
  readonly sourceGitUrl: string;
  readonly sourcePath: string;
  readonly modulePath: string;
  readonly runtimePublicUrlOutput: string;
  readonly appPrefix: string;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly publicUrlChecks: readonly PublicUrlCheck[];
};

const YURUCOMMU_PROFILE_OUTPUT_LAUNCH_URL = "launch_url" as const;

/**
 * The one known app. `launch_url` is the managed runtime URL the provider
 * projects, and the checks assert real content, not just a 200.
 */
export const YURUCOMMU_PROFILE: InstallServingProfile = Object.freeze({
  id: "yurucommu",
  sourceGitUrl: "https://github.com/tako0614/yurucommu.git",
  // Yurucommu's install destination is the whole repository with module
  // `deploy/takoform`: `.well-known/tcs.json` names that `modulePath`, and the
  // site install link passes it as `path` with the default Source path. The
  // module's repository-owned `sourceBuild` runs at the SourceSnapshot root
  // (`bun install` against the root `package.json`, then the root build
  // scripts) and must produce `deploy/takoform/...` outputs, so the snapshot
  // has to be the repository root. A Source scoped to `deploy/takoform` holds
  // neither, and its Plan fails `source_build_failed`.
  sourcePath: ".",
  // `modulePath` is relative to the SourceSnapshot root that `sourcePath`
  // pins. Repeating a scoped Source path here makes the compatibility check
  // reject the tree with `repository_install_ux_module_missing`.
  modulePath: "deploy/takoform",
  runtimePublicUrlOutput: "launch_url",
  appPrefix: "yuru-install-e2e",
  outputAllowlist: Object.freeze({
    launch_url: { from: "launch_url", type: "url", required: true },
    takoform_resource_ids: {
      from: "takoform_resource_ids",
      type: "json",
      required: true,
    },
  }),
  publicUrlChecks: Object.freeze([
    publicUrlCheck("healthz", "/healthz", [
      '"service":"yurucommu"',
      '"status":"ok"',
    ]),
    publicUrlCheck("readyz", "/readyz", [
      '"service":"yurucommu"',
      '"status":"ok"',
    ]),
    publicUrlCheck("social-server", "/.well-known/social-server", [
      '"product":"yurucommu"',
      '"server":{',
    ]),
    publicUrlCheck("nodeinfo", "/nodeinfo/2.0", [
      '"name":"yurucommu"',
      '"version":"2.0"',
    ]),
  ]),
});

function publicUrlCheck(
  name: string,
  path: string,
  bodyIncludes: readonly string[],
): PublicUrlCheck {
  return Object.freeze({
    name,
    output: YURUCOMMU_PROFILE_OUTPUT_LAUNCH_URL,
    path,
    expectedStatus: 200,
    bodyIncludes: Object.freeze(bodyIncludes),
    destroyExpectation: Object.freeze({ kind: "http-404" as const }),
  });
}

/**
 * Ordered phase groups over the product smoke's own step vocabulary. The first
 * step that is listed but not completed names the failing phase, so the harness
 * never invents its own notion of progress.
 */
export const PHASE_GROUPS: readonly {
  readonly phase: string;
  readonly steps: readonly string[];
}[] = Object.freeze([
  {
    phase: "connection",
    steps: [
      "existingProviderConnectionSelected",
      "existingProviderConnectionsSelected",
      "providerConnectionNotRequired",
      "workspaceScopedProviderConnection",
      "genericEnvProviderConnection",
      "connectionVerified",
    ],
  },
  { phase: "preflight", steps: ["cloudflareResourcePreflight"] },
  { phase: "source", steps: ["sourceRegistered", "sourceSynced"] },
  { phase: "install-plan", steps: ["scratchInstall"] },
  { phase: "compatibility", steps: ["compatibilityChecked"] },
  { phase: "plan", steps: ["plan"] },
  {
    phase: "apply",
    steps: ["apply", "opentofuApplyVerified", "runtimeVerified"],
  },
  { phase: "output", steps: ["stateVersionLedgerVerified"] },
  { phase: "serving", steps: ["publicUrlVerified"] },
  { phase: "probe", steps: ["functionalProbe"] },
  {
    phase: "interface",
    steps: [
      "interfaceMaterializationVerified",
      "interfaceTokenProofVerified",
      "interfaceRetiredVerified",
    ],
  },
  { phase: "destroy", steps: ["destroy"] },
  {
    phase: "evidence",
    steps: ["releaseActivationVerified", "runEventSequenceVerified"],
  },
  { phase: "cleanup", steps: ["connectionRevoked"] },
]);

export function phaseOfStep(step: string): string {
  for (const group of PHASE_GROUPS) {
    if (group.steps.includes(step)) return group.phase;
  }
  return "unknown";
}

export type InstallServingPhaseStatus = {
  readonly phase: string;
  readonly status: "passed" | "failed" | "not_reached";
  readonly steps: readonly {
    readonly step: string;
    readonly durationMs: number;
  }[];
};

export type InstallServingSummary = {
  readonly phases: readonly InstallServingPhaseStatus[];
  readonly failedPhase: string;
  readonly failedStep?: string;
  readonly notReachedPhases: readonly string[];
  readonly runIds: Readonly<Record<string, string>>;
};

type SmokeStepTiming = {
  readonly step?: string;
  readonly durationMs?: number;
};

export type SmokeResultView = {
  readonly status?: string;
  readonly steps?: readonly string[];
  readonly completedSteps?: readonly string[];
  readonly stepTimings?: readonly SmokeStepTiming[];
  readonly capsuleId?: string;
  readonly sourceId?: string;
  readonly sourceSnapshotId?: string;
  readonly installConfigId?: string;
  readonly planRunId?: string;
  readonly applyRunId?: string;
  readonly destroyPlanRunId?: string;
  readonly destroyApplyRunId?: string;
  readonly sourceSyncRunId?: string;
  readonly providerConnectionId?: string;
  readonly workerUrl?: string;
  readonly error?: string;
  readonly publicUrlChecks?: readonly {
    readonly name?: string;
    readonly url?: string;
    readonly status?: number;
    readonly ok?: boolean;
    readonly bodyIncludes?: readonly string[];
  }[];
};

/**
 * Derive per-phase status from the smoke's declared step list so a failure
 * names the phase instead of only the product's internal step name.
 */
export function summarizeSmokeResult(
  result: SmokeResultView,
): InstallServingSummary {
  const declared = result.steps ?? [];
  const completed = new Set(result.completedSteps ?? []);
  const durations = new Map<string, number>();
  for (const timing of result.stepTimings ?? []) {
    if (typeof timing.step === "string") {
      durations.set(timing.step, timing.durationMs ?? 0);
    }
  }

  const failedStep = result.status === "passed"
    ? undefined
    : declared.find((step) => !completed.has(step));
  const failedPhase = failedStep ? phaseOfStep(failedStep) : "complete";

  const phases: InstallServingPhaseStatus[] = [];
  for (const group of PHASE_GROUPS) {
    const steps = declared
      .filter((step) => group.steps.includes(step))
      .map((step) => ({ step, durationMs: durations.get(step) ?? 0 }));
    if (steps.length === 0) continue;
    const hasFailure = failedStep !== undefined && steps.some(
      (entry) => entry.step === failedStep,
    );
    const reached = steps.some((entry) => completed.has(entry.step));
    phases.push({
      phase: group.phase,
      status: hasFailure ? "failed" : reached ? "passed" : "not_reached",
      steps,
    });
  }

  const runIds: Record<string, string> = {};
  for (
    const [label, value] of [
      ["sourceSync", result.sourceSyncRunId],
      ["plan", result.planRunId],
      ["apply", result.applyRunId],
      ["destroyPlan", result.destroyPlanRunId],
      ["destroyApply", result.destroyApplyRunId],
    ] as const
  ) {
    if (typeof value === "string" && value) runIds[label] = value;
  }

  return {
    phases,
    failedPhase,
    ...(failedStep === undefined ? {} : { failedStep }),
    notReachedPhases: phases
      .filter((entry) => entry.status === "not_reached")
      .map((entry) => entry.phase),
    runIds,
  };
}

export type InstallServingOptions = {
  readonly origin: string;
  readonly workspace: string;
  readonly connectionId?: string;
  readonly tokenFile: string;
  readonly authTokenKind: "pat" | "session";
  readonly profile: InstallServingProfile;
  readonly appName: string;
  readonly sourceRef?: string;
  readonly evidenceDir: string;
  readonly environment: string;
  readonly timeoutSeconds: number;
  readonly deployTimeoutSeconds: number;
  readonly json: boolean;
  readonly dryRun: boolean;
};

export function resolveHarnessOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): InstallServingOptions {
  const args = parseArgs(argv);
  const origin = normalizeOrigin(
    args.origin ?? env.TAKOSUMI_INSTALL_E2E_ORIGIN ?? DEFAULT_ORIGIN,
  );
  const workspace = args.workspace ?? envValue(env, WORKSPACE_ENV_NAMES);
  if (!workspace) {
    throw new Error(
      "--workspace <ws_...|@handle> is required (or TAKOSUMI_INSTALL_E2E_WORKSPACE)",
    );
  }
  const tokenFile = args.tokenFile ??
    args.patTokenFile ??
    args.sessionTokenFile ??
    envValue(env, TOKEN_FILE_ENV_NAMES);
  if (!tokenFile) {
    throw new Error(
      "--token-file <path> is required: a Takosumi Account PAT or session token file (or TAKOSUMI_INSTALL_E2E_TOKEN_FILE)",
    );
  }
  if (!isAbsolute(tokenFile)) {
    throw new Error("--token-file must be an absolute path");
  }
  const authTokenKind = args.authTokenKind ??
    (args.sessionTokenFile && !args.patTokenFile ? "session" : "pat");
  if (authTokenKind !== "pat" && authTokenKind !== "session") {
    throw new Error("--auth-token-kind must be pat or session");
  }
  const stamp = timestampSlug();
  return Object.freeze({
    origin,
    workspace,
    ...(args.connectionId === undefined
      ? {}
      : { connectionId: args.connectionId }),
    tokenFile: resolve(tokenFile),
    authTokenKind,
    profile: YURUCOMMU_PROFILE,
    appName: args.appName ?? defaultAppName(stamp),
    ...(args.sourceRef === undefined ? {} : { sourceRef: args.sourceRef }),
    evidenceDir: resolve(
      args.evidenceDir ??
        join(tmpdir(), "takosumi-install-serving-e2e", stamp),
    ),
    environment: args.environment ?? "integration",
    timeoutSeconds: positiveInteger(args.timeoutSeconds, 900),
    deployTimeoutSeconds: positiveInteger(args.deployTimeoutSeconds, 600),
    json: args.json === true,
    dryRun: args.dryRun === true,
  });
}

type RawArgs = {
  readonly origin?: string;
  readonly workspace?: string;
  readonly connectionId?: string;
  readonly tokenFile?: string;
  readonly patTokenFile?: string;
  readonly sessionTokenFile?: string;
  readonly authTokenKind?: string;
  readonly appName?: string;
  readonly sourceRef?: string;
  readonly evidenceDir?: string;
  readonly environment?: string;
  readonly timeoutSeconds?: string;
  readonly deployTimeoutSeconds?: string;
  readonly json?: boolean;
  readonly dryRun?: boolean;
  readonly help?: boolean;
};

const STRING_FLAGS: Readonly<Record<string, keyof RawArgs>> = Object.freeze({
  "--origin": "origin",
  "--url": "origin",
  "--workspace": "workspace",
  "--connection-id": "connectionId",
  "--token-file": "tokenFile",
  "--pat-token-file": "patTokenFile",
  "--session-token-file": "sessionTokenFile",
  "--auth-token-kind": "authTokenKind",
  "--app-name": "appName",
  "--source-ref": "sourceRef",
  "--evidence-dir": "evidenceDir",
  "--environment": "environment",
  "--timeout-seconds": "timeoutSeconds",
  "--deploy-timeout-seconds": "deployTimeoutSeconds",
});

function parseArgs(argv: readonly string[]): RawArgs {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") continue;
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    const key = STRING_FLAGS[token];
    if (key === undefined) {
      throw new Error(
        `unknown option ${token}; run with --help for the exact surface`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed as RawArgs;
}

export function buildSmokeInvocation(
  options: InstallServingOptions,
  resolved: { readonly workspaceId: string; readonly connectionId: string },
): readonly string[] {
  const profile = options.profile;
  return [
    "run",
    SMOKE_ENTRY,
    "--",
    "--url",
    options.origin,
    "--workspace",
    resolved.workspaceId,
    "--source-git-url",
    profile.sourceGitUrl,
    ...(options.sourceRef === undefined
      ? []
      : ["--source-ref", options.sourceRef]),
    "--source-path",
    profile.sourcePath,
    "--module-path",
    profile.modulePath,
    "--provider-connection-id",
    resolved.connectionId,
    "--cloudflare-connection-mode",
    "none",
    "--verification-mode",
    "opentofu",
    "--no-interface-proof",
    "--output-allowlist-json",
    JSON.stringify(profile.outputAllowlist),
    "--runtime-public-url-output",
    profile.runtimePublicUrlOutput,
    "--public-url-checks-json",
    JSON.stringify(profile.publicUrlChecks),
    "--app-name",
    options.appName,
    "--environment",
    options.environment,
    "--timeout-seconds",
    String(options.timeoutSeconds),
    "--deploy-timeout-seconds",
    String(options.deployTimeoutSeconds),
    "--out-file",
    join(options.evidenceDir, "smoke-result.json"),
    "--json",
    options.authTokenKind === "session" ? "--session-token-file" : "--pat-token-file",
    options.tokenFile,
  ];
}

export async function readTokenFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("token file must be a regular file");
  if (info.size === 0 || info.size > TOKEN_FILE_MAX_BYTES) {
    throw new Error("token file size is out of range");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("token file must not be group or world accessible");
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error("token file is empty");
  return value;
}

type ApiError = { readonly status: number; readonly detail: string };

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" && value !== null && "status" in value &&
    "detail" in value
  );
}

async function requestJson(input: {
  readonly origin: string;
  readonly token: string;
  readonly path: string;
  readonly method?: string;
}): Promise<unknown> {
  const response = await fetch(new URL(input.path, input.origin), {
    method: input.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.token}`,
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) {
    throw {
      status: response.status,
      detail: `HTTP ${response.status}`,
    } satisfies ApiError;
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw {
      status: response.status,
      detail: "response was not JSON",
    } satisfies ApiError;
  }
}

type ConnectionEntry = {
  readonly id?: string;
  readonly providerSource?: string;
  readonly displayName?: string;
  readonly credentialRecipe?: { readonly authMode?: string };
};

export type ResolvedTarget = {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly connectionProviderSource: string;
};

export function canonicalProviderSource(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("registry.opentofu.org/")) {
    return `registry.terraform.io/${trimmed.slice("registry.opentofu.org/".length)}`;
  }
  return trimmed;
}

export function selectTakoformConnection(
  connections: readonly ConnectionEntry[],
  requestedId?: string,
): { readonly id: string; readonly providerSource: string } {
  if (requestedId !== undefined) {
    const match = connections.find((entry) => entry.id === requestedId);
    if (!match?.id) {
      throw new Error(`provider connection ${requestedId} is not in this Workspace`);
    }
    return {
      id: match.id,
      providerSource: canonicalProviderSource(match.providerSource ?? ""),
    };
  }
  const matches = connections.filter(
    (entry) =>
      typeof entry.id === "string" &&
      canonicalProviderSource(entry.providerSource ?? "") ===
        TAKOFORM_PROVIDER_SOURCE,
  );
  if (matches.length === 0) {
    throw new Error(
      `no ${TAKOFORM_PROVIDER_SOURCE} provider connection is available in this Workspace; pass --connection-id or connect one first`,
    );
  }
  // A Workspace can hold both the predecessor broker connection and the
  // current renewable run-credential connection. The renewable one is the
  // supported path, so it wins; anything still ambiguous needs an explicit id.
  const renewable = matches.filter(
    (entry) => entry.credentialRecipe?.authMode === "broker-renewable",
  );
  const candidates = renewable.length > 0 ? renewable : matches;
  if (candidates.length > 1) {
    throw new Error(
      `${candidates.length} ${TAKOFORM_PROVIDER_SOURCE} connections are equally eligible; pass --connection-id to select one`,
    );
  }
  const match = candidates[0];
  if (!match?.id) {
    throw new Error("provider connection entry did not expose an id");
  }
  return {
    id: match.id,
    providerSource: canonicalProviderSource(
      match.providerSource ?? TAKOFORM_PROVIDER_SOURCE,
    ),
  };
}

export async function resolveTarget(input: {
  readonly origin: string;
  readonly token: string;
  readonly workspace: string;
  readonly connectionId?: string;
}): Promise<ResolvedTarget> {
  const workspaceId = await resolveWorkspaceId(input);
  const body = await requestJson({
    origin: input.origin,
    token: input.token,
    path: `${API_PREFIX}/provider-connections?workspaceId=${encodeURIComponent(workspaceId)}`,
  });
  const connections = (body as { readonly providerConnections?: readonly ConnectionEntry[] })
    .providerConnections ?? [];
  const connection = selectTakoformConnection(connections, input.connectionId);
  return {
    workspaceId,
    connectionId: connection.id,
    connectionProviderSource: connection.providerSource,
  };
}

async function resolveWorkspaceId(input: {
  readonly origin: string;
  readonly token: string;
  readonly workspace: string;
}): Promise<string> {
  const requested = input.workspace.trim();
  if (!requested.startsWith("@")) return requested;
  const handle = requested.slice(1);
  const body = await requestJson({
    origin: input.origin,
    token: input.token,
    path: `${API_PREFIX}/workspaces?includeArchived=true&limit=100&order=updated_desc`,
  });
  const workspaces = (body as {
    readonly workspaces?: readonly { readonly id?: string; readonly handle?: string }[];
  }).workspaces ?? [];
  const match = workspaces.find((entry) => entry.handle === handle);
  if (!match?.id) {
    throw new Error(`Workspace @${handle} was not found for this account`);
  }
  return match.id;
}

export type RunDetail = {
  readonly status?: string;
  readonly errorCode?: string;
  readonly type?: string;
  readonly finishedAt?: string;
};

export type CapsuleView = {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly name?: string;
  readonly environment?: string;
  readonly status?: string;
};

export type RunSummary = {
  readonly id?: string;
  readonly capsuleId?: string;
  readonly type?: string;
  readonly status?: string;
  readonly errorCode?: string;
  readonly createdAt?: string;
};

/**
 * The product smoke drives Source, install plan, compatibility, and Plan inside
 * one coordinator call, so a coordinator failure stops before it records those
 * steps. The step gap alone would then name the first *unrecorded* step rather
 * than the operation that actually failed, so the harness also reads the Run
 * authority it already has access to.
 */
export function selectOwnCapsule(
  capsules: readonly CapsuleView[],
  input: { readonly appName: string; readonly environment?: string },
): CapsuleView | undefined {
  return capsules.find(
    (capsule) =>
      typeof capsule.id === "string" &&
      capsule.name === input.appName &&
      (input.environment === undefined ||
        capsule.environment === undefined ||
        capsule.environment === input.environment),
  );
}

/** Run types and phases share one vocabulary so a failure names one thing. */
export function phaseOfRunType(type: string | undefined): string | undefined {
  switch (type) {
    case "compatibility_check":
      return "compatibility";
    case "source_sync":
      return "source";
    case "plan":
      return "plan";
    case "apply":
      return "apply";
    default:
      return undefined;
  }
}

export function selectNewestFailedRun(
  runs: readonly RunSummary[],
  capsuleId: string,
): RunSummary | undefined {
  return runs
    .filter((run) => run.capsuleId === capsuleId && run.status === "failed")
    .sort((left, right) =>
      (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
    )[0];
}

async function readWorkspaceCapsules(input: {
  readonly origin: string;
  readonly token: string;
  readonly workspaceId: string;
}): Promise<readonly CapsuleView[]> {
  const body = await requestJson({
    origin: input.origin,
    token: input.token,
    path: `${API_PREFIX}/workspaces/${encodeURIComponent(
      input.workspaceId,
    )}/capsules`,
  });
  return (body as { readonly capsules?: readonly CapsuleView[] }).capsules ??
    [];
}

async function readWorkspaceRuns(input: {
  readonly origin: string;
  readonly token: string;
  readonly workspaceId: string;
}): Promise<readonly RunSummary[]> {
  const body = await requestJson({
    origin: input.origin,
    token: input.token,
    path: `${API_PREFIX}/workspaces/${encodeURIComponent(
      input.workspaceId,
    )}/runs?limit=500`,
  });
  return (body as { readonly runs?: readonly RunSummary[] }).runs ?? [];
}

const DIAGNOSTIC_DETAIL_MAX_CHARS = 320;

export function firstRunDiagnosticMessage(body: unknown): string | undefined {
  const diagnostics = (body as {
    readonly diagnostics?: readonly {
      readonly severity?: string;
      readonly code?: string;
      readonly message?: string;
      readonly detail?: string;
    }[];
  }).diagnostics;
  if (!Array.isArray(diagnostics)) return undefined;
  const entry = diagnostics.find((value) => value?.severity === "error") ??
    diagnostics[0];
  if (!entry?.message) return undefined;
  const summary = entry.code ? `${entry.code}: ${entry.message}` : entry.message;
  // `detail` is the server-redacted, bounded runner excerpt (for example the
  // failing source-build command's output); keep it as one bounded line.
  const detail = typeof entry.detail === "string"
    ? entry.detail.replace(/\s+/gu, " ").trim()
    : "";
  if (!detail) return summary;
  return `${summary} (${
    detail.length > DIAGNOSTIC_DETAIL_MAX_CHARS
      ? `${detail.slice(0, DIAGNOSTIC_DETAIL_MAX_CHARS)}...`
      : detail
  })`;
}

export type FailureAttribution = {
  readonly phase: string;
  readonly failedRunId?: string;
  readonly lines: readonly string[];
  readonly leftoverCapsule?: {
    readonly id: string;
    readonly status: string;
  };
};

/**
 * Name the phase that actually failed and the state a rerun must clean up.
 * The Run for this Capsule is the authority; the smoke's step gap is only a
 * fallback for failures that never reached a Run.
 */
async function attributeFailure(input: {
  readonly options: InstallServingOptions;
  readonly token: string;
  readonly workspaceId: string;
  readonly result: SmokeResultView;
  readonly summary: InstallServingSummary;
}): Promise<FailureAttribution> {
  const lines: string[] = [];
  let phase = input.summary.failedPhase;
  let runId = [
    input.result.applyRunId,
    input.result.destroyApplyRunId,
    input.result.planRunId,
    input.result.destroyPlanRunId,
    input.result.sourceSyncRunId,
  ].find((value) => typeof value === "string" && value.length > 0);

  let capsule: CapsuleView | undefined;
  try {
    capsule = selectOwnCapsule(
      await readWorkspaceCapsules({
        origin: input.options.origin,
        token: input.token,
        workspaceId: input.workspaceId,
      }),
      { appName: input.options.appName, environment: input.options.environment },
    );
  } catch (error) {
    lines.push(`capsule readback unavailable (${describeApiError(error)})`);
  }

  if (runId === undefined && capsule?.id !== undefined) {
    try {
      const failed = selectNewestFailedRun(
        await readWorkspaceRuns({
          origin: input.options.origin,
          token: input.token,
          workspaceId: input.workspaceId,
        }),
        capsule.id,
      );
      if (failed?.id !== undefined) {
        runId = failed.id;
        lines.push(
          `failed run ${failed.id} type=${failed.type ?? "unknown"}${
            failed.errorCode ? ` errorCode=${failed.errorCode}` : ""
          }`,
        );
      }
      const derivedPhase = phaseOfRunType(failed?.type);
      if (derivedPhase !== undefined) phase = derivedPhase;
    } catch (error) {
      lines.push(`run readback unavailable (${describeApiError(error)})`);
    }
  }

  if (runId !== undefined) {
    try {
      const body = await requestJson({
        origin: input.options.origin,
        token: input.token,
        path: `${API_PREFIX}/runs/${encodeURIComponent(runId)}`,
      });
      const run = (body as { readonly run?: RunDetail }).run;
      if (run) {
        lines.push(
          `run ${runId} status=${run.status ?? "unknown"}${
            run.errorCode ? ` errorCode=${run.errorCode}` : ""
          }`,
        );
      }
    } catch (error) {
      lines.push(`run ${runId} readback unavailable (${describeApiError(error)})`);
    }

    try {
      // The edge-public Run logs route; `/internal/v1` is never edge-routed.
      const logs = await requestJson({
        origin: input.options.origin,
        token: input.token,
        path: `${API_PREFIX}/runs/${encodeURIComponent(runId)}/logs`,
      });
      const message = firstRunDiagnosticMessage(logs);
      if (message) lines.push(`diagnostic: ${message}`);
    } catch (error) {
      lines.push(`diagnostic readback unavailable (${describeApiError(error)})`);
    }
  }

  // A failed run leaves its Capsule (and whatever it already created) behind.
  // Report it instead of starting a second destroy authority: the owning Run
  // may still hold the mutation.
  if (capsule?.id !== undefined) {
    lines.push(
      `capsule ${capsule.id} status=${capsule.status ?? "unknown"} remains; destroy did not complete`,
    );
  } else if (input.summary.failedPhase !== "connection") {
    lines.push("no Capsule was created for this app name; nothing to clean up");
  }

  return {
    phase,
    ...(runId === undefined ? {} : { failedRunId: runId }),
    lines,
    ...(capsule?.id === undefined
      ? {}
      : {
          leftoverCapsule: {
            id: capsule.id,
            status: capsule.status ?? "unknown",
          },
        }),
  };
}

function describeApiError(error: unknown): string {
  if (isApiError(error)) return error.detail;
  if (error instanceof Error) return error.message;
  return "unknown error";
}

export type SmokeChildInput = {
  readonly args: readonly string[];
  readonly stdoutPath: string;
  readonly stderrPath: string;
};

export type SmokeChildRunner = (
  input: SmokeChildInput,
) => Promise<number>;

const runChild: SmokeChildRunner = async (input) => {
  const child = spawn(process.execPath, [...input.args], {
    cwd: TAKOSUMI_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: process.env.HOME ?? "/root",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_WRITE_LOGS: "false",
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  await writeFile(input.stdoutPath, Buffer.concat(stdout), { mode: 0o600 });
  await writeFile(input.stderrPath, Buffer.concat(stderr), { mode: 0o600 });
  return exitCode;
};

export type InstallServingOutcome = {
  readonly kind: typeof INSTALL_SERVING_E2E_KIND;
  readonly status: "passed" | "failed";
  readonly phase: string;
  readonly origin: string;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly appName: string;
  readonly capsuleId?: string;
  readonly failedRunId?: string;
  readonly leftoverCapsule?: {
    readonly id: string;
    readonly status: string;
  };
  readonly reason: string;
  readonly evidenceDir: string;
};

/** Injection point so failure classification is testable without a live Run. */
export type InstallServingDeps = {
  readonly runChild?: SmokeChildRunner;
};

export async function runInstallServingE2e(
  options: InstallServingOptions,
  deps: InstallServingDeps = {},
): Promise<InstallServingOutcome> {
  const spawnChild = deps.runChild ?? runChild;
  await mkdir(options.evidenceDir, { recursive: true, mode: 0o700 });
  await chmod(options.evidenceDir, 0o700);
  const token = await readTokenFile(options.tokenFile);

  const target = await resolveTarget({
    origin: options.origin,
    token,
    workspace: options.workspace,
    ...(options.connectionId === undefined
      ? {}
      : { connectionId: options.connectionId }),
  });

  const smokeArgs = buildSmokeInvocation(options, target);
  await writeFile(
    join(options.evidenceDir, "smoke-invocation.json"),
    `${JSON.stringify(redactInvocation(smokeArgs), null, 2)}\n`,
    { mode: 0o600 },
  );

  const exitCode = await spawnChild({
    args: smokeArgs,
    stdoutPath: join(options.evidenceDir, "smoke-stdout.log"),
    stderrPath: join(options.evidenceDir, "smoke-stderr.log"),
  });

  let result: SmokeResultView = {};
  try {
    result = JSON.parse(
      await readFile(join(options.evidenceDir, "smoke-result.json"), "utf8"),
    ) as SmokeResultView;
  } catch {
    // The smoke never wrote a result: report that as its own phase.
  }

  const summary = summarizeSmokeResult(result);
  const attribution: FailureAttribution = result.status === "passed"
    ? { phase: "complete", lines: [] }
    : await attributeFailure({
      options,
      token,
      workspaceId: target.workspaceId,
      result,
      summary,
    });
  const detailLines = attribution.lines;
  const reason = result.status === "passed"
    ? "managed runtime answered the expected content and destroy completed"
    : detailLines.join("; ") ||
      result.error ||
      `platform smoke exited ${exitCode} without a result`;

  const outcome: InstallServingOutcome = {
    kind: INSTALL_SERVING_E2E_KIND,
    status: result.status === "passed" && exitCode === 0 ? "passed" : "failed",
    phase: attribution.phase,
    origin: options.origin,
    workspaceId: target.workspaceId,
    connectionId: target.connectionId,
    appName: options.appName,
    ...(result.capsuleId === undefined ? {} : { capsuleId: result.capsuleId }),
    ...(attribution.failedRunId === undefined
      ? {}
      : { failedRunId: attribution.failedRunId }),
    ...(attribution.leftoverCapsule === undefined
      ? {}
      : { leftoverCapsule: attribution.leftoverCapsule }),
    reason,
    evidenceDir: options.evidenceDir,
  };

  await writeFile(
    join(options.evidenceDir, "summary.json"),
    `${JSON.stringify(outcome, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (!options.json) printOutcome(outcome, summary, result, detailLines);
  if (options.json) process.stdout.write(`${JSON.stringify(outcome)}\n`);
  return outcome;
}

export function redactInvocation(args: readonly string[]): readonly string[] {
  return args.map((value, index) => {
    const previous = args[index - 1];
    if (
      previous === "--pat-token-file" || previous === "--session-token-file"
    ) {
      return "<redacted>";
    }
    return value;
  });
}

function printOutcome(
  outcome: InstallServingOutcome,
  summary: InstallServingSummary,
  result: SmokeResultView,
  detailLines: readonly string[],
): void {
  const write = (line: string) => process.stdout.write(`${line}\n`);
  write(
    `${INSTALL_SERVING_E2E_KIND} origin=${outcome.origin} workspace=${outcome.workspaceId} app=${outcome.appName} connection=${outcome.connectionId}`,
  );
  for (const phase of summary.phases) {
    const duration = phase.steps.reduce(
      (total, entry) => total + entry.durationMs,
      0,
    );
    write(
      `[${phase.phase}] ${phase.status}${
        duration > 0 ? ` ${Math.round(duration / 100) / 10}s` : ""
      }`,
    );
  }
  for (const check of result.publicUrlChecks ?? []) {
    write(
      `[serving] check=${check.name ?? "?"} status=${check.status ?? "?"} ${
        check.ok === true ? "ok" : "not ok"
      }`,
    );
  }
  for (const line of detailLines) write(`  ${line}`);
  if (outcome.status === "passed") {
    write(`PASS ${INSTALL_SERVING_E2E_KIND} evidence=${outcome.evidenceDir}`);
    return;
  }
  write(
    `FAIL phase=${outcome.phase} run=${outcome.failedRunId ?? "none"} reason=${outcome.reason}`,
  );
  if (outcome.leftoverCapsule) {
    write(
      `cleanup: capsule ${outcome.leftoverCapsule.id} status=${outcome.leftoverCapsule.status} still exists`,
    );
  }
  write(`evidence=${outcome.evidenceDir}`);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  bun run e2e:install-serving -- --workspace <ws_...|@handle> --token-file <path>

Installs the known Yurucommu Git module into the selected Takosumi environment
through the canonical Run lifecycle, asserts the managed runtime answers HTTP
with the expected content, then destroys the Capsule.

Required:
  --workspace <id|@handle>          or TAKOSUMI_INSTALL_E2E_WORKSPACE
  --token-file <path>               Takosumi Account PAT (or session) token file;
                                    absolute, mode 0600, or TAKOSUMI_INSTALL_E2E_TOKEN_FILE

Options:
  --origin <url>                    default ${DEFAULT_ORIGIN}
  --connection-id <conn_...>        default: the single ${TAKOFORM_PROVIDER_SOURCE}
                                    connection in the Workspace
  --auth-token-kind <pat|session>   default pat
  --source-ref <ref>                Git ref for ${YURUCOMMU_PROFILE.sourceGitUrl}
  --app-name <name>                 default ${YURUCOMMU_PROFILE.appPrefix}-<date>-<rand>
  --environment <label>             default integration
  --evidence-dir <path>             default $TMPDIR/takosumi-install-serving-e2e/<stamp>
  --timeout-seconds <n>             default 900
  --deploy-timeout-seconds <n>      default 600
  --dry-run                         print the pinned plan without mutating
  --json                            print the outcome as one JSON line
  --help

Failure output names the phase (connection/source/install-plan/compatibility/
plan/apply/output/serving/destroy) plus the Run status, errorCode, and the
redacted Run diagnostic. When the product's install coordinator stops before it
records step progress, the phase comes from the newest failed Run of this app's
Capsule instead of the first unrecorded step. A Capsule left behind by a failed
Run is reported, never destroyed a second time.
Uncovered on purpose: production, containers, native actor lifecycle.
`);
}

export function dryRunPlan(
  options: InstallServingOptions,
): Record<string, unknown> {
  return {
    kind: INSTALL_SERVING_E2E_KIND,
    status: "dry_run",
    origin: options.origin,
    workspace: options.workspace,
    connectionId: options.connectionId ?? "<discover>",
    profile: options.profile.id,
    sourceGitUrl: options.profile.sourceGitUrl,
    ...(options.sourceRef === undefined ? {} : { sourceRef: options.sourceRef }),
    sourcePath: options.profile.sourcePath,
    modulePath: options.profile.modulePath,
    appName: options.appName,
    environment: options.environment,
    evidenceDir: options.evidenceDir,
    tokenFile: redactInvocation(["--pat-token-file", options.tokenFile])[1],
    phases: PHASE_GROUPS.map((group) => group.phase),
    publicUrlChecks: options.profile.publicUrlChecks.map((check) =>
      `${check.path} -> ${check.expectedStatus}`
    ),
  };
}

export function envValue(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("--origin must be an https origin");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--origin must be a bare https origin");
  }
  return url.origin;
}

export function defaultAppName(stamp: string): string {
  return `${YURUCOMMU_PROFILE.appPrefix}-${stamp.slice(0, 8)}-${
    randomBytes(3).toString("hex")
  }`;
}

export function timestampSlug(now = new Date()): string {
  return now.toISOString().replace(/[^0-9]/gu, "").slice(0, 14);
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${value}`);
  }
  return parsed;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  let options: InstallServingOptions;
  try {
    options = resolveHarnessOptions(argv);
  } catch (error) {
    process.stderr.write(`${describeApiError(error)}\n`);
    return 2;
  }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(dryRunPlan(options), null, 2)}\n`);
    return 0;
  }
  try {
    const outcome = await runInstallServingE2e(options);
    return outcome.status === "passed" ? 0 : 1;
  } catch (error) {
    // Preflight and transport failures never touched a Run; name them directly.
    process.stderr.write(
      `FAIL phase=preflight reason=${describeApiError(error)} origin=${
        options.origin
      } workspace=${options.workspace}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
