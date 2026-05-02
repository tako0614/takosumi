import assert from "node:assert/strict";
import { LocalDockerPostgresConnector } from "../../src/connectors/selfhost/local_docker_postgres.ts";

interface CapturedCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

function makeMockCommand(): {
  command: typeof Deno.Command;
  calls: CapturedCommand[];
} {
  const calls: CapturedCommand[] = [];
  // deno-lint-ignore no-explicit-any
  const command: any = class MockCommand {
    constructor(cmd: string, options: { args: readonly string[] }) {
      calls.push({ cmd, args: options.args });
    }
    output(): Promise<
      { code: number; stderr: Uint8Array; stdout: Uint8Array }
    > {
      return Promise.resolve({
        code: 0,
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
      });
    }
  };
  return { command, calls };
}

Deno.test("LocalDockerPostgresConnector.apply runs `docker run postgres:<version>` and emits connection string", async () => {
  const { command, calls } = makeMockCommand();
  const connector = new LocalDockerPostgresConnector({
    command,
    passwordGenerator: () => "fixed-pass",
  });
  const res = await connector.apply({
    shape: "database-postgres@v1",
    provider: "local-docker",
    resourceName: "rs",
    spec: { version: "16" },
  });
  assert.match(res.handle, /^pg-app-/);
  assert.equal(res.outputs.host, "localhost");
  assert.equal(res.outputs.port, 15432);
  assert.equal(res.outputs.database, "app");
  assert.equal(res.outputs.username, "app");
  assert.match(
    `${res.outputs.connectionString}`,
    /^postgresql:\/\/app@localhost:\d+\/app$/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "run");
  assert.ok(calls[0].args.includes("postgres:16"));
  assert.ok(calls[0].args.some((a) => a === "POSTGRES_DB=app"));
});
