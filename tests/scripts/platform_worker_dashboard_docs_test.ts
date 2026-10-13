import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeterministicDashboard,
  buildPlatformDashboardOnce,
  type PlatformReleaseCommand,
} from "../../scripts/platform-worker-release.ts";

function prepareVitePress(root: string): void {
  const bin = join(root, "docs", "node_modules", ".bin", "vitepress");
  mkdirSync(join(root, "docs", "node_modules", ".bin"), { recursive: true });
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

test.each(["staging", "production"] as const)("routine dashboard build seals the freshly rebuilt hosted docs (%s)", async (environment) => {
  const root = join(
    tmpdir(),
    `takosumi-dashboard-docs-${crypto.randomUUID()}`,
  );
  prepareVitePress(root);
  const dist = join(root, "dashboard", "dist");
  mkdirSync(join(dist, "docs"), { recursive: true });
  writeFileSync(join(dist, "docs", "index.html"), "stale hosted docs");
  const commands: string[] = [];
  const command: PlatformReleaseCommand = async (argv, _stdin, cwd) => {
    commands.push(`${argv.join(" ")} @ ${cwd}`);
    if (argv[0] === "bun" && argv[1] === "run" && argv[2] === "build") {
      rmSync(dist, { recursive: true, force: true });
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "index.html"), "fresh dashboard");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (
      argv[0] === "bun" &&
      argv[1] === "run" &&
      argv[2] === "app-docs:build"
    ) {
      mkdirSync(join(dist, "docs"), { recursive: true });
      writeFileSync(join(dist, "docs", "index.html"), "fresh hosted docs");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };

  try {
    const seal = await buildPlatformDashboardOnce(
      environment,
      command,
      root,
    );

    expect(seal.entries.map((entry) => entry.path)).toEqual([
      "docs/index.html",
      "index.html",
    ]);
    expect(commands).toEqual([
      `bun run build @ ${join(root, "dashboard")}`,
      `bun run app-docs:build @ ${root}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["staging", "production"] as const)("deterministic dashboard release rebuilds and seals hosted docs twice (%s)", async (environment) => {
  const root = join(
    tmpdir(),
    `takosumi-dashboard-docs-${crypto.randomUUID()}`,
  );
  prepareVitePress(root);
  const dist = join(root, "dashboard", "dist");
  const commands: string[] = [];
  const command: PlatformReleaseCommand = async (argv, _stdin, cwd) => {
    commands.push(`${argv.join(" ")} @ ${cwd}`);
    if (argv[0] === "bun" && argv[1] === "run" && argv[2] === "build") {
      rmSync(dist, { recursive: true, force: true });
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "index.html"), "fresh dashboard");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (
      argv[0] === "bun" &&
      argv[1] === "run" &&
      argv[2] === "app-docs:build"
    ) {
      mkdirSync(join(dist, "docs"), { recursive: true });
      writeFileSync(join(dist, "docs", "index.html"), "fresh hosted docs");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };

  try {
    const seal = await buildDeterministicDashboard(environment, command, root);

    expect(seal.entries.map((entry) => entry.path)).toEqual([
      "docs/index.html",
      "index.html",
    ]);
    expect(commands).toEqual([
      `bun run build @ ${join(root, "dashboard")}`,
      `bun run app-docs:build @ ${root}`,
      `bun run build @ ${join(root, "dashboard")}`,
      `bun run app-docs:build @ ${root}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const environment of ["staging", "production"] as const) {
  for (const lane of ["official plan", "routine code"] as const) {
    for (const dependency of ["missing", "not executable"] as const) {
      test(`${lane} refuses ${dependency} VitePress before any build (${environment})`, async () => {
        const root = join(tmpdir(), `takosumi-docs-preflight-${crypto.randomUUID()}`);
        mkdirSync(root, { recursive: true });
        if (dependency === "not executable") {
          prepareVitePress(root);
          chmodSync(join(root, "docs/node_modules/.bin/vitepress"), 0o644);
        }
        const commands: string[][] = [];
        const command: PlatformReleaseCommand = async (argv) => {
          commands.push([...argv]);
          throw new Error("release command ran before dependency preflight");
        };
        try {
          const build = lane === "official plan"
            ? buildDeterministicDashboard
            : buildPlatformDashboardOnce;
          await expect(build(environment, command, root)).rejects.toThrow(
            "platform_worker_release_docs_dependencies_missing: run npm ci --prefix docs --include=dev --no-audit --no-fund before release",
          );
          expect(commands).toEqual([]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

test("app-docs build refuses missing VitePress without installing dependencies", async () => {
  const root = join(tmpdir(), `takosumi-app-docs-preflight-${crypto.randomUUID()}`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(
    new URL("../../scripts/build-app-docs.sh", import.meta.url),
    join(root, "scripts/build-app-docs.sh"),
  );
  for (const installer of ["npm", "bun"]) {
    writeFileSync(join(root, "bin", installer), "#!/bin/sh\necho unexpected-installer >&2\nexit 99\n", { mode: 0o755 });
  }
  try {
    const child = Bun.spawn(["bash", "scripts/build-app-docs.sh"], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("npm ci --prefix docs --include=dev --no-audit --no-fund");
    expect(stderr).not.toContain("unexpected-installer");
    expect(stdout).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
