import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireRunRootOwnership,
  RunRootOwnershipBusyError,
  RunRootOwnershipUnavailableError,
  withRunRootOwnershipChild,
  withRunRootWriter,
} from "../../runner/lib/run_root_ownership.ts";

const CHILD_MODULE = new URL(
  "../../runner/lib/run_root_ownership.ts",
  import.meta.url,
).href;
const CHILD_SCRIPT = `
import {
  adoptRunRootOwnershipFromStdin,
  RunRootOwnershipUnavailableError,
  withRunRootWriter,
} from ${JSON.stringify(CHILD_MODULE)};

const root = process.env.PROBE_ROOT;
const mode = process.env.PROBE_MODE;
await Bun.write(root + "/child-started", "started");

if (mode === "ignore-challenge") {
  await Bun.write(root + "/child-started", "started");
  await Bun.sleep(10_000);
  process.exit(0);
}

try {
  const owner = await adoptRunRootOwnershipFromStdin(root, { timeoutMs: 250 });
  if (mode === "adopt-and-release") {
    await withRunRootWriter(owner, async () => {
      await Bun.write(root + "/child-adopted", "adopted");
    });
    const grandchildScript = \`
import { readdirSync, fstatSync } from "node:fs";
const expectedDev = Number(process.env.PROBE_LOCK_DEV);
const expectedIno = Number(process.env.PROBE_LOCK_INO);
let inherited = false;
for (const entry of readdirSync("/proc/self/fd")) {
  const fd = Number(entry);
  if (!Number.isInteger(fd)) continue;
  try {
    const info = fstatSync(fd);
    if (info.dev === expectedDev && info.ino === expectedIno) inherited = true;
  } catch {}
}
await Bun.write(process.env.PROBE_ROOT + "/grandchild-fd", inherited ? "inherited" : "closed");
await Bun.write(process.env.PROBE_ROOT + "/grandchild-started", "started");
for (let i = 0; i < 500 && !await Bun.file(process.env.PROBE_ROOT + "/release-grandchild").exists(); i++) await Bun.sleep(10);
await Bun.write(process.env.PROBE_ROOT + "/grandchild-exited", "done");
\`;
    const grandchild = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", grandchildScript],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: {
          HOME: root,
          PATH: "/usr/bin:/bin",
          PROBE_LOCK_DEV: process.env.PROBE_LOCK_DEV,
          PROBE_LOCK_INO: process.env.PROBE_LOCK_INO,
          PROBE_ROOT: root,
        },
      },
    );
    grandchild.unref();
    for (let i = 0; i < 100 && !await Bun.file(root + "/grandchild-started").exists(); i++) await Bun.sleep(10);
    if (!await Bun.file(root + "/grandchild-started").exists()) process.exit(31);
    await owner.close();
    await Bun.write(root + "/child-closed", "closed");
    for (let i = 0; i < 300 && !await Bun.file(root + "/release-child").exists(); i++) await Bun.sleep(10);
    if (!await Bun.file(root + "/release-child").exists()) process.exit(32);
    process.exit(0);
  }

  await owner.close();
  await Bun.write(root + "/child-adopted", "adopted");
  process.exit(0);
} catch (error) {
  if (error instanceof RunRootOwnershipUnavailableError) {
    await Bun.write(root + "/child-refused", "refused");
    process.exit(0);
  }
  process.exit(33);
}
`;

test.skipIf(
  process.platform !== "linux" ||
    (process.arch !== "x64" && process.arch !== "arm64"),
)("an adopted child shares the lease, closes safely, and cannot leak it to a grandchild", async () => {
  const root = await createPrivateRoot();
  const owner = await acquireRunRootOwnership(root);
  let ownerClosed = false;
  let releaseSupervisor: (() => void) | undefined;
  const supervisorDrain = new Promise<void>((resolve) => {
    releaseSupervisor = resolve;
  });
  const supervisorHold = withRunRootWriter(owner, () => supervisorDrain);
  let releaseParentClose: Promise<void> | undefined;
  let childExited = false;
  let grandchildExited = false;
  try {
    const result = await withRunRootOwnershipChild(
      owner,
      root,
      [process.execPath, "--no-env-file", "-e", CHILD_SCRIPT],
      { env: childEnv(root, "adopt-and-release") },
      async (child) => {
        await waitForFile(join(root, "child-adopted"));
        releaseParentClose = owner.close().then(() => {
          ownerClosed = true;
        });
        await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
          RunRootOwnershipBusyError,
        );
        await waitForFile(join(root, "child-closed"));
        await waitForFile(join(root, "grandchild-started"));
        expect(await readFile(join(root, "grandchild-fd"), "utf8")).toBe("closed");
        expect(ownerClosed).toBe(false);
        await Bun.write(join(root, "release-child"), "release");
        expect(await child.exited).toBe(0);
        childExited = true;
        expect(ownerClosed).toBe(false);
        await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
          RunRootOwnershipBusyError,
        );
        await Bun.write(join(root, "release-grandchild"), "release");
        await waitForFile(join(root, "grandchild-exited"));
        grandchildExited = true;
        releaseSupervisor?.();
        await supervisorHold;
        expect(ownerClosed).toBe(false);
        return "drained";
      },
    );

    await supervisorHold;
    await releaseParentClose;
    expect(result).toBe("drained");
    expect(childExited).toBe(true);
    expect(grandchildExited).toBe(true);
    expect(ownerClosed).toBe(true);
    const nextOwner = await acquireRunRootOwnership(root);
    await nextOwner.close();
  } finally {
    releaseSupervisor?.();
    await supervisorHold.catch(() => {});
    if (!childExited && !await Bun.file(join(root, "child-adopted")).exists()) {
      // No writer reached the child protocol; the private fixture stays isolated.
    } else if (await Bun.file(join(root, "grandchild-started")).exists()) {
      await Bun.write(join(root, "release-grandchild"), "release").catch(() => {});
      await waitForFile(join(root, "grandchild-exited")).catch(() => {});
    }
    if (releaseParentClose) await releaseParentClose.catch(() => {});
    else await owner.close().then(() => { ownerClosed = true; }).catch(() => {});
    if (ownerClosed && childExited && grandchildExited) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test.skipIf(process.platform !== "linux")(
  "an independently opened same-inode descriptor cannot be adopted while the real owner holds the lock",
  async () => {
    const root = await createPrivateRoot();
    const owner = await acquireRunRootOwnership(root);
    const foreign = await open(join(root, ".takosumi-run-root.lock"), "r+");
    let exited = false;
    try {
      const attempt = await runManualAdopter(root, foreign.fd, true);
      exited = true;
      expect(attempt.readySeen).toBe(true);
      expect(await readFile(join(root, "child-refused"), "utf8")).toBe("refused");
      await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
        RunRootOwnershipBusyError,
      );
    } finally {
      await foreign.close();
      await owner.close().catch(() => {});
      if (exited) await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a valid inherited descriptor is refused when the parent does not acknowledge adoption",
  async () => {
    const root = await createPrivateRoot();
    const lock = await open(join(root, ".takosumi-run-root.lock"), "r+");
    const acquirer = Bun.spawn(
      ["/usr/bin/flock", "-n", "-E", "73", "1"],
      {
        stdin: "ignore",
        stdout: lock.fd,
        stderr: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    expect(await acquirer.exited).toBe(0);
    let exited = false;
    try {
      const attempt = await runManualAdopter(root, lock.fd, false);
      exited = true;
      expect(attempt.readySeen).toBe(true);
      expect(await Bun.file(join(root, "child-refused")).exists()).toBe(true);
      expect(await Bun.file(join(root, "child-adopted")).exists()).toBe(false);
      await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
        RunRootOwnershipBusyError,
      );
    } finally {
      await lock.close();
      if (exited) await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "an unlocked same-inode descriptor cannot be adopted after a forged acknowledgement",
  async () => {
    const root = await createPrivateRoot();
    const unlocked = await open(join(root, ".takosumi-run-root.lock"), "r+");
    let exited = false;
    try {
      const attempt = await runManualAdopter(root, unlocked.fd, true);
      exited = true;
      expect(attempt.readySeen).toBe(true);
      expect(await Bun.file(join(root, "child-refused")).exists()).toBe(true);
      expect(await Bun.file(join(root, "child-adopted")).exists()).toBe(false);
      const owner = await acquireRunRootOwnership(root);
      await owner.close();
    } finally {
      await unlocked.close();
      if (exited) await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a stale parent owner is rejected before a child is spawned",
  async () => {
    const root = await createPrivateRoot();
    const owner = await acquireRunRootOwnership(root);
    await owner.close();
    try {
      await expect(
        withRunRootOwnershipChild(
          owner,
          root,
          [process.execPath, "--no-env-file", "-e", CHILD_SCRIPT],
          { env: childEnv(root, "adopt-and-release") },
          async (child) => await child.exited,
        ),
      ).rejects.toBeInstanceOf(RunRootOwnershipUnavailableError);
      expect(await Bun.file(join(root, "child-started")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a child that never acknowledges the handoff is terminated without releasing the parent lease",
  async () => {
    const root = await createPrivateRoot();
    const owner = await acquireRunRootOwnership(root);
    try {
      await expect(
        withRunRootOwnershipChild(
          owner,
          root,
          [
            process.execPath,
            "--no-env-file",
            "-e",
            'await Bun.write(process.env.PROBE_ROOT + "/child-started", "started"); await Bun.sleep(10_000);',
          ],
          { env: childEnv(root, "ignore-challenge"), handshakeTimeoutMs: 100 },
          async (child) => await child.exited,
        ),
      ).rejects.toBeInstanceOf(RunRootOwnershipUnavailableError);
      expect(await Bun.file(join(root, "child-started")).exists()).toBe(true);
      await expect(acquireRunRootOwnership(root)).rejects.toBeInstanceOf(
        RunRootOwnershipBusyError,
      );
    } finally {
      await owner.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function runManualAdopter(
  root: string,
  stdin: number,
  acknowledgeReady: boolean,
): Promise<{ readySeen: boolean }> {
  const nonce = crypto.randomUUID();
  let readySeen = false;
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", CHILD_SCRIPT],
    {
      stdin,
      stdout: "ignore",
      stderr: "ignore",
      env: childEnv(root, "adopt-only"),
      ipc(message, subprocess) {
        if (isProtocolMessage(message, "run-root-owner-started")) {
          subprocess.send({ kind: "run-root-owner-challenge", nonce });
        } else if (
          isProtocolMessage(message, "run-root-owner-ready", nonce)
        ) {
          readySeen = true;
          if (acknowledgeReady) {
            subprocess.send({ kind: "run-root-owner-ack", nonce });
          }
        }
      },
    },
  );
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(2_000).then(() => null),
  ]);
  if (exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error("manual adoption fixture did not exit within its bound");
  }
  expect(exitCode).toBe(0);
  return { readySeen };
}

function isProtocolMessage(
  value: unknown,
  kind: string,
  nonce?: string,
): boolean {
  return typeof value === "object" && value !== null && "kind" in value &&
    value.kind === kind && (nonce === undefined || ("nonce" in value && value.nonce === nonce));
}

function childEnv(root: string, mode: string): Record<string, string> {
  const lockStat = statSync(join(root, ".takosumi-run-root.lock"));
  return {
    HOME: root,
    PATH: "/usr/bin:/bin",
    PROBE_LOCK_DEV: String(lockStat.dev),
    PROBE_LOCK_INO: String(lockStat.ino),
    PROBE_MODE: mode,
    PROBE_ROOT: root,
  };
}

async function createPrivateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-root-fd-handoff-"));
  await chmod(root, 0o700);
  const lock = await open(join(root, ".takosumi-run-root.lock"), "w", 0o600);
  await lock.close();
  await chmod(join(root, ".takosumi-run-root.lock"), 0o600);
  return root;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error("owned fixture marker did not arrive within its bound");
}
