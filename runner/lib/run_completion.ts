/**
 * Private, value-free custody for a local HTTP Apply/Destroy dispatch. The
 * claim lives outside the mutable tofu workspace: losing an HTTP response can
 * never grant a second provider dispatch for the same Run.
 */
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { RUN_ROOT } from "./constants.ts";
import { digestBytes, isRecord } from "./util.ts";
import { readModuleDir, workspaceForRun } from "./artifacts.ts";

type MutationAction = "apply" | "destroy";
const MAX_RECORD_BYTES = 16 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

interface Claim {
  readonly kind: "takosumi.local-mutation-claim@v1";
  readonly runId: string;
  readonly action: MutationAction;
  readonly requestDigest: string;
  readonly restoredProviderLockDigest?: string;
  readonly reservationDigest?: string;
}

interface Completion extends Claim {
  readonly outcome: "provider_failed" | "other";
  readonly stateDigest?: string;
  readonly errorCode?: string;
  readonly providerInstallation?: readonly Record<string, unknown>[];
}

function custodyDirectory(runRoot = RUN_ROOT): string {
  return join(runRoot, ".mutation-custody");
}

async function recordPaths(
  runId: string,
): Promise<{ claim: string; completion: string }> {
  const name = (await digestBytes(new TextEncoder().encode(runId))).slice(7);
  const root = custodyDirectory();
  return {
    claim: join(root, `${name}.claim.json`),
    completion: join(root, `${name}.completion.json`),
  };
}

export async function mutationRequestDigest(
  runId: string,
  action: MutationAction,
  request: unknown,
  restoredProviderLockDigest?: string,
): Promise<string> {
  // The raw request, including credentials, is never persisted. A digest of
  // the exact dispatched JSON is deliberately conservative: changed material
  // may lose convergence, but can never adopt another provider invocation.
  return await digestBytes(
    new TextEncoder().encode(
      JSON.stringify({ runId, action, request, restoredProviderLockDigest }),
    ),
  );
}

export async function ensureCustodyDirectory(
  create: boolean,
  runRoot = RUN_ROOT,
  sync = syncDirectory,
): Promise<boolean> {
  const root = custodyDirectory(runRoot);
  if (create) {
    const runRootParent = dirname(runRoot);
    let parentInfo;
    try {
      parentInfo = await lstat(runRootParent);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new Error("local mutation run root parent must already exist");
      }
      throw error;
    }
    // Do not let recursive mkdir create an unbounded ancestor chain whose
    // directory entries cannot all be made durable here. Permit secure
    // owner-controlled parents and sticky shared roots such as /tmp.
    if (
      !parentInfo.isDirectory() ||
      ((parentInfo.mode & 0o022) !== 0 && (parentInfo.mode & 0o1000) === 0)
    ) {
      throw new Error(
        "local mutation run root parent is not a trusted directory",
      );
    }
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const parent = await lstat(runRoot);
    if (
      !parent.isDirectory() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o022) !== 0
    ) {
      throw new Error(
        "local mutation run root is not owned or writable only by owner",
      );
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    // The first claim is not durable if its newly created directory entry can
    // disappear after a crash, even when the claim file and custody dir sync.
    // Another process may create either directory after this process checks
    // but before it calls mkdir. Always sync both parent entries before any
    // claim is acknowledged, regardless of which process observed creation.
    await sync(dirname(runRoot));
    await sync(runRoot);
  }
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    if (!create && isErrno(error, "ENOENT")) return false;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("local mutation custody directory is not private");
  }
  const handle = await open(
    root,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  await handle.close();
  return true;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBounded(
  path: string,
  allowLinkedTemporary = false,
): Promise<unknown | undefined> {
  let file;
  try {
    file = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.nlink !== 1 && !(allowLinkedTemporary && stat.nlink === 2)) ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_RECORD_BYTES
    )
      return undefined;
    const bytes = new Uint8Array(MAX_RECORD_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_RECORD_BYTES) return undefined;
    return JSON.parse(
      new TextDecoder().decode(bytes.subarray(0, offset)),
    ) as unknown;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function matchesClaim(value: unknown, claim: Claim): value is Claim {
  return (
    isRecord(value) &&
    value.kind === claim.kind &&
    value.runId === claim.runId &&
    value.action === claim.action &&
    value.requestDigest === claim.requestDigest &&
    value.restoredProviderLockDigest === claim.restoredProviderLockDigest &&
    (claim.reservationDigest === undefined ||
      value.reservationDigest === claim.reservationDigest)
  );
}

async function createExclusive(path: string, value: unknown): Promise<boolean> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > MAX_RECORD_BYTES)
    throw new Error("local mutation custody record too large");
  let file;
  try {
    file = await open(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(
    custodyDirectory(),
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return true;
}

/** Claim before the first possible tofu apply, or return a proven old outcome. */
export async function claimLocalMutation(
  runId: string,
  action: MutationAction,
  request: unknown,
  restoredProviderLockDigest?: string,
  reservationDigest?: string,
): Promise<{
  readonly status: "claimed" | "completed" | "indeterminate";
  readonly completion?: Completion;
}> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(runId))
    return { status: "indeterminate" };
  const requestDigest = await mutationRequestDigest(
    runId,
    action,
    request,
    restoredProviderLockDigest,
  );
  const claim: Claim = {
    kind: "takosumi.local-mutation-claim@v1",
    runId,
    action,
    requestDigest,
    ...(restoredProviderLockDigest ? { restoredProviderLockDigest } : {}),
    ...(reservationDigest ? { reservationDigest } : {}),
  };
  await ensureCustodyDirectory(true);
  const paths = await recordPaths(runId);
  if (await createExclusive(paths.claim, claim)) return { status: "claimed" };
  if (!matchesClaim(await readBounded(paths.claim), claim))
    return { status: "indeterminate" };
  const completion = await readLocalMutationCompletion(
    runId,
    action,
    requestDigest,
    restoredProviderLockDigest,
  );
  return completion
    ? { status: "completed", completion }
    : { status: "indeterminate" };
}

/** The adapter reserves before any workspace mutation. A lost reservation reply
 * deliberately leaves the Run indeterminate rather than allowing a second prep. */
export async function reserveLocalMutation(
  runId: string,
  action: MutationAction,
  request: unknown,
  restoredProviderLockDigest?: string,
): Promise<string | undefined> {
  const token = crypto.randomUUID();
  const reservationDigest = await digestBytes(new TextEncoder().encode(token));
  const claimed = await claimLocalMutation(
    runId,
    action,
    request,
    restoredProviderLockDigest,
    reservationDigest,
  );
  return claimed.status === "claimed" ? token : undefined;
}

/** One POST may consume an exact reservation; a duplicate can never execute. */
export async function consumeLocalMutationReservation(
  runId: string,
  action: MutationAction,
  request: unknown,
  restoredProviderLockDigest: string | undefined,
  token: string,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/u.test(token)) return false;
  const requestDigest = await mutationRequestDigest(
    runId,
    action,
    request,
    restoredProviderLockDigest,
  );
  const reservationDigest = await digestBytes(new TextEncoder().encode(token));
  const claim: Claim = {
    kind: "takosumi.local-mutation-claim@v1",
    runId,
    action,
    requestDigest,
    ...(restoredProviderLockDigest ? { restoredProviderLockDigest } : {}),
    reservationDigest,
  };
  const paths = await recordPaths(runId);
  if (!matchesClaim(await readBounded(paths.claim), claim)) return false;
  return await createExclusive(`${paths.claim}.dispatched`, claim);
}

export async function readLocalMutationCompletion(
  runId: string,
  action: MutationAction,
  requestDigest: string,
  restoredProviderLockDigest?: string,
): Promise<Completion | undefined> {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(runId) ||
    !DIGEST_PATTERN.test(requestDigest)
  )
    return undefined;
  if (!(await ensureCustodyDirectory(false))) return undefined;
  const claim: Claim = {
    kind: "takosumi.local-mutation-claim@v1",
    runId,
    action,
    requestDigest,
    ...(restoredProviderLockDigest ? { restoredProviderLockDigest } : {}),
  };
  const paths = await recordPaths(runId);
  const existing = await readBounded(paths.claim);
  if (!matchesClaim(existing, claim)) return undefined;
  const record = await readBounded(paths.completion, true);
  if (
    isRecord(existing) &&
    typeof existing.reservationDigest === "string" &&
    !matchesClaim(record, {
      ...claim,
      reservationDigest: existing.reservationDigest,
    })
  )
    return undefined;
  if (
    !matchesClaim(record, claim) ||
    !isRecord(record) ||
    (record.outcome !== "provider_failed" && record.outcome !== "other") ||
    (record.stateDigest !== undefined &&
      (typeof record.stateDigest !== "string" ||
        !DIGEST_PATTERN.test(record.stateDigest))) ||
    (record.errorCode !== undefined &&
      (typeof record.errorCode !== "string" ||
        !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(record.errorCode))) ||
    (record.providerInstallation !== undefined &&
      !Array.isArray(record.providerInstallation))
  )
    return undefined;
  return record as unknown as Completion;
}

/** Distinguish a first dispatch from an existing but unprovable dispatch. */
export async function inspectLocalMutation(
  runId: string,
  action: MutationAction,
  requestDigest: string,
  restoredProviderLockDigest?: string,
): Promise<"absent" | "indeterminate" | Completion> {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(runId) ||
    !DIGEST_PATTERN.test(requestDigest)
  )
    return "indeterminate";
  if (!(await ensureCustodyDirectory(false))) return "absent";
  const paths = await recordPaths(runId);
  const existing = await readBounded(paths.claim);
  if (existing === undefined) {
    try {
      await lstat(paths.claim);
      return "indeterminate";
    } catch (error) {
      if (isErrno(error, "ENOENT")) return "absent";
      throw error;
    }
  }
  const claim: Claim = {
    kind: "takosumi.local-mutation-claim@v1",
    runId,
    action,
    requestDigest,
    ...(restoredProviderLockDigest ? { restoredProviderLockDigest } : {}),
  };
  if (!matchesClaim(existing, claim)) return "indeterminate";
  return (
    (await readLocalMutationCompletion(
      runId,
      action,
      requestDigest,
      restoredProviderLockDigest,
    )) ?? "indeterminate"
  );
}

/** Persist only typed, non-secret outcome metadata and a digest of runner state. */
export async function completeLocalMutation(
  runId: string,
  action: MutationAction,
  request: unknown,
  result: Record<string, unknown>,
  restoredProviderLockDigest?: string,
): Promise<Completion> {
  const requestDigest = await mutationRequestDigest(
    runId,
    action,
    request,
    restoredProviderLockDigest,
  );
  let claim: Claim = {
    kind: "takosumi.local-mutation-claim@v1",
    runId,
    action,
    requestDigest,
    ...(restoredProviderLockDigest ? { restoredProviderLockDigest } : {}),
  };
  const paths = await recordPaths(runId);
  const existing = await readBounded(paths.claim);
  if (!matchesClaim(existing, claim))
    throw new Error("local mutation claim mismatch");
  if (isRecord(existing) && typeof existing.reservationDigest === "string") {
    claim = { ...claim, reservationDigest: existing.reservationDigest };
  }
  const failure =
    isRecord(result.providerExecutionFailure) &&
    result.providerExecutionFailure.kind === "provider_execution_failed";
  let stateDigest: string | undefined;
  if (failure) {
    try {
      const moduleDir = await readModuleDir(workspaceForRun(runId));
      stateDigest = await digestBytes(
        new Uint8Array(await readFile(join(moduleDir, "terraform.tfstate"))),
      );
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  const errorCode =
    typeof result.errorCode === "string" &&
    /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(result.errorCode)
      ? result.errorCode
      : undefined;
  const providerInstallation = Array.isArray(result.providerInstallation)
    ? result.providerInstallation
        .filter(isRecord)
        .map((row) =>
          Object.fromEntries(
            [
              "provider",
              "mirrored",
              "installationMethod",
              "attested",
              "attestationMethod",
              "cliConfigDigest",
              "installedDigest",
            ]
              .filter(
                (key) =>
                  typeof row[key] === "string" || typeof row[key] === "boolean",
              )
              .map((key) => [key, row[key]]),
          ),
        )
    : undefined;
  const completion: Completion = {
    ...claim,
    outcome: failure ? "provider_failed" : "other",
    ...(stateDigest ? { stateDigest } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(providerInstallation ? { providerInstallation } : {}),
  };
  const temporary = `${paths.completion}.${crypto.randomUUID()}.tmp`;
  if (!(await createExclusive(temporary, completion)))
    throw new Error("local mutation completion temporary conflict");
  try {
    try {
      await link(temporary, paths.completion);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const prior = await readLocalMutationCompletion(
        runId,
        action,
        requestDigest,
        restoredProviderLockDigest,
      );
      if (!prior || JSON.stringify(prior) !== JSON.stringify(completion))
        throw new Error("local mutation completion conflict");
    }
    const directory = await open(
      custodyDirectory(),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
    const directory = await open(
      custodyDirectory(),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  return completion;
}

export function localMutationCompletionResponse(
  completion: Completion,
): Response {
  if (completion.outcome !== "provider_failed") {
    return Response.json(
      { errorCode: "runner_mutation_indeterminate", retryable: false },
      { status: 409 },
    );
  }
  return Response.json(
    {
      status: "failed",
      exitCode: 1,
      providerExecutionFailure: { kind: "provider_execution_failed" },
      ...(completion.errorCode ? { errorCode: completion.errorCode } : {}),
      ...(completion.stateDigest
        ? { stateDigest: completion.stateDigest }
        : {}),
      ...(completion.providerInstallation
        ? { providerInstallation: completion.providerInstallation }
        : {}),
    },
    { status: 500 },
  );
}
