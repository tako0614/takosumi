import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { runSourceBuild } from "../../runner/entrypoint.ts";
import { prepareRuntimeSecretFiles } from "../../runner/lib/runtime_secrets.ts";
import { prepareProviderCredentialFiles } from "../../runner/lib/credentials.ts";
import { readSourceBuildPhaseForTest } from "../../runner/lib/source_build_phase_gate.ts";
import type { RunWorkspace } from "../../runner/lib/types.ts";

test("source build runs without provider credentials and reuses configured caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-"));
  const sourceRoot = join(root, "source");
  const cacheRoot = join(root, "cache");
  const previousToken = Bun.env.CLOUDFLARE_API_TOKEN;
  const previousCache = Bun.env.TAKOSUMI_SOURCE_BUILD_CACHE_DIR;
  try {
    await mkdir(join(sourceRoot, "web"), { recursive: true });
    Bun.env.CLOUDFLARE_API_TOKEN = "must-not-leak";
    Bun.env.TAKOSUMI_SOURCE_BUILD_CACHE_DIR = cacheRoot;
    const log = await runSourceBuild(
      {
        commands: [
          {
            argv: [
              process.execPath,
              "-e",
              `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/result.json", JSON.stringify({
  token: process.env.CLOUDFLARE_API_TOKEN ?? null,
  bunCache: process.env.BUN_INSTALL_CACHE_DIR ?? null,
  npmCache: process.env.npm_config_cache ?? null,
  xdgCache: process.env.XDG_CACHE_HOME ?? null,
}));`,
            ],
            workingDirectory: "web",
          },
        ],
        outputs: ["web/dist/result.json"],
      },
      sourceRoot,
    );
    expect(log).toContain("source build 1/1");
    const result = JSON.parse(
      await readFile(join(sourceRoot, "web/dist/result.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(result.token).toBeNull();
    expect(result.bunCache).toBe(join(cacheRoot, "bun"));
    expect(result.npmCache).toBe(join(cacheRoot, "npm"));
    expect(result.xdgCache).toBe(join(cacheRoot, "xdg"));
  } finally {
    if (previousToken === undefined) delete Bun.env.CLOUDFLARE_API_TOKEN;
    else Bun.env.CLOUDFLARE_API_TOKEN = previousToken;
    if (previousCache === undefined) {
      delete Bun.env.TAKOSUMI_SOURCE_BUILD_CACHE_DIR;
    } else {
      Bun.env.TAKOSUMI_SOURCE_BUILD_CACHE_DIR = previousCache;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("source build failure includes bounded redacted stderr diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-failure-"));
  const sourceRoot = join(root, "source");
  const secret = "source-build-token-must-not-leak";
  const sentinel = "source-build-failure-sentinel";
  try {
    await mkdir(sourceRoot, { recursive: true });
    const failure = await runSourceBuild(
      {
        commands: [
          {
            argv: [
              process.execPath,
              "-e",
              `console.log("stdout-only-marker");
console.error(${JSON.stringify(`${sentinel} API_TOKEN=${secret}\n${"x".repeat(6000)}`)});
process.exit(7);`,
            ],
          },
        ],
        outputs: ["dist/worker.js"],
      },
      sourceRoot,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message =
      failure instanceof Error ? failure.message : String(failure);
    const output = message
      .slice(message.indexOf("output:") + "output:".length)
      .trim();
    expect(message).toContain("source build 1/1");
    expect(message).toContain("failed with exit code 7");
    expect(message).toContain("output:");
    expect(message).toContain(sentinel);
    expect(message).toContain("[redacted]");
    expect(message).toContain("diagnostics omitted");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("stdout-only-marker");
    expect(output.length).toBeLessThanOrEqual(4_096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source build failure falls back to stdout when stderr is empty", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "takosumi-source-build-failure-stdout-"),
  );
  const sourceRoot = join(root, "source");
  const sentinel = "source-build-stdout-failure-sentinel";
  try {
    await mkdir(sourceRoot, { recursive: true });
    const failure = await runSourceBuild(
      {
        commands: [
          {
            argv: [
              process.execPath,
              "-e",
              `console.log(${JSON.stringify(sentinel)}); process.exit(3);`,
            ],
          },
        ],
        outputs: ["dist/worker.js"],
      },
      sourceRoot,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message =
      failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("output:");
    expect(message).toContain(sentinel);
    expect(message).toContain("failed with exit code 3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source build failure without output retains the concise failure", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "takosumi-source-build-failure-empty-"),
  );
  const sourceRoot = join(root, "source");
  try {
    await mkdir(sourceRoot, { recursive: true });
    const failure = await runSourceBuild(
      {
        commands: [
          {
            argv: [process.execPath, "-e", "process.exit(2)"],
          },
        ],
        outputs: ["dist/worker.js"],
      },
      sourceRoot,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message =
      failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("source build 1/1");
    expect(message).toContain("failed with exit code 2");
    expect(message).not.toContain("output:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source build rejects outputs that resolve outside the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-link-"));
  const sourceRoot = join(root, "source");
  const outside = join(root, "outside.txt");
  try {
    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    await writeFile(outside, "outside");
    await symlink(outside, join(sourceRoot, "dist/output.txt"));
    await expect(
      runSourceBuild(
        {
          commands: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
          outputs: ["dist/output.txt"],
        },
        sourceRoot,
      ),
    ).rejects.toThrow(/must stay inside source root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source build revalidates canonical repository paths at the Runner boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-path-"));
  try {
    for (const unsafePath of [
      "C:relative",
      "dist\\output.txt",
      "dist//output.txt",
      "dist/./output.txt",
      "dist\u2028output.txt",
    ]) {
      await expect(
        runSourceBuild(
          {
            commands: [{ argv: ["bun", "--version"] }],
            outputs: [unsafePath],
          },
          root,
        ),
      ).rejects.toThrow("repository source-build output path contract");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source build leaves no surviving descendant behind", async () => {
  // A build command that daemonizes a helper would otherwise still be running,
  // as the same uid, once the run's provider credential files are written for
  // the tofu phases.
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-group-"));
  const sourceRoot = join(root, "source");
  let leakedPid: number | undefined;
  try {
    await mkdir(sourceRoot, { recursive: true });
    await runSourceBuild(
      {
        commands: [
          {
            argv: [
              process.execPath,
              "-e",
              `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
  stdio: "ignore",
});
child.unref();
writeFileSync("leaked.pid", String(child.pid));`,
            ],
          },
        ],
        outputs: ["leaked.pid"],
      },
      sourceRoot,
    );
    leakedPid = Number(await readFile(join(sourceRoot, "leaked.pid"), "utf8"));
    expect(Number.isInteger(leakedPid)).toBe(true);
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try {
        process.kill(leakedPid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  } finally {
    if (leakedPid !== undefined) {
      try {
        process.kill(leakedPid, "SIGKILL");
      } catch {
        // Already reaped by the process-group kill under test.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("source build drains an escaped descendant holding its output pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-setsid-"));
  let escapedPid: number | undefined;
  try {
    await runSourceBuild(
      {
        commands: [{
          argv: [process.execPath, "-e", `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
  detached: true,
  stdio: "inherit",
});
child.unref();
writeFileSync("escaped.pid", String(child.pid));
`],
        }],
        outputs: ["escaped.pid"],
      },
      root,
    );
    escapedPid = Number(await readFile(join(root, "escaped.pid"), "utf8"));
    expect(Number.isSafeInteger(escapedPid)).toBe(true);
    expect(escapedPid).toBeGreaterThan(0);
    expect(() => process.kill(escapedPid!, 0)).toThrow();
  } finally {
    if (escapedPid !== undefined) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {
        // Already reaped by the supervised build under test.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("failed source build drains an escaped descendant before reporting failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-failed-setsid-"));
  let escapedPid: number | undefined;
  try {
    const error = await runSourceBuild(
      {
        commands: [{
          argv: [process.execPath, "-e", `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
  detached: true,
  stdio: "ignore",
});
child.unref();
writeFileSync("escaped.pid", String(child.pid));
process.exit(7);
`],
        }],
        outputs: ["escaped.pid"],
      },
      root,
    ).catch((value) => value);
    escapedPid = Number(await readFile(join(root, "escaped.pid"), "utf8"));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("failed with exit code 7");
    expect(() => process.kill(escapedPid!, 0)).toThrow();
  } finally {
    if (escapedPid !== undefined) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {
        // Already reaped by the supervised build under test.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("aborted source build drains an escaped descendant holding output pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-abort-setsid-"));
  const controller = new AbortController();
  let escapedPid: number | undefined;
  try {
    const build = runSourceBuild(
      {
        commands: [{
          argv: [process.execPath, "-e", `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
  detached: true,
  stdio: "inherit",
});
child.unref();
writeFileSync("escaped.pid", String(child.pid));
setTimeout(() => {}, 120000);
`],
        }],
        outputs: ["escaped.pid"],
      },
      root,
      { signal: controller.signal },
    ).catch((value) => value);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        escapedPid = Number(await readFile(join(root, "escaped.pid"), "utf8"));
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    expect(escapedPid).toBeGreaterThan(0);
    controller.abort();
    const error = await build;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("command aborted");
    expect(() => process.kill(escapedPid!, 0)).toThrow();
  } finally {
    controller.abort();
    if (escapedPid !== undefined) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {
        // Already reaped by the supervised build under test.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("another Run's synthetic runtime file blocks source build until cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-overlap-"));
  const workspace = { root: join(root, "other-run") } as RunWorkspace;
  const marker = join(root, "build-started");
  const prepared = await prepareRuntimeSecretFiles(
    { env: {} },
    workspace,
    {
      contract: "takosumi.runner-runtime-secret-files/v1",
      profileDigest: `sha256:${"a".repeat(64)}`,
      files: [{
        path: "synthetic.json",
        mode: 0o600,
        content: JSON.stringify({ SYNTHETIC: "synthetic-other-run-secret" }),
        envName: "TAKOS_RUNTIME_SECRETS_FILE",
        secretNames: ["SYNTHETIC"],
      }],
    },
  );
  const build = runSourceBuild(
    {
      commands: [{ argv: [process.execPath, "-e", `await Bun.write("build-started", "yes")`] }],
      outputs: ["build-started"],
    },
    root,
  );
  try {
    expect(readSourceBuildPhaseForTest()).toMatchObject({
      activeSensitive: 1,
      queuedBuilds: 1,
    });
    await Bun.sleep(100);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await prepared.cleanup();
    await build;
    expect(await readFile(marker, "utf8")).toBe("yes");
  } finally {
    await prepared.cleanup().catch(() => {});
    await build.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("another Run's provider env lease blocks source build until cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-source-build-env-overlap-"));
  const workspace = { root: join(root, "other-run") } as RunWorkspace;
  const marker = join(root, "build-started");
  const prepared = await prepareProviderCredentialFiles(
    { env: { CLOUDFLARE_API_TOKEN: "synthetic-other-run-token" } },
    workspace,
  );
  const build = runSourceBuild(
    {
      commands: [{ argv: [process.execPath, "-e", `await Bun.write("build-started", "yes")`] }],
      outputs: ["build-started"],
    },
    root,
  );
  try {
    expect(readSourceBuildPhaseForTest()).toMatchObject({
      activeSensitive: 1,
      queuedBuilds: 1,
    });
    await Bun.sleep(100);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await prepared.cleanup();
    await build;
    expect(await readFile(marker, "utf8")).toBe("yes");
  } finally {
    await prepared.cleanup().catch(() => {});
    await build.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a killed build supervisor poisons later synthetic secret preparation", async () => {
  const probe = fileURLToPath(new URL("./fixtures/source_build_supervisor_death_probe.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, probe], {
    env: {
      PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: Bun.env.HOME ?? "/root",
      TMPDIR: tmpdir(),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const result = JSON.parse(stdout) as Record<string, unknown>;
  expect(result.buildRejected).toBe(true);
  expect(result.nextSecret).toBe("source build isolation is unavailable");
});
