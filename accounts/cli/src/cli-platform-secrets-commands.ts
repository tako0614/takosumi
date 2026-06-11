import process from "node:process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join as pathJoin, resolve } from "node:path";
import { booleanOption, optionalStringOption, parseOptions } from "./cli-options.ts";
import {
  platformSecretsApplyHelpText,
  platformSecretsHelpText,
  platformSecretsStatusHelpText,
} from "./cli-help.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";
import type { CliIo } from "./cli-io.ts";

export type CommandRunner = (
  args: readonly string[],
  input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: CommandRunner = async (args, input) => {
  const proc = Bun.spawn([...args], {
    stdin: input === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export async function runPlatformSecrets(
  args: string[],
  io: CliIo,
  runner: CommandRunner = defaultRunner,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(platformSecretsHelpText());
    return 0;
  }
  if (command === "status") return await runPlatformSecretsStatus(rest, io, runner);
  if (command === "apply") return await runPlatformSecretsApply(rest, io, runner);
  io.stderr(`Unknown platform-secrets command: ${command}`);
  io.stderr(platformSecretsHelpText());
  return 2;
}

type SecretClass =
  | "protected_key"
  | "rotate_safe_generated"
  | "manual_external";

type SecretManifestEntry = {
  readonly name: string;
  readonly secretClass: SecretClass;
  readonly generator?: () => string;
};

const SECRET_MANIFEST: readonly SecretManifestEntry[] = [
  {
    name: "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK",
    secretClass: "protected_key",
  },
  {
    name: "TAKOSUMI_ACCOUNTS_ES256_KEY_ID",
    secretClass: "protected_key",
  },
  {
    name: "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    secretClass: "protected_key",
  },
  {
    name: "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
    secretClass: "protected_key",
  },
  {
    name: "TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET",
    secretClass: "protected_key",
  },
  {
    name: "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
    secretClass: "rotate_safe_generated",
    generator: () => generateBase64UrlSecret(48),
  },
  {
    name: "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET",
    secretClass: "rotate_safe_generated",
    generator: () => generateBase64UrlSecret(48),
  },
  {
    name: "TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET",
    secretClass: "rotate_safe_generated",
    generator: () => generateBase64UrlSecret(32),
  },
  {
    name: "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET",
    secretClass: "manual_external",
  },
  {
    name: "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET",
    secretClass: "manual_external",
  },
  {
    name: "STRIPE_SECRET_KEY",
    secretClass: "manual_external",
  },
] as const;

const manifestByName = new Map(
  SECRET_MANIFEST.map((entry) => [entry.name, entry]),
);

export async function runPlatformSecretsStatus(
  args: string[],
  io: CliIo,
  runner: CommandRunner = defaultRunner,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(platformSecretsStatusHelpText());
    return 0;
  }
  try {
    const status = await platformSecretsStatus(options, runner);
    io.stdout(formatSecretStatus(status, booleanOption(options, "json")));
    return status.missingProtected.length === 0 &&
        status.remoteOnly.length === 0
      ? 0
      : 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runPlatformSecretsApply(
  args: string[],
  io: CliIo,
  runner: CommandRunner = defaultRunner,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(platformSecretsApplyHelpText());
    return 0;
  }
  try {
    const result = await applyPlatformSecrets(args, options, runner);
    io.stdout(formatSecretApply(result, booleanOption(options, "json")));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

export async function platformSecretsStatus(
  options: Record<string, string | boolean>,
  runner: CommandRunner = defaultRunner,
): Promise<{
  localNames: readonly string[];
  remoteNames: readonly string[];
  missingGenerated: readonly string[];
  missingProtected: readonly string[];
  remoteOnly: readonly string[];
  generatedPresent: readonly string[];
  protectedPresent: readonly string[];
  manualPresent: readonly string[];
  unknownLocal: readonly string[];
}> {
  const [localNames, remoteNames] = await Promise.all([
    listLocalSecretNames(options),
    listRemoteSecretNames(options, runner),
  ]);
  const local = new Set(localNames);
  const expected = new Set(SECRET_MANIFEST.map((entry) => entry.name));
  const generated = SECRET_MANIFEST.filter((entry) =>
    entry.secretClass === "rotate_safe_generated"
  ).map((entry) => entry.name);
  const protectedNames = SECRET_MANIFEST.filter((entry) =>
    entry.secretClass === "protected_key"
  ).map((entry) => entry.name);
  const manual = SECRET_MANIFEST.filter((entry) =>
    entry.secretClass === "manual_external"
  ).map((entry) => entry.name);
  return {
    localNames,
    remoteNames,
    missingGenerated: generated.filter((name) => !local.has(name)),
    missingProtected: protectedNames.filter((name) => !local.has(name)),
    remoteOnly: remoteNames.filter((name) => !local.has(name)),
    generatedPresent: generated.filter((name) => local.has(name)),
    protectedPresent: protectedNames.filter((name) => local.has(name)),
    manualPresent: manual.filter((name) => local.has(name)),
    unknownLocal: localNames.filter((name) => !expected.has(name)),
  };
}

async function applyPlatformSecrets(
  rawArgs: readonly string[],
  options: Record<string, string | boolean>,
  runner: CommandRunner,
): Promise<{
  dryRun: boolean;
  generated: readonly string[];
  regenerated: readonly string[];
  pushed: readonly string[];
  planned: readonly string[];
}> {
  const dryRun = booleanOption(options, "dryRun");
  const dir = secretsDir(options);
  if (!dryRun) await mkdir(dir, { recursive: true });

  const regenerate = parseRegenerateOptions(rawArgs);
  const localFilesBefore = await listLocalSecretFiles(options).catch((error) => {
    if (dryRun && isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  });
  const localBefore = new Map(localFilesBefore.map((file) => [file.name, file]));
  const generated: string[] = [];
  const regenerated: string[] = [];

  for (const entry of SECRET_MANIFEST) {
    if (entry.secretClass !== "rotate_safe_generated" || !entry.generator) {
      continue;
    }
    const shouldRegenerate = regenerate.has(entry.name);
    if (localBefore.has(entry.name) && !shouldRegenerate) continue;
    if (dryRun) {
      if (shouldRegenerate) regenerated.push(entry.name);
      else generated.push(entry.name);
      continue;
    }
    await writeSecretFile(dir, entry.name, entry.generator());
    if (shouldRegenerate) regenerated.push(entry.name);
    else generated.push(entry.name);
  }

  const files = dryRun
    ? plannedLocalFilesAfterDryRun(localFilesBefore, generated, regenerated, dir)
    : await listLocalSecretFiles(options);
  if (files.length === 0) {
    throw new TypeError("no local secret files found");
  }
  if (!dryRun) {
    for (const file of files) {
      await putRemoteSecret(file.name, file.path, options, runner);
    }
  }
  const names = files.map((file) => file.name);
  return {
    dryRun,
    generated,
    regenerated,
    pushed: dryRun ? [] : names,
    planned: names,
  };
}

function parseRegenerateOptions(rawArgs: readonly string[]): Set<string> {
  const requested: string[] = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--regenerate") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new TypeError("--regenerate requires a secret name");
      }
      requested.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--regenerate=")) {
      requested.push(arg.slice("--regenerate=".length));
    }
  }
  const rotateSafe = SECRET_MANIFEST.filter((entry) =>
    entry.secretClass === "rotate_safe_generated"
  ).map((entry) => entry.name);
  const output = new Set<string>();
  for (const name of requested) {
    if (name === "rotate-safe") {
      for (const secret of rotateSafe) output.add(secret);
      continue;
    }
    const entry = manifestByName.get(name);
    if (!entry) {
      throw new TypeError(`unknown managed platform secret: ${name}`);
    }
    if (entry.secretClass !== "rotate_safe_generated") {
      throw new TypeError(`${name} is ${entry.secretClass} and cannot be regenerated by apply`);
    }
    output.add(name);
  }
  return output;
}

async function listLocalSecretNames(
  options: Record<string, string | boolean>,
): Promise<readonly string[]> {
  return (await listLocalSecretFiles(options)).map((file) => file.name);
}

async function listLocalSecretFiles(
  options: Record<string, string | boolean>,
): Promise<readonly { name: string; path: string }[]> {
  const dir = secretsDir(options);
  const entries = await readdir(dir);
  const files: { name: string; path: string }[] = [];
  for (const name of entries.sort()) {
    if (name === ".gitignore" || name.startsWith(".")) continue;
    const path = pathJoin(dir, name);
    if (!(await stat(path)).isFile()) continue;
    files.push({ name, path });
  }
  return files;
}

function plannedLocalFilesAfterDryRun(
  existing: readonly { name: string; path: string }[],
  generated: readonly string[],
  regenerated: readonly string[],
  dir: string,
): readonly { name: string; path: string }[] {
  const names = new Set(existing.map((file) => file.name));
  for (const name of generated) names.add(name);
  for (const name of regenerated) names.add(name);
  return [...names].sort().map((name) => ({ name, path: pathJoin(dir, name) }));
}

async function listRemoteSecretNames(
  options: Record<string, string | boolean>,
  runner: CommandRunner,
): Promise<readonly string[]> {
  const result = await runner([
    "bunx",
    "wrangler",
    "secret",
    "list",
    "--config",
    wranglerConfig(options),
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "wrangler secret list failed");
  }
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("wrangler secret list returned invalid JSON");
  return parsed.map((entry) => {
    if (!isRecord(entry)) return undefined;
    return stringValue(entry.name);
  }).filter((name): name is string => Boolean(name)).sort();
}

async function putRemoteSecret(
  name: string,
  localSecretPath: string,
  options: Record<string, string | boolean>,
  runner: CommandRunner,
): Promise<void> {
  const value = await readFile(localSecretPath, "utf8");
  const result = await runner([
    "bunx",
    "wrangler",
    "secret",
    "put",
    name,
    "--config",
    wranglerConfig(options),
  ], value);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `wrangler secret put ${name} failed`);
  }
}

function wranglerConfig(options: Record<string, string | boolean>): string {
  const value = optionalStringOption(options, "config") ??
    process.env.TAKOSUMI_WRANGLER_CONFIG ??
    defaultWranglerConfig();
  if (!value) {
    throw new TypeError(
      "--config or TAKOSUMI_WRANGLER_CONFIG is required; no sibling takosumi-private/platform/wrangler.toml was found",
    );
  }
  return value;
}

function secretsDir(options: Record<string, string | boolean>): string {
  const value = optionalStringOption(options, "secretsDir") ??
    process.env.TAKOSUMI_SECRETS ??
    defaultSecretsDir();
  if (!value) {
    throw new TypeError(
      "--secrets-dir or TAKOSUMI_SECRETS is required; no sibling takosumi-private/.secrets/<env> was found",
    );
  }
  return value;
}

function defaultWranglerConfig(): string | undefined {
  const privateRoot = findTakosumiPrivateRoot();
  if (!privateRoot) return undefined;
  const candidate = pathJoin(privateRoot, "platform", "wrangler.toml");
  return existsSync(candidate) ? candidate : undefined;
}

function defaultSecretsDir(): string | undefined {
  const privateRoot = findTakosumiPrivateRoot();
  if (!privateRoot) return undefined;
  const env = process.env.TAKOSUMI_ENV || "production";
  const candidate = pathJoin(privateRoot, ".secrets", env);
  return existsSync(candidate) ? candidate : undefined;
}

function findTakosumiPrivateRoot(): string | undefined {
  let current = resolve(process.cwd());
  while (true) {
    const sameLevel = pathJoin(current, "takosumi-private");
    if (existsSync(sameLevel)) return sameLevel;
    const sibling = pathJoin(dirname(current), "takosumi-private");
    if (existsSync(sibling)) return sibling;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function formatSecretStatus(
  input: {
    localNames: readonly string[];
    remoteNames: readonly string[];
    missingGenerated: readonly string[];
    missingProtected: readonly string[];
    remoteOnly: readonly string[];
    generatedPresent: readonly string[];
    protectedPresent: readonly string[];
    manualPresent: readonly string[];
    unknownLocal: readonly string[];
  },
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(input, null, 2);
  return [
    `Local secrets: ${input.localNames.length}`,
    `Remote secrets: ${input.remoteNames.length}`,
    `Generated present: ${input.generatedPresent.length ? input.generatedPresent.join(", ") : "none"}`,
    `Protected present: ${input.protectedPresent.length ? input.protectedPresent.join(", ") : "none"}`,
    `Manual present: ${input.manualPresent.length ? input.manualPresent.join(", ") : "none"}`,
    `Missing generated: ${input.missingGenerated.length ? input.missingGenerated.join(", ") : "none"}`,
    `Missing protected: ${input.missingProtected.length ? input.missingProtected.join(", ") : "none"}`,
    `Unknown local: ${input.unknownLocal.length ? input.unknownLocal.join(", ") : "none"}`,
    `Remote only: ${input.remoteOnly.length ? input.remoteOnly.join(", ") : "none"}`,
  ].join("\n");
}

function formatSecretApply(
  result: {
    dryRun: boolean;
    generated: readonly string[];
    regenerated: readonly string[];
    pushed: readonly string[];
    planned: readonly string[];
  },
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(result, null, 2);
  const verb = result.dryRun ? "Would push" : "Pushed";
  return [
    `Generated: ${result.generated.length ? result.generated.join(", ") : "none"}`,
    `Regenerated: ${result.regenerated.length ? result.regenerated.join(", ") : "none"}`,
    `${verb} ${result.planned.length} platform secret(s): ${result.planned.join(", ")}`,
  ].join("\n");
}

async function writeSecretFile(
  dir: string,
  name: string,
  value: string,
): Promise<void> {
  const path = pathJoin(dir, name);
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

function generateBase64UrlSecret(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === code;
}
