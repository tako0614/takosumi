import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeterministicDashboard,
  buildPlatformDashboardOnce,
  type PlatformReleaseCommand,
} from "../../scripts/platform-worker-release.ts";

test("routine dashboard release seals the freshly rebuilt hosted docs", async () => {
  const root = join(
    tmpdir(),
    `takosumi-dashboard-docs-${crypto.randomUUID()}`,
  );
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
      "staging",
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

test("deterministic dashboard release rebuilds and seals hosted docs twice", async () => {
  const root = join(
    tmpdir(),
    `takosumi-dashboard-docs-${crypto.randomUUID()}`,
  );
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
    const seal = await buildDeterministicDashboard("staging", command, root);

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
