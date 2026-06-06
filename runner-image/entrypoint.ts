import {
  chmod,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
// Shared provider -> credential env-name table. This module is dependency-free
// and is copied into the runner container image alongside this file so the
// relative import resolves at container runtime (see runner-image/Dockerfile).
import {
  PROVIDER_CREDENTIAL_ENV_RULES,
  type ProviderCredentialEnvRule,
  providerEnvRule,
} from "../packages/schema/src/provider-env-rules.ts";

type OpenTofuRunAction = "plan" | "apply" | "destroy";
type OpenTofuOperation = "create" | "update" | "destroy";
type JsonRecord = Record<string, unknown>;

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
  // Template-path (Phase 1C) workspace dirs. `generatedRootDir` is where tofu
  // runs for a template-based run (it holds the generated root module + the
  // copied template-module); `artifactDir` receives the build artifact.
  readonly generatedRootDir: string;
  readonly templateModuleDir: string;
  readonly artifactDir: string;
}

/** Optional baked official-template reference on the dispatch payload. */
interface TemplateRef {
  readonly id: string;
  readonly version: string;
  /** Absolute path INSIDE the runner image, e.g. /app/templates/<id>/module. */
  readonly localModulePath: string;
}

/** Generated root module HCL files (filename -> content). */
interface GeneratedRoot {
  readonly files: Record<string, string>;
}

/** Optional credential-free build phase that runs before plan. */
interface BuildSpec {
  readonly runtime: "bun";
  readonly commands: readonly string[];
  /** File/dir relative to the source root; copied to /work/artifact. */
  readonly artifactPath: string;
}

export interface CommandContext {
  readonly env: Record<string, string>;
  readonly timeoutMs?: number;
  readonly sourceArchiveMaxBytes?: number;
  readonly sourceArchiveMaxDecompressedBytes?: number;
}

const port = Number(Bun.env.PORT ?? "8080");
const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";
const TFVARS_FILENAME = "takosumi.auto.tfvars.json";
const DEFAULT_PREPARED_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_PREPARED_SOURCE_MAX_DECOMPRESSED_BYTES = 10 *
  DEFAULT_PREPARED_SOURCE_MAX_BYTES;
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
async function handleRunnerRequest(request: Request): Promise<Response> {
  {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" || url.pathname === "/container/health") {
      return Response.json({ ok: true, runner: "opentofu" });
    }
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    const artifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfplan$/.exec(
      url.pathname,
    );
    const planJsonArtifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfplan-json$/
      .exec(url.pathname);
    const stateArtifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfstate$/.exec(
      url.pathname,
    );
    const sourceArchiveArtifactMatch =
      /^\/runs\/([^/]+)\/artifacts\/source-archive$/.exec(url.pathname);
    const sourceArchiveRestoreMatch =
      /^\/runs\/([^/]+)\/source-archive\/restore$/.exec(url.pathname);
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
            stderr: redactCredentialOutput(
              error instanceof Error ? error.message : String(error),
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
      const result = action === "plan"
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
          stderr: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  }
}

// Only bind a port when run as the container entrypoint; importing this module
// (e.g. for a unit test of commandContextFromRequest) must not start a server.
if (import.meta.main) {
  Bun.serve({ port, fetch: handleRunnerRequest });
}

async function runPlan(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const template = parseTemplate(request);
  const generatedRoot = parseGeneratedRoot(request);
  if (template || generatedRoot) {
    return await runTemplatePlan(runId, request, template, generatedRoot);
  }
  return await runRawModulePlan(runId, request);
}

async function runRawModulePlan(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const operation = parseOperation(request);
  const source = parseSource(request);
  const variables = parseVariables(request);
  const runnerProfile = parseRunnerProfile(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);
  assertRunnerPolicyBeforeInit(request, runnerProfile, commandContext);
  const workspace = await preparePlanWorkspace(
    runId,
    source,
    variables,
    commandContext,
  );
  const sourceCommit = source.kind === "git"
    ? await gitRevParseHead(workspace.sourceRoot, commandContext)
    : undefined;
  return await initPlanAndBuildResponse(runId, workspace, workspace.moduleDir, {
    operation,
    commandContext,
    extra: sourceCommit ? { sourceCommit } : {},
  });
}

// Template path (Phase 1C): the OpenTofu surface is the generated root module
// (which references the baked official template module as ./template-module).
// The user source, when present, is ONLY a BUILD input and is never the tofu
// root. Build commands run with NO credentials before any tofu phase.
async function runTemplatePlan(
  runId: string,
  request: unknown,
  template: TemplateRef | undefined,
  generatedRoot: GeneratedRoot | undefined,
): Promise<JsonRecord> {
  if (!template) throw new Error("template is required when generatedRoot is present");
  if (!generatedRoot) throw new Error("generatedRoot is required when template is present");
  const operation = parseOperation(request);
  const build = parseBuild(request);
  const runnerProfile = parseRunnerProfile(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);
  assertRunnerPolicyBeforeInit(request, runnerProfile, commandContext);

  const workspace = await prepareTemplateWorkspace(runId);
  let buildLog = "";
  let sourceCommit: string | undefined;
  if (build) {
    const buildSource = parseSource(request);
    const built = await runBuildPhase(runId, workspace, buildSource, build);
    if ("failure" in built) return built.failure;
    buildLog = built.buildLog;
    sourceCommit = built.sourceCommit;
  }

  await materializeGeneratedRoot(workspace, template, generatedRoot);
  const planContext = build
    ? withArtifactPathVar(commandContext, workspace, build)
    : commandContext;
  return await initPlanAndBuildResponse(
    runId,
    workspace,
    workspace.generatedRootDir,
    {
      operation,
      commandContext: planContext,
      buildLog,
      extra: {
        template: { id: template.id, version: template.version },
        ...(sourceCommit ? { sourceCommit } : {}),
      },
    },
  );
}

interface PlanResponseOptions {
  readonly operation: OpenTofuOperation;
  readonly commandContext: CommandContext;
  readonly buildLog?: string;
  readonly extra?: JsonRecord;
}

// Shared init+plan+show pipeline for both the raw-module and template lanes.
// `moduleDir` is the tofu root (the source module dir for raw modules, the
// generated-root dir for templates).
async function initPlanAndBuildResponse(
  runId: string,
  workspace: RunWorkspace,
  moduleDir: string,
  options: PlanResponseOptions,
): Promise<JsonRecord> {
  const { operation, commandContext } = options;
  const init = await runCommand(["tofu", "init", "-input=false", "-no-color"], {
    cwd: moduleDir,
    context: commandContext,
  });
  if (init.exitCode !== 0) {
    return mergeBuildLog(
      commandFailurePayload(runId, "plan", init),
      options.buildLog,
    );
  }
  const plan = await runCommand([
    "tofu",
    "plan",
    ...(operation === "destroy" ? ["-destroy"] : []),
    "-input=false",
    "-no-color",
    "-out",
    workspace.planPath,
  ], { cwd: moduleDir, context: commandContext });
  if (plan.exitCode !== 0) {
    return mergeBuildLog(
      commandFailurePayload(runId, "plan", plan),
      options.buildLog,
    );
  }

  const planBytes = await readFile(workspace.planPath);
  const planDigest = await digestBytes(planBytes);
  const planJson = await readOpenTofuPlanJson(moduleDir, workspace, commandContext);
  if (planJson) await writePlanJsonArtifact(workspace, planJson);
  const providerLockDigest = await digestFileIfExists(
    join(moduleDir, ".terraform.lock.hcl"),
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
    requiredProviders: planJson ? providersFromPlanJson(planJson) : [],
    ...(planJson ? { summary: summaryFromPlanJson(planJson) } : {}),
    ...(planJson
      ? { planResourceChanges: resourceChangesFromPlanJson(planJson) }
      : {}),
    ...(providerLockDigest ? { providerLockDigest } : {}),
    ...(options.extra ?? {}),
    stdout: [options.buildLog, init.stdout, plan.stdout].filter(Boolean).join(
      "\n",
    ),
    stderr: [init.stderr, plan.stderr].filter(Boolean).join("\n"),
  };
}

function mergeBuildLog(payload: JsonRecord, buildLog: string | undefined): JsonRecord {
  if (!buildLog) return payload;
  const existing = typeof payload.stdout === "string" ? payload.stdout : "";
  return { ...payload, stdout: [buildLog, existing].filter(Boolean).join("\n") };
}

async function runReviewedPlanApply(
  runId: string,
  action: "apply" | "destroy",
  request: unknown,
): Promise<JsonRecord> {
  const template = parseTemplate(request);
  const generatedRoot = parseGeneratedRoot(request);
  const runnerProfile = parseRunnerProfile(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);
  assertRunnerPolicyBeforeInit(request, runnerProfile, commandContext);
  const planArtifact = parsePlanArtifact(request);
  await verifyPlanArtifact(workspaceForRun(runId).planPath, planArtifact);

  const moduleDir = template || generatedRoot
    ? await restoreTemplateApplyWorkspace(runId, template, generatedRoot)
    : (await prepareApplyWorkspace(runId, parseSource(request), commandContext))
      .moduleDir;

  const init = await runCommand(["tofu", "init", "-input=false", "-no-color"], {
    cwd: moduleDir,
    context: commandContext,
  });
  if (init.exitCode !== 0) {
    return commandFailurePayload(runId, action, init);
  }
  const result = await runCommand([
    "tofu",
    "apply",
    "-input=false",
    "-no-color",
    workspaceForRun(runId).planPath,
  ], { cwd: moduleDir, context: commandContext });
  const outputs = action === "apply" && result.exitCode === 0
    ? await readOpenTofuOutputsIn(moduleDir, commandContext)
    : undefined;
  return {
    runId,
    action,
    status: result.exitCode === 0 ? "succeeded" : "failed",
    exitCode: result.exitCode,
    ...(outputs ? { outputs } : {}),
    stdout: [init.stdout, result.stdout].filter(Boolean).join("\n"),
    stderr: [init.stderr, result.stderr].filter(Boolean).join("\n"),
  };
}

// For template apply the consumer resends template + generatedRoot. Restore the
// generated root the same way plan did so `tofu apply tfplan` runs against an
// identical root (the saved plan binds to this module layout).
async function restoreTemplateApplyWorkspace(
  runId: string,
  template: TemplateRef | undefined,
  generatedRoot: GeneratedRoot | undefined,
): Promise<string> {
  if (!template || !generatedRoot) {
    throw new Error("template apply requires both template and generatedRoot");
  }
  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  await materializeGeneratedRoot(workspace, template, generatedRoot);
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
  await materializeSource(source, workspace.sourceRoot, buildContext);
  const sourceCommit = source.kind === "git"
    ? await gitRevParseHead(workspace.sourceRoot, buildContext)
    : undefined;
  const logs: string[] = [];
  for (const command of build.commands) {
    const result = await runCommand(["bash", "-lc", command], {
      cwd: workspace.sourceRoot,
      context: buildContext,
    });
    logs.push(redactBuildOutput(`$ ${command}\n${result.stdout}\n${result.stderr}`));
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
  let redacted = text;
  for (const name of allKnownCredentialEnvNames()) {
    redacted = redacted.replaceAll(
      new RegExp(`(${name}=)[^\\s]+`, "g"),
      "$1[redacted]",
    );
  }
  return redacted;
}

async function preparePlanWorkspace(
  runId: string,
  source: OpenTofuModuleSource,
  variables: JsonRecord,
  context: CommandContext,
): Promise<RunWorkspace> {
  const workspace = workspaceForRun(runId);
  await rm(workspace.root, { recursive: true, force: true });
  await mkdir(workspace.root, { recursive: true });
  await materializeSource(source, workspace.sourceRoot, context);
  const moduleDir = resolveModulePath(workspace.sourceRoot, source.modulePath);
  await assertDirectory(moduleDir, "source module directory");
  await assertRealPathInsideSourceRoot(
    moduleDir,
    workspace.sourceRoot,
    "source module directory",
  );
  await writeModuleInfo(workspace, moduleDir);
  await restoreUploadedState(workspace, moduleDir);
  if (Object.keys(variables).length > 0) {
    await writeFile(
      join(moduleDir, TFVARS_FILENAME),
      `${JSON.stringify(variables, null, 2)}\n`,
    );
  }
  return { ...workspace, moduleDir };
}

async function prepareApplyWorkspace(
  runId: string,
  source: OpenTofuModuleSource,
  context: CommandContext,
): Promise<RunWorkspace> {
  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  try {
    await assertDirectory(workspace.sourceRoot, "source root");
  } catch {
    await materializeSource(source, workspace.sourceRoot, context);
  }
  const prepared = {
    ...workspace,
    moduleDir: resolveModulePath(workspace.sourceRoot, source.modulePath),
  };
  await assertDirectory(prepared.moduleDir, "source module directory");
  await assertRealPathInsideSourceRoot(
    prepared.moduleDir,
    workspace.sourceRoot,
    "source module directory",
  );
  await writeModuleInfo(prepared, prepared.moduleDir);
  await restoreUploadedState(prepared, prepared.moduleDir);
  return prepared;
}

// Fresh per-run workspace for a template plan. Wipes any previous run dir and
// records the generated-root as the state moduleDir so the DO's state artifact
// GET (which reads module-info.json) finds terraform.tfstate after apply.
async function prepareTemplateWorkspace(runId: string): Promise<RunWorkspace> {
  const workspace = workspaceForRun(runId);
  await rm(workspace.root, { recursive: true, force: true });
  await mkdir(workspace.root, { recursive: true });
  await mkdir(workspace.generatedRootDir, { recursive: true });
  await writeModuleInfo(workspace, workspace.generatedRootDir);
  return workspace;
}

// Writes the generated root module files and copies the baked official template
// module into ./template-module so the generated root's `source =
// "./template-module"` resolves. Both the generated-root files and the template
// path are validated by the parsers before reaching here.
async function materializeGeneratedRoot(
  workspace: RunWorkspace,
  template: TemplateRef,
  generatedRoot: GeneratedRoot,
): Promise<void> {
  await mkdir(workspace.generatedRootDir, { recursive: true });
  await rm(workspace.templateModuleDir, { recursive: true, force: true });
  await assertDirectory(template.localModulePath, "template module directory");
  await cp(template.localModulePath, workspace.templateModuleDir, {
    recursive: true,
  });
  for (const [name, content] of Object.entries(generatedRoot.files)) {
    await writeFile(join(workspace.generatedRootDir, name), content);
  }
  // Re-assert the state moduleDir after a restore-only path created the dir.
  await writeModuleInfo(workspace, workspace.generatedRootDir);
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
      return Response.json({ error: "plan artifact not found" }, { status: 404 });
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
    if (/[\r\n\0]/.test(url) || url.startsWith("-")) {
      throw new Error("source url contains control characters");
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("source url must be a valid https/ssh URL or git@host:path");
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
  if (/[\r\n\0]/.test(url)) {
    throw new Error("source url contains control characters");
  }
}

// The source subtree path is a relative path INSIDE the cloned repo. Reject
// absolute paths and any traversal so a job can only ever archive a directory
// that lives under the checkout.
function normalizeSourceSubtreePath(path: string): string {
  if (path === "" || path === ".") return ".";
  if (
    isAbsolute(path) ||
    path.includes("\0") ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw new Error(`source_sync.source.path is not a safe relative path: ${path}`);
  }
  const normalized = normalize(path).replaceAll("\\", "/").replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`source_sync.source.path is not a safe relative path: ${path}`);
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
      if (typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(name)) {
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

async function runSourceSync(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const source = parseSourceSyncSource(request);
  const credentials = parseSourceCredentials(request);
  const runnerProfile = parseRunnerProfile(request);
  // archiveObjectKey may sit at the request root or alongside source; accept
  // either so the service lane can place it wherever the run record holds it.
  const archiveObjectKey = stringField(request, "archiveObjectKey") ??
    stringField(recordField(request, "source"), "archiveObjectKey");
  if (!archiveObjectKey) throw new Error("archiveObjectKey is required");
  assertSafeArchiveObjectKey(archiveObjectKey);
  const maxArchiveBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceArchiveBytes",
  ) ?? DEFAULT_SOURCE_ARCHIVE_MAX_BYTES;

  const workspace = workspaceForRun(runId);
  await rm(workspace.root, { recursive: true, force: true });
  await mkdir(workspace.root, { recursive: true });
  const credentialDir = join(workspace.root, "source-credentials");

  try {
    const gitContext = await prepareSourceGitContext(
      source,
      credentials,
      credentialDir,
    );
    const resolvedCommit = await resolveSourceCommit(source, gitContext);
    await shallowCloneAtCommit(source, resolvedCommit, workspace.sourceRoot, gitContext);
    const subtree = await resolveSourceSubtree(workspace.sourceRoot, source.path);
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

  return { context: { env } };
}

function sourceUrlScheme(url: string): "https" | "ssh" {
  const lower = url.toLowerCase();
  if (lower.startsWith("ssh://")) return "ssh";
  if (lower.startsWith("https://")) return "https";
  // scp-like git@host:path is ssh transport.
  if (/^[^@/\s]+@[^:/\s]+:.+$/.test(url) && !url.includes("://")) return "ssh";
  return "https";
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
      `git ls-remote failed: ${redactCredentialOutput(result.stderr || result.stdout)}`,
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
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
  await runRequiredCommand([
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
  ], { cwd: RUN_ROOT, context: git.context });
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
function redactCredentialOutput(text: string): string {
  let redacted = text;
  for (const name of ["GIT_HTTPS_TOKEN", "GIT_SSH_PRIVATE_KEY"]) {
    redacted = redacted.replaceAll(
      new RegExp(`(${name}=)[^\\s]+`, "g"),
      "$1[redacted]",
    );
  }
  return redacted;
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
    await runRequiredCommand([
      "tar",
      "-x",
      "--zstd",
      "-f",
      archivePath,
      "--no-same-owner",
      "--keep-old-files",
      "-C",
      workspace.sourceRoot,
    ], { cwd: RUN_ROOT, context });
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

// Same tar-slip / link-target / zip-bomb hardening as assertSafeTarArchive but
// for a zstd-compressed tar (the source_sync archive format). Reuses the shared
// per-entry validators (escape quoting, duplicate normalized paths, file/dir
// only, decompressed-size cap).
export async function assertSafeZstdTarArchive(
  archivePath: string,
  context: CommandContext,
): Promise<void> {
  const verbose = await runCommand([
    "tar",
    "-t",
    "-v",
    "--quoting-style=escape",
    "--zstd",
    "-f",
    archivePath,
  ], { cwd: RUN_ROOT, context });
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
        throw new Error(`source archive duplicates normalized path: ${entry.path}`);
      }
      seenPaths.add(normalizedPath);
    }
    if (entry.type !== "-" && entry.type !== "d") {
      throw new Error(
        `source archive contains unsupported entry type: ${entry.type}`,
      );
    }
    decompressedBytes += entry.size;
    const decompressedCap = context.sourceArchiveMaxDecompressedBytes ??
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
  if (
    path.includes("\0") ||
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw new Error(`source archive contains unsafe path: ${path}`);
  }
  const normalized = normalize(path).replaceAll("\\", "/").replace(/^\.\//, "")
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
      return Response.json({ error: "state artifact not found" }, { status: 404 });
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
    const parsed = JSON.parse(await readFile(workspace.moduleInfoPath, "utf8")) as unknown;
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
      if (source.commit) assertFullGitObjectId(source.commit, "git source commit");
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
      await runRequiredCommand([
        "tar",
        "-x",
        "-z",
        "-f",
        archivePath,
        "--no-same-owner",
        "--keep-old-files",
        "-C",
        sourceRoot,
      ], { cwd: RUN_ROOT, context });
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
  // core (packages/schema/src/reference/prepared-source-core.ts).
  const verbose = await runCommand([
    "tar",
    "-t",
    "-v",
    "--quoting-style=escape",
    "-z",
    "-f",
    archivePath,
  ], {
    cwd: RUN_ROOT,
    context,
  });
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
    const decompressedCap = context.sourceArchiveMaxDecompressedBytes ??
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
  const literal = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  // IP literals are already fully covered by assertHostLiteralNotBlocked.
  if (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(literal) || literal.includes(":")
  ) {
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
        `https://cloudflare-dns.com/dns-query?name=${
          encodeURIComponent(host)
        }&type=${type}`,
        {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) continue;
      const body = await response.json() as {
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
    throw new Error(`${label} must not start with '-' or contain control characters`);
  }
}

function assertFullGitObjectId(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} must be a full git object id`);
  }
}

function assertHostLiteralNotBlocked(host: string, label: string): void {
  const literal = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
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
      `${command[0]} failed with ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
}

async function readOpenTofuPlanJson(
  moduleDir: string,
  workspace: RunWorkspace,
  context: CommandContext,
): Promise<string | undefined> {
  const result = await runCommand([
    "tofu",
    "show",
    "-json",
    workspace.planPath,
  ], { cwd: moduleDir, context });
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
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    return undefined;
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

async function runCommand(
  command: readonly string[],
  options: { readonly cwd: string; readonly context?: CommandContext },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let timedOut = false;
  const subprocess = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.context?.env ?? baseCommandEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.context?.timeoutMs;
  const exit = timeoutMs && timeoutMs > 0
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
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
): JsonRecord {
  return {
    runId,
    action,
    status: "failed",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseOperation(request: unknown): OpenTofuOperation {
  const planRun = recordField(request, "planRun");
  const operation = planRun ? recordField(planRun, "operation") : undefined;
  return operation === "destroy" || operation === "update" || operation === "create"
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
      ...(stringField(source, "ref") ? { ref: stringField(source, "ref") } : {}),
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

function parseVariables(request: unknown): JsonRecord {
  const variables = recordField(request, "variables");
  return isRecord(variables) ? variables : {};
}

export function parseTemplate(request: unknown): TemplateRef | undefined {
  const template = recordField(request, "template");
  if (!isRecord(template)) return undefined;
  const id = requiredStringField(template, "id");
  const version = requiredStringField(template, "version");
  const localModulePath = requiredStringField(template, "localModulePath");
  assertTemplateModulePath(localModulePath);
  return { id, version, localModulePath };
}

export function parseGeneratedRoot(request: unknown): GeneratedRoot | undefined {
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
  return { files: out };
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

// The template module is baked into the image under /app/templates. Only allow
// an absolute path inside that root with no traversal so a crafted payload can
// never point the copy at, e.g., /etc or the source checkout.
const TEMPLATE_MODULE_ROOT = "/app/templates/";

function assertTemplateModulePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error("template.localModulePath must be an absolute image path");
  }
  const normalized = normalize(path);
  if (
    !normalized.startsWith(TEMPLATE_MODULE_ROOT) ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(
      `template.localModulePath must stay inside ${TEMPLATE_MODULE_ROOT}`,
    );
  }
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
  const providers = planRun ? recordField(planRun, "requiredProviders") : undefined;
  return stringArray(providers);
}

export function commandContextFromRequest(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
): CommandContext {
  const env = baseCommandEnv();
  const requiredProviders = parseRequiredProviders(request);
  const credentialRefs = credentialRefsFromRunnerProfile(runnerProfile);
  // Credentials minted by the Vault broker and threaded onto the dispatch
  // payload (Phase 1B). Read these FIRST, filtered through the same
  // provider-env-rules match the Bun.env path uses, so only env names the
  // required providers actually allow are admitted. Falls back to Bun.env when a
  // name is not supplied on the payload (e.g. local/dev runners with ambient
  // credentials). The payload credential map is NEVER echoed back (see the run
  // response builders, which return only run metadata + stdout/stderr).
  const payloadCredentials = credentialsFromRequest(request);
  const maxRunSeconds = maxRunSecondsFromProfile(runnerProfile);
  const maxSourceArchiveBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceArchiveBytes",
  );
  const maxSourceDecompressedBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceDecompressedBytes",
  );
  for (const provider of requiredProviders) {
    for (const envName of credentialEnvNamesForProviderAndRefs(
      provider,
      credentialRefs.filter((ref) => providerMatches(provider, ref.provider)),
    )) {
      const fromPayload = payloadCredentials[envName];
      if (typeof fromPayload === "string") {
        env[envName] = fromPayload;
        continue;
      }
      const value = Bun.env[envName];
      if (typeof value === "string") env[envName] = value;
    }
  }
  return {
    env,
    ...(maxRunSeconds ? { timeoutMs: maxRunSeconds * 1000 } : {}),
    ...(maxSourceArchiveBytes ? { sourceArchiveMaxBytes: maxSourceArchiveBytes } : {}),
    ...(maxSourceDecompressedBytes
      ? { sourceArchiveMaxDecompressedBytes: maxSourceDecompressedBytes }
      : {}),
  };
}

/**
 * Extracts the minted credential env map from the dispatch payload's
 * `credentials` field. Only string values keyed by a valid env-name shape are
 * admitted; everything else is ignored. The provider-allowlist filtering happens
 * in {@link commandContextFromRequest} (only names a required provider allows are
 * ever read out of this map).
 */
function credentialsFromRequest(request: unknown): Record<string, string> {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(credentials)) {
    if (typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(name)) {
      out[name] = value;
    }
  }
  return out;
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

function assertRunnerPolicyBeforeInit(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
  context: CommandContext,
): void {
  if (!runnerProfile) return;
  const source = parseSource(request);
  if (
    source.kind === "local" &&
    recordField(recordField(runnerProfile, "sourcePolicy"), "allowLocalSource") !== true
  ) {
    throw new Error(
      `runner profile ${stringField(runnerProfile, "id") ?? "<unknown>"} does not allow local source paths`,
    );
  }
  const requiredProviders = parseRequiredProviders(request);
  const allowedProviders = stringArray(recordField(runnerProfile, "allowedProviders"));
  const deniedProviders = stringArray(recordField(runnerProfile, "deniedProviders"));
  if (allowedProviders.length > 0 && requiredProviders.length === 0) {
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
      !allowedProviders.some((allowed) => allowed === "*" || providerMatches(provider, allowed))
    ) {
      throw new Error(`provider ${provider} is not allowed before OpenTofu init`);
    }
  }
  assertCredentialEnvAvailable(requiredProviders, runnerProfile, context.env);
}

function assertCredentialEnvAvailable(
  requiredProviders: readonly string[],
  runnerProfile: JsonRecord,
  env: Readonly<Record<string, string>>,
): void {
  const requireCredentialRefs = recordField(runnerProfile, "requireCredentialRefs") === true;
  const credentialRefs = credentialRefsFromRunnerProfile(runnerProfile);
  for (const provider of requiredProviders) {
    const refs = credentialRefs.filter((ref) => providerMatches(provider, ref.provider));
    const requiredRefs = refs.filter((ref) => ref.required || requireCredentialRefs);
    if (requiredRefs.length === 0) continue;
    const envNames = credentialEnvNamesForProviderAndRefs(provider, refs);
    if (envNames.length === 0) {
      throw new Error(`no runner env mapping is configured for provider ${provider}`);
    }
    const rule = providerEnvRule(provider);
    const requiredGroups = envRequiredGroupsForRefs(rule, refs);
    const hasRequiredGroup = requiredGroups.length === 0
      ? envNames.some((envName) => env[envName])
      : requiredGroups.some((group) => group.every((envName) => env[envName]));
    if (!hasRequiredGroup) {
      throw new Error(`required credential env for provider ${provider} is not available in runner environment`);
    }
  }
}

function credentialRefsFromRunnerProfile(
  runnerProfile: JsonRecord | undefined,
): readonly { readonly provider: string; readonly ref: string; readonly required: boolean }[] {
  const refs = recordField(runnerProfile, "credentialRefs");
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((value) => {
    if (!isRecord(value)) return [];
    const provider = stringField(value, "provider");
    const ref = stringField(value, "ref");
    if (!provider || !ref) return [];
    return [{ provider, ref, required: recordField(value, "required") === true }];
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
  return ref.slice("env://".length)
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

function collectProviderFullNames(value: unknown, providers: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProviderFullNames(item, providers);
    return;
  }
  if (!isRecord(value)) return;
  const fullName = value.full_name;
  if (typeof fullName === "string" && fullName.includes("/")) {
    providers.add(fullName);
  }
  for (const child of Object.values(value)) collectProviderFullNames(child, providers);
}

function summaryFromPlanJson(planJson: string): {
  readonly add: number;
  readonly change: number;
  readonly destroy: number;
} {
  const parsed = JSON.parse(planJson) as { readonly resource_changes?: unknown };
  let add = 0;
  let change = 0;
  let destroy = 0;
  if (Array.isArray(parsed.resource_changes)) {
    for (const changeRecord of parsed.resource_changes) {
      const actions = recordField(recordField(changeRecord, "change"), "actions");
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
export function resourceChangesFromPlanJson(
  planJson: string,
): Array<{ address: string; type: string; actions: string[] }> {
  const parsed = JSON.parse(planJson) as { readonly resource_changes?: unknown };
  const out: Array<{ address: string; type: string; actions: string[] }> = [];
  if (!Array.isArray(parsed.resource_changes)) return out;
  for (const changeRecord of parsed.resource_changes) {
    const address = stringField(changeRecord, "address");
    const type = stringField(changeRecord, "type");
    const actions = recordField(recordField(changeRecord, "change"), "actions");
    if (!address || !type || !Array.isArray(actions)) continue;
    out.push({
      address,
      type,
      actions: actions.filter((action): action is string =>
        typeof action === "string"
      ),
    });
  }
  return out;
}

async function gitRevParseHead(
  cwd: string,
  context: CommandContext,
): Promise<string | undefined> {
  const result = await runCommand(["git", "rev-parse", "HEAD"], { cwd, context });
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

function resolveModulePath(sourceRoot: string, modulePath: string | undefined): string {
  const moduleDir = resolve(sourceRoot, modulePath ?? ".");
  const normalizedRoot = resolve(sourceRoot);
  if (moduleDir !== normalizedRoot && !moduleDir.startsWith(`${normalizedRoot}/`)) {
    throw new Error("source.modulePath must stay inside source root");
  }
  return moduleDir;
}

function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function recordField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string" && item.length > 0
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
    throw new Error(`${label} must stay inside source root after symlink resolution`);
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
  if (value === "plan" || value === "apply" || value === "destroy") {
    return value;
  }
  return undefined;
}

async function digestBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}
