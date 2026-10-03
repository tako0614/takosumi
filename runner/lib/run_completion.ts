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
  rm,
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

interface PreparationCompletion {
  readonly kind: "takosumi.local-mutation-completion@v2";
  readonly runId: string;
  readonly action: MutationAction;
  readonly requestDigest: string;
  readonly restoredProviderLockDigest?: string;
  readonly processInstanceId: string;
  readonly attemptDigest: string;
  readonly epoch: number;
  readonly outcome: "provider_failed" | "other";
  readonly stateDigest?: string;
  readonly errorCode?: string;
  readonly providerInstallation?: readonly Record<string, unknown>[];
}

// An unfinished v2 preparation is transferable only inside this exact serving
// process. A replacement runner process cannot prove that an old tar/source
// child has stopped writing to the shared workspace, so it must refuse it.
const LOCAL_PROCESS_INSTANCE_ID = crypto.randomUUID();
const MAX_PREPARATION_EPOCH = 64;
/** Private test seam for a failed custody fsync; production always uses real fsync. */
export type LocalMutationSyncFault = (
  step: "file" | "directory",
  path: string,
) => void | Promise<void>;
interface PreparationClaim {
  readonly kind: "takosumi.local-mutation-preparation@v2";
  readonly runId: string;
  readonly action: MutationAction;
  readonly requestDigest: string;
  readonly restoredProviderLockDigest?: string;
  readonly processInstanceId: string;
  readonly attemptDigest: string;
  readonly epoch: 1;
}
interface PreparationOwner {
  readonly kind: "takosumi.local-mutation-preparation-owner@v2";
  readonly runId: string;
  readonly requestDigest: string;
  readonly processInstanceId: string;
  readonly attemptDigest: string;
  readonly epoch: number;
}

const runGateTails = new Map<string, Promise<void>>();

/** Serialize whole same-run HTTP mutations, including body reads and child exit. */
export async function withLocalMutationGate<T>(
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const preceding = runGateTails.get(runId);
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  runGateTails.set(runId, tail);
  if (preceding) await preceding;
  try {
    return await operation();
  } finally {
    release();
    if (runGateTails.get(runId) === tail) runGateTails.delete(runId);
  }
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

async function createExclusive(
  path: string,
  value: unknown,
  syncFault?: LocalMutationSyncFault,
): Promise<boolean> {
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
    await syncFault?.("file", path);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(
    custodyDirectory(),
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await syncFault?.("directory", path);
    await directory.sync();
  } finally {
    await directory.close();
  }
  return true;
}

/** A visible record is not durable authority after an uncertain prior fsync. */
async function readDurable(
  path: string,
  syncFault?: LocalMutationSyncFault,
  allowLinkedTemporary = false,
): Promise<unknown | undefined> {
  const before = await readBounded(path, allowLinkedTemporary);
  if (before === undefined) return undefined;
  try {
    const file = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() ||
        (info.nlink !== 1 && !(allowLinkedTemporary && info.nlink === 2)) ||
        info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        return undefined;
      await syncFault?.("file", path);
      await file.sync();
    } finally {
      await file.close();
    }
    await syncFault?.("directory", path);
    await syncDirectory(dirname(path));
    const after = await readBounded(path, allowLinkedTemporary);
    return JSON.stringify(before) === JSON.stringify(after) ? after : undefined;
  } catch {
    return undefined;
  }
}

function validAttemptId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value);
}

async function occupied(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function ownerPath(claimPath: string, epoch: number): string {
  return `${claimPath}.owner-${epoch}.json`;
}

function readyPath(claimPath: string, epoch: number): string {
  return `${claimPath}.ready-${epoch}.json`;
}

function isPreparationClaim(value: unknown, runId: string): value is PreparationClaim {
  return isRecord(value) &&
    value.kind === "takosumi.local-mutation-preparation@v2" &&
    value.runId === runId &&
    (value.action === "apply" || value.action === "destroy") &&
    typeof value.requestDigest === "string" && DIGEST_PATTERN.test(value.requestDigest) &&
    (value.restoredProviderLockDigest === undefined ||
      (typeof value.restoredProviderLockDigest === "string" && DIGEST_PATTERN.test(value.restoredProviderLockDigest))) &&
    typeof value.processInstanceId === "string" && validAttemptId(value.processInstanceId) &&
    typeof value.attemptDigest === "string" && DIGEST_PATTERN.test(value.attemptDigest) &&
    value.epoch === 1;
}

async function currentPreparationOwner(
  claimPath: string,
  claim: PreparationClaim,
  historicalAttempts?: Set<string>,
  syncFault?: LocalMutationSyncFault,
): Promise<PreparationOwner | undefined> {
  const attempts = new Set<string>([claim.attemptDigest]);
  let current: PreparationOwner = {
    kind: "takosumi.local-mutation-preparation-owner@v2",
    runId: claim.runId,
    requestDigest: claim.requestDigest,
    processInstanceId: claim.processInstanceId,
    attemptDigest: claim.attemptDigest,
    epoch: 1,
  };
  for (let epoch = 2; epoch <= MAX_PREPARATION_EPOCH + 1; epoch++) {
    const path = ownerPath(claimPath, epoch);
    const next = await readDurable(path, syncFault);
    if (next === undefined) {
      if (await occupied(path)) return undefined;
      for (const attempt of attempts) historicalAttempts?.add(attempt);
      return current;
    }
    if (!isRecord(next) ||
      next.kind !== current.kind ||
      next.runId !== claim.runId ||
      next.requestDigest !== claim.requestDigest ||
      next.processInstanceId !== claim.processInstanceId ||
      typeof next.attemptDigest !== "string" || !DIGEST_PATTERN.test(next.attemptDigest) ||
      next.epoch !== epoch || attempts.has(next.attemptDigest)) return undefined;
    attempts.add(next.attemptDigest);
    current = next as unknown as PreparationOwner;
  }
  return undefined;
}

async function preparationReady(
  claimPath: string,
  owner: PreparationOwner,
  syncFault?: LocalMutationSyncFault,
): Promise<boolean> {
  const path = readyPath(claimPath, owner.epoch);
  const record = await readDurable(path, syncFault);
  return isRecord(record) &&
    record.kind === "takosumi.local-mutation-preparation-ready@v2" &&
    record.runId === owner.runId &&
    record.requestDigest === owner.requestDigest &&
    record.processInstanceId === owner.processInstanceId &&
    record.attemptDigest === owner.attemptDigest &&
    record.epoch === owner.epoch;
}

async function resetPreparationWorkspace(runId: string): Promise<void> {
  const workspace = workspaceForRun(runId);
  await rm(workspace.root, { recursive: true, force: true });
  await rm(workspace.depsDir, { recursive: true, force: true });
}

/** Caller must hold withLocalMutationGate for the entire acquisition/reset. */
export async function reserveLocalMutationPreparation(
  runId: string,
  action: MutationAction,
  request: unknown,
  attemptId: string,
  restoredProviderLockDigest?: string,
  syncFault?: LocalMutationSyncFault,
): Promise<number | undefined> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(runId) || !validAttemptId(attemptId)) return undefined;
  const requestDigest = await mutationRequestDigest(runId, action, request, restoredProviderLockDigest);
  const attemptDigest = await digestBytes(new TextEncoder().encode(attemptId));
  await ensureCustodyDirectory(true);
  const paths = await recordPaths(runId);
  const initial: PreparationClaim = {
    kind: "takosumi.local-mutation-preparation@v2",
    runId, action, requestDigest,
    ...(restoredProviderLockDigest ? { restoredProviderLockDigest } : {}),
    processInstanceId: LOCAL_PROCESS_INSTANCE_ID,
    attemptDigest,
    epoch: 1,
  };
  await createExclusive(paths.claim, initial, syncFault);
  const value = await readDurable(paths.claim, syncFault);
  if (!isPreparationClaim(value, runId) ||
    value.action !== action || value.requestDigest !== requestDigest ||
    value.restoredProviderLockDigest !== restoredProviderLockDigest ||
    value.processInstanceId !== LOCAL_PROCESS_INSTANCE_ID ||
    await occupied(`${paths.claim}.dispatched`)) return undefined;
  const historicalAttempts = new Set<string>();
  const current = await currentPreparationOwner(paths.claim, value, historicalAttempts, syncFault);
  if (!current) return undefined;
  let owner = current;
  if (current.attemptDigest !== attemptDigest) {
    if (current.epoch >= MAX_PREPARATION_EPOCH || historicalAttempts.has(attemptDigest)) return undefined;
    owner = { ...current, attemptDigest, epoch: current.epoch + 1 };
    if (!(await createExclusive(ownerPath(paths.claim, owner.epoch), owner, syncFault))) return undefined;
  }
  if (!(await preparationReady(paths.claim, owner, syncFault))) {
    if (await occupied(readyPath(paths.claim, owner.epoch))) return undefined;
    await resetPreparationWorkspace(runId);
    if (!(await createExclusive(readyPath(paths.claim, owner.epoch), {
      kind: "takosumi.local-mutation-preparation-ready@v2",
      runId, requestDigest, processInstanceId: LOCAL_PROCESS_INSTANCE_ID,
      attemptDigest: owner.attemptDigest, epoch: owner.epoch,
    }, syncFault))) return undefined;
  }
  // A returned epoch is authority: re-read and sync its exact immutable files.
  if (!(await preparationReady(paths.claim, owner, syncFault))) return undefined;
  const verified = await currentPreparationOwner(paths.claim, value, undefined, syncFault);
  if (!verified || verified.epoch !== owner.epoch ||
    verified.attemptDigest !== owner.attemptDigest) return undefined;
  return owner.epoch;
}

export async function inspectLocalMutationPreparation(runId: string): Promise<"absent" | "legacy" | "indeterminate" | PreparationOwner> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(runId)) return "indeterminate";
  if (!(await ensureCustodyDirectory(false))) return "absent";
  const paths = await recordPaths(runId);
  const value = await readBounded(paths.claim);
  if (value === undefined) return (await occupied(paths.claim)) ? "indeterminate" : "absent";
  if (isRecord(value) && value.kind === "takosumi.local-mutation-claim@v1") return "legacy";
  const durable = await readDurable(paths.claim);
  if (!isPreparationClaim(durable, runId) || durable.processInstanceId !== LOCAL_PROCESS_INSTANCE_ID) return "indeterminate";
  return (await currentPreparationOwner(paths.claim, durable)) ?? "indeterminate";
}

/** Caller holds the same-run gate through the entire mutating handler. */
export async function authorizeLocalMutationPreparation(
  runId: string,
  attemptId: string | null,
  epochText: string | null,
): Promise<"legacy" | "allowed" | "indeterminate"> {
  const owner = await inspectLocalMutationPreparation(runId);
  if (owner === "absent" || owner === "legacy") return "legacy";
  if (owner === "indeterminate" || !validAttemptId(attemptId) ||
    epochText !== String(owner.epoch) ||
    owner.attemptDigest !== await digestBytes(new TextEncoder().encode(attemptId))) return "indeterminate";
  const paths = await recordPaths(runId);
  if (await occupied(`${paths.claim}.dispatched`) ||
    !(await preparationReady(paths.claim, owner))) return "indeterminate";
  return "allowed";
}

/** Persist dispatch before any OpenTofu preparation or provider invocation. */
export async function consumeLocalMutationPreparation(
  runId: string,
  action: MutationAction,
  request: unknown,
  restoredProviderLockDigest: string | undefined,
  attemptId: string | null,
  epochText: string | null,
  syncFault?: LocalMutationSyncFault,
): Promise<boolean> {
  if ((await authorizeLocalMutationPreparation(runId, attemptId, epochText)) !== "allowed") return false;
  const paths = await recordPaths(runId);
  const value = await readDurable(paths.claim, syncFault);
  if (!isPreparationClaim(value, runId) || value.action !== action ||
    value.restoredProviderLockDigest !== restoredProviderLockDigest ||
    value.requestDigest !== await mutationRequestDigest(runId, action, request, restoredProviderLockDigest)) return false;
  const owner = await currentPreparationOwner(paths.claim, value);
  if (!owner || owner.epoch !== Number(epochText)) return false;
  return await createExclusive(`${paths.claim}.dispatched`, {
    kind: "takosumi.local-mutation-dispatched@v2",
    runId, action, requestDigest: value.requestDigest,
    processInstanceId: LOCAL_PROCESS_INSTANCE_ID,
    attemptDigest: owner.attemptDigest,
    epoch: owner.epoch,
  }, syncFault);
}

export async function inspectLocalMutationPreparationCompletion(
  runId: string,
  action: MutationAction,
  requestDigest: string,
  restoredProviderLockDigest?: string,
): Promise<"not-v2" | "preparing" | "indeterminate" | PreparationCompletion> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(runId) || !DIGEST_PATTERN.test(requestDigest))
    return "indeterminate";
  if (!(await ensureCustodyDirectory(false))) return "not-v2";
  const paths = await recordPaths(runId);
  const initial = await readBounded(paths.claim);
  if (!isRecord(initial) || initial.kind !== "takosumi.local-mutation-preparation@v2")
    return "not-v2";
  const value = await readDurable(paths.claim);
  if (!isPreparationClaim(value, runId) || value.action !== action ||
    value.requestDigest !== requestDigest ||
    value.restoredProviderLockDigest !== restoredProviderLockDigest ||
    value.processInstanceId !== LOCAL_PROCESS_INSTANCE_ID) return "indeterminate";
  const owner = await currentPreparationOwner(paths.claim, value);
  if (!owner || !(await preparationReady(paths.claim, owner))) return "indeterminate";
  const dispatchedPath = `${paths.claim}.dispatched`;
  if (await occupied(dispatchedPath)) {
    const dispatched = await readDurable(dispatchedPath);
    if (!isRecord(dispatched) ||
      dispatched.kind !== "takosumi.local-mutation-dispatched@v2" ||
      dispatched.runId !== runId || dispatched.action !== action ||
      dispatched.requestDigest !== requestDigest ||
      dispatched.processInstanceId !== LOCAL_PROCESS_INSTANCE_ID ||
      dispatched.attemptDigest !== owner.attemptDigest ||
      dispatched.epoch !== owner.epoch) return "indeterminate";
    const completion = await readDurable(paths.completion, undefined, true);
    if (!isRecord(completion) ||
      completion.kind !== "takosumi.local-mutation-completion@v2" ||
      completion.runId !== runId || completion.action !== action ||
      completion.requestDigest !== requestDigest ||
      completion.restoredProviderLockDigest !== restoredProviderLockDigest ||
      completion.processInstanceId !== LOCAL_PROCESS_INSTANCE_ID ||
      completion.attemptDigest !== owner.attemptDigest ||
      completion.epoch !== owner.epoch ||
      (completion.outcome !== "provider_failed" && completion.outcome !== "other") ||
      (completion.stateDigest !== undefined &&
        (typeof completion.stateDigest !== "string" || !DIGEST_PATTERN.test(completion.stateDigest))) ||
      (completion.errorCode !== undefined &&
        (typeof completion.errorCode !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(completion.errorCode))) ||
      (completion.providerInstallation !== undefined && !Array.isArray(completion.providerInstallation)))
      return "indeterminate";
    return completion as unknown as PreparationCompletion;
  }
  return "preparing";
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
): Promise<Completion | PreparationCompletion> {
  const requestDigest = await mutationRequestDigest(
    runId,
    action,
    request,
    restoredProviderLockDigest,
  );
  let claim: Claim | Omit<PreparationCompletion, "outcome"> = {
    kind: "takosumi.local-mutation-claim@v1",
    runId,
    action,
    requestDigest,
    ...(restoredProviderLockDigest ? { restoredProviderLockDigest } : {}),
  };
  const paths = await recordPaths(runId);
  const existing = await readBounded(paths.claim);
  const durableExisting = isRecord(existing) &&
      existing.kind === "takosumi.local-mutation-preparation@v2"
    ? await readDurable(paths.claim)
    : undefined;
  if (matchesClaim(existing, claim)) {
    if (isRecord(existing) && typeof existing.reservationDigest === "string") {
      claim = { ...claim, reservationDigest: existing.reservationDigest };
    }
  } else if (isPreparationClaim(durableExisting, runId) &&
    durableExisting.action === action && durableExisting.requestDigest === requestDigest &&
    durableExisting.restoredProviderLockDigest === restoredProviderLockDigest &&
    durableExisting.processInstanceId === LOCAL_PROCESS_INSTANCE_ID) {
    const owner = await currentPreparationOwner(paths.claim, durableExisting);
    const dispatched = await readDurable(`${paths.claim}.dispatched`);
    if (!owner || !isRecord(dispatched) ||
      dispatched.kind !== "takosumi.local-mutation-dispatched@v2" ||
      dispatched.runId !== runId || dispatched.action !== action ||
      dispatched.requestDigest !== requestDigest ||
      dispatched.processInstanceId !== LOCAL_PROCESS_INSTANCE_ID ||
      dispatched.attemptDigest !== owner.attemptDigest ||
      dispatched.epoch !== owner.epoch) throw new Error("local mutation dispatch mismatch");
    claim = {
      kind: "takosumi.local-mutation-completion@v2",
      runId, action, requestDigest,
      ...(restoredProviderLockDigest ? { restoredProviderLockDigest } : {}),
      processInstanceId: LOCAL_PROCESS_INSTANCE_ID,
      attemptDigest: owner.attemptDigest,
      epoch: owner.epoch,
    };
  } else {
    throw new Error("local mutation claim mismatch");
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
  const completion = {
    ...claim,
    outcome: failure ? "provider_failed" : "other",
    ...(stateDigest ? { stateDigest } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(providerInstallation ? { providerInstallation } : {}),
  } as Completion | PreparationCompletion;
  const temporary = `${paths.completion}.${crypto.randomUUID()}.tmp`;
  if (!(await createExclusive(temporary, completion)))
    throw new Error("local mutation completion temporary conflict");
  try {
    try {
      await link(temporary, paths.completion);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const prior = await readBounded(paths.completion, true);
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
  completion: Completion | PreparationCompletion,
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
