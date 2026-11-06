import { fileURLToPath } from "node:url";
import type { SourceBuildConfig } from "./types.ts";
import { buildPhaseEnv } from "./credentials.ts";
import { SOURCE_BUILD_CACHE_DIR_ENV } from "./constants.ts";
import { enterSourceBuildPhase } from "./source_build_phase_gate.ts";
import { createPhaseHome, type PhaseHome } from "./phase_home.ts";

interface ChildResult {
  readonly drained: boolean;
  readonly ok: boolean;
  readonly log?: string;
  readonly error?: string;
}

/**
 * The build runs in a dedicated child-subreaper, never in the shared HTTP
 * process. Its positive response is issued only after waitpid reports ECHILD.
 */
export async function runSupervisedSourceBuild(
  sourceBuild: SourceBuildConfig,
  sourceRoot: string,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<string> {
  if (options.signal?.aborted) throw new Error("source build aborted");
  const lease = await enterSourceBuildPhase(options.signal);
  let spawned = false;
  let provenDrained = false;
  let completed = false;
  let setupFailed = false;
  let home: PhaseHome | undefined;
  try {
    try {
      home = await createPhaseHome([sourceRoot]);
    } catch (error) {
      setupFailed = true;
      throw error;
    }
    const env = buildPhaseEnv();
    Object.assign(env, home.env);
    const cacheRoot = Bun.env[SOURCE_BUILD_CACHE_DIR_ENV];
    if (cacheRoot !== undefined) env[SOURCE_BUILD_CACHE_DIR_ENV] = cacheRoot;
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./source_build_child.ts", import.meta.url))],
      { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    spawned = true;
    const abort = () => {
      try {
        child.stdin.write("ABORT\n");
        void Promise.resolve(child.stdin.flush()).catch(() => {});
      } catch {
        // A dead child cannot provide a successful drain proof.
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      child.stdin.write(JSON.stringify({ sourceBuild, sourceRoot, timeoutMs: options.timeoutMs }) + "\n");
      await child.stdin.flush();
      if (options.signal?.aborted) abort();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      let result: ChildResult | undefined;
      try {
        result = JSON.parse(stdout) as ChildResult;
      } catch {
        // Missing or malformed completion is never a drain proof.
      }
      if (!result?.drained || exitCode !== 0) {
        throw new Error(
          `source build child supervision unavailable${stderr.trim() ? `: ${stderr.trim().slice(0, 512)}` : ""}`,
        );
      }
      provenDrained = true;
      if (!result.ok) throw new Error(result.error ?? "source build failed");
      if (typeof result.log !== "string") {
        throw new Error("source build child returned an invalid completion");
      }
      completed = true;
      return result.log;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      try {
        child.stdin.end();
      } catch {
        // The child has already closed its input.
      }
    }
  } finally {
    // A missing ECHILD proof means descendants may still hold this HOME.
    if (setupFailed || (spawned && !provenDrained)) {
      lease.poison();
    } else {
      let cleanupFailed = false;
      if (home) await home.cleanup().catch(() => { cleanupFailed = true; });
      if (cleanupFailed) lease.poison();
      else lease.release();
      if (cleanupFailed && completed) throw new Error("source build phase HOME cleanup failed");
    }
  }
}
