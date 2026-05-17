import type {
  EnvReader,
  FetchHandler,
  FsAdapter,
  RuntimeAdapter,
  ServeHttpHandle,
  ServeHttpOptions,
  SubprocessAdapter,
  SubprocessOutput,
} from "./runtime.ts";

interface NodeProcess {
  env: Record<string, string | undefined>;
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
  readTextFileSync(path) {
    // Synchronous read: require the cached `node:fs` module if available.
    const required = nodeRequire("node:fs") as
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
  isNotFoundError(error) {
    return hasErrorCode(error, "ENOENT");
  },
};

function nodeRequire(specifier: string): unknown {
  const req = (globalThis as {
    require?: (specifier: string) => unknown;
  }).require;
  if (typeof req === "function") return req(specifier);
  // ESM-only Node: fall back to createRequire via import.meta if available.
  return undefined;
}

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
      const request = new Request(url, {
        method: req.method ?? "GET",
        headers,
        body,
      });
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
