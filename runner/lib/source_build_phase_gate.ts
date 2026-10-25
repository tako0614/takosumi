/**
 * Source builds execute repository commands as the Runner uid. In a shared
 * Runner process they must not overlap another Run's materialized files.
 * This gate covers the full file lifetime, not only the write operation.
 */
type Phase = "build" | "sensitive";
type Waiter = {
  readonly phase: Phase;
  readonly resolve: (lease: PhaseLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};

export interface PhaseLease {
  release(): void;
  poison(): void;
}

let activeBuild = false;
let activeSensitive = 0;
let poisoned = false;
const waiters: Waiter[] = [];

function unavailable(): Error {
  return new Error("source build isolation is unavailable");
}

function pump(): void {
  if (poisoned) {
    for (const waiter of waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      waiter.reject(unavailable());
    }
    return;
  }
  if (activeBuild) return;
  while (waiters.length > 0) {
    const next = waiters[0];
    if (next.phase === "build" && activeSensitive !== 0) return;
    if (next.phase === "build") activeBuild = true;
    else activeSensitive += 1;
    waiters.shift();
    next.signal?.removeEventListener("abort", next.onAbort!);
    let released = false;
    const lease: PhaseLease = {
      release() {
        if (released) return;
        released = true;
        if (next.phase === "build") activeBuild = false;
        else activeSensitive -= 1;
        pump();
      },
      poison() {
        poisoned = true;
        this.release();
      },
    };
    next.resolve(lease);
    if (activeBuild) return;
  }
}

function enter(phase: Phase, signal?: AbortSignal): Promise<PhaseLease> {
  if (poisoned) return Promise.reject(unavailable());
  if (signal?.aborted) return Promise.reject(new Error("source build aborted"));
  return new Promise<PhaseLease>((resolve, reject) => {
    const waiter: Waiter = {
      phase,
      resolve,
      reject,
      ...(signal ? { signal } : {}),
      ...(signal ? {
        onAbort: () => {
          const index = waiters.indexOf(waiter);
          if (index < 0) return;
          waiters.splice(index, 1);
          reject(new Error("source build aborted"));
          pump();
        },
      } : {}),
    };
    waiters.push(waiter);
    if (signal && waiter.onAbort) signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal?.aborted) waiter.onAbort?.();
    else pump();
  });
}

export function enterSourceBuildPhase(signal?: AbortSignal): Promise<PhaseLease> {
  return enter("build", signal);
}

export function enterSensitiveFilePhase(signal?: AbortSignal): Promise<PhaseLease> {
  return enter("sensitive", signal);
}

/** Read-only test observation; never a release or credential authority. */
export function readSourceBuildPhaseForTest(): {
  readonly activeSensitive: number;
  readonly queuedBuilds: number;
} {
  return {
    activeSensitive,
    queuedBuilds: waiters.filter((waiter) => waiter.phase === "build").length,
  };
}
