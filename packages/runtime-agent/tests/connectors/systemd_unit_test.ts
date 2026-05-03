import assert from "node:assert/strict";
import { SystemdUnitConnector } from "../../src/connectors/selfhost/systemd_unit.ts";

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

Deno.test("SystemdUnitConnector.verify reports ok when systemctl --version exits 0", async () => {
  const { command, calls } = makeMockCommand([{ code: 0 }]);
  const connector = new SystemdUnitConnector({ command });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.match(`${res.note}`, /systemctl reachable/);
  assert.equal(calls[0].cmd, "systemctl");
  assert.equal(calls[0].args[0], "--version");
});

Deno.test("SystemdUnitConnector.verify reports network_error when systemctl fails", async () => {
  const { command } = makeMockCommand([
    { code: 127, stderr: "systemctl: command not found" },
  ]);
  const connector = new SystemdUnitConnector({ command });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "network_error");
});

Deno.test("SystemdUnitConnector.apply writes unit file and enables it via systemctl", async () => {
  const dir = await Deno.makeTempDir({ prefix: "systemd-" });
  try {
    const { command, calls } = makeMockCommand();
    const connector = new SystemdUnitConnector({ unitDir: dir, command });
    const res = await connector.apply({
      shape: "web-service@v1",
      provider: "systemd-unit",
      resourceName: "rs",
      spec: {
        image: "registry/app:1",
        port: 8080,
        env: { FOO: "bar" },
      },
    }, {});
    assert.equal(res.handle, "app.service");
    assert.equal(res.outputs.internalPort, 8080);
    assert.match(`${res.outputs.url}`, /^http:\/\/127\.0\.0\.1:\d+$/);
    const unitFile = await Deno.readTextFile(`${dir}/app.service`);
    assert.match(unitFile, /\[Unit\]/);
    assert.match(unitFile, /ExecStart=registry\/app:1/);
    assert.match(unitFile, /Environment=FOO=bar/);
    // first call: daemon-reload, second: enable --now
    assert.deepEqual(calls.map((c) => c.args[0]), ["daemon-reload", "enable"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
