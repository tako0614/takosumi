import { constants, fstatSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const runRootOwnershipBrand: unique symbol = Symbol("run-root-ownership");

export interface RunRootOwnership {
  readonly [runRootOwnershipBrand]: true;
  /** Waits for enrolled writers; no timeout may release the lease under one. */
  close(): Promise<void>;
}

export class RunRootOwnershipBusyError extends Error {
  constructor() {
    super("run root is already owned by another runner process");
    this.name = "RunRootOwnershipBusyError";
  }
}

export class RunRootOwnershipUnavailableError extends Error {
  constructor() {
    super("exclusive run-root ownership is unavailable");
    this.name = "RunRootOwnershipUnavailableError";
  }
}

interface OwnershipState {
  readonly lockHandle: LockDescriptor;
  readonly canonicalRoot: string;
  readonly rootDev: number;
  readonly rootIno: number;
  readonly lockDev: number;
  readonly lockIno: number;
  closing: boolean;
  closed: boolean;
  activeWriters: number;
  closePromise?: Promise<void>;
  drainWriters?: Promise<void>;
  resolveWriterDrain?: () => void;
}

interface LockDescriptor {
  readonly fd: number;
  close(): Promise<void> | void;
}

type LockAcquirer = Bun.Subprocess<"ignore", number, "ignore">;

const LOCK_FILE_NAME = ".takosumi-run-root.lock";
const LOCK_COMMAND = "/usr/bin/flock";
const LOCK_CONFLICT_EXIT = 73;
const LOCK_ACQUIRE_TIMEOUT_MS = 1_000;
const LOCK_REAP_TIMEOUT_MS = 1_000;
const OWNED_CHILD_HANDSHAKE_TIMEOUT_MS = 2_000;
const MAX_OWNED_CHILD_HANDSHAKE_TIMEOUT_MS = 5_000;
const F_DUPFD_CLOEXEC = 1030;
const F_GETFD = 1;
const FD_CLOEXEC = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const ownershipStates = new WeakMap<object, OwnershipState>();

type RunRootOwnershipChild = Bun.Subprocess<number, "ignore", "ignore">;
type ChildProtocolMessage = { readonly kind: string; readonly nonce?: string };
type ChildHandoffPhase =
  | "await-start"
  | "await-ready"
  | "await-adopted"
  | "acknowledged"
  | "failed";
type InheritedFdApi = {
  readonly symbols: {
    readonly close: (fd: number) => number;
    readonly fcntl: (fd: number, command: number, argument: number) => number;
    readonly flock: (fd: number, operation: number) => number;
  };
  close(): void;
};

/**
 * Acquire a Linux kernel advisory lock for one existing private runtime root.
 * This only coordinates cooperating processes; callers must enroll every
 * workspace writer and must not treat the lock as proof about legacy run state.
 */
export async function acquireRunRootOwnership(
  runRoot: string,
): Promise<RunRootOwnership> {
  const { lockHandle, canonicalRoot, rootDev, rootIno, lockDev, lockIno } =
    await openLockFile(runRoot);
  let acquired = false;
  try {
    const acquirer = Bun.spawn(
      [LOCK_COMMAND, "-n", "-E", String(LOCK_CONFLICT_EXIT), "1"],
      {
        stdin: "ignore",
        stdout: lockHandle.fd,
        stderr: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    const exitCode = await waitForLockAcquirer(acquirer);
    if (exitCode === LOCK_CONFLICT_EXIT) {
      throw new RunRootOwnershipBusyError();
    }
    if (exitCode !== 0) throw new RunRootOwnershipUnavailableError();
    acquired = true;
  } catch (error) {
    if (error instanceof RunRootOwnershipBusyError) throw error;
    throw new RunRootOwnershipUnavailableError();
  } finally {
    if (!acquired) await lockHandle.close().catch(() => {});
  }

  const state: OwnershipState = {
    lockHandle,
    canonicalRoot,
    rootDev,
    rootIno,
    lockDev,
    lockIno,
    closing: false,
    closed: false,
    activeWriters: 0,
  };
  const owner = createOwnershipHandle(state);
  return owner;
}

/**
 * Run one Bun child while this process retains an enrolled root writer hold.
 * The callback must cover direct-child exit and the caller's child-tree drain;
 * process-local child supervision remains responsible for proving ECHILD.
 */
export async function withRunRootOwnershipChild<T>(
  owner: RunRootOwnership,
  runRoot: string,
  command: readonly string[],
  options: {
    readonly env: Record<string, string>;
    readonly handshakeTimeoutMs?: number;
  },
  runUntilDrained: (child: RunRootOwnershipChild) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.handshakeTimeoutMs ?? OWNED_CHILD_HANDSHAKE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 ||
    timeoutMs > MAX_OWNED_CHILD_HANDSHAKE_TIMEOUT_MS || command.length === 0 ||
    command.some((part) => part.length === 0)
  ) {
    throw new RunRootOwnershipUnavailableError();
  }
  return withRunRootWriter(owner, async () => {
    assertRunRootOwnershipFor(owner, runRoot);
    const state = ownershipStates.get(owner as object);
    if (!state) throw new RunRootOwnershipUnavailableError();
    const nonce = randomUUID();
    const ready = createDeferred<boolean>();
    let phase: ChildHandoffPhase = "await-start";
    let child: RunRootOwnershipChild | undefined;
    try {
      const spawnedChild = Bun.spawn([...command], {
        stdin: state.lockHandle.fd,
        stdout: "ignore",
        stderr: "ignore",
        env: options.env,
        ipc(message, subprocess) {
          if (phase === "await-start" && isProtocolMessage(message, "run-root-owner-started")) {
            try {
              assertRunRootOwnershipFor(owner, runRoot);
              subprocess.send({ kind: "run-root-owner-challenge", nonce });
              phase = "await-ready";
            } catch {
              phase = "failed";
              ready.resolve(false);
            }
            return;
          }
          if (
            phase === "await-ready" &&
            isProtocolMessage(message, "run-root-owner-ready", nonce)
          ) {
            try {
              assertRunRootOwnershipFor(owner, runRoot);
              subprocess.send({ kind: "run-root-owner-ack", nonce });
              phase = "await-adopted";
            } catch {
              phase = "failed";
              ready.resolve(false);
            }
            return;
          }
          if (
            phase === "await-adopted" &&
            isProtocolMessage(message, "run-root-owner-adopted", nonce)
          ) {
            phase = "acknowledged";
            ready.resolve(true);
            return;
          }
          phase = "failed";
          ready.resolve(false);
        },
      });
      child = spawnedChild;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const handshake = await Promise.race([
        ready.promise,
        new Promise<undefined>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      if (handshake !== true || !isAcknowledgedHandoff(phase)) {
        spawnedChild.kill("SIGKILL");
        await spawnedChild.exited;
        throw new RunRootOwnershipUnavailableError();
      }
      const result = await runUntilDrained(spawnedChild);
      if (spawnedChild.exitCode === null) {
        await spawnedChild.exited;
        throw new RunRootOwnershipUnavailableError();
      }
      return result;
    } catch (error) {
      if (child && child.exitCode === null) {
        if (!isAcknowledgedHandoff(phase)) child.kill("SIGKILL");
        await child.exited;
      }
      if (error instanceof RunRootOwnershipUnavailableError) throw error;
      throw error;
    }
  });
}

/** Adopt the parent's already-locked OFD from stdin after the private IPC handshake. */
export async function adoptRunRootOwnershipFromStdin(
  runRoot: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<RunRootOwnership> {
  const timeoutMs = options.timeoutMs ?? OWNED_CHILD_HANDSHAKE_TIMEOUT_MS;
  if (
    process.platform !== "linux" ||
    (process.arch !== "x64" && process.arch !== "arm64") ||
    process.getuid === undefined || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 50 || timeoutMs > MAX_OWNED_CHILD_HANDSHAKE_TIMEOUT_MS ||
    typeof process.send !== "function"
  ) {
    throw new RunRootOwnershipUnavailableError();
  }

  let api: InheritedFdApi | undefined;
  let parentHoldProbe: FileHandle | undefined;
  let duplicateFd = -1;
  let duplicateOwned = false;
  let inheritedFdClosed = false;
  let adoptedOwner: RunRootOwnership | undefined;
  const inheritedFd = 0;
  const challengePromise = receiveIpcMessage("run-root-owner-challenge", timeoutMs);
  try {
    process.send({ kind: "run-root-owner-started" });
  } catch {
    throw new RunRootOwnershipUnavailableError();
  }
  const challenge = await challengePromise;
  if (!isProtocolMessage(challenge, "run-root-owner-challenge")) {
    throw new RunRootOwnershipUnavailableError();
  }
  const nonce = challenge.nonce;
  if (!nonce || nonce.length > 128) throw new RunRootOwnershipUnavailableError();
  try {
    const identity = assertPrivateRunRootAndInheritedFd(runRoot, inheritedFd);
    api = await openInheritedFdApi();
    const readyPromise = receiveIpcMessage("run-root-owner-ack", timeoutMs, nonce);
    process.send({ kind: "run-root-owner-ready", nonce });
    const ack = await readyPromise;
    if (!ack) {
      throw new RunRootOwnershipUnavailableError();
    }
    parentHoldProbe = await openParentHoldProbe(identity.canonicalRoot, identity.lockStat);
    const probeAcquirer = Bun.spawn(
      [LOCK_COMMAND, "-n", "-E", String(LOCK_CONFLICT_EXIT), "1"],
      {
        stdin: "ignore",
        stdout: parentHoldProbe.fd,
        stderr: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    const probeResult = await waitForLockAcquirer(probeAcquirer);
    if (probeResult !== LOCK_CONFLICT_EXIT) {
      throw new RunRootOwnershipUnavailableError();
    }
    await parentHoldProbe.close();
    parentHoldProbe = undefined;
    if (api.symbols.flock(inheritedFd, LOCK_EX | LOCK_NB) !== 0) throw new Error();
    duplicateFd = api.symbols.fcntl(inheritedFd, F_DUPFD_CLOEXEC, 3);
    if (duplicateFd < 3) throw new Error();
    const duplicateStat = fstatSync(duplicateFd);
    const descriptorFlags = api.symbols.fcntl(duplicateFd, F_GETFD, 0);
    if (
      !samePrivateLockFile(duplicateStat, identity.lockStat) ||
      descriptorFlags < 0 || (descriptorFlags & FD_CLOEXEC) === 0 ||
      api.symbols.flock(duplicateFd, LOCK_EX | LOCK_NB) !== 0
    ) {
      throw new Error();
    }
    const lockHandle = createInheritedLockDescriptor(duplicateFd, api);
    duplicateOwned = true;
    const state: OwnershipState = {
      lockHandle,
      canonicalRoot: identity.canonicalRoot,
      rootDev: identity.rootStat.dev,
      rootIno: identity.rootStat.ino,
      lockDev: identity.lockStat.dev,
      lockIno: identity.lockStat.ino,
      closing: false,
      closed: false,
      activeWriters: 0,
    };
    const owner = createOwnershipHandle(state);
    adoptedOwner = owner;
    if (api.symbols.close(inheritedFd) !== 0) {
      throw new RunRootOwnershipUnavailableError();
    }
    inheritedFdClosed = true;
    process.send({ kind: "run-root-owner-adopted", nonce });
    return owner;
  } catch {
    if (parentHoldProbe) await parentHoldProbe.close().catch(() => {});
    if (api && !inheritedFdClosed) {
      api.symbols.close(inheritedFd);
      inheritedFdClosed = true;
    }
    if (adoptedOwner) {
      await adoptedOwner.close().catch(() => {});
    } else if (!duplicateOwned && api && duplicateFd >= 3) {
      api.symbols.close(duplicateFd);
    }
    try {
      process.send?.({ kind: "run-root-owner-refused", nonce });
    } catch {
      // The channel is private; a failed notification remains a refusal.
    }
    if (api && !duplicateOwned) {
      try {
        api.close();
      } catch {
        // A failed close remains a refusal; no descriptor is re-adopted.
      }
    }
    throw new RunRootOwnershipUnavailableError();
  }
}

async function openParentHoldProbe(
  canonicalRoot: string,
  expectedLock: Stats,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    const closeOnExec = (constants as typeof constants & {
      readonly O_CLOEXEC?: number;
    }).O_CLOEXEC ?? 0;
    handle = await open(
      join(canonicalRoot, LOCK_FILE_NAME),
      constants.O_RDWR | constants.O_NOFOLLOW | closeOnExec,
    );
    const probeStat = await handle.stat();
    if (!samePrivateLockFile(probeStat, expectedLock)) throw new Error();
    return handle;
  } catch {
    await handle?.close().catch(() => {});
    throw new RunRootOwnershipUnavailableError();
  }
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isAcknowledgedHandoff(phase: ChildHandoffPhase): boolean {
  return phase === "acknowledged";
}

function isProtocolMessage(
  value: unknown,
  kind: string,
  nonce?: string,
): value is ChildProtocolMessage {
  return typeof value === "object" && value !== null && "kind" in value &&
    value.kind === kind &&
    (nonce === undefined || ("nonce" in value && value.nonce === nonce));
}

function receiveIpcMessage(
  kind: string,
  timeoutMs: number,
  nonce?: string,
): Promise<ChildProtocolMessage | null> {
  return new Promise((resolveMessage) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (message: ChildProtocolMessage | null) => {
      if (timer !== undefined) clearTimeout(timer);
      process.off("message", listener);
      resolveMessage(message);
    };
    const listener = (message: unknown) => {
      finish(isProtocolMessage(message, kind, nonce) ? message : null);
    };
    process.on("message", listener);
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function assertPrivateRunRootAndInheritedFd(
  runRoot: string,
  fd: number,
): {
  readonly canonicalRoot: string;
  readonly rootStat: Stats;
  readonly lockStat: Stats;
} {
  try {
    const absoluteRoot = resolve(runRoot);
    const rootStat = lstatSync(absoluteRoot);
    const uid = process.getuid?.();
    const canonicalRoot = realpathSync(absoluteRoot);
    const lockStat = lstatSync(join(canonicalRoot, LOCK_FILE_NAME));
    const inheritedStat = fstatSync(fd);
    if (
      uid === undefined || !rootStat.isDirectory() || rootStat.uid !== uid ||
      (rootStat.mode & 0o077) !== 0 || (rootStat.mode & 0o700) !== 0o700 ||
      !lockStat.isFile() || lockStat.uid !== uid || lockStat.nlink !== 1 ||
      (lockStat.mode & 0o777) !== 0o600 ||
      !samePrivateLockFile(inheritedStat, lockStat)
    ) {
      throw new Error();
    }
    return { canonicalRoot, rootStat, lockStat };
  } catch {
    throw new RunRootOwnershipUnavailableError();
  }
}

function samePrivateLockFile(actual: Stats, expected: Stats): boolean {
  return actual.isFile() && expected.isFile() && actual.uid === expected.uid &&
    actual.nlink === 1 && expected.nlink === 1 &&
    (actual.mode & 0o777) === 0o600 && (expected.mode & 0o777) === 0o600 &&
    actual.dev === expected.dev && actual.ino === expected.ino;
}

async function openInheritedFdApi(): Promise<InheritedFdApi> {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    return dlopen("libc.so.6", {
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      fcntl: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }) as InheritedFdApi;
  } catch {
    throw new RunRootOwnershipUnavailableError();
  }
}

function createInheritedLockDescriptor(
  fd: number,
  api: InheritedFdApi,
): LockDescriptor {
  let closed = false;
  let closePromise: Promise<void> | undefined;
  return {
    fd,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (closed) return;
        if (api.symbols.close(fd) !== 0) {
          throw new RunRootOwnershipUnavailableError();
        }
        closed = true;
        api.close();
      })();
      return closePromise;
    },
  };
}

/** Reject a token for any other root, or a replaced root/lockfile inode. */
export function assertRunRootOwnershipFor(
  owner: RunRootOwnership,
  runRoot: string,
): void {
  const state = ownershipStates.get(owner as object);
  if (!state || state.closing || state.closed) {
    throw new RunRootOwnershipUnavailableError();
  }
  try {
    const absoluteRoot = resolve(runRoot);
    const rootStat = lstatSync(absoluteRoot);
    const canonicalRoot = realpathSync(absoluteRoot);
    const lockStat = lstatSync(join(canonicalRoot, LOCK_FILE_NAME));
    const heldLockStat = fstatSync(state.lockHandle.fd);
    const uid = process.getuid?.();
    if (
      uid === undefined || !rootStat.isDirectory() || rootStat.uid !== uid ||
      (rootStat.mode & 0o077) !== 0 || (rootStat.mode & 0o700) !== 0o700 ||
      canonicalRoot !== state.canonicalRoot ||
      rootStat.dev !== state.rootDev || rootStat.ino !== state.rootIno ||
      !lockStat.isFile() || lockStat.uid !== uid || lockStat.nlink !== 1 ||
      (lockStat.mode & 0o777) !== 0o600 ||
      lockStat.dev !== state.lockDev || lockStat.ino !== state.lockIno ||
      !heldLockStat.isFile() || heldLockStat.uid !== uid || heldLockStat.nlink !== 1 ||
      (heldLockStat.mode & 0o777) !== 0o600 ||
      heldLockStat.dev !== state.lockDev || heldLockStat.ino !== state.lockIno
    ) {
      throw new Error();
    }
  } catch {
    throw new RunRootOwnershipUnavailableError();
  }
}

/** Run one workspace writer while retaining the lifetime root owner. */
export async function withRunRootWriter<T>(
  owner: RunRootOwnership,
  writer: () => T | Promise<T>,
): Promise<T> {
  const state = ownershipStates.get(owner as object);
  if (!state || state.closing || state.closed) {
    throw new RunRootOwnershipUnavailableError();
  }
  state.activeWriters += 1;
  try {
    return await writer();
  } finally {
    state.activeWriters -= 1;
    if (state.closing && state.activeWriters === 0) {
      state.resolveWriterDrain?.();
    }
  }
}

function createOwnershipHandle(state: OwnershipState): RunRootOwnership {
  let owner!: RunRootOwnership;
  owner = Object.freeze({
    [runRootOwnershipBrand]: true as const,
    close: () => closeOwnership(owner, state),
  });
  ownershipStates.set(owner, state);
  return owner;
}

function closeOwnership(
  owner: RunRootOwnership,
  state: OwnershipState,
): Promise<void> {
  if (ownershipStates.get(owner as object) !== state) {
    return Promise.reject(new RunRootOwnershipUnavailableError());
  }
  if (state.closePromise) return state.closePromise;
  state.closing = true;
  state.closePromise = (async () => {
    if (state.activeWriters > 0) {
      state.drainWriters = new Promise<void>((resolveDrain) => {
        state.resolveWriterDrain = resolveDrain;
      });
      await state.drainWriters;
    }
    try {
      await state.lockHandle.close();
    } catch {
      throw new RunRootOwnershipUnavailableError();
    }
    state.closed = true;
    ownershipStates.delete(owner as object);
  })();
  return state.closePromise;
}

async function waitForLockAcquirer(
  acquirer: LockAcquirer,
): Promise<number | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    acquirer.exited,
    new Promise<"timeout">((resolveTimeout) => {
      timeout = setTimeout(
        () => resolveTimeout("timeout"),
        LOCK_ACQUIRE_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (result !== "timeout") return result;

  try {
    acquirer.kill("SIGKILL");
  } catch {
    // Reap below; the parent-held FD remains open until acquisition ends.
  }
  let reapTimeout: ReturnType<typeof setTimeout> | undefined;
  const reaped = await Promise.race([
    acquirer.exited.then(() => true),
    new Promise<false>((resolveNotReaped) => {
      reapTimeout = setTimeout(
        () => resolveNotReaped(false),
        LOCK_REAP_TIMEOUT_MS,
      );
    }),
  ]);
  if (reapTimeout !== undefined) clearTimeout(reapTimeout);
  if (!reaped) {
    // Fail closed. The process reference is exact; no unrelated PID is signaled.
    throw new RunRootOwnershipUnavailableError();
  }
  throw new RunRootOwnershipUnavailableError();
}

async function openLockFile(runRoot: string): Promise<{
  lockHandle: FileHandle;
  canonicalRoot: string;
  rootDev: number;
  rootIno: number;
  lockDev: number;
  lockIno: number;
}> {
  let handle: FileHandle | undefined;
  try {
    if (process.platform !== "linux" || process.getuid === undefined) {
      throw new Error();
    }
    const absoluteRoot = resolve(runRoot);
    const rootStat = await lstat(absoluteRoot);
    const uid = process.getuid();
    if (
      !rootStat.isDirectory() || rootStat.uid !== uid ||
      (rootStat.mode & 0o077) !== 0 || (rootStat.mode & 0o700) !== 0o700
    ) {
      throw new Error();
    }
    const canonicalRoot = await realpath(absoluteRoot);
    const lockPath = join(canonicalRoot, LOCK_FILE_NAME);
    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") throw new Error();
    const closeOnExec = (constants as typeof constants & {
      readonly O_CLOEXEC?: number;
    }).O_CLOEXEC ?? 0;
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | noFollow | closeOnExec,
      0o600,
    );
    await handle.chmod(0o600);
    const lockStat = await handle.stat();
    if (
      !lockStat.isFile() || lockStat.uid !== uid || lockStat.nlink !== 1 ||
      (lockStat.mode & 0o077) !== 0 || (lockStat.mode & 0o777) !== 0o600
    ) {
      throw new Error();
    }
    return {
      lockHandle: handle,
      canonicalRoot,
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      lockDev: lockStat.dev,
      lockIno: lockStat.ino,
    };
  } catch {
    await handle?.close().catch(() => {});
    throw new RunRootOwnershipUnavailableError();
  }
}
