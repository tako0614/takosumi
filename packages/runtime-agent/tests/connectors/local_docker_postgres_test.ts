import assert from "node:assert/strict";
import { LocalDockerPostgresConnector } from "../../src/connectors/selfhost/local_docker_postgres.ts";

interface CapturedCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

function makeMockCommand(
  outcomes: readonly { code: number; stderr?: string }[] = [],
): {
  command: typeof Deno.Command;
  calls: CapturedCommand[];
} {
  const calls: CapturedCommand[] = [];
  let idx = 0;
  // deno-lint-ignore no-explicit-any
  const command: any = class MockCommand {
    constructor(cmd: string, options: { args: readonly string[] }) {
      calls.push({ cmd, args: options.args });
    }
    output(): Promise<
      { code: number; stderr: Uint8Array; stdout: Uint8Array }
    > {
      const outcome = outcomes[idx++] ?? { code: 0 };
      return Promise.resolve({
        code: outcome.code,
        stdout: new Uint8Array(0),
        stderr: new TextEncoder().encode(outcome.stderr ?? ""),
      });
    }
  };
  return { command, calls };
}

Deno.test("LocalDockerPostgresConnector.verify reports ok when docker version exits 0", async () => {
  const { command, calls } = makeMockCommand([{ code: 0 }]);
  const connector = new LocalDockerPostgresConnector({ command });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.match(`${res.note}`, /docker daemon reachable/);
  assert.equal(calls[0].cmd, "docker");
  assert.equal(calls[0].args[0], "version");
});

Deno.test("LocalDockerPostgresConnector.verify reports network_error when docker exits non-zero", async () => {
  const { command } = makeMockCommand([
    { code: 1, stderr: "Cannot connect" },
  ]);
  const connector = new LocalDockerPostgresConnector({ command });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "network_error");
});

Deno.test("LocalDockerPostgresConnector.apply runs `docker run postgres:<version>` and emits connection string", async () => {
  const { command, calls } = makeMockCommand();
  const connector = new LocalDockerPostgresConnector({
    command,
    passwordGenerator: () => "fixed-pass",
  });
  const res = await connector.apply({
    shape: "database-postgres@v1",
    provider: "@takos/selfhost-postgres",
    resourceName: "rs",
    spec: { version: "16" },
  }, {});
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
