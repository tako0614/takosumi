import type {
  EnvReader,
  FetchHandler,
  FsAdapter,
  RuntimeAdapter,
  ServeHttpHandle,
  Signal,
  SubprocessAdapter,
  SubprocessOutput,
} from "./runtime.ts";

declare const Deno: {
  env: {
    get(name: string): string | undefined;
    set(name: string, value: string): void;
    toObject(): Record<string, string>;
  };
  execPath(): string;
  exit(code: number): never;
  addSignalListener(signal: Signal, handler: () => void): void;
  build: { os: string };
  errors: { NotFound: ErrorConstructor };
  readTextFile(path: string | URL): Promise<string>;
  readFile(path: string | URL): Promise<Uint8Array>;
  // deno-lint-ignore no-explicit-any
  readTextFileSync(path: any): string;
  writeTextFile(path: string, data: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  makeTempDir(options?: { prefix?: string }): Promise<string>;
  remove(
    path: string | URL,
    options?: { recursive?: boolean },
  ): Promise<void>;
  Command: new (
    command: string,
    options?: {
      args?: readonly string[];
      stdin?: "piped" | "inherit" | "null";
      stdout?: "piped" | "inherit" | "null";
      stderr?: "piped" | "inherit" | "null";
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => {
    spawn(): {
      stdin: WritableStream<Uint8Array>;
      status: Promise<{ code: number }>;
      output(): Promise<{
        code: number;
        stdout: Uint8Array;
        stderr: Uint8Array;
      }>;
    };
    output(): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>;
  };
  serve(
    options: { port?: number; hostname?: string; signal?: AbortSignal },
    handler: FetchHandler,
  ): {
    shutdown(): Promise<void>;
    finished: Promise<void>;
  };
};

const env: EnvReader = {
  get(name) {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  },
  set(name, value) {
    Deno.env.set(name, value);
  },
  toObject() {
    try {
      return Deno.env.toObject();
    } catch {
      return {};
    }
  },
};

const fs: FsAdapter = {
  available: true,
  readTextFile(path) {
    return Deno.readTextFile(path);
  },
  readFile(path) {
    return Deno.readFile(path);
  },
  readTextFileSync(path) {
    return Deno.readTextFileSync(path);
  },
  writeTextFile(path, content) {
    return Deno.writeTextFile(path, content);
  },
  mkdir(path, options) {
    return Deno.mkdir(path, options);
  },
  makeTempDir(prefix) {
    return Deno.makeTempDir(prefix !== undefined ? { prefix } : undefined);
  },
  remove(path, options) {
    return Deno.remove(path, options);
  },
  isNotFoundError(error) {
    return error instanceof Deno.errors.NotFound;
  },
};

const subprocess: SubprocessAdapter = {
  available: true,
  async run(command, options): Promise<SubprocessOutput> {
    const cmd = new Deno.Command(command, {
      args: options?.args ?? [],
      stdin: options?.stdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(options?.env ? { env: options.env } : {}),
    });
    if (options?.stdin) {
      const child = cmd.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(options.stdin);
      await writer.close();
      const result = await child.output();
      return result;
    }
    return await cmd.output();
  },
};

export const denoRuntime: RuntimeAdapter = {
  kind: "deno",
  env,
  fs,
  subprocess,
  execPath() {
    return Deno.execPath();
  },
  exit(code) {
    Deno.exit(code);
  },
  onSignal(signal, handler) {
    try {
      if (signal === "SIGTERM" && Deno.build.os === "windows") return;
      Deno.addSignalListener(signal, handler);
    } catch {
      // Signal not supported on this platform; ignore.
    }
  },
  serveHttp(handler, options): ServeHttpHandle {
    const server = Deno.serve(
      {
        ...(options?.port !== undefined ? { port: options.port } : {}),
        ...(options?.hostname !== undefined
          ? { hostname: options.hostname }
          : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      handler,
    );
    return {
      shutdown: () => server.shutdown(),
      finished: server.finished,
    };
  },
};

export function isDeno(): boolean {
  // Probe for a genuine `Deno.Command` (a function only on real Deno) instead
  // of a bare `typeof Deno !== "undefined"`, so partial compatibility globals
  // in embedded hosts cannot satisfy `isDeno()`.
  //
  // NOTE: do NOT additionally gate on `process.versions.node` being absent —
  // Deno 2.x exposes a Node-compat `globalThis.process` with a faked
  // `versions.node` string, so a "Node absent" clause would reject real Deno.
  // The `Deno.Command === "function"` probe alone is the reliable
  // discriminator.
  const deno = (globalThis as { Deno?: { Command?: unknown } }).Deno;
  return typeof deno?.Command === "function";
}
