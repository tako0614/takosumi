import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  credentialDirPrefixForWorkspace,
  prepareProviderCredentialFiles,
} from "../../runner/lib/credentials.ts";
import {
  enterSourceBuildPhase,
  readSourceBuildPhaseForTest,
} from "../../runner/lib/source_build_phase_gate.ts";
import type { RunWorkspace } from "../../runner/lib/types.ts";

const SYNTHETIC_VALUE = "synthetic-provider-credential-must-not-surface";
const FIXED_CLEANUP_ERROR = /^credential directory cleanup failed: (EACCES|EPERM)$/;

async function fixtureRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "takosumi-provider-cleanup-"));
}

function workspaceUnder(root: string): RunWorkspace {
  return { root: join(root, "run") } as RunWorkspace;
}

// The credential directory is a /tmp sibling named from the workspace root, so
// a fresh root gives a prefix no other test or Run shares.
async function credentialDirsOf(workspace: RunWorkspace): Promise<string[]> {
  const prefix = await credentialDirPrefixForWorkspace(workspace);
  return (await readdir("/tmp"))
    .filter((name) => name.startsWith(prefix))
    .map((name) => join("/tmp", name));
}

async function removeCredentialDirsOf(workspace: RunWorkspace): Promise<void> {
  for (const dir of await credentialDirsOf(workspace)) {
    await rm(dir, { recursive: true, force: true });
  }
}

async function buildPhaseIsAvailable(): Promise<boolean> {
  const lease = await enterSourceBuildPhase();
  lease.release();
  return true;
}

test("provider credential cleanup removes the run-owned directory and releases the sensitive-file lease", async () => {
  const root = await fixtureRoot();
  const workspace = workspaceUnder(root);
  try {
    const prepared = await prepareProviderCredentialFiles(
      { env: {}, credentialFiles: [{ path: "token", mode: 0o600, content: SYNTHETIC_VALUE }] },
      workspace,
    );
    const [dir] = await credentialDirsOf(workspace);
    expect(dir).toBeDefined();
    expect((await lstat(dir!)).mode & 0o777).toBe(0o700);
    expect(readSourceBuildPhaseForTest().activeSensitive).toBe(1);

    await prepared.cleanup();

    expect(await credentialDirsOf(workspace)).toEqual([]);
    expect(readSourceBuildPhaseForTest().activeSensitive).toBe(0);
    expect(await buildPhaseIsAvailable()).toBe(true);
  } finally {
    await removeCredentialDirsOf(workspace);
    await rm(root, { recursive: true, force: true });
  }
});

test("provider credential setup failure removes the directory, keeps its own error and releases the lease", async () => {
  const root = await fixtureRoot();
  const workspace = workspaceUnder(root);
  try {
    const failure = await prepareProviderCredentialFiles(
      { env: {}, credentialFiles: [{ path: "../escape", mode: 0o600, content: SYNTHETIC_VALUE }] },
      workspace,
    ).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("source_sync credential file path is unsafe: ../escape");
    expect(await credentialDirsOf(workspace)).toEqual([]);
    expect(readSourceBuildPhaseForTest().activeSensitive).toBe(0);
    expect(await buildPhaseIsAvailable()).toBe(true);
  } finally {
    await removeCredentialDirsOf(workspace);
    await rm(root, { recursive: true, force: true });
  }
});

// Phase-gate poison is process-global and permanent, so the failing-removal
// scenarios run in a child Bun that is discarded afterwards. The removal fails
// for real, with no injected remover: as root the child drops its effective uid
// (root bypasses file modes, so chmod alone cannot fail); otherwise a nested
// directory with mode 000 is not removable by its owner.
function probeSource(): string {
  const url = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
  return `
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialDirPrefixForWorkspace, prepareProviderCredentialFiles } from ${url("../../runner/lib/credentials.ts")};
import { enterSensitiveFilePhase, enterSourceBuildPhase } from ${url("../../runner/lib/source_build_phase_gate.ts")};
import { shredCredentialDir } from ${url("../../runner/lib/util.ts")};

const scenario = process.env.CREDENTIAL_CLEANUP_PROBE;
const workspace = { root: process.env.CREDENTIAL_CLEANUP_ROOT + "/run" };
const secret = "synthetic-provider-credential-must-not-surface";
const prefix = await credentialDirPrefixForWorkspace(workspace);
const credentialDirs = () =>
  readdirSync("/tmp").filter((name) => name.startsWith(prefix)).map((name) => join("/tmp", name));

// Synchronous so it can also run inside the credential file content getter.
function breakRemoval() {
  const [dir] = credentialDirs();
  if (process.getuid() === 0) {
    process.seteuid(65534);
    return () => process.seteuid(0);
  }
  mkdirSync(join(dir, "blocked"));
  writeFileSync(join(dir, "blocked", "token"), secret);
  chmodSync(join(dir, "blocked"), 0o000);
  return () => chmodSync(join(dir, "blocked"), 0o700);
}

const result = {};
let restore = () => {};
try {
  if (scenario === "cleanup-failure") {
    const prepared = await prepareProviderCredentialFiles(
      { env: {}, credentialFiles: [{ path: "token", mode: 0o600, content: secret }] },
      workspace,
    );
    restore = breakRemoval();
    result.cleanup = await prepared.cleanup().then(() => "resolved", (error) => error.message);
  } else {
    const file = {
      path: "token",
      mode: 0o600,
      get content() {
        // Read after the directory exists, as the credential file is written.
        restore = breakRemoval();
        throw new Error("synthetic setup failure");
      },
    };
    result.prepare = await prepareProviderCredentialFiles({ env: {}, credentialFiles: [file] }, workspace)
      .then(() => "resolved", (error) => error.message);
  }
} finally {
  restore();
}
result.directoriesAfter = credentialDirs().length;
result.nextBuild = await enterSourceBuildPhase().then((lease) => { lease.release(); return "entered"; }, (error) => error.message);
result.nextSensitive = await enterSensitiveFilePhase().then((lease) => { lease.release(); return "entered"; }, (error) => error.message);
for (const dir of credentialDirs()) await shredCredentialDir(dir);
console.log(JSON.stringify(result));
`;
}

async function runProbe(scenario: "cleanup-failure" | "setup-failure", root: string) {
  const child = Bun.spawn([process.execPath, "-e", probeSource()], {
    env: {
      PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: Bun.env.HOME ?? "/root",
      TMPDIR: tmpdir(),
      CREDENTIAL_CLEANUP_PROBE: scenario,
      CREDENTIAL_CLEANUP_ROOT: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain(SYNTHETIC_VALUE);
  expect(stdout).not.toContain("takosumi-run-credentials");
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("a failed credential directory removal fails cleanup with a fixed error and poisons the lease", async () => {
  const root = await fixtureRoot();
  const workspace = workspaceUnder(root);
  try {
    const result = await runProbe("cleanup-failure", root);

    expect(String(result.cleanup)).toMatch(FIXED_CLEANUP_ERROR);
    // The directory really is still there while the child reports the failure.
    expect(result.directoriesAfter).toBe(1);
    expect(result.nextBuild).toBe("source build isolation is unavailable");
    expect(result.nextSensitive).toBe("source build isolation is unavailable");
  } finally {
    await removeCredentialDirsOf(workspace);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed removal after a setup failure keeps the setup error and poisons the lease", async () => {
  const root = await fixtureRoot();
  const workspace = workspaceUnder(root);
  try {
    const result = await runProbe("setup-failure", root);

    expect(result.prepare).toBe("synthetic setup failure");
    expect(result.directoriesAfter).toBe(1);
    expect(result.nextBuild).toBe("source build isolation is unavailable");
    expect(result.nextSensitive).toBe("source build isolation is unavailable");
  } finally {
    await removeCredentialDirsOf(workspace);
    await rm(root, { recursive: true, force: true });
  }
});
