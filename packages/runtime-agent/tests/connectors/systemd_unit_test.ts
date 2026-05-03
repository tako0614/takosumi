import assert from "node:assert/strict";
import { SystemdUnitConnector } from "../../src/connectors/selfhost/systemd_unit.ts";

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
