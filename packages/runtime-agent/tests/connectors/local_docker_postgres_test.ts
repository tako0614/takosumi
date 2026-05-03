import assert from "node:assert/strict";
import { LocalDockerPostgresConnector } from "../../src/connectors/selfhost/local_docker_postgres.ts";

interface CapturedCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

interface MockOutcome {
  readonly code: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

function makeMockCommand(
  outcomes: readonly MockOutcome[] = [],
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
        stdout: new TextEncoder().encode(outcome.stdout ?? ""),
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

Deno.test("LocalDockerPostgresConnector.apply retries on port-allocation collision", async () => {
  const { command, calls } = makeMockCommand([
    { code: 125, stderr: "port is already allocated" },
    { code: 0 },
  ]);
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
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.some((a) => a === "15432:5432"));
  assert.ok(calls[1].args.some((a) => a === "15433:5432"));
  assert.equal(res.outputs.port, 15433);
});

Deno.test("LocalDockerPostgresConnector.apply throws on non-port docker errors without retry", async () => {
  const { command, calls } = makeMockCommand([
    { code: 125, stderr: "image postgres:16 not found" },
  ]);
  const connector = new LocalDockerPostgresConnector({
    command,
    passwordGenerator: () => "fixed-pass",
  });
  await assert.rejects(
    () =>
      connector.apply({
        shape: "database-postgres@v1",
        provider: "@takos/selfhost-postgres",
        resourceName: "rs",
        spec: { version: "16" },
      }, {}),
    /docker run postgres failed/,
  );
  assert.equal(calls.length, 1);
});

Deno.test("LocalDockerPostgresConnector.describe queries `docker inspect` and reconstructs outputs", async () => {
  const inspectJson = JSON.stringify({
    State: { Status: "running" },
    NetworkSettings: {
      Ports: {
        "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "15432" }],
      },
    },
    Config: {
      Env: [
        "POSTGRES_DB=mydb",
        "POSTGRES_USER=myuser",
        "POSTGRES_PASSWORD=secret",
      ],
    },
  });
  const { command, calls } = makeMockCommand([
    { code: 0, stdout: inspectJson },
  ]);
  const connector = new LocalDockerPostgresConnector({ command });
  const res = await connector.describe({
    shape: "database-postgres@v1",
    provider: "@takos/selfhost-postgres",
    handle: "pg-app-abc123",
  }, {});
  assert.equal(res.status, "running");
  assert.equal(res.outputs?.host, "localhost");
  assert.equal(res.outputs?.port, 15432);
  assert.equal(res.outputs?.database, "mydb");
  assert.equal(res.outputs?.username, "myuser");
  assert.equal(
    res.outputs?.connectionString,
    "postgresql://myuser@localhost:15432/mydb",
  );
  assert.equal(calls[0].args[0], "inspect");
  assert.equal(calls[0].args[1], "pg-app-abc123");
});

Deno.test("LocalDockerPostgresConnector.describe returns missing when docker inspect fails", async () => {
  const { command } = makeMockCommand([
    { code: 1, stderr: "No such container" },
  ]);
  const connector = new LocalDockerPostgresConnector({ command });
  const res = await connector.describe({
    shape: "database-postgres@v1",
    provider: "@takos/selfhost-postgres",
    handle: "pg-app-missing",
  }, {});
  assert.equal(res.status, "missing");
});

Deno.test("LocalDockerPostgresConnector.describe survives without prior apply (restart scenario)", async () => {
  const inspectJson = JSON.stringify({
    State: { Status: "running" },
    NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "15999" }] } },
    Config: { Env: ["POSTGRES_DB=app", "POSTGRES_USER=app"] },
  });
  const { command } = makeMockCommand([{ code: 0, stdout: inspectJson }]);
  const connector = new LocalDockerPostgresConnector({ command });
  const res = await connector.describe({
    shape: "database-postgres@v1",
    provider: "@takos/selfhost-postgres",
    handle: "pg-app-fromdisk",
  }, {});
  assert.equal(res.status, "running");
  assert.equal(res.outputs?.port, 15999);
  assert.equal(
    res.outputs?.passwordSecretRef,
    "secret://selfhosted/database-postgres/pg-app-fromdisk/password",
  );
});
