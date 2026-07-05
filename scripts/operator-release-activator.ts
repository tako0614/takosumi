#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isReservedProviderEnvName,
  PROVIDER_CREDENTIAL_ENV_RULES,
} from "../contract/provider-env-rules.ts";

const RELEASE_ACTIVATION_KIND = "takosumi.operator.release-activation@v1";
const DEFAULT_WORK_ROOT = defaultReleaseWorkRoot();
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8797;
const USAGE = "usage: operator-release-activator.ts <serve|run> ...";

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
  readonly commandEnvAllowlist?: readonly string[];
}

interface ServeOptions extends RunReleaseOptions {
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly runActivation?: (
    payload: ReleaseActivationPayload,
    options: RunReleaseOptions,
    jobId: string,
  ) => Promise<ReleaseActivationResponse>;
}

interface ReleaseActivationResponse {
  readonly status: "pending" | "succeeded" | "failed";
  readonly kind: string;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

type ReleaseActivationJobStatus =
  "pending" | "running" | "succeeded" | "failed";

interface ReleaseActivationJob {
  readonly id: string;
  readonly payload: ReleaseActivationPayload;
  readonly createdAt: string;
  status: ReleaseActivationJobStatus;
  updatedAt: string;
  result?: ReleaseActivationResponse;
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
const SECRET_ENV_NAME_RE =
  /(?:^|[_-])(?:token|secret|password|passwd|credential|auth|bearer|session|cookie|key)(?:$|[_-])|(?:^|[_-])(?:database|db|postgres|postgresql|mysql|mariadb|redis|mongo|mongodb|libsql|sqlite)[_-]?(?:url|uri|dsn)(?:$|[_-])|(?:^|[_-])(?:dsn|connection[_-]?string)(?:$|[_-])/i;
const SECRET_ENV_VALUE_RE =
  /(?:token|secret|password|passwd|credential|auth|bearer|session|cookie|key|database[_-]?url|connection[_-]?string|\bdsn\b|(?:postgres(?:ql)?|mysql|mariadb|redis|mongo|mongodb|libsql|sqlite):\/\/|:\/\/[^/\s:@]+:[^@\s]+@)/i;
const activeServers: Array<ReturnType<typeof Bun.serve>> = [];
const keepAliveTimers: Array<ReturnType<typeof setInterval>> = [];

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
  const runtimeRoot = join(workdir, "runtime");
  await prepareRuntimeRoot(runtimeRoot);
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
      runReleaseCommand(
        payload,
        command,
        sourceRoot,
        runtimeRoot,
        options.commandEnv,
        options.commandEnvAllowlist,
      );
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
    if (SECRET_ENV_NAME_RE.test(name)) {
      throw new Error(
        `release command env must not include secret-like ${name}`,
      );
    }
    if (isReservedProviderEnvName(name)) {
      throw new Error(`release command env must not override reserved ${name}`);
    }
    if (typeof value === "string") {
      if (SECRET_ENV_VALUE_RE.test(value)) {
        throw new Error(
          `release command env value for ${name} looks secret-like`,
        );
      }
      env[name] = value;
    }
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
  const runtimeRoot = join(dirname(archivePath), "tool-runtime");
  await prepareRuntimeRoot(runtimeRoot);
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
    env: materializerToolEnv(options.operatorEnv, runtimeRoot),
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
  runtimeRoot: string,
  parentEnv: Readonly<Record<string, string | undefined>> | undefined,
  commandEnvAllowlist: readonly string[] | undefined,
): void {
  const cwd = command.workingDirectory
    ? resolve(sourceRoot, command.workingDirectory)
    : sourceRoot;
  assertInside(cwd, sourceRoot, `release command ${command.id} cwd`);
  const releaseRunId = `operator_${payload.applyRunId}_${randomUUID()}`;
  const outputs = payload.nonSensitiveOutputs ?? {};
  const explicitOperatorEnv = materializerAllowedCommandEnv(
    parentEnv,
    commandEnvAllowlist,
  );
  const env = {
    ...materializerBaseEnv(parentEnv),
    ...explicitOperatorEnv,
    TAKOSUMI_RELEASE_RUN_ID: releaseRunId,
    TAKOSUMI_APPLY_RUN_ID: payload.applyRunId,
    ...(payload.installation?.id
      ? { TAKOSUMI_CAPSULE_ID: payload.installation.id }
      : {}),
    ...(payload.deployment?.id
      ? { TAKOSUMI_STATE_VERSION_ID: payload.deployment.id }
      : {}),
    TAKOSUMI_OUTPUTS_JSON: JSON.stringify(outputs),
    TAKOSUMI_RELEASE_CONTEXT_JSON: JSON.stringify({
      kind: "takosumi.release-context@v1",
      releaseRunId,
      ...(payload.planRunId ? { planRunId: payload.planRunId } : {}),
      applyRunId: payload.applyRunId,
      ...(payload.spaceId ? { workspaceId: payload.spaceId } : {}),
      ...(payload.installation ? { installation: payload.installation } : {}),
      ...(payload.deployment ? { deployment: payload.deployment } : {}),
      outputs,
    }),
    ...(command.env ?? {}),
    ...materializerRuntimeEnv(runtimeRoot),
  };
  assertNoUnexpectedCredentialEnv(
    env,
    new Set(Object.keys(explicitOperatorEnv)),
  );
  const [cmd, ...args] = command.command;
  const result = spawnSync(cmd!, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const stdoutTail = tailText(result.stdout);
    const stderrTail = tailText(result.stderr);
    throw new Error(
      [
        `release command failed (${result.status ?? "unknown"}): ${command.id}`,
        result.error ? `error: ${result.error.message}` : undefined,
        stdoutTail ? `stdout tail:\n${stdoutTail}` : undefined,
        stderrTail ? `stderr tail:\n${stderrTail}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function tailText(value: string | null | undefined, limit = 16 * 1024): string {
  if (!value) return "";
  return value.length <= limit ? value : value.slice(value.length - limit);
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

function defaultReleaseWorkRoot(): string {
  const configured = process.env.TAKOSUMI_RELEASE_WORK_ROOT?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    return join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "takosumi-release-activator",
    );
  }
  return join("/var/tmp", "takosumi-release-activator");
}

async function prepareRuntimeRoot(runtimeRoot: string): Promise<void> {
  await Promise.all(
    [
      "tmp",
      "bun-install-cache",
      "bun-tmp",
      "xdg-cache",
      "node-compile-cache",
    ].map((name) => mkdir(join(runtimeRoot, name), { recursive: true })),
  );
}

function materializerRuntimeEnv(runtimeRoot: string): Record<string, string> {
  const tmpPath = join(runtimeRoot, "tmp");
  return {
    TMPDIR: tmpPath,
    TEMP: tmpPath,
    TMP: tmpPath,
    BUN_INSTALL_CACHE_DIR: join(runtimeRoot, "bun-install-cache"),
    BUN_TMPDIR: join(runtimeRoot, "bun-tmp"),
    XDG_CACHE_HOME: join(runtimeRoot, "xdg-cache"),
    NODE_COMPILE_CACHE: join(runtimeRoot, "node-compile-cache"),
  };
}

function materializerAllowedCommandEnv(
  env: Readonly<Record<string, string | undefined>> | undefined = process.env,
  allowlist: readonly string[] | undefined,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const name of normalizeCommandEnvAllowlist(allowlist)) {
    if (isReservedProviderEnvName(name)) {
      throw new Error(
        `release command env allowlist must not include reserved ${name}`,
      );
    }
    const value = env[name];
    if (typeof value === "string") next[name] = value;
  }
  return next;
}

function normalizeCommandEnvAllowlist(
  allowlist: readonly string[] | undefined,
): readonly string[] {
  if (!allowlist) return [];
  const names = new Set<string>();
  for (const raw of allowlist) {
    const name = raw.trim();
    if (!name) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
      throw new Error(`release command env allowlist entry is invalid: ${raw}`);
    }
    names.add(name);
  }
  return [...names].sort();
}

function materializerToolEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtimeRoot?: string,
): Record<string, string> {
  const next = materializerBaseEnv(env);
  for (const name of WRANGLER_AUTH_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") next[name] = value;
  }
  if (runtimeRoot) Object.assign(next, materializerRuntimeEnv(runtimeRoot));
  return next;
}

function assertNoUnexpectedCredentialEnv(
  env: Readonly<Record<string, string>>,
  explicitNames: ReadonlySet<string>,
): void {
  for (const name of Object.keys(env)) {
    if (PROVIDER_CREDENTIAL_ENV_NAMES.has(name) && !explicitNames.has(name)) {
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
    commandEnvAllowlist: parseCommandEnvAllowlist(
      values.get("command-env-allowlist") ??
        process.env.TAKOSUMI_RELEASE_COMMAND_ENV_ALLOWLIST,
    ),
  };
}

function parseCommandEnvAllowlist(
  value: string | undefined,
): readonly string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }
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
    await new Promise(() => {
      // Keep the operator HTTP activator process alive after Bun.serve returns.
    });
    return;
  }
  throw new Error(USAGE);
}

export function serveReleaseActivator(options: ServeOptions): void {
  const fetch = createReleaseActivatorFetchHandler(options);
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch,
  });
  activeServers.push(server);
  keepAliveTimers.push(
    setInterval(() => {
      // A pending Promise alone does not keep Bun's event loop alive.
    }, 60_000),
  );
  console.log(
    `Takosumi operator release activator listening on http://${server.hostname}:${server.port}`,
  );
}

export function createReleaseActivatorFetchHandler(options: ServeOptions) {
  const jobs = new Map<string, ReleaseActivationJob>();
  return async function fetch(request: Request): Promise<Response> {
    const expected = `Bearer ${options.token}`;
    if (request.headers.get("authorization") !== expected) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (request.method === "GET") {
      const jobId = url.searchParams.get("jobId");
      if (!jobId) return Response.json({ error: "not found" }, { status: 404 });
      const job = jobs.get(jobId);
      if (!job) {
        return Response.json({ error: "job not found" }, { status: 404 });
      }
      return Response.json(jobResponse(job, request.url));
    }
    if (request.method !== "POST") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    let payload: ReleaseActivationPayload;
    try {
      payload = parsePayload(await request.json());
    } catch (error) {
      return Response.json(
        {
          status: "failed",
          kind: "takosumi.operator.release-commands@v1",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 400 },
      );
    }
    const jobId = releaseActivationJobId(payload);
    let job = jobs.get(jobId);
    if (!job) {
      job = {
        id: jobId,
        payload,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.set(jobId, job);
      startReleaseActivationJob(job, options);
    }
    const status =
      job.status === "pending" || job.status === "running" ? 202 : 200;
    return Response.json(jobResponse(job, statusUrl(request.url, job.id)), {
      status,
    });
  };
}

function startReleaseActivationJob(
  job: ReleaseActivationJob,
  options: ServeOptions,
): void {
  setTimeout(() => {
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    const run =
      options.runActivation ??
      ((payload: ReleaseActivationPayload, runOptions: RunReleaseOptions) =>
        runReleaseActivationChild(payload, runOptions, job.id));
    void run(job.payload, options, job.id)
      .then((result) => {
        job.status = result.status;
        job.result = result;
        job.updatedAt = new Date().toISOString();
      })
      .catch((error) => {
        job.status = "failed";
        job.result = {
          status: "failed",
          kind: "takosumi.operator.release-commands@v1",
          message: error instanceof Error ? error.message : String(error),
        };
        job.updatedAt = new Date().toISOString();
      });
  }, 0);
}

async function runReleaseActivationChild(
  payload: ReleaseActivationPayload,
  options: RunReleaseOptions,
  jobId: string,
): Promise<ReleaseActivationResponse> {
  const workRoot = options.workRoot ?? DEFAULT_WORK_ROOT;
  const jobDir = join(workRoot, "jobs", jobId);
  await mkdir(jobDir, { recursive: true });
  const payloadPath = join(jobDir, "payload.json");
  await writeFile(payloadPath, JSON.stringify(payload), "utf8");
  const args = [
    fileURLToPath(import.meta.url),
    "run",
    "--payload",
    payloadPath,
    ...runModeArgs(options),
  ];
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = tailText(stdout + String(chunk), 256 * 1024);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = tailText(stderr + String(chunk), 256 * 1024);
  });
  try {
    return await new Promise((resolve) => {
      child.on("error", (error) => {
        resolve({
          status: "failed",
          kind: "takosumi.operator.release-commands@v1",
          message: `release activation child failed: ${error.message}`,
        });
      });
      child.on("close", (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout) as ReleaseActivationResponse);
            return;
          } catch {
            resolve({
              status: "failed",
              kind: "takosumi.operator.release-commands@v1",
              message: `release activation child returned invalid JSON: ${tailText(
                stdout,
              )}`,
            });
            return;
          }
        }
        resolve({
          status: "failed",
          kind: "takosumi.operator.release-commands@v1",
          message: [
            `release activation child exited ${code ?? "unknown"}`,
            stdout ? `stdout tail:\n${tailText(stdout)}` : undefined,
            stderr ? `stderr tail:\n${tailText(stderr)}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        });
      });
    });
  } finally {
    if (options.keepWorkdir !== true) {
      await rm(jobDir, { recursive: true, force: true });
    }
  }
}

function runModeArgs(options: RunReleaseOptions): string[] {
  const args: string[] = [];
  if (options.sourceBucket) args.push("--source-bucket", options.sourceBucket);
  if (options.wranglerConfig) {
    args.push("--wrangler-config", options.wranglerConfig);
  }
  if (options.wranglerEnv) args.push("--wrangler-env", options.wranglerEnv);
  if (options.jurisdiction) args.push("--jurisdiction", options.jurisdiction);
  if (options.workRoot) args.push("--work-root", options.workRoot);
  if (options.keepWorkdir) args.push("--keep-workdir");
  if (options.commandEnvAllowlist && options.commandEnvAllowlist.length > 0) {
    args.push("--command-env-allowlist", options.commandEnvAllowlist.join(","));
  }
  return args;
}

function releaseActivationJobId(payload: ReleaseActivationPayload): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        applyRunId: payload.applyRunId,
        deploymentId: payload.deployment?.id ?? "",
        archiveDigest: payload.sourceSnapshot.archiveDigest,
        commands: payload.commands,
      }),
    )
    .digest("hex");
  return `rel_${digest.slice(0, 32)}`;
}

function jobResponse(
  job: ReleaseActivationJob,
  statusUrlValue?: string,
): ReleaseActivationResponse & {
  readonly jobId: string;
  readonly statusUrl?: string;
} {
  const base =
    job.result ??
    ({
      status: "pending",
      kind: "takosumi.operator.release-commands@v1",
      message:
        job.status === "running"
          ? "release activation job is running"
          : "release activation job is pending",
    } satisfies ReleaseActivationResponse);
  return {
    ...base,
    jobId: job.id,
    ...(statusUrlValue ? { statusUrl: statusUrlValue } : {}),
    metadata: {
      ...(base.metadata ?? {}),
      jobId: job.id,
      jobStatus: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
  };
}

function statusUrl(requestUrl: string, jobId: string): string {
  const url = new URL(requestUrl);
  url.search = "";
  url.searchParams.set("jobId", jobId);
  return url.toString();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
