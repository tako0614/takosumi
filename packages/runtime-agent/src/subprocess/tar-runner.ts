/**
 * `tar` subprocess primitive for the runtime-agent prepared-source reader
 * (runtime-detecting).
 *
 * Runs `tar` through `Deno.Command` on Deno and through `node:child_process`
 * on Node, piping the archive bytes to stdin and selecting the path at call
 * time. No dnt module mapping is required: the local `declare const Deno` type
 * keeps the npm build typeable, and the runtime check picks the Node path
 * where `globalThis.Deno` is absent.
 */

import { spawn } from "node:child_process";
import process from "node:process";

declare const Deno: {
  Command: new (
    command: string,
    options?: {
      args?: readonly string[];
      stdin?: "piped" | "inherit" | "null";
      stdout?: "piped" | "inherit" | "null";
      stderr?: "piped" | "inherit" | "null";
      env?: Record<string, string>;
    },
  ) => {
    spawn(): {
      stdin: WritableStream<Uint8Array>;
      output(): Promise<{
        code: number;
        stdout: Uint8Array;
        stderr: Uint8Array;
      }>;
    };
  };
};

function hasDeno(): boolean {
  return typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";
}

async function runTarCommandDeno(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  // Force a deterministic C locale so the `tar -tv` column format (mode, owner,
  // size, date, time, path) does not shift with the operator's LANG / LC_TIME
  // settings. Without this, locale-specific date / time columns can introduce
  // extra whitespace runs that confuse the column parser.
  const child = new Deno.Command("tar", {
    args: [...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      LC_ALL: "C",
      LANG: "C",
    },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(stdin);
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(
      `tar ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

function runTarCommandNode(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Force a deterministic C locale so the `tar -tv` column format does not
    // shift with the operator's LANG / LC_TIME settings (matches the Deno
    // path).
    const child = spawn("tar", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    child.stdout?.on("data", (chunk: Uint8Array) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      const decoder = new TextDecoder();
      if ((code ?? 0) !== 0) {
        reject(
          new Error(
            `tar ${args.join(" ")} failed: ${
              decoder.decode(concatChunks(stderrChunks))
            }`,
          ),
        );
        return;
      }
      resolve(decoder.decode(concatChunks(stdoutChunks)));
    });
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export function runTarCommand(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  return hasDeno()
    ? runTarCommandDeno(args, stdin)
    : runTarCommandNode(args, stdin);
}

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
