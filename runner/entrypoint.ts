import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
// Shared provider -> credential env-name table. This module is dependency-free
// and is copied into the runner container image alongside this file so the
// relative import resolves at container runtime (see runner/Dockerfile).
import {
  PROVIDER_CREDENTIAL_ENV_RULES,
  type ProviderCredentialEnvRule,
  isProviderEnvName,
  isReservedProviderEnvName,
  providerCredentialArgs,
  providerEnvRule,
} from "../contract/provider-env-rules.ts";
import {
  assertHostNotBlocked,
  BlockedHostError,
} from "../contract/reference/host-blocklist.ts";

type OpenTofuRunAction =
  | "plan"
  | "apply"
  | "destroy"
  | "compatibility_check"
  | "backup";
type OpenTofuOperation = "create" | "update" | "destroy";
type JsonRecord = Record<string, unknown>;

const CAPSULE_COMPATIBILITY_MAX_FILES = 256;
const CAPSULE_COMPATIBILITY_MAX_FILE_BYTES = 1024 * 1024;
const CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROVIDER_MIRROR_PATH = "/opt/opentofu/provider-mirror";
const RUNNER_START_SERVER_ENV = "TAKOSUMI_RUNNER_START_SERVER";
const PROVIDER_SNAPSHOT_COMMAND_ENV = "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND";
const PROVIDER_SNAPSHOT_COMMAND_ENV_PREFIX =
  "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND_";
const PROVIDER_SNAPSHOT_POINTER_DIR_ENV =
  "TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR";
type RunRequest = {
  readonly action?: unknown;
  readonly runId?: unknown;
  readonly request?: unknown;
};

type OpenTofuModuleSource =
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref?: string;
      readonly commit?: string;
      readonly modulePath?: string;
    }
  | {
      readonly kind: "prepared";
      readonly url: string;
      readonly digest: string;
      readonly modulePath?: string;
    }
  | {
      readonly kind: "local";
      readonly path: string;
      readonly modulePath?: string;
    };

interface RunWorkspace {
  readonly root: string;
  readonly sourceRoot: string;
  readonly moduleDir: string;
  readonly planPath: string;
  readonly restoredStatePath: string;
  readonly moduleInfoPath: string;
  // Generated-root workspace dirs. `generatedRootDir` is where tofu runs (it
  // holds the generated root module + child `template-module`); `artifactDir`
  // receives the build artifact.
  readonly generatedRootDir: string;
  readonly templateModuleDir: string;
  readonly artifactDir: string;
  // remote_state dependency states (spec §15): each producer state is written
  // read-only as <depsDir>/<name>.tfstate before init/plan/apply for the
  // consumer's `terraform_remote_state` data sources.
  readonly depsDir: string;
}

/** Generated root module HCL files (filename -> content). */
interface GeneratedRoot {
  readonly files: Record<string, string>;
  readonly moduleFiles?: readonly GeneratedRootModuleFile[];
}

interface GeneratedRootModuleFile {
  readonly path: string;
  readonly text: string;
}

/** Optional credential-free build phase that runs before plan. */
interface BuildSpec {
  readonly runtime: "bun";
  readonly commands: readonly string[];
  /** File/dir relative to the source root; copied to /work/artifact. */
  readonly artifactPath: string;
}

interface BackupSpec {
  readonly mode: "provider_snapshot" | "custom_command";
  readonly command?: readonly string[];
  readonly outputPath: string;
  readonly provider?: string;
}

export interface CommandContext {
  readonly env: Record<string, string>;
  readonly credentialFiles?: readonly ProviderCredentialFile[];
  readonly redactionValues?: readonly string[];
  readonly timeoutMs?: number;
  readonly sourceArchiveMaxBytes?: number;
  readonly sourceArchiveMaxDecompressedBytes?: number;
}

interface ProviderCredentialFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
  readonly envName?: string;
}

const port = Number(Bun.env.PORT ?? "8080");
const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";
const DEFAULT_PREPARED_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_PREPARED_SOURCE_MAX_DECOMPRESSED_BYTES =
  10 * DEFAULT_PREPARED_SOURCE_MAX_BYTES;
const BASE_COMMAND_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "REQUESTS_CA_BUNDLE",
  // Baked CLI config pointing at the offline provider filesystem mirror +
  // plugin cache (see runner/tofu.rc). Must be on the tofu process env so init
  // resolves the mirrored providers from disk with no registry round-trip.
  "TF_CLI_CONFIG_FILE",
] as const;
// Well-known tofu input the runner sets when a build phase produced an artifact.
// A generated root module may wire `var.artifact_path` to consume it.
const ARTIFACT_PATH_TF_VAR = "TF_VAR_artifact_path";
// Default cap for the produced source archive when the runner profile does not
// pin `resourceLimits.maxSourceArchiveBytes`. Source repos are small modules.
const DEFAULT_SOURCE_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
const RUNNER_REDACTED_VALUE = "[redacted]";
const RUNNER_SECRET_WORD =
  "(?:secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|auth[_-]?token|bearer[_-]?token|connection[_-]?string|database[_-]?url|dsn)";
const RUNNER_AUTH_HEADER_PATTERN =
  /\b(Authorization\s*:\s*(?:Bearer|Basic|Digest|Token)?\s*)[^\s,;]+/gi;
const RUNNER_AUTH_SCHEME_PATTERN =
  /\b(Bearer|Basic|Digest|Token)\s+[-._~+/=a-zA-Z0-9]+/g;
const RUNNER_URL_CREDENTIAL_PATTERN =
  /\b([a-z][a-z0-9+.\-]*:\/\/[^:/?#\s@]+:)([^@/?#\s]+)@/gi;
const RUNNER_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b((${RUNNER_SECRET_WORD})|(?:[A-Za-z_][A-Za-z0-9_.-]*${RUNNER_SECRET_WORD}[A-Za-z0-9_.-]*))(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,&;]+)`,
  "gi",
);
const RUNNER_TF_VAR_ASSIGNMENT_PATTERN =
  /\b(TF_VAR_[A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,&;]+)/g;
export async function handleRunnerRequest(request: Request): Promise<Response> {
  {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" || url.pathname === "/container/health") {
      return Response.json({ ok: true, runner: "opentofu" });
    }
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    const artifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfplan$/.exec(
      url.pathname,
    );
    const planJsonArtifactMatch =
      /^\/runs\/([^/]+)\/artifacts\/tfplan-json$/.exec(url.pathname);
    const stateArtifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfstate$/.exec(
      url.pathname,
    );
    const sourceArchiveArtifactMatch =
      /^\/runs\/([^/]+)\/artifacts\/source-archive$/.exec(url.pathname);
    const sourceArchiveRestoreMatch =
      /^\/runs\/([^/]+)\/source-archive\/restore$/.exec(url.pathname);
    const depStateRestoreMatch =
      /^\/runs\/([^/]+)\/deps\/([^/]+)\/restore$/.exec(url.pathname);
    if (depStateRestoreMatch) {
      return await handleDepStateRestoreRequest(
        decodeURIComponent(depStateRestoreMatch[1]!),
        decodeURIComponent(depStateRestoreMatch[2]!),
        request,
      );
    }
    if (sourceArchiveRestoreMatch) {
      return await handleSourceArchiveRestoreRequest(
        decodeURIComponent(sourceArchiveRestoreMatch[1]!),
        request,
      );
    }
    if (sourceArchiveArtifactMatch) {
      return await handleSourceArchiveArtifactRequest(
        decodeURIComponent(sourceArchiveArtifactMatch[1]!),
        request,
      );
    }
    if (planJsonArtifactMatch) {
      return await handlePlanJsonArtifactRequest(
        decodeURIComponent(planJsonArtifactMatch[1]!),
        request,
      );
    }
    if (artifactMatch) {
      return await handlePlanArtifactRequest(
        decodeURIComponent(artifactMatch[1]!),
        request,
      );
    }
    if (stateArtifactMatch) {
      return await handleStateArtifactRequest(
        decodeURIComponent(stateArtifactMatch[1]!),
        request,
      );
    }
    if (!match) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "method not allowed" },
        { status: 405, headers: { allow: "POST" } },
      );
    }

    const body = (await readJsonObject(request)) as RunRequest;
    const runId = decodeURIComponent(match[1]);

    // Source-sync (LANE M1) is a distinct job carried on the `request` field as
    // `{ action: "source_sync", source, credentials?, archiveObjectKey }`. It
    // resolves a commit, builds a deterministic archive of source.path, PUTs the
    // bytes to the DO source-archive route, and returns resolution metadata. It
    // never runs tofu and never restores/persists OpenTofu state.
    const requestRedactionValues = redactionValuesFromRequest(body.request);
    if (isSourceSyncRequest(body.request)) {
      try {
        const result = await runSourceSync(runId, body.request);
        return Response.json(result, { status: 200 });
      } catch (error) {
        return Response.json(
          {
            runId,
            action: "source_sync",
            status: "failed",
            exitCode: 1,
            stderr: redactRunnerOutput(
              error instanceof Error ? error.message : String(error),
              requestRedactionValues,
            ),
          },
          { status: 500 },
        );
      }
    }

    const action = parseAction(body.action);
    if (!action) {
      return Response.json(
        { error: "invalid OpenTofu action" },
        { status: 400 },
      );
    }

    try {
      const result =
        action === "compatibility_check"
          ? await runCompatibilityCheck(runId)
          : action === "backup"
            ? await runBackup(runId, body.request)
            : action === "plan"
              ? await runPlan(runId, body.request)
              : await runReviewedPlanApply(runId, action, body.request);
      return Response.json(result, {
        status: result.exitCode === 0 ? 200 : 500,
      });
    } catch (error) {
      return Response.json(
        {
          runId,
          action,
          status: "failed",
          exitCode: 1,
          stderr: redactRunnerOutput(
            error instanceof Error ? error.message : String(error),
            requestRedactionValues,
          ),
        },
        { status: 500 },
      );
    }
  }
}

async function runBackup(runId: string, request: unknown): Promise<JsonRecord> {
  const backup = parseBackup(request);
  if (backup.mode === "provider_snapshot") {
    return await runProviderSnapshotBackup(runId, backup);
  }

  const workspace = workspaceForRun(runId);
  await assertDirectory(workspace.sourceRoot, "backup source root");
  const context: CommandContext = {
    env: buildPhaseEnv(),
    timeoutMs: 10 * 60 * 1000,
  };
  assertBuildEnvHasNoCredentials(context.env);
  const logs: string[] = [];
  let stdout = "";
  let stderr = "";
  for (const command of backup.command ?? []) {
    const result = await runCommand(["bash", "-lc", command], {
      cwd: workspace.sourceRoot,
      context,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    logs.push(redactBuildOutput(`$ ${command}\n${stdout}\n${stderr}`));
    if (result.exitCode !== 0) {
      return {
        runId,
        action: "backup",
        status: "failed",
        exitCode: result.exitCode,
        phase: "backup",
        stdout: logs.join("\n"),
        stderr: redactBuildOutput(
          `backup command failed (${result.exitCode}): ${command}\n${stderr}`,
        ),
      };
    }
  }
  const artifact = parseBackupArtifactPointer(stdout);
  if (!artifact) {
    return {
      runId,
      action: "backup",
      status: "missing",
      exitCode: 0,
      stdout: logs.join("\n"),
      reason:
        "backup command did not print a service-data artifact pointer JSON object",
    };
  }
  return {
    runId,
    action: "backup",
    status: "succeeded",
    exitCode: 0,
    stdout: logs.join("\n"),
    outputPath: backup.outputPath,
    artifact,
  };
}

async function runProviderSnapshotBackup(
  runId: string,
  backup: BackupSpec,
): Promise<JsonRecord> {
  const command = providerSnapshotCommand(backup.provider);
  if (!command) {
    const builtIn = await runBuiltInProviderSnapshotBackup(runId, backup);
    if (builtIn) return builtIn;
    return {
      runId,
      action: "backup",
      status: "unsupported",
      exitCode: 0,
      reason: `provider_snapshot requires operator-specific adapter command ${providerSnapshotCommandEnvNames(backup.provider).join(" or ")} or built-in pointer directory ${PROVIDER_SNAPSHOT_POINTER_DIR_ENV}`,
    };
  }

  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  const context: CommandContext = {
    env: {
      ...baseCommandEnv(),
      TAKOSUMI_BACKUP_MODE: "provider_snapshot",
      TAKOSUMI_BACKUP_OUTPUT_PATH: backup.outputPath,
      TAKOSUMI_BACKUP_PROVIDER: backup.provider ?? "",
      TAKOSUMI_RUN_ID: runId,
    },
    timeoutMs: 10 * 60 * 1000,
  };
  const result = await runCommand(["bash", "-lc", command.command], {
    cwd: workspace.root,
    context,
  });
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (result.exitCode !== 0) {
    return {
      runId,
      action: "backup",
      status: "failed",
      exitCode: result.exitCode,
      phase: "backup",
      stdout: redactBuildOutput(stdout),
      stderr: redactBuildOutput(
        `provider snapshot adapter failed (${result.exitCode})\n${stderr}`,
      ),
    };
  }
  const artifact = parseBackupArtifactPointer(stdout);
  if (!artifact) {
    return {
      runId,
      action: "backup",
      status: "missing",
      exitCode: 0,
      stdout: redactBuildOutput(stdout),
      reason:
        "provider snapshot adapter did not print a service-data artifact pointer JSON object",
    };
  }
  return {
    runId,
    action: "backup",
    status: "succeeded",
    exitCode: 0,
    stdout: redactBuildOutput(stdout),
    outputPath: backup.outputPath,
    artifact,
  };
}

function providerSnapshotCommand(
  provider: string | undefined,
): { readonly command: string; readonly envName: string } | undefined {
  for (const envName of providerSnapshotCommandEnvNames(provider)) {
    const command = Bun.env[envName]?.trim();
    if (command) return { command, envName };
  }
  return undefined;
}

function providerSnapshotCommandEnvNames(
  provider: string | undefined,
): readonly string[] {
  const names: string[] = [];
  if (provider) {
    names.push(
      `${PROVIDER_SNAPSHOT_COMMAND_ENV_PREFIX}${providerSnapshotEnvSuffix(provider)}`,
    );
  }
  names.push(PROVIDER_SNAPSHOT_COMMAND_ENV);
  return names;
}

function providerSnapshotEnvSuffix(provider: string): string {
  return provider
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function runBuiltInProviderSnapshotBackup(
  runId: string,
  backup: BackupSpec,
): Promise<JsonRecord | undefined> {
  const pointerDir = Bun.env[PROVIDER_SNAPSHOT_POINTER_DIR_ENV]?.trim();
  if (!pointerDir) {
    return await runBuiltInNativeProviderSnapshotBackup(runId, backup);
  }
  const pointerPaths = providerSnapshotPointerPaths(
    pointerDir,
    backup.outputPath,
    backup.provider,
  );
  let pointerText: string;
  let matchedPointerPath: string | undefined;
  try {
    const matched = await readFirstExistingPointer(pointerPaths);
    pointerText = matched.text;
    matchedPointerPath = matched.path;
  } catch {
    return {
      runId,
      action: "backup",
      status: "missing",
      exitCode: 0,
      outputPath: backup.outputPath,
      reason: `provider snapshot built-in pointer ${pointerPaths.join(" or ")} does not exist`,
    };
  }
  const artifact = parseBackupArtifactPointer(pointerText);
  if (!artifact) {
    return {
      runId,
      action: "backup",
      status: "missing",
      exitCode: 0,
      outputPath: backup.outputPath,
      reason: `provider snapshot built-in pointer ${matchedPointerPath ?? pointerPaths[0]} is not a service-data artifact pointer JSON object`,
    };
  }
  return {
    runId,
    action: "backup",
    status: "succeeded",
    exitCode: 0,
    outputPath: backup.outputPath,
    artifact,
  };
}

async function readFirstExistingPointer(
  paths: readonly string[],
): Promise<{ readonly path: string; readonly text: string }> {
  for (const path of paths) {
    try {
      return { path, text: await readFile(path, "utf8") };
    } catch {
      // Try the next provider-scoped / legacy pointer path.
    }
  }
  throw new Error("provider snapshot pointer not found");
}

function providerSnapshotPointerPaths(
  pointerDir: string,
  outputPath: string,
  provider: string | undefined,
): readonly string[] {
  const safeName = outputPath.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const legacy = join(pointerDir, `${safeName}.json`);
  if (!provider) return [legacy];
  const safeProvider = provider.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return [join(pointerDir, safeProvider, `${safeName}.json`), legacy];
}

async function runBuiltInNativeProviderSnapshotBackup(
  runId: string,
  backup: BackupSpec,
): Promise<JsonRecord | undefined> {
  const provider = normalizeProviderSource(backup.provider);
  const kind = builtInProviderSnapshotKind(provider);
  if (!kind) return undefined;

  const workspace = workspaceForRun(runId);
  await mkdir(workspace.artifactDir, { recursive: true });
  const manifest = {
    kind,
    version: 1,
    runId,
    provider,
    outputPath: backup.outputPath,
    capturedAt: new Date().toISOString(),
    note: "Takosumi built-in provider snapshot adapter metadata. Provider-native snapshot bytes remain in the provider or service-owned artifact store; this manifest is a non-secret pointer/evidence object.",
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const fileName = `${providerSnapshotEnvSuffix(provider).toLowerCase()}-${backup.outputPath.replace(/[^A-Za-z0-9_.-]+/g, "_")}.snapshot.json`;
  await writeFile(join(workspace.artifactDir, fileName), bytes, {
    mode: 0o600,
  });
  return {
    runId,
    action: "backup",
    status: "succeeded",
    exitCode: 0,
    outputPath: backup.outputPath,
    artifact: {
      ref: `runner-local://${runId}/artifact/${fileName}`,
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
      contentType: "application/json",
      metadata: {
        provider,
        adapter: "takosumi-built-in-provider-snapshot",
        adapterKind: kind,
      },
    },
  };
}

function normalizeProviderSource(provider: string | undefined): string {
  const value = provider?.trim().toLowerCase();
  if (!value) return "";
  if (value.includes("/")) return value;
  if (value === "cloudflare")
    return "registry.opentofu.org/cloudflare/cloudflare";
  if (value === "aws") return "registry.opentofu.org/hashicorp/aws";
  return value;
}

function builtInProviderSnapshotKind(provider: string): string | undefined {
  if (provider === "registry.opentofu.org/cloudflare/cloudflare") {
    return "cloudflare-provider-snapshot";
  }
  if (provider === "registry.opentofu.org/hashicorp/aws") {
    return "aws-provider-snapshot";
  }
  return undefined;
}

// Only bind a port when run as the container entrypoint; importing this module
// (e.g. for a unit test of commandContextFromRequest) must not start a server.
if (Bun.env[RUNNER_START_SERVER_ENV] === "1" || import.meta.main) {
  console.log("Takosumi OpenTofu runner listening", {
    hostname: "0.0.0.0",
    port,
  });
  Bun.serve({ hostname: "0.0.0.0", port, fetch: handleRunnerRequest });
}

export function redactRunnerOutput(
  text: string,
  exactValues: readonly string[] = [],
): string {
  let redacted = redactExactCredentialValues(text, exactValues)
    .replace(
      RUNNER_URL_CREDENTIAL_PATTERN,
      (_match, prefix: string) => `${prefix}${RUNNER_REDACTED_VALUE}@`,
    )
    .replace(
      RUNNER_AUTH_HEADER_PATTERN,
      (_match, prefix: string) => `${prefix}${RUNNER_REDACTED_VALUE}`,
    )
    .replace(
      RUNNER_AUTH_SCHEME_PATTERN,
      (_match, scheme: string) => `${scheme} ${RUNNER_REDACTED_VALUE}`,
    )
    .replace(
      RUNNER_SECRET_ASSIGNMENT_PATTERN,
      (_match, key: string, _bareKey: string, sep: string) =>
        `${key}${sep}${RUNNER_REDACTED_VALUE}`,
    )
    .replace(
      RUNNER_TF_VAR_ASSIGNMENT_PATTERN,
      (_match, prefix: string) => `${prefix}${RUNNER_REDACTED_VALUE}`,
    );
  for (const name of [
    "GIT_HTTPS_TOKEN",
    "GIT_SSH_PRIVATE_KEY",
    ...allKnownCredentialEnvNames(),
  ]) {
    redacted = redacted.replaceAll(
      new RegExp(
        `\\b(${escapeRegExp(name)}\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,&;]+)`,
        "g",
      ),
      `$1${RUNNER_REDACTED_VALUE}`,
    );
  }
  return redactExactCredentialValues(redacted, exactValues);
}

const SOURCE_CREDENTIAL_ENV_NAMES = new Set(["GIT_HTTPS_TOKEN"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactExactCredentialValues(
  text: string,
  values: readonly string[],
): string {
  let redacted = text;
  for (const value of normalizedRedactionValues(values)) {
    redacted = redacted.replaceAll(value, RUNNER_REDACTED_VALUE);
  }
  return redacted;
}

function normalizedRedactionValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length >= 8))].sort(
    (left, right) => right.length - left.length,
  );
}

async function runPlan(runId: string, request: unknown): Promise<JsonRecord> {
  const generatedRoot = parseGeneratedRoot(request);
  if (generatedRoot) {
    return await runGeneratedRootPlan(runId, request, generatedRoot);
  }
  throw new Error("generatedRoot is required for OpenTofu plan runs");
}

// Generated-root path (§7): the OpenTofu surface is the generated root module.
// Official catalog modules and normalized Capsules arrive as
// generatedRoot.moduleFiles. Git-sourced Capsules without moduleFiles use the
// restored SourceSnapshot module as the child module.
async function runGeneratedRootPlan(
  runId: string,
  request: unknown,
  generatedRoot: GeneratedRoot,
): Promise<JsonRecord> {
  const operation = parseOperation(request);
  const build = parseBuild(request);
  const source = parseSource(request);
  const runnerProfile = parseRunnerProfile(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);

  const workspace = await prepareGeneratedRootWorkspace(runId);
  let buildLog = "";
  let sourceCommit: string | undefined;
  if (build) {
    const built = await runBuildPhase(runId, workspace, source, build);
    if ("failure" in built) return built.failure;
    buildLog = built.buildLog;
    sourceCommit = built.sourceCommit;
  }

  if (generatedRoot.moduleFiles) {
    await materializeGeneratedRootFromFiles(workspace, generatedRoot);
  } else {
    await ensureSourceAvailable(source, workspace.sourceRoot, commandContext);
    const moduleDir = resolveModulePath(
      workspace.sourceRoot,
      source.modulePath,
    );
    await assertDirectory(moduleDir, "source module directory");
    await assertRealPathInsideSourceRoot(
      moduleDir,
      workspace.sourceRoot,
      "source module directory",
    );
    const pinnedGitCommit =
      source.kind === "git"
        ? (source.commit ??
          (await gitRevParseHead(workspace.sourceRoot, commandContext)))
        : undefined;
    sourceCommit = sourceCommit ?? pinnedGitCommit;
    await materializeGeneratedRootFromModule(
      workspace,
      moduleDir,
      generatedRoot,
    );
  }
  await restoreUploadedState(workspace, workspace.generatedRootDir);
  const planContext = build
    ? withArtifactPathVar(commandContext, workspace, build)
    : commandContext;
  const preparedCredentials = await prepareProviderCredentialFiles(
    planContext,
    workspace,
  );
  try {
    assertRunnerPolicyBeforeInit(
      request,
      runnerProfile,
      preparedCredentials.context,
      {
        allowProviderFreeGeneratedRoot:
          await generatedRootTreeHasNoProviderUsage(workspace.generatedRootDir),
      },
    );
    return await initPlanAndBuildResponse(
      runId,
      workspace,
      workspace.generatedRootDir,
      {
        operation,
        commandContext: preparedCredentials.context,
        buildLog,
        requiredProviders: parseRequiredProviders(request),
        ...(parseProviderInstallationPolicy(request)
          ? {
              providerInstallationPolicy:
                parseProviderInstallationPolicy(request),
            }
          : {}),
        extra: {
          ...(sourceCommit ? { sourceCommit } : {}),
        },
      },
    );
  } finally {
    await preparedCredentials.cleanup();
  }
}

interface PlanResponseOptions {
  readonly operation: OpenTofuOperation;
  readonly commandContext: CommandContext;
  readonly requiredProviders: readonly string[];
  readonly providerInstallationPolicy?: {
    readonly requireMirror: boolean;
  };
  readonly buildLog?: string;
  readonly extra?: JsonRecord;
}

// Shared init+plan+show pipeline for generated-root lanes. `moduleDir` is the
// tofu root, normally /work/generated-root.
async function initPlanAndBuildResponse(
  runId: string,
  workspace: RunWorkspace,
  moduleDir: string,
  options: PlanResponseOptions,
): Promise<JsonRecord> {
  const { operation } = options;
  const strictMirrorInit = await prepareStrictProviderMirrorInit(
    workspace,
    options.commandContext,
    options.requiredProviders,
    options.providerInstallationPolicy,
  );
  const commandContext =
    strictMirrorInit?.commandContext ?? options.commandContext;
  const init = await runCommand(["tofu", "init", "-input=false", "-no-color"], {
    cwd: moduleDir,
    context: commandContext,
  });
  if (init.exitCode !== 0) {
    return mergeBuildLog(
      commandFailurePayload(runId, "plan", init, commandContext),
      options.buildLog,
    );
  }
  const plan = await runCommand(
    [
      "tofu",
      "plan",
      ...(operation === "destroy" ? ["-destroy"] : []),
      "-input=false",
      "-no-color",
      "-out",
      workspace.planPath,
    ],
    { cwd: moduleDir, context: commandContext },
  );
  if (plan.exitCode !== 0) {
    return mergeBuildLog(
      commandFailurePayload(runId, "plan", plan, commandContext),
      options.buildLog,
    );
  }

  const planBytes = await readFile(workspace.planPath);
  const planDigest = await digestBytes(planBytes);
  const planJson = await readOpenTofuPlanJson(
    moduleDir,
    workspace,
    commandContext,
  );
  if (planJson) await writePlanJsonArtifact(workspace, planJson);
  const providerLockDigest = await digestFileIfExists(
    join(moduleDir, ".terraform.lock.hcl"),
  );
  const requiredProviders = normalizedProviderList([
    ...options.requiredProviders,
    ...(planJson ? providersFromPlanJson(planJson) : []),
  ]);
  const providerInstallation = await providerInstallationEvidence(
    moduleDir,
    requiredProviders,
    strictMirrorInit?.attestation,
  );
  return {
    runId,
    action: "plan",
    status: "succeeded",
    exitCode: 0,
    planDigest,
    planArtifact: {
      kind: "runner-local",
      ref: `runner-local://${runId}/tfplan`,
      digest: planDigest,
      contentType: "application/vnd.opentofu.plan",
      sizeBytes: planBytes.byteLength,
    },
    requiredProviders,
    providerInstallation,
    ...(planJson ? { summary: summaryFromPlanJson(planJson) } : {}),
    ...(planJson
      ? { planResourceChanges: resourceChangesFromPlanJson(planJson) }
      : {}),
    ...(providerLockDigest ? { providerLockDigest } : {}),
    ...(options.extra ?? {}),
    stdout: redactRunnerOutput(
      [options.buildLog, init.stdout, plan.stdout].filter(Boolean).join("\n"),
      commandContext.redactionValues,
    ),
    stderr: redactRunnerOutput(
      [init.stderr, plan.stderr].filter(Boolean).join("\n"),
      commandContext.redactionValues,
    ),
  };
}

function mergeBuildLog(
  payload: JsonRecord,
  buildLog: string | undefined,
): JsonRecord {
  if (!buildLog) return payload;
  const existing = typeof payload.stdout === "string" ? payload.stdout : "";
  return {
    ...payload,
    stdout: [buildLog, existing].filter(Boolean).join("\n"),
  };
}

async function runReviewedPlanApply(
  runId: string,
  action: "apply" | "destroy",
  request: unknown,
): Promise<JsonRecord> {
  const generatedRoot = parseGeneratedRoot(request);
  const runnerProfile = parseRunnerProfile(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);
  const workspace = workspaceForRun(runId);
  const planArtifact = parsePlanArtifact(request);
  await verifyPlanArtifact(workspace.planPath, planArtifact);
  if (!generatedRoot) {
    throw new Error("generatedRoot is required for OpenTofu apply runs");
  }

  const moduleDir = await restoreGeneratedRootApplyWorkspace(
    runId,
    parseSource(request),
    commandContext,
    generatedRoot,
  );
  const preparedCredentials = await prepareProviderCredentialFiles(
    commandContext,
    workspace,
  );
  try {
    assertRunnerPolicyBeforeInit(
      request,
      runnerProfile,
      preparedCredentials.context,
      {
        allowProviderFreeGeneratedRoot:
          await generatedRootTreeHasNoProviderUsage(moduleDir),
      },
    );
    const strictMirrorInit = await prepareStrictProviderMirrorInit(
      workspace,
      preparedCredentials.context,
      parseRequiredProviders(request),
      parseProviderInstallationPolicy(request),
    );
    const applyContext =
      strictMirrorInit?.commandContext ?? preparedCredentials.context;

    const init = await runCommand(
      ["tofu", "init", "-input=false", "-no-color"],
      {
        cwd: moduleDir,
        context: applyContext,
      },
    );
    if (init.exitCode !== 0) {
      return commandFailurePayload(runId, action, init, applyContext);
    }
    const providerInstallation = await providerInstallationEvidence(
      moduleDir,
      parseRequiredProviders(request),
      strictMirrorInit?.attestation,
    );
    const result = await runCommand(
      ["tofu", "apply", "-input=false", "-no-color", workspace.planPath],
      { cwd: moduleDir, context: applyContext },
    );
    const outputs =
      action === "apply" && result.exitCode === 0
        ? await readOpenTofuOutputsIn(moduleDir, applyContext)
        : undefined;
    return {
      runId,
      action,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      exitCode: result.exitCode,
      providerInstallation,
      ...(outputs ? { outputs } : {}),
      stdout: redactRunnerOutput(
        [init.stdout, result.stdout].filter(Boolean).join("\n"),
        applyContext.redactionValues,
      ),
      stderr: redactRunnerOutput(
        [init.stderr, result.stderr].filter(Boolean).join("\n"),
        applyContext.redactionValues,
      ),
    };
  } finally {
    await preparedCredentials.cleanup();
  }
}

// For generated-root apply the consumer resends generatedRoot. Restore the
// generated root the same way plan did so `tofu apply tfplan` runs against an
// identical root layout.
async function restoreGeneratedRootApplyWorkspace(
  runId: string,
  source: OpenTofuModuleSource,
  context: CommandContext,
  generatedRoot: GeneratedRoot,
): Promise<string> {
  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  if (generatedRoot.moduleFiles) {
    await materializeGeneratedRootFromFiles(workspace, generatedRoot);
  } else {
    await ensureSourceAvailable(source, workspace.sourceRoot, context);
    const moduleDir = resolveModulePath(
      workspace.sourceRoot,
      source.modulePath,
    );
    await assertDirectory(moduleDir, "source module directory");
    await assertRealPathInsideSourceRoot(
      moduleDir,
      workspace.sourceRoot,
      "source module directory",
    );
    await materializeGeneratedRootFromModule(
      workspace,
      moduleDir,
      generatedRoot,
    );
  }
  await restoreUploadedState(workspace, workspace.generatedRootDir);
  return workspace.generatedRootDir;
}

// BUILD phase: clone/materialize the user source, run build.commands with a
// CREDENTIAL-FREE env, then copy the declared artifact into /work/artifact.
async function runBuildPhase(
  runId: string,
  workspace: RunWorkspace,
  source: OpenTofuModuleSource,
  build: BuildSpec,
): Promise<
  | { readonly buildLog: string; readonly sourceCommit: string | undefined }
  | { readonly failure: JsonRecord }
> {
  const buildContext: CommandContext = { env: buildPhaseEnv() };
  // Hard invariant: the build phase env must carry no provider credential.
  assertBuildEnvHasNoCredentials(buildContext.env);
  await ensureSourceAvailable(source, workspace.sourceRoot, buildContext);
  const sourceCommit =
    source.kind === "git"
      ? await gitRevParseHead(workspace.sourceRoot, buildContext)
      : undefined;
  const logs: string[] = [];
  for (const command of build.commands) {
    const result = await runCommand(["bash", "-lc", command], {
      cwd: workspace.sourceRoot,
      context: buildContext,
    });
    logs.push(
      redactBuildOutput(`$ ${command}\n${result.stdout}\n${result.stderr}`),
    );
    if (result.exitCode !== 0) {
      return {
        failure: {
          runId,
          action: "plan",
          status: "failed",
          exitCode: result.exitCode,
          phase: "build",
          stdout: logs.join("\n"),
          stderr: redactBuildOutput(
            `build command failed (${result.exitCode}): ${command}\n${result.stderr}`,
          ),
        },
      };
    }
  }
  await copyBuildArtifact(workspace, build);
  return { buildLog: logs.join("\n"), sourceCommit };
}

async function copyBuildArtifact(
  workspace: RunWorkspace,
  build: BuildSpec,
): Promise<void> {
  const artifactSource = resolve(workspace.sourceRoot, build.artifactPath);
  const normalizedRoot = resolve(workspace.sourceRoot);
  if (
    artifactSource !== normalizedRoot &&
    !artifactSource.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error("build.artifactPath must stay inside source root");
  }
  await assertRealPathInsideSourceRoot(
    artifactSource,
    workspace.sourceRoot,
    "build artifact path",
  );
  await mkdir(workspace.artifactDir, { recursive: true });
  const destination = join(workspace.artifactDir, build.artifactPath);
  await mkdir(join(destination, ".."), { recursive: true });
  await cp(artifactSource, destination, { recursive: true });
}

// Expose the well-known TF_VAR_artifact_path input pointing at the copied
// artifact so a generated root may wire `var.artifact_path`.
function withArtifactPathVar(
  context: CommandContext,
  workspace: RunWorkspace,
  build: BuildSpec,
): CommandContext {
  return {
    ...context,
    env: {
      ...context.env,
      [ARTIFACT_PATH_TF_VAR]: join(workspace.artifactDir, build.artifactPath),
    },
  };
}

function redactBuildOutput(text: string): string {
  // Build commands run credential-free, but redact any value that LOOKS like a
  // known credential env assignment as defense-in-depth before it reaches the
  // run record / diagnostics.
  return redactRunnerOutput(text);
}

// Fresh per-run workspace for a generated-root plan. Preserve a SourceSnapshot
// archive already restored by the DO under /work/source; only the
// generated-root subtree is recreated.
async function prepareGeneratedRootWorkspace(
  runId: string,
): Promise<RunWorkspace> {
  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  await rm(workspace.generatedRootDir, { recursive: true, force: true });
  await mkdir(workspace.generatedRootDir, { recursive: true });
  await writeModuleInfo(workspace, workspace.generatedRootDir);
  return workspace;
}

// Writes the generated root module files and copies a child module into
// ./template-module so the generated root's `source = "./template-module"`
// resolves. For Git-sourced Capsules it is the restored SourceSnapshot module.
async function materializeGeneratedRootFromModule(
  workspace: RunWorkspace,
  moduleDir: string,
  generatedRoot: GeneratedRoot,
): Promise<void> {
  await mkdir(workspace.generatedRootDir, { recursive: true });
  await rm(workspace.templateModuleDir, { recursive: true, force: true });
  await assertDirectory(moduleDir, "child module directory");
  await cp(moduleDir, workspace.templateModuleDir, {
    recursive: true,
  });
  for (const [name, content] of Object.entries(generatedRoot.files)) {
    await writeFile(join(workspace.generatedRootDir, name), content);
  }
  // Re-assert the state moduleDir after a restore-only path created the dir.
  await writeModuleInfo(workspace, workspace.generatedRootDir);
}

async function materializeGeneratedRootFromFiles(
  workspace: RunWorkspace,
  generatedRoot: GeneratedRoot,
): Promise<void> {
  if (!generatedRoot.moduleFiles || generatedRoot.moduleFiles.length === 0) {
    throw new Error("generatedRoot.moduleFiles must be a non-empty array");
  }
  await mkdir(workspace.generatedRootDir, { recursive: true });
  await rm(workspace.templateModuleDir, { recursive: true, force: true });
  await mkdir(workspace.templateModuleDir, { recursive: true });
  for (const file of generatedRoot.moduleFiles) {
    assertSafeRelativePath(file.path, "generatedRoot.moduleFiles[].path");
    const target = resolve(workspace.templateModuleDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await assertRealPathInsideSourceRoot(
      dirname(target),
      workspace.templateModuleDir,
      "generated root child module file directory",
    );
    await writeFile(target, file.text);
  }
  for (const [name, content] of Object.entries(generatedRoot.files)) {
    await writeFile(join(workspace.generatedRootDir, name), content);
  }
  await writeModuleInfo(workspace, workspace.generatedRootDir);
}

async function ensureSourceAvailable(
  source: OpenTofuModuleSource,
  sourceRoot: string,
  context: CommandContext,
): Promise<void> {
  try {
    await assertDirectory(sourceRoot, "source root");
    if ((await readdir(sourceRoot)).length > 0) return;
  } catch {
    // Materialize below.
  }
  await rm(sourceRoot, { recursive: true, force: true });
  await materializeSource(source, sourceRoot, context);
}

// Stores the full `tofu show -json tfplan` JSON next to the plan binary so the
// DO/relay can promote it. The DO already promotes the tfplan binary; the
// plan-JSON sits beside it under the run root and is surfaced via the
// /artifacts/tfplan-json route below.
async function writePlanJsonArtifact(
  workspace: RunWorkspace,
  planJson: string,
): Promise<void> {
  await writeFile(planJsonPath(workspace), planJson);
}

function planJsonPath(workspace: RunWorkspace): string {
  return join(workspace.root, "tfplan.json");
}

async function handlePlanJsonArtifactRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json(
      { error: "method not allowed" },
      { status: 405, headers: { allow: "GET" } },
    );
  }
  try {
    const bytes = await readFile(planJsonPath(workspaceForRun(runId)));
    return new Response(bytes, {
      headers: {
        "content-type": "application/json",
        "content-length": String(bytes.byteLength),
      },
    });
  } catch {
    return Response.json(
      { error: "plan-json artifact not found" },
      { status: 404 },
    );
  }
}

async function handlePlanArtifactRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  const workspace = workspaceForRun(runId);
  if (request.method === "GET") {
    try {
      const bytes = await readFile(workspace.planPath);
      return new Response(bytes, {
        headers: {
          "content-type": "application/vnd.opentofu.plan",
          "content-length": String(bytes.byteLength),
        },
      });
    } catch {
      return Response.json(
        { error: "plan artifact not found" },
        { status: 404 },
      );
    }
  }
  if (request.method === "PUT") {
    await mkdir(workspace.root, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    await writeFile(workspace.planPath, bytes);
    return Response.json({
      runId,
      artifact: "tfplan",
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  }
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { allow: "GET, PUT" } },
  );
}

async function runCompatibilityCheck(runId: string): Promise<JsonRecord> {
  const workspace = workspaceForRun(runId);
  await assertDirectory(workspace.sourceRoot, "source root");
  const context: CommandContext = { env: buildPhaseEnv() };
  assertBuildEnvHasNoCredentials(context.env);
  const init = await runCommand(["tofu", "init", "-input=false", "-no-color"], {
    cwd: workspace.sourceRoot,
    context,
  });
  if (init.exitCode !== 0) {
    return commandFailurePayload(runId, "compatibility_check", init, context);
  }
  const files = await readCapsuleCompatibilityFiles(workspace.sourceRoot);
  const providerLockDigest = await digestFileIfExists(
    join(workspace.sourceRoot, ".terraform.lock.hcl"),
  );
  return {
    runId,
    action: "compatibility_check",
    status: "succeeded",
    exitCode: 0,
    files,
    ...(providerLockDigest ? { providerLockDigest } : {}),
    stdout: redactRunnerOutput(init.stdout, context.redactionValues),
    stderr: redactRunnerOutput(init.stderr, context.redactionValues),
  };
}

async function readCapsuleCompatibilityFiles(
  sourceRoot: string,
): Promise<readonly { readonly path: string; readonly text: string }[]> {
  const root = await realpath(sourceRoot);
  const out: { path: string; text: string }[] = [];
  let totalBytes = 0;

  async function walk(relativeDir: string): Promise<void> {
    const absoluteDir = resolve(root, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".terraform" ||
        entry.name === "node_modules"
      )
        continue;
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      const absolutePath = resolve(root, relativePath);
      assertPathInsideRoot(root, absolutePath, "compatibility source file");
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".tf") && entry.name !== ".terraform.lock.hcl")
      )
        continue;
      if (out.length >= CAPSULE_COMPATIBILITY_MAX_FILES) {
        throw new Error(
          `compatibility source files exceed ${CAPSULE_COMPATIBILITY_MAX_FILES} files`,
        );
      }
      const info = await stat(absolutePath);
      if (info.size > CAPSULE_COMPATIBILITY_MAX_FILE_BYTES) {
        throw new Error(
          `compatibility source file ${relativePath} exceeds ${CAPSULE_COMPATIBILITY_MAX_FILE_BYTES} bytes`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES) {
        throw new Error(
          `compatibility source files exceed ${CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES} bytes`,
        );
      }
      out.push({
        path: relativePath,
        text: await readFile(absolutePath, "utf8"),
      });
    }
  }

  await walk("");
  return out;
}

// ===========================================================================
// SOURCE SYNC (LANE M1)
//
// A source_sync job resolves a Git ref to a commit, makes a deterministic
// archive of `source.path`, uploads it to the DO (which persists to R2_SOURCE),
// and returns { resolvedCommit, archiveDigest, archiveSizeBytes }. Git
// credentials, when present, are minted by the Vault for the `source` phase and
// arrive as { env, files }. The runner writes credential files to a per-run temp
// dir with the given mode, uses them via GIT_ASKPASS / GIT_SSH_COMMAND, and
// shreds them afterward. Credentials are NEVER embedded in the URL and NEVER
// logged.
// ===========================================================================

interface SourceSyncSource {
  readonly url: string;
  readonly ref: string;
  readonly path: string;
}

interface SourceCredentialFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
}

interface SourceCredentials {
  readonly env: Record<string, string>;
  readonly files: readonly SourceCredentialFile[];
}

export function isSourceSyncRequest(request: unknown): boolean {
  return stringField(request, "action") === "source_sync";
}

export function parseSourceSyncSource(request: unknown): SourceSyncSource {
  const source = recordField(request, "source");
  if (!isRecord(source)) throw new Error("source_sync.source is required");
  const url = requiredStringField(source, "url");
  const ref = requiredStringField(source, "ref");
  // Defense in depth: re-check the URL policy locally (the service already
  // validated it). The rules are small and duplicated intentionally so a runner
  // never clones a forbidden scheme even if a malformed job reaches it.
  assertSourceUrlPolicy(url);
  assertSafeGitSelector(ref, "source_sync.source.ref");
  const rawPath = stringField(source, "path") ?? ".";
  const path = normalizeSourceSubtreePath(rawPath);
  return { url, ref, path };
}

// URL policy (spec 7.1): allow https://host/path(.git), ssh://git@host/...,
// git@host:path. Forbid file://, absolute/relative filesystem paths, git://,
// ext::, and embedded credentials (user:pass@).
export function assertSourceUrlPolicy(url: string): void {
  if (url.length === 0) throw new Error("source url must not be empty");
  if (/[\\\r\n\0]/.test(url)) {
    throw new Error("source url is malformed");
  }
  const lower = url.toLowerCase();
  if (lower.startsWith("file://")) {
    throw new Error("source url scheme file:// is forbidden");
  }
  if (lower.startsWith("git://")) {
    throw new Error("source url scheme git:// is forbidden");
  }
  if (lower.startsWith("ext::")) {
    throw new Error("source url transport ext:: is forbidden");
  }
  // scp-like shorthand: git@host:path (no scheme, single colon before path).
  const scpLike = /^([^@/\s]+)@([^:/\s]+):(.+)$/.exec(url);
  if (scpLike && !url.includes("://")) {
    const user = scpLike[1]!;
    const host = scpLike[2]!;
    const remotePath = scpLike[3]!;
    if (user.includes(":")) {
      throw new Error("source url must not embed credentials");
    }
    if (host.length === 0 || remotePath.length === 0) {
      throw new Error("source url is malformed");
    }
    assertSourceHostAllowed(host);
    if (/[\r\n\0]/.test(url) || url.startsWith("-")) {
      throw new Error("source url contains control characters");
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "source url must be a valid https/ssh URL or git@host:path",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw new Error(`source url scheme ${parsed.protocol} is forbidden`);
  }
  if (parsed.username || parsed.password) {
    // ssh://git@host carries only a username (the ssh login, conventionally
    // "git") and no password; that is allowed. A password is always rejected.
    if (parsed.password) {
      throw new Error("source url must not embed credentials");
    }
    if (parsed.protocol === "https:" && parsed.username) {
      throw new Error("source url must not embed credentials");
    }
  }
  if (!parsed.hostname) throw new Error("source url must include a host");
  assertSourceHostAllowed(parsed.hostname);
  if (/[\r\n\0]/.test(url)) {
    throw new Error("source url contains control characters");
  }
}

function assertSourceHostAllowed(host: string): void {
  const normalized = host.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal"
  ) {
    throw new Error("source url host is blocked");
  }
  try {
    assertHostNotBlocked(host, "source URL host");
  } catch (error) {
    if (error instanceof BlockedHostError) {
      throw new Error("source url host is blocked");
    }
    throw error;
  }
}

// The source subtree path is a relative path INSIDE the cloned repo. Reject
// absolute paths and any traversal so a job can only ever archive a directory
// that lives under the checkout.
function normalizeSourceSubtreePath(path: string): string {
  if (path === "" || path === ".") return ".";
  if (isAbsolute(path) || path.includes("\0") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(
      `source_sync.source.path is not a safe relative path: ${path}`,
    );
  }
  const normalized = normalize(path)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(
      `source_sync.source.path is not a safe relative path: ${path}`,
    );
  }
  return normalized;
}

export function parseSourceCredentials(request: unknown): SourceCredentials {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return { env: {}, files: [] };
  const env: Record<string, string> = {};
  const rawEnv = recordField(credentials, "env");
  if (isRecord(rawEnv)) {
    for (const [name, value] of Object.entries(rawEnv)) {
      if (typeof value === "string" && SOURCE_CREDENTIAL_ENV_NAMES.has(name)) {
        env[name] = value;
      }
    }
  }
  const files: SourceCredentialFile[] = [];
  const rawFiles = recordField(credentials, "files");
  if (Array.isArray(rawFiles)) {
    for (const entry of rawFiles) {
      if (!isRecord(entry)) continue;
      const path = stringField(entry, "path");
      const content = entry.content;
      const mode = entry.mode;
      if (
        typeof path !== "string" ||
        typeof content !== "string" ||
        typeof mode !== "number"
      ) {
        throw new Error("source_sync credential file is malformed");
      }
      assertSafeCredentialFileName(path);
      assertSafeCredentialFileMode(mode);
      files.push({ path, mode: Math.floor(mode), content });
    }
  }
  return { env, files };
}

// The R2_SOURCE archive object key (agreed layout
// spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst) is
// minted by the service and persisted by the DO. The runner forwards it to the
// DO; re-assert here that it is a safe, traversal-free relative key.
export function assertSafeArchiveObjectKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("\0") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.startsWith("spaces/") === false
  ) {
    throw new Error(`unsafe source archive object key: ${key}`);
  }
}

// Minted credential files are referenced only by basename inside the per-run
// credential dir; reject anything with a separator/traversal so a job can never
// write outside that dir.
function assertSafeCredentialFileName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".." ||
    isAbsolute(name)
  ) {
    throw new Error(`source_sync credential file path is unsafe: ${name}`);
  }
}

function assertSafeCredentialFileMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0o400 || mode > 0o700) {
    throw new Error(`source_sync credential file mode is unsafe: ${mode}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `source_sync credential file mode is group/world-readable: ${mode}`,
    );
  }
}

async function runSourceSync(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const source = parseSourceSyncSource(request);
  const credentials = parseSourceCredentials(request);
  const runnerProfile = parseRunnerProfile(request);
  // archiveObjectKey may sit at the request root or alongside source; accept
  // either so the service lane can place it wherever the run record holds it.
  const archiveObjectKey =
    stringField(request, "archiveObjectKey") ??
    stringField(recordField(request, "source"), "archiveObjectKey");
  if (!archiveObjectKey) throw new Error("archiveObjectKey is required");
  assertSafeArchiveObjectKey(archiveObjectKey);
  const maxArchiveBytes =
    positiveIntegerLimitFromProfile(runnerProfile, "maxSourceArchiveBytes") ??
    DEFAULT_SOURCE_ARCHIVE_MAX_BYTES;

  const workspace = workspaceForRun(runId);
  await rm(workspace.root, { recursive: true, force: true });
  await mkdir(workspace.root, { recursive: true });
  const credentialDir = join(workspace.root, "source-credentials");

  try {
    // SECURITY (SSRF): assertSourceUrlPolicy (run in parseSourceSyncSource) only
    // rejects IP *literals*. Before the credentialed git phase touches the
    // network, resolve the source host (DoH) and reject if ANY resolved address
    // is private/loopback/link-local — the same DNS-rebinding protection the
    // plan/apply git path gets via assertHttpsSourceUrl. Fails closed when the
    // host cannot be resolved.
    await assertResolvedHostNotBlocked(
      sourceUrlHost(source.url),
      "source URL host",
    );
    const gitContext = await prepareSourceGitContext(
      source,
      credentials,
      credentialDir,
    );
    const resolvedCommit = await resolveSourceCommit(source, gitContext);
    await shallowCloneAtCommit(
      source,
      resolvedCommit,
      workspace.sourceRoot,
      gitContext,
    );
    const subtree = await resolveSourceSubtree(
      workspace.sourceRoot,
      source.path,
    );
    const archivePath = sourceArchivePath(workspace);
    await createDeterministicArchive(subtree, archivePath, gitContext);
    const archiveBytes = await readFile(archivePath);
    if (archiveBytes.byteLength > maxArchiveBytes) {
      throw new Error(
        `source archive ${archiveBytes.byteLength} bytes exceeds limit ${maxArchiveBytes}`,
      );
    }
    const archiveDigest = await digestBytes(archiveBytes);
    // The archive is left at sourceArchivePath; the DO pulls it via
    // GET /runs/{runId}/artifacts/source-archive and persists to R2_SOURCE under
    // archiveObjectKey (mirrors the tfplan pull-then-persist protocol). The key
    // is echoed back so the DO knows where to write.
    return {
      runId,
      action: "source_sync",
      status: "succeeded",
      exitCode: 0,
      resolvedCommit,
      archiveDigest,
      archiveSizeBytes: archiveBytes.byteLength,
      sourceArchive: {
        kind: "runner-local",
        ref: `runner-local://${runId}/source-archive`,
        archiveObjectKey,
        digest: archiveDigest,
        contentType: "application/zstd",
        sizeBytes: archiveBytes.byteLength,
      },
    };
  } finally {
    await shredCredentialDir(credentialDir);
  }
}

interface SourceGitContext {
  readonly context: CommandContext;
}

// Writes any minted credential files to the per-run credential dir and builds
// the command env that wires git to use them WITHOUT ever putting a secret in
// the URL or process arg list. https token flow uses GIT_ASKPASS; ssh-key flow
// uses GIT_SSH_COMMAND with StrictHostKeyChecking=yes against the minted
// known_hosts (StrictHostKeyChecking=no is forbidden).
async function prepareSourceGitContext(
  source: SourceSyncSource,
  credentials: SourceCredentials,
  credentialDir: string,
): Promise<SourceGitContext> {
  const env: Record<string, string> = {
    ...baseCommandEnv(),
    GIT_TERMINAL_PROMPT: "0",
    // Minted env (e.g. GIT_HTTPS_TOKEN, or a username) is threaded through but
    // is consumed by the askpass script, never written to the URL.
    ...credentials.env,
  };

  let wroteKeyFile = false;
  let keyFilePath = "";
  let knownHostsPath = "";
  let askpassPath = "";

  if (credentials.files.length > 0) {
    await mkdir(credentialDir, { recursive: true, mode: 0o700 });
    for (const file of credentials.files) {
      const target = join(credentialDir, file.path);
      await writeFile(target, file.content, { mode: file.mode });
      // writeFile honors umask on some platforms; force the requested mode.
      await chmod(target, file.mode);
      if (/known_hosts/i.test(file.path)) knownHostsPath = target;
      else if (/askpass/i.test(file.path)) askpassPath = target;
      else {
        keyFilePath = target;
        wroteKeyFile = true;
      }
    }
  }

  const scheme = sourceUrlScheme(source.url);
  if (scheme === "ssh") {
    // SECURITY INVARIANT: an ssh source ALWAYS requires a minted known_hosts
    // entry so host verification runs with StrictHostKeyChecking=yes. Without
    // it the job cannot verify the host and we fail closed rather than fall back
    // to a permissive default (StrictHostKeyChecking=no is forbidden). A key is
    // also required in practice; reject when neither is minted.
    if (!knownHostsPath) {
      throw new Error(
        wroteKeyFile
          ? "ssh source requires a known_hosts entry; StrictHostKeyChecking=no is forbidden"
          : "ssh source requires a minted ssh key and known_hosts (StrictHostKeyChecking=yes)",
      );
    }
    const sshParts = [
      "ssh",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
    ];
    if (wroteKeyFile) {
      sshParts.push("-i", shellQuote(keyFilePath));
    }
    env.GIT_SSH_COMMAND = sshParts.join(" ");
  } else if (askpassPath) {
    // https token flow: GIT_ASKPASS points at the minted script which echoes
    // the token (and optional username). GIT_TERMINAL_PROMPT=0 ensures git never
    // falls back to an interactive prompt.
    await chmod(askpassPath, 0o500);
    env.GIT_ASKPASS = askpassPath;
  }

  return {
    context: {
      env,
      redactionValues: sourceCredentialRedactionValues(credentials),
    },
  };
}

function sourceUrlScheme(url: string): "https" | "ssh" {
  const lower = url.toLowerCase();
  if (lower.startsWith("ssh://")) return "ssh";
  if (lower.startsWith("https://")) return "https";
  // scp-like git@host:path is ssh transport.
  if (/^[^@/\s]+@[^:/\s]+:.+$/.test(url) && !url.includes("://")) return "ssh";
  return "https";
}

// Extract the host from an already-policy-validated source URL (https://, ssh://,
// or scp-like git@host:path) so it can be DoH-resolved for SSRF validation. Uses
// the same parsing assertSourceUrlPolicy applies.
function sourceUrlHost(url: string): string {
  const scpLike = /^([^@/\s]+)@([^:/\s]+):(.+)$/.exec(url);
  if (scpLike && !url.includes("://")) {
    return scpLike[2]!;
  }
  return new URL(url).hostname;
}

// Resolve the requested ref to a full commit sha. A full 40/64-hex ref is taken
// verbatim (it is a commit id already); otherwise ls-remote resolves the
// branch/tag. The ref is passed as a literal arg (never interpolated into a
// shell string) and is validated by assertSafeGitSelector.
async function resolveSourceCommit(
  source: SourceSyncSource,
  git: SourceGitContext,
): Promise<string> {
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(source.ref)) {
    return source.ref.toLowerCase();
  }
  const result = await runCommand(
    ["git", "ls-remote", "--", source.url, source.ref],
    { cwd: RUN_ROOT, context: git.context },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-remote failed: ${redactCredentialOutput(result.stderr || result.stdout, git.context)}`,
    );
  }
  const commit = parseLsRemoteCommit(result.stdout, source.ref);
  if (!commit) {
    throw new Error(`source ref did not resolve to a commit: ${source.ref}`);
  }
  return commit;
}

// Parse `git ls-remote` output ("<sha>\t<refname>") and pick the commit for the
// requested ref. Prefers an exact refs/heads|refs/tags match, then a peeled tag
// (^{}), then the bare ref, then a single-line fallback.
export function parseLsRemoteCommit(
  stdout: string,
  ref: string,
): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = lines.flatMap((line) => {
    const [sha, name] = line.split(/\s+/, 2);
    if (!sha || !name || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(sha)) return [];
    return [{ sha: sha.toLowerCase(), name }];
  });
  if (rows.length === 0) return undefined;
  const candidates = [
    `refs/heads/${ref}`,
    `refs/tags/${ref}^{}`,
    `refs/tags/${ref}`,
    ref,
  ];
  for (const candidate of candidates) {
    const match = rows.find((row) => row.name === candidate);
    if (match) return match.sha;
  }
  // Annotated-tag peel: prefer the peeled object when both forms are present.
  const peeled = rows.find((row) => row.name.endsWith("^{}"));
  if (peeled) return peeled.sha;
  return rows.length === 1 ? rows[0]!.sha : undefined;
}

async function shallowCloneAtCommit(
  source: SourceSyncSource,
  commit: string,
  sourceRoot: string,
  git: SourceGitContext,
): Promise<void> {
  await mkdir(sourceRoot, { recursive: true });
  await runRequiredCommand(["git", "init", "-q"], {
    cwd: sourceRoot,
    context: git.context,
  });
  await runRequiredCommand(
    ["git", "remote", "add", "origin", "--", source.url],
    { cwd: sourceRoot, context: git.context },
  );
  // Fetch exactly the resolved commit at depth 1. Server must allow fetching by
  // sha (uploadpack.allowReachableSHA1InWant / allowAnySHA1InWant); most hosts
  // (GitHub/GitLab) do. Fall back to a shallow fetch of the ref then checkout.
  const fetchSha = await runCommand(
    ["git", "fetch", "--depth", "1", "--no-tags", "origin", commit],
    { cwd: sourceRoot, context: git.context },
  );
  if (fetchSha.exitCode === 0) {
    await runRequiredCommand(["git", "checkout", "-q", "--detach", commit], {
      cwd: sourceRoot,
      context: git.context,
    });
    return;
  }
  await runRequiredCommand(
    ["git", "fetch", "--depth", "1", "--no-tags", "origin", "--", source.ref],
    { cwd: sourceRoot, context: git.context },
  );
  await runRequiredCommand(["git", "checkout", "-q", "--detach", commit], {
    cwd: sourceRoot,
    context: git.context,
  });
}

async function resolveSourceSubtree(
  sourceRoot: string,
  path: string,
): Promise<string> {
  const subtree = path === "." ? sourceRoot : resolve(sourceRoot, path);
  await assertDirectory(subtree, "source subtree");
  await assertRealPathInsideSourceRoot(subtree, sourceRoot, "source subtree");
  return subtree;
}

// Build a deterministic tar of the subtree (sorted entries, numeric owners,
// excluding .git) and compress with zstd. Determinism makes the digest stable
// across two runs of the same commit.
async function createDeterministicArchive(
  subtree: string,
  archivePath: string,
  git: SourceGitContext,
): Promise<void> {
  await runRequiredCommand(
    [
      "tar",
      "--sort=name",
      "--numeric-owner",
      "--owner=0",
      "--group=0",
      "--mtime=@0",
      "--exclude=.git",
      "--format=gnu",
      "-C",
      subtree,
      "-cf",
      `${archivePath}.tar`,
      ".",
    ],
    { cwd: RUN_ROOT, context: git.context },
  );
  await runRequiredCommand(
    ["zstd", "-q", "-19", "-f", "-o", archivePath, `${archivePath}.tar`],
    { cwd: RUN_ROOT, context: git.context },
  );
  await rm(`${archivePath}.tar`, { force: true });
}

function sourceArchivePath(workspace: RunWorkspace): string {
  return join(workspace.root, "source.tar.zst");
}

async function shredCredentialDir(credentialDir: string): Promise<void> {
  await rm(credentialDir, { recursive: true, force: true }).catch(() => {});
}

// Redact any minted git credential env value that might appear in command
// output. Git never receives the secret in the URL, but ls-remote/fetch errors
// can echo the URL or env; this strips known credential env assignments and the
// literal token value if it is known.
function redactCredentialOutput(text: string, context: CommandContext): string {
  return redactRunnerOutput(text, context.redactionValues);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Stores the uploaded source archive bytes under the run root so the DO can GET
// them; in practice the DO PUTs and immediately persists to R2, so this route is
// the relay seam. The bytes are kept until the next run wipes the workspace.
async function handleSourceArchiveArtifactRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  const workspace = workspaceForRun(runId);
  const archivePath = sourceArchivePath(workspace);
  if (request.method === "GET") {
    try {
      const bytes = await readFile(archivePath);
      return new Response(bytes, {
        headers: {
          "content-type": "application/zstd",
          "content-length": String(bytes.byteLength),
        },
      });
    } catch {
      return Response.json(
        { error: "source archive artifact not found" },
        { status: 404 },
      );
    }
  }
  if (request.method === "PUT") {
    await mkdir(workspace.root, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    await writeFile(archivePath, bytes);
    return Response.json({
      runId,
      artifact: "source-archive",
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  }
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { allow: "GET, PUT" } },
  );
}

// M2 SOURCE-ARCHIVE RESTORE: the DO streams the snapshotted source archive
// (deterministic tar.zst produced by a prior source_sync) to this route. We
// write the bytes, list+validate the archive metadata with the SAME tar-slip
// hardening used for prepared sources, then extract into /work/source as the
// source tree for the build/plan phases. The archive already contains the
// snapshot subtree (source_sync archived `source.path`), so it is extracted at
// the source root with no path remap.
async function handleSourceArchiveRestoreRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "PUT") {
    return Response.json(
      { error: "method not allowed" },
      { status: 405, headers: { allow: "PUT" } },
    );
  }
  const workspace = workspaceForRun(runId);
  try {
    await rm(workspace.root, { recursive: true, force: true });
    await mkdir(workspace.sourceRoot, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const archivePath = join(workspace.root, "restore-source.tar.zst");
    await writeFile(archivePath, bytes);
    const context: CommandContext = { env: baseCommandEnv() };
    await assertSafeZstdTarArchive(archivePath, context);
    await runRequiredCommand(
      [
        "tar",
        "-x",
        "--zstd",
        "-f",
        archivePath,
        "--no-same-owner",
        "--keep-old-files",
        "-C",
        workspace.sourceRoot,
      ],
      { cwd: RUN_ROOT, context },
    );
    await rm(archivePath, { force: true });
    // Record the source root as the state moduleDir default; a template/raw
    // dispatch overwrites module-info.json before plan, but this keeps the state
    // GET route resolvable if the dispatch omits it.
    await writeModuleInfo(workspace, workspace.sourceRoot);
    return Response.json({
      runId,
      artifact: "source-archive-restore",
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  } catch (error) {
    return Response.json(
      {
        error: "source archive restore failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// remote_state DEPENDENCY STATE RESTORE (spec §15): the DO streams a decrypted
// producer tfstate to this route. We write the bytes READ-ONLY (0444) as
// <depsDir>/<name>.tfstate so the consumer's `terraform_remote_state` data
// sources can read it during init/plan/apply. The dep name is path-jailed to a
// single safe filename segment (no traversal, no separators) so the write stays
// inside the deps dir. Read-only blocks any accidental write-back to a producer's
// state (a remote_state read is one-directional).
export async function handleDepStateRestoreRequest(
  runId: string,
  name: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "PUT") {
    return Response.json(
      { error: "method not allowed" },
      { status: 405, headers: { allow: "PUT" } },
    );
  }
  const workspace = workspaceForRun(runId);
  try {
    const safeName = safeDepName(name);
    const target = join(workspace.depsDir, `${safeName}.tfstate`);
    // Path-jail: the resolved target MUST stay inside the deps dir.
    const resolvedTarget = resolve(target);
    const resolvedDepsDir = resolve(workspace.depsDir);
    if (
      resolvedTarget !== join(resolvedDepsDir, `${safeName}.tfstate`) ||
      !resolvedTarget.startsWith(`${resolvedDepsDir}/`)
    ) {
      throw new Error(`dependency state name escapes deps dir: ${name}`);
    }
    await mkdir(workspace.depsDir, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    // Remove any prior (read-only) file from a re-restore of the same dep name in
    // this run, then write + chmod 0444. writeFile honors umask on some
    // platforms, so force the read-only mode after the bytes land.
    await rm(target, { force: true });
    await writeFile(target, bytes);
    await chmod(target, 0o444);
    return Response.json({
      runId,
      artifact: "dep-state-restore",
      name: safeName,
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  } catch (error) {
    return Response.json(
      {
        error: "dependency state restore failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// A remote_state dependency name must be a single safe path segment so it can
// only ever name <depsDir>/<name>.tfstate. Reject empty / traversal / separator
// / NUL / drive-letter names (the producer Installation name is `[a-z0-9-]`-ish,
// but harden against a crafted dispatch).
function safeDepName(name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    isAbsolute(name) ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`unsafe dependency state name: ${name}`);
  }
  return name;
}

// Same tar-slip / link-target / zip-bomb hardening as assertSafeTarArchive but
// for a zstd-compressed tar (the source_sync archive format). Reuses the shared
// per-entry validators (escape quoting, duplicate normalized paths, file/dir
// only, decompressed-size cap).
export async function assertSafeZstdTarArchive(
  archivePath: string,
  context: CommandContext,
): Promise<void> {
  const verbose = await runCommand(
    ["tar", "-t", "-v", "--quoting-style=escape", "--zstd", "-f", archivePath],
    { cwd: RUN_ROOT, context },
  );
  if (verbose.exitCode !== 0) {
    throw new Error(
      `source archive metadata list failed: ${verbose.stderr || verbose.stdout}`,
    );
  }
  const seenPaths = new Set<string>();
  let decompressedBytes = 0;
  for (const line of verbose.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const entry = parseTarVerboseLine(line);
    if (!entry) {
      throw new Error(
        `source archive has an unparseable metadata line: ${line}`,
      );
    }
    const normalizedPath = normalizeSourceArchiveEntryPath(entry.path);
    // The deterministic source archive carries a single `./` root dir entry;
    // skip it from the duplicate set but still validate it is the safe root.
    if (normalizedPath !== "") {
      if (seenPaths.has(normalizedPath)) {
        throw new Error(
          `source archive duplicates normalized path: ${entry.path}`,
        );
      }
      seenPaths.add(normalizedPath);
    }
    if (entry.type !== "-" && entry.type !== "d") {
      throw new Error(
        `source archive contains unsupported entry type: ${entry.type}`,
      );
    }
    decompressedBytes += entry.size;
    const decompressedCap =
      context.sourceArchiveMaxDecompressedBytes ??
      DEFAULT_PREPARED_SOURCE_MAX_DECOMPRESSED_BYTES;
    if (decompressedBytes > decompressedCap) {
      throw new Error(
        `source archive decompresses to more than ${decompressedCap} bytes`,
      );
    }
  }
}

// Like normalizeArchiveEntryPath but tolerant of the deterministic source
// archive's `.` / `./` ROOT entry (returns "" for it). Everything else must be a
// traversal-free, absolute-free relative path so extraction stays inside
// /work/source.
function normalizeSourceArchiveEntryPath(path: string): string {
  if (path === "." || path === "./") return "";
  if (path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`source archive contains unsafe path: ${path}`);
  }
  const normalized = normalize(path)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`source archive contains unsafe path: ${path}`);
  }
  return normalized;
}

function workspaceForRun(runId: string): RunWorkspace {
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  return {
    root,
    sourceRoot,
    moduleDir: sourceRoot,
    planPath: join(root, "tfplan"),
    restoredStatePath: join(root, "restored.tfstate"),
    moduleInfoPath: join(root, "module-info.json"),
    generatedRootDir: join(root, "generated-root"),
    templateModuleDir: join(root, "generated-root", "template-module"),
    artifactDir: join(root, "artifact"),
    // The deps dir is a SIBLING of root (not under it) so the producer state
    // files restored BEFORE the run POST survive the plan/apply workspace prep,
    // which wipes `root`. The consumer's `terraform_remote_state` data sources
    // reference these absolute paths; they are written read-only (one-way read).
    depsDir: join(RUN_ROOT, `${safeRunId(runId)}-deps`),
  };
}

async function handleStateArtifactRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  const workspace = workspaceForRun(runId);
  if (request.method === "GET") {
    const moduleDir = await readModuleDir(workspace);
    try {
      const bytes = await readFile(join(moduleDir, "terraform.tfstate"));
      return new Response(bytes, {
        headers: {
          "content-type": "application/json",
          "content-length": String(bytes.byteLength),
        },
      });
    } catch {
      return Response.json(
        { error: "state artifact not found" },
        { status: 404 },
      );
    }
  }
  if (request.method === "PUT") {
    await mkdir(workspace.root, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    await writeFile(workspace.restoredStatePath, bytes);
    return Response.json({
      runId,
      artifact: "tfstate",
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  }
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { allow: "GET, PUT" } },
  );
}

async function writeModuleInfo(
  workspace: RunWorkspace,
  moduleDir: string,
): Promise<void> {
  await writeFile(
    workspace.moduleInfoPath,
    `${JSON.stringify({ moduleDir })}\n`,
  );
}

async function readModuleDir(workspace: RunWorkspace): Promise<string> {
  try {
    const parsed = JSON.parse(
      await readFile(workspace.moduleInfoPath, "utf8"),
    ) as unknown;
    if (isRecord(parsed) && typeof parsed.moduleDir === "string") {
      return parsed.moduleDir;
    }
  } catch {
    // Fall through to the default root-module state path.
  }
  return workspace.sourceRoot;
}

async function restoreUploadedState(
  workspace: RunWorkspace,
  moduleDir: string,
): Promise<void> {
  try {
    const bytes = await readFile(workspace.restoredStatePath);
    await writeFile(join(moduleDir, "terraform.tfstate"), bytes);
  } catch {
    // No previous state exists for first create plans.
  }
}

async function materializeSource(
  source: OpenTofuModuleSource,
  sourceRoot: string,
  context: CommandContext,
): Promise<void> {
  switch (source.kind) {
    case "git":
      await assertHttpsSourceUrl(source.url, "git source url");
      if (source.ref) assertSafeGitSelector(source.ref, "git source ref");
      if (source.commit)
        assertFullGitObjectId(source.commit, "git source commit");
      await runRequiredCommand(["git", "clone", source.url, sourceRoot], {
        cwd: RUN_ROOT,
        context,
      });
      if (source.ref) {
        await runRequiredCommand(["git", "checkout", source.ref], {
          cwd: sourceRoot,
          context,
        });
      }
      if (source.commit) {
        await runRequiredCommand(["git", "checkout", source.commit], {
          cwd: sourceRoot,
          context,
        });
      }
      return;
    case "prepared": {
      await assertHttpsSourceUrl(source.url, "prepared source url");
      const response = await fetch(source.url, { redirect: "error" });
      if (!response.ok) {
        throw new Error(`prepared source fetch failed: ${response.status}`);
      }
      const bytes = await readResponseBytesWithCap(
        response,
        context.sourceArchiveMaxBytes ?? DEFAULT_PREPARED_SOURCE_MAX_BYTES,
        "prepared source archive",
      );
      const digest = await digestBytes(bytes);
      if (digest !== source.digest) {
        throw new Error(`prepared source digest mismatch: ${digest}`);
      }
      const archivePath = join(sourceRoot, "..", "source.tar.gz");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(archivePath, bytes);
      await assertSafeTarArchive(archivePath, context);
      await runRequiredCommand(
        [
          "tar",
          "-x",
          "-z",
          "-f",
          archivePath,
          "--no-same-owner",
          "--keep-old-files",
          "-C",
          sourceRoot,
        ],
        { cwd: RUN_ROOT, context },
      );
      return;
    }
    case "local":
      await cp(source.path, sourceRoot, { recursive: true });
      return;
  }
}

async function assertSafeTarArchive(
  archivePath: string,
  context: CommandContext,
): Promise<void> {
  // SECURITY (tar-slip / link-target bypass): use `--quoting-style=escape`, NOT
  // `literal`. Literal quoting lets a newline byte in an entry name split the
  // listing across two lines, so the traversal / duplicate checks see a harmless
  // first line and silently skip the dangerous fragment while `tar -x` still
  // extracts the real entry. Escape quoting renders control chars as backslash
  // sequences so a name can never span lines. This matches the hardened shared
  // core (contract/reference/prepared-source-core.ts).
  const verbose = await runCommand(
    ["tar", "-t", "-v", "--quoting-style=escape", "-z", "-f", archivePath],
    {
      cwd: RUN_ROOT,
      context,
    },
  );
  if (verbose.exitCode !== 0) {
    throw new Error(
      `prepared source archive metadata list failed: ${verbose.stderr || verbose.stdout}`,
    );
  }
  const seenPaths = new Set<string>();
  let decompressedBytes = 0;
  for (const line of verbose.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const entry = parseTarVerboseLine(line);
    // REJECT any unparseable non-empty line instead of skipping it: a skipped
    // line is exactly how a smuggled entry would evade the path / type checks.
    if (!entry) {
      throw new Error(
        `prepared source archive has an unparseable metadata line: ${line}`,
      );
    }
    const normalizedPath = normalizeArchiveEntryPath(entry.path);
    if (seenPaths.has(normalizedPath)) {
      throw new Error(
        `prepared source archive duplicates normalized path: ${entry.path}`,
      );
    }
    seenPaths.add(normalizedPath);
    if (entry.type !== "-" && entry.type !== "d") {
      throw new Error(
        `prepared source archive contains unsupported entry type: ${entry.type}`,
      );
    }
    decompressedBytes += entry.size;
    const decompressedCap =
      context.sourceArchiveMaxDecompressedBytes ??
      DEFAULT_PREPARED_SOURCE_MAX_DECOMPRESSED_BYTES;
    if (decompressedBytes > decompressedCap) {
      throw new Error(
        `prepared source archive decompresses to more than ${decompressedCap} bytes`,
      );
    }
  }
}

interface TarVerboseEntry {
  readonly type: string;
  readonly path: string;
  readonly size: number;
}

function parseTarVerboseLine(line: string): TarVerboseEntry | undefined {
  const columns = line.split(/\s+/);
  if (columns.length < 6) return undefined;
  const rawSize = Number.parseInt(columns[2] ?? "0", 10);
  const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0;
  let cursor = 0;
  let column = 0;
  while (column < 5 && cursor < line.length) {
    while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor += 1;
    while (cursor < line.length && !/\s/.test(line[cursor] ?? "")) cursor += 1;
    column += 1;
  }
  while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor += 1;
  const path = line.slice(cursor);
  if (!path) return undefined;
  return { type: line[0] ?? "", path, size };
}

function normalizeArchiveEntryPath(path: string): string {
  if (
    path === "." ||
    path === "./" ||
    path.includes("\0") ||
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw new Error(`prepared source archive contains unsafe path: ${path}`);
  }
  const normalized = normalize(path).replaceAll("\\", "/").replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`prepared source archive contains unsafe path: ${path}`);
  }
  return normalized;
}

async function assertHttpsSourceUrl(url: string, label: string): Promise<void> {
  // Git/libcurl and WHATWG URL parsing disagree on backslashes. Reject the raw
  // URL before validating `new URL(url).hostname` and before handing it to git.
  if (/[\\\r\n\0]/.test(url)) {
    throw new Error(`${label} is malformed`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use https://`);
  }
  if (!parsed.hostname) {
    throw new Error(`${label} must include a host`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not embed credentials`);
  }
  assertHostLiteralNotBlocked(parsed.hostname, `${label} host`);
  // SECURITY (SSRF): the literal check above only rejects IP literals. A DNS
  // NAME that resolves to a private/loopback/link-local address would otherwise
  // pass and let the credentialed runner fetch/clone from internal hosts. Reject
  // internal-only name suffixes and resolve the host (DoH), rejecting if ANY
  // resolved address is blocked. Fails closed when the host cannot be resolved.
  await assertResolvedHostNotBlocked(parsed.hostname, `${label} host`);
}

const INTERNAL_NAME_SUFFIXES =
  /(\.internal|\.local|\.localdomain|\.intranet|\.lan|\.corp|\.home|\.svc|\.cluster\.local)$/;

async function assertResolvedHostNotBlocked(
  host: string,
  label: string,
): Promise<void> {
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // IP literals are already fully covered by assertHostLiteralNotBlocked.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(literal) || literal.includes(":")) {
    return;
  }
  const lower = literal.toLowerCase();
  if (lower === "localhost" || INTERNAL_NAME_SUFFIXES.test(lower)) {
    throw new Error(`${label} is an internal-only name: ${host}`);
  }
  const addresses = await resolveHostAddresses(literal);
  if (addresses.length === 0) {
    throw new Error(
      `${label} could not be resolved for SSRF validation: ${host}`,
    );
  }
  for (const addr of addresses) {
    if (isBlockedIpv4Literal(addr) || isBlockedIpv6Literal(addr)) {
      throw new Error(
        `${label} resolves to a blocked address (${addr}): ${host}`,
      );
    }
  }
}

/** Resolve A/AAAA records via DNS-over-HTTPS for SSRF pre-flight validation. */
async function resolveHostAddresses(host: string): Promise<string[]> {
  const addresses: string[] = [];
  for (const type of ["A", "AAAA"]) {
    try {
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(
          host,
        )}&type=${type}`,
        {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) continue;
      const body = (await response.json()) as {
        Answer?: Array<{ type: number; data: string }>;
      };
      for (const answer of body.Answer ?? []) {
        // RR type 1 = A, 28 = AAAA. Ignore CNAME/other chain records.
        if (
          (answer.type === 1 || answer.type === 28) &&
          typeof answer.data === "string"
        ) {
          addresses.push(answer.data.trim());
        }
      }
    } catch {
      // Treat a failed lookup as "unresolved"; the caller fails closed.
    }
  }
  return addresses;
}

function assertSafeGitSelector(value: string, label: string): void {
  if (value.startsWith("-") || /[\r\n\0]/.test(value)) {
    throw new Error(
      `${label} must not start with '-' or contain control characters`,
    );
  }
}

function assertFullGitObjectId(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} must be a full git object id`);
  }
}

function assertHostLiteralNotBlocked(host: string, label: string): void {
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = literal.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new Error(`${label} is not allowed: ${host}`);
  }
  if (isBlockedIpv4Literal(lower) || isBlockedIpv6Literal(lower)) {
    throw new Error(`${label} is not allowed: ${host}`);
  }
}

function isBlockedIpv4Literal(value: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c, d] = parts;
  if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a === 255 && b === 255 && c === 255 && d === 255;
}

function isBlockedIpv6Literal(value: string): boolean {
  if (!value.includes(":")) return false;
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("ff")) return true;
  if (value.startsWith("::ffff:")) {
    return isBlockedIpv4Literal(value.slice("::ffff:".length));
  }
  return false;
}

async function readResponseBytesWithCap(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number.parseInt(declared, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error(`${label} declares ${parsed} bytes, cap is ${maxBytes}`);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function runRequiredCommand(
  command: readonly string[],
  options: { readonly cwd: string; readonly context: CommandContext },
): Promise<void> {
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command[0]} failed with ${result.exitCode}: ${redactRunnerOutput(
        result.stderr || result.stdout,
        options.context.redactionValues,
      )}`,
    );
  }
}

async function readOpenTofuPlanJson(
  moduleDir: string,
  workspace: RunWorkspace,
  context: CommandContext,
): Promise<string | undefined> {
  const result = await runCommand(
    ["tofu", "show", "-json", workspace.planPath],
    { cwd: moduleDir, context },
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0
    ? result.stdout
    : undefined;
}

async function readOpenTofuOutputsIn(
  moduleDir: string,
  context: CommandContext,
): Promise<Record<string, unknown> | undefined> {
  const result = await runCommand(["tofu", "output", "-json"], {
    cwd: moduleDir,
    context,
  });
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0
    ) {
      return parsed as Record<string, unknown>;
    }
  }
  return await readOpenTofuOutputsFromStateFile(moduleDir);
}

async function readOpenTofuOutputsFromStateFile(
  moduleDir: string,
): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(moduleDir, "terraform.tfstate"), "utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const outputs = parsed.outputs;
  if (!isRecord(outputs) || Object.keys(outputs).length === 0) {
    return undefined;
  }
  return outputs;
}

async function runCommand(
  command: readonly string[],
  options: { readonly cwd: string; readonly context?: CommandContext },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let timedOut = false;
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.context?.env ?? baseCommandEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.context?.timeoutMs;
  const exit =
    timeoutMs && timeoutMs > 0
      ? Promise.race([
          subprocess.exited,
          new Promise<number>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              subprocess.kill();
              resolve(124);
            }, timeoutMs);
          }),
        ])
      : subprocess.exited;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    exit,
  ]);
  if (timeout) clearTimeout(timeout);
  return {
    exitCode,
    stdout,
    stderr: timedOut
      ? [stderr, `command timed out after ${timeoutMs}ms: ${command[0]}`]
          .filter(Boolean)
          .join("\n")
      : stderr,
  };
}

function commandFailurePayload(
  runId: string,
  action: OpenTofuRunAction,
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  context?: CommandContext,
): JsonRecord {
  return {
    runId,
    action,
    status: "failed",
    exitCode: result.exitCode,
    stdout: redactRunnerOutput(result.stdout, context?.redactionValues),
    stderr: redactRunnerOutput(result.stderr, context?.redactionValues),
  };
}

function parseOperation(request: unknown): OpenTofuOperation {
  const planRun = recordField(request, "planRun");
  const operation = planRun ? recordField(planRun, "operation") : undefined;
  return operation === "destroy" ||
    operation === "update" ||
    operation === "create"
    ? operation
    : "create";
}

function parseSource(request: unknown): OpenTofuModuleSource {
  const planRun = recordField(request, "planRun");
  const source = recordField(planRun, "source");
  if (!isRecord(source)) throw new Error("planRun.source is required");
  const modulePath = stringField(source, "modulePath");
  const kind = stringField(source, "kind");
  if (kind === "git") {
    return {
      kind,
      url: requiredStringField(source, "url"),
      ...(stringField(source, "ref")
        ? { ref: stringField(source, "ref") }
        : {}),
      ...(stringField(source, "commit")
        ? { commit: stringField(source, "commit") }
        : {}),
      ...(modulePath ? { modulePath } : {}),
    };
  }
  if (kind === "prepared") {
    return {
      kind,
      url: requiredStringField(source, "url"),
      digest: requiredStringField(source, "digest"),
      ...(modulePath ? { modulePath } : {}),
    };
  }
  if (kind === "local") {
    return {
      kind,
      path: requiredStringField(source, "path"),
      ...(modulePath ? { modulePath } : {}),
    };
  }
  throw new Error("planRun.source.kind must be git, prepared, or local");
}

export function parseGeneratedRoot(
  request: unknown,
): GeneratedRoot | undefined {
  const generated = recordField(request, "generatedRoot");
  if (!isRecord(generated)) return undefined;
  const files = recordField(generated, "files");
  if (!isRecord(files)) {
    throw new Error("generatedRoot.files must be an object");
  }
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    assertGeneratedRootFileName(name);
    if (typeof content !== "string") {
      throw new Error(`generatedRoot.files[${name}] must be a string`);
    }
    out[name] = content;
  }
  if (Object.keys(out).length === 0) {
    throw new Error("generatedRoot.files must not be empty");
  }
  const moduleFilesValue = recordField(generated, "moduleFiles");
  const moduleFiles =
    moduleFilesValue === undefined
      ? undefined
      : parseGeneratedRootModuleFiles(moduleFilesValue);
  return {
    files: out,
    ...(moduleFiles ? { moduleFiles } : {}),
  };
}

function parseGeneratedRootModuleFiles(
  value: unknown,
): readonly GeneratedRootModuleFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("generatedRoot.moduleFiles must be a non-empty array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`generatedRoot.moduleFiles[${index}] must be an object`);
    }
    const path = stringField(entry, "path");
    const text = stringField(entry, "text");
    if (!path) {
      throw new Error(
        `generatedRoot.moduleFiles[${index}].path must be a string`,
      );
    }
    if (text === undefined) {
      throw new Error(
        `generatedRoot.moduleFiles[${index}].text must be a string`,
      );
    }
    assertSafeRelativePath(path, `generatedRoot.moduleFiles[${index}].path`);
    return { path, text };
  });
}

export function parseBuild(request: unknown): BuildSpec | undefined {
  const build = recordField(request, "build");
  if (!isRecord(build)) return undefined;
  if (stringField(build, "runtime") !== "bun") {
    throw new Error("build.runtime must be 'bun'");
  }
  const commands = stringArray(recordField(build, "commands"));
  if (commands.length === 0) {
    throw new Error("build.commands must be a non-empty string array");
  }
  const artifactPath = requiredStringField(build, "artifactPath");
  assertSafeRelativePath(artifactPath, "build.artifactPath");
  return { runtime: "bun", commands, artifactPath };
}

function parseBackup(request: unknown): BackupSpec {
  const backup = recordField(request, "backup");
  if (!isRecord(backup)) {
    throw new Error("backup request requires backup object");
  }
  const mode = stringField(backup, "mode");
  if (mode !== "provider_snapshot" && mode !== "custom_command") {
    throw new Error("backup.mode must be provider_snapshot or custom_command");
  }
  const outputPath = requiredStringField(backup, "outputPath");
  const provider = stringField(backup, "provider")?.trim();
  const commands = stringArray(recordField(backup, "command"));
  if (mode === "custom_command" && commands.length === 0) {
    throw new Error("custom_command backup requires BackupConfig.command");
  }
  return {
    mode,
    outputPath,
    ...(provider ? { provider } : {}),
    ...(commands.length > 0 ? { command: commands } : {}),
  };
}

function parseBackupArtifactPointer(stdout: string): JsonRecord | undefined {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed)) continue;
      const ref =
        stringField(parsed, "ref") ??
        stringField(parsed, "objectKey") ??
        stringField(parsed, "artifactKey") ??
        stringField(parsed, "key");
      if (!ref || !isSafeBackupArtifactRef(ref)) continue;
      const pointer: JsonRecord = { ref };
      const digest = stringField(parsed, "digest");
      if (digest) pointer.digest = digest;
      const sizeBytes = recordField(parsed, "sizeBytes");
      if (
        typeof sizeBytes === "number" &&
        Number.isInteger(sizeBytes) &&
        sizeBytes >= 0
      ) {
        pointer.sizeBytes = sizeBytes;
      }
      const contentType = stringField(parsed, "contentType");
      if (contentType) pointer.contentType = contentType;
      const metadata = recordField(parsed, "metadata");
      if (isRecord(metadata)) pointer.metadata = metadata;
      return pointer;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isSafeBackupArtifactRef(ref: string): boolean {
  if (ref.length === 0 || ref.includes("\0")) return false;
  if (/^https?:\/\//i.test(ref)) return false;
  if (/^r2:\/\/[A-Za-z0-9._-]+\/[^\s]+$/u.test(ref)) return true;
  return /^[A-Za-z0-9._/@:+-]+$/u.test(ref) && !ref.includes("..");
}

function assertGeneratedRootFileName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".." ||
    isAbsolute(name)
  ) {
    throw new Error(`generatedRoot.files key is not a safe filename: ${name}`);
  }
}

function assertSafeRelativePath(path: string, label: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\0") ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw new Error(`${label} must be a relative path inside the source root`);
  }
  const normalized = normalize(path).replaceAll("\\", "/");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`${label} must not escape the source root`);
  }
}

function parseRunnerProfile(request: unknown): JsonRecord | undefined {
  return recordField(request, "runnerProfile") as JsonRecord | undefined;
}

function parseRequiredProviders(request: unknown): readonly string[] {
  const planRun = recordField(request, "planRun");
  const providers = planRun
    ? recordField(planRun, "requiredProviders")
    : undefined;
  return stringArray(providers);
}

function parseProviderInstallationPolicy(
  request: unknown,
): { readonly requireMirror: boolean } | undefined {
  const policy = recordField(request, "providerInstallationPolicy");
  return isRecord(policy) && recordField(policy, "requireMirror") === true
    ? { requireMirror: true }
    : undefined;
}

export function commandContextFromRequest(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
): CommandContext {
  const env = baseCommandEnv();
  const requiredProviders = parseRequiredProviders(request);
  const payloadCredentials = credentialsFromRequest(request);
  const credentialFiles = providerCredentialFilesFromRequest(request);
  const redactionValues = redactionValuesFromRequestCredentials(request);
  const maxRunSeconds = maxRunSecondsFromProfile(runnerProfile);
  const maxSourceArchiveBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceArchiveBytes",
  );
  const maxSourceDecompressedBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceDecompressedBytes",
  );
  // §13 per-alias credential split uses `TF_VAR_…` env. Declared-env arbitrary
  // providers use their real provider env names (e.g. SNOWFLAKE_PASSWORD). Both
  // arrive ONLY via dispatched credentials (the Vault mints them per resolved
  // Connection — never from Bun.env, never from the runner profile env map). The
  // values are never logged and never echoed in the run response.
  for (const [name, value] of Object.entries(payloadCredentials)) {
    if (name.startsWith("TF_VAR_")) {
      env[name] = value;
      continue;
    }
    if (isAdmittedDeclaredProviderEnvName(name)) {
      env[name] = value;
    }
  }
  return {
    env,
    ...(credentialFiles.length > 0 ? { credentialFiles } : {}),
    ...(redactionValues.length > 0 ? { redactionValues } : {}),
    ...(maxRunSeconds ? { timeoutMs: maxRunSeconds * 1000 } : {}),
    ...(maxSourceArchiveBytes
      ? { sourceArchiveMaxBytes: maxSourceArchiveBytes }
      : {}),
    ...(maxSourceDecompressedBytes
      ? { sourceArchiveMaxDecompressedBytes: maxSourceDecompressedBytes }
      : {}),
  };
}

export function assertRunnerPolicyForRequest(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
): void {
  assertRunnerPolicyBeforeInit(
    request,
    runnerProfile,
    commandContextFromRequest(request, runnerProfile),
  );
}

/**
 * Extracts the minted credential env map from the dispatch payload's
 * `credentials` field. §13 per-alias tofu variables (`TF_VAR_...`) are admitted
 * for built-in root-only provider args. Declared-env provider variables are
 * admitted under their real env names after rejecting runner/runtime reserved
 * names. They are read only from the dispatched credential payload, never from
 * ambient process env, so built-in provider names such as CLOUDFLARE_API_TOKEN
 * can still be used by explicit generic-env ProviderConnections.
 */
function credentialsFromRequest(request: unknown): Record<string, string> {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return {};
  const rawEnv = recordField(credentials, "env");
  if (isRecord(rawEnv)) {
    return credentialsFromRecord(rawEnv);
  }
  return credentialsFromRecord(credentials);
}

function credentialsFromRecord(
  credentials: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(credentials)) {
    if (typeof value !== "string") continue;
    if (/^TF_VAR_[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      out[name] = value;
      continue;
    }
    if (isAdmittedDeclaredProviderEnvName(name)) {
      out[name] = value;
    }
  }
  return out;
}

function providerCredentialFilesFromRequest(
  request: unknown,
): readonly ProviderCredentialFile[] {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return [];
  const files = recordField(credentials, "files");
  if (!Array.isArray(files)) return [];
  return files.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("provider credential file is malformed");
    }
    const path = stringField(entry, "path");
    const content = entry.content;
    const mode = entry.mode;
    const envName = stringField(entry, "envName");
    if (
      typeof path !== "string" ||
      typeof content !== "string" ||
      typeof mode !== "number"
    ) {
      throw new Error("provider credential file is malformed");
    }
    assertSafeCredentialFileName(path);
    assertSafeCredentialFileMode(mode);
    if (envName !== undefined && !isAdmittedDeclaredProviderEnvName(envName)) {
      throw new Error(
        `provider credential file env name is unsafe: ${envName}`,
      );
    }
    return {
      path,
      content,
      mode: Math.floor(mode),
      ...(envName ? { envName } : {}),
    };
  });
}

function isAdmittedDeclaredProviderEnvName(name: string): boolean {
  return isProviderEnvName(name) && !isReservedProviderEnvName(name);
}

function redactionValuesFromRequest(request: unknown): string[] {
  return [
    ...redactionValuesFromRequestCredentials(request),
    ...sourceCredentialRedactionValuesFromRequest(request),
  ];
}

function redactionValuesFromRequestCredentials(request: unknown): string[] {
  return [
    ...Object.values(credentialsFromRequest(request)),
    ...providerCredentialFilesFromRequest(request).map((file) => file.content),
  ];
}

function sourceCredentialRedactionValues(
  credentials: SourceCredentials,
): string[] {
  return [
    ...Object.values(credentials.env),
    ...credentials.files.map((file) => file.content),
  ];
}

function sourceCredentialRedactionValuesFromRequest(
  request: unknown,
): string[] {
  try {
    return sourceCredentialRedactionValues(parseSourceCredentials(request));
  } catch {
    return [];
  }
}

interface PreparedProviderCredentialFiles {
  readonly context: CommandContext;
  readonly cleanup: () => Promise<void>;
}

async function prepareProviderCredentialFiles(
  context: CommandContext,
  workspace: RunWorkspace,
): Promise<PreparedProviderCredentialFiles> {
  const files = context.credentialFiles ?? [];
  if (files.length === 0) {
    return { context, cleanup: async () => {} };
  }
  const credentialDir = join(workspace.root, ".provider-credentials");
  await mkdir(credentialDir, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = { ...context.env };
  for (const file of files) {
    assertSafeCredentialFileName(file.path);
    assertSafeCredentialFileMode(file.mode);
    const target = join(credentialDir, file.path);
    await writeFile(target, file.content, { mode: file.mode });
    await chmod(target, file.mode);
    if (file.envName) {
      if (!isAdmittedDeclaredProviderEnvName(file.envName)) {
        throw new Error(
          `provider credential file env name is unsafe: ${file.envName}`,
        );
      }
      env[file.envName] = target;
    }
  }
  return {
    context: { ...context, env },
    cleanup: async () => {
      await shredCredentialDir(credentialDir);
    },
  };
}

function baseCommandEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    TF_INPUT: "0",
    TF_IN_AUTOMATION: "1",
  };
  for (const name of BASE_COMMAND_ENV_NAMES) {
    const value = Bun.env[name];
    if (typeof value === "string") env[name] = value;
  }
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return env;
}

/** Every credential env name any known provider may supply. */
function allKnownCredentialEnvNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const rule of PROVIDER_CREDENTIAL_ENV_RULES) {
    for (const name of rule.envNames) names.add(name);
  }
  return names;
}

/**
 * Builds the env for the BUILD phase. The build phase runs user-supplied
 * commands against the user source checkout and MUST NOT see any cloud
 * credential: it is the only phase that runs untrusted commands, and it runs
 * BEFORE the credentialed tofu phases. We start from {@link baseCommandEnv}
 * (which carries only PATH/HOME/TLS-CA/TF_CLI_CONFIG_FILE etc., never
 * credentials) and additionally assert that no known credential env name leaked
 * in. The minted payload credentials live only on the dispatch payload and are
 * never written into the process env, so they cannot reach here regardless.
 */
export function buildPhaseEnv(): Record<string, string> {
  const env = baseCommandEnv();
  const credentialNames = allKnownCredentialEnvNames();
  for (const name of Object.keys(env)) {
    if (credentialNames.has(name)) {
      // baseCommandEnv never includes these; this is defense-in-depth so a
      // future edit to BASE_COMMAND_ENV_NAMES can never silently leak a
      // credential into untrusted build commands.
      delete env[name];
    }
  }
  return env;
}

function assertBuildEnvHasNoCredentials(
  env: Readonly<Record<string, string>>,
): void {
  const credentialNames = allKnownCredentialEnvNames();
  for (const name of Object.keys(env)) {
    if (credentialNames.has(name)) {
      throw new Error(
        `build phase env unexpectedly carries credential env name ${name}`,
      );
    }
  }
}

interface RunnerPolicyBeforeInitOptions {
  readonly allowProviderFreeGeneratedRoot?: boolean;
}

function assertRunnerPolicyBeforeInit(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
  context: CommandContext,
  options: RunnerPolicyBeforeInitOptions = {},
): void {
  if (!runnerProfile) return;
  const source = parseSource(request);
  if (
    source.kind === "local" &&
    recordField(
      recordField(runnerProfile, "sourcePolicy"),
      "allowLocalSource",
    ) !== true
  ) {
    throw new Error(
      `runner profile ${stringField(runnerProfile, "id") ?? "<unknown>"} does not allow local source paths`,
    );
  }
  const requiredProviders = parseRequiredProviders(request);
  const allowedProviders = stringArray(
    recordField(runnerProfile, "allowedProviders"),
  );
  const deniedProviders = stringArray(
    recordField(runnerProfile, "deniedProviders"),
  );
  if (
    allowedProviders.length > 0 &&
    requiredProviders.length === 0 &&
    options.allowProviderFreeGeneratedRoot !== true
  ) {
    throw new Error(
      `runner profile ${stringField(runnerProfile, "id") ?? "<unknown>"} requires requiredProviders before OpenTofu init`,
    );
  }
  for (const provider of requiredProviders) {
    if (deniedProviders.some((denied) => providerMatches(provider, denied))) {
      throw new Error(`provider ${provider} is denied before OpenTofu init`);
    }
    if (
      allowedProviders.length > 0 &&
      !allowedProviders.some(
        (allowed) => allowed === "*" || providerMatches(provider, allowed),
      )
    ) {
      throw new Error(
        `provider ${provider} is not allowed before OpenTofu init`,
      );
    }
  }
  assertCredentialEnvAvailable(requiredProviders, runnerProfile, context.env);
}

async function generatedRootTreeHasNoProviderUsage(
  rootDir: string,
): Promise<boolean> {
  let files = 0;
  let totalBytes = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".terraform" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".tf")) continue;
      files += 1;
      if (files > CAPSULE_COMPATIBILITY_MAX_FILES) return false;
      const info = await stat(path);
      if (info.size > CAPSULE_COMPATIBILITY_MAX_FILE_BYTES) return false;
      totalBytes += info.size;
      if (totalBytes > CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES) return false;
      const text = await readFile(path, "utf8");
      if (hasProviderUsageBeforeInit(text)) return false;
    }
  }
  return files > 0;
}

function hasProviderUsageBeforeInit(text: string): boolean {
  const normalized = text.replace(/\brequired_providers\s*\{\s*\}/gu, "");
  return /\brequired_providers\b|\bprovider\s+"|\bresource\s+"|\bdata\s+"|\bbackend\s+"/u.test(
    normalized,
  );
}

function assertCredentialEnvAvailable(
  requiredProviders: readonly string[],
  runnerProfile: JsonRecord,
  env: Readonly<Record<string, string>>,
): void {
  const requireCredentialRefs =
    recordField(runnerProfile, "requireCredentialRefs") === true;
  const credentialRefs = credentialRefsFromRunnerProfile(runnerProfile);
  for (const provider of requiredProviders) {
    const refs = credentialRefs.filter((ref) =>
      providerMatches(provider, ref.provider),
    );
    const requiredRefs = refs.filter(
      (ref) => ref.required || requireCredentialRefs,
    );
    if (requiredRefs.length === 0) continue;
    const envNames = credentialEnvNamesForProviderAndRefs(provider, refs);
    if (envNames.length === 0) {
      throw new Error(
        `no runner env mapping is configured for provider ${provider}`,
      );
    }
    const rule = providerEnvRule(provider);
    if (rule && rootOnlyCredentialEnvAvailable(provider, rule, env)) continue;
    const requiredGroups = envRequiredGroupsForRefs(rule, refs);
    const hasRequiredGroup =
      requiredGroups.length === 0
        ? envNames.some((envName) => env[envName])
        : requiredGroups.some((group) =>
            group.every((envName) => env[envName]),
          );
    if (!hasRequiredGroup) {
      throw new Error(
        `required credential env for provider ${provider} is not available in runner environment`,
      );
    }
  }
}

function rootOnlyCredentialEnvAvailable(
  provider: string,
  rule: ProviderCredentialEnvRule,
  env: Readonly<Record<string, string>>,
): boolean {
  const requiredGroups =
    rule.requiredGroups.length > 0
      ? rule.requiredGroups
      : rule.envNames.map((name) => [name]);
  return requiredGroups.some((group) =>
    rootOnlyCredentialGroupAvailable(provider, group, env),
  );
}

function rootOnlyCredentialGroupAvailable(
  provider: string,
  envNames: readonly string[],
  env: Readonly<Record<string, string>>,
): boolean {
  const argMap = providerCredentialArgs(provider);
  if (argMap.length === 0) {
    return envNames.every((name) => env[`TF_VAR_${name}`]);
  }
  const aliasSets = envNames.map((name) =>
    rootOnlyAliasesForProviderEnv(provider, name, env),
  );
  if (aliasSets.some((aliases) => aliases.size === 0)) return false;
  const [first, ...rest] = aliasSets;
  for (const alias of first ?? []) {
    if (rest.every((aliases) => aliases.has(alias))) return true;
  }
  return false;
}

function rootOnlyAliasesForProviderEnv(
  provider: string,
  envName: string,
  env: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const localProvider = providerLocalName(provider);
  const aliases = new Set<string>();
  for (const { envName: mappedEnvName, arg } of providerCredentialArgs(
    provider,
  )) {
    if (mappedEnvName !== envName) continue;
    const prefix = `TF_VAR_${localProvider}_`;
    const suffix = `_${arg}`;
    for (const name of Object.keys(env)) {
      if (!name.startsWith(prefix)) continue;
      if (name === `TF_VAR_${localProvider}_${arg}`) {
        aliases.add("");
        continue;
      }
      if (!name.endsWith(suffix)) continue;
      const alias = name.slice(prefix.length, -suffix.length);
      if (/^[A-Za-z0-9_]+$/.test(alias)) aliases.add(alias);
    }
  }
  return aliases;
}

function providerLocalName(provider: string): string {
  return (
    providerEnvRule(provider)?.shortName ??
    provider.split("/").pop() ??
    provider
  );
}

function credentialRefsFromRunnerProfile(
  runnerProfile: JsonRecord | undefined,
): readonly {
  readonly provider: string;
  readonly ref: string;
  readonly required: boolean;
}[] {
  const refs = recordField(runnerProfile, "credentialRefs");
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((value) => {
    if (!isRecord(value)) return [];
    const provider = stringField(value, "provider");
    const ref = stringField(value, "ref");
    if (!provider || !ref) return [];
    return [
      { provider, ref, required: recordField(value, "required") === true },
    ];
  });
}

function credentialEnvNamesForProviderAndRefs(
  provider: string,
  refs: readonly { readonly ref: string }[],
): readonly string[] {
  const names = new Set<string>(providerEnvRule(provider)?.envNames ?? []);
  for (const ref of refs) {
    for (const name of envNamesFromCredentialRef(ref.ref)) names.add(name);
  }
  return Array.from(names).sort();
}

function envRequiredGroupsForRefs(
  rule: ProviderCredentialEnvRule | undefined,
  refs: readonly { readonly ref: string }[],
): readonly (readonly string[])[] {
  const groups: (readonly string[])[] = [...(rule?.requiredGroups ?? [])];
  for (const ref of refs) {
    const names = envNamesFromCredentialRef(ref.ref);
    if (names.length > 0) groups.push(names);
  }
  return groups;
}

function envNamesFromCredentialRef(ref: string): readonly string[] {
  if (!ref.startsWith("env://")) return [];
  return ref
    .slice("env://".length)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Z_][A-Z0-9_]*$/.test(value));
}

function maxRunSecondsFromProfile(
  runnerProfile: JsonRecord | undefined,
): number | undefined {
  return positiveIntegerLimitFromProfile(runnerProfile, "maxRunSeconds");
}

function positiveIntegerLimitFromProfile(
  runnerProfile: JsonRecord | undefined,
  key: string,
): number | undefined {
  const limits = recordField(runnerProfile, "resourceLimits");
  if (!limits) return undefined;
  const value = recordField(limits, key);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function parsePlanArtifact(request: unknown): { readonly digest: string } {
  const artifact = recordField(request, "planArtifact");
  if (!isRecord(artifact)) throw new Error("planArtifact is required");
  return { digest: requiredStringField(artifact, "digest") };
}

async function verifyPlanArtifact(
  planPath: string,
  artifact: { readonly digest: string },
): Promise<void> {
  const bytes = await readFile(planPath);
  const digest = await digestBytes(bytes);
  if (digest !== artifact.digest) {
    throw new Error(`plan artifact digest mismatch: ${digest}`);
  }
}

function providersFromPlanJson(planJson: string): readonly string[] {
  const parsed = JSON.parse(planJson) as JsonRecord;
  const providers = new Set<string>();
  collectProviderFullNames(parsed, providers);
  return Array.from(providers).sort();
}

function normalizedProviderList(
  providers: readonly string[],
): readonly string[] {
  return Array.from(new Set(providers.map(canonicalProviderAddress))).sort();
}

async function providerInstallationEvidence(
  moduleDir: string,
  providers: readonly string[],
  attestation?: StrictProviderMirrorAttestation,
): Promise<
  readonly {
    readonly provider: string;
    readonly mirrored: boolean;
    readonly installationMethod: "filesystem_mirror" | "direct" | "unknown";
    readonly mirrorPath?: string;
    readonly attested?: boolean;
    readonly attestationMethod?: "forced_filesystem_mirror_init";
    readonly cliConfigDigest?: string;
    readonly installedPath?: string;
    readonly installedDigest?: string;
  }[]
> {
  const mirrorRoot =
    Bun.env.OPENTOFU_PROVIDER_MIRROR ?? DEFAULT_PROVIDER_MIRROR_PATH;
  const attestedProviders = new Set(attestation?.providers ?? []);
  const rows = await Promise.all(
    providers.map(async (provider) => {
      const canonical = canonicalProviderAddress(provider);
      const mirrorPath = join(mirrorRoot, ...canonical.split("/"));
      const installedPath = join(
        moduleDir,
        ".terraform",
        "providers",
        ...canonical.split("/"),
      );
      const mirrored = await pathExists(mirrorPath);
      const installedDigest = await digestPathIfExists(installedPath);
      const attested = mirrored && attestedProviders.has(canonical);
      return {
        provider: canonical,
        mirrored,
        installationMethod: mirrored ? "filesystem_mirror" : "direct",
        mirrorPath,
        ...(installedDigest ? { installedDigest } : {}),
        ...(attested
          ? {
              attested: true,
              attestationMethod: "forced_filesystem_mirror_init" as const,
              installedPath,
              ...(attestation
                ? { cliConfigDigest: attestation.cliConfigDigest }
                : {}),
            }
          : {}),
      } as const;
    }),
  );
  return rows.sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
}

interface StrictProviderMirrorAttestation {
  readonly providers: readonly string[];
  readonly cliConfigPath: string;
  readonly cliConfigDigest: string;
}

async function prepareStrictProviderMirrorInit(
  workspace: RunWorkspace,
  context: CommandContext,
  providers: readonly string[],
  policy: { readonly requireMirror: boolean } | undefined,
): Promise<
  | {
      readonly commandContext: CommandContext;
      readonly attestation: StrictProviderMirrorAttestation;
    }
  | undefined
> {
  if (policy?.requireMirror !== true) return undefined;
  const canonicalProviders = normalizedProviderList(providers);
  if (canonicalProviders.length === 0) return undefined;
  const mirrorRoot =
    Bun.env.OPENTOFU_PROVIDER_MIRROR ?? DEFAULT_PROVIDER_MIRROR_PATH;
  const content = strictProviderMirrorCliConfig(canonicalProviders, mirrorRoot);
  const cliConfigPath = join(workspace.root, "takosumi.strict-tofu.rc");
  await mkdir(workspace.root, { recursive: true });
  await writeFile(cliConfigPath, content, { mode: 0o600 });
  const cliConfigDigest = await digestBytes(new TextEncoder().encode(content));
  return {
    commandContext: {
      ...context,
      env: {
        ...context.env,
        TF_CLI_CONFIG_FILE: cliConfigPath,
      },
    },
    attestation: {
      providers: canonicalProviders,
      cliConfigPath,
      cliConfigDigest,
    },
  };
}

function strictProviderMirrorCliConfig(
  providers: readonly string[],
  mirrorRoot: string,
): string {
  const providerLines = providers
    .map((provider) => `      ${JSON.stringify(provider)}`)
    .join(",\n");
  return `provider_installation {
  filesystem_mirror {
    path = ${JSON.stringify(mirrorRoot)}
    include = [
${providerLines}
    ]
  }

  direct {
    exclude = ["*/*"]
  }
}
`;
}

function canonicalProviderAddress(provider: string): string {
  const segments = provider.split("/").filter((part) => part.length > 0);
  if (segments.length === 2) return `registry.opentofu.org/${provider}`;
  return provider;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function digestPathIfExists(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  return await digestPath(path, path);
}

async function digestPath(path: string, root: string): Promise<string> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return await digestBytes(await readFile(path));
  }
  const entries = await readdir(path, { withFileTypes: true });
  const childDigests: Array<{ path: string; digest: string }> = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = join(path, entry.name);
    if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    childDigests.push({
      path: child.slice(root.length + 1),
      digest: await digestPath(child, root),
    });
  }
  return await digestBytes(
    new TextEncoder().encode(JSON.stringify(childDigests)),
  );
}

function collectProviderFullNames(
  value: unknown,
  providers: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProviderFullNames(item, providers);
    return;
  }
  if (!isRecord(value)) return;
  const fullName = value.full_name;
  if (typeof fullName === "string" && fullName.includes("/")) {
    providers.add(fullName);
  }
  for (const child of Object.values(value))
    collectProviderFullNames(child, providers);
}

function summaryFromPlanJson(planJson: string): {
  readonly add: number;
  readonly change: number;
  readonly destroy: number;
} {
  const parsed = JSON.parse(planJson) as {
    readonly resource_changes?: unknown;
  };
  let add = 0;
  let change = 0;
  let destroy = 0;
  if (Array.isArray(parsed.resource_changes)) {
    for (const changeRecord of parsed.resource_changes) {
      const actions = recordField(
        recordField(changeRecord, "change"),
        "actions",
      );
      if (!Array.isArray(actions)) continue;
      if (actions.includes("create")) add++;
      if (actions.includes("update")) change++;
      if (actions.includes("delete")) destroy++;
    }
  }
  return { add, change, destroy };
}

// Trimmed per-resource change list (address/type/actions only) extracted from
// `tofu show -json tfplan`. Used by the plan-JSON policy on the service side.
export function resourceChangesFromPlanJson(planJson: string): Array<{
  address: string;
  type: string;
  actions: string[];
  scope?: {
    cloudflareAccountId?: string;
    cloudflareZoneId?: string;
    awsAccountId?: string;
    awsRegion?: string;
  };
}> {
  const parsed = JSON.parse(planJson) as {
    readonly resource_changes?: unknown;
  };
  const out: Array<{
    address: string;
    type: string;
    actions: string[];
    scope?: {
      cloudflareAccountId?: string;
      cloudflareZoneId?: string;
      awsAccountId?: string;
      awsRegion?: string;
    };
  }> = [];
  if (!Array.isArray(parsed.resource_changes)) return out;
  for (const changeRecord of parsed.resource_changes) {
    const address = stringField(changeRecord, "address");
    const type = stringField(changeRecord, "type");
    const change = recordField(changeRecord, "change");
    const actions = recordField(change, "actions");
    if (!address || !type || !Array.isArray(actions)) continue;
    const resourceChange = {
      address,
      type,
      actions: actions.filter(
        (action): action is string => typeof action === "string",
      ),
      ...scopeProjectionForPlanResource(type, change),
    };
    out.push(resourceChange);
  }
  return out;
}

function scopeProjectionForPlanResource(
  type: string,
  change: unknown,
): {
  scope?: {
    cloudflareAccountId?: string;
    cloudflareZoneId?: string;
    awsAccountId?: string;
    awsRegion?: string;
  };
} {
  const after = recordField(change, "after");
  const before = recordField(change, "before");
  const source = after ?? before;
  if (!source) return {};
  const scope: {
    cloudflareAccountId?: string;
    cloudflareZoneId?: string;
    awsAccountId?: string;
    awsRegion?: string;
  } = {};
  if (type.startsWith("cloudflare_")) {
    const accountId =
      stringField(source, "account_id") ?? stringField(source, "accountId");
    const zoneId =
      stringField(source, "zone_id") ?? stringField(source, "zoneId");
    if (accountId) scope.cloudflareAccountId = accountId;
    if (zoneId) scope.cloudflareZoneId = zoneId;
  }
  if (type.startsWith("aws_")) {
    const accountId =
      stringField(source, "account_id") ??
      stringField(source, "accountId") ??
      stringField(source, "owner_id");
    const region = stringField(source, "region");
    if (accountId) scope.awsAccountId = accountId;
    if (region) scope.awsRegion = region;
  }
  return Object.keys(scope).length > 0 ? { scope } : {};
}

async function gitRevParseHead(
  cwd: string,
  context: CommandContext,
): Promise<string | undefined> {
  const result = await runCommand(["git", "rev-parse", "HEAD"], {
    cwd,
    context,
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function digestFileIfExists(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  return await digestBytes(await readFile(path));
}

function resolveModulePath(
  sourceRoot: string,
  modulePath: string | undefined,
): string {
  const moduleDir = resolve(sourceRoot, modulePath ?? ".");
  const normalizedRoot = resolve(sourceRoot);
  if (
    moduleDir !== normalizedRoot &&
    !moduleDir.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error("source.modulePath must stay inside source root");
  }
  return moduleDir;
}

function assertPathInsideRoot(root: string, path: string, label: string): void {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (
    normalizedPath !== normalizedRoot &&
    !normalizedPath.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error(`${label} must stay inside source root`);
  }
}

export function safeRunId(runId: string): string {
  const sanitized = runId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  // Defense-in-depth: the charset above permits `.`, so a runId that is exactly
  // `.`/`..` or contains a `..` path segment could let the workspace path escape
  // its RUN_ROOT jail. Neutralize any dot-only path segment so `join(RUN_ROOT, …)`
  // can never resolve outside the jail.
  const guarded = sanitized
    .split("/")
    .map((segment) => (segment === "." || segment === ".." ? "_" : segment))
    .join("/");
  return guarded === "." || guarded === ".." ? "_" : guarded;
}

function recordField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function providerMatches(provider: string, rule: string): boolean {
  return provider === rule || provider.endsWith(`/${rule}`);
}

function stringField(value: unknown, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function requiredStringField(value: unknown, key: string): string {
  const field = stringField(value, key);
  if (!field) throw new Error(`${key} is required`);
  return field;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

async function assertRealPathInsideSourceRoot(
  path: string,
  sourceRoot: string,
  label: string,
): Promise<void> {
  const [realTarget, realRoot] = await Promise.all([
    realpath(path),
    realpath(sourceRoot),
  ]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new Error(
      `${label} must stay inside source root after symlink resolution`,
    );
  }
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("request body must be a JSON object");
}

function parseAction(value: unknown): OpenTofuRunAction | undefined {
  if (
    value === "plan" ||
    value === "apply" ||
    value === "destroy" ||
    value === "compatibility_check" ||
    value === "backup"
  ) {
    return value;
  }
  return undefined;
}

async function digestBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    arrayBufferFromBytes(data),
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
