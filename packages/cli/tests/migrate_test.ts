import assert from "node:assert/strict";
import { runMigrate } from "../src/commands/migrate.ts";

Deno.test("runMigrate fails fast with missing-env when DATABASE_URL unset for staging", async () => {
  const lines: string[] = [];
  const result = await runMigrate({
    env: "staging",
    readEnv: () => undefined,
    resolveScript: () => "/tmp/db-migrate.ts",
    spawn: () => Promise.resolve({ code: 0 }),
    write: (line) => lines.push(line),
  });
  assert.equal(result.status, "missing-env");
  assert.equal(result.exitCode, 2);
  assert.ok(lines.some((line) => /TAKOSUMI_DATABASE_URL/.test(line)));
});

Deno.test("runMigrate dry-run does not require DATABASE_URL", async () => {
  let spawnedArgs: readonly string[] | undefined;
  const result = await runMigrate({
    env: "production",
    dryRun: true,
    readEnv: () => undefined,
    resolveScript: () => "/tmp/db-migrate.ts",
    spawn: (_cmd, args) => {
      spawnedArgs = args;
      return Promise.resolve({ code: 0 });
    },
    write: () => {},
  });
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.ok(spawnedArgs);
  assert.ok(spawnedArgs!.includes("--dry-run"));
  assert.ok(spawnedArgs!.includes("--env=production"));
});

Deno.test("runMigrate returns missing-script when kernel script unreachable", async () => {
  const lines: string[] = [];
  const result = await runMigrate({
    env: "local",
    readEnv: () => undefined,
    resolveScript: () => undefined,
    spawn: () => Promise.resolve({ code: 0 }),
    write: (line) => lines.push(line),
  });
  assert.equal(result.status, "missing-script");
  assert.equal(result.exitCode, 1);
  assert.ok(lines.some((line) => /db-migrate\.ts/.test(line)));
  assert.ok(
    lines.some((line) => /cd packages\/kernel/.test(line)),
    "must print the exact command operators should run",
  );
});

Deno.test("runMigrate spawns deno run against resolved script", async () => {
  let spawnedCmd: string | undefined;
  let spawnedArgs: readonly string[] | undefined;
  const result = await runMigrate({
    env: "local",
    readEnv: (key) =>
      key === "TAKOSUMI_DATABASE_URL" ? "postgres://x/y" : undefined,
    resolveScript: () => "/path/to/db-migrate.ts",
    spawn: (cmd, args) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      return Promise.resolve({ code: 0 });
    },
    write: () => {},
  });
  assert.equal(result.status, "ok");
  assert.equal(spawnedCmd, "deno");
  assert.ok(spawnedArgs);
  assert.equal(spawnedArgs![0], "run");
  assert.ok(spawnedArgs!.includes("/path/to/db-migrate.ts"));
  assert.ok(spawnedArgs!.includes("--env=local"));
  assert.ok(!spawnedArgs!.includes("--dry-run"));
});

Deno.test("runMigrate surfaces non-zero exit codes from kernel script", async () => {
  const result = await runMigrate({
    env: "local",
    readEnv: (key) =>
      key === "TAKOSUMI_DATABASE_URL" ? "postgres://x/y" : undefined,
    resolveScript: () => "/path/to/db-migrate.ts",
    spawn: () => Promise.resolve({ code: 7 }),
    write: () => {},
  });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
  assert.match(result.message ?? "", /code 7/);
});
