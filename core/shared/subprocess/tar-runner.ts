/**
 * Shared low-level `tar` subprocess primitive.
 *
 * Single source of truth for the runtime-detecting `tar` primitive consumed by
 * the runtime-agent (`runtime-agent/subprocess/tar-runner.ts`). It lives in a
 * neutral leaf module that imports nothing from any other layer and loads Node
 * subprocess primitives lazily so Worker/browser bundles can include the
 * runtime-agent HTTP surface without pulling `node:*` modules into the static
 * graph.
 */

async function runTarCommandNode(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  const [{ spawn }, processModule] = await Promise.all([
    import("node:child_process"),
    import("node:process"),
  ]);
  return new Promise((resolve, reject) => {
    // Force a deterministic C locale so the `tar -tv` column format does not
    // shift with the operator's LANG / LC_TIME settings.
    const child = spawn("tar", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...processModule.env, LC_ALL: "C", LANG: "C" },
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

/**
 * Run `tar` with the given args, piping `stdin` to the subprocess and resolving
 * with its decoded stdout. Throws `tar <args> failed: <stderr>` on a non-zero exit.
 */
export function runTarCommand(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  return runTarCommandNode(args, stdin);
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
