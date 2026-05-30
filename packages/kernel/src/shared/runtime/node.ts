import {
  type EnvReader,
  type FetchHandler,
  type FsAdapter,
  type RuntimeAdapter,
  type ServeHttpHandle,
  type ServeHttpOptions,
  type SubprocessAdapter,
  type SubprocessOutput,
  UnavailableInRuntimeError,
} from "./runtime.ts";

interface NodeProcess {
  env: Record<string, string | undefined>;
  execPath: string;
  exit(code?: number): never;
  on(event: string, handler: () => void): void;
}

function getProcess(): NodeProcess | undefined {
  const candidate = (globalThis as { process?: unknown }).process;
  if (
    typeof candidate === "object" && candidate !== null &&
    "env" in candidate && "exit" in candidate
  ) {
    return candidate as unknown as NodeProcess;
  }
  return undefined;
}

const env: EnvReader = {
  get(name) {
    const proc = getProcess();
    const value = proc?.env[name];
    return typeof value === "string" ? value : undefined;
  },
  set(name, value) {
    const proc = getProcess();
    if (proc) proc.env[name] = value;
  },
  toObject() {
    const proc = getProcess();
    if (!proc) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(proc.env)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  },
};

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === code;
}

const fs: FsAdapter = {
  available: true,
  async readTextFile(path) {
    const mod = await import("node:fs/promises");
    return await mod.readFile(path as string | URL, "utf8");
  },
  async readFile(path) {
    const mod = await import("node:fs/promises");
    const buf = await mod.readFile(path as string | URL);
    return new Uint8Array(buf);
  },
  readTextFileSync(path) {
    // Synchronous read: prefer the CommonJS `require` global when running on
    // classic Node, otherwise use the `require` synthesised from
    // `node:module#createRequire(import.meta.url)` that we pre-warm
    // asynchronously at module load (see `warmNodeRequire`). On pure-ESM Node
    // and Deno's node-compat shim there is no `globalThis.require`, so the
    // pre-warmed cache is the only path; the read happens lazily (descriptor
    // JSON loading at deploy-plan time), long after the warm-up import has
    // resolved.
    const required = nodeRequireSync("node:fs") as
      | { readFileSync(p: string | URL, enc: string): string }
      | undefined;
    if (!required) {
      throw new Error("node:fs synchronous read not available in this runtime");
    }
    return required.readFileSync(path, "utf8");
  },
  async writeTextFile(path, content) {
    const mod = await import("node:fs/promises");
    await mod.writeFile(path, content, "utf8");
  },
  async mkdir(path, options) {
    const mod = await import("node:fs/promises");
    await mod.mkdir(path, { recursive: options?.recursive ?? false });
  },
  async makeTempDir(prefix) {
    // Match `Deno.makeTempDir({ prefix })`: create a uniquely-named directory
    // inside the OS temp dir whose basename starts with `prefix`. Node's
    // `mkdtemp` takes a full path template and appends 6 random chars, so we
    // join `os.tmpdir()` with the prefix to land the temp dir in the same
    // location Deno uses.
    const [fsMod, osMod, pathMod] = await Promise.all([
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
    ]);
    const template = pathMod.join(osMod.tmpdir(), prefix ?? "");
    return await fsMod.mkdtemp(template);
  },
  async remove(path, options) {
    const mod = await import("node:fs/promises");
    await mod.rm(path as string | URL, {
      recursive: options?.recursive ?? false,
      force: false,
    });
  },
  isNotFoundError(error) {
    return hasErrorCode(error, "ENOENT");
  },
};

/**
 * Synchronously resolve a CJS specifier on Node (and Bun's Node-compat
 * surface).
 *
 * Resolution order:
 *   1. A `require` synthesised from `node:module#createRequire(import.meta.url)`
 *      that {@link warmNodeRequire} pre-warms via an async import at module
 *      load. This is the only path that works on pure-ESM Node and Deno's
 *      node-compat shim, where `globalThis.require` is absent.
 *   2. `globalThis.require` directly, when a CommonJS bootstrap exposes one.
 *
 * `createRequire` cannot be obtained synchronously without an existing
 * `require` (we would have to `await import("node:module")`), so the async
 * warm-up is started eagerly at module load. `readTextFileSync`'s only caller
 * loads descriptor JSON lazily at deploy-plan time — long after the warm-up
 * import resolves — so the cache is populated by the time the sync read runs.
 */
let cachedRequire: ((specifier: string) => unknown) | undefined;

function nodeRequireSync(specifier: string): unknown {
  if (cachedRequire) return cachedRequire(specifier);
  const builtin = (globalThis as {
    require?: (specifier: string) => unknown;
  }).require;
  if (typeof builtin === "function") {
    cachedRequire = builtin;
    return cachedRequire(specifier);
  }
  // No global require and the async warm-up has not resolved yet (or this is
  // a runtime without `node:module`). Returning undefined lets the caller
  // surface a clear "not available in this runtime" error.
  return undefined;
}

/**
 * Eagerly build a `require` via `node:module#createRequire(import.meta.url)`.
 *
 * Started once at module load and never awaited at the top level (so a runtime
 * without `node:module`, e.g. Cloudflare Workers, never blocks or throws at
 * import time — the dynamic import simply rejects and is swallowed). On Node /
 * Bun / Deno node-compat the import resolves and populates {@link cachedRequire}
 * for the synchronous read path.
 */
function warmNodeRequire(): void {
  if (cachedRequire) return;
  if (
    typeof (globalThis as { require?: unknown }).require === "function"
  ) {
    return;
  }
  try {
    import("node:module").then((moduleNs) => {
      const createRequire = (moduleNs as {
        createRequire?: (url: string) => (specifier: string) => unknown;
      }).createRequire;
      if (cachedRequire || typeof createRequire !== "function") return;
      cachedRequire = createRequire(import.meta.url);
    }).catch(() => {
      // Runtime without `node:module` (e.g. Workers). The sync read path falls
      // back to throwing "node:fs synchronous read not available in this
      // runtime", which is the documented behaviour for such runtimes.
    });
  } catch {
    // Some runtimes reject `import("node:*")` synchronously rather than
    // returning a rejected promise; swallow the same way.
  }
}

warmNodeRequire();

const subprocess: SubprocessAdapter = {
  available: true,
  async run(command, options): Promise<SubprocessOutput> {
    const { spawn } = await import("node:child_process");
    return await new Promise<SubprocessOutput>((resolve, reject) => {
      const child = spawn(command, [...(options?.args ?? [])], {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env
          ? { env: { ...getProcess()?.env, ...options.env } }
          : {}),
        stdio: [options?.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];
      child.stdout?.on(
        "data",
        (chunk: Uint8Array) => stdoutChunks.push(chunk),
      );
      child.stderr?.on(
        "data",
        (chunk: Uint8Array) => stderrChunks.push(chunk),
      );
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        resolve({
          code: code ?? 0,
          stdout: concatChunks(stdoutChunks),
          stderr: concatChunks(stderrChunks),
        });
      });
      if (options?.stdin && child.stdin) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
    });
  },
};

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export const nodeRuntime: RuntimeAdapter = {
  kind: "node",
  env,
  fs,
  subprocess,
  execPath() {
    const proc = getProcess();
    if (proc) return proc.execPath;
    throw new UnavailableInRuntimeError("execPath", "node");
  },
  exit(code) {
    const proc = getProcess();
    if (proc) proc.exit(code);
    throw new Error(`exit(${code}) called outside Node`);
  },
  onSignal(signal, handler) {
    const proc = getProcess();
    if (!proc) return;
    try {
      proc.on(signal, handler);
    } catch {
      // ignore — unsupported on some platforms (e.g. SIGTERM on Windows)
    }
  },
  serveHttp(handler, options): ServeHttpHandle {
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const promise = startNodeHttpServer(handler, options, resolveFinished);
    return {
      shutdown: async () => {
        const server = await promise;
        await new Promise<void>((resolve, reject) => {
          server.close((err: Error | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      finished,
    };
  },
};

interface NodeHttpServer {
  listen(port: number, hostname: string, cb: () => void): void;
  close(cb: (err: Error | undefined) => void): void;
  on(event: string, handler: (err: Error) => void): void;
}

async function startNodeHttpServer(
  handler: FetchHandler,
  options: ServeHttpOptions | undefined,
  onFinish: () => void,
): Promise<NodeHttpServer> {
  const http = await import("node:http");
  const server = http.createServer(
    async (
      req: { url?: string; method?: string; headers: Record<string, unknown> },
      res: {
        statusCode: number;
        setHeader(name: string, value: string): void;
        end(chunk?: Uint8Array | string): void;
        write(chunk: Uint8Array | string): void;
      },
    ) => {
      const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(","));
      }
      const body = req.method && req.method !== "GET" && req.method !== "HEAD"
        ? new ReadableStream<Uint8Array>({
          start(controller) {
            const r = req as unknown as {
              on(event: string, h: (chunk: Uint8Array) => void): void;
            };
            r.on("data", (chunk) => controller.enqueue(chunk));
            r.on("end", () => controller.close());
            r.on("error", (err) => controller.error(err));
          },
        })
        : null;
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method ?? "GET",
        headers,
        body,
      };
      if (body) init.duplex = "half";
      const request = new Request(url, init);
      const response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (!response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(value);
      }
      res.end();
    },
  ) as unknown as NodeHttpServer;
  await new Promise<void>((resolve) => {
    server.listen(
      options?.port ?? 8788,
      options?.hostname ?? "0.0.0.0",
      () => resolve(),
    );
  });
  server.on("close", onFinish);
  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      server.close(() => {});
    });
  }
  return server;
}

export function isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } })
    .process;
  return typeof proc?.versions?.node === "string";
}
