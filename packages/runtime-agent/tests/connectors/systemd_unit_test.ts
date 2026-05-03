import assert from "node:assert/strict";
import { SystemdUnitConnector } from "../../src/connectors/selfhost/systemd_unit.ts";

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

Deno.test("SystemdUnitConnector.apply writes unit file with port markers and enables it via systemctl", async () => {
  const dir = await Deno.makeTempDir({ prefix: "systemd-" });
  try {
    const { command, calls } = makeMockCommand();
    const connector = new SystemdUnitConnector({ unitDir: dir, command });
    const res = await connector.apply({
      shape: "web-service@v1",
      provider: "@takos/selfhost-systemd",
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
    assert.match(unitFile, /^# X-Takos-HostPort=\d+$/m);
    assert.match(unitFile, /^# X-Takos-InternalPort=8080$/m);
    // first call: daemon-reload, second: enable --now
    assert.deepEqual(calls.map((c) => c.args[0]), ["daemon-reload", "enable"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SystemdUnitConnector.describe returns missing when unit file does not exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "systemd-" });
  try {
    const { command, calls } = makeMockCommand();
    const connector = new SystemdUnitConnector({ unitDir: dir, command });
    const res = await connector.describe({
      shape: "web-service@v1",
      provider: "@takos/selfhost-systemd",
      handle: "ghost.service",
    }, {});
    assert.equal(res.status, "missing");
    // systemctl should NOT have been called when unit file is absent
    assert.equal(calls.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SystemdUnitConnector.describe returns missing when systemctl is-active exits non-zero", async () => {
  const dir = await Deno.makeTempDir({ prefix: "systemd-" });
  try {
    const { command, calls } = makeMockCommand([
      { code: 0 }, // daemon-reload
      { code: 0 }, // enable --now
      { code: 3, stdout: "inactive" }, // is-active
    ]);
    const connector = new SystemdUnitConnector({ unitDir: dir, command });
    await connector.apply({
      shape: "web-service@v1",
      provider: "@takos/selfhost-systemd",
      resourceName: "rs",
      spec: { image: "registry/app:1", port: 8080 },
    }, {});
    const res = await connector.describe({
      shape: "web-service@v1",
      provider: "@takos/selfhost-systemd",
      handle: "app.service",
    }, {});
    assert.equal(res.status, "missing");
    assert.equal(calls[2].cmd, "systemctl");
    assert.equal(calls[2].args[0], "is-active");
    assert.equal(calls[2].args[1], "app.service");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SystemdUnitConnector.describe returns running with reconstructed outputs from on-disk unit file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "systemd-" });
  try {
    const { command, calls } = makeMockCommand([
      { code: 0 }, // daemon-reload
      { code: 0 }, // enable --now
      { code: 0, stdout: "active" }, // is-active
    ]);
    const connector = new SystemdUnitConnector({ unitDir: dir, command });
    const apply = await connector.apply({
      shape: "web-service@v1",
      provider: "@takos/selfhost-systemd",
      resourceName: "rs",
      spec: { image: "registry/app:1", port: 8080 },
    }, {});

    // Throw away the in-memory map by creating a fresh connector pointing at
    // the same unitDir (simulates runtime-agent restart).
    const { command: command2 } = makeMockCommand([
      { code: 0, stdout: "active" }, // is-active
    ]);
    const connector2 = new SystemdUnitConnector({
      unitDir: dir,
      command: command2,
    });
    const res = await connector2.describe({
      shape: "web-service@v1",
      provider: "@takos/selfhost-systemd",
      handle: apply.handle,
    }, {});
    assert.equal(res.status, "running");
    assert.equal(res.outputs?.internalPort, 8080);
    assert.match(`${res.outputs?.url}`, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(calls[2] ?? null, null); // unused by connector1
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SystemdUnitConnector.describe returns status only when port markers are absent (hand-written unit)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "systemd-" });
  try {
    // Write a unit file without port markers.
    await Deno.writeTextFile(
      `${dir}/handwritten.service`,
      "[Unit]\nDescription=hand\n[Service]\nExecStart=/bin/true\n",
    );
    const { command } = makeMockCommand([
      { code: 0, stdout: "active" }, // is-active
    ]);
    const connector = new SystemdUnitConnector({ unitDir: dir, command });
    const res = await connector.describe({
      shape: "web-service@v1",
      provider: "@takos/selfhost-systemd",
      handle: "handwritten.service",
    }, {});
    assert.equal(res.status, "running");
    assert.equal(res.outputs, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
