import assert from "node:assert/strict";
import { DockerComposeConnector } from "../../src/connectors/selfhost/docker_compose.ts";

interface CapturedCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

function makeMockCommand(
  outcomes: readonly { code: number; stderr?: string }[],
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
        stdout: new Uint8Array(0),
        stderr: new TextEncoder().encode(outcome.stderr ?? ""),
      });
    }
  };
  return { command, calls };
}

Deno.test("DockerComposeConnector.apply runs `docker run` with image + port mapping", async () => {
  const { command, calls } = makeMockCommand([{ code: 0 }]);
  const connector = new DockerComposeConnector({ command });
  const res = await connector.apply({
    shape: "web-service@v1",
    provider: "docker-compose",
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

Deno.test("DockerComposeConnector.destroy runs `docker rm -f`", async () => {
  const { command, calls } = makeMockCommand([{ code: 0 }, { code: 0 }]);
  const connector = new DockerComposeConnector({ command });
  await connector.apply({
    shape: "web-service@v1",
    provider: "docker-compose",
    resourceName: "rs",
    spec: { image: "registry/app:1", port: 8080 },
  }, {});
  const res = await connector.destroy({
    shape: "web-service@v1",
    provider: "docker-compose",
    handle: "app",
  }, {});
  assert.equal(res.ok, true);
  assert.equal(calls[1].args[0], "rm");
  assert.ok(calls[1].args.includes("-f"));
});
