import { denoRuntime, isDeno } from "./deno.ts";
import { isNode, nodeRuntime } from "./node.ts";
import { isWorkers } from "./workers.ts";
import {
  type FsAdapter,
  type RuntimeAdapter,
  type SubprocessAdapter,
  UnavailableInRuntimeError,
} from "./runtime.ts";

let cached: RuntimeAdapter | undefined;

/**
 * Auto-detect the current runtime and return its adapter.
 *
 * Order matters: Deno first (it exposes `Deno.*`), then Node (which has
 * `process.versions.node`), then Workers (V8 isolate with no Deno / Node).
 * Tests that need a specific runtime can override the cache by calling
 * `setRuntimeForTesting(adapter)`.
 *
 * On Workers, the caller MUST use `createWorkersRuntime(env)` per-request
 * because env bindings arrive on the fetch invocation, not at module
 * load. This function only returns a useful adapter on long-running
 * server runtimes.
 */
export function currentRuntime(): RuntimeAdapter {
  if (cached) return cached;
  if (isDeno()) {
    cached = denoRuntime;
    return cached;
  }
  if (isNode()) {
    cached = nodeRuntime;
    return cached;
  }
  if (isWorkers()) {
    cached = unknownWorkersRuntime();
    return cached;
  }
  cached = unknownRuntime();
  return cached;
}

export function setRuntimeForTesting(adapter: RuntimeAdapter): void {
  cached = adapter;
}

export function resetRuntimeForTesting(): void {
  cached = undefined;
}

function unknownRuntime(): RuntimeAdapter {
  const fs: FsAdapter = {
    available: false,
    readTextFile() {
      throw new UnavailableInRuntimeError("fs.readTextFile", "unknown");
    },
    readFile(): Promise<Uint8Array> {
      throw new UnavailableInRuntimeError("fs.readFile", "unknown");
    },
    readTextFileSync(): string {
      throw new UnavailableInRuntimeError("fs.readTextFileSync", "unknown");
    },
    writeTextFile() {
      throw new UnavailableInRuntimeError("fs.writeTextFile", "unknown");
    },
    mkdir() {
      throw new UnavailableInRuntimeError("fs.mkdir", "unknown");
    },
    isNotFoundError() {
      return false;
    },
  };
  const subprocess: SubprocessAdapter = {
    available: false,
    run() {
      throw new UnavailableInRuntimeError("subprocess.run", "unknown");
    },
  };
  return {
    kind: "unknown",
    env: {
      get: () => undefined,
      toObject: () => ({}),
    },
    fs,
    subprocess,
    exit() {
      throw new UnavailableInRuntimeError("exit", "unknown");
    },
    onSignal: () => {},
    serveHttp() {
      throw new UnavailableInRuntimeError("serveHttp", "unknown");
    },
  };
}

function unknownWorkersRuntime(): RuntimeAdapter {
  // Workers detected but no env bindings supplied (kernel module loaded
  // outside a fetch handler). Callers should switch to
  // `createWorkersRuntime(env)` per-request.
  const adapter = unknownRuntime();
  return { ...adapter, kind: "workers" };
}
