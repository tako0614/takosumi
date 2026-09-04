import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

test("runner image release has one Takosumi-owned entrypoint, focused check, and portable-gate coverage", () => {
  const guide = readFileSync(
    join(ROOT, "docs/operations/runner-image-release.md"),
    "utf8",
  );
  const operationsIndex = readFileSync(
    join(ROOT, "docs/operations/README.md"),
    "utf8",
  );
  const deploySource = readFileSync(join(ROOT, "scripts/deploy.mjs"), "utf8");
  const releaseSource = readFileSync(
    join(ROOT, "scripts/runner-image-release.ts"),
    "utf8",
  );
  const sourceAuthority = readFileSync(
    join(ROOT, "scripts/lib/platform-release-source.ts"),
    "utf8",
  );
  const portableGate = readFileSync(
    join(ROOT, "scripts/check-portable-gate.ts"),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as { readonly scripts?: Readonly<Record<string, string>> };
  const executableBlocks = [...guide.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/gu)]
    .map((match) => match[1])
    .join("\n");
  const normalizedGuide = guide.replace(/\s+/gu, " ");

  expect(guide).toContain("bun run deploy -- takosumi-runner-image build");
  expect(guide).toContain("bun run deploy -- takosumi-runner-image reconcile");
  expect(guide).toContain("bun run deploy -- takosumi-runner-image verify");
  expect(guide).toContain("bun run deploy -- takosumi-platform-staging execute");
  expect(guide).toContain("bun run check:runner-image-release");
  expect(normalizedGuide).toContain(
    "Takosumi owns both the runner source and its release implementation",
  );
  expect(normalizedGuide).toContain(
    "`takosumi-private` owns the official realized image pin and operator evidence",
  );
  expect(operationsIndex).toContain("./runner-image-release.md");
  expect(executableBlocks).not.toMatch(
    /\b(?:docker|wrangler)\s+(?:push|deploy|containers)\b/u,
  );

  expect(packageJson.scripts?.["check:runner-image-release"]).toContain(
    "runner_image_release_test.ts",
  );
  expect(packageJson.scripts?.["check:runner-image-release"]).toContain(
    "release_config_composition_test.ts",
  );
  expect(packageJson.scripts?.test).toContain("bun test");
  expect(packageJson.scripts?.test).toContain("./tests");
  expect(portableGate).toContain('phase("tests", ["bun", "run", "test"])');
  expect(portableGate).not.toContain(
    'phase("runner-image-release", ["bun", "run", "check:runner-image-release"])',
  );

  expect(deploySource.match(/\.\/runner-image-release\.ts/gu)).toHaveLength(1);
  expect(deploySource).not.toContain("takosumi-cloud");
  expect(releaseSource).toContain('resolve(repositoryRoot, "runner/Dockerfile")');
  expect(releaseSource).toContain("resolvePlatformReleaseSourceAuthority");
  expect(sourceAuthority).toContain('"deploy/platform/entry-worker.ts"');
  expect(sourceAuthority).toContain('"dashboard/dist"');
  expect(sourceAuthority).toContain("O_NOFOLLOW");
  expect(releaseSource).toContain('"cosign"');
  expect(releaseSource).toContain('"publication-started"');
  expect(releaseSource).toContain('"reconciled-absent"');
  expect(releaseSource).not.toMatch(/"wrangler",\s*"deploy"/u);
});
