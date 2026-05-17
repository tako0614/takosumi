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
    toObject(): Record<string, string>;
  };
  exit(code: number): never;
  addSignalListener(signal: Signal, handler: () => void): void;
  build: { os: string };
  errors: { NotFound: ErrorConstructor };
  readTextFile(path: string | URL): Promise<string>;
  // deno-lint-ignore no-explicit-any
  readTextFileSync(path: any): string;
  writeTextFile(path: string, data: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
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
  readTextFileSync(path) {
    return Deno.readTextFileSync(path);
  },
  writeTextFile(path, content) {
    return Deno.writeTextFile(path, content);
  },
  mkdir(path, options) {
    return Deno.mkdir(path, options);
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
  return typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";
}
