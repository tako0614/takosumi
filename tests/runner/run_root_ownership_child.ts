import {
  acquireRunRootOwnership,
  RunRootOwnershipBusyError,
  RunRootOwnershipUnavailableError,
  withRunRootWriter,
} from "../../runner/lib/run_root_ownership.ts";

const mode = process.argv[2];
const root = process.argv[3] ?? "";

if (mode === "hold") {
  await holdRoot(root);
} else if (mode === "hold-with-unrelated-child") {
  await holdRootWithUnrelatedChild(root);
} else if (mode === "probe") {
  await probeRoot(root);
} else if (mode === "unrelated") {
  process.stdout.write("unrelated\n");
  await waitForInputEnd();
} else {
  process.exitCode = 2;
}

async function holdRoot(runRoot: string): Promise<void> {
  try {
    const owner = await acquireRunRootOwnership(runRoot);
    process.stdout.write("held\n");
    await new Promise<void>((resolve) => {
      process.stdin.once("end", resolve);
      process.stdin.resume();
    });
    await owner.close();
    try {
      await withRunRootWriter(owner, async () => undefined);
      process.exitCode = 1;
    } catch (error) {
      process.exitCode = error instanceof RunRootOwnershipUnavailableError
        ? 0
        : 1;
    }
  } catch {
    process.stdout.write("unavailable\n");
    process.exitCode = 1;
  }
}

async function probeRoot(runRoot: string): Promise<void> {
  try {
    const owner = await acquireRunRootOwnership(runRoot);
    process.stdout.write("acquired\n");
    await owner.close();
  } catch (error) {
    if (error instanceof RunRootOwnershipBusyError) {
      process.stdout.write("busy\n");
      return;
    }
    process.stdout.write("unavailable\n");
    process.exitCode = 1;
  }
}

async function holdRootWithUnrelatedChild(runRoot: string): Promise<void> {
  let owner: Awaited<ReturnType<typeof acquireRunRootOwnership>> | undefined;
  let unrelated: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  try {
    owner = await acquireRunRootOwnership(runRoot);
    unrelated = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        process.argv[1] ?? "",
        "unrelated",
        runRoot,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { HOME: runRoot, PATH: "/usr/bin:/bin" },
      },
    );
    const readyReader = unrelated.stdout.getReader();
    const ready = await readyReader.read();
    readyReader.releaseLock();
    if (new TextDecoder().decode(ready.value).trim() !== "unrelated") {
      throw new Error("unrelated fixture child did not become ready");
    }
    process.stdout.write("held\n");
    const command = await readOneInputByte();
    if (command !== "c") throw new Error("unexpected fixture command");
    await owner.close();
    owner = undefined;
    process.stdout.write("closed\n");
    const release = await readOneInputByte();
    if (release !== "q") throw new Error("unexpected fixture release");
    process.stdout.write("released\n");
    unrelated.kill("SIGKILL");
    await unrelated.exited;
    process.stdout.write("terminated\n");
  } catch {
    process.exitCode = 1;
  } finally {
    await owner?.close().catch(() => {});
    unrelated?.kill("SIGKILL");
    await unrelated?.exited;
  }
}

async function readOneInputByte(): Promise<string | undefined> {
  const value = await new Promise<string | undefined>((resolve) => {
    process.stdin.once("data", (chunk) => {
      resolve(String(chunk).slice(0, 1));
    });
    process.stdin.once("end", () => resolve(undefined));
    process.stdin.resume();
  });
  return value;
}

async function waitForInputEnd(): Promise<void> {
  if (process.stdin.readableEnded) return;
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.resume();
  });
}
