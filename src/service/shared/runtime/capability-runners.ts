/**
 * Default `GitRunner` / `TarRunner` implementations built over the
 * `RuntimeAdapter` `SubprocessAdapter` (`currentRuntime().subprocess`).
 *
 * Takosumi is consumed as a framework library: runtime capabilities are
 * *injected* rather than reached through host-specific globals in the library
 * surface. These defaults route every git / tar invocation through the runtime
 * adapter's subprocess primitive, which has Bun / Node / Workers
 * implementations. This keeps subprocess behavior byte-for-byte identical while
 * keeping host runtime calls outside the library surface. This is the boundary the reference service injects so callers never
 * reach the deployControl / runtime-agent fallback subprocess primitives in
 * production.
 *
 * Behavior parity contract (do not change without re-checking the deploy control
 * tar column parser and git-fetch call sites):
 *   - git: `ok` is `exit code === 0`; stdout / stderr are UTF-8 decoded.
 *   - tar: pipes `stdin`, forces `LC_ALL=C` / `LANG=C`, throws with the exact
 *     `tar <args> failed: <stderr>` message on a non-zero exit, and resolves
 *     with the UTF-8 decoded stdout otherwise.
 */

import type {
  GitInvocationResult,
  GitRunner,
  TarRunner,
} from "takosumi-contract/reference/runtime-capability";
import { currentRuntime } from "./detect.ts";
import type { SubprocessAdapter } from "./runtime.ts";

const decoder = new TextDecoder();

/**
 * Default `GitRunner` over the runtime adapter subprocess primitive. Mirrors
 * the local `runGitCommand(args, cwd)` behavior exactly.
 */
export function createSubprocessGitRunner(
  subprocess: SubprocessAdapter = currentRuntime().subprocess,
): GitRunner {
  return {
    async run(
      args: readonly string[],
      cwd?: string,
    ): Promise<GitInvocationResult> {
      const { code, stdout, stderr } = await subprocess.run("git", {
        args,
        ...(cwd !== undefined ? { cwd } : {}),
      });
      return {
        ok: code === 0,
        stdout: decoder.decode(stdout),
        stderr: decoder.decode(stderr),
      };
    },
  };
}

/**
 * Default `TarRunner` over the runtime adapter subprocess primitive. Mirrors
 * the local `runTarCommand(args, stdin)` behavior exactly, including the
 * forced C locale and the non-zero-exit error message.
 */
export function createSubprocessTarRunner(
  subprocess: SubprocessAdapter = currentRuntime().subprocess,
): TarRunner {
  return {
    async run(args: readonly string[], stdin: Uint8Array): Promise<string> {
      // Force a deterministic C locale so the `tar -tv` column format (mode,
      // owner, size, date, time, path) does not shift with the operator's
      // LANG / LC_TIME settings. Without this, locale-specific date / time
      // columns can introduce extra whitespace runs that confuse the column
      // parser.
      const { code, stdout, stderr } = await subprocess.run("tar", {
        args,
        stdin,
        env: { LC_ALL: "C", LANG: "C" },
      });
      if (code !== 0) {
        throw new Error(
          `tar ${args.join(" ")} failed: ${decoder.decode(stderr)}`,
        );
      }
      return decoder.decode(stdout);
    },
  };
}

/**
 * The bundled default `GitRunner`, resolving the subprocess primitive lazily
 * from `currentRuntime()` on each call so a `setRuntimeForTesting` override is
 * honored.
 */
export const defaultGitRunner: GitRunner = {
  run(args, cwd) {
    return createSubprocessGitRunner().run(args, cwd);
  },
};

/**
 * The bundled default `TarRunner`, resolving the subprocess primitive lazily
 * from `currentRuntime()` on each call so a `setRuntimeForTesting` override is
 * honored.
 */
export const defaultTarRunner: TarRunner = {
  run(args, stdin) {
    return createSubprocessTarRunner().run(args, stdin);
  },
};
