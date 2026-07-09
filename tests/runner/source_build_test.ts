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
import { expect, test } from "bun:test";
import { runSourceBuild } from "../../runner/entrypoint.ts";

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
