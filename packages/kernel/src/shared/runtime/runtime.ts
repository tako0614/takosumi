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
