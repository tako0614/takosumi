import { readFileSync } from "node:fs";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import {
  assertRunRootOwnershipFor,
  type RunRootOwnership,
  withRunRootWriter,
} from "./run_root_ownership.ts";

const PR_SET_CHILD_SUBREAPER = 36;
const PR_GET_CHILD_SUBREAPER = 37;
const ECHILD = 10;
const EINTR = 4;
const WNOHANG = 1;
const MAX_DRAIN_TIMEOUT_MS = 300_000;

export class PreparationV2ChildSupervisorBusyError extends Error {
  constructor() {
    super("preparation child tree is not drained");
    this.name = "PreparationV2ChildSupervisorBusyError";
  }
}

export class PreparationV2ChildSupervisorDrainTimeoutError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly signalCode: string | null,
  ) {
    super("preparation child tree did not drain within the bound");
    this.name = "PreparationV2ChildSupervisorDrainTimeoutError";
  }
}

export class PreparationV2ChildSupervisorUnavailableError extends Error {
  constructor() {
    super("preparation child supervision is unavailable");
    this.name = "PreparationV2ChildSupervisorUnavailableError";
  }
}

interface LinuxChildApi {
  readonly symbols: {
    readonly prctl: (
      option: number,
      argument2: bigint,
      argument3: bigint,
      argument4: bigint,
      argument5: bigint,
    ) => number;
    readonly waitpid: (pid: number, status: number, options: number) => number;
    readonly __errno_location: () => number;
  };
  close(): void;
}

export interface PreparationV2RunnerResult {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly drained: boolean;
}

/**
 * Dormant Linux-only primitive for one dedicated Runner supervisor process.
 * It must not be constructed in a shared application/test process: waitpid(-1)
 * is safe here only because this process is reserved for the supervised Runner
 * and its descendants. The caller must keep `ownership` open until this object
 * closes successfully. This is not a ticket for another OS process to adopt.
 */
export class PreparationV2ChildSupervisor {
  readonly #runRoot: string;
  readonly #ownership: RunRootOwnership;
  readonly #api: LinuxChildApi;
  readonly #ownerHold: Promise<void>;
  readonly #releaseOwnerHold: () => void;
  #drainPromise?: Promise<boolean>;
  #phase: "ready" | "running" | "draining" | "unavailable" | "closed" =
    "ready";

  constructor(runRoot: string, ownership: RunRootOwnership) {
    assertSupportedLinux();
    assertDedicatedProcessHasNoChildren();
    try {
      assertRunRootOwnershipFor(ownership, runRoot);
      this.#api = openLinuxChildApi();
      try {
        enableChildSubreaper(this.#api);
      } catch {
        this.#api.close();
        throw new PreparationV2ChildSupervisorUnavailableError();
      }
      let releaseOwnerHold!: () => void;
      const ownerHold = new Promise<void>((resolve) => {
        releaseOwnerHold = resolve;
      });
      this.#ownerHold = withRunRootWriter(ownership, () => ownerHold);
      this.#releaseOwnerHold = releaseOwnerHold;
      void this.#ownerHold.catch(() => {
        this.#phase = "unavailable";
      });
    } catch {
      throw new PreparationV2ChildSupervisorUnavailableError();
    }
    this.#runRoot = runRoot;
    this.#ownership = ownership;
  }

  async runRunner(
    executable: string,
    args: string[],
    options: { readonly env: Record<string, string>; readonly drainTimeoutMs: number },
  ): Promise<PreparationV2RunnerResult> {
    this.#assertReady();
    assertRunRootOwnershipFor(this.#ownership, this.#runRoot);
    assertDrainTimeout(options.drainTimeoutMs);
    this.#phase = "running";
    let child: Bun.Subprocess<"ignore", "ignore", "ignore">;
    try {
      child = Bun.spawn([executable, ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: options.env,
      });
    } catch {
      this.#phase = "ready";
      throw new PreparationV2ChildSupervisorUnavailableError();
    }

    let exitCode: number | null;
    let signalCode: string | null;
    try {
      exitCode = await child.exited;
      signalCode = child.signalCode;
    } catch {
      this.#phase = "unavailable";
      throw new PreparationV2ChildSupervisorUnavailableError();
    }
    this.#phase = "draining";
    const drained = await this.drainAdoptedChildren({
      timeoutMs: options.drainTimeoutMs,
    });
    if (!drained) {
      throw new PreparationV2ChildSupervisorDrainTimeoutError(
        exitCode,
        signalCode,
      );
    }
    return { exitCode, signalCode, drained };
  }

  /** Returns false on bounded live-child timeout, retaining ownership and state. */
  async drainAdoptedChildren(options: { readonly timeoutMs: number }): Promise<boolean> {
    assertDrainTimeout(options.timeoutMs);
    if (this.#drainPromise) return this.#drainPromise;
    const drain = this.#drainAdoptedChildren(options.timeoutMs);
    this.#drainPromise = drain;
    try {
      return await drain;
    } finally {
      if (this.#drainPromise === drain) this.#drainPromise = undefined;
    }
  }

  async #drainAdoptedChildren(timeoutMs: number): Promise<boolean> {
    if (this.#phase !== "draining") {
      if (this.#phase === "ready") return true;
      throw new PreparationV2ChildSupervisorUnavailableError();
    }
    const deadline = performance.now() + timeoutMs;
    while (true) {
      let result: "empty" | "children-live" | "unavailable";
      try {
        result = reapExitedAdoptedChildren(this.#api);
      } catch {
        result = "unavailable";
      }
      if (result === "empty") {
        this.#phase = "ready";
        return true;
      }
      if (result === "unavailable") {
        this.#phase = "unavailable";
        throw new PreparationV2ChildSupervisorUnavailableError();
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await Bun.sleep(Math.min(remaining, 10));
    }
  }

  async close(): Promise<void> {
    if (this.#phase === "closed") return;
    if (this.#phase !== "ready") {
      throw new PreparationV2ChildSupervisorBusyError();
    }
    try {
      this.#api.close();
    } catch {
      this.#phase = "unavailable";
      throw new PreparationV2ChildSupervisorUnavailableError();
    }
    this.#phase = "closed";
    this.#releaseOwnerHold();
    await this.#ownerHold;
  }

  #assertReady(): void {
    if (this.#phase !== "ready") {
      if (this.#phase === "closed" || this.#phase === "unavailable") {
        throw new PreparationV2ChildSupervisorUnavailableError();
      }
      throw new PreparationV2ChildSupervisorBusyError();
    }
  }
}

function assertSupportedLinux(): void {
  if (
    process.platform !== "linux" ||
    (process.arch !== "x64" && process.arch !== "arm64") ||
    process.getuid === undefined
  ) {
    throw new PreparationV2ChildSupervisorUnavailableError();
  }
}

function assertDedicatedProcessHasNoChildren(): void {
  try {
    const children = readFileSync(
      `/proc/self/task/${process.pid}/children`,
      "utf8",
    ).trim();
    if (children !== "") throw new Error();
  } catch {
    throw new PreparationV2ChildSupervisorUnavailableError();
  }
}

function openLinuxChildApi(): LinuxChildApi {
  try {
    return dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64_fast, FFIType.u64_fast, FFIType.u64_fast, FFIType.u64_fast],
        returns: FFIType.i32,
      },
      waitpid: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      __errno_location: {
        args: [],
        returns: FFIType.ptr,
      },
    }) as LinuxChildApi;
  } catch {
    throw new PreparationV2ChildSupervisorUnavailableError();
  }
}

function enableChildSubreaper(api: LinuxChildApi): void {
  const value = new Int32Array(1);
  value[0] = -1;
  const before = api.symbols.prctl(
    PR_GET_CHILD_SUBREAPER,
    BigInt(ptr(value)),
    0n,
    0n,
    0n,
  );
  if (before !== 0 || value[0] !== 0) throw new Error();
  if (api.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0) {
    throw new Error();
  }
  value[0] = 0;
  const readBack = api.symbols.prctl(
    PR_GET_CHILD_SUBREAPER,
    BigInt(ptr(value)),
    0n,
    0n,
    0n,
  );
  if (readBack !== 0 || value[0] !== 1) throw new Error();
}

function reapExitedAdoptedChildren(
  api: LinuxChildApi,
): "empty" | "children-live" | "unavailable" {
  const status = new Int32Array(1);
  while (true) {
    const result = api.symbols.waitpid(-1, ptr(status), WNOHANG);
    if (result > 0) continue;
    if (result === 0) return "children-live";
    const errno = new Int32Array(
      toArrayBuffer(api.symbols.__errno_location(), 0, Int32Array.BYTES_PER_ELEMENT),
    )[0];
    if (errno === EINTR) continue;
    return errno === ECHILD ? "empty" : "unavailable";
  }
}

function assertDrainTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 ||
    timeoutMs > MAX_DRAIN_TIMEOUT_MS
  ) {
    throw new PreparationV2ChildSupervisorUnavailableError();
  }
}
