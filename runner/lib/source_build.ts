import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  isRepositorySourceBuildOutputPath,
  isRepositorySourceBuildRelativePath,
} from "../../contract/repository-manifest.ts";
import type { CommandContext, SourceBuildConfig } from "./types.ts";
import { SOURCE_BUILD_CACHE_DIR_ENV } from "./constants.ts";
import {
  assertCommandEnvHasNoProviderCredentials,
  buildPhaseEnv,
} from "./credentials.ts";
import { runCommand } from "./exec.ts";
import { assertSafeRelativePath } from "./policy.ts";
import { redactBuildOutput } from "./redaction.ts";
import { assertDirectory, assertRealPathInsideSourceRoot } from "./util.ts";

const SOURCE_BUILD_ENV_NAMES = [
  "CI",
  "BUN_INSTALL_CACHE_DIR",
  "npm_config_cache",
  "XDG_CACHE_HOME",
] as const;
// Source-build output is user-controlled and can be copied into Run failure
// details. Redact before enforcing the bound so a credential-like assignment
// cannot be retained by an excerpt boundary.
const SOURCE_BUILD_OUTPUT_MAX_CHARS = 4_096;
const SOURCE_BUILD_OUTPUT_OMISSION = "\n... diagnostics omitted ...\n";

export async function runSourceBuild(
  sourceBuild: SourceBuildConfig | undefined,
  sourceRoot: string,
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  if (!sourceBuild) return undefined;
  await assertDirectory(sourceRoot, "source build root");

  const env = await sourceBuildEnv();
  assertCommandEnvHasNoProviderCredentials(env, SOURCE_BUILD_ENV_NAMES);
  const context: CommandContext = {
    env,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const logs: string[] = [];

  for (const [index, command] of sourceBuild.commands.entries()) {
    const relativeCwd = command.workingDirectory ?? ".";
    if (!isRepositorySourceBuildRelativePath(relativeCwd)) {
      throw new Error(
        `sourceBuild.commands[${index}].workingDirectory must satisfy the repository source-build path contract`,
      );
    }
    assertSafeRelativePath(
      relativeCwd,
      `sourceBuild.commands[${index}].workingDirectory`,
    );
    const cwd = resolve(sourceRoot, relativeCwd);
    await assertDirectory(cwd, `sourceBuild.commands[${index}] directory`);
    await assertRealPathInsideSourceRoot(
      cwd,
      sourceRoot,
      `sourceBuild.commands[${index}] directory`,
    );

    const result = await runCommand(command.argv, {
      cwd,
      context,
      isolateProcessGroup: true,
    });
    const commandLabel = `source build ${index + 1}/${sourceBuild.commands.length} (${command.argv[0]})`;
    const commandOutput = boundedBuildOutput(
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
    );
    logs.push([commandLabel, commandOutput].filter(Boolean).join("\n"));
    if (result.exitCode !== 0) {
      const diagnostic = boundedBuildOutput(
        result.stderr.trim() || result.stdout.trim(),
      );
      throw new Error(
        `${commandLabel} failed with exit code ${result.exitCode}${
          diagnostic ? `\noutput: ${diagnostic}` : ""
        }`,
      );
    }
  }

  for (const [index, output] of sourceBuild.outputs.entries()) {
    if (!isRepositorySourceBuildOutputPath(output)) {
      throw new Error(
        `sourceBuild.outputs[${index}] must satisfy the repository source-build output path contract`,
      );
    }
    assertSafeRelativePath(output, `sourceBuild.outputs[${index}]`);
    const outputPath = resolve(sourceRoot, output);
    try {
      await lstat(outputPath);
    } catch {
      throw new Error(`sourceBuild output was not produced: ${output}`);
    }
    await assertRealPathInsideSourceRoot(
      outputPath,
      sourceRoot,
      `sourceBuild.outputs[${index}]`,
    );
  }

  return boundedBuildOutput(logs.filter(Boolean).join("\n"));
}

function boundedBuildOutput(text: string): string {
  const redacted = redactBuildOutput(text.trim()).trim();
  if (redacted.length <= SOURCE_BUILD_OUTPUT_MAX_CHARS) return redacted;
  const retainedLength =
    SOURCE_BUILD_OUTPUT_MAX_CHARS - SOURCE_BUILD_OUTPUT_OMISSION.length;
  const headLength = Math.ceil(retainedLength / 2);
  const tailLength = retainedLength - headLength;
  return `${redacted.slice(0, headLength)}${SOURCE_BUILD_OUTPUT_OMISSION}${redacted.slice(-tailLength)}`;
}

async function sourceBuildEnv(): Promise<Record<string, string>> {
  const env = buildPhaseEnv();
  env.CI = "1";
  const cacheRoot = Bun.env[SOURCE_BUILD_CACHE_DIR_ENV]?.trim();
  if (!cacheRoot) return env;
  if (!isAbsolute(cacheRoot) || cacheRoot.includes("\0")) {
    throw new Error(`${SOURCE_BUILD_CACHE_DIR_ENV} must be an absolute path`);
  }
  const bunCache = join(cacheRoot, "bun");
  const npmCache = join(cacheRoot, "npm");
  const xdgCache = join(cacheRoot, "xdg");
  await Promise.all([
    mkdir(bunCache, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(xdgCache, { recursive: true }),
  ]);
  env.BUN_INSTALL_CACHE_DIR = bunCache;
  env.npm_config_cache = npmCache;
  env.XDG_CACHE_HOME = xdgCache;
  return env;
}
