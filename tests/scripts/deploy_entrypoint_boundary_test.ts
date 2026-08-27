import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

test("OSS deploy entrypoint owns the official platform Worker without a Cloud wrapper", async () => {
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
      readonly triggers?: readonly string[];
      readonly obligations?: Readonly<Record<string, string>>;
    }[];
  };
  expect(contract.surfaces).toEqual([
    expect.objectContaining({
      surface: "takosumi-platform-staging",
      target: "cloudflare-worker:takosumi-staging",
    }),
    expect.objectContaining({
      surface: "takosumi-platform",
      target: "cloudflare-worker:takosumi",
    }),
    expect.objectContaining({
      surface: "takosumi-runner-image",
      target: "cloudflare-container:takosumi-runner",
    }),
    expect.objectContaining({
      surface: "takosumi-website",
      target: "cloudflare-pages:takosumi-website",
    }),
    expect.objectContaining({
      surface: "takosumi-contract-package",
      target: "npm:@takosjp/takosumi-contract",
    }),
  ]);
  const runnerImage = contract.surfaces.find(
    (entry) => entry.surface === "takosumi-runner-image",
  );
  expect(runnerImage?.triggers).toEqual(["authority", "published-identity"]);
  expect(Object.keys(runnerImage?.obligations ?? {}).sort()).toEqual([
    "failure-handling",
    "independent-review",
    "no-overwrite",
    "post-conditions",
    "provenance",
    "reversal",
  ]);

  const source = await Bun.file(resolve(root, "scripts/deploy.mjs")).text();
  expect(source).not.toContain("takosumi-cloud");
  expect(source).toContain('import("./platform-worker-release.ts")');
  expect(source).toContain('import("./runner-image-release.ts")');
});
