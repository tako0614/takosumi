// runner/lib/plan_apply.ts
//
// Plan / apply / destroy / compatibility-check pipelines + generated-root workspace.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  JsonRecord,
  OpenTofuModuleSource,
  RunWorkspace,
  GeneratedRoot,
  OperatorModule,
  CommandContext,
  PlanResponseOptions,
  SourceBuildConfig,
} from "./types.ts";
import {
  CAPSULE_COMPATIBILITY_MAX_FILES,
  CAPSULE_COMPATIBILITY_MAX_FILE_BYTES,
  CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES,
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
import { redactRunnerOutput } from "./redaction.ts";
import { RunnerPhaseTimer, withPhaseTimings } from "./timing.ts";
import {
  readOpenTofuPlanJson,
  readOpenTofuOutputsIn,
  runCommand,
  commandFailurePayload,
  classifyOpenTofuFailure,
} from "./exec.ts";
import { assertSafeRelativePath } from "./policy.ts";
import {
  commandContextFromRequest,
  prepareProviderCredentialFiles,
  buildPhaseEnv,
  assertCommandEnvHasNoProviderCredentials,
} from "./credentials.ts";
import { ensureSourceAvailable, gitRevParseHead } from "./source_sync.ts";
import {
  writePlanJsonArtifact,
  workspaceForRun,
  writeModuleInfo,
  restoreUploadedState,
} from "./artifacts.ts";
import {
  parseOperation,
  parseRefreshOnly,
  parseSource,
  parseGeneratedRoot,
  parseOperatorModule,
  parseVariables,
  parseSourceBuild,
  assertNoLegacyArtifactDispatch,
  parseRunnerProfile,
  parseRequiredProviders,
  parseProviderInstallationPolicy,
  parsePlanScopeSelectors,
  parseOutputAllowlist,
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
  withProviderPluginCacheInitLock,
  summaryFromPlanJson,
  resourceChangesFromPlanJson,
  plannedOutputsFromPlanJson,
} from "./providers.ts";
import { runSourceBuild } from "./source_build.ts";

export async function runPlan(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const generatedRoot = parseGeneratedRoot(request);
  if (generatedRoot) {
    return await runGeneratedRootPlan(runId, request, generatedRoot);
  }
  if (parseOperatorModule(request)) {
    throw new Error("operatorModule requires a generated root");
  }
  return await runDirectRootPlan(runId, request);
}

// Generated-root path: used only when explicit provider alias/configuration
// requires a child-module wrapper, or by an explicit Resource Shape operator
// module. Ordinary Git Capsules execute their selected module as the root.
export async function runGeneratedRootPlan(
  runId: string,
  request: unknown,
  generatedRoot: GeneratedRoot,
): Promise<JsonRecord> {
  const operation = parseOperation(request);
  const refreshOnly = parseRefreshOnly(request);
  assertNoLegacyArtifactDispatch(request);
  const source = parseSource(request);
  const sourceBuild = parseSourceBuild(request);
  const runnerProfile = parseRunnerProfile(request);
  const outputAllowlist = parseOutputAllowlist(request);
  const operatorModule = parseOperatorModule(request);
  const scopeSelectors = parsePlanScopeSelectors(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);

  const workspace = await prepareGeneratedRootWorkspace(runId);
  let sourceCommit: string | undefined;
  let buildLog: string | undefined;

  if (operatorModule) {
    if (sourceBuild) {
      throw new Error(
        "sourceBuild requires a restored Git SourceSnapshot module",
      );
    }
    await materializeGeneratedRootFromFiles(
      workspace,
      generatedRoot,
      operatorModule,
    );
  } else {
    if (source.kind === "operator_module") {
      throw new Error("operator_module source requires operatorModule");
    }
    await ensureSourceAvailable(source, workspace.sourceRoot);
    buildLog = await runSourceBuild(sourceBuild, workspace.sourceRoot, {
      ...(commandContext.timeoutMs
        ? { timeoutMs: commandContext.timeoutMs }
        : {}),
    });
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
  const preparedCredentials = await prepareProviderCredentialFiles(
    commandContext,
    workspace,
  );
  try {
    const providerScan = await requiredProvidersForGeneratedRoot(
      request,
      workspace.generatedRootDir,
    );
    const requiredProviders = providerScan.providers;
    assertRunnerPolicyBeforeInit(
      request,
      runnerProfile,
      preparedCredentials.context,
      {
        allowProviderFreeGeneratedRoot:
          await generatedRootTreeHasNoProviderUsage(workspace.generatedRootDir),
        requiredProviders,
        providerScanComplete: providerScan.complete,
      },
    );
    return await initPlanAndBuildResponse(
      runId,
      workspace,
      workspace.generatedRootDir,
      {
        operation,
        ...(refreshOnly ? { refreshOnly: true } : {}),
        commandContext: preparedCredentials.context,
        requiredProviders,
        ...(outputAllowlist ? { outputAllowlist } : {}),
        ...(scopeSelectors.length > 0 ? { scopeSelectors } : {}),
        ...(parseProviderInstallationPolicy(request)
          ? {
              providerInstallationPolicy:
                parseProviderInstallationPolicy(request),
            }
          : {}),
        ...(buildLog ? { buildLog } : {}),
        extra: {
          ...(sourceCommit ? { sourceCommit } : {}),
        },
      },
    );
  } finally {
    await preparedCredentials.cleanup();
  }
}

/** Execute the restored Git SourceSnapshot module as the OpenTofu root. */
export async function runDirectRootPlan(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const operation = parseOperation(request);
  const refreshOnly = parseRefreshOnly(request);
  assertNoLegacyArtifactDispatch(request);
  const source = parseSource(request);
  if (source.kind === "operator_module") {
    throw new Error("operator_module source requires a generated root");
  }
  const sourceBuild = parseSourceBuild(request);
  const runnerProfile = parseRunnerProfile(request);
  const outputAllowlist = parseOutputAllowlist(request);
  const scopeSelectors = parsePlanScopeSelectors(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);
  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  await ensureSourceAvailable(source, workspace.sourceRoot);
  const buildLog = await runSourceBuild(sourceBuild, workspace.sourceRoot, {
    ...(commandContext.timeoutMs
      ? { timeoutMs: commandContext.timeoutMs }
      : {}),
  });
  const moduleDir = resolveModulePath(workspace.sourceRoot, source.modulePath);
  await assertDirectory(moduleDir, "source module directory");
  await assertRealPathInsideSourceRoot(
    moduleDir,
    workspace.sourceRoot,
    "source module directory",
  );
  await restoreUploadedState(workspace, moduleDir);
  await writeModuleInfo(workspace, moduleDir);
  const variableFilePath = join(workspace.root, "run-inputs.tfvars.json");
  await writeFile(
    variableFilePath,
    `${JSON.stringify(parseVariables(request))}\n`,
  );
  const preparedCredentials = await prepareProviderCredentialFiles(
    commandContext,
    workspace,
  );
  try {
    const providerScan = await requiredProvidersForGeneratedRoot(
      request,
      moduleDir,
    );
    const requiredProviders = providerScan.providers;
    assertRunnerPolicyBeforeInit(
      request,
      runnerProfile,
      preparedCredentials.context,
      {
        allowProviderFreeGeneratedRoot:
          await generatedRootTreeHasNoProviderUsage(moduleDir),
        requiredProviders,
        providerScanComplete: providerScan.complete,
      },
    );
    const sourceCommit =
      source.kind === "git"
        ? (source.commit ??
          (await gitRevParseHead(workspace.sourceRoot, commandContext)))
        : undefined;
    return await initPlanAndBuildResponse(runId, workspace, moduleDir, {
      operation,
      ...(refreshOnly ? { refreshOnly: true } : {}),
      commandContext: preparedCredentials.context,
      requiredProviders,
      variableFilePath,
      ...(outputAllowlist ? { outputAllowlist } : {}),
      ...(scopeSelectors.length > 0 ? { scopeSelectors } : {}),
      ...(parseProviderInstallationPolicy(request)
        ? {
            providerInstallationPolicy:
              parseProviderInstallationPolicy(request),
          }
        : {}),
      ...(buildLog ? { buildLog } : {}),
      extra: { ...(sourceCommit ? { sourceCommit } : {}) },
    });
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
  if (options.refreshOnly && operation === "destroy") {
    throw new Error("refreshOnly cannot be combined with destroy");
  }
  const timer = new RunnerPhaseTimer();
  const strictMirrorInit = await prepareStrictProviderMirrorInit(
    workspace,
    options.commandContext,
    options.requiredProviders,
    options.providerInstallationPolicy,
  );
  const commandContext =
    strictMirrorInit?.commandContext ?? options.commandContext;
  const init = await timer.measure("tofu_init", () =>
    withProviderPluginCacheInitLock(strictMirrorInit, () =>
      runCommand(["tofu", "init", "-input=false", "-no-color"], {
        cwd: moduleDir,
        context: commandContext,
      }),
    ),
  );
  if (init.exitCode !== 0) {
    return withPhaseTimings(
      mergeBuildLog(
        commandFailurePayload(runId, "plan", init, commandContext, "init"),
        options.buildLog,
      ),
      timer,
    );
  }
  const plan = await timer.measure("tofu_plan", () =>
    runCommand(
      [
        "tofu",
        "plan",
        ...(operation === "destroy" ? ["-destroy"] : []),
        ...(options.refreshOnly ? ["-refresh-only"] : []),
        ...(options.variableFilePath
          ? [`-var-file=${options.variableFilePath}`]
          : []),
        "-input=false",
        "-no-color",
        "-out",
        workspace.planPath,
      ],
      { cwd: moduleDir, context: commandContext },
    ),
  );
  if (plan.exitCode !== 0) {
    return withPhaseTimings(
      mergeBuildLog(
        commandFailurePayload(runId, "plan", plan, commandContext, "plan"),
        options.buildLog,
      ),
      timer,
    );
  }

  const planBytes = await readFile(workspace.planPath);
  const planDigest = await digestBytes(planBytes);
  const planJson = await timer.measure("tofu_plan_json", () =>
    readOpenTofuPlanJson(moduleDir, workspace, commandContext),
  );
  const planJsonArtifact = planJson
    ? await writePlanJsonArtifact(workspace, planJson)
    : undefined;
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
  const plannedOutputs = planJson
    ? plannedOutputsFromPlanJson(planJson, options.outputAllowlist)
    : undefined;
  return withPhaseTimings(
    {
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
        ? {
            planResourceChanges: resourceChangesFromPlanJson(
              planJson,
              options.scopeSelectors,
            ),
          }
        : {}),
      ...(plannedOutputs ? { plannedOutputs } : {}),
      ...(planJsonArtifact
        ? {
            planJsonArtifact: {
              kind: "runner-local",
              written: planJsonArtifact.written,
              sizeBytes: planJsonArtifact.sizeBytes,
              maxBytes: planJsonArtifact.maxBytes,
              ...(planJsonArtifact.written
                ? { ref: `runner-local://${runId}/tfplan-json` }
                : { skippedReason: "size_limit_exceeded" }),
            },
          }
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
    },
    timer,
  );
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
  const operatorModule = parseOperatorModule(request);
  const sourceBuild = parseSourceBuild(request);
  const runnerProfile = parseRunnerProfile(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);
  const workspace = workspaceForRun(runId);
  const planArtifact = parsePlanArtifact(request);
  assertNoLegacyArtifactDispatch(request);
  await verifyPlanArtifact(workspace.planPath, planArtifact);
  if (!generatedRoot && operatorModule) {
    throw new Error("operatorModule requires a generated root");
  }
  const moduleDir = generatedRoot
    ? await restoreGeneratedRootApplyWorkspace(
        runId,
        parseSource(request),
        commandContext,
        generatedRoot,
        operatorModule,
        sourceBuild,
      )
    : await restoreDirectRootApplyWorkspace(
        runId,
        parseSource(request),
        commandContext,
        sourceBuild,
      );
  const timer = new RunnerPhaseTimer();
  const preparedCredentials = await prepareProviderCredentialFiles(
    commandContext,
    workspace,
  );
  try {
    const providerScan = await requiredProvidersForGeneratedRoot(
      request,
      moduleDir,
    );
    const requiredProviders = providerScan.providers;
    assertRunnerPolicyBeforeInit(
      request,
      runnerProfile,
      preparedCredentials.context,
      {
        allowProviderFreeGeneratedRoot:
          await generatedRootTreeHasNoProviderUsage(moduleDir),
        requiredProviders,
        providerScanComplete: providerScan.complete,
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

    const init = await timer.measure("tofu_init", () =>
      withProviderPluginCacheInitLock(strictMirrorInit, () =>
        runCommand(["tofu", "init", "-input=false", "-no-color"], {
          cwd: moduleDir,
          context: applyContext,
        }),
      ),
    );
    if (init.exitCode !== 0) {
      return withPhaseTimings(
        commandFailurePayload(runId, action, init, applyContext, "init"),
        timer,
      );
    }
    const providerInstallation = await providerInstallationEvidence(
      moduleDir,
      parseRequiredProviders(request),
      strictMirrorInit?.attestation,
    );
    const result = await timer.measure("tofu_apply", () =>
      runCommand(
        ["tofu", "apply", "-input=false", "-no-color", workspace.planPath],
        { cwd: moduleDir, context: applyContext },
      ),
    );
    const outputs =
      action === "apply" && result.exitCode === 0
        ? await timer.measure("tofu_output", () =>
            readOpenTofuOutputsIn(moduleDir, applyContext),
          )
        : undefined;
    return withPhaseTimings(
      {
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
        ...(result.exitCode === 0
          ? {}
          : {
              errorCode:
                classifyOpenTofuFailure(
                  [result.stderr, result.stdout].filter(Boolean).join("\n"),
                  "apply",
                ) ?? "apply_failed",
            }),
      },
      timer,
    );
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
  operatorModule?: OperatorModule,
  sourceBuild?: SourceBuildConfig,
): Promise<string> {
  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  if (operatorModule) {
    if (sourceBuild) {
      throw new Error(
        "sourceBuild requires a restored Git SourceSnapshot module",
      );
    }
    await materializeGeneratedRootFromFiles(
      workspace,
      generatedRoot,
      operatorModule,
    );
  } else {
    if (source.kind === "operator_module") {
      throw new Error("operator_module source requires operatorModule");
    }
    await ensureSourceAvailable(source, workspace.sourceRoot);
    await runSourceBuild(sourceBuild, workspace.sourceRoot, {
      ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}),
    });
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

export async function restoreDirectRootApplyWorkspace(
  runId: string,
  source: OpenTofuModuleSource,
  context: CommandContext,
  sourceBuild?: SourceBuildConfig,
): Promise<string> {
  if (source.kind === "operator_module") {
    throw new Error("operator_module source requires a generated root");
  }
  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  await ensureSourceAvailable(source, workspace.sourceRoot);
  await runSourceBuild(sourceBuild, workspace.sourceRoot, {
    ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}),
  });
  const moduleDir = resolveModulePath(workspace.sourceRoot, source.modulePath);
  await assertDirectory(moduleDir, "source module directory");
  await assertRealPathInsideSourceRoot(
    moduleDir,
    workspace.sourceRoot,
    "source module directory",
  );
  await restoreUploadedState(workspace, moduleDir);
  await writeModuleInfo(workspace, moduleDir);
  return moduleDir;
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
// ./module so the generated root's `source = "./module"`
// resolves. For Git-sourced Capsules it is the restored SourceSnapshot module.
export async function materializeGeneratedRootFromModule(
  workspace: RunWorkspace,
  moduleDir: string,
  generatedRoot: GeneratedRoot,
): Promise<void> {
  await mkdir(workspace.generatedRootDir, { recursive: true });
  await rm(workspace.childModuleDir, { recursive: true, force: true });
  await assertDirectory(moduleDir, "child module directory");
  await cp(moduleDir, workspace.childModuleDir, {
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
  operatorModule: OperatorModule,
): Promise<void> {
  if (operatorModule.files.length === 0) {
    throw new Error("operatorModule.files must be a non-empty array");
  }
  await mkdir(workspace.generatedRootDir, { recursive: true });
  await rm(workspace.childModuleDir, { recursive: true, force: true });
  await mkdir(workspace.childModuleDir, { recursive: true });
  for (const file of operatorModule.files) {
    assertSafeRelativePath(file.path, "operatorModule.files[].path");
    const target = resolve(workspace.childModuleDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await assertRealPathInsideSourceRoot(
      dirname(target),
      workspace.childModuleDir,
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
  const timer = new RunnerPhaseTimer();
  const providerInit = await prepareStrictProviderMirrorInit(
    workspace,
    context,
    [],
    undefined,
  );
  const commandContext = providerInit?.commandContext ?? context;
  const init = await timer.measure("tofu_init", () =>
    withProviderPluginCacheInitLock(providerInit, () =>
      runCommand(["tofu", "init", "-input=false", "-no-color"], {
        cwd: moduleRoot,
        context: commandContext,
      }),
    ),
  );
  if (init.exitCode !== 0) {
    return withPhaseTimings(
      commandFailurePayload(
        runId,
        "compatibility_check",
        init,
        commandContext,
        "init",
      ),
      timer,
    );
  }
  const files = await readCapsuleCompatibilityFiles(
    moduleRoot,
    workspace.sourceRoot,
  );
  const providerLockDigest = await digestFileIfExists(
    join(moduleRoot, ".terraform.lock.hcl"),
  );
  return withPhaseTimings(
    {
      runId,
      action: "compatibility_check",
      status: "succeeded",
      exitCode: 0,
      files,
      ...(providerLockDigest ? { providerLockDigest } : {}),
      stdout: redactRunnerOutput(init.stdout, commandContext.redactionValues),
      stderr: redactRunnerOutput(init.stderr, commandContext.redactionValues),
    },
    timer,
  );
}

export function compatibilityModulePath(request: unknown): string | undefined {
  const source = recordField(request, "source");
  return isRecord(source) ? stringField(source, "modulePath") : undefined;
}

export async function readCapsuleCompatibilityFiles(
  sourceRoot: string,
  repositoryRoot = sourceRoot,
): Promise<readonly { readonly path: string; readonly text: string }[]> {
  const root = await realpath(sourceRoot);
  const repository = await realpath(repositoryRoot);
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

  // Store listings are discovery pointers only. The repository-owned install
  // presentation contract lives at this well-known path and must be read from
  // the same immutable SourceSnapshot as the OpenTofu module. Keep it separate
  // from executable authority: compatibility analysis ignores non-.tf files,
  // while the control plane may consume this bounded JSON document only for
  // display text and icons.
  const metadataRelativePath = ".well-known/tcs.json";
  const metadataPath = resolve(repository, metadataRelativePath);
  try {
    const resolvedMetadataPath = await realpath(metadataPath);
    assertPathInsideRoot(
      repository,
      resolvedMetadataPath,
      "repository install metadata",
    );
    const info = await stat(resolvedMetadataPath);
    if (!info.isFile()) return out;
    if (info.size > CAPSULE_COMPATIBILITY_MAX_FILE_BYTES) {
      throw new Error(
        `repository install metadata ${metadataRelativePath} exceeds ${CAPSULE_COMPATIBILITY_MAX_FILE_BYTES} bytes`,
      );
    }
    if (out.length >= CAPSULE_COMPATIBILITY_MAX_FILES) {
      throw new Error(
        `compatibility source files exceed ${CAPSULE_COMPATIBILITY_MAX_FILES} files`,
      );
    }
    totalBytes += info.size;
    if (totalBytes > CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES) {
      throw new Error(
        `compatibility source files exceed ${CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES} bytes`,
      );
    }
    out.push({
      path: metadataRelativePath,
      text: await readFile(resolvedMetadataPath, "utf8"),
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "";
    if (code !== "ENOENT") throw error;
  }
  return out;
}
