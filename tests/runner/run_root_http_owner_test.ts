import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRunnerRequestWithDependencies, startRunnerHttpServer } from "../../runner/entrypoint.ts";
import {
  adoptRunRootOwnershipFromStdin,
  acquireRunRootOwnership,
  assertRunRootOwnershipFor,
  RunRootOwnershipBusyError,
  RunRootOwnershipUnavailableError,
} from "../../runner/lib/run_root_ownership.ts";
import {
  PreparationV2ChildSupervisor,
  PreparationV2ChildSupervisorBusyError,
  PreparationV2ChildSupervisorDrainTimeoutError,
  PreparationV2ChildSupervisorUnavailableError,
} from "../../runner/lib/preparation_v2_child_supervisor.ts";

const childMode = Bun.argv[2];
const serverChild = childMode === "--owner-server" || childMode === "--v1-server";
const fixtureChild = childMode === "http-supervisor-fixture" ||
  childMode === "http-runner-child" || childMode === "http-rejected-handshake-fixture";
if (import.meta.main && childMode === "http-supervisor-fixture") {
  await runHttpSupervisorFixture(Bun.argv[3] ?? "", Number(Bun.argv[4]));
}
if (import.meta.main && childMode === "http-runner-child") {
  await runHttpRunnerChild(Bun.argv[3] ?? "", Number(Bun.argv[4]), Bun.argv[5] ?? "");
}
if (import.meta.main && childMode === "http-rejected-handshake-fixture") {
  await runRejectedHandshakeFixture(Bun.argv[3] ?? "");
}
if (import.meta.main && serverChild) {
  try {
    const running = await startRunnerHttpServer({
      hostname: "127.0.0.1", port: 0, localPreparationV2: childMode === "--owner-server",
    });
    process.stdout.write(`ready:${running.server.port}\n`);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (value: string) => {
      if (value !== "close\n") return;
      void running.close().then(
        () => process.stdout.write("closed\n"),
        () => { process.stderr.write("runner close failed\n"); process.exitCode = 1; },
      );
    });
  } catch (error) {
    if (error instanceof RunRootOwnershipBusyError) {
      process.stdout.write("busy\n");
    } else {
      process.stdout.write("unavailable\n");
      process.exitCode = 1;
    }
  }
}

if (!serverChild && !fixtureChild) test.skipIf(process.platform !== "linux")(
  "private v2 HTTP runner owns one root, drains a pending restore, then releases it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takosumi-root-http-"));
    await chmod(root, 0o700);
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    const spawn = () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--owner-server"], {
        stdin: "pipe", stdout: "pipe", stderr: "ignore",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          TAKOSUMI_OPENTOFU_RUN_ROOT: root,
          TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
        },
      });
      children.push(child);
      return child;
    };
    try {
      const first = spawn();
      const firstLine = await readLine(first.stdout);
      expect(firstLine).toMatch(/^ready:\d+$/);
      const port = Number(firstLine.slice("ready:".length));
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/healthz`);
      expect((await health.json()).capabilities).toContain("takosumi.local-mutation-preparation@v2");

      const runId = "root_owner_success";
      const attemptId = crypto.randomUUID();
      const prepared = await fetch(`${base}/runs/${runId}/mutation-preparation`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, action: "apply", attemptId, request: { applyRun: { id: runId } } }),
      });
      expect(prepared.status).toBe(201);
      const { epoch } = await prepared.json() as { epoch: number };
      expect(epoch).toBe(1);

      // Send an incomplete chunked body so the actual artifact PUT remains in flight.
      const socket = createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      socket.write(`PUT /runs/${runId}/artifacts/tfplan HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nx-takosumi-preparation-attempt: ${attemptId}\r\nx-takosumi-preparation-epoch: ${epoch}\r\nConnection: close\r\n\r\n4\r\nplan\r\n`);
      const response = new Promise<string>((resolve, reject) => {
        let bytes = "";
        socket.on("data", (chunk) => { bytes += chunk.toString(); });
        socket.once("end", () => resolve(bytes));
        socket.once("error", reject);
      });

      const second = spawn();
      expect(await readLine(second.stdout)).toBe("busy");
      expect(await second.exited).toBe(0);
      first.stdin.write("close\n");
      // Closing must not drop this request or release the root while it is pending.
      const third = spawn();
      expect(await readLine(third.stdout)).toBe("busy");
      expect(await third.exited).toBe(0);
      socket.write("0\r\n\r\n");
      expect(await response).toContain("200 OK");
      expect(await readLine(first.stdout)).toBe("closed");
      first.stdin.end();
      expect(await first.exited).toBe(0);

      const successor = spawn();
      expect(await readLine(successor.stdout)).toMatch(/^ready:\d+$/);
      successor.stdin.write("close\n");
      expect(await readLine(successor.stdout)).toBe("closed");
      successor.stdin.end();
      expect(await successor.exited).toBe(0);
    } finally {
      for (const child of children) {
        if (typeof child.stdin === "object" && child.stdin !== null) {
          child.stdin.end();
        }
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => child.exited));
      await rm(root, { recursive: true, force: true });
    }
  },
);

if (!serverChild && !fixtureChild) test(
  "default local HTTP v1 boots without a private run root or flock setup",
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "takosumi-v1-no-owner-"));
    const root = join(parent, "missing-parent", "runs");
    const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--v1-server"], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: parent,
        TAKOSUMI_OPENTOFU_RUN_ROOT: root,
        TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
      },
    });
    try {
      const ready = await readLine(child.stdout);
      expect(ready).toMatch(/^ready:\d+$/);
      const base = `http://127.0.0.1:${Number(ready.slice("ready:".length))}`;
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const status = await health.json() as { mutationCustodyMode: string; capabilities: string[] };
      expect(status.mutationCustodyMode).toBe("local-http");
      expect(status.capabilities).not.toContain("takosumi.local-mutation-preparation@v2");
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      child.stdin.write("close\n");
      expect(await readLine(child.stdout)).toBe("closed");
      child.stdin.end();
      expect(await child.exited).toBe(0);
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await rm(parent, { recursive: true, force: true });
    }
  },
);

if (!serverChild && !fixtureChild) test.skipIf(process.platform !== "linux")(
  "private v2 HTTP runner refuses writes after root or lock permissions drift",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takosumi-root-mode-drift-"));
    await chmod(root, 0o700);
    const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--owner-server"], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        TAKOSUMI_OPENTOFU_RUN_ROOT: root,
        TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
      },
    });
    const lock = join(root, ".takosumi-run-root.lock");
    try {
      const ready = await readLine(child.stdout);
      expect(ready).toMatch(/^ready:\d+$/);
      const base = `http://127.0.0.1:${Number(ready.slice("ready:".length))}`;
      const artifact = `${base}/runs/root_mode_drift/artifacts/tfplan`;
      await chmod(root, 0o777);
      expect((await fetch(artifact, { method: "PUT", body: "must not write" })).status).toBe(503);
      await chmod(root, 0o700);
      expect((await fetch(artifact)).status).toBe(404);
      await chmod(lock, 0o666);
      expect((await fetch(artifact, { method: "PUT", body: "must not write" })).status).toBe(503);
      await chmod(lock, 0o600);
      expect((await fetch(artifact)).status).toBe(404);
      child.stdin.write("close\n");
      expect(await readLine(child.stdout)).toBe("closed");
      child.stdin.end();
      expect(await child.exited).toBe(0);
    } finally {
      await chmod(root, 0o700);
      await chmod(lock, 0o600).catch(() => {});
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

if (!serverChild && !fixtureChild) test.skipIf(process.platform !== "linux")(
  "a root owner cannot authorize a different root or a replacement lock inode",
  async () => {
    const first = await mkdtemp(join(tmpdir(), "takosumi-root-bound-first-"));
    const second = await mkdtemp(join(tmpdir(), "takosumi-root-bound-second-"));
    await chmod(first, 0o700);
    await chmod(second, 0o700);
    const moved = `${first}-moved`;
    let owner: Awaited<ReturnType<typeof acquireRunRootOwnership>> | undefined;
    try {
      owner = await acquireRunRootOwnership(first);
      expect(() => assertRunRootOwnershipFor(owner!, second)).toThrow(RunRootOwnershipUnavailableError);
      const wrongRoot = await handleRunnerRequestWithDependencies(
        new Request("http://runner/runs/wrong_root/artifacts/tfplan", {
          method: "PUT", body: "must not write",
        }),
        { mutationCustodyMode: "local-http", localPreparationV2: true, runRootOwnership: owner },
      );
      expect(wrongRoot.status).toBe(503);
      await rename(first, moved);
      await mkdir(first, { mode: 0o700 });
      expect(() => assertRunRootOwnershipFor(owner!, first)).toThrow(RunRootOwnershipUnavailableError);
      await rm(first, { recursive: true });
      await rename(moved, first);
      assertRunRootOwnershipFor(owner, first);
      await rm(join(first, ".takosumi-run-root.lock"));
      await writeFile(join(first, ".takosumi-run-root.lock"), "", { mode: 0o600 });
      expect(() => assertRunRootOwnershipFor(owner!, first)).toThrow(RunRootOwnershipUnavailableError);
    } finally {
      await owner?.close();
      await rm(first, { recursive: true, force: true });
      await rm(moved, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  },
);

if (!serverChild && !fixtureChild) test(
  "private v2 handler refuses to advertise readiness without a root owner",
  async () => {
    const health = await handleRunnerRequestWithDependencies(
      new Request("http://runner/healthz"),
      { mutationCustodyMode: "local-http", localPreparationV2: true },
    );
    expect(health.status).toBe(503);
    expect((await health.json()).errorCode).toBe("runner_run_root_ownership_unavailable");
  },
);

interface LineState {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}
const lineReaders = new WeakMap<ReadableStream<Uint8Array>, LineState>();
async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  let state = lineReaders.get(stream);
  if (!state) {
    state = { reader: stream.getReader(), buffer: "" };
    lineReaders.set(stream, state);
  }
  while (!state.buffer.includes("\n")) {
    const result = await state.reader.read();
    if (result.done) throw new Error("child closed before status line");
    state.buffer += new TextDecoder().decode(result.value);
    if (state.buffer.length > 128) throw new Error("child status line exceeded limit");
  }
  const end = state.buffer.indexOf("\n");
  const line = state.buffer.slice(0, end);
  state.buffer = state.buffer.slice(end + 1);
  return line;
}

if (!serverChild && !fixtureChild) test.skipIf(
  process.platform !== "linux" ||
    (process.arch !== "x64" && process.arch !== "arm64"),
)("HTTP Runner A is drained before Runner B adopts the same root lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-root-http-supervisor-"));
  await chmod(root, 0o700);
  const port = await reservePort();
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", import.meta.path, "http-supervisor-fixture", root, String(port)],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { HOME: root, PATH: "/usr/bin:/bin" } },
  );
  const lines = readLines(child.stdout);
  let fixtureSucceeded = false;
  try {
    expect(await lines.next()).toBe("a-ready");
    const base = `http://127.0.0.1:${port}`;
    const healthA = await fetch(`${base}/healthz`);
    expect(healthA.status).toBe(200);
    expect((await healthA.json()).capabilities).toContain(
      "takosumi.local-mutation-preparation@v2",
    );
    expect(await readFile(join(root, "writer-started"), "utf8")).toBe("yes");

    await writeFile(join(root, "kill-a-request"), "yes", { mode: 0o600 });
    expect(await lines.next()).toBe("a-draining");
    expect(await lines.next()).toBe("b-blocked");
    await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
      RunRootOwnershipBusyError,
    );
    await expect(lstat(join(root, "http-b-started"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(join(root, "release-writer"), "yes", { mode: 0o600 });
    expect(await lines.next()).toBe("writer-tree-drained");
    expect(await readFile(join(root, "writer-finished"), "utf8")).toBe("yes");
    expect(await lines.next()).toBe("b-ready");
    expect(await readFile(join(root, "http-b-started"), "utf8")).toBe("yes");
    const healthB = await fetch(`${base}/healthz`);
    expect(healthB.status).toBe(200);
    expect((await healthB.json()).capabilities).toContain(
      "takosumi.local-mutation-preparation@v2",
    );

    await writeFile(join(root, "stop-b-request"), "yes", { mode: 0o600 });
    expect(await lines.next()).toBe("b-drained");
    expect(await lines.next()).toBe("fixture-complete");
    expect(await child.exited).toBe(0);
    const owner = await acquireRunRootOwnership(root);
    await owner.close();
    fixtureSucceeded = true;
  } finally {
    if (child.exitCode === null) {
      await writeFile(join(root, "release-writer"), "yes", { mode: 0o600 }).catch(() => {});
      await writeFile(join(root, "kill-a-request"), "yes", { mode: 0o600 }).catch(() => {});
      await writeFile(join(root, "stop-b-request"), "yes", { mode: 0o600 }).catch(() => {});
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await child.exited.catch(() => null);
    if (fixtureSucceeded) await rm(root, { recursive: true, force: true });
  }
}, 20_000);

if (!serverChild && !fixtureChild) test.skipIf(
  process.platform !== "linux" ||
    (process.arch !== "x64" && process.arch !== "arm64"),
)("a busy private entrypoint exits so a later process can acquire the released root", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-entrypoint-"));
  await chmod(root, 0o700);
  const port = await reservePort();
  const competingPort = await reservePort();
  const entrypoint = join(import.meta.dir, "../../runner/entrypoint.ts");
  const spawnSupervisor = (listenPort: number) => Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      entrypoint,
      "--local-preparation-v2-supervisor",
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        HOME: root,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        PORT: String(listenPort),
        TAKOSUMI_OPENTOFU_RUN_ROOT: root,
        TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
      },
    },
  );
  const first = spawnSupervisor(port);
  let competing: ReturnType<typeof spawnSupervisor> | undefined;
  let successor: ReturnType<typeof spawnSupervisor> | undefined;
  let fixtureSucceeded = false;
  try {
    await waitForHealth(port);
    competing = spawnSupervisor(competingPort);
    const competingExited = await Promise.race([
      competing.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    expect(competingExited).toBe(true);
    expect(competing.exitCode).toBe(1);
    await expect(
      fetch(`http://127.0.0.1:${competingPort}/healthz`, {
        signal: AbortSignal.timeout(250),
      }),
    ).rejects.toThrow();

    first.kill("SIGTERM");
    expect(await first.exited).toBe(0);
    fixtureSucceeded = true;
    await expect(
      fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(250) }),
    ).rejects.toThrow();
    const owner = await acquireRunRootOwnership(root);
    await owner.close();
    successor = spawnSupervisor(competingPort);
    await waitForHealth(competingPort);
    successor.kill("SIGTERM");
    expect(await successor.exited).toBe(0);
  } finally {
    if (first.exitCode === null) first.kill("SIGTERM");
    await first.exited.catch(() => null);
    for (const child of [competing, successor]) {
      if (child?.exitCode === null) child.kill("SIGKILL");
    }
    await Promise.all([competing, successor].map((child) => child?.exited.catch(() => null)));
    if (fixtureSucceeded) {
      await rm(root, { recursive: true, force: true });
    } else {
      const cleanupOwner = await acquireRunRootOwnership(root).catch(() => undefined);
      if (cleanupOwner) {
        await cleanupOwner.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

if (!serverChild && !fixtureChild) test("entrypoint rejects unknown private startup arguments", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", join(import.meta.dir, "../../runner/entrypoint.ts"), "--unknown-private-mode"],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", TAKOSUMI_RUNNER_START_SERVER: "0" },
    },
  );
  expect(await child.exited).toBe(1);
});

if (!serverChild && !fixtureChild) test("no-argument entrypoint retains local HTTP v1 startup behavior", async () => {
  const parent = await mkdtemp(join(tmpdir(), "takosumi-entrypoint-v1-"));
  const root = join(parent, "missing", "runs");
  const port = await reservePort();
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", join(import.meta.dir, "../../runner/entrypoint.ts")],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        HOME: parent,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        PORT: String(port),
        TAKOSUMI_OPENTOFU_RUN_ROOT: root,
        TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
        TAKOSUMI_RUNNER_START_SERVER: "1",
      },
    },
  );
  let completed = false;
  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const health = await response.json() as { capabilities: string[] };
    expect(health.capabilities).not.toContain("takosumi.local-mutation-preparation@v2");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    completed = true;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited.catch(() => null);
    if (completed) await rm(parent, { recursive: true, force: true });
  }
});

if (!serverChild && !fixtureChild) test.skipIf(
  process.platform !== "linux" ||
    (process.arch !== "x64" && process.arch !== "arm64"),
)("a rejected child handshake keeps the parent root lease until its process exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-rejected-child-handoff-"));
  await chmod(root, 0o700);
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", import.meta.path, "http-rejected-handshake-fixture", root],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { HOME: root, PATH: "/usr/bin:/bin" } },
  );
  const lines = readLines(child.stdout);
  let complete = false;
  try {
    expect(await lines.next()).toBe("handshake-refused-held");
    await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
      RunRootOwnershipBusyError,
    );
    await writeFile(join(root, "release-parent"), "yes", { mode: 0o600 });
    expect(await lines.next()).toBe("fixture-exiting");
    expect(await child.exited).toBe(0);
    const owner = await acquireRunRootOwnership(root);
    await owner.close();
    complete = true;
  } finally {
    if (child.exitCode === null) {
      await writeFile(join(root, "release-parent"), "yes", { mode: 0o600 }).catch(() => {});
      await Promise.race([child.exited, Bun.sleep(2_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await child.exited.catch(() => null);
    if (complete) await rm(root, { recursive: true, force: true });
  }
}, 10_000);

async function runHttpSupervisorFixture(root: string, port: number): Promise<void> {
  let owner: Awaited<ReturnType<typeof acquireRunRootOwnership>> | undefined;
  let supervisor: PreparationV2ChildSupervisor | undefined;
  let stage = "owner";
  try {
    owner = await acquireRunRootOwnership(root);
    supervisor = new PreparationV2ChildSupervisor(root, owner);
    const childArgs = (label: string) => [
      "--no-env-file", import.meta.path, "http-runner-child", root, String(port), label,
    ];
    const env = runnerChildEnv(root, port);
    stage = "runner-a";
    const first = supervisor.runRunnerUntilDrained(process.execPath, childArgs("a"), {
      env,
      drainTimeoutMs: 100,
      retryIntervalMs: 20,
    });
    await waitForHealth(port);
    await waitForFile(root, "writer-started");
    process.stdout.write("a-ready\n");
    await waitForFile(root, "kill-a-request");
    stage = "terminate-runner-a";
    if (!supervisor.signalRunner("SIGKILL")) throw new Error();
    stage = "confirm-drain-retry";
    await Bun.sleep(150);
    const writerCountBefore = await readFile(join(root, "writer-count"), "utf8");
    await Bun.sleep(60);
    const writerCountAfter = await readFile(join(root, "writer-count"), "utf8");
    expect(writerCountAfter).not.toBe(writerCountBefore);
    const runnerStillWaiting = await Promise.race([
      first.then(() => false, () => false),
      Bun.sleep(0).then(() => true),
    ]);
    expect(runnerStillWaiting).toBe(true);
    process.stdout.write("a-draining\n");

    stage = "runner-b-refused";
    try {
      await supervisor.runRunner(process.execPath, childArgs("b"), {
        env,
        drainTimeoutMs: 100,
      });
      throw new Error();
    } catch (error) {
      if (!(error instanceof PreparationV2ChildSupervisorBusyError)) throw error;
    }
    process.stdout.write("b-blocked\n");
    stage = "writer-release";
    await waitForFile(root, "release-writer");
    stage = "finish-drain-await";
    const completed = await first;
    stage = "finish-drain-result-check";
    if (completed.signalCode !== "SIGKILL" || !completed.drained) {
      throw new Error();
    }
    process.stdout.write("writer-tree-drained\n");

    stage = "runner-b-start";
    const second = supervisor.runRunner(process.execPath, childArgs("b"), {
      env,
      drainTimeoutMs: 5_000,
    });
    await waitForHealth(port);
    process.stdout.write("b-ready\n");
    await waitForFile(root, "stop-b-request");
    if (!supervisor.signalRunner("SIGTERM")) throw new Error();
    const result = await second;
    if (result.exitCode !== 0 || result.signalCode !== null || !result.drained) throw new Error();
    process.stdout.write("b-drained\n");
    await supervisor.close();
    supervisor = undefined;
    await owner.close();
    owner = undefined;
    process.stdout.write("fixture-complete\n");
  } catch (error) {
    const failurePhase = error instanceof PreparationV2ChildSupervisorUnavailableError
      ? "unavailable"
      : error instanceof PreparationV2ChildSupervisorBusyError
          ? "busy"
        : error instanceof PreparationV2ChildSupervisorDrainTimeoutError
          ? "timeout"
          : error instanceof TypeError
            ? "type"
            : error instanceof RangeError
              ? "range"
              : "unexpected";
    process.stdout.write(`fixture-failed:${stage}:${failurePhase}\n`);
    process.exitCode = 1;
    if (supervisor && owner) {
      try {
        if (await supervisor.drainAdoptedChildren({ timeoutMs: 5_000 })) {
          await supervisor.close();
          supervisor = undefined;
          await owner.close();
          owner = undefined;
        }
      } catch {
        // Unknown child custody deliberately retains the process and lease.
      }
    }
    if (supervisor || owner) await new Promise<void>(() => {});
  }
}

async function runHttpRunnerChild(root: string, port: number, label: string): Promise<void> {
  let owner: Awaited<ReturnType<typeof acquireRunRootOwnership>> | undefined;
  try {
    owner = await adoptRunRootOwnershipFromStdin(root);
    const running = await startRunnerHttpServer({
      hostname: "127.0.0.1",
      port,
      localPreparationV2: true,
      runRootOwnership: owner,
    });
    owner = undefined;
    if (label === "a") spawnDetachedWriter(root);
    if (label === "b") await writeFile(join(root, "http-b-started"), "yes", { mode: 0o600 });
    process.on("SIGTERM", () => {
      void running.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    await new Promise<void>(() => {});
  } catch {
    await owner?.close().catch(() => {});
    process.exitCode = 1;
  }
}

async function runRejectedHandshakeFixture(root: string): Promise<void> {
  const owner = await acquireRunRootOwnership(root);
  const supervisor = new PreparationV2ChildSupervisor(root, owner);
  try {
    await expectRejectedEntrypoint(supervisor, root);
    try {
      await supervisor.runRunner("/bin/true", [], {
        env: { HOME: root, PATH: "/usr/bin:/bin" },
        drainTimeoutMs: 100,
      });
      throw new Error("Runner started after rejected child handshake");
    } catch (error) {
      if (!(error instanceof PreparationV2ChildSupervisorUnavailableError)) throw error;
    }
    try {
      await supervisor.close();
      throw new Error("supervisor closed without a proven ECHILD transition");
    } catch (error) {
      if (!(error instanceof PreparationV2ChildSupervisorBusyError)) throw error;
    }
    process.stdout.write("handshake-refused-held\n");
    await waitForFile(root, "release-parent");
    process.stdout.write("fixture-exiting\n");
    process.exit(0);
  } catch {
    process.stdout.write("rejected-handshake-fixture-failed\n");
    process.exitCode = 1;
  }
}

async function expectRejectedEntrypoint(
  supervisor: PreparationV2ChildSupervisor,
  root: string,
): Promise<void> {
  try {
    await supervisor.runRunner(
      process.execPath,
      ["--no-env-file", join(import.meta.dir, "../../runner/entrypoint.ts"), "--unknown-private-mode"],
      {
        env: {
          HOME: root,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TAKOSUMI_OPENTOFU_RUN_ROOT: root,
          TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
        },
        drainTimeoutMs: 100,
      },
    );
    throw new Error("invalid private entrypoint unexpectedly completed with owner handoff");
  } catch (error) {
    if (!(error instanceof PreparationV2ChildSupervisorUnavailableError)) throw error;
  }
}

function spawnDetachedWriter(root: string): void {
  const script = 'printf yes > "$1/writer-started"; i=0; while [ ! -e "$1/release-writer" ] && [ "$i" -lt 500 ]; do printf "%s" "$i" > "$1/writer-count"; i=$((i+1)); sleep 0.02; done; printf yes > "$1/writer-finished"';
  Bun.spawn(["/usr/bin/setsid", "/bin/sh", "-c", script, "writer", root], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { HOME: root, PATH: "/usr/bin:/bin" },
  });
}

function runnerChildEnv(root: string, port: number): Record<string, string> {
  return {
    HOME: root,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PORT: String(port),
    TAKOSUMI_OPENTOFU_RUN_ROOT: root,
    TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
  };
}

async function reservePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const selected = server.port;
  await server.stop();
  if (selected === undefined) throw new Error("Bun did not assign a local test port");
  return selected;
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.status === 200) return;
    } catch {
      // The Runner binds after completing its root-owner handshake.
    }
    await Bun.sleep(10);
  }
  throw new Error("HTTP Runner health did not become ready within the bound");
}

async function waitForFile(root: string, name: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    try {
      await lstat(join(root, name));
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await Bun.sleep(10);
  }
  throw new Error("private Runner fixture marker did not arrive within the bound");
}

function readLines(stream: ReadableStream<Uint8Array>): { next(): Promise<string> } {
  const reader = stream.getReader();
  let buffered = "";
  return {
    async next() {
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return line;
        }
        const result = await reader.read();
        if (result.done) throw new Error(`HTTP supervisor ended unexpectedly: ${buffered}`);
        buffered += new TextDecoder().decode(result.value);
        if (buffered.length > 256) throw new Error("HTTP supervisor status exceeded bound");
      }
    },
  };
}
