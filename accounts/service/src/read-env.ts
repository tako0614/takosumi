// Single env-reading boundary for the accounts-service package.
//
// Several modules independently open-coded defensive process-env probes. This
// helper keeps that runtime boundary in one place so a future Workers binding
// bridge can be added deliberately instead of by ad hoc global probing.
//
// NOTE on Cloudflare Workers: in a pure Workers context `process.env` is
// absent, so `readEnvVar` returns `undefined` for every key. Workers operators
// surface configuration through Worker `env` bindings, NOT process env. Code
// that has a production fail-closed requirement on Workers must therefore
// detect the Workers runtime explicitly (see `isWorkersRuntime`) instead of
// relying on process-level markers being present.

type ProcessEnvLike = Record<string, string | undefined>;

function processEnv(): ProcessEnvLike | undefined {
  try {
    return (
      globalThis as {
        process?: { env?: ProcessEnvLike };
      }
    ).process?.env;
  } catch {
    return undefined;
  }
}

/**
 * Read a process-level env var, returning `undefined` when the runtime has no
 * process env (Workers), the global is missing, or env access is denied by the
 * runtime. Never throws.
 */
export function readEnvVar(name: string): string | undefined {
  const env = processEnv();
  if (!env) return undefined;
  try {
    return env[name];
  } catch {
    return undefined;
  }
}

/**
 * True when running on a runtime without process env (e.g. Cloudflare
 * Workers). Used by fail-closed guards that cannot read process-level
 * production markers on Workers and must instead refuse to fall back to a dev
 * default unless an explicit dev opt-in is set.
 */
export function isWorkersRuntime(): boolean {
  return processEnv() === undefined;
}
