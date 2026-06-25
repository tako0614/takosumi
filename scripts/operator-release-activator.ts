#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import {
  isReservedProviderEnvName,
  PROVIDER_CREDENTIAL_ENV_RULES,
} from "../contract/provider-env-rules.ts";

const RELEASE_ACTIVATION_KIND = "takosumi.operator.release-activation@v1";
const DEFAULT_WORK_ROOT = join(tmpdir(), "takosumi-release-activator");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8797;

interface ReleaseActivationPayload {
  readonly kind: typeof RELEASE_ACTIVATION_KIND;
  readonly planRunId?: string;
  readonly applyRunId: string;
  readonly spaceId?: string;
  readonly installation?: {
    readonly id?: string;
    readonly name?: string;
    readonly environment?: string;
  };
  readonly deployment?: {
    readonly id?: string;
  };
  readonly sourceSnapshot: {
    readonly archiveObjectKey: string;
    readonly archiveDigest: string;
  };
  readonly nonSensitiveOutputs?: Readonly<Record<string, unknown>>;
  readonly commands: readonly ReleaseActivationCommand[];
}

interface ReleaseActivationCommand {
  readonly id: string;
  readonly command: readonly string[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly executor?: "runner" | "operator";
}

interface WranglerR2GetInput {
  readonly bucket: string;
  readonly key: string;
  readonly file: string;
  readonly config?: string;
  readonly env?: string;
  readonly jurisdiction?: string;
}

interface RunReleaseOptions {
  readonly sourceBucket?: string;
  readonly wranglerConfig?: string;
  readonly wranglerEnv?: string;
  readonly jurisdiction?: string;
  readonly workRoot?: string;
  readonly keepWorkdir?: boolean;
  readonly downloadArchive?: (
    payload: ReleaseActivationPayload,
    archivePath: string,
  ) => Promise<void>;
  readonly operatorEnv?: Readonly<Record<string, string | undefined>>;
  readonly commandEnv?: Readonly<Record<string, string | undefined>>;
}

interface ServeOptions extends RunReleaseOptions {
  readonly token: string;
  readonly host: string;
  readonly port: number;
}

interface ReleaseActivationResponse {
  readonly status: "succeeded" | "failed";
  readonly kind: string;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const PROVIDER_CREDENTIAL_ENV_NAMES = new Set(
  PROVIDER_CREDENTIAL_ENV_RULES.flatMap((rule) => rule.envNames),
);
const BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "WRANGLER_HOME",
] as const;
const WRANGLER_AUTH_ENV_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_API_KEY",
  "CF_API_TOKEN",
  "CF_ACCOUNT_ID",
] as const;

export function buildWranglerR2GetArgs(input: WranglerR2GetInput): string[] {
  const args = [
    "wrangler",
    "r2",
    "object",
    "get",
    `${input.bucket}/${input.key}`,
    "--file",
    input.file,
    "--remote",
  ];
  if (input.config) args.push("--config", input.config);
  if (input.env) args.push("--env", input.env);
  if (input.jurisdiction) args.push("--jurisdiction", input.jurisdiction);
  return args;
}

export async function runReleaseActivation(
  rawPayload: unknown,
  options: RunReleaseOptions = {},
): Promise<ReleaseActivationResponse> {
  const payload = parsePayload(rawPayload);
  const workRoot = options.workRoot ?? DEFAULT_WORK_ROOT;
  await mkdir(workRoot, { recursive: true });
  const workdir = await mkdtemp(join(workRoot, "release-"));
  const archivePath = join(workdir, "source.tar.zst");
  const sourceRoot = join(workdir, "source");
  try {
    if (options.downloadArchive) {
      await options.downloadArchive(payload, archivePath);
    } else {
      await downloadArchiveWithWrangler(payload, archivePath, options);
    }
    await verifyArchiveDigest(
      archivePath,
      payload.sourceSnapshot.archiveDigest,
    );
    await extractSourceArchive(archivePath, sourceRoot);
    const commandIds: string[] = [];
    for (const command of payload.commands) {
      runReleaseCommand(payload, command, sourceRoot, options.commandEnv);
      commandIds.push(command.id);
    }
    return {
      status: "succeeded",
      kind: "takosumi.operator.release-commands@v1",
      message: `ran ${commandIds.length} operator release command(s)`,
      metadata: {
        applyRunId: payload.applyRunId,
        commandCount: commandIds.length,
        commandIds,
      },
    };
  } finally {
    if (options.keepWorkdir !== true) {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}

export function parsePayload(raw: unknown): ReleaseActivationPayload {
  const value = asRecord(raw, "payload");
  if (value.kind !== RELEASE_ACTIVATION_KIND) {
    throw new Error("release activation payload kind is invalid");
  }
  const applyRunId = nonEmptyString(value.applyRunId, "applyRunId");
  const sourceSnapshot = asRecord(value.sourceSnapshot, "sourceSnapshot");
  const archiveObjectKey = nonEmptyString(
    sourceSnapshot.archiveObjectKey,
    "sourceSnapshot.archiveObjectKey",
  );
  const archiveDigest = nonEmptyString(
    sourceSnapshot.archiveDigest,
    "sourceSnapshot.archiveDigest",
  );
  assertSafeArchiveObjectKey(archiveObjectKey);
  assertSha256Digest(archiveDigest, "sourceSnapshot.archiveDigest");
  const commands = parseCommands(value.commands);
  return {
    kind: RELEASE_ACTIVATION_KIND,
    ...(typeof value.planRunId === "string"
      ? { planRunId: value.planRunId }
      : {}),
    applyRunId,
    ...(typeof value.spaceId === "string" ? { spaceId: value.spaceId } : {}),
    ...(isRecord(value.installation)
      ? { installation: pickInstallation(value.installation) }
      : {}),
    ...(isRecord(value.deployment)
      ? { deployment: pickDeployment(value.deployment) }
      : {}),
    sourceSnapshot: { archiveObjectKey, archiveDigest },
    ...(isRecord(value.nonSensitiveOutputs)
      ? { nonSensitiveOutputs: value.nonSensitiveOutputs }
      : {}),
    commands,
  };
}

function parseCommands(raw: unknown): readonly ReleaseActivationCommand[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("release activation commands must be a non-empty array");
  }
  if (raw.length > 20)
    throw new Error("release activation command limit is 20");
  return raw.map((entry, index) => {
    const value = asRecord(entry, `commands[${index}]`);
    const id =
      typeof value.id === "string" && value.id.trim()
        ? value.id.trim()
        : `post_apply_${index + 1}`;
    const command = parseArgv(value.command, `commands[${index}].command`);
    const workingDirectory =
      typeof value.workingDirectory === "string" &&
      value.workingDirectory.trim()
        ? value.workingDirectory.trim()
        : undefined;
    if (workingDirectory) assertSafeRelativePath(workingDirectory);
    const env = parseCommandEnv(value.env);
    const executor = parseExecutor(value.executor, `commands[${index}]`);
    if (executor !== "operator") {
      throw new Error(
        `commands[${index}].executor must be operator for operator release activation`,
      );
    }
    return {
      id,
      command,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(env ? { env } : {}),
      executor,
    };
  });
}

function parseExecutor(
  value: unknown,
  label: string,
): "runner" | "operator" | undefined {
  if (value === undefined) return undefined;
  if (value === "operator" || value === "runner") return value;
  throw new Error(`${label}.executor is invalid`);
}

function parseArgv(raw: unknown, label: string): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return raw.map((part, index) => {
    const value = nonEmptyString(part, `${label}[${index}]`);
    if (/[\0\r\n]/u.test(value)) {
      throw new Error(`${label}[${index}] must not contain control characters`);
    }
    return value;
  });
}

function parseCommandEnv(
  raw: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isRecord(raw)) return undefined;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) continue;
    if (PROVIDER_CREDENTIAL_ENV_NAMES.has(name)) {
      throw new Error(`release command env must not include ${name}`);
    }
    if (name === "TAKOSUMI_RELEASE_ACTIVATOR_TOKEN") {
      throw new Error("release command env must not include activator token");
    }
    if (isReservedProviderEnvName(name)) {
      throw new Error(`release command env must not override reserved ${name}`);
    }
    if (typeof value === "string") env[name] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

async function downloadArchiveWithWrangler(
  payload: ReleaseActivationPayload,
  archivePath: string,
  options: RunReleaseOptions,
): Promise<void> {
  const bucket = options.sourceBucket?.trim();
  if (!bucket) {
    throw new Error(
      "source bucket is required to fetch release source archive",
    );
  }
  await mkdir(dirname(archivePath), { recursive: true });
  const args = buildWranglerR2GetArgs({
    bucket,
    key: payload.sourceSnapshot.archiveObjectKey,
    file: archivePath,
    ...(options.wranglerConfig ? { config: options.wranglerConfig } : {}),
    ...(options.wranglerEnv ? { env: options.wranglerEnv } : {}),
    ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}),
  });
  const result = spawnSync("bunx", args, {
    encoding: "utf8",
    env: materializerToolEnv(options.operatorEnv),
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler r2 object get failed (${result.status ?? "unknown"}): ${result.stderr}`,
    );
  }
}

async function verifyArchiveDigest(
  archivePath: string,
  expectedDigest: string,
): Promise<void> {
  const bytes = await readFile(archivePath);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== expectedDigest) {
    throw new Error(`source archive digest mismatch: ${actual}`);
  }
}

async function extractSourceArchive(
  archivePath: string,
  sourceRoot: string,
): Promise<void> {
  await mkdir(sourceRoot, { recursive: true });
  const list = spawnSync(
    "tar",
    ["-t", "--zstd", "--quoting-style=escape", "-f", archivePath],
    { encoding: "utf8" },
  );
  if (list.status !== 0) {
    throw new Error(`source archive list failed: ${list.stderr}`);
  }
  for (const entry of list.stdout.split(/\r?\n/u)) {
    const path = entry.trim();
    if (!path) continue;
    assertSafeRelativePath(path);
  }
  const extract = spawnSync(
    "tar",
    ["-x", "--zstd", "-f", archivePath, "-C", sourceRoot],
    {
      encoding: "utf8",
    },
  );
  if (extract.status !== 0) {
    throw new Error(`source archive extract failed: ${extract.stderr}`);
  }
}

function runReleaseCommand(
  payload: ReleaseActivationPayload,
  command: ReleaseActivationCommand,
  sourceRoot: string,
  parentEnv: Readonly<Record<string, string | undefined>> | undefined,
): void {
  const cwd = command.workingDirectory
    ? resolve(sourceRoot, command.workingDirectory)
    : sourceRoot;
  assertInside(cwd, sourceRoot, `release command ${command.id} cwd`);
  const env = {
    ...materializerBaseEnv(parentEnv),
    TAKOSUMI_RELEASE_RUN_ID: `operator_${payload.applyRunId}_${randomUUID()}`,
    TAKOSUMI_APPLY_RUN_ID: payload.applyRunId,
    ...(payload.installation?.id
      ? { TAKOSUMI_INSTALLATION_ID: payload.installation.id }
      : {}),
    ...(payload.deployment?.id
      ? { TAKOSUMI_DEPLOYMENT_ID: payload.deployment.id }
      : {}),
    TAKOSUMI_OUTPUTS_JSON: JSON.stringify(payload.nonSensitiveOutputs ?? {}),
    ...(command.env ?? {}),
  };
  assertNoCredentialEnv(env);
  const [cmd, ...args] = command.command;
  const result = spawnSync(cmd!, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `release command failed (${result.status ?? "unknown"}): ${command.id}\n${result.stderr}`,
    );
  }
}

function materializerBaseEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") next[name] = value;
  }
  if (!next.PATH) next.PATH = "/usr/local/bin:/usr/bin:/bin";
  if (!next.HOME && env.HOME) next.HOME = env.HOME;
  return next;
}

function materializerToolEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const next = materializerBaseEnv(env);
  for (const name of WRANGLER_AUTH_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") next[name] = value;
  }
  return next;
}

function assertNoCredentialEnv(env: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(env)) {
    if (PROVIDER_CREDENTIAL_ENV_NAMES.has(name)) {
      throw new Error(`release command env unexpectedly carries ${name}`);
    }
  }
}

function pickInstallation(
  value: Record<string, unknown>,
): ReleaseActivationPayload["installation"] {
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.environment === "string"
      ? { environment: value.environment }
      : {}),
  };
}

function pickDeployment(
  value: Record<string, unknown>,
): ReleaseActivationPayload["deployment"] {
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
  };
}

function assertSafeArchiveObjectKey(key: string): void {
  if (!key.startsWith("spaces/") || key.includes("..") || key.includes("\\")) {
    throw new Error("source archive object key is invalid");
  }
  assertSafeRelativePath(key);
}

function assertSha256Digest(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be sha256:<hex>`);
  }
}

function assertSafeRelativePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    /[\0\r\n]/u.test(path) ||
    path.split(/[\\/]+/u).some((segment) => segment === "..")
  ) {
    throw new Error(`unsafe relative path: ${path}`);
  }
}

function assertInside(path: string, root: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw new Error(`${label} must stay inside source root`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseCliArgs(argv: readonly string[]) {
  const [mode, ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "keep-workdir") {
      flags.add(key);
      continue;
    }
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    values.set(key, value);
    i += 1;
  }
  return { mode, values, flags };
}

function optionsFromCli(values: Map<string, string>, flags: Set<string>) {
  return {
    sourceBucket:
      values.get("source-bucket") ?? process.env.TAKOSUMI_RELEASE_SOURCE_BUCKET,
    wranglerConfig:
      values.get("wrangler-config") ??
      process.env.TAKOSUMI_RELEASE_WRANGLER_CONFIG,
    wranglerEnv:
      values.get("wrangler-env") ?? process.env.TAKOSUMI_RELEASE_WRANGLER_ENV,
    jurisdiction:
      values.get("jurisdiction") ??
      process.env.TAKOSUMI_RELEASE_R2_JURISDICTION,
    workRoot: values.get("work-root") ?? process.env.TAKOSUMI_RELEASE_WORK_ROOT,
    keepWorkdir: flags.has("keep-workdir"),
  };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const { mode, values, flags } = parseCliArgs(argv);
  if (mode === "run") {
    const payloadPath = values.get("payload");
    if (!payloadPath) throw new Error("--payload is required for run mode");
    const payload = JSON.parse(await readFile(payloadPath, "utf8")) as unknown;
    const result = await runReleaseActivation(
      payload,
      optionsFromCli(values, flags),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (mode === "serve") {
    const token =
      values.get("token") ?? process.env.TAKOSUMI_RELEASE_ACTIVATOR_TOKEN;
    if (!token) throw new Error("release activator token is required");
    serveReleaseActivator({
      ...optionsFromCli(values, flags),
      token,
      host:
        values.get("host") ?? process.env.TAKOSUMI_RELEASE_HOST ?? DEFAULT_HOST,
      port: Number(
        values.get("port") ?? process.env.TAKOSUMI_RELEASE_PORT ?? DEFAULT_PORT,
      ),
    });
    return;
  }
  throw new Error("usage: operator-release-activator.ts <serve|run> ...");
}

export function serveReleaseActivator(options: ServeOptions): void {
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    async fetch(request) {
      if (request.method !== "POST") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const expected = `Bearer ${options.token}`;
      if (request.headers.get("authorization") !== expected) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      try {
        const result = await runReleaseActivation(
          await request.json(),
          options,
        );
        return Response.json(result);
      } catch (error) {
        return Response.json(
          {
            status: "failed",
            kind: "takosumi.operator.release-commands@v1",
            message: error instanceof Error ? error.message : String(error),
          },
          { status: 500 },
        );
      }
    },
  });
  console.log(
    `Takosumi operator release activator listening on http://${server.hostname}:${server.port}`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
