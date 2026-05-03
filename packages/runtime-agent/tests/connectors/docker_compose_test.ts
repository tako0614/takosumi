import assert from "node:assert/strict";
import { DockerComposeConnector } from "../../src/connectors/selfhost/docker_compose.ts";

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
  outcomes: readonly MockOutcome[],
): { command: typeof Deno.Command; calls: CapturedCommand[] } {
  const calls: CapturedCommand[] = [];
  let idx = 0;
  // deno-lint-ignore no-explicit-any
  const command: any = class MockCommand {
    readonly #cmd: string;
    readonly #args: readonly string[];
    constructor(cmd: string, options: { args: readonly string[] }) {
      this.#cmd = cmd;
      this.#args = options.args;
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

Deno.test("DockerComposeConnector.verify reports ok when `docker version` exits 0", async () => {
  const { command, calls } = makeMockCommand([{ code: 0 }]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.match(`${res.note}`, /docker daemon reachable/);
  assert.equal(calls[0].cmd, "docker");
  assert.equal(calls[0].args[0], "version");
});

Deno.test("DockerComposeConnector.verify reports network_error when docker exits non-zero", async () => {
  const { command } = makeMockCommand([
    { code: 1, stderr: "Cannot connect to the Docker daemon" },
  ]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "network_error");
});

Deno.test("DockerComposeConnector.apply runs `docker run` with image + port mapping", async () => {
  const { command, calls } = makeMockCommand([{ code: 0 }]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.apply({
    shape: "web-service@v1",
    provider: "@takos/selfhost-docker-compose",
    resourceName: "rs",
    spec: {
      image: "registry/app:1",
      port: 8080,
      env: { FOO: "bar" },
    },
  }, {});
  assert.equal(res.handle, "app");
  assert.equal(res.outputs.internalPort, 8080);
  assert.equal(res.outputs.internalHost, "app");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "docker");
  assert.equal(calls[0].args[0], "run");
  assert.ok(calls[0].args.includes("--name"));
  assert.ok(calls[0].args.includes("app"));
  assert.ok(calls[0].args.some((a) => a.startsWith("18080:")));
});

Deno.test("DockerComposeConnector.apply retries on port-allocation collision", async () => {
  const { command, calls } = makeMockCommand([
    {
      code: 125,
      stderr:
        "docker: Error response from daemon: Bind for 0.0.0.0:18080 failed: port is already allocated.",
    },
    {
      code: 125,
      stderr:
        "docker: Error response from daemon: Bind for 0.0.0.0:18081 failed: port is already allocated.",
    },
    { code: 0 },
  ]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.apply({
    shape: "web-service@v1",
    provider: "@takos/selfhost-docker-compose",
    resourceName: "rs",
    spec: { image: "registry/app:1", port: 8080 },
  }, {});
  assert.equal(calls.length, 3);
  assert.ok(calls[0].args.some((a) => a === "18080:8080"));
  assert.ok(calls[1].args.some((a) => a === "18081:8080"));
  assert.ok(calls[2].args.some((a) => a === "18082:8080"));
  assert.equal(res.handle, "app");
});

Deno.test("DockerComposeConnector.apply throws on non-port docker errors without retry", async () => {
  const { command, calls } = makeMockCommand([
    { code: 125, stderr: "Unable to find image 'registry/app:1' locally" },
  ]);
  const connector = new DockerComposeConnector({ command });
  await assert.rejects(
    () =>
      connector.apply({
        shape: "web-service@v1",
        provider: "@takos/selfhost-docker-compose",
        resourceName: "rs",
        spec: { image: "registry/app:1", port: 8080 },
      }, {}),
    /docker run failed/,
  );
  assert.equal(calls.length, 1);
});

Deno.test("DockerComposeConnector.destroy runs `docker rm -f`", async () => {
  const { command, calls } = makeMockCommand([{ code: 0 }, { code: 0 }]);
  const connector = new DockerComposeConnector({ command });
  await connector.apply({
    shape: "web-service@v1",
    provider: "@takos/selfhost-docker-compose",
    resourceName: "rs",
    spec: { image: "registry/app:1", port: 8080 },
  }, {});
  const res = await connector.destroy({
    shape: "web-service@v1",
    provider: "@takos/selfhost-docker-compose",
    handle: "app",
  }, {});
  assert.equal(res.ok, true);
  assert.equal(calls[1].args[0], "rm");
  assert.ok(calls[1].args.includes("-f"));
});

Deno.test("DockerComposeConnector.describe queries `docker inspect` and reports running with reconstructed outputs", async () => {
  const inspectJson = JSON.stringify({
    State: { Status: "running" },
    NetworkSettings: {
      Ports: {
        "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "18080" }],
      },
    },
    Config: { ExposedPorts: { "8080/tcp": {} }, Env: [] },
  });
  const { command, calls } = makeMockCommand([
    { code: 0, stdout: inspectJson },
  ]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.describe({
    shape: "web-service@v1",
    provider: "@takos/selfhost-docker-compose",
    handle: "app",
  }, {});
  assert.equal(res.status, "running");
  assert.equal(res.outputs?.internalPort, 8080);
  assert.equal(res.outputs?.internalHost, "app");
  assert.equal(res.outputs?.url, "http://localhost:18080");
  assert.equal(calls[0].cmd, "docker");
  assert.equal(calls[0].args[0], "inspect");
  assert.equal(calls[0].args[1], "app");
});

Deno.test("DockerComposeConnector.describe returns missing when docker inspect exits non-zero", async () => {
  const { command } = makeMockCommand([
    { code: 1, stderr: "Error: No such object: app" },
  ]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.describe({
    shape: "web-service@v1",
    provider: "@takos/selfhost-docker-compose",
    handle: "app",
  }, {});
  assert.equal(res.status, "missing");
});

Deno.test("DockerComposeConnector.describe returns missing when container is not running", async () => {
  const inspectJson = JSON.stringify({
    State: { Status: "exited" },
    NetworkSettings: { Ports: {} },
  });
  const { command } = makeMockCommand([{ code: 0, stdout: inspectJson }]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.describe({
    shape: "web-service@v1",
    provider: "@takos/selfhost-docker-compose",
    handle: "app",
  }, {});
  assert.equal(res.status, "missing");
});

Deno.test("DockerComposeConnector.describe survives without prior apply (restart scenario)", async () => {
  // Fresh connector instance — no in-memory state, but docker inspect succeeds.
  const inspectJson = JSON.stringify({
    State: { Status: "running" },
    NetworkSettings: {
      Ports: { "3000/tcp": [{ HostPort: "19999" }] },
    },
  });
  const { command } = makeMockCommand([{ code: 0, stdout: inspectJson }]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.describe({
    shape: "web-service@v1",
    provider: "@takos/selfhost-docker-compose",
    handle: "previously-deployed",
  }, {});
  assert.equal(res.status, "running");
  assert.equal(res.outputs?.internalPort, 3000);
  assert.equal(res.outputs?.url, "http://localhost:19999");
});
