import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRunnerRequestWithDependencies, startRunnerHttpServer } from "../../runner/entrypoint.ts";
import {
  acquireRunRootOwnership,
  assertRunRootOwnershipFor,
  RunRootOwnershipBusyError,
  RunRootOwnershipUnavailableError,
} from "../../runner/lib/run_root_ownership.ts";

const childMode = Bun.argv[2];
const serverChild = childMode === "--owner-server" || childMode === "--v1-server";
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

if (!serverChild) test.skipIf(process.platform !== "linux")(
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
        child.stdin.end();
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => child.exited));
      await rm(root, { recursive: true, force: true });
    }
  },
);

if (!serverChild) test(
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

if (!serverChild) test.skipIf(process.platform !== "linux")(
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

if (!serverChild) test.skipIf(process.platform !== "linux")(
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

if (!serverChild) test(
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
