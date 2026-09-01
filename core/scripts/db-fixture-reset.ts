#!/usr/bin/env bun
/**
 * Disposable fixture reset for a local / development / test database.
 *
 * Protected production schemas stay forward-only: this CLI is the supported
 * way to unwind a *disposable* database after rewriting a migration you have
 * not released yet, so the answer to "I changed a migration and my local
 * database rejects it" stops being "drop the whole database".
 *
 * It is fail-closed by construction:
 *
 *   - `--scope` is mandatory and must be local / development / test; the
 *     scope is re-checked inside StorageMigrationFixtureResetter.
 *   - the connection string comes only from `--url` or
 *     `TAKOSUMI_FIXTURE_DATABASE_URL`. `DATABASE_URL`,
 *     `TAKOSUMI_STAGING_DATABASE_URL`, and
 *     `TAKOSUMI_PRODUCTION_DATABASE_URL` are never read, so an exported
 *     production credential cannot be picked up by accident.
 *   - the host must be a loopback address or a unix socket.
 *   - a production-like `TAKOSUMI_ENVIRONMENT` refuses outright.
 *
 * Usage:
 *   bun run db:fixture-reset --scope=local --steps=1
 *   bun run db:fixture-reset --scope=test --target-version=61 --dry-run
 *   bun run db:fixture-reset --scope=local --url=postgres://... --steps=2
 */

import { StorageMigrationFixtureResetter } from "../adapters/storage/migration-runner/fixture-reset.ts";
import type { StorageMigrationFixtureScope } from "../adapters/storage/migration-runner/fixture-reset.ts";
import type { SqlClient } from "../adapters/storage/sql.ts";
import { createPostgresSqlClient } from "./pg_sql_client.ts";

const FIXTURE_DATABASE_URL_ENV = "TAKOSUMI_FIXTURE_DATABASE_URL";
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "",
]);

interface CliOptions {
  readonly scope: StorageMigrationFixtureScope;
  readonly url: string;
  readonly steps?: number;
  readonly targetVersion?: number;
  readonly dryRun: boolean;
}

export class FixtureResetCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureResetCliError";
  }
}

export function assertDisposableScope(
  value: string | undefined,
): StorageMigrationFixtureScope {
  if (value === "local" || value === "development" || value === "test") {
    return value;
  }
  throw new FixtureResetCliError(
    `--scope is required and must be local, development, or test (got ${
      value ?? "nothing"
    }); protected production schemas are forward-only`,
  );
}

/**
 * Reject anything that is not obviously a disposable local database. The
 * check is deliberately narrow: an unparsable or remote target fails rather
 * than being given the benefit of the doubt.
 */
export function assertDisposableDatabaseUrl(url: string): void {
  if (url.startsWith("/") || url.startsWith("postgres:///") ||
    url.startsWith("postgresql:///")) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FixtureResetCliError(
      "fixture reset database URL is not parsable; expected a loopback postgres:// URL or a unix socket path",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new FixtureResetCliError(
      `fixture reset only accepts a postgres URL, got ${parsed.protocol}`,
    );
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new FixtureResetCliError(
      `fixture reset refuses the non-loopback host ${parsed.hostname}; point it at a disposable local database`,
    );
  }
}

export function assertDisposableEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const environment = (
    env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT ?? "local"
  ).toLowerCase();
  if (environment === "production" || environment === "staging") {
    throw new FixtureResetCliError(
      `fixture reset refuses to run with TAKOSUMI_ENVIRONMENT=${environment}; protected schemas are forward-only`,
    );
  }
}

export function parseFixtureResetArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliOptions {
  let scope: string | undefined;
  let url: string | undefined;
  let steps: number | undefined;
  let targetVersion: number | undefined;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--scope=")) {
      scope = arg.slice("--scope=".length);
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
    } else if (arg.startsWith("--steps=")) {
      steps = parsePositiveInteger(arg, arg.slice("--steps=".length));
    } else if (arg.startsWith("--target-version=")) {
      targetVersion = parsePositiveInteger(
        arg,
        arg.slice("--target-version=".length),
      );
    } else {
      throw new FixtureResetCliError(`unknown argument: ${arg}`);
    }
  }

  if (steps !== undefined && targetVersion !== undefined) {
    throw new FixtureResetCliError(
      "pass either --steps or --target-version, not both",
    );
  }

  const resolvedScope = assertDisposableScope(scope);
  assertDisposableEnvironment(env);
  const resolvedUrl = url ?? env[FIXTURE_DATABASE_URL_ENV];
  if (!resolvedUrl || resolvedUrl.length === 0) {
    throw new FixtureResetCliError(
      `no fixture database URL; pass --url or set ${FIXTURE_DATABASE_URL_ENV}. This CLI never reads DATABASE_URL`,
    );
  }
  assertDisposableDatabaseUrl(resolvedUrl);

  return {
    scope: resolvedScope,
    url: resolvedUrl,
    steps,
    targetVersion,
    dryRun,
  };
}

function parsePositiveInteger(arg: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new FixtureResetCliError(`${arg} must be a non-negative integer`);
  }
  return value;
}

function printHelp(): void {
  console.log(
    [
      "takosumi disposable fixture reset",
      "",
      "Usage:",
      "  bun run db:fixture-reset --scope=local|development|test [options]",
      "",
      "Options:",
      "  --steps=N            unwind the N most recently applied migrations (default 1)",
      "  --target-version=N   unwind everything applied above version N",
      "  --url=<postgres url> loopback database to reset",
      "  --dry-run            print the plan and change nothing",
      "",
      `The database URL comes from --url or ${FIXTURE_DATABASE_URL_ENV} only.`,
      "Protected production schemas are forward-only and have no reset path.",
    ].join("\n"),
  );
}

/**
 * Reset against an already-authorized client. `main` owns URL authorization;
 * this owns the reset itself, so the real behaviour is reachable from a test
 * with an in-process database.
 */
export async function runFixtureReset(
  client: SqlClient,
  options: Omit<CliOptions, "url">,
  write: (line: string) => void = console.log,
): Promise<readonly string[]> {
  const resetter = new StorageMigrationFixtureResetter(client, {
    scope: options.scope,
  });
  const result = await resetter.reset({
    steps: options.steps,
    targetVersion: options.targetVersion,
    dryRun: options.dryRun,
  });
  const entries = options.dryRun ? result.planned : result.resetNow;
  write(
    `[db-fixture-reset] scope=${options.scope} dryRun=${options.dryRun} ${
      options.dryRun ? "would reset" : "reset"
    } ${entries.length} migration(s):`,
  );
  for (const entry of entries) {
    write(
      `  - ${entry.migration.id} v${entry.migration.version} (${entry.migration.domain})`,
    );
  }
  if (entries.length === 0) {
    write("[db-fixture-reset] nothing to unwind.");
  }
  return entries.map((entry) => entry.migration.id);
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }

  let options: CliOptions;
  try {
    options = parseFixtureResetArgs(argv, process.env);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    printHelp();
    return 1;
  }

  const { client, close } = await createPostgresSqlClient(options.url);
  try {
    await runFixtureReset(client, options);
    return 0;
  } catch (error) {
    console.error(`[db-fixture-reset] failed: ${(error as Error).message}`);
    return 1;
  } finally {
    await close().catch(() => {});
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
