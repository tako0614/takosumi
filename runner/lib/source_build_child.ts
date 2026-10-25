import { readFileSync } from "node:fs";
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import type { SourceBuildConfig } from "./types.ts";
import { runSourceBuildInline } from "./source_build.ts";

const PR_SET_CHILD_SUBREAPER = 36;
const PR_GET_CHILD_SUBREAPER = 37;
const WNOHANG = 1;
const ECHILD = 10;
const EINTR = 4;

type LinuxApi = {
  readonly symbols: {
    readonly prctl: (option: number, a: bigint, b: bigint, c: bigint, d: bigint) => number;
    readonly waitpid: (pid: number, status: number, options: number) => number;
    readonly __errno_location: () => Pointer;
  };
  close(): void;
};

function ownChildren(): number[] {
  const value = readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim();
  if (!value) return [];
  return value.split(/\s+/).map((raw) => {
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid owned child pid");
    return pid;
  });
}

function errno(api: LinuxApi): number {
  return new Int32Array(
    toArrayBuffer(api.symbols.__errno_location(), 0, Int32Array.BYTES_PER_ELEMENT),
  )[0];
}

function enableSubreaper(): LinuxApi {
  if (process.platform !== "linux" || ownChildren().length !== 0) {
    throw new Error("dedicated source build supervision unavailable");
  }
  const api = dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64_fast, FFIType.u64_fast, FFIType.u64_fast, FFIType.u64_fast],
      returns: FFIType.i32,
    },
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }) as LinuxApi;
  try {
    const value = new Int32Array(1);
    if (api.symbols.prctl(PR_GET_CHILD_SUBREAPER, BigInt(ptr(value)), 0n, 0n, 0n) !== 0 || value[0] !== 0) {
      throw new Error("source build child already inherits subreaper authority");
    }
    if (api.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0) {
      throw new Error("source build child subreaper unavailable");
    }
    value[0] = 0;
    if (api.symbols.prctl(PR_GET_CHILD_SUBREAPER, BigInt(ptr(value)), 0n, 0n, 0n) !== 0 || value[0] !== 1) {
      throw new Error("source build child subreaper unconfirmed");
    }
    return api;
  } catch (error) {
    api.close();
    throw error;
  }
}

/** Kill only descendants adopted by this dedicated process; ECHILD is proof. */
async function drainOwnedChildren(api: LinuxApi): Promise<void> {
  const status = new Int32Array(1);
  while (true) {
    for (const pid of ownChildren()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    while (true) {
      const result = api.symbols.waitpid(-1, ptr(status), WNOHANG);
      if (result > 0) continue;
      if (result === -1 && errno(api) === EINTR) continue;
      if (result === -1 && errno(api) === ECHILD) return;
      if (result !== 0) throw new Error("source build child drain unavailable");
      break;
    }
    await Bun.sleep(5);
  }
}

interface Payload {
  readonly sourceBuild: SourceBuildConfig;
  readonly sourceRoot: string;
  readonly timeoutMs?: number;
}

function readPayload(controller: AbortController): Promise<Payload> {
  return new Promise((resolve, reject) => {
    let first = true;
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2_000_000) {
        reject(new Error("source build child input exceeds bound"));
        return;
      }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (first) {
          first = false;
          try {
            resolve(JSON.parse(line) as Payload);
          } catch {
            reject(new Error("source build child input invalid"));
          }
        } else if (line === "ABORT") {
          controller.abort();
        } else {
          controller.abort();
        }
      }
    });
    process.stdin.on("end", () => {
      if (first) reject(new Error("source build child input missing"));
    });
  });
}

async function main(): Promise<void> {
  let api: LinuxApi | undefined;
  let result: { drained: boolean; ok: boolean; log?: string; error?: string };
  try {
    api = enableSubreaper();
    const controller = new AbortController();
    const payload = await readPayload(controller);
    try {
      const log = await runSourceBuildInline(payload.sourceBuild, payload.sourceRoot, {
        ...(payload.timeoutMs ? { timeoutMs: payload.timeoutMs } : {}),
        signal: controller.signal,
        onDirectChildExit: () => drainOwnedChildren(api!),
      });
      result = { drained: false, ok: true, log };
    } catch (error) {
      result = { drained: false, ok: false, error: error instanceof Error ? error.message : "source build failed" };
    }
    await drainOwnedChildren(api);
    result = { ...result, drained: true };
  } catch {
    result = { drained: false, ok: false, error: "source build child supervision unavailable" };
  } finally {
    api?.close();
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(result), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  process.exit(result.drained ? 0 : 1);
}

await main();
