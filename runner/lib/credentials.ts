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
  PrivateRunFileDispatch,
  RunCredentialRefreshUpdate,
  CredentialRefreshSessionMetadata,
} from "./types.ts";
import { BASE_COMMAND_ENV_NAMES } from "./constants.ts";
import {
  isRecord,
  recordField,
  stringField,
  digestBytes,
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
import {
  MAX_PRIVATE_RUN_FILE_DESCRIPTOR_BYTES,
  MAX_PRIVATE_RUN_FILE_DISPATCHES,
  MAX_PRIVATE_RUN_FILE_ROTATIONS,
  PRIVATE_RUN_FILE_DESCRIPTOR_ENV,
  privateRunFileManifestDigest,
  type PrivateRunFileDescriptorFile,
  type PrivateRunFileRefreshFile,
  type PrivateRunFileRefreshOwner,
  type PrivateRunFileRefreshUpdate,
} from "../../core/shared/private_run_file_refresh.ts";

// A 120-second credential renewed 90 seconds before expiry can rotate every
// 30 seconds. Keep a large finite history for supported long-running plans.
const MAX_ROTATIONS_PER_RUN = 2_048;
const MAX_RENEWABLE_CREDENTIALS = 32;
const MAX_REDACTION_VALUES_PER_RUN = 4_096;
const MAX_REDACTION_VALUE_BYTES_PER_RUN = 16 * 1024 * 1024;
type RenewableCredentialIdentity = Omit<RenewableCredentialProjection, "initialValue">;
const activeCredentialRefreshSessions = new Map<string, CredentialRefreshSession>();
const activeRunRedactionValues = new Map<string, string[]>();
const activePrivateRunFileRefreshSessions = new Map<string, PrivateRunFileRefreshSession>();

async function stableCredentialManifestDigest(value: unknown): Promise<string> {
  return await digestBytes(new TextEncoder().encode(stableCredentialJson(value)));
}

function stableCredentialJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableCredentialJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableCredentialJson(record[key])}`
  ).join(",")}}`;
}

function sameRenewableDescriptors(
  left: readonly RenewableCredentialIdentity[],
  right: readonly RenewableCredentialIdentity[],
): boolean {
  const key = (item: RenewableCredentialIdentity) =>
    `${item.providerSource}\0${item.connectionId}\0${item.sourceEnvName}\0${item.fileEnvName}`;
  const leftKeys = [...left].map(key).sort();
  const rightKeys = [...right].map(key).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index]);
}

export async function credentialDirPrefixForWorkspace(
  workspace: RunWorkspace,
): Promise<string> {
  const digest = await digestBytes(new TextEncoder().encode(workspace.root));
  return `takosumi-run-credentials-${digest.slice("sha256:".length, "sha256:".length + 16)}-`;
}

class CredentialRefreshSession {
  #sequence: number;
  #closed = false;
  #rotations = 0;
  #tail: Promise<void> = Promise.resolve();
  #promoted = false;
  #currentByFileEnvName: Map<string, { descriptor: RenewableCredentialIdentity; value: string }>;
  #filesByEnvName = new Map<string, string>();

  constructor(
    readonly runId: string,
    readonly owner: NonNullable<CommandContext["credentialRefreshOwner"]>,
    readonly manifestDigest: string,
    descriptors: readonly RenewableCredentialProjection[],
    readonly redactionValues: string[],
    readonly signal?: AbortSignal,
    initialSequence = 0,
  ) {
    this.#sequence = initialSequence;
    this.#rotations = initialSequence;
    this.descriptors = descriptors.map(({ initialValue: _initialValue, ...descriptor }) => descriptor);
    this.#currentByFileEnvName = new Map(descriptors.map(({ initialValue, ...descriptor }) => [
      descriptor.fileEnvName,
      { descriptor, value: initialValue },
    ]));
  }

  readonly descriptors: readonly RenewableCredentialIdentity[];

  get metadata() {
    return {
      owner: this.owner,
      runnerRunId: this.runId,
      manifestDigest: this.manifestDigest,
      sequence: this.#sequence,
    } as const;
  }

  matches(context: CommandContext): boolean {
    const owner = context.credentialRefreshOwner;
    return !!owner && owner.kind === this.owner.kind && owner.id === this.owner.id &&
      context.credentialManifestDigest === this.manifestDigest &&
      sameRenewableDescriptors(context.renewableCredentials ?? [], this.descriptors);
  }

  async promote(filesByEnvName: ReadonlyMap<string, string>): Promise<void> {
    await this.#serialize(async () => {
      if (this.#closed || this.signal?.aborted) throw new Error("credential refresh is no longer active");
      if (this.#promoted) throw new Error("credential refresh session is already promoted");
      for (const descriptor of this.descriptors) {
        const target = filesByEnvName.get(descriptor.fileEnvName);
        const current = this.#currentByFileEnvName.get(descriptor.fileEnvName);
        if (!target || !current) throw new Error("credential refresh projection is incomplete");
        await replaceCredentialFile(target, current.value);
      }
      this.#filesByEnvName = new Map(filesByEnvName);
      this.#promoted = true;
    });
  }

  async update(update: RunCredentialRefreshUpdate): Promise<void> {
    await this.#serialize(async () => {
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
      ) throw new Error("credential refresh identity or sequence mismatch");
      const item = update.credentials[0]!;
      const descriptor = this.descriptors.find((candidate) =>
        candidate.providerSource === item.providerSource &&
        candidate.connectionId === item.connectionId &&
        candidate.sourceEnvName === item.sourceEnvName &&
        candidate.fileEnvName === item.fileEnvName,
      );
      if (
        !descriptor || !validCredentialValue(item.value) ||
        !Number.isFinite(Date.parse(item.expiresAt))
      ) throw new Error("credential refresh descriptor mismatch");
      const target = this.#filesByEnvName.get(descriptor.fileEnvName);
      if (this.#promoted) {
        if (!target) throw new Error("credential refresh target is unavailable");
        const info = await lstat(target);
        if (
          !info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())
        ) throw new Error("credential refresh target is not a private runner file");
      }
      const addedBytes = this.redactionValues.includes(item.value)
        ? 0
        : new TextEncoder().encode(item.value).byteLength;
      const currentBytes = this.redactionValues.reduce(
        (total, value) => total + new TextEncoder().encode(value).byteLength,
        0,
      );
      if (
        (!this.redactionValues.includes(item.value) && this.redactionValues.length >= MAX_REDACTION_VALUES_PER_RUN) ||
        currentBytes + addedBytes > MAX_REDACTION_VALUE_BYTES_PER_RUN
      ) throw new Error("credential refresh redaction history limit exceeded");
      // Redaction admission precedes filesystem writes and pending-session
      // replacement, so even an ambiguous failed promotion cannot leak it.
      if (!this.redactionValues.includes(item.value)) this.redactionValues.push(item.value);
      if (this.#promoted) await replaceCredentialFile(target!, item.value);
      this.#currentByFileEnvName.set(descriptor.fileEnvName, {
        descriptor: { ...descriptor, expiresAt: item.expiresAt },
        value: item.value,
      });
      this.#sequence = update.sequence;
      this.#rotations += 1;
    });
  }

  async #serialize(work: () => Promise<void>): Promise<void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await work();
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    this.#currentByFileEnvName.clear();
    this.#filesByEnvName.clear();
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

class PrivateRunFileRefreshSession {
  #sequence: number;
  #closed = false;
  #rotations: number;
  #tail: Promise<void> = Promise.resolve();
  #descriptorPath: string | undefined;
  #files: readonly PrivateRunFileRefreshFile[];

  constructor(
    readonly runId: string,
    readonly owner: PrivateRunFileRefreshOwner,
    readonly manifestDigest: string,
    files: readonly PrivateRunFileRefreshFile[],
    readonly redactionValues: string[],
    readonly signal: AbortSignal | undefined,
    initialSequence: number,
  ) {
    this.#sequence = initialSequence;
    this.#rotations = initialSequence;
    this.#files = [...files];
  }

  get metadata() {
    return {
      owner: this.owner,
      runnerRunId: this.runId,
      manifestDigest: this.manifestDigest,
      sequence: this.#sequence,
    } as const;
  }

  matches(context: CommandContext): boolean {
    return context.privateRunFiles !== undefined &&
      samePrivateRunFileIdentity(context.privateRunFiles, this.#files) &&
      context.privateRunFileRefreshOwner?.kind === this.owner.kind &&
      context.privateRunFileRefreshOwner.id === this.owner.id;
  }

  async promote(path: string): Promise<void> {
    await this.#serialize(async () => {
      if (this.#closed || this.signal?.aborted) {
        throw new Error("private Run file refresh is no longer active");
      }
      if (this.#descriptorPath) throw new Error("private Run file descriptor is already promoted");
      if (!this.redactionValues.includes(path)) {
        if (this.redactionValues.length >= MAX_REDACTION_VALUES_PER_RUN) {
          throw new Error("private Run file redaction history limit exceeded");
        }
        this.redactionValues.push(path);
      }
      try {
        await publishPrivateRunFileDescriptor(path, this.#envelope(), undefined);
      } catch {
        throw new Error("private Run file descriptor publication failed");
      }
      this.#descriptorPath = path;
    });
  }

  async update(update: PrivateRunFileRefreshUpdate): Promise<void> {
    await this.#serialize(async () => {
      if (this.#closed || this.signal?.aborted) {
        throw new Error("private Run file refresh is no longer active");
      }
      if (
        update.kind !== "takosumi.private-run-files.refresh@v1" ||
        update.owner.kind !== this.owner.kind || update.owner.id !== this.owner.id ||
        update.runnerRunId !== this.runId || update.manifestDigest !== this.manifestDigest ||
        !samePrivateRunFileIdentity(update.files, this.#files)
      ) throw new Error("private Run file refresh identity mismatch");

      if (update.sequence === this.#sequence) {
        if (!samePrivateRunFilesExactly(update.files, this.#files)) {
          throw new Error("private Run file refresh replay mismatch");
        }
        if (this.#descriptorPath) {
          try {
            await assertPrivateRunFileDescriptorMatches(
              this.#descriptorPath,
              this.#envelope(),
            );
          } catch {
            throw new Error("private Run file descriptor replay reconciliation failed");
          }
        }
        return;
      }
      if (update.sequence !== this.#sequence + 1) {
        throw new Error("private Run file refresh sequence mismatch");
      }
      if (this.#rotations >= MAX_PRIVATE_RUN_FILE_ROTATIONS) {
        throw new Error("private Run file refresh rotation limit exceeded");
      }
      for (const descriptor of update.files) {
        if (!isPrintableOpaqueGrant(descriptor.grant)) {
          throw new Error("private Run file refresh descriptor is invalid");
        }
      }
      const newValues = update.files.map(({ grant }) => grant)
        .filter((grant) => !this.redactionValues.includes(grant));
      const currentBytes = this.redactionValues.reduce(
        (total, value) => total + new TextEncoder().encode(value).byteLength,
        0,
      );
      const addedBytes = newValues.reduce(
        (total, value) => total + new TextEncoder().encode(value).byteLength,
        0,
      );
      if (
        this.redactionValues.length + newValues.length > MAX_REDACTION_VALUES_PER_RUN ||
        currentBytes + addedBytes > MAX_REDACTION_VALUE_BYTES_PER_RUN
      ) throw new Error("private Run file refresh redaction history limit exceeded");
      // Keep every newly minted grant redacted even if a filesystem publication
      // becomes indeterminate after the atomic rename.
      this.redactionValues.push(...newValues);

      if (this.#descriptorPath) {
        const nextEnvelope = this.#envelope(update.sequence, update.files);
        try {
          await publishPrivateRunFileDescriptor(
            this.#descriptorPath,
            nextEnvelope,
            this.#envelope(),
          );
        } catch {
          throw new Error("private Run file descriptor publication failed");
        }
      }
      this.#files = [...update.files];
      this.#sequence = update.sequence;
      this.#rotations += 1;
    });
  }

  async #serialize(work: () => Promise<void>): Promise<void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await work();
    } finally {
      release();
    }
  }

  #envelope(
    sequence = this.#sequence,
    files = this.#files,
  ): PrivateRunFileDescriptorFile {
    return { version: 1, sequence, files };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    this.#files = [];
    this.#descriptorPath = undefined;
  }
}

function isPrintableOpaqueGrant(value: string): boolean {
  return value.length > 0 && value.length <= 16_384 && /^[\x21-\x7e]+$/u.test(value);
}

function samePrivateRunFileIdentity(
  left: readonly PrivateRunFileRefreshFile[],
  right: readonly PrivateRunFileRefreshFile[],
): boolean {
  const identities = (files: readonly PrivateRunFileRefreshFile[]) =>
    files.map(({ slot, endpoint }) => `${slot}\0${endpoint}`).sort();
  const leftIdentities = identities(left);
  const rightIdentities = identities(right);
  return leftIdentities.length === rightIdentities.length &&
    leftIdentities.every((identity, index) => identity === rightIdentities[index]);
}

function samePrivateRunFilesExactly(
  left: readonly PrivateRunFileRefreshFile[],
  right: readonly PrivateRunFileRefreshFile[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.slot === other.slot &&
      item.endpoint === other.endpoint && item.grant === other.grant;
  });
}

function privateRunFileDescriptorBytes(
  envelope: PrivateRunFileDescriptorFile,
): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (bytes.byteLength > MAX_PRIVATE_RUN_FILE_DESCRIPTOR_BYTES) {
    throw new Error("private Run file descriptor exceeds its size limit");
  }
  return bytes;
}

async function assertPrivateRunFileDirectory(path: string): Promise<void> {
  const directory = await lstat(dirname(path));
  if (
    !directory.isDirectory() || directory.isSymbolicLink() ||
    (directory.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && directory.uid !== process.getuid())
  ) throw new Error("private Run file descriptor directory is unsafe");
}

async function readPrivateRunFileDescriptor(
  path: string,
): Promise<{ readonly envelope: PrivateRunFileDescriptorFile; readonly bytes: Uint8Array }> {
  await assertPrivateRunFileDirectory(path);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (
      !info.isFile() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      info.size > MAX_PRIVATE_RUN_FILE_DESCRIPTOR_BYTES
    ) throw new Error("private Run file descriptor is unsafe");
    const text = await handle.readFile({ encoding: "utf8" });
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAX_PRIVATE_RUN_FILE_DESCRIPTOR_BYTES) {
      throw new Error("private Run file descriptor exceeds its size limit");
    }
    const parsed = JSON.parse(text) as unknown;
    if (
      !isRecord(parsed) || parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 0 ||
      (parsed.sequence as number) > MAX_PRIVATE_RUN_FILE_ROTATIONS ||
      !Array.isArray(parsed.files)
    ) throw new Error("private Run file descriptor is malformed");
    const files = validatePrivateRunFiles(parsed.files);
    const envelope: PrivateRunFileDescriptorFile = {
      version: 1,
      sequence: parsed.sequence as number,
      files,
    };
    if (JSON.stringify(envelope) !== text) {
      throw new Error("private Run file descriptor is not canonical");
    }
    return { envelope, bytes };
  } finally {
    await handle.close();
  }
}

async function assertPrivateRunFileDescriptorMatches(
  path: string,
  expected: PrivateRunFileDescriptorFile,
): Promise<void> {
  const current = await readPrivateRunFileDescriptor(path);
  if (JSON.stringify(current.envelope) !== JSON.stringify(expected)) {
    throw new Error("private Run file descriptor content mismatch");
  }
}

async function syncPrivateRunFileDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function publishPrivateRunFileDescriptor(
  path: string,
  next: PrivateRunFileDescriptorFile,
  expectedCurrent: PrivateRunFileDescriptorFile | undefined,
): Promise<void> {
  await assertPrivateRunFileDirectory(path);
  const bytes = privateRunFileDescriptorBytes(next);
  let current: PrivateRunFileDescriptorFile | undefined;
  try {
    current = (await readPrivateRunFileDescriptor(path)).envelope;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (expectedCurrent === undefined) {
    if (current !== undefined) throw new Error("private Run file descriptor already exists");
  } else if (current !== undefined) {
    if (JSON.stringify(current) === JSON.stringify(next)) {
      // Recover a prior publication whose caller did not observe the directory
      // fsync/ACK. Re-fence both file contents and the containing directory.
      const existing = await open(path, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        await existing.sync();
      } finally {
        await existing.close();
      }
      await syncPrivateRunFileDirectory(path);
      return;
    }
    if (JSON.stringify(current) !== JSON.stringify(expectedCurrent)) {
      throw new Error("private Run file descriptor changed unexpectedly");
    }
  } else {
    throw new Error("private Run file descriptor is missing");
  }

  const temporary = join(dirname(path), `.private-run-files-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const temporaryInfo = await handle.stat();
    if (
      !temporaryInfo.isFile() || (temporaryInfo.mode & 0o777) !== 0o600 ||
      temporaryInfo.nlink !== 1 ||
      (typeof process.getuid === "function" && temporaryInfo.uid !== process.getuid())
    ) throw new Error("private Run file descriptor temporary is unsafe");
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const published = await readPrivateRunFileDescriptor(path);
    if (JSON.stringify(published.envelope) !== JSON.stringify(next)) {
      throw new Error("private Run file descriptor publication mismatch");
    }
    const finalHandle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      await finalHandle.sync();
    } finally {
      await finalHandle.close();
    }
    await syncPrivateRunFileDirectory(path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function validatePrivateRunFiles(value: unknown): readonly PrivateRunFileRefreshFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRIVATE_RUN_FILE_DISPATCHES) {
    throw new Error("private Run file refresh descriptor set is invalid");
  }
  const files = privateRunFilesFromRequest({ privateRunFiles: value });
  if (files.some(({ grant }) => !isPrintableOpaqueGrant(grant))) {
    throw new Error("private Run file refresh descriptor set is invalid");
  }
  return files;
}

function parsePrivateRunFileRefreshUpdate(value: unknown): PrivateRunFileRefreshUpdate {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    value.kind !== "takosumi.private-run-files.refresh@v1" ||
    !isRecord(value.owner) || Object.keys(value.owner).length !== 2 ||
    (value.owner.kind !== "plan" && value.owner.kind !== "apply") ||
    typeof value.owner.id !== "string" || value.owner.id.length === 0 ||
    typeof value.runnerRunId !== "string" ||
    typeof value.manifestDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.manifestDigest) ||
    !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
  ) throw new Error("private Run file refresh update is malformed");
  return {
    kind: "takosumi.private-run-files.refresh@v1",
    owner: { kind: value.owner.kind, id: value.owner.id },
    runnerRunId: value.runnerRunId,
    manifestDigest: value.manifestDigest,
    sequence: value.sequence as number,
    files: validatePrivateRunFiles(value.files),
  };
}

export function setRunRedactionValues(runId: string, values: string[]): void {
  activeRunRedactionValues.set(runId, values);
}

export function clearRunRedactionValues(runId: string, values: string[]): void {
  if (activeRunRedactionValues.get(runId) === values) activeRunRedactionValues.delete(runId);
}

export async function beginRunCredentialRefreshSession(
  runId: string,
  action: "plan" | "apply" | "destroy",
  request: unknown,
  signal: AbortSignal | undefined,
  redactionValues: string[],
): Promise<object | undefined> {
  const profile = recordField(request, "runnerProfile");
  const context = commandContextFromRequest(
    request,
    isRecord(profile) ? profile : undefined,
    signal,
    runId,
  );
  const descriptors = context.renewableCredentials ?? [];
  if (descriptors.length === 0) {
    if (context.credentialRefreshSequence !== undefined) {
      throw new Error("credential refresh sequence has no renewable descriptors");
    }
    return undefined;
  }
  const owner = context.credentialRefreshOwner;
  const expectedKind = action === "plan" ? "plan" : "apply";
  if (!owner || owner.kind !== expectedKind || !context.credentialManifestDigest) {
    throw new Error("renewable credentials have no exact action owner");
  }
  if (
    !context.credentialManifest ||
    await stableCredentialManifestDigest(context.credentialManifest) !== context.credentialManifestDigest
  ) throw new Error("renewable credential manifest digest mismatch");
  if (activeCredentialRefreshSessions.has(runId)) {
    throw new Error("credential refresh session already exists for run");
  }
  if (signal?.aborted) throw new Error("credential refresh is no longer active");
  const session = new CredentialRefreshSession(
    runId,
    owner,
    context.credentialManifestDigest,
    descriptors,
    redactionValues,
    signal,
    context.credentialRefreshSequence ?? 0,
  );
  activeCredentialRefreshSessions.set(runId, session);
  return session;
}

export function runCredentialRefreshSessionMetadata(
  runId: string,
): CredentialRefreshSessionMetadata | undefined {
  return activeCredentialRefreshSessions.get(runId)?.metadata;
}

export async function endRunCredentialRefreshSession(
  runId: string,
  handle: object | undefined,
): Promise<void> {
  if (!handle) return;
  const session = activeCredentialRefreshSessions.get(runId);
  if (!session || session !== handle) return;
  activeCredentialRefreshSessions.delete(runId);
  await session.close();
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

export async function beginRunPrivateRunFileRefreshSession(
  runId: string,
  action: "plan" | "apply" | "destroy",
  request: unknown,
  signal: AbortSignal | undefined,
  redactionValues: string[],
  initialSequence = 0,
): Promise<object | undefined> {
  const files = privateRunFilesFromRequest(request);
  if (files.length === 0) {
    if (initialSequence !== 0) {
      throw new Error("private Run file refresh sequence has no descriptors");
    }
    return undefined;
  }
  if (
    files.length > MAX_PRIVATE_RUN_FILE_DISPATCHES ||
    !Number.isSafeInteger(initialSequence) || initialSequence < 0 ||
    initialSequence > MAX_PRIVATE_RUN_FILE_ROTATIONS
  ) throw new Error("private Run file refresh initial state is malformed");
  const profile = recordField(request, "runnerProfile");
  const context = commandContextFromRequest(
    request,
    isRecord(profile) ? profile : undefined,
    signal,
    runId,
  );
  const owner = context.privateRunFileRefreshOwner;
  const expectedKind = action === "plan" ? "plan" : "apply";
  if (!owner || owner.kind !== expectedKind) {
    throw new Error("private Run file refresh has no exact Run owner");
  }
  if (signal?.aborted) throw new Error("private Run file refresh is no longer active");
  if (activePrivateRunFileRefreshSessions.has(runId)) {
    throw new Error("private Run file refresh session already exists for Run");
  }
  const manifestDigest = await privateRunFileManifestDigest({
    owner,
    runnerRunId: runId,
    files,
  });
  const session = new PrivateRunFileRefreshSession(
    runId,
    owner,
    manifestDigest,
    files,
    redactionValues,
    signal,
    initialSequence,
  );
  activePrivateRunFileRefreshSessions.set(runId, session);
  return session;
}

export function runPrivateRunFileRefreshSessionMetadata(
  runId: string,
): PrivateRunFileRefreshSession["metadata"] | undefined {
  return activePrivateRunFileRefreshSessions.get(runId)?.metadata;
}

export async function refreshRunPrivateFiles(
  runId: string,
  value: unknown,
): Promise<number> {
  const session = activePrivateRunFileRefreshSessions.get(runId);
  if (!session) throw new Error("no active private Run file refresh session");
  const update = parsePrivateRunFileRefreshUpdate(value);
  await session.update(update);
  return session.metadata.sequence;
}

export async function endRunPrivateRunFileRefreshSession(
  runId: string,
  handle: object | undefined,
): Promise<void> {
  if (!handle) return;
  const session = activePrivateRunFileRefreshSessions.get(runId);
  if (!session || session !== handle) return;
  activePrivateRunFileRefreshSessions.delete(runId);
  await session.close();
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
  const credentialRefreshSequence = credentialRefreshSequenceFromRequest(request);
  const applyRun = recordField(request, "applyRun");
  const applyRunId = isRecord(applyRun)
    ? stringField(applyRun, "id")
    : undefined;
  const privateRunFileRefreshOwner = applyRunId
    ? { kind: "apply" as const, id: applyRunId }
    : runId
      ? { kind: "plan" as const, id: runId }
      : undefined;
  const credentialRefreshOwner = applyRunId
    ? { kind: "apply" as const, id: applyRunId }
    : runId
      ? { kind: "plan" as const, id: runId }
      : undefined;
  const runtimeInputs = runtimeInputsFromRequest(request);
  const privateRunFiles = privateRunFilesFromRequest(request);
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
      // Keep bearer values in the in-memory session until private-file promotion.
      delete env[credential.sourceEnvName];
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
    ...(credentialRefreshSequence !== undefined ? { credentialRefreshSequence } : {}),
    ...(runtimeInputs.length > 0 ? { runtimeInputs } : {}),
    ...(privateRunFiles.length > 0 ? { privateRunFiles } : {}),
    ...(privateRunFileRefreshOwner ? { privateRunFileRefreshOwner } : {}),
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

/** Materialize private-file authority only for the trusted OpenTofu process. */
export function openTofuCommandContext(
  context: CommandContext,
): CommandContext {
  if (!context.privateRunFiles?.length) return context;
  if (!context.privateRunFilesFile) {
    throw new Error("private Run file descriptor is not promoted");
  }
  return {
    ...context,
    env: {
      ...context.env,
      [PRIVATE_RUN_FILE_DESCRIPTOR_ENV]: context.privateRunFilesFile,
    },
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

function credentialRefreshSequenceFromRequest(request: unknown): number | undefined {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return undefined;
  const sequence = credentials.refreshSequence;
  if (sequence === undefined) return undefined;
  if (
    !Number.isSafeInteger(sequence) || (sequence as number) < 0 ||
    (sequence as number) > MAX_ROTATIONS_PER_RUN
  ) throw new Error("run credential refresh sequence is malformed");
  return sequence as number;
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
    ...privateRunFilesFromRequest(request).map((grant) => grant.grant),
  ];
}

export function privateRunFilesFromRequest(
  request: unknown,
): readonly PrivateRunFileDispatch[] {
  const raw = recordField(request, "privateRunFiles");
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("private Run file grants are malformed");
  }
  if (raw.length > MAX_PRIVATE_RUN_FILE_DISPATCHES) {
    throw new Error("private Run file grants exceed their count limit");
  }
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(entry, "slot") ||
      !Object.prototype.hasOwnProperty.call(entry, "endpoint") ||
      !Object.prototype.hasOwnProperty.call(entry, "grant")
    ) {
      throw new Error("private Run file grant is malformed");
    }
    const { slot, endpoint, grant } = entry;
    if (
      typeof slot !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(slot) ||
      seen.has(slot) ||
      typeof endpoint !== "string" || endpoint.length > 2_048 ||
      typeof grant !== "string" || !isPrintableOpaqueGrant(grant)
    ) {
      throw new Error("private Run file grant is invalid");
    }
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new Error("private Run file grant is invalid");
    }
    if (
      (parsedEndpoint.protocol !== "https:" && parsedEndpoint.protocol !== "http:") ||
      parsedEndpoint.username !== "" || parsedEndpoint.password !== "" ||
      parsedEndpoint.search !== "" || parsedEndpoint.hash !== ""
    ) {
      throw new Error("private Run file grant is invalid");
    }
    seen.add(slot);
    return { slot, endpoint: parsedEndpoint.toString().replace(/\/$/u, ""), grant };
  });
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
  workspace: RunWorkspace,
  runId?: string,
): Promise<PreparedProviderCredentialFiles> {
  const files = context.credentialFiles ?? [];
  const renewable = context.renewableCredentials ?? [];
  const privateRunFiles = context.privateRunFiles ?? [];
  if (files.length === 0 && renewable.length === 0 && privateRunFiles.length === 0) {
    return { context, cleanup: async () => {} };
  }
  // A SIBLING of the run workspace with a random suffix, never a child of it:
  // the source-build phase runs user commands inside `workspace.sourceRoot`,
  // and `<workspace.root>/.provider-credentials` was one `../` away from them.
  const tmpInfo = await lstat("/tmp");
  if (!tmpInfo.isDirectory() || tmpInfo.isSymbolicLink()) {
    throw new Error("run credential parent directory is unsafe");
  }
  let credentialDir: string | undefined;
  let session: CredentialRefreshSession | undefined;
  let privateRunFileSession: PrivateRunFileRefreshSession | undefined;
  let sessionRegistered = false;
  let createdSession = false;
  let privateRunFileSessionRegistered = false;
  try {
    try {
      credentialDir = await mkdtemp(`/tmp/${await credentialDirPrefixForWorkspace(workspace)}`);
    } catch {
      if (privateRunFiles.length > 0) throw new Error("private Run file preparation failed");
      throw new Error("run credential directory creation failed");
    }
    if (!credentialDir) throw new Error("credential directory was not created");
    const ownedCredentialDir = credentialDir;
    await chmod(credentialDir, 0o700);
    const env: Record<string, string> = { ...context.env };
    const renewableFiles = new Map<string, string>();
    if (renewable.length > 0) {
      if (!runId || !context.credentialRefreshOwner || !context.credentialManifestDigest) {
        throw new Error("renewable credentials lost run identity or manifest digest");
      }
      if (
        !context.credentialManifest ||
        await stableCredentialManifestDigest(context.credentialManifest) !== context.credentialManifestDigest
      ) throw new Error("renewable credential manifest digest mismatch");
      const pendingSession = activeCredentialRefreshSessions.get(runId);
      if (pendingSession) {
        if (!pendingSession.matches(context)) {
          throw new Error("pending credential refresh session does not match dispatch");
        }
        session = pendingSession;
      } else {
        session = new CredentialRefreshSession(
          runId,
          context.credentialRefreshOwner,
          context.credentialManifestDigest,
          renewable,
          (context.redactionValues ?? []) as string[],
          context.signal,
          context.credentialRefreshSequence ?? 0,
        );
        activeCredentialRefreshSessions.set(runId, session);
        sessionRegistered = true;
        createdSession = true;
      }
    }
    if (privateRunFiles.length > 0) {
      const owner = context.privateRunFileRefreshOwner;
      if (!runId || !owner) {
        throw new Error("private Run files lost Run identity or owner");
      }
      const manifestDigest = await privateRunFileManifestDigest({
        owner,
        runnerRunId: runId,
        files: privateRunFiles,
      });
      const pendingSession = activePrivateRunFileRefreshSessions.get(runId);
      if (pendingSession) {
        if (!pendingSession.matches(context)) {
          throw new Error("pending private Run file refresh session does not match dispatch");
        }
        privateRunFileSession = pendingSession;
      } else {
        privateRunFileSession = new PrivateRunFileRefreshSession(
          runId,
          owner,
          manifestDigest,
          privateRunFiles,
          (context.redactionValues ?? []) as string[],
          context.signal,
          0,
        );
        activePrivateRunFileRefreshSessions.set(runId, privateRunFileSession);
        privateRunFileSessionRegistered = true;
      }
    }
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
      delete env[credential.sourceEnvName];
      env[credential.fileEnvName] = target;
      renewableFiles.set(credential.fileEnvName, target);
    }
    if (session) await session.promote(renewableFiles);
    let privateRunFilesFile: string | undefined;
    if (privateRunFileSession) {
      privateRunFilesFile = join(credentialDir, "private-run-files.json");
      await privateRunFileSession.promote(privateRunFilesFile);
    }
    return {
      context: {
        ...context,
        env,
        ...(privateRunFilesFile ? { privateRunFilesFile } : {}),
        ...(session ? { redactionValues: session.redactionValues } : {}),
        ...(privateRunFileSession
          ? { redactionValues: privateRunFileSession.redactionValues }
          : {}),
      },
      cleanup: async () => {
        try {
          if (session) {
            await session.close();
            if (activeCredentialRefreshSessions.get(runId!) === session) {
              activeCredentialRefreshSessions.delete(runId!);
            }
          }
          if (privateRunFileSession) {
            await privateRunFileSession.close();
            if (activePrivateRunFileRefreshSessions.get(runId!) === privateRunFileSession) {
              activePrivateRunFileRefreshSessions.delete(runId!);
            }
          }
        } finally {
          await shredCredentialDir(ownedCredentialDir);
        }
      },
    };
  } catch (error) {
    if (session && runId) {
      await session.close().catch(() => {});
    }
    if (privateRunFileSession && runId) {
      await privateRunFileSession.close().catch(() => {});
    }
    if ((sessionRegistered || createdSession) && runId && activeCredentialRefreshSessions.get(runId) === session) {
      activeCredentialRefreshSessions.delete(runId);
    }
    if (privateRunFileSessionRegistered && runId &&
      activePrivateRunFileRefreshSessions.get(runId) === privateRunFileSession) {
      activePrivateRunFileRefreshSessions.delete(runId);
    }
    if (credentialDir) await shredCredentialDir(credentialDir).catch(() => {});
    if (privateRunFiles.length > 0) {
      throw new Error("private Run file preparation failed");
    }
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
