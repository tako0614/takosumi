// runner/lib/plan_apply.ts
//
// Plan / apply / destroy / compatibility-check pipelines + build phase + generated-root workspace.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  JsonRecord,
  OpenTofuModuleSource,
  RunWorkspace,
  GeneratedRoot,
  BuildSpec,
  PrebuiltArtifactSpec,
  CommandContext,
  PlanResponseOptions,
} from "./types.ts";
import {
  CAPSULE_COMPATIBILITY_MAX_FILES,
  CAPSULE_COMPATIBILITY_MAX_FILE_BYTES,
  CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES,
  ARTIFACT_PATH_TF_VAR,
} from "./constants.ts";
import {
  isRecord,
  recordField,
  stringField,
  digestBytes,
  digestFileIfExists,
  assertPathInsideRoot,
  assertDirectory,
  assertRealPathInsideSourceRoot,
  resolveModulePath,
} from "./util.ts";
import {
  redactRunnerOutput,
  redactBuildOutput,
} from "./redaction.ts";
import {
  readOpenTofuPlanJson,
  readOpenTofuOutputsIn,
  runCommand,
  commandFailurePayload,
} from "./exec.ts";
import {
  assertSafeRelativePath,
} from "./policy.ts";
import {
  commandContextFromRequest,
  prepareProviderCredentialFiles,
  buildPhaseEnv,
  assertCommandEnvHasNoProviderCredentials,
} from "./credentials.ts";
import {
  ensureSourceAvailable,
  gitRevParseHead,
} from "./source_sync.ts";
import {
  writePlanJsonArtifact,
  workspaceForRun,
  writeModuleInfo,
  restoreUploadedState,
} from "./artifacts.ts";
import {
  parseOperation,
  parseSource,
  parseGeneratedRoot,
  parseBuild,
  parsePrebuiltArtifact,
  parseRunnerProfile,
  parseRequiredProviders,
  parseProviderInstallationPolicy,
  parsePlanArtifact,
  verifyPlanArtifact,
} from "./parsing.ts";
import {
  requiredProvidersForGeneratedRoot,
  assertRunnerPolicyBeforeInit,
  generatedRootTreeHasNoProviderUsage,
  providersFromPlanJson,
  normalizedProviderList,
  providerInstallationEvidence,
  prepareStrictProviderMirrorInit,
  summaryFromPlanJson,
  resourceChangesFromPlanJson,
} from "./providers.ts";

export async function runPlan(runId: string, request: unknown): Promise<JsonRecord> {
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
export async function runGeneratedRootPlan(
  runId: string,
  request: unknown,
  generatedRoot: GeneratedRoot,
): Promise<JsonRecord> {
  const operation = parseOperation(request);
  const build = parseBuild(request);
  const prebuiltArtifact = parsePrebuiltArtifact(request);
  if (build && prebuiltArtifact) {
    throw new Error("build and prebuiltArtifact are mutually exclusive");
  }
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
  const planContext = await withRequestArtifactPathVar(
    commandContext,
    workspace,
    { build, prebuiltArtifact },
  );
  const preparedCredentials = await prepareProviderCredentialFiles(
    planContext,
    workspace,
  );
  try {
    const requiredProviders = await requiredProvidersForGeneratedRoot(
      request,
      workspace.generatedRootDir,
    );
    assertRunnerPolicyBeforeInit(
      request,
      runnerProfile,
      preparedCredentials.context,
      {
        allowProviderFreeGeneratedRoot:
          await generatedRootTreeHasNoProviderUsage(workspace.generatedRootDir),
        requiredProviders,
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
        requiredProviders,
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


// Shared init+plan+show pipeline for generated-root lanes. `moduleDir` is the
// tofu root, normally /work/generated-root.
export async function initPlanAndBuildResponse(
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

export function mergeBuildLog(
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

export async function runReviewedPlanApply(
  runId: string,
  action: "apply" | "destroy",
  request: unknown,
): Promise<JsonRecord> {
  const generatedRoot = parseGeneratedRoot(request);
  const runnerProfile = parseRunnerProfile(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);
  const workspace = workspaceForRun(runId);
  const planArtifact = parsePlanArtifact(request);
  const build = parseBuild(request);
  const prebuiltArtifact = parsePrebuiltArtifact(request);
  if (build && prebuiltArtifact) {
    throw new Error("build and prebuiltArtifact are mutually exclusive");
  }
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
  const applyBaseContext = await withRequestArtifactPathVar(
    commandContext,
    workspace,
    { build, prebuiltArtifact },
  );
  const preparedCredentials = await prepareProviderCredentialFiles(
    applyBaseContext,
    workspace,
  );
  try {
    const requiredProviders = await requiredProvidersForGeneratedRoot(
      request,
      moduleDir,
    );
    assertRunnerPolicyBeforeInit(
      request,
      runnerProfile,
      preparedCredentials.context,
      {
        allowProviderFreeGeneratedRoot:
          await generatedRootTreeHasNoProviderUsage(moduleDir),
        requiredProviders,
      },
    );
    const strictMirrorInit = await prepareStrictProviderMirrorInit(
      workspace,
      preparedCredentials.context,
      requiredProviders,
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
export async function restoreGeneratedRootApplyWorkspace(
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
export async function runBuildPhase(
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
  assertCommandEnvHasNoProviderCredentials(buildContext.env);
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

export async function copyBuildArtifact(
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
export function withArtifactPathVar(
  context: CommandContext,
  workspace: RunWorkspace,
  build: BuildSpec,
): CommandContext {
  return withArtifactPathValue(
    context,
    join(workspace.artifactDir, build.artifactPath),
  );
}

export async function withRequestArtifactPathVar(
  context: CommandContext,
  workspace: RunWorkspace,
  requestArtifact: {
    readonly build?: BuildSpec;
    readonly prebuiltArtifact?: PrebuiltArtifactSpec;
  },
): Promise<CommandContext> {
  if (requestArtifact.build) {
    return withArtifactPathVar(context, workspace, requestArtifact.build);
  }
  if (requestArtifact.prebuiltArtifact) {
    return withArtifactPathValue(
      context,
      await resolvePrebuiltArtifactPath(
        workspace,
        requestArtifact.prebuiltArtifact,
      ),
    );
  }
  return context;
}

export async function resolvePrebuiltArtifactPath(
  workspace: RunWorkspace,
  artifact: PrebuiltArtifactSpec,
): Promise<string> {
  const artifactSource = resolve(workspace.sourceRoot, artifact.path);
  const normalizedRoot = resolve(workspace.sourceRoot);
  if (
    artifactSource !== normalizedRoot &&
    !artifactSource.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error("prebuiltArtifact.path must stay inside source root");
  }
  await assertRealPathInsideSourceRoot(
    artifactSource,
    workspace.sourceRoot,
    "prebuilt artifact path",
  );
  return artifactSource;
}

export function withArtifactPathValue(
  context: CommandContext,
  artifactPath: string,
): CommandContext {
  return {
    ...context,
    env: {
      ...context.env,
      [ARTIFACT_PATH_TF_VAR]: artifactPath,
    },
  };
}

// Fresh per-run workspace for a generated-root plan. Preserve a SourceSnapshot
// archive already restored by the DO under /work/source; only the
// generated-root subtree is recreated.
export async function prepareGeneratedRootWorkspace(
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
export async function materializeGeneratedRootFromModule(
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

export async function materializeGeneratedRootFromFiles(
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

export async function runCompatibilityCheck(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const workspace = workspaceForRun(runId);
  await assertDirectory(workspace.sourceRoot, "source root");
  const modulePath = compatibilityModulePath(request);
  const moduleRoot = resolveModulePath(workspace.sourceRoot, modulePath);
  await assertDirectory(moduleRoot, "compatibility module root");
  const context: CommandContext = { env: buildPhaseEnv() };
  assertCommandEnvHasNoProviderCredentials(context.env);
  const init = await runCommand(["tofu", "init", "-input=false", "-no-color"], {
    cwd: moduleRoot,
    context,
  });
  if (init.exitCode !== 0) {
    return commandFailurePayload(runId, "compatibility_check", init, context);
  }
  const files = await readCapsuleCompatibilityFiles(moduleRoot);
  const providerLockDigest = await digestFileIfExists(
    join(moduleRoot, ".terraform.lock.hcl"),
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

export function compatibilityModulePath(request: unknown): string | undefined {
  const source = recordField(request, "source");
  return isRecord(source) ? stringField(source, "modulePath") : undefined;
}

export async function readCapsuleCompatibilityFiles(
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
