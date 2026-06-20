/**
 * RuntimeAdapter — substrate-neutral surface for the JS runtime primitives
 * the service actually depends on at boot. The service itself must run on
 * Bun, Node.js 22+, Cloudflare Workers, and any other Web-standard JS
 * runtime that supports `fetch` / `Request` / `Response` / Web Crypto.
 *
 * The service must not call runtime globals such as `process.*` or `node:*` directly
 * outside of this module. Anything reachable from a Cloudflare Worker
 * entry point (Hono `app.fetch` and the modules it imports) must compile
 * on V8 isolates, which means no FS, no subprocess, no signal handlers,
 * and no synchronous IO.
 *
 * The HTTP server entrypoint is the Web-standard fetch handler
 * `(req: Request) => Response | Promise<Response>`. `serveHttp` is only
 * called by long-running server entry points (Bun / Node); Workers
 * `export default { fetch: app.fetch }` directly and never invoke this
 * surface.
 */

export type RuntimeKind = "node" | "workers" | "bun" | "unknown";

export type Signal = "SIGINT" | "SIGTERM";

export interface EnvReader {
  get(name: string): string | undefined;
  toObject(): Record<string, string>;
  /**
   * Set a process environment variable. Available on Node/Bun
   * (`process.env[name] = value`); a no-op on Workers / unknown
   * runtimes, where process env is not a mutable surface. Used by long-running
   * server entry points (e.g. the CLI `server` command handing `PORT` to the
   * service module).
   */
  set(name: string, value: string): void;
}

export interface FsAdapter {
  readonly available: boolean;
  readTextFile(path: string | URL): Promise<string>;
  /**
   * Read the file as raw bytes (no decoding). Used by the deployControl
   * pipeline to compute artifact digests over binary build outputs.
   * Available on Node/Bun; throws on Workers.
   */
  readFile(path: string | URL): Promise<Uint8Array>;
  writeTextFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /**
   * Synchronous text read for descriptor bundles that are loaded at
   * module init time. Available on Node/Bun; throws on Workers.
   */
  readTextFileSync(path: string | URL): string;
  /**
   * Create a uniquely-named temporary directory and return its absolute
   * path. Used by the deploy control pipeline to stage git / prepared source
   * checkouts before running OpenTofu. Available on Node/Bun;
   * throws on Workers (`makeTempDir` → `node:fs/promises#mkdtemp`).
   */
  makeTempDir(prefix?: string): Promise<string>;
  /**
   * Remove a file or directory. With `{ recursive: true }` the entire tree
   * is removed (used to clean up the temp checkout staged by
   * {@link FsAdapter.makeTempDir}). Available on Node/Bun; throws on
   * Workers (`remove` → `node:fs/promises#rm`).
   */
  remove(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
  isNotFoundError(error: unknown): boolean;
}

export interface SubprocessOutput {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface SubprocessAdapter {
  readonly available: boolean;
  run(
    command: string,
    options?: {
      args?: readonly string[];
      stdin?: Uint8Array;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<SubprocessOutput>;
}

export interface ServeHttpHandle {
  shutdown(): Promise<void>;
  readonly finished: Promise<void>;
}

export interface ServeHttpOptions {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly env: EnvReader;
  readonly fs: FsAdapter;
  readonly subprocess: SubprocessAdapter;
  /**
   * Absolute path to the runtime executable that is running this process
   * (Node/Bun `process.execPath`). Used by CLI commands that
   * render supervisor templates for long-running operator processes. Throws
   * {@link UnavailableInRuntimeError} on Workers / unknown runtimes.
   */
  execPath(): string;
  exit(code: number): never;
  onSignal(signal: Signal, handler: () => void): void;
  serveHttp(handler: FetchHandler, options?: ServeHttpOptions): ServeHttpHandle;
}

export class UnavailableInRuntimeError extends Error {
  constructor(api: string, runtime: RuntimeKind) {
    super(`${api} is not available on the ${runtime} runtime`);
    this.name = "UnavailableInRuntimeError";
  }
}

/**
 * Fail-closed {@link FsAdapter} for runtimes without filesystem access
 * (Cloudflare Workers / unknown). Every IO method throws
 * {@link UnavailableInRuntimeError} tagged with `runtime`, and
 * `isNotFoundError` reports `false` because no IO ever succeeds here.
 *
 * Shared by the Workers adapter and the auto-detect fallback so the
 * unavailable surface has a single definition (no per-runtime drift when a
 * new FS method is added to the {@link FsAdapter} contract).
 */
export function unavailableFsAdapter(runtime: RuntimeKind): FsAdapter {
  return {
    available: false,
    readTextFile() {
      throw new UnavailableInRuntimeError("fs.readTextFile", runtime);
    },
    readFile(): Promise<Uint8Array> {
      throw new UnavailableInRuntimeError("fs.readFile", runtime);
    },
    readTextFileSync(): string {
      throw new UnavailableInRuntimeError("fs.readTextFileSync", runtime);
    },
    writeTextFile() {
      throw new UnavailableInRuntimeError("fs.writeTextFile", runtime);
    },
    mkdir() {
      throw new UnavailableInRuntimeError("fs.mkdir", runtime);
    },
    makeTempDir() {
      throw new UnavailableInRuntimeError("fs.makeTempDir", runtime);
    },
    remove() {
      throw new UnavailableInRuntimeError("fs.remove", runtime);
    },
    isNotFoundError() {
      return false;
    },
  };
}

/**
 * Fail-closed {@link SubprocessAdapter} for runtimes without process spawn
 * (Cloudflare Workers / unknown). `run` throws
 * {@link UnavailableInRuntimeError} tagged with `runtime`. Shared by the
 * Workers adapter and the auto-detect fallback.
 */
export function unavailableSubprocessAdapter(
  runtime: RuntimeKind,
): SubprocessAdapter {
  return {
    available: false,
    run() {
      throw new UnavailableInRuntimeError("subprocess.run", runtime);
    },
  };
}
