/**
 * RuntimeAdapter — substrate-neutral surface for the JS runtime primitives
 * the kernel actually depends on at boot. The kernel itself must run on
 * Deno, Node.js 22+, Cloudflare Workers, and any other Web-standard JS
 * runtime that supports `fetch` / `Request` / `Response` / Web Crypto.
 *
 * The kernel must not call `Deno.*`, `process.*`, or `node:*` directly
 * outside of this module. Anything reachable from a Cloudflare Worker
 * entry point (Hono `app.fetch` and the modules it imports) must compile
 * on V8 isolates, which means no FS, no subprocess, no signal handlers,
 * and no synchronous IO.
 *
 * The HTTP server entrypoint is the Web-standard fetch handler
 * `(req: Request) => Response | Promise<Response>`. `serveHttp` is only
 * called by long-running server entry points (Deno / Node); Workers
 * `export default { fetch: app.fetch }` directly and never invoke this
 * surface.
 */

export type RuntimeKind = "deno" | "node" | "workers" | "bun" | "unknown";

export type Signal = "SIGINT" | "SIGTERM";

export interface EnvReader {
  get(name: string): string | undefined;
  toObject(): Record<string, string>;
  /**
   * Set a process environment variable. Available on Deno (`Deno.env.set`)
   * and Node (`process.env[name] = value`); a no-op on Workers / unknown
   * runtimes, where process env is not a mutable surface. Used by long-running
   * server entry points (e.g. the CLI `server` command handing `PORT` to the
   * kernel module).
   */
  set(name: string, value: string): void;
}

export interface FsAdapter {
  readonly available: boolean;
  readTextFile(path: string | URL): Promise<string>;
  /**
   * Read the file as raw bytes (no decoding). Used by the installer
   * pipeline to compute artifact digests over binary build outputs.
   * Available on Deno and Node; throws on Workers.
   */
  readFile(path: string | URL): Promise<Uint8Array>;
  writeTextFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /**
   * Synchronous text read for descriptor bundles that are loaded at
   * module init time. Available on Deno and Node; throws on Workers.
   */
  readTextFileSync(path: string | URL): string;
  /**
   * Create a uniquely-named temporary directory and return its absolute
   * path. Used by the installer pipeline to stage git / prepared source
   * checkouts before reading the InternalDeploySpec. Available on Deno and Node;
   * throws on Workers (`makeTempDir` → `Deno.makeTempDir` /
   * `node:fs/promises#mkdtemp`).
   */
  makeTempDir(prefix?: string): Promise<string>;
  /**
   * Remove a file or directory. With `{ recursive: true }` the entire tree
   * is removed (used to clean up the temp checkout staged by
   * {@link FsAdapter.makeTempDir}). Available on Deno and Node; throws on
   * Workers (`remove` → `Deno.remove` / `node:fs/promises#rm`).
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

export type FetchHandler = (
  request: Request,
) => Response | Promise<Response>;

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly env: EnvReader;
  readonly fs: FsAdapter;
  readonly subprocess: SubprocessAdapter;
  /**
   * Absolute path to the runtime executable that is running this process
   * (`Deno.execPath()` / Node `process.execPath`). Used by CLI commands that
   * render supervisor templates (e.g. `takosumi server --detach`). Throws
   * {@link UnavailableInRuntimeError} on Workers / unknown runtimes.
   */
  execPath(): string;
  exit(code: number): never;
  onSignal(signal: Signal, handler: () => void): void;
  serveHttp(
    handler: FetchHandler,
    options?: ServeHttpOptions,
  ): ServeHttpHandle;
}

export class UnavailableInRuntimeError extends Error {
  constructor(api: string, runtime: RuntimeKind) {
    super(`${api} is not available on the ${runtime} runtime`);
    this.name = "UnavailableInRuntimeError";
  }
}
