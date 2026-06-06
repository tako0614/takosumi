import {
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
// relative import resolves at container runtime (see runner/Dockerfile).
import {
  type ProviderCredentialEnvRule,
  providerEnvRule,
} from "../../../src/contract/provider-env-rules.ts";

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
}

interface CommandContext {
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
] as const;
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
    const stateArtifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfstate$/.exec(
      url.pathname,
    );
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
    const action = parseAction(body.action);
    if (!action) {
      return Response.json(
        { error: "invalid OpenTofu action" },
        { status: 400 },
      );
    }

    const runId = decodeURIComponent(match[1]);
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
  const init = await runCommand(["tofu", "init", "-input=false", "-no-color"], {
    cwd: workspace.moduleDir,
    context: commandContext,
  });
  if (init.exitCode !== 0) {
    return commandFailurePayload(runId, "plan", init);
  }

  const plan = await runCommand([
    "tofu",
    "plan",
    ...(operation === "destroy" ? ["-destroy"] : []),
    "-input=false",
    "-no-color",
    "-out",
    workspace.planPath,
  ], { cwd: workspace.moduleDir, context: commandContext });
  if (plan.exitCode !== 0) {
    return commandFailurePayload(runId, "plan", plan);
  }

  const planBytes = await readFile(workspace.planPath);
  const planDigest = await digestBytes(planBytes);
  const planJson = await readOpenTofuPlanJson(workspace, commandContext);
  const providerLockDigest = await digestFileIfExists(
    join(workspace.moduleDir, ".terraform.lock.hcl"),
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
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(providerLockDigest ? { providerLockDigest } : {}),
    stdout: [init.stdout, plan.stdout].filter(Boolean).join("\n"),
    stderr: [init.stderr, plan.stderr].filter(Boolean).join("\n"),
  };
}

async function runReviewedPlanApply(
  runId: string,
  action: "apply" | "destroy",
  request: unknown,
): Promise<JsonRecord> {
  const source = parseSource(request);
  const runnerProfile = parseRunnerProfile(request);
  const commandContext = commandContextFromRequest(request, runnerProfile);
  assertRunnerPolicyBeforeInit(request, runnerProfile, commandContext);
  const planArtifact = parsePlanArtifact(request);
  await verifyPlanArtifact(workspaceForRun(runId).planPath, planArtifact);
  const workspace = await prepareApplyWorkspace(runId, source, commandContext);
  const init = await runCommand(["tofu", "init", "-input=false", "-no-color"], {
    cwd: workspace.moduleDir,
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
    workspace.planPath,
  ], { cwd: workspace.moduleDir, context: commandContext });
  const outputs = action === "apply" && result.exitCode === 0
    ? await readOpenTofuOutputs(workspace, commandContext)
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
  // core (src/contract/reference/prepared-source-core.ts).
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
  workspace: RunWorkspace,
  context: CommandContext,
): Promise<string | undefined> {
  const result = await runCommand([
    "tofu",
    "show",
    "-json",
    workspace.planPath,
  ], { cwd: workspace.moduleDir, context });
  return result.exitCode === 0 && result.stdout.trim().length > 0
    ? result.stdout
    : undefined;
}

async function readOpenTofuOutputs(
  workspace: RunWorkspace,
  context: CommandContext,
): Promise<Record<string, unknown> | undefined> {
  const result = await runCommand(["tofu", "output", "-json"], {
    cwd: workspace.moduleDir,
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
