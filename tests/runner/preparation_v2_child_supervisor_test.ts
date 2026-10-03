import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { acquireRunRootOwnership, RunRootOwnershipBusyError } from "../../runner/lib/run_root_ownership.ts";
import {
  PreparationV2ChildSupervisor,
  PreparationV2ChildSupervisorBusyError,
  PreparationV2ChildSupervisorDrainTimeoutError,
  PreparationV2ChildSupervisorUnavailableError,
} from "../../runner/lib/preparation_v2_child_supervisor.ts";

const roots: Array<{ path: string; fixtureExitedSuccessfully: boolean }> = [];
const fixtures: Array<{
  child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  root: { path: string; fixtureExitedSuccessfully: boolean };
}> = [];
const CHILD_SCRIPT = import.meta.path;

if (process.argv[2] === "supervisor-fixture") {
  await runSupervisorFixture(process.argv[3] ?? "", process.argv[4] ?? "normal");
} else if (process.argv[2] === "existing-child-fixture") {
  await runExistingChildFixture(process.argv[3] ?? "");
}

if (process.argv[2] === undefined) {
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      const { child } = fixture;
      if (child.exitCode === null) child.kill("SIGKILL");
      fixture.root.fixtureExitedSuccessfully =
        (await child.exited.catch(() => null)) === 0;
    }
    for (const root of roots.splice(0)) {
      if (!root.fixtureExitedSuccessfully) {
        throw new Error("private child-supervisor fixture retained after uncertain cleanup");
      }
      await rm(root.path, { recursive: true, force: true });
    }
  });

test("a subreaper drains only its child tree before another Runner may start", async () => {
  const root = await createPrivateRoot();
  const child = spawnFixture("supervisor-fixture", root);
  const lines = lineReader(child.stdout);
  expect(await lines.next()).toBe("drain-pending");

  await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
    RunRootOwnershipBusyError,
  );
  expect(await lines.next()).toBe("runner-blocked");
  const runnerAPid = await readPid(root, "runner-a.pid");
  const writerPid = await readPid(root, "writer.pid");
  expect(runnerAPid).toBeGreaterThan(0);
  expect(writerPid).toBeGreaterThan(0);
  await expect(readFile(join(root, "second-started"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await lines.next()).toBe("drain-complete");
  expect(await readFile(join(root, "writer-count"), "utf8")).toBe("24");
  expect(await lines.next()).toBe("runner-b-started");
  expect(await readFile(join(root, "second-started"), "utf8")).toBe("yes");
  const runnerBPid = await readPid(root, "runner-b.pid");
  expect(new Set([runnerAPid, writerPid, runnerBPid]).size).toBe(3);
  expect(await child.exited).toBe(0);

  const owner = await acquireRunRootOwnership(root);
  await owner.close();
});

test("an unavailable or timed-out drain never releases root ownership", async () => {
  const root = await createPrivateRoot();
  const child = spawnFixture("supervisor-fixture", root, "hold-after-timeout");
  const lines = lineReader(child.stdout);
  expect(await lines.next()).toBe("drain-pending");
  await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
    RunRootOwnershipBusyError,
  );
  expect(await lines.next()).toBe("runner-blocked");
  expect(await lines.next()).toBe("drain-still-pending");
  await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
    RunRootOwnershipBusyError,
  );
  expect(await lines.next()).toBe("drain-complete");
  expect(await lines.next()).toBe("owner-released");
  expect(await child.exited).toBe(0);
  await expect(readFile(join(root, "second-started"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  const owner = await acquireRunRootOwnership(root);
  await owner.close();
});

test("the supervisor refuses initialization when its dedicated process has another child", async () => {
  const root = await createPrivateRoot();
  const child = spawnFixture("existing-child-fixture", root);
  const lines = lineReader(child.stdout);
  expect(await lines.next()).toBe("supervisor-refused-existing-child");
  expect(await child.exited).toBe(0);
});
}

async function runSupervisorFixture(
  root: string,
  mode = "normal",
): Promise<void> {
  let stage = "ownership";
  const owner = await acquireRunRootOwnership(root);
  let supervisor: PreparationV2ChildSupervisor | undefined;
  try {
    stage = "initialize";
    supervisor = new PreparationV2ChildSupervisor(root, owner);
    stage = "first-runner";
    let firstResult: PreparationV2ChildSupervisorDrainTimeoutError | undefined;
    try {
      await supervisor.runRunner(
        "/bin/sh",
        [
          "-c",
          'printf "%s" "$$" > "$2/runner-a.pid"; /usr/bin/setsid /bin/sh -c "$1" sh "$2" >/dev/null 2>&1 & kill -KILL $$',
          "runner",
          'printf "%s" "$$" > "$1/writer.pid"; i=0; while [ "$i" -lt 25 ]; do printf "%s" "$i" > "$1/writer-count"; i=$((i+1)); sleep 0.04; done',
          root,
        ],
        { env: { HOME: root, PATH: "/usr/bin:/bin" }, drainTimeoutMs: 30 },
      );
      throw new Error("Runner unexpectedly completed with a live writer");
    } catch (error) {
      if (!(error instanceof PreparationV2ChildSupervisorDrainTimeoutError)) {
        throw error;
      }
      firstResult = error;
    }
    if (
      !firstResult ||
      (firstResult.exitCode !== 137 && firstResult.signalCode !== "SIGKILL")
    ) throw new Error("Runner did not terminate by SIGKILL");
    stage = "runner-a-pending";
    process.stdout.write("drain-pending\n");
    try {
      await supervisor.runRunner(
        "/bin/sh",
        ["-c", 'printf yes > "$1/second-started"', "runner", root],
        { env: { HOME: root, PATH: "/usr/bin:/bin" }, drainTimeoutMs: 100 },
      );
      throw new Error("second Runner unexpectedly started");
    } catch (error) {
      if (!(error instanceof PreparationV2ChildSupervisorBusyError)) throw error;
    }
    stage = "runner-b-blocked";
    try {
      await supervisor.close();
      throw new Error("supervisor closed before child drain");
    } catch (error) {
      if (!(error instanceof PreparationV2ChildSupervisorBusyError)) throw error;
    }
    process.stdout.write("runner-blocked\n");
    if (mode === "hold-after-timeout") {
      const ownerClose = owner.close();
      try {
        await supervisor.runRunner(
          "/bin/sh",
          ["-c", 'printf yes > "$1/second-started"', "runner", root],
          { env: { HOME: root, PATH: "/usr/bin:/bin" }, drainTimeoutMs: 100 },
        );
        throw new Error("Runner started after owner close request");
      } catch (error) {
        if (!(error instanceof PreparationV2ChildSupervisorBusyError)) {
          throw error;
        }
      }
      const stillPending = await supervisor.drainAdoptedChildren({ timeoutMs: 30 });
      if (stillPending) throw new Error("unexpected early drain");
      process.stdout.write("drain-still-pending\n");
      const drained = await supervisor.drainAdoptedChildren({ timeoutMs: 2_000 });
      if (!drained) throw new Error("writer did not drain in the bound");
      process.stdout.write("drain-complete\n");
      await supervisor.close();
      supervisor = undefined;
      await ownerClose;
      process.stdout.write("owner-released\n");
      return;
    }
    stage = "child-drain";
    const drained = await supervisor.drainAdoptedChildren({ timeoutMs: 2_000 });
    if (!drained) throw new Error("writer did not drain in the bound");
    process.stdout.write("drain-complete\n");
    stage = "runner-b";
    const second = await supervisor.runRunner(
      "/bin/sh",
      ["-c", 'printf "%s" "$$" > "$1/runner-b.pid"; printf yes > "$1/second-started"', "runner", root],
      { env: { HOME: root, PATH: "/usr/bin:/bin" }, drainTimeoutMs: 1_000 },
    );
    if (second.exitCode !== 0 || !second.drained) throw new Error("second Runner failed");
    process.stdout.write("runner-b-started\n");
    await supervisor.close();
    supervisor = undefined;
    await owner.close();
  } catch {
    process.stdout.write(`fixture-error:${stage}\n`);
    process.exitCode = 1;
  }
}

async function runExistingChildFixture(root: string): Promise<void> {
  const owner = await acquireRunRootOwnership(root);
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(100)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { HOME: root, PATH: "/usr/bin:/bin" },
  });
  try {
    await Bun.sleep(20);
    expect(() => new PreparationV2ChildSupervisor(root, owner)).toThrow(
      PreparationV2ChildSupervisorUnavailableError,
    );
    process.stdout.write("supervisor-refused-existing-child\n");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await owner.close();
  }
}

async function createPrivateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tko-child-supervisor-"));
  await chmod(root, 0o700);
  roots.push({ path: root, fixtureExitedSuccessfully: false });
  return root;
}

async function readPid(root: string, filename: string): Promise<number> {
  return Number(await readFile(join(root, filename), "utf8"));
}

function spawnFixture(
  mode: string,
  root: string,
  extra?: string,
): Bun.Subprocess<"ignore", "pipe", "ignore"> {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", CHILD_SCRIPT, mode, root, ...(extra ? [extra] : [])],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { HOME: root, PATH: "/usr/bin:/bin" },
    },
  );
  const fixtureRoot = roots.find((candidate) => candidate.path === root);
  if (!fixtureRoot) throw new Error("private child-supervisor fixture root missing");
  fixtures.push({ child, root: fixtureRoot });
  return child;
}

function lineReader(stream: ReadableStream<Uint8Array>): { next(): Promise<string> } {
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
        if (result.done) {
          throw new Error(`fixture ended before expected status: ${buffered}`);
        }
        buffered += new TextDecoder().decode(result.value);
      }
    },
  };
}
