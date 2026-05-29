import {
  type EnvReader,
  type FsAdapter,
  type RuntimeAdapter,
  type ServeHttpHandle,
  type SubprocessAdapter,
  UnavailableInRuntimeError,
} from "./runtime.ts";

/**
 * Cloudflare Workers / V8 isolate runtime adapter.
 *
 * Workers expose env bindings as the second argument to `fetch(req, env)`,
 * not via globals. The adapter therefore does NOT capture env at module
 * load; callers must wrap `createWorkersRuntime(env)` per-request and
 * thread it through the handler invocation.
 *
 * FS, subprocess, signal handling, exit, and `serveHttp` are all
 * unavailable in V8 isolates. The adapter exposes them as fail-closed
 * surfaces so that any accidental call (e.g. from a CLI-only code path
 * imported by mistake) throws a clear error instead of a confusing
 * `Deno is not defined` ReferenceError.
 */

export interface WorkersEnvBindings {
  readonly [key: string]: unknown;
}

export function createWorkersRuntime(
  bindings: WorkersEnvBindings,
): RuntimeAdapter {
  const env: EnvReader = {
    get(name) {
      const value = bindings[name];
      return typeof value === "string" ? value : undefined;
    },
    toObject() {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(bindings)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    },
  };

  const fs: FsAdapter = {
    available: false,
    readTextFile() {
      throw new UnavailableInRuntimeError("fs.readTextFile", "workers");
    },
    readFile(): Promise<Uint8Array> {
      throw new UnavailableInRuntimeError("fs.readFile", "workers");
    },
    readTextFileSync(): string {
      throw new UnavailableInRuntimeError("fs.readTextFileSync", "workers");
    },
    writeTextFile() {
      throw new UnavailableInRuntimeError("fs.writeTextFile", "workers");
    },
    mkdir() {
      throw new UnavailableInRuntimeError("fs.mkdir", "workers");
    },
    isNotFoundError() {
      return false;
    },
  };

  const subprocess: SubprocessAdapter = {
    available: false,
    run() {
      throw new UnavailableInRuntimeError("subprocess.run", "workers");
    },
  };

  return {
    kind: "workers",
    env,
    fs,
    subprocess,
    exit() {
      throw new UnavailableInRuntimeError("exit", "workers");
    },
    onSignal() {
      // No-op on Workers; isolates have no signals.
    },
    serveHttp(): ServeHttpHandle {
      throw new UnavailableInRuntimeError("serveHttp", "workers");
    },
  };
}

export function isWorkers(): boolean {
  // Primary signal: Workers expose `navigator.userAgent` containing
  // "Cloudflare-Workers". This is the authoritative marker and is checked
  // first.
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (
    nav?.userAgent && typeof nav.userAgent === "string" &&
    nav.userAgent.includes("Cloudflare-Workers")
  ) {
    return true;
  }
  // Best-effort fallback for environments where `navigator.userAgent` is not
  // populated (older `workerd` builds): Workers expose `WebSocketPair` but not
  // Deno / Node `process`. This is a heuristic and could misclassify a
  // non-Deno/non-Node host that exposes `WebSocketPair`; the userAgent signal
  // above is preferred whenever available.
  const hasDeno =
    typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";
  const hasNodeProcess = typeof (globalThis as {
    process?: { versions?: { node?: string } };
  }).process?.versions?.node === "string";
  const hasWebSocketPair =
    typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !==
      "undefined";
  return hasWebSocketPair && !hasDeno && !hasNodeProcess;
}
