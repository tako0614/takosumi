#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];
const fail = (message: string): void => {
  failures.push(message);
};
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");

const packageJson = JSON.parse(read("package.json")) as {
  readonly scripts?: Readonly<Record<string, string>>;
};
const scripts = packageJson.scripts ?? {};
for (const [name, command] of Object.entries(scripts)) {
  if (
    /(?:^|:)migrate:(?:down|rollback)(?::|$)/u.test(name) ||
    /\bdb-migrate-down\b/u.test(command) ||
    /\ballow-production-rollback\b/u.test(command)
  ) {
    fail(
      `package.json script ${name} exposes protected-schema down migration authority`,
    );
  }
}

if (existsSync(resolve(root, "core/scripts/db-migrate-down.ts"))) {
  fail("core/scripts/db-migrate-down.ts must not exist");
}

const productionRunner = read(
  "core/adapters/storage/migration-runner/mod.ts",
);
for (const token of [
  "planRollback",
  "RollbackStorageMigrations",
  "StorageMigrationDownNotSupported",
  "async rollback(",
]) {
  if (productionRunner.includes(token)) {
    fail(`production StorageMigrationRunner still exposes ${token}`);
  }
}

const fixtureReset = read(
  "core/adapters/storage/migration-runner/fixture-reset.ts",
);
for (const scope of ["local", "development", "test"]) {
  if (!fixtureReset.includes(`"${scope}"`)) {
    fail(`fixture reset does not explicitly admit ${scope}`);
  }
}
for (const forbidden of [
  "TAKOSUMI_PRODUCTION_DATABASE_URL",
  "TAKOSUMI_STAGING_DATABASE_URL",
  "DATABASE_URL",
  "createPostgresClient",
  "wrangler",
]) {
  if (fixtureReset.includes(forbidden)) {
    fail(`fixture reset must not resolve real targets (${forbidden})`);
  }
}

// The one shipped entrypoint allowed to reach the fixture reset. Local and
// test databases get a supported unwind path; protected schemas still get
// none. Its fail-closed guards are part of this boundary.
const FIXTURE_RESET_CLI = "core/scripts/db-fixture-reset.ts";
if (!existsSync(resolve(root, FIXTURE_RESET_CLI))) {
  fail(
    `${FIXTURE_RESET_CLI} must exist so disposable databases have a supported reset path`,
  );
} else {
  const cli = read(FIXTURE_RESET_CLI);
  const protectedEnvRead =
    /(?:process\.env|env)\s*(?:\.\s*|\[\s*["'])(?:DATABASE_URL|TAKOSUMI_PRODUCTION_DATABASE_URL|TAKOSUMI_STAGING_DATABASE_URL)\b/u;
  if (protectedEnvRead.test(cli)) {
    fail(`${FIXTURE_RESET_CLI} must not read a protected database URL`);
  }
  for (const guard of [
    "assertDisposableScope",
    "assertDisposableDatabaseUrl",
    "assertDisposableEnvironment",
    "TAKOSUMI_FIXTURE_DATABASE_URL",
  ]) {
    if (!cli.includes(guard)) {
      fail(`${FIXTURE_RESET_CLI} is missing the ${guard} guard`);
    }
  }
  if (scripts["db:fixture-reset"] !== `bun ${FIXTURE_RESET_CLI}`) {
    fail(
      `package.json script db:fixture-reset must run ${FIXTURE_RESET_CLI}`,
    );
  }
}

const tracked = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
);
if (tracked.status !== 0) {
  fail(`cannot list repository files: ${tracked.stderr.trim()}`);
} else {
  const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
  for (const path of tracked.stdout.split("\0").filter(Boolean)) {
    if (!sourceExtensions.has(extname(path))) continue;
    if (!existsSync(resolve(root, path))) continue;
    if (
      path ===
        "core/adapters/storage/migration-runner/fixture-reset.ts" ||
      path === FIXTURE_RESET_CLI ||
      path.startsWith("tests/")
    ) {
      continue;
    }
    if (
      /(?:from\s+|import\s*\()\s*["'][^"']*migration-runner\/fixture-reset/u
        .test(readFileSync(resolve(root, path), "utf8"))
    ) {
      fail(`${path} imports the fixture-only migration reset module`);
    }
  }
}

const operations = read("docs/operations/online-db-migrations.md");
if (
  !operations.includes(
    "protected production schema は forward-only",
  ) ||
  !operations.includes(
    "local / development / test fixture reset",
  )
) {
  fail(
    "online DB migration runbook must separate forward-only production from fixture reset",
  );
}

if (failures.length > 0) {
  console.error("production migration boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "production migration boundary passed: protected schemas are forward-only and fixture reset is test-scoped",
);
