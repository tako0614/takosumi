// runner/lib/backup.ts
//
// Backup / release execution + their request parsing.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isReservedProviderEnvName } from "../../contract/provider-env-rules.ts";
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
  PROVIDER_SNAPSHOT_COMMAND_ENV,
  PROVIDER_SNAPSHOT_COMMAND_ENV_PREFIX,
  PROVIDER_SNAPSHOT_POINTER_DIR_ENV,
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
  allKnownCredentialEnvNames,
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

export function providerSnapshotCommand(
  provider: string | undefined,
): { readonly command: string; readonly envName: string } | undefined {
  for (const envName of providerSnapshotCommandEnvNames(provider)) {
    const command = Bun.env[envName]?.trim();
    if (command) return { command, envName };
  }
  return undefined;
}

export function providerSnapshotCommandEnvNames(
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

export function providerSnapshotEnvSuffix(provider: string): string {
  return provider
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function runBuiltInProviderSnapshotBackup(
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

export async function readFirstExistingPointer(
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

export function providerSnapshotPointerPaths(
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

export async function runBuiltInNativeProviderSnapshotBackup(
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

export function normalizeProviderSource(provider: string | undefined): string {
  const value = provider?.trim().toLowerCase();
  if (!value) return "";
  if (value.includes("/")) return value;
  if (value === "cloudflare")
    return "registry.opentofu.org/cloudflare/cloudflare";
  if (value === "aws") return "registry.opentofu.org/hashicorp/aws";
  return value;
}

export function builtInProviderSnapshotKind(
  provider: string,
): string | undefined {
  if (provider === "registry.opentofu.org/cloudflare/cloudflare") {
    return "cloudflare-provider-snapshot";
  }
  if (provider === "registry.opentofu.org/hashicorp/aws") {
    return "aws-provider-snapshot";
  }
  return undefined;
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
  };
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
    ...(stringField(value, "spaceId")
      ? { spaceId: stringField(value, "spaceId") }
      : {}),
    ...(stringField(value, "installationId")
      ? { installationId: stringField(value, "installationId") }
      : {}),
    ...(stringField(value, "deploymentId")
      ? { deploymentId: stringField(value, "deploymentId") }
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
    if (allKnownCredentialEnvNames().has(key)) {
      throw new Error(
        `command env unexpectedly carries provider credential env name ${key}`,
      );
    }
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
  const workspaceId =
    release.activation?.workspaceId ?? release.activation?.spaceId;
  return {
    TAKOSUMI_RELEASE_RUN_ID: runId,
    ...(release.activation?.applyRunId
      ? { TAKOSUMI_APPLY_RUN_ID: release.activation.applyRunId }
      : {}),
    ...(workspaceId
      ? {
          TAKOSUMI_WORKSPACE_ID: workspaceId,
          TAKOSUMI_SPACE_ID: workspaceId,
          TAKOSUMI_CLOUD_BILLING_WORKSPACE_ID: workspaceId,
        }
      : {}),
    ...(release.activation?.installationId
      ? {
          TAKOSUMI_CAPSULE_ID: release.activation.installationId,
          TAKOSUMI_CLOUD_BILLING_CAPSULE_ID: release.activation.installationId,
        }
      : {}),
    ...(release.activation?.deploymentId
      ? {
          TAKOSUMI_STATE_VERSION_ID: release.activation.deploymentId,
        }
      : {}),
    TAKOSUMI_OUTPUTS_JSON: JSON.stringify(outputs),
    TAKOSUMI_RELEASE_CONTEXT_JSON: JSON.stringify({
      kind: "takosumi.release-context@v1",
      releaseRunId: runId,
      ...(release.activation?.applyRunId
        ? { applyRunId: release.activation.applyRunId }
        : {}),
      ...(workspaceId ? { workspaceId, spaceId: workspaceId } : {}),
      ...(release.activation?.installationId
        ? {
            installationId: release.activation.installationId,
            capsuleId: release.activation.installationId,
            installation: { id: release.activation.installationId },
          }
        : {}),
      ...(release.activation?.deploymentId
        ? { deploymentId: release.activation.deploymentId }
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

export function isSafeBackupArtifactRef(ref: string): boolean {
  if (ref.length === 0 || ref.includes("\0")) return false;
  if (/^https?:\/\//i.test(ref)) return false;
  if (/^r2:\/\/[A-Za-z0-9._-]+\/[^\s]+$/u.test(ref)) return true;
  return /^[A-Za-z0-9._/@:+-]+$/u.test(ref) && !ref.includes("..");
}
