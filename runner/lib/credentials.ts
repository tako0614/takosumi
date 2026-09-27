// runner/lib/credentials.ts
//
// Credential env/file injection, shredding, and credential-env availability checks.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";
import { dirname, join } from "node:path";
import {
  isProviderEnvName,
  isReservedProviderEnvName,
} from "../../contract/provider-env-rules.ts";
import type { RunCredentialRecipeManifest } from "../../contract/credential-recipes.ts";
import type {
  JsonRecord,
  RunWorkspace,
  CommandContext,
  ProviderCredentialFile,
  SourceCredentials,
  PreparedProviderCredentialFiles,
  RenewableCredentialProjection,
  RunCredentialRefreshUpdate,
} from "./types.ts";
import { BASE_COMMAND_ENV_NAMES } from "./constants.ts";
import {
  isRecord,
  recordField,
  stringField,
  shredCredentialDir,
} from "./util.ts";
import {
  assertSafeCredentialFileName,
  assertSafeCredentialFileMode,
} from "./policy.ts";
import { parseSourceCredentials } from "./source_sync.ts";
import {
  runtimeInputRedactionValues,
  runtimeInputsFromRequest,
} from "./runtime_inputs.ts";
import {
  maxRunSecondsFromProfile,
  positiveIntegerLimitFromProfile,
} from "./parsing.ts";

// A 120-second credential renewed 90 seconds before expiry can rotate every
// 30 seconds. Keep a large finite history for supported long-running plans.
const MAX_ROTATIONS_PER_RUN = 2_048;
const MAX_RENEWABLE_CREDENTIALS = 32;
const MAX_REDACTION_VALUES_PER_RUN = 4_096;
const MAX_REDACTION_VALUE_BYTES_PER_RUN = 16 * 1024 * 1024;
const activeCredentialRefreshSessions = new Map<string, CredentialRefreshSession>();
const activeRunRedactionValues = new Map<string, string[]>();

class CredentialRefreshSession {
  #sequence = 0;
  #closed = false;
  #rotations = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly runId: string,
    readonly owner: NonNullable<CommandContext["credentialRefreshOwner"]>,
    readonly manifestDigest: string,
    readonly descriptors: readonly RenewableCredentialProjection[],
    readonly filesByEnvName: ReadonlyMap<string, string>,
    readonly redactionValues: string[],
    readonly signal?: AbortSignal,
  ) {}

  async update(update: RunCredentialRefreshUpdate): Promise<void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.#closed || this.signal?.aborted) throw new Error("credential refresh is no longer active");
      if (
        update.owner.kind !== this.owner.kind ||
        update.owner.id !== this.owner.id ||
        update.runnerRunId !== this.runId ||
        update.manifestDigest !== this.manifestDigest ||
        update.sequence !== this.#sequence + 1 ||
        update.credentials.length !== 1 ||
        this.descriptors.length > MAX_RENEWABLE_CREDENTIALS ||
        this.#rotations >= MAX_ROTATIONS_PER_RUN
      ) {
        throw new Error("credential refresh identity or sequence mismatch");
      }
      const mapped = new Map(this.descriptors.map((item) => [
        `${item.providerSource}\0${item.connectionId}\0${item.sourceEnvName}\0${item.fileEnvName}`,
        item,
      ]));
      const updates = update.credentials.map((item) => {
        const descriptor = mapped.get(`${item.providerSource}\0${item.connectionId}\0${item.sourceEnvName}\0${item.fileEnvName}`);
        if (
          !descriptor || typeof item.value !== "string" || !validCredentialValue(item.value) ||
          !Number.isFinite(Date.parse(item.expiresAt))
        ) throw new Error("credential refresh descriptor mismatch");
        return { descriptor, value: item.value };
      });
      if (
        new Set(updates.map(({ descriptor }) => descriptor.sourceEnvName)).size !== updates.length ||
        new Set(updates.map(({ descriptor }) => descriptor.fileEnvName)).size !== updates.length
      ) {
        throw new Error("credential refresh contains duplicate descriptors");
      }
      // Validate every destination before writing any update. The directory is
      // mode 0700, but still refuse a replaced/symlink target explicitly.
      for (const { descriptor } of updates) {
        const target = this.filesByEnvName.get(descriptor.fileEnvName);
        if (!target) throw new Error("credential refresh target is unavailable");
        const info = await lstat(target);
        if (
          !info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())
        ) throw new Error("credential refresh target is not a private runner file");
      }
      // Redact every accepted candidate before the first asynchronous file
      // operation: a provider can emit the value while replacement is in flight.
      const addedValues = [...new Set(updates.map(({ value }) => value))]
        .filter((value) => !this.redactionValues.includes(value));
      const currentBytes = this.redactionValues.reduce(
        (total, value) => total + new TextEncoder().encode(value).byteLength,
        0,
      );
      const addedBytes = addedValues.reduce(
        (total, value) => total + new TextEncoder().encode(value).byteLength,
        0,
      );
      if (
        this.redactionValues.length + addedValues.length > MAX_REDACTION_VALUES_PER_RUN ||
        currentBytes + addedBytes > MAX_REDACTION_VALUE_BYTES_PER_RUN
      ) throw new Error("credential refresh redaction history limit exceeded");
      for (const { value } of updates) {
        if (!this.redactionValues.includes(value)) this.redactionValues.push(value);
      }
      for (const { descriptor, value } of updates) {
        await replaceCredentialFile(this.filesByEnvName.get(descriptor.fileEnvName)!, value);
      }
      this.#sequence = update.sequence;
      this.#rotations += 1;
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }
}

async function replaceCredentialFile(path: string, value: string): Promise<void> {
  const parent = await lstat(dirname(path));
  if (
    !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && parent.uid !== process.getuid())
  ) throw new Error("credential refresh directory is not private");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function validCredentialValue(value: string): boolean {
  return value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 8192 &&
    !value.includes("\0");
}

export function setRunRedactionValues(runId: string, values: string[]): void {
  activeRunRedactionValues.set(runId, values);
}

export function clearRunRedactionValues(runId: string, values: string[]): void {
  if (activeRunRedactionValues.get(runId) === values) activeRunRedactionValues.delete(runId);
}

function redactionValuesForRun(runId: string | undefined, fallback: string[]): string[] {
  return runId ? (activeRunRedactionValues.get(runId) ?? fallback) : fallback;
}

export async function refreshRunCredentials(
  runId: string,
  update: RunCredentialRefreshUpdate,
): Promise<void> {
  const session = activeCredentialRefreshSessions.get(runId);
  if (!session) throw new Error("no active renewable credentials for run");
  await session.update(update);
}

export function commandContextFromRequest(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
  signal?: AbortSignal,
  runId?: string,
): CommandContext {
  const env = baseCommandEnv();
  const credentialManifest = credentialManifestFromRequest(request);
  const payloadCredentials = credentialsFromRequest(request);
  const credentialFiles = providerCredentialFilesFromRequest(request);
  const renewableCredentials = renewableCredentialsFromRequest(request);
  const credentialManifestDigest = credentialManifestDigestFromRequest(request);
  const applyRun = recordField(request, "applyRun");
  const applyRunId = isRecord(applyRun)
    ? stringField(applyRun, "id")
    : undefined;
  const credentialRefreshOwner = applyRunId
    ? { kind: "apply" as const, id: applyRunId }
    : runId
      ? { kind: "plan" as const, id: runId }
      : undefined;
  const runtimeInputs = runtimeInputsFromRequest(request);
  const redactionValues = redactionValuesForRun(
    runId,
    redactionValuesFromRequestCredentials(request),
  );
  const maxRunSeconds = maxRunSecondsFromProfile(runnerProfile);
  const maxSourceArchiveBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceArchiveBytes",
  );
  const maxSourceDecompressedBytes = positiveIntegerLimitFromProfile(
    runnerProfile,
    "maxSourceDecompressedBytes",
  );
  // Credential Recipes deliver provider credentials under their declared
  // process-env names (for example CLOUDFLARE_API_TOKEN or
  // SNOWFLAKE_PASSWORD). They arrive only via the dispatched credential bundle:
  // never from Bun.env and never from the runner profile env map.
  for (const [name, value] of Object.entries(payloadCredentials)) {
    if (isAdmittedDeclaredProviderEnvName(name)) {
      env[name] = value;
    }
  }
  if (renewableCredentials.length > 0) {
    if (!runId || !credentialRefreshOwner || !credentialManifestDigest || renewableCredentials.length > MAX_RENEWABLE_CREDENTIALS) {
      throw new Error("renewable provider credentials require run identity and manifest digest");
    }
    for (const credential of renewableCredentials) {
      if (!env[credential.sourceEnvName]) {
        throw new Error("renewable provider credential is missing its initial value");
      }
    }
  }
  return {
    env,
    ...(signal ? { signal } : {}),
    ...(credentialManifest ? { credentialManifest } : {}),
    ...(credentialFiles.length > 0 ? { credentialFiles } : {}),
    ...(renewableCredentials.length > 0 ? { renewableCredentials } : {}),
    ...(credentialManifestDigest ? { credentialManifestDigest } : {}),
    ...(credentialRefreshOwner ? { credentialRefreshOwner } : {}),
    ...(runtimeInputs.length > 0 ? { runtimeInputs } : {}),
    ...(redactionValues.length > 0 ? { redactionValues } : {}),
    ...(maxRunSeconds ? { timeoutMs: maxRunSeconds * 1000 } : {}),
    ...(maxSourceArchiveBytes
      ? { sourceArchiveMaxBytes: maxSourceArchiveBytes }
      : {}),
    ...(maxSourceDecompressedBytes
      ? { sourceArchiveMaxDecompressedBytes: maxSourceDecompressedBytes }
      : {}),
  };
}

function credentialManifestDigestFromRequest(request: unknown): string | undefined {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return undefined;
  const digest = stringField(credentials, "manifestDigest");
  if (digest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("run credential manifest digest is malformed");
  }
  return digest;
}

export function renewableCredentialsFromRequest(
  request: unknown,
): readonly RenewableCredentialProjection[] {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return [];
  const raw = recordField(credentials, "renewable");
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("renewable provider credentials are malformed");
  const manifest = credentialManifestFromRequest(request);
  const env = recordField(credentials, "env");
  if (!manifest || !isRecord(env)) {
    throw new Error("renewable provider credentials require a manifest and env values");
  }
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!isRecord(entry)) throw new Error("renewable provider credential is malformed");
    const providerSource = stringField(entry, "providerSource");
    const connectionId = stringField(entry, "connectionId");
    const sourceEnvName = stringField(entry, "sourceEnvName");
    const fileEnvName = stringField(entry, "fileEnvName");
    const expiresAt = stringField(entry, "expiresAt");
    const binding = manifest.bindings.find((candidate) =>
      candidate.providerSource === providerSource && candidate.connectionId === connectionId,
    );
    if (
      !providerSource || !connectionId || !sourceEnvName || !fileEnvName ||
      !expiresAt || !Number.isFinite(Date.parse(expiresAt)) ||
      !binding || !binding.envNames.includes(sourceEnvName) ||
      !binding.fileEnvNames.includes(fileEnvName) ||
      binding.renewableEnv?.sourceEnvName !== sourceEnvName ||
      binding.renewableEnv?.fileEnvName !== fileEnvName ||
      binding.fileEnvNames.includes(sourceEnvName) ||
      typeof env[sourceEnvName] !== "string" || !validCredentialValue(env[sourceEnvName] as string) ||
      seen.has(sourceEnvName) || seen.has(fileEnvName)
    ) {
      throw new Error("renewable provider credential does not match its manifest");
    }
    seen.add(sourceEnvName);
    seen.add(fileEnvName);
    return {
      providerSource,
      connectionId,
      sourceEnvName,
      fileEnvName,
      expiresAt,
      initialValue: env[sourceEnvName] as string,
    };
  });
}

/**
 * Extracts the minted credential env map from the dispatch payload's
 * `credentials` field. Credential Recipe variables are admitted under their
 * declared env names after rejecting runner/runtime reserved names. They are
 * read only from the dispatched credential payload, never from ambient process
 * env. `TF_VAR_*` is intentionally reserved: credentials must not be smuggled
 * through generated-root input variables.
 */
export function credentialsFromRequest(
  request: unknown,
): Record<string, string> {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return {};
  const rawEnv = recordField(credentials, "env");
  const source = isRecord(rawEnv) ? rawEnv : credentials;
  const manifest = credentialManifestFromRequest(request);
  if (
    !manifest &&
    Object.keys(source).some((name) => typeof source[name] === "string")
  ) {
    throw new Error(
      "provider credentials require an explicit run credential manifest",
    );
  }
  const allowed = new Set(
    manifest?.bindings.flatMap((binding) =>
      binding.envNames.filter((name) => !binding.fileEnvNames.includes(name)),
    ) ?? [],
  );
  const out = credentialsFromRecord(source);
  for (const name of Object.keys(out)) {
    if (!allowed.has(name)) {
      throw new Error(
        `provider credential env name is not declared by the run recipe: ${name}`,
      );
    }
  }
  return out;
}

export function credentialsFromRecord(
  credentials: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(credentials)) {
    if (typeof value !== "string") continue;
    if (isAdmittedDeclaredProviderEnvName(name)) {
      out[name] = value;
    }
  }
  return out;
}

export function credentialManifestFromRequest(
  request: unknown,
): RunCredentialRecipeManifest | undefined {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return undefined;
  const value = recordField(credentials, "manifest");
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.bindings)) {
    throw new Error("run credential manifest is malformed");
  }
  const bindings = value.bindings.map((entry) => {
    if (!isRecord(entry))
      throw new Error("run credential manifest binding is malformed");
    const providerSource = stringField(entry, "providerSource");
    const connectionId = stringField(entry, "connectionId");
    const recipeId = stringField(entry, "recipeId");
    const authMode = stringField(entry, "authMode");
    const alias = stringField(entry, "alias");
    if (!providerSource || !connectionId || !recipeId || !authMode) {
      throw new Error("run credential manifest binding is malformed");
    }
    const envNames = safeManifestEnvNames(entry.envNames, "envNames");
    const fileEnvNames = safeManifestEnvNames(
      entry.fileEnvNames,
      "fileEnvNames",
    );
    if (!Array.isArray(entry.requiredEnvGroups)) {
      throw new Error("run credential manifest requiredEnvGroups is malformed");
    }
    const requiredEnvGroups = entry.requiredEnvGroups.map((group) =>
      safeManifestEnvNames(group, "requiredEnvGroups"),
    );
    const renewableEnv = entry.renewableEnv;
    if (
      renewableEnv !== undefined &&
      (!isRecord(renewableEnv) ||
        Object.keys(renewableEnv).length !== 3 ||
        typeof renewableEnv.sourceEnvName !== "string" ||
        typeof renewableEnv.fileEnvName !== "string" ||
        typeof renewableEnv.minimumProviderVersion !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(renewableEnv.minimumProviderVersion) ||
        !isAdmittedDeclaredProviderEnvName(renewableEnv.sourceEnvName) ||
        !isAdmittedDeclaredProviderEnvName(renewableEnv.fileEnvName) ||
        !envNames.includes(renewableEnv.sourceEnvName) ||
        !fileEnvNames.includes(renewableEnv.fileEnvName))) {
      throw new Error("run credential manifest renewable env is malformed");
    }
    return {
      providerSource,
      ...(alias ? { alias } : {}),
      connectionId,
      recipeId,
      authMode,
      envNames,
      fileEnvNames,
      requiredEnvGroups,
      ...(renewableEnv
        ? {
            renewableEnv: {
              sourceEnvName: renewableEnv.sourceEnvName as string,
              fileEnvName: renewableEnv.fileEnvName as string,
              minimumProviderVersion: renewableEnv.minimumProviderVersion as string,
            },
          }
        : {}),
    };
  });
  const rawFiles = value.files;
  const files =
    rawFiles === undefined
      ? undefined
      : Array.isArray(rawFiles)
        ? rawFiles.map((entry) => {
            if (!isRecord(entry))
              throw new Error("run credential manifest file is malformed");
            const path = stringField(entry, "path");
            const envName = stringField(entry, "envName");
            const mode = entry.mode;
            if (!path || typeof mode !== "number") {
              throw new Error("run credential manifest file is malformed");
            }
            assertSafeCredentialFileName(path);
            assertSafeCredentialFileMode(mode);
            if (envName && !isAdmittedDeclaredProviderEnvName(envName)) {
              throw new Error(
                `run credential manifest file env name is unsafe: ${envName}`,
              );
            }
            return {
              path,
              mode: Math.floor(mode),
              ...(envName ? { envName } : {}),
            };
          })
        : (() => {
            throw new Error("run credential manifest files is malformed");
          })();
  return { bindings, ...(files ? { files } : {}) };
}

function safeManifestEnvNames(
  value: unknown,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`run credential manifest ${field} is malformed`);
  }
  return value.map((name) => {
    if (typeof name !== "string" || !isAdmittedDeclaredProviderEnvName(name)) {
      throw new Error(
        `run credential manifest ${field} contains an unsafe env name`,
      );
    }
    return name;
  });
}

function sameExplicitProviderSource(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const trimmed = value.trim();
    return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(trimmed)
      ? `registry.opentofu.org/${trimmed}`
      : trimmed;
  };
  return normalize(left) === normalize(right);
}

export function providerCredentialFilesFromRequest(
  request: unknown,
): readonly ProviderCredentialFile[] {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return [];
  const files = recordField(credentials, "files");
  if (!Array.isArray(files)) return [];
  const manifest = credentialManifestFromRequest(request);
  if (!manifest) {
    throw new Error(
      "provider credential files require an explicit run credential manifest",
    );
  }
  return files.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("provider credential file is malformed");
    }
    const path = stringField(entry, "path");
    const content = entry.content;
    const mode = entry.mode;
    const envName = stringField(entry, "envName");
    if (
      typeof path !== "string" ||
      typeof content !== "string" ||
      typeof mode !== "number"
    ) {
      throw new Error("provider credential file is malformed");
    }
    assertSafeCredentialFileName(path);
    assertSafeCredentialFileMode(mode);
    if (envName !== undefined && !isAdmittedDeclaredProviderEnvName(envName)) {
      throw new Error(
        `provider credential file env name is unsafe: ${envName}`,
      );
    }
    const normalized = {
      path,
      content,
      mode: Math.floor(mode),
      ...(envName ? { envName } : {}),
    };
    const declared = manifest.files?.some(
      (file) =>
        file.path === normalized.path &&
        file.mode === normalized.mode &&
        file.envName === normalized.envName,
    );
    if (!declared) {
      throw new Error(
        `provider credential file is not declared by the run recipe: ${path}`,
      );
    }
    return normalized;
  });
}

export function isAdmittedDeclaredProviderEnvName(name: string): boolean {
  return isProviderEnvName(name) && !isReservedProviderEnvName(name);
}

export function redactionValuesFromRequest(request: unknown): string[] {
  return [
    ...redactionValuesFromRequestCredentials(request),
    ...sourceCredentialRedactionValuesFromRequest(request),
  ];
}

export function redactionValuesFromRequestCredentials(
  request: unknown,
): string[] {
  return [
    ...Object.values(credentialsFromRequest(request)),
    ...providerCredentialFilesFromRequest(request).map((file) => file.content),
    // A provider that echoes a run-scoped sensitive input back in a diagnostic
    // must not leak it through runner stdout/stderr.
    ...runtimeInputRedactionValues(runtimeInputsFromRequest(request)),
  ];
}

export function sourceCredentialRedactionValues(
  credentials: SourceCredentials,
): string[] {
  return [
    ...Object.values(credentials.env),
    ...credentials.files.map((file) => file.content),
  ];
}

export function sourceCredentialRedactionValuesFromRequest(
  request: unknown,
): string[] {
  try {
    return sourceCredentialRedactionValues(parseSourceCredentials(request));
  } catch {
    return [];
  }
}

export async function prepareProviderCredentialFiles(
  context: CommandContext,
  _workspace: RunWorkspace,
  runId?: string,
): Promise<PreparedProviderCredentialFiles> {
  const files = context.credentialFiles ?? [];
  const renewable = context.renewableCredentials ?? [];
  if (files.length === 0 && renewable.length === 0) {
    return { context, cleanup: async () => {} };
  }
  // A SIBLING of the run workspace with a random suffix, never a child of it:
  // the source-build phase runs user commands inside `workspace.sourceRoot`,
  // and `<workspace.root>/.provider-credentials` was one `../` away from them.
  const tmpInfo = await lstat("/tmp");
  if (!tmpInfo.isDirectory() || tmpInfo.isSymbolicLink()) {
    throw new Error("run credential parent directory is unsafe");
  }
  const credentialDir = await mkdtemp("/tmp/takosumi-run-credentials-");
  let session: CredentialRefreshSession | undefined;
  let sessionRegistered = false;
  try {
    await chmod(credentialDir, 0o700);
    const env: Record<string, string> = { ...context.env };
    const renewableFiles = new Map<string, string>();
    for (const file of files) {
      assertSafeCredentialFileName(file.path);
      assertSafeCredentialFileMode(file.mode);
      const target = join(credentialDir, file.path);
      await writeFile(target, file.content, { mode: file.mode });
      await chmod(target, file.mode);
      if (file.envName) {
        if (!isAdmittedDeclaredProviderEnvName(file.envName)) {
          throw new Error(
            `provider credential file env name is unsafe: ${file.envName}`,
          );
        }
        env[file.envName] = target;
      }
    }
    for (const credential of renewable) {
      const target = join(credentialDir, `renewable-${randomUUID()}`);
      await replaceCredentialFile(target, credential.initialValue);
      await chmod(target, 0o600);
      delete env[credential.sourceEnvName];
      env[credential.fileEnvName] = target;
      renewableFiles.set(credential.fileEnvName, target);
    }
    if (renewable.length > 0) {
      if (!runId || !context.credentialRefreshOwner || !context.credentialManifestDigest) {
        throw new Error("renewable credentials lost run identity or manifest digest");
      }
      if (
        !context.credentialManifest ||
        await stableJsonDigest(context.credentialManifest) !== context.credentialManifestDigest
      ) {
        throw new Error("renewable credential manifest digest mismatch");
      }
      if (activeCredentialRefreshSessions.has(runId)) {
        throw new Error("credential refresh session already exists for run");
      }
      session = new CredentialRefreshSession(
        runId,
        context.credentialRefreshOwner,
        context.credentialManifestDigest,
        renewable,
        renewableFiles,
        (context.redactionValues ?? []) as string[],
        context.signal,
      );
      activeCredentialRefreshSessions.set(runId, session);
      sessionRegistered = true;
    }
    return {
      context: {
        ...context,
        env,
        ...(session ? { redactionValues: session.redactionValues } : {}),
      },
      cleanup: async () => {
        try {
          if (session) {
            await session.close();
            if (activeCredentialRefreshSessions.get(runId!) === session) {
              activeCredentialRefreshSessions.delete(runId!);
            }
          }
        } finally {
          await shredCredentialDir(credentialDir);
        }
      },
    };
  } catch (error) {
    if (sessionRegistered && runId && activeCredentialRefreshSessions.get(runId) === session) {
      activeCredentialRefreshSessions.delete(runId);
    }
    await session?.close().catch(() => {});
    await shredCredentialDir(credentialDir);
    throw error;
  }
}

export function baseCommandEnv(): Record<string, string> {
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

/**
 * Builds the env for credential-free source preparation and compatibility
 * checks. User-approved source-build commands run against a reviewed checkout
 * and MUST NOT see any provider credential.
 */
export function buildPhaseEnv(): Record<string, string> {
  return baseCommandEnv();
}

export function assertCommandEnvHasNoProviderCredentials(
  env: Readonly<Record<string, string>>,
  additionalAllowedNames: readonly string[] = [],
): void {
  const allowedNames = new Set([
    ...Object.keys(baseCommandEnv()),
    ...additionalAllowedNames,
  ]);
  for (const name of Object.keys(env)) {
    if (!allowedNames.has(name)) {
      throw new Error(
        `build command env unexpectedly carries undeclared name ${name}`,
      );
    }
  }
}

export function assertCredentialEnvAvailable(
  requiredProviders: readonly string[],
  runnerProfile: JsonRecord,
  env: Readonly<Record<string, string>>,
  manifest?: RunCredentialRecipeManifest,
): void {
  const requireProviderBindings =
    recordField(runnerProfile, "requireProviderBindings") === true;
  for (const binding of manifest?.bindings ?? []) {
    const requiredGroups = binding.requiredEnvGroups;
    const envNames = binding.envNames;
    const hasRequiredGroup =
      requiredGroups.length === 0
        ? envNames.some((envName) => env[envName] || renewableFileEnvName(manifest, envName, env))
        : requiredGroups.some((group) =>
            group.every((envName) => env[envName] || renewableFileEnvName(manifest, envName, env)),
          );
    if (!hasRequiredGroup) {
      throw new Error(
        `required credential env for provider ${binding.providerSource} is not available in runner environment`,
      );
    }
  }
  if (requireProviderBindings) {
    for (const provider of requiredProviders) {
      if (
        !(manifest?.bindings ?? []).some((binding) =>
          sameExplicitProviderSource(provider, binding.providerSource),
        )
      ) {
        throw new Error(
          `explicit run credential recipe is required for provider ${provider}`,
        );
      }
    }
  }
}

function renewableFileEnvName(
  manifest: RunCredentialRecipeManifest | undefined,
  sourceEnvName: string,
  env: Readonly<Record<string, string>>,
): boolean {
  // The source bearer is intentionally absent from the child environment.
  // The declared file variable is the positive evidence that its renewable
  // projection was materialized successfully.
  return (manifest?.bindings ?? []).some((binding) =>
    binding.envNames.includes(sourceEnvName) &&
    binding.renewableEnv?.sourceEnvName === sourceEnvName &&
    Boolean(env[binding.renewableEnv.fileEnvName]),
  );
}
