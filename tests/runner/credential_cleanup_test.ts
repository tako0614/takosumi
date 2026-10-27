import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  assertShreddableCredentialDir,
  shredCredentialDir,
} from "../../runner/lib/util.ts";

const SYNTHETIC_VALUE = "synthetic-credential-value-must-not-surface";

async function fixtureRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "takosumi-credential-cleanup-"));
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, () => false);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("shredCredentialDir rejected with a non-Error value");
  }
  throw new Error("shredCredentialDir resolved but a removal failure was expected");
}

test("shredCredentialDir removes a populated credential directory", async () => {
  const root = await fixtureRoot();
  try {
    const dir = join(root, "credentials");
    await mkdir(join(dir, "nested"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "token"), SYNTHETIC_VALUE, { mode: 0o600 });
    await writeFile(join(dir, "nested", "key"), SYNTHETIC_VALUE, { mode: 0o600 });

    await shredCredentialDir(dir);

    expect(await exists(dir)).toBe(false);
    expect(await exists(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shredCredentialDir is idempotent for a missing or already removed directory", async () => {
  const root = await fixtureRoot();
  try {
    const dir = join(root, "credentials");
    await shredCredentialDir(dir);
    await mkdir(dir, { mode: 0o700 });
    await shredCredentialDir(dir);
    await shredCredentialDir(dir);
    expect(await exists(dir)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shredCredentialDir removes a symlink at the credential path without following it", async () => {
  const root = await fixtureRoot();
  try {
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "keep"), "keep");
    const dir = join(root, "credentials");
    await symlink(outside, dir);

    await shredCredentialDir(dir);

    expect(await exists(dir)).toBe(false);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shredCredentialDir reports a real non-missing removal failure without the path or values", async () => {
  const root = await fixtureRoot();
  try {
    // A path below a regular file fails with ENOTDIR, not ENOENT, on every
    // platform and for root too, so it needs no privilege or immutable bit.
    const blocker = join(root, `${SYNTHETIC_VALUE}-blocker`);
    await writeFile(blocker, SYNTHETIC_VALUE);
    const dir = join(blocker, "credentials");

    const error = await rejection(shredCredentialDir(dir));

    expect(error.message).toBe("credential directory cleanup failed: ENOTDIR");
    expect(error.cause).toBeUndefined();
    const surfaced = `${error.message}\n${error.stack ?? ""}`;
    expect(surfaced).not.toContain(root);
    expect(surfaced).not.toContain(SYNTHETIC_VALUE);
    expect(await readFile(blocker, "utf8")).toBe(SYNTHETIC_VALUE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shredCredentialDir does not forward a raw removal error that names the path or a value", async () => {
  const root = await fixtureRoot();
  try {
    const dir = join(root, "credentials");
    await mkdir(dir, { mode: 0o700 });
    const calls: Array<{ path: string; options: unknown }> = [];

    const error = await rejection(shredCredentialDir(dir, async (path, options) => {
      calls.push({ path: String(path), options });
      throw Object.assign(
        new Error(`EACCES: permission denied, rm '${dir}/${SYNTHETIC_VALUE}'`),
        { code: "EACCES" },
      );
    }));

    expect(error.message).toBe("credential directory cleanup failed: EACCES");
    expect(error.cause).toBeUndefined();
    expect(`${error.message}\n${error.stack ?? ""}`).not.toContain(SYNTHETIC_VALUE);
    expect(`${error.message}\n${error.stack ?? ""}`).not.toContain(dir);
    // Exactly the one directory is removed; nothing broader is attempted.
    expect(calls).toEqual([{ path: dir, options: { recursive: true, force: true } }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shredCredentialDir maps a removal error without an errno code to a fixed code", async () => {
  const root = await fixtureRoot();
  try {
    const dir = join(root, "credentials");
    const error = await rejection(shredCredentialDir(dir, async () => {
      throw new Error(`boom ${dir} ${SYNTHETIC_VALUE}`);
    }));
    expect(error.message).toBe("credential directory cleanup failed: UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the credential directory guard refuses every path that could name more than one run-owned directory", () => {
  // Pure predicate calls: nothing here can reach a removal.
  const unsafe = [
    "",
    ".",
    "..",
    "credentials",
    "./credentials",
    "/",
    "//",
    "/tmp",
    "/tmp/",
    "/tmp/credentials/",
    "/tmp/a/../b",
    "/tmp//credentials",
    "/tmp/./credentials",
  ];
  for (const path of unsafe) {
    expect(() => assertShreddableCredentialDir(path), JSON.stringify(path))
      .toThrow("credential directory path is unsafe");
  }
  for (const path of ["/tmp/takosumi-run-credentials-0123456789abcdef-AbCdEf", "/tmp/takosumi-runs/run_1/source-credentials"]) {
    expect(() => assertShreddableCredentialDir(path), path).not.toThrow();
  }
});

test("shredCredentialDir checks the path before it starts any removal", async () => {
  const root = await fixtureRoot();
  try {
    const sibling = join(root, "sibling");
    await mkdir(sibling, { mode: 0o700 });
    await writeFile(join(sibling, "keep"), "keep");
    // Harmless even if the guard or the injected remover were ignored: an
    // empty path, a relative name nothing owns, and a sibling fixture.
    const unsafe = [
      "",
      `takosumi-credential-cleanup-absent-${crypto.randomUUID()}`,
      `${root}/credentials/../sibling`,
    ];
    const calls: string[] = [];

    for (const path of unsafe) {
      const error = await rejection(shredCredentialDir(path, async (target) => {
        calls.push(target);
      }));
      expect(error.message).toBe("credential directory path is unsafe");
    }

    expect(calls).toEqual([]);
    expect(await readFile(join(sibling, "keep"), "utf8")).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
