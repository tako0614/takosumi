import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isProviderEnvName,
  isReservedProviderEnvName,
} from "../../contract/provider-env-rules.ts";
import type {
  CommandContext,
  PreparedRuntimeSecretFiles,
  RunWorkspace,
  RuntimeSecretFileDispatch,
  RuntimeSecretFilesDispatch,
} from "./types.ts";
import { isRecord, recordField } from "./util.ts";

const CONTRACT = "takosumi.runner-runtime-secret-files/v1";
const PROFILE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_SECRET_COUNT = 16;

export interface RuntimeSecretFileSystem {
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly lstat: (path: string) => ReturnType<typeof lstat>;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly open: (path: string, flags: number) => ReturnType<typeof open>;
  readonly rm: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
  readonly writeFile: (
    path: string,
    content: string,
    options: { readonly mode: 0o600; readonly flag: "wx" },
  ) => Promise<void>;
}

const NODE_RUNTIME_SECRET_FILE_SYSTEM: RuntimeSecretFileSystem = {
  chmod,
  lstat,
  mkdtemp,
  open,
  rm,
  writeFile,
};

export function runtimeSecretFilesFromRequest(
  request: unknown,
): RuntimeSecretFilesDispatch | undefined {
  const raw = recordField(request, "runtimeSecrets");
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !hasExactKeys(raw, ["contract", "profileDigest", "files"])) {
    invalid("runtime secret files payload is malformed");
  }
  if (
    raw.contract !== CONTRACT ||
    typeof raw.profileDigest !== "string" ||
    !PROFILE_DIGEST_PATTERN.test(raw.profileDigest) ||
    !Array.isArray(raw.files) ||
    raw.files.length !== 1
  ) {
    invalid("runtime secret files payload is malformed");
  }
  return {
    contract: CONTRACT,
    profileDigest: raw.profileDigest as `sha256:${string}`,
    files: [exactRuntimeSecretFile(raw.files[0])],
  };
}

export function assertReleaseCommandsDoNotOverrideRuntimeSecretEnv(
  commands: readonly { readonly env?: Readonly<Record<string, string>> }[],
  dispatch: RuntimeSecretFilesDispatch | undefined,
): void {
  if (!dispatch) return;
  const envName = dispatch.files[0].envName;
  if (commands.some((command) => Object.hasOwn(command.env ?? {}, envName))) {
    invalid("release command env must not override runtime secret file env");
  }
}

export async function prepareRuntimeSecretFiles(
  context: CommandContext,
  workspace: RunWorkspace,
  dispatch: RuntimeSecretFilesDispatch | undefined,
  fileSystemOverrides: Partial<RuntimeSecretFileSystem> = {},
): Promise<PreparedRuntimeSecretFiles> {
  if (!dispatch) return { context, cleanup: async () => {} };
  const fileSystem = {
    ...NODE_RUNTIME_SECRET_FILE_SYSTEM,
    ...fileSystemOverrides,
  };
  const file = dispatch.files[0];
  let runtimeDir: string | undefined;
  let target: string | undefined;
  try {
    runtimeDir = await fileSystem.mkdtemp(
      `${workspace.root}-runtime-secrets-`,
    );
    target = join(runtimeDir, file.path);
    await fileSystem.chmod(runtimeDir, 0o700);
    await fileSystem.writeFile(target, file.content, {
      mode: 0o600,
      flag: "wx",
    });
    await fileSystem.chmod(target, 0o600);
    const values = exactRuntimeSecretValues(file);
    const preparedRuntimeDir = runtimeDir;
    const preparedTarget = target;
    return {
      context: {
        ...context,
        env: { ...context.env, [file.envName]: preparedTarget },
        redactionValues: [
          ...(context.redactionValues ?? []),
          ...Object.values(values),
          file.content,
          preparedTarget,
        ],
      },
      cleanup: async () => {
        await removeRuntimeSecretDir(
          preparedRuntimeDir,
          preparedTarget,
          true,
          fileSystem,
        );
      },
    };
  } catch {
    if (runtimeDir !== undefined) {
      try {
        await removeRuntimeSecretDir(
          runtimeDir,
          target,
          false,
          fileSystem,
        );
      } catch {
        // Setup diagnostics are fixed and value-free even if cleanup also fails.
      }
    }
    throw new Error("runtime secret sandbox setup failed");
  }
}

async function removeRuntimeSecretDir(
  runtimeDir: string,
  target: string | undefined,
  requireTarget: boolean,
  fileSystem: RuntimeSecretFileSystem,
): Promise<void> {
  let failed = false;
  let targetExists = false;
  if (target !== undefined) {
    try {
      await fileSystem.lstat(target);
      targetExists = true;
    } catch (error) {
      if (!isMissingPath(error)) failed = true;
    }
  }
  if (requireTarget && !targetExists) failed = true;

  if (targetExists && target !== undefined) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await fileSystem.open(
        target,
        constants.O_WRONLY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CONTENT_BYTES) {
        failed = true;
      } else {
        await handle.truncate(0);
        await handle.sync();
      }
    } catch {
      failed = true;
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          failed = true;
        }
      }
    }
  }

  try {
    await fileSystem.rm(runtimeDir, { recursive: true, force: true });
  } catch {
    failed = true;
  }
  try {
    await fileSystem.lstat(runtimeDir);
    failed = true;
  } catch (error) {
    if (!isMissingPath(error)) failed = true;
  }
  if (failed) throw new Error("runtime secret sandbox cleanup failed");
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function exactRuntimeSecretFile(value: unknown): RuntimeSecretFileDispatch {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["path", "mode", "content", "envName", "secretNames"])
  ) {
    invalid("runtime secret file is malformed");
  }
  if (typeof value.path !== "string" || !FILE_NAME_PATTERN.test(value.path)) {
    invalid("runtime secret file path is unsafe");
  }
  if (value.mode !== 0o600) {
    invalid("runtime secret file mode must be 0600");
  }
  if (
    typeof value.content !== "string" ||
    new TextEncoder().encode(value.content).byteLength > MAX_CONTENT_BYTES
  ) {
    invalid("runtime secret file content is malformed");
  }
  if (
    typeof value.envName !== "string" ||
    !isProviderEnvName(value.envName) ||
    isReservedProviderEnvName(value.envName)
  ) {
    invalid("runtime secret file env name is unsafe");
  }
  if (
    !Array.isArray(value.secretNames) ||
    value.secretNames.length < 1 ||
    value.secretNames.length > MAX_SECRET_COUNT ||
    value.secretNames.some(
      (name) => typeof name !== "string" || !SECRET_NAME_PATTERN.test(name),
    )
  ) {
    invalid("runtime secret file secretNames are malformed");
  }
  const declaredSecretNames = value.secretNames as string[];
  const secretNames = [...declaredSecretNames].sort();
  if (
    new Set(secretNames).size !== secretNames.length ||
    secretNames.some((name, index) => name !== declaredSecretNames[index])
  ) {
    invalid("runtime secret file secretNames must be sorted and unique");
  }
  const file = {
    path: value.path,
    mode: 0o600,
    content: value.content,
    envName: value.envName,
    secretNames,
  } as const;
  exactRuntimeSecretValues(file);
  return file;
}

function exactRuntimeSecretValues(
  file: RuntimeSecretFileDispatch,
): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content) as unknown;
  } catch {
    invalid("runtime secret file content is malformed");
  }
  if (!isRecord(parsed)) invalid("runtime secret file content is malformed");
  const names = Object.keys(parsed).sort();
  if (
    names.length !== file.secretNames.length ||
    names.some((name, index) => name !== file.secretNames[index]) ||
    names.some((name) => typeof parsed[name] !== "string" || parsed[name] === "")
  ) {
    invalid("runtime secret file content differs from secretNames");
  }
  return Object.fromEntries(names.map((name) => [name, parsed[name] as string]));
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function invalid(message: string): never {
  throw new TypeError(message);
}
