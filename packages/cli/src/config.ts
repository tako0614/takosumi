/**
 * CLI config / env / file resolution.
 *
 * Resolution order for `--remote` / `--token` (highest priority first):
 *   1. CLI flag (`--remote`, `--token`) — explicit wins.
 *   2. Specific env: `TAKOSUMI_REMOTE_URL` / `TAKOSUMI_DEPLOY_TOKEN`.
 *   3. `~/.takosumi/config.yml` — operator-managed defaults so common
 *      flags (`remote_url`, `token`) need not be re-typed per command.
 *
 * The config file is parsed lazily on first `loadConfig()` call and cached
 * for the lifetime of the process — every CLI invocation already starts a
 * fresh process, so caching the file content is safe and avoids re-reading
 * `~/.takosumi/config.yml` for each subcommand wired through the same
 * binary (e.g. piped invocations).
 */

import { parse as parseYaml } from "@std/yaml";

export interface CliConfig {
  readonly kernelUrl?: string;
  readonly token?: string;
}

/**
 * Persisted file shape under `~/.takosumi/config.yml`. We keep the schema
 * deliberately small for now (`remote_url`, `token`); future per-host or
 * per-template entries can extend this without breaking the resolution
 * order above.
 */
export interface TakosumiConfigFile {
  readonly remote_url?: string;
  readonly token?: string;
}

let configFileCache: TakosumiConfigFile | null | undefined;

export async function loadConfig(): Promise<CliConfig> {
  const file = await loadConfigFile();
  return {
    kernelUrl: resolveKernelUrl(file),
    token: resolveToken(file),
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

/**
 * Read `~/.takosumi/config.yml` once per process. Returns `undefined` when
 * `$HOME` is unset, the file does not exist, or the YAML body is empty.
 * Other errors (parse failure, permission denied) are surfaced as a single
 * stderr warning so the operator knows the file is being silently ignored,
 * but they do NOT abort the CLI run — env / flags remain usable.
 *
 * Test hook: `__resetConfigFileCacheForTesting()` clears the cache so the
 * config-file integration test can write a temp config and re-load.
 */
async function loadConfigFile(): Promise<TakosumiConfigFile | undefined> {
  if (configFileCache !== undefined) {
    return configFileCache ?? undefined;
  }
  const path = configFilePath();
  if (!path) {
    configFileCache = null;
    return undefined;
  }
  try {
    const text = await Deno.readTextFile(path);
    const trimmed = text.trim();
    if (!trimmed) {
      configFileCache = null;
      return undefined;
    }
    const parsed = parseYaml(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        `[takosumi] ${path}: expected a YAML mapping, ignoring.`,
      );
      configFileCache = null;
      return undefined;
    }
    const file = parsed as TakosumiConfigFile;
    configFileCache = file;
    return file;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      configFileCache = null;
      return undefined;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[takosumi] failed to read ${path}: ${message}`);
    configFileCache = null;
    return undefined;
  }
}

function configFilePath(): string | undefined {
  const override = Deno.env.get("TAKOSUMI_CONFIG_FILE");
  if (override) return override;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) return undefined;
  return `${home}/.takosumi/config.yml`;
}

function resolveKernelUrl(
  file: TakosumiConfigFile | undefined,
): string | undefined {
  const fresh = Deno.env.get("TAKOSUMI_REMOTE_URL");
  if (fresh) return fresh;
  if (file?.remote_url) return file.remote_url;
  return undefined;
}

function resolveToken(
  file: TakosumiConfigFile | undefined,
): string | undefined {
  const deployToken = Deno.env.get("TAKOSUMI_DEPLOY_TOKEN");
  if (deployToken) return deployToken;
  if (file?.token) return file.token;
  return undefined;
}

/** Test hook: clear the lazily-cached config file. */
export function __resetConfigFileCacheForTesting(): void {
  configFileCache = undefined;
}
