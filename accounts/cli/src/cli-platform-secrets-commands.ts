import process from "node:process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join as pathJoin, resolve } from "node:path";
import {
  booleanOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import {
  containsSecretLikeString,
  isSecretKey,
  redactString,
} from "../../../core/domains/observability/redaction.ts";
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
  if (command === "status")
    return await runPlatformSecretsStatus(rest, io, runner);
  if (command === "apply")
    return await runPlatformSecretsApply(rest, io, runner);
  io.stderr(`Unknown platform-secrets command: ${command}`);
  io.stderr(platformSecretsHelpText());
  return 2;
}

type SecretClass =
  | "protected_key"
  | "rotate_safe_generated"
  | "required_manual_external"
  | "manual_external";

type SecretManifestEntry = {
  readonly name: string;
  readonly secretClass: SecretClass;
  readonly generator?: () => string | Promise<string>;
};

const BASE_SECRET_MANIFEST: readonly SecretManifestEntry[] = [
  {
    name: "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK",
    secretClass: "protected_key",
    generator: () => generateEs256PrivateJwkSecret(),
  },
  {
    name: "TAKOSUMI_ACCOUNTS_ES256_KEY_ID",
    secretClass: "protected_key",
    generator: () => `takosumi-${crypto.randomUUID()}`,
  },
  {
    name: "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    secretClass: "protected_key",
    generator: () => generateBase64UrlSecret(48),
  },
  {
    name: "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
    secretClass: "protected_key",
    generator: () => generateBase64UrlSecret(48),
  },
  {
    name: "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT",
    secretClass: "protected_key",
    generator: () => generateBase64UrlSecret(48),
  },
  {
    name: "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET",
    secretClass: "protected_key",
    generator: () => generateBase64UrlSecret(48),
  },
  {
    name: "TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET",
    secretClass: "protected_key",
    generator: () => generateBase64UrlSecret(48),
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
    name: "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET",
    secretClass: "manual_external",
  },
  {
    name: "TAKOSUMI_METRICS_SCRAPE_TOKEN",
    secretClass: "manual_external",
  },
  {
    name: "TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY",
    secretClass: "manual_external",
  },
  {
    name: "TAKOSUMI_ACCOUNTS_STRIPE_API_KEY",
    secretClass: "manual_external",
  },
  {
    name: "TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET",
    secretClass: "manual_external",
  },
] as const;

const manifestByName = new Map(
  BASE_SECRET_MANIFEST.map((entry) => [entry.name, entry]),
);

const SECRET_BEARING_STATIC_UPSTREAM_HEADER_PATTERN =
  /(^|[-_])(api[-_]?key|access[-_]?token|auth[-_]?token|secret|credential)([-_]|$)/;

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
      status.missingRequiredManual.length === 0 &&
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
  missingRequiredManual: readonly string[];
  remoteOnly: readonly string[];
  generatedPresent: readonly string[];
  protectedPresent: readonly string[];
  requiredManualPresent: readonly string[];
  manualPresent: readonly string[];
  unknownLocal: readonly string[];
}> {
  const [localNames, remoteNames] = await Promise.all([
    listLocalSecretNames(options),
    listRemoteSecretNames(options, runner),
  ]);
  const manifest = await platformSecretManifest(options, localNames);
  const local = new Set(localNames);
  const expected = new Set(manifest.map((entry) => entry.name));
  const generated = manifest
    .filter((entry) => entry.secretClass === "rotate_safe_generated")
    .map((entry) => entry.name);
  const protectedNames = manifest
    .filter((entry) => entry.secretClass === "protected_key")
    .map((entry) => entry.name);
  const requiredManual = manifest
    .filter((entry) => entry.secretClass === "required_manual_external")
    .map((entry) => entry.name);
  const manual = manifest
    .filter((entry) => entry.secretClass === "manual_external")
    .map((entry) => entry.name);
  return {
    localNames,
    remoteNames,
    missingGenerated: generated.filter((name) => !local.has(name)),
    missingProtected: protectedNames.filter((name) => !local.has(name)),
    missingRequiredManual: requiredManual.filter((name) => !local.has(name)),
    remoteOnly: remoteNames.filter((name) => !local.has(name)),
    generatedPresent: generated.filter((name) => local.has(name)),
    protectedPresent: protectedNames.filter((name) => local.has(name)),
    requiredManualPresent: requiredManual.filter((name) => local.has(name)),
    manualPresent: manual.filter((name) => local.has(name)),
    unknownLocal: localNames.filter((name) => !expected.has(name)),
  };
}

async function platformSecretManifest(
  options: Record<string, string | boolean>,
  localNames: readonly string[],
): Promise<readonly SecretManifestEntry[]> {
  const entries: SecretManifestEntry[] = BASE_SECRET_MANIFEST.map((entry) => ({
    ...entry,
  }));
  const known = new Set(entries.map((entry) => entry.name));
  for (const name of await configuredUpstreamOAuthClientSecretNames(options)) {
    markRequiredManualSecret(entries, name);
    known.add(name);
  }
  for (const name of await aiGatewayProfileApiKeyEnvNames(options)) {
    if (known.has(name)) continue;
    entries.push({ name, secretClass: "required_manual_external" });
    known.add(name);
  }
  for (const name of localNames) {
    if (known.has(name) || !isAiGatewayApiKeySecretName(name)) continue;
    entries.push({ name, secretClass: "manual_external" });
    known.add(name);
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function markRequiredManualSecret(
  entries: SecretManifestEntry[],
  name: string,
): void {
  const index = entries.findIndex((entry) => entry.name === name);
  if (index >= 0) {
    entries[index] = {
      ...entries[index],
      secretClass: "required_manual_external",
    };
    return;
  }
  entries.push({ name, secretClass: "required_manual_external" });
}

async function configuredUpstreamOAuthClientSecretNames(
  options: Record<string, string | boolean>,
): Promise<readonly string[]> {
  const configText = await readWranglerConfigText(options);
  const providers = [
    {
      id: "GOOGLE",
      secretName: "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET",
    },
  ];
  return providers
    .filter(({ id }) =>
      hasConfiguredUpstreamOAuthProvider({ providerId: id, configText }),
    )
    .map(({ secretName }) => secretName)
    .sort();
}

function hasConfiguredUpstreamOAuthProvider({
  providerId,
  configText,
}: {
  readonly providerId: string;
  readonly configText: string | undefined;
}): boolean {
  return [
    `TAKOSUMI_ACCOUNTS_UPSTREAM_${providerId}_CLIENT_ID`,
    `TAKOSUMI_ACCOUNTS_UPSTREAM_${providerId}_REDIRECT_URI`,
  ].some((name) => configuredStringValue(name, configText) !== undefined);
}

function configuredStringValue(
  name: string,
  configText: string | undefined,
): string | undefined {
  const envValue = process.env[name];
  if (typeof envValue === "string" && envValue.length > 0) return envValue;
  if (!configText) return undefined;
  const configValue = stringVarFromTomlSection(configText, "vars", name);
  return configValue && configValue.length > 0 ? configValue : undefined;
}

async function aiGatewayProfileApiKeyEnvNames(
  options: Record<string, string | boolean>,
): Promise<readonly string[]> {
  const raw =
    optionalStringOption(options, "aiGatewayProfiles") ??
    process.env.TAKOSUMI_AI_GATEWAY_PROFILES ??
    (await aiGatewayProfilesFromWranglerConfig(options));
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("TAKOSUMI_AI_GATEWAY_PROFILES must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("TAKOSUMI_AI_GATEWAY_PROFILES must be a JSON array");
  }
  const names = new Set<string>();
  parsed.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`AI Gateway profile ${index} must be an object`);
    }
    const id = stringValue(entry.id) ?? String(index);
    if ("apiKey" in entry) {
      throw new TypeError(
        `AI Gateway profile ${id}.apiKey must not be embedded; use apiKeyEnv`,
      );
    }
    const apiKeyEnv = stringValue(entry.apiKeyEnv);
    if (!apiKeyEnv) {
      throw new TypeError(`AI Gateway profile ${id}.apiKeyEnv is required`);
    }
    if (!isWorkerSecretName(apiKeyEnv)) {
      throw new TypeError(
        `AI Gateway profile ${id}.apiKeyEnv must be a Worker secret name`,
      );
    }
    assertNoSecretBearingAiGatewayHeaders(entry, id);
    assertNoSecretBearingAiGatewayModelMetadata(entry, id);
    names.add(apiKeyEnv);
  });
  return [...names].sort();
}

function assertNoSecretBearingAiGatewayHeaders(
  entry: Record<string, unknown>,
  id: string,
): void {
  if (entry.headers === undefined) return;
  if (!isRecord(entry.headers)) {
    throw new TypeError(`AI Gateway profile ${id}.headers must be an object`);
  }
  for (const [name, value] of Object.entries(entry.headers)) {
    if (typeof value !== "string") {
      throw new TypeError(
        `AI Gateway profile ${id}.headers.${name} must be a string`,
      );
    }
    if (containsSecretLikeString(value) || redactString(value) !== value) {
      throw new TypeError(
        `AI Gateway profile ${id}.headers.${name} value may carry secrets; use apiKeyEnv and apiKeyHeader`,
      );
    }
    const lower = name.toLowerCase();
    if (
      AI_GATEWAY_RESERVED_STATIC_HEADERS.has(lower) ||
      SECRET_BEARING_STATIC_UPSTREAM_HEADER_PATTERN.test(lower)
    ) {
      throw new TypeError(
        `AI Gateway profile ${id}.headers.${name} may carry secrets; use apiKeyEnv and apiKeyHeader`,
      );
    }
  }
}

function assertNoSecretBearingAiGatewayModelMetadata(
  entry: Record<string, unknown>,
  id: string,
): void {
  if (entry.models === undefined) return;
  if (!Array.isArray(entry.models)) return;
  entry.models.forEach((model, index) => {
    if (!isRecord(model)) return;
    const label = `AI Gateway profile ${id}.models[${index}].metadata`;
    assertNoSecretBearingAiGatewayPublicMetadata(model.metadata, label);
  });
}

function assertNoSecretBearingAiGatewayPublicMetadata(
  value: unknown,
  label: string,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  const issue = aiGatewayPublicMetadataSecretIssue(value, label);
  if (issue) {
    throw new TypeError(`${issue} may carry secrets; use apiKeyEnv`);
  }
}

function aiGatewayPublicMetadataSecretIssue(
  value: unknown,
  path: string,
): string | undefined {
  if (typeof value === "string") {
    return containsSecretLikeString(value) || redactString(value) !== value
      ? path
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const issue = aiGatewayPublicMetadataSecretIssue(
        child,
        `${path}[${index}]`,
      );
      if (issue) return issue;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const childPath = `${path}.${key}`;
      if (isSecretKey(key)) return childPath;
      const issue = aiGatewayPublicMetadataSecretIssue(child, childPath);
      if (issue) return issue;
    }
  }
  return undefined;
}

const AI_GATEWAY_RESERVED_STATIC_HEADERS = new Set([
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

async function aiGatewayProfilesFromWranglerConfig(
  options: Record<string, string | boolean>,
): Promise<string | undefined> {
  const text = await readWranglerConfigText(options);
  if (!text) return undefined;
  return stringVarFromTomlSection(text, "vars", "TAKOSUMI_AI_GATEWAY_PROFILES");
}

async function readWranglerConfigText(
  options: Record<string, string | boolean>,
): Promise<string | undefined> {
  try {
    return await readFile(wranglerConfig(options), "utf8");
  } catch {
    return undefined;
  }
}

function isAiGatewayApiKeySecretName(name: string): boolean {
  return /^TAKOSUMI_AI_GATEWAY_[A-Z0-9_]+_API_KEY$/.test(name);
}

function isWorkerSecretName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

function stringVarFromTomlSection(
  text: string,
  section: string,
  key: string,
): string | undefined {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      inSection = header[1]?.trim() === section;
      continue;
    }
    if (!inSection) continue;
    const assignment = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (!assignment) continue;
    const parsed = parseTomlStringValue(lines, index, assignment[1] ?? "");
    if (!parsed) return undefined;
    return parsed.value;
  }
  return undefined;
}

function parseTomlStringValue(
  lines: readonly string[],
  startIndex: number,
  rawStart: string,
): { readonly value: string } | undefined {
  const start = rawStart.trimStart();
  if (start.startsWith("'''")) {
    return parseTomlMultilineLiteralString(lines, startIndex, start);
  }
  if (start.startsWith('"""')) {
    return parseTomlMultilineBasicString(lines, startIndex, start);
  }
  if (start.startsWith("'")) {
    const end = start.indexOf("'", 1);
    return end > 0 ? { value: start.slice(1, end) } : undefined;
  }
  if (start.startsWith('"')) {
    return parseTomlBasicString(start);
  }
  return undefined;
}

function parseTomlMultilineLiteralString(
  lines: readonly string[],
  startIndex: number,
  start: string,
): { readonly value: string } | undefined {
  const first = start.slice(3);
  const sameLineEnd = first.indexOf("'''");
  if (sameLineEnd >= 0) return { value: first.slice(0, sameLineEnd) };
  const parts = [first];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const end = line.indexOf("'''");
    if (end >= 0) {
      parts.push(line.slice(0, end));
      return { value: normalizeTomlMultilineString(parts.join("\n")) };
    }
    parts.push(line);
  }
  return undefined;
}

function parseTomlMultilineBasicString(
  lines: readonly string[],
  startIndex: number,
  start: string,
): { readonly value: string } | undefined {
  const first = start.slice(3);
  const sameLineEnd = first.indexOf('"""');
  if (sameLineEnd >= 0) {
    return parseTomlBasicString(`"${first.slice(0, sameLineEnd)}"`);
  }
  const parts = [first];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const end = line.indexOf('"""');
    if (end >= 0) {
      parts.push(line.slice(0, end));
      return parseTomlBasicString(
        JSON.stringify(normalizeTomlMultilineString(parts.join("\n"))),
      );
    }
    parts.push(line);
  }
  return undefined;
}

function parseTomlBasicString(
  raw: string,
): { readonly value: string } | undefined {
  let escaped = false;
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    try {
      return { value: JSON.parse(raw.slice(0, index + 1)) as string };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeTomlMultilineString(value: string): string {
  return value.startsWith("\n") ? value.slice(1) : value;
}

async function applyPlatformSecrets(
  rawArgs: readonly string[],
  options: Record<string, string | boolean>,
  runner: CommandRunner,
): Promise<{
  dryRun: boolean;
  localOnly: boolean;
  generated: readonly string[];
  regenerated: readonly string[];
  pushed: readonly string[];
  planned: readonly string[];
}> {
  const dryRun = booleanOption(options, "dryRun");
  const localOnly = booleanOption(options, "localOnly");
  const initProtected = booleanOption(options, "initProtected");
  const dir = secretsDir(options);
  if (!dryRun) await mkdir(dir, { recursive: true });

  const regenerate = parseRegenerateOptions(rawArgs);
  const localFilesBefore = await listLocalSecretFiles(options).catch(
    (error) => {
      if (dryRun && isNodeErrorCode(error, "ENOENT")) return [];
      throw error;
    },
  );
  const localBefore = new Map(
    localFilesBefore.map((file) => [file.name, file]),
  );
  const generated: string[] = [];
  const regenerated: string[] = [];

  for (const entry of BASE_SECRET_MANIFEST) {
    const shouldRegenerate = regenerate.has(entry.name);
    const canGenerate =
      entry.secretClass === "rotate_safe_generated" ||
      (initProtected && entry.secretClass === "protected_key");
    if (!canGenerate || !entry.generator) continue;
    if (localBefore.has(entry.name) && !shouldRegenerate) continue;
    if (dryRun) {
      if (shouldRegenerate) regenerated.push(entry.name);
      else generated.push(entry.name);
      continue;
    }
    await writeSecretFile(dir, entry.name, await entry.generator());
    if (shouldRegenerate) regenerated.push(entry.name);
    else generated.push(entry.name);
  }

  const files = dryRun
    ? plannedLocalFilesAfterDryRun(
        localFilesBefore,
        generated,
        regenerated,
        dir,
      )
    : await listLocalSecretFiles(options);
  if (files.length === 0) {
    throw new TypeError("no local secret files found");
  }
  const manifest = await platformSecretManifest(
    options,
    files.map((file) => file.name),
  );
  const expectedNames = new Set(manifest.map((entry) => entry.name));
  const localNames = new Set(files.map((file) => file.name));
  const missingRequiredManual = manifest
    .filter((entry) => entry.secretClass === "required_manual_external")
    .map((entry) => entry.name)
    .filter((name) => !localNames.has(name));
  if (missingRequiredManual.length > 0) {
    throw new TypeError(
      `missing required manual platform secret(s): ${missingRequiredManual.join(", ")}`,
    );
  }
  const managedFiles = files.filter((file) => expectedNames.has(file.name));
  if (managedFiles.length === 0) {
    throw new TypeError("no managed platform secret files found");
  }
  if (!dryRun && !localOnly) {
    for (const file of managedFiles) {
      await putRemoteSecret(file.name, file.path, options, runner);
    }
  }
  const names = managedFiles.map((file) => file.name);
  return {
    dryRun,
    localOnly,
    generated,
    regenerated,
    pushed: dryRun || localOnly ? [] : names,
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
  const rotateSafe = BASE_SECRET_MANIFEST.filter(
    (entry) => entry.secretClass === "rotate_safe_generated",
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
      throw new TypeError(
        `${name} is ${entry.secretClass} and cannot be regenerated by apply`,
      );
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
  if (!Array.isArray(parsed))
    throw new Error("wrangler secret list returned invalid JSON");
  return parsed
    .map((entry) => {
      if (!isRecord(entry)) return undefined;
      return stringValue(entry.name);
    })
    .filter((name): name is string => Boolean(name))
    .sort();
}

async function putRemoteSecret(
  name: string,
  localSecretPath: string,
  options: Record<string, string | boolean>,
  runner: CommandRunner,
): Promise<void> {
  const value = await readFile(localSecretPath, "utf8");
  const result = await runner(
    [
      "bunx",
      "wrangler",
      "secret",
      "put",
      name,
      "--config",
      wranglerConfig(options),
    ],
    value,
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || `wrangler secret put ${name} failed`,
    );
  }
}

function wranglerConfig(options: Record<string, string | boolean>): string {
  const value =
    optionalStringOption(options, "config") ??
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
  const value =
    optionalStringOption(options, "secretsDir") ??
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
    missingRequiredManual: readonly string[];
    remoteOnly: readonly string[];
    generatedPresent: readonly string[];
    protectedPresent: readonly string[];
    requiredManualPresent: readonly string[];
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
    `Required manual present: ${input.requiredManualPresent.length ? input.requiredManualPresent.join(", ") : "none"}`,
    `Manual present: ${input.manualPresent.length ? input.manualPresent.join(", ") : "none"}`,
    `Missing generated: ${input.missingGenerated.length ? input.missingGenerated.join(", ") : "none"}`,
    `Missing protected: ${input.missingProtected.length ? input.missingProtected.join(", ") : "none"}`,
    `Missing required manual: ${input.missingRequiredManual.length ? input.missingRequiredManual.join(", ") : "none"}`,
    `Unknown local: ${input.unknownLocal.length ? input.unknownLocal.join(", ") : "none"}`,
    `Remote only: ${input.remoteOnly.length ? input.remoteOnly.join(", ") : "none"}`,
  ].join("\n");
}

function formatSecretApply(
  result: {
    dryRun: boolean;
    localOnly: boolean;
    generated: readonly string[];
    regenerated: readonly string[];
    pushed: readonly string[];
    planned: readonly string[];
  },
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(result, null, 2);
  const verb = result.dryRun
    ? "Would push"
    : result.localOnly
      ? "Initialized local vault with"
      : "Pushed";
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
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function generateEs256PrivateJwkSecret(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return JSON.stringify(privateJwk);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
