import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
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
  readonly lockHandle: FileHandle;
  closing: boolean;
  closed: boolean;
  activeWriters: number;
  closePromise?: Promise<void>;
  drainWriters?: Promise<void>;
  resolveWriterDrain?: () => void;
}

type LockAcquirer = Bun.Subprocess<"ignore", number, "ignore">;

const LOCK_FILE_NAME = ".takosumi-run-root.lock";
const LOCK_COMMAND = "/usr/bin/flock";
const LOCK_CONFLICT_EXIT = 73;
const LOCK_ACQUIRE_TIMEOUT_MS = 1_000;
const LOCK_REAP_TIMEOUT_MS = 1_000;
const ownershipStates = new WeakMap<object, OwnershipState>();

/**
 * Acquire a Linux kernel advisory lock for one existing private runtime root.
 * This only coordinates cooperating processes; callers must enroll every
 * workspace writer and must not treat the lock as proof about legacy run state.
 */
export async function acquireRunRootOwnership(
  runRoot: string,
): Promise<RunRootOwnership> {
  const lockHandle = await openLockFile(runRoot);
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
    closing: false,
    closed: false,
    activeWriters: 0,
  };
  const owner = createOwnershipHandle(state);
  return owner;
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

async function openLockFile(runRoot: string): Promise<FileHandle> {
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
    return handle;
  } catch {
    await handle?.close().catch(() => {});
    throw new RunRootOwnershipUnavailableError();
  }
}
