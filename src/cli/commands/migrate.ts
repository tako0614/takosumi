import { Command } from "../command.ts";
import {
  exitProcess,
  readEnv,
  spawnMigrate,
  statIsFile,
} from "./migrate-runtime.ts";

export type MigrateEnv = "local" | "staging" | "production" | string;

export type MigrateStatus =
  | "missing-env"
  | "missing-script"
  | "ok"
  | "failed"
  | "spawn-failed";

export interface MigrateResult {
  readonly status: MigrateStatus;
  readonly exitCode: number;
  readonly message?: string;
}

export interface RunMigrateOptions {
  readonly env: MigrateEnv;
  readonly dryRun?: boolean;
  readonly readEnv: (key: string) => string | undefined;
  readonly resolveScript: () => string | undefined;
  readonly spawn: (
    cmd: string,
    args: readonly string[],
  ) => Promise<{ readonly code: number }>;
  readonly write: (line: string) => void;
}

const DATABASE_URL_KEYS: Record<string, readonly string[]> = {
  local: ["TAKOSUMI_DATABASE_URL", "DATABASE_URL"],
  staging: [
    "TAKOSUMI_STAGING_DATABASE_URL",
    "TAKOSUMI_DATABASE_URL",
    "DATABASE_URL",
  ],
  production: [
    "TAKOSUMI_PRODUCTION_DATABASE_URL",
    "TAKOSUMI_DATABASE_URL",
    "DATABASE_URL",
  ],
};

function envRequiresDatabaseUrl(env: MigrateEnv, dryRun: boolean): boolean {
  if (dryRun) return false;
  return env === "staging" || env === "production";
}

function readDatabaseUrl(
  env: MigrateEnv,
  readEnv: (key: string) => string | undefined,
): string | undefined {
  const candidates = DATABASE_URL_KEYS[env] ?? DATABASE_URL_KEYS.local;
  for (const key of candidates) {
    const value = readEnv(key);
    if (value) return value;
  }
  return undefined;
}

/**
 * Default `resolveScript` implementation. Resolves
 * `src/kernel/scripts/db-migrate.ts` relative to this CLI package.
 * Returns `undefined` when the file cannot be located on disk.
 */
export function defaultResolveScript(): string | undefined {
  try {
    const here = new URL(import.meta.url);
    const candidate = new URL(
      "../../../kernel/scripts/db-migrate.ts",
      here,
    );
    if (candidate.protocol !== "file:") return candidate.toString();
    const path = candidate.pathname;
    if (!statIsFile(path)) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

export async function runMigrate(
  options: RunMigrateOptions,
): Promise<MigrateResult> {
  const dryRun = options.dryRun === true;
  if (envRequiresDatabaseUrl(options.env, dryRun)) {
    const url = readDatabaseUrl(options.env, options.readEnv);
    if (!url) {
      options.write(
        `error: TAKOSUMI_DATABASE_URL (or env-specific override) is required ` +
          `for migrating against ${options.env}; set it before re-running.`,
      );
      return { status: "missing-env", exitCode: 2 };
    }
  }

  const script = options.resolveScript();
  if (!script) {
    options.write(
      "error: could not locate kernel scripts/db-migrate.ts; ensure " +
        "@takosjp/takosumi kernel sources are installed alongside the CLI.",
    );
    options.write(
      "hint: run takosumi migrate from the @takosjp/takosumi package root, or run " +
        `bun run ${dryRun ? "db:migrate:dry-run" : "db:migrate"}`,
    );
    return { status: "missing-script", exitCode: 1 };
  }

  const args: string[] = [script, `--env=${options.env}`];
  if (dryRun) args.push("--dry-run");

  try {
    const result = await options.spawn("bun", args);
    if (result.code !== 0) {
      const message = `kernel db-migrate exited with code ${result.code}`;
      options.write(`error: ${message}`);
      return { status: "failed", exitCode: result.code, message };
    }
    return { status: "ok", exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.write(`error: failed to spawn bun: ${message}`);
    return { status: "spawn-failed", exitCode: 1, message };
  }
}

function createMigrateCommand(): Command {
  return new Command("migrate")
    .description("Run Takosumi DB migrations")
    .option("--dry-run", "Show planned migrations without applying")
    .option(
      "--env <env>",
      "Target environment (local, staging, production)",
      "local",
    )
    .action(async (opts: { dryRun?: boolean; env: string }) => {
      const result = await runMigrate({
        env: opts.env as MigrateEnv,
        dryRun: opts.dryRun === true,
        readEnv: (key) => readEnv(key),
        resolveScript: defaultResolveScript,
        spawn: (cmd, args) => spawnMigrate(cmd, args),
        write: (line) => console.log(line),
      });
      if (result.exitCode !== 0) {
        exitProcess(result.exitCode);
      }
    }) as Command;
}

export const migrateCommand: Command = createMigrateCommand();
