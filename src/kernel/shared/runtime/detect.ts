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
 * Detection priority (Workers first to avoid leaking Node-compat probes into
 * V8 isolates):
 *
 *   1. Cloudflare Workers (`navigator.userAgent === "Cloudflare-Workers"` or
 *      `globalThis.WebSocketPair` fallback). Returning early here keeps the
 *      module safe to import inside an isolate where touching `Deno.*` or
 *      `process.versions.node` could throw or spawn Node-compat shims.
 *   2. Bun (`typeof Bun !== "undefined"`). Bun is mostly Node-compatible but
 *      surfaces its own marker; we still treat the adapter as `node`-shaped
 *      because Bun supports the same `node:fs` / `node:http` modules.
 *   3. Deno (`isDeno()` = `typeof Deno.Command === "function"`). A naive
 *      `typeof Deno !== "undefined"` probe can be satisfied by partial
 *      compatibility globals in embedded hosts and then misclassify them as
 *      Deno before calling missing `Deno.Command` / `Deno.serve` APIs.
 *      `isDeno()` instead probes a genuine `Deno.Command` (a function only on
 *      real Deno), which is the reliable discriminator. It deliberately does
 *      NOT also require `process.versions.node` absent, because Deno 2.x
 *      exposes a Node-compat `process.versions.node` string — that clause
 *      would reject real Deno.
 *   4. Node.js (`isNode()` = `process.versions.node` string). Checked AFTER
 *      Deno: Deno also reports `process.versions.node`, so Deno must be matched
 *      first via the `Deno.Command` probe; the only host that reaches this
 *      branch is genuine Node.
 *
 * On Workers, callers MUST use `createWorkersRuntime(env)` per request
 * because env bindings arrive on the fetch invocation, not at module load.
 * This function only returns a useful adapter on long-running server runtimes.
 *
 * Tests that need a specific runtime can override the cache by calling
 * `setRuntimeForTesting(adapter)`.
 */
export function currentRuntime(): RuntimeAdapter {
  if (cached) return cached;
  if (isWorkers()) {
    cached = unknownWorkersRuntime();
    return cached;
  }
  if (isBun()) {
    // Bun's `node:*` modules cover the FS / HTTP / signal surfaces the
    // kernel needs, so reuse the Node adapter. The Node adapter's synchronous
    // FS path (`readTextFileSync`) no longer depends on a `globalThis.require`
    // bootstrap: it uses the `require` pre-warmed from
    // `node:module#createRequire` (see node.ts), which Bun exposes. This path
    // is still not exercised by a verified Bun deployment profile per
    // AGENTS.md, so treat Bun support as best-effort until a Bun smoke test
    // covers descriptor JSON loading.
    cached = nodeRuntime;
    return cached;
  }
  if (isDeno()) {
    cached = denoRuntime;
    return cached;
  }
  if (isNode()) {
    cached = nodeRuntime;
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

/** Detect Bun via its global marker. Kept inline so callers do not have to
 *  import a Bun-specific helper. */
function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
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
    makeTempDir() {
      throw new UnavailableInRuntimeError("fs.makeTempDir", "unknown");
    },
    remove() {
      throw new UnavailableInRuntimeError("fs.remove", "unknown");
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
      set: () => {},
      toObject: () => ({}),
    },
    fs,
    subprocess,
    execPath() {
      throw new UnavailableInRuntimeError("execPath", "unknown");
    },
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
