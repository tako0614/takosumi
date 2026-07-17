// runner/lib/backup.ts
//
// Backup / release execution + their request parsing.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isReservedProviderEnvName } from "../../contract/provider-env-rules.ts";
import {
  emptyProviderConfigurationsEnvelope,
  parseProviderConfigurationsEnvelope,
  providerConfigurationsJson,
} from "../../contract/provider-configurations.ts";
import type {
  JsonRecord,
  RunWorkspace,
  BackupSpec,
  ReleaseCommandSpec,
  ReleaseSpec,
  ReleaseActivationSpec,
  CommandContext,
} from "./types.ts";
import {
  BACKUP_ADAPTERS_ENV,
  RUNNER_SECRET_ENV_NAME_PATTERN,
  RUNNER_SECRET_VALUE_PATTERN,
} from "./constants.ts";
import {
  isRecord,
  recordField,
  stringField,
  requiredStringField,
  stringArray,
  digestBytes,
  assertDirectory,
  assertRealPathInsideSourceRoot,
} from "./util.ts";
import { redactBuildOutput, redactRunnerOutput } from "./redaction.ts";
import { runCommand } from "./exec.ts";
import { assertSafeRelativePath } from "./policy.ts";
import {
  baseCommandEnv,
  buildPhaseEnv,
  assertCommandEnvHasNoProviderCredentials,
  commandContextFromRequest,
  prepareProviderCredentialFiles,
} from "./credentials.ts";
import { workspaceForRun } from "./artifacts.ts";

export async function runBackup(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
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
  assertCommandEnvHasNoProviderCredentials(context.env);
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

export async function runRelease(
  runId: string,
  request: unknown,
): Promise<JsonRecord> {
  const release = parseRelease(request);
  const workspace = workspaceForRun(runId);
  await assertDirectory(workspace.sourceRoot, "release source root");
  const commandContext = commandContextFromRequest(request, undefined);
  const preparedCredentials = await prepareProviderCredentialFiles(
    commandContext,
    workspace,
  );
  const logs: string[] = [];
  try {
    for (const command of release.commands) {
      const cwd = releaseCommandCwd(workspace, command);
      await assertDirectory(
        cwd,
        `release command ${command.id} working directory`,
      );
      await assertRealPathInsideSourceRoot(
        cwd,
        workspace.sourceRoot,
        `release command ${command.id} working directory`,
      );
      const context: CommandContext = {
        ...preparedCredentials.context,
        env: {
          ...preparedCredentials.context.env,
          ...releaseBaseEnv(runId, release),
          ...(command.env ?? {}),
        },
        timeoutMs:
          releaseCommandTimeoutMs(command) ??
          preparedCredentials.context.timeoutMs ??
          10 * 60 * 1000,
      };
      const result = await runCommand(command.command, { cwd, context });
      logs.push(
        redactRunnerOutput(
          redactBuildOutput(
            `$ ${command.command.join(" ")}\n${result.stdout}\n${result.stderr}`,
          ),
          context.redactionValues,
        ),
      );
      if (result.exitCode !== 0) {
        return {
          runId,
          action: "release",
          status: "failed",
          exitCode: result.exitCode,
          phase: "release",
          failedCommandId: command.id,
          stdout: logs.join("\n"),
          stderr: redactRunnerOutput(
            redactBuildOutput(
              `release command failed (${result.exitCode}): ${command.id}\n${result.stderr}`,
            ),
            context.redactionValues,
          ),
        };
      }
    }
  } finally {
    await preparedCredentials.cleanup();
  }
  return {
    runId,
    action: "release",
    status: "succeeded",
    exitCode: 0,
    commandCount: release.commands.length,
    stdout: logs.join("\n"),
  };
}

export async function runProviderSnapshotBackup(
  runId: string,
  backup: BackupSpec,
): Promise<JsonRecord> {
  const adapterId = backup.adapterId;
  if (!adapterId) {
    throw new Error("provider_snapshot requires backup.adapterId");
  }
  const adapter = backupAdapter(adapterId);
  if (!adapter) {
    return {
      runId,
      action: "backup",
      status: "unsupported",
      exitCode: 0,
      reason: `backup adapter ${adapterId} is not installed`,
    };
  }
  if (adapter.kind === "pointer") {
    return await runProviderSnapshotPointerBackup(
      runId,
      backup,
      adapter.directory,
    );
  }

  const workspace = workspaceForRun(runId);
  await mkdir(workspace.root, { recursive: true });
  const context: CommandContext = {
    env: {
      ...baseCommandEnv(),
      TAKOSUMI_BACKUP_MODE: "provider_snapshot",
      TAKOSUMI_BACKUP_ADAPTER_ID: adapterId,
      TAKOSUMI_BACKUP_OUTPUT_PATH: backup.outputPath,
      TAKOSUMI_RUN_ID: runId,
    },
    timeoutMs: 10 * 60 * 1000,
  };
  const result = await runCommand(["bash", "-lc", adapter.command], {
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

export type BackupAdapter =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "pointer"; readonly directory: string };

/** Resolve only an exact operator-installed adapter id from one explicit map. */
export function backupAdapter(
  adapterId: string,
  serializedRegistry = Bun.env[BACKUP_ADAPTERS_ENV],
): BackupAdapter | undefined {
  if (!isBackupAdapterId(adapterId)) {
    throw new Error("backup adapter id must be a non-empty opaque token");
  }
  if (!serializedRegistry?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedRegistry);
  } catch {
    throw new Error(`${BACKUP_ADAPTERS_ENV} must be a JSON object`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${BACKUP_ADAPTERS_ENV} must be a JSON object`);
  }
  if (!Object.hasOwn(parsed, adapterId)) return undefined;
  const candidate = parsed[adapterId];
  if (!isRecord(candidate)) {
    throw new Error(`backup adapter ${adapterId} must be an object`);
  }
  if (candidate.kind === "command") {
    const command = stringField(candidate, "command")?.trim();
    if (!command) {
      throw new Error(`backup adapter ${adapterId} requires command`);
    }
    return { kind: "command", command };
  }
  if (candidate.kind === "pointer") {
    const directory = stringField(candidate, "directory")?.trim();
    if (!directory) {
      throw new Error(`backup adapter ${adapterId} requires directory`);
    }
    return { kind: "pointer", directory };
  }
  throw new Error(
    `backup adapter ${adapterId} kind must be command or pointer`,
  );
}

export async function runProviderSnapshotPointerBackup(
  runId: string,
  backup: BackupSpec,
  pointerDirectory: string,
): Promise<JsonRecord> {
  const pointerPath = providerSnapshotPointerPath(
    pointerDirectory,
    backup.outputPath,
  );
  let pointerText: string;
  try {
    pointerText = await readFile(pointerPath, "utf8");
  } catch {
    return {
      runId,
      action: "backup",
      status: "missing",
      exitCode: 0,
      outputPath: backup.outputPath,
      reason: `provider snapshot artifact pointer ${pointerPath} does not exist`,
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
      reason: `provider snapshot artifact pointer ${pointerPath} is not a service-data artifact pointer JSON object`,
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

export function providerSnapshotPointerPath(
  pointerDir: string,
  outputPath: string,
): string {
  const safeName = outputPath.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return join(pointerDir, `${safeName}.json`);
}

export function parseBackup(request: unknown): BackupSpec {
  const backup = recordField(request, "backup");
  if (!isRecord(backup)) {
    throw new Error("backup request requires backup object");
  }
  const mode = stringField(backup, "mode");
  if (mode !== "provider_snapshot" && mode !== "custom_command") {
    throw new Error("backup.mode must be provider_snapshot or custom_command");
  }
  const outputPath = requiredStringField(backup, "outputPath");
  const adapterId = stringField(backup, "adapterId")?.trim();
  const commands = stringArray(recordField(backup, "command"));
  if (mode === "provider_snapshot" && !adapterId) {
    throw new Error("provider_snapshot backup requires BackupConfig.adapterId");
  }
  if (adapterId && !isBackupAdapterId(adapterId)) {
    throw new Error("backup.adapterId must be a non-empty opaque token");
  }
  if (mode === "custom_command" && commands.length === 0) {
    throw new Error("custom_command backup requires BackupConfig.command");
  }
  return {
    mode,
    outputPath,
    ...(adapterId ? { adapterId } : {}),
    ...(commands.length > 0 ? { command: commands } : {}),
  };
}

function isBackupAdapterId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

export function parseRelease(request: unknown): ReleaseSpec {
  const release = recordField(request, "release");
  if (!isRecord(release)) {
    throw new Error("release request requires release object");
  }
  const rawCommands = release.commands;
  if (!Array.isArray(rawCommands) || rawCommands.length === 0) {
    throw new Error("release.commands must be a non-empty array");
  }
  return {
    commands: rawCommands.map((entry, index): ReleaseCommandSpec => {
      if (!isRecord(entry)) {
        throw new Error(`release.commands[${index}] must be an object`);
      }
      const id = stringField(entry, "id")?.trim() || `post_apply_${index + 1}`;
      const command = stringArray(entry.command);
      if (command.length === 0) {
        throw new Error(`release.commands[${index}].command is required`);
      }
      const workingDirectory = stringField(entry, "workingDirectory")?.trim();
      if (workingDirectory) {
        assertSafeRelativePath(
          workingDirectory,
          `release.commands[${index}].workingDirectory`,
        );
      }
      const env = releaseCommandEnv(recordField(entry, "env"));
      const timeoutSeconds = releaseCommandTimeoutSeconds(
        entry.timeoutSeconds ?? entry.timeout_seconds,
        `release.commands[${index}].timeoutSeconds`,
      );
      return {
        id,
        command,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(env ? { env } : {}),
        ...(timeoutSeconds ? { timeoutSeconds } : {}),
      };
    }),
    ...releaseOutputs(recordField(request, "outputs")),
    ...releaseActivation(recordField(request, "activation")),
    providerConfigurations: releaseProviderConfigurations(
      isRecord(request) ? request.providerConfigurations : undefined,
    ),
  };
}

function releaseProviderConfigurations(
  value: unknown,
): ReleaseSpec["providerConfigurations"] {
  return value === undefined
    ? emptyProviderConfigurationsEnvelope()
    : parseProviderConfigurationsEnvelope(value);
}

export function releaseOutputs(
  value: unknown,
): { readonly outputs: JsonRecord } | Record<string, never> {
  return isRecord(value) ? { outputs: value } : {};
}

export function releaseActivation(
  value: unknown,
): { readonly activation: ReleaseActivationSpec } | Record<string, never> {
  if (!isRecord(value)) return {};
  const activation: ReleaseActivationSpec = {
    ...(stringField(value, "applyRunId")
      ? { applyRunId: stringField(value, "applyRunId") }
      : {}),
    ...(stringField(value, "workspaceId")
      ? { workspaceId: stringField(value, "workspaceId") }
      : {}),
    ...(stringField(value, "capsuleId")
      ? { capsuleId: stringField(value, "capsuleId") }
      : {}),
    ...(stringField(value, "stateVersionId")
      ? { stateVersionId: stringField(value, "stateVersionId") }
      : {}),
  };
  return Object.keys(activation).length > 0 ? { activation } : {};
}

export function releaseCommandEnv(
  envRecord: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isRecord(envRecord)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envRecord)) {
    if (isReservedProviderEnvName(key)) {
      throw new Error(`release command env must not override reserved ${key}`);
    }
    if (RUNNER_SECRET_ENV_NAME_PATTERN.test(key)) {
      throw new Error(
        `release command env must not include secret-like ${key}`,
      );
    }
    if (typeof value === "string") {
      if (RUNNER_SECRET_VALUE_PATTERN.test(value)) {
        throw new Error(
          `release command env value for ${key} looks secret-like`,
        );
      }
      env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function releaseCommandTimeoutSeconds(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())
        ? Number(value.trim())
        : undefined;
  if (
    parsed === undefined ||
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 6 * 60 * 60
  ) {
    throw new Error(`${label} must be an integer between 1 and 21600`);
  }
  return parsed;
}

function releaseCommandTimeoutMs(
  command: ReleaseCommandSpec,
): number | undefined {
  return command.timeoutSeconds ? command.timeoutSeconds * 1000 : undefined;
}

export function releaseCommandCwd(
  workspace: RunWorkspace,
  command: ReleaseCommandSpec,
): string {
  if (!command.workingDirectory) return workspace.sourceRoot;
  return join(workspace.sourceRoot, command.workingDirectory);
}

export function releaseBaseEnv(
  runId: string,
  release: ReleaseSpec,
): Record<string, string> {
  const outputs = release.outputs ?? {};
  const workspaceId = release.activation?.workspaceId;
  return {
    TAKOSUMI_RELEASE_RUN_ID: runId,
    ...(release.activation?.applyRunId
      ? { TAKOSUMI_APPLY_RUN_ID: release.activation.applyRunId }
      : {}),
    ...(workspaceId
      ? {
          TAKOSUMI_WORKSPACE_ID: workspaceId,
        }
      : {}),
    ...(release.activation?.capsuleId
      ? {
          TAKOSUMI_CAPSULE_ID: release.activation.capsuleId,
        }
      : {}),
    ...(release.activation?.stateVersionId
      ? {
          TAKOSUMI_STATE_VERSION_ID: release.activation.stateVersionId,
        }
      : {}),
    TAKOSUMI_OUTPUTS_JSON: JSON.stringify(outputs),
    TAKOSUMI_PROVIDER_CONFIGS_JSON: providerConfigurationsJson(
      release.providerConfigurations,
    ),
    TAKOSUMI_RELEASE_CONTEXT_JSON: JSON.stringify({
      kind: "takosumi.release-context@v1",
      releaseRunId: runId,
      ...(release.activation?.applyRunId
        ? { applyRunId: release.activation.applyRunId }
        : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(release.activation?.capsuleId
        ? {
            capsuleId: release.activation.capsuleId,
          }
        : {}),
      ...(release.activation?.stateVersionId
        ? { stateVersionId: release.activation.stateVersionId }
        : {}),
      outputs,
    }),
  };
}

export function parseBackupArtifactPointer(
  stdout: string,
): JsonRecord | undefined {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed)) continue;
      const ref = stringField(parsed, "ref");
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

export function isSafeBackupArtifactRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    !ref.includes("\0") &&
    !ref.includes("..") &&
    /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/u.test(ref)
  );
}
