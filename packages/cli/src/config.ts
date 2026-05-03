/**
 * CLI config / env resolution.
 *
 * Resolution order for `--remote` / `--token` (highest priority first):
 *   1. CLI flag (`--remote`, `--token`) — explicit wins.
 *   2. Command-specific env (e.g. `TAKOSUMI_DEPLOY_TOKEN` for deploy/destroy).
 *      The command-side reads these directly, not via this module.
 *   3. Generic env: `TAKOSUMI_REMOTE_URL` / `TAKOSUMI_TOKEN`.
 *   4. Deprecated aliases: `TAKOSUMI_KERNEL_URL` / `TAKOSUMI_TOKEN`. A
 *      one-shot warning fires the first time these are read so operators
 *      know to migrate.
 *
 * Future: read `~/.takosumi/config.yml` ahead of env. Not implemented yet.
 */

let warnedKernelUrl = false;
let warnedToken = false;

export interface CliConfig {
  readonly kernelUrl?: string;
  readonly token?: string;
}

export function loadConfig(): CliConfig {
  return {
    kernelUrl: resolveKernelUrl(),
    token: resolveToken(),
  };
}

export function resolveMode(
  flags: { remote?: string; token?: string },
  config: CliConfig,
): { mode: "local" } | { mode: "remote"; url: string; token?: string } {
  const url = flags.remote ?? config.kernelUrl;
  if (!url) return { mode: "local" };
  return { mode: "remote", url, token: flags.token ?? config.token };
}

function resolveKernelUrl(): string | undefined {
  const fresh = Deno.env.get("TAKOSUMI_REMOTE_URL");
  if (fresh) return fresh;
  const legacy = Deno.env.get("TAKOSUMI_KERNEL_URL");
  if (legacy) {
    if (!warnedKernelUrl) {
      console.warn(
        "[takosumi] TAKOSUMI_KERNEL_URL is deprecated; use TAKOSUMI_REMOTE_URL",
      );
      warnedKernelUrl = true;
    }
    return legacy;
  }
  return undefined;
}

function resolveToken(): string | undefined {
  // Generic alias matches `TAKOSUMI_TOKEN`. The deploy / artifact commands
  // separately fall back to `TAKOSUMI_DEPLOY_TOKEN` for stronger
  // command-specific scoping; this generic alias only fires when the
  // command didn't pass a token via flag and the more-specific env was
  // also unset.
  const token = Deno.env.get("TAKOSUMI_TOKEN");
  if (token && !warnedToken && !Deno.env.get("TAKOSUMI_DEPLOY_TOKEN")) {
    console.warn(
      "[takosumi] TAKOSUMI_TOKEN is generic; prefer TAKOSUMI_DEPLOY_TOKEN " +
        "for kernel deploy / artifact endpoints",
    );
    warnedToken = true;
  }
  return token;
}
