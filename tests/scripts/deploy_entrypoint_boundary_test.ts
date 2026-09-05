import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
      surface: "takosumi-control-d1-schema-staging",
      triggers: ["irreversible", "authority"],
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

async function schemaDeploy(
  surface: string,
  args: readonly string[],
  preload?: string,
) {
  const child = Bun.spawn([
    process.execPath,
    ...(preload ? ["--preload", preload] : []),
    "scripts/deploy.mjs",
    surface,
    ...args,
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      TAKOSUMI_CONTROL_D1_SOURCE_COMMIT:
        "03a9f89b3ae1ff60df1480ba834b67064dbd237c",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("schema deploy keeps plans local and binds the surface environment", async () => {
  const result = await schemaDeploy("takosumi-control-d1-schema-staging", [
    "plan",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: "takosumi.control-d1-schema-transcript@v1",
    mode: "plan",
    environment: "staging",
    status: "planned",
  });
}, 30_000);

test("schema deploy does not expose an unqualified production mutation surface", async () => {
  for (const command of ["apply", "release"]) {
    const result = await schemaDeploy("takosumi-control-d1-schema", [command]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("known surfaces:");
    expect(result.stdout).toBe("");
  }
});

test("schema deploy refuses caller environment overrides before delegation", async () => {
  for (const override of [
    ["--environment", "production"],
    ["--environment=production"],
    ["--environment", "staging"],
  ]) {
    const result = await schemaDeploy("takosumi-control-d1-schema-staging", [
      "apply",
      ...override,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("schema environment is fixed by the selected surface");
    expect(result.stdout).toBe("");
  }
});

test("schema deploy preserves CLI refusal without manifest confirmation", async () => {
  const result = await schemaDeploy("takosumi-control-d1-schema-staging", [
    "apply",
  ]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: "takosumi.control-d1-schema-transcript@v1",
    mode: "apply",
    environment: "staging",
    status: "failed",
    failureCode: "manifest_confirmation_required",
  });
}, 30_000);

test("schema apply delegates once with a retained maintenance fence", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "takosumi-schema-deploy-"));
  try {
    const preload = join(temporary, "cli-spy.ts");
    const cli = resolve(root, "deploy/platform/control_d1_schema_cli.ts");
    await writeFile(
      preload,
      `import { mock } from "bun:test";
mock.module(${JSON.stringify(cli)}, () => ({
  runControlD1SchemaCli: async (args: string[]) => {
    console.log(JSON.stringify({ args }));
    return 0;
  },
}));
`,
    );
    const manifest = `sha256:${"a".repeat(64)}`;
    const result = await schemaDeploy("takosumi-control-d1-schema-staging", [
      "apply",
      "--confirm-manifest",
      manifest,
    ], preload);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: [
        "apply",
        "--environment",
        "staging",
        "--confirm-manifest",
        manifest,
        "--retain-maintenance-fence",
      ],
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
