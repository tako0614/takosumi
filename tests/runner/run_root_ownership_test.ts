import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireRunRootOwnership,
  RunRootOwnershipUnavailableError,
  withRunRootWriter,
} from "../../runner/lib/run_root_ownership.ts";

const HOLDER_MODE = "hold";
const PROBE_MODE = "probe";
const CHILD_SCRIPT = join(import.meta.dir, "run_root_ownership_child.ts");
const CHILD_READ_TIMEOUT_MS = 1_000;
type OwnerChild = Bun.Subprocess<"pipe", "pipe", "ignore">;
const lineReaders = new WeakMap<ReadableStream<Uint8Array>, BoundedLineReader>();

test("line reader preserves a second line coalesced into one chunk", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first\nsecond\n"));
      controller.close();
    },
  });
  expect(await readFirstLine(stream)).toBe("first");
  expect(await readFirstLine(stream)).toBe("second");
});

test.skipIf(process.platform !== "linux")(
  "two Bun processes cannot own one run root at once",
  async () => {
    const root = await createPrivateRoot();
    const children: OwnerChild[] = [];
    try {
      const first = spawnOwner(HOLDER_MODE, root);
      children.push(first);
      expect(await readFirstLine(first.stdout)).toBe("held");
      expect(await readProcessChildren(first.pid)).toEqual([]);

      const second = spawnOwner(PROBE_MODE, root);
      children.push(second);
      expect(await readFirstLine(second.stdout)).toBe("busy");
      expect(await second.exited).toBe(0);

      first.stdin.end();
      expect(await first.exited).toBe(0);

      const next = spawnOwner(HOLDER_MODE, root);
      children.push(next);
      expect(await readFirstLine(next.stdout)).toBe("held");
      next.stdin.end();
      expect(await next.exited).toBe(0);
    } finally {
      for (const child of children) child.stdin.end();
      const exitCodes = await Promise.all(children.map((child) => child.exited));
      if (exitCodes.every((code) => code === 0)) {
        await removePrivateRootWhenUnlocked(root);
      }
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "an unrelated live child does not retain the owner's lock descriptor",
  async () => {
    const root = await createPrivateRoot();
    const holder = spawnOwner("hold-with-unrelated-child", root);
    let contender: OwnerChild | undefined;
    try {
      expect(await readFirstLine(holder.stdout)).toBe("held");
      holder.stdin.write("c");
      expect(await readFirstLine(holder.stdout)).toBe("closed");

      contender = spawnOwner(PROBE_MODE, root);
      expect(await readFirstLine(contender.stdout)).toBe("acquired");
      expect(await contender.exited).toBe(0);
      contender = undefined;

      holder.stdin.write("q");
      holder.stdin.end();
      expect(await readFirstLine(holder.stdout)).toBe("released");
      expect(await readFirstLine(holder.stdout)).toBe("terminated");
      expect(await holder.exited).toBe(0);
    } finally {
      holder.stdin.end();
      contender?.stdin.end();
      await Promise.all([holder.exited, contender?.exited]);
      await removePrivateRootWhenUnlocked(root);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a child-free owner process death releases its kernel lease",
  async () => {
    const root = await createPrivateRoot();
    const ownerProcess = spawnOwner(HOLDER_MODE, root);
    let contender: OwnerChild | undefined;
    try {
      expect(await readFirstLine(ownerProcess.stdout)).toBe("held");
      expect(await readProcessChildren(ownerProcess.pid)).toEqual([]);
      ownerProcess.kill("SIGKILL");
      await ownerProcess.exited;

      contender = spawnOwner(PROBE_MODE, root);
      expect(await readFirstLine(contender.stdout)).toBe("acquired");
      expect(await contender.exited).toBe(0);
      contender = undefined;
    } finally {
      ownerProcess.stdin.end();
      contender?.stdin.end();
      await Promise.all([ownerProcess.exited, contender?.exited]);
      await removePrivateRootWhenUnlocked(root);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "ownership refuses a run root without private directory permissions",
  async () => {
    const root = await createPrivateRoot();
    try {
      await chmod(root, 0o755);
      await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
        RunRootOwnershipUnavailableError,
      );
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "closing root ownership drains writers before releasing the kernel lock",
  async () => {
    const root = await createPrivateRoot();
    let ownerForCleanup:
      | Awaited<ReturnType<typeof acquireRunRootOwnership>>
      | undefined;
    let contender: OwnerChild | undefined;
    let finishWriter: (() => void) | undefined;
    let writer: Promise<void> | undefined;
    try {
      const owner = await acquireRunRootOwnership(root);
      ownerForCleanup = owner;
      let writerStarted = false;
      const writerFinished = new Promise<void>((resolve) => {
        finishWriter = resolve;
      });
      writer = withRunRootWriter(owner, async () => {
        writerStarted = true;
        await writerFinished;
      });
      await waitFor(() => writerStarted);

      const closing = owner.close();
      await expect(
        withRunRootWriter(owner, async () => "must not start"),
      ).rejects.toBeInstanceOf(RunRootOwnershipUnavailableError);

      contender = spawnOwner(PROBE_MODE, root);
      expect(await readFirstLine(contender.stdout)).toBe("busy");
      expect(await contender.exited).toBe(0);

      if (!finishWriter) throw new Error("writer fixture did not start");
      finishWriter();
      await writer;
      await closing;
      ownerForCleanup = undefined;
      await expect(
        withRunRootWriter(owner, async () => "stale owner"),
      ).rejects.toBeInstanceOf(RunRootOwnershipUnavailableError);

      ownerForCleanup = await acquireRunRootOwnership(root);
      const nextOwner = ownerForCleanup;
      await nextOwner.close();
      ownerForCleanup = undefined;
    } finally {
      finishWriter?.();
      await writer?.catch(() => {});
      contender?.stdin.end();
      await contender?.exited;
      await ownerForCleanup?.close().catch(() => {});
      await removePrivateRootWhenUnlocked(root);
    }
  },
);

function spawnOwner(mode: string, root: string): OwnerChild {
  return Bun.spawn(
    [process.execPath, "--no-env-file", CHILD_SCRIPT, mode, root],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { HOME: root, PATH: "/usr/bin:/bin" },
    },
  );
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  let reader = lineReaders.get(stream);
  if (!reader) {
    reader = new BoundedLineReader(stream);
    lineReaders.set(stream, reader);
  }
  return reader.readLine();
}

class BoundedLineReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readLine(): Promise<string> {
    const deadline = Date.now() + CHILD_READ_TIMEOUT_MS;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      if (this.buffer.length >= 128) {
        await this.cancel();
        throw new Error("owned child status line exceeded its bound");
      }
      if (this.ended) {
        await this.cancel();
        throw new Error("owned child exited before a bounded status line");
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.cancel();
        throw new Error("owned child status read timed out");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        this.reader.read(),
        new Promise<undefined>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(undefined), remaining);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (next === undefined) {
        await this.cancel();
        throw new Error("owned child status read timed out");
      }
      if (next.done) {
        this.ended = true;
        this.buffer += this.decoder.decode();
      } else {
        this.buffer += this.decoder.decode(next.value, { stream: true });
      }
    }
  }

  private async cancel(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // Cancellation is best effort; always release the stream reader lock.
    } finally {
      this.reader.releaseLock();
      this.ended = true;
    }
  }
}

async function createPrivateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-run-owner-"));
  await chmod(root, 0o700);
  return root;
}

async function readProcessChildren(pid: number): Promise<number[]> {
  const children = await readFile(
    `/proc/${pid}/task/${pid}/children`,
    "utf8",
  );
  return children.trim().length === 0
    ? []
    : children.trim().split(/\s+/).map(Number);
}

async function removePrivateRootWhenUnlocked(root: string): Promise<void> {
  try {
    const owner = await acquireRunRootOwnership(root);
    await owner.close();
    await rm(root, { recursive: true, force: true });
  } catch {
    // Preserve the private fixture rather than unlink a root with uncertain custody.
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("bounded fixture condition timed out");
    }
    await Bun.sleep(5);
  }
}
