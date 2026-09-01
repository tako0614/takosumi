import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

test("OSS deploy contract exposes only its platform Worker and website surfaces", async () => {
  const child = Bun.spawn(["bun", "scripts/deploy.mjs", "--contract"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  const contract = JSON.parse(stdout) as {
    readonly surfaces: readonly {
      readonly surface: string;
      readonly target: string;
    }[];
  };
  expect(contract.surfaces).toEqual([
    expect.objectContaining({
      surface: "takosumi-platform",
      target: "cloudflare-worker:takosumi",
    }),
    expect.objectContaining({
      surface: "takosumi-website",
      target: "cloudflare-pages:takosumi-website",
    }),
  ]);

  const source = await Bun.file(resolve(root, "scripts/deploy.mjs")).text();
  expect(source).not.toContain("TAKOSUMI_WRANGLER_CONFIG");
  expect(source).not.toContain("takosumi-platform-worker");
  expect(source).toMatch(/surface:\s*["']takosumi-platform["']/u);
  expect(source).toMatch(/wrangler["'],\s*\["deploy"/u);
  expect(source).not.toMatch(/Workers?\s+for\s+Platforms/iu);
  expect(source).not.toMatch(/\bWfP\b/iu);
  expect(source).not.toMatch(/\bModuleWorker\b/iu);
  expect(source).not.toMatch(/Takoserver/iu);
  expect(source).not.toMatch(/managed customer(?: runtime| worker)?/iu);
});
