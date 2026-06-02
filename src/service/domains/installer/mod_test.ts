import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "takosumi-contract/reference/runtime-capability";
import { InstallerPipeline, InstallerPipelineError } from "./mod.ts";

test("installation dry-run returns a manifestless install plan", async () => {
  await withTempSource(async (dir) => {
    await writeFile(
      `${dir}/package.json`,
      JSON.stringify({
        name: "@acme/app",
        version: "1.2.3",
        description: "Example app",
      }),
    );
    const pipeline = new InstallerPipeline();

    const result = await pipeline.installationDryRun({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });

    assert.equal(result.installPlan.repo.name, "@acme/app");
    assert.equal(result.installPlan.repo.version, "1.2.3");
    assert.match(result.planSnapshotDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal("installPlan" in result, true);
    assert.deepEqual(result.expected, {
      planSnapshotDigest: result.planSnapshotDigest,
    });
  });
});

test("installation apply records plan snapshot and binding snapshot", async () => {
  await withTempSource(async (dir) => {
    await writeFile(`${dir}/package.json`, '{"name":"web"}');
    const pipeline = new InstallerPipeline({
      platformServices: {
        resolve(context) {
          assert.equal(context.binding.name, "oidc");
          return {
            path: "identity.primary.oidc",
            kind: "identity.oidc@v1",
            material: { issuerUrl: "https://id.example.test" },
          };
        },
      },
    });

    const { installation, deployment } = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
      bindings: [{
        name: "oidc",
        servicePath: "identity.primary.oidc",
        required: true,
      }],
    });

    assert.equal(installation.status, "ready");
    assert.equal(installation.currentDeploymentId, deployment.id);
    assert.equal(deployment.planSnapshot.repo.name, "web");
    assert.equal(deployment.bindingsSnapshot.length, 1);
    assert.deepEqual(deployment.outputs.public?.oidc, {
      issuerUrl: "https://id.example.test",
    });
  });
});

test("expected plan snapshot digest guards apply", async () => {
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline();
    await assert.rejects(
      () =>
        pipeline.installationApply({
          spaceId: "space_test",
          source: { kind: "local", url: dir },
          expected: { planSnapshotDigest: "sha256:bad" },
        }),
      (error) =>
        error instanceof InstallerPipelineError &&
        error.code === "failed_precondition",
    );
  });
});

test("prepared source expected guard includes source digest and plan snapshot", async () => {
  await withTempSource(async (dir) => {
    const sourceDir = join(dir, "prepared-src");
    const archive = join(dir, "prepared-source.tar");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(`${sourceDir}/package.json`, '{"name":"prepared-app"}\n');
    runTar(["-c", "-f", archive, "-C", sourceDir, "package.json"], dir);
    const bytes = await readFile(archive);
    const digest = await sha256Hex(bytes);
    const url = "https://example.test/prepared-source.tar";
    const source = { kind: "prepared" as const, url, digest };

    await withFetchBytes(url, bytes, async () => {
      const pipeline = new InstallerPipeline();
      const dryRun = await pipeline.installationDryRun({
        spaceId: "space_test",
        source,
      });

      assert.equal(dryRun.source.kind, "prepared");
      assert.equal(dryRun.source.sourceDigest, digest);
      assert.deepEqual(dryRun.expected, {
        sourceDigest: digest,
        planSnapshotDigest: dryRun.planSnapshotDigest,
      });

      const applied = await pipeline.installationApply({
        spaceId: "space_test",
        source,
        expected: dryRun.expected,
      });
      assert.equal(applied.installation.status, "ready");
      assert.equal(applied.deployment.source.kind, "prepared");
      assert.equal(applied.deployment.source.sourceDigest, digest);

      await assert.rejects(
        () =>
          pipeline.installationApply({
            spaceId: "space_test",
            source,
            expected: {
              sourceDigest: digest,
              planSnapshotDigest:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          }),
        (error) =>
          error instanceof InstallerPipelineError &&
          error.code === "failed_precondition",
      );
    });
  });
});

test("deployment apply fences current deployment pointer", async () => {
  await withTempSource(async (dir) => {
    const pipeline = new InstallerPipeline();
    const first = await pipeline.installationApply({
      spaceId: "space_test",
      source: { kind: "local", url: dir },
    });
    const dryRun = await pipeline.deploymentDryRun(first.installation.id, {
      source: { kind: "local", url: dir },
    });
    assert.equal(
      dryRun.expected.currentDeploymentId,
      first.deployment.id,
    );

    const second = await pipeline.deploymentApply(first.installation.id, {
      source: { kind: "local", url: dir },
      expected: dryRun.expected,
    });
    assert.equal(second.deployment.status, "succeeded");
  });
});

test("git source installs OpenTofu-only repo without Takosumi source metadata", async () => {
  await withTempSource(async (dir) => {
    const fixture = await createOpenTofuOnlyGitFixture(dir);
    const sourceUrl = "https://fixture.example/opentofu-only-app.git";
    const oidcService = await readOpenTofuPlatformService(
      `${fixture.repo}/tofu-output.json`,
    );
    let providerSawSourceDirectory = false;

    const pipeline = new InstallerPipeline({
      gitRunner: rewriteGitCloneUrl(sourceUrl, fixture.repo),
      platformServices: {
        resolve(context) {
          assert.equal(context.source.kind, "git");
          assert.equal(context.source.commit, fixture.commit);
          assert.equal(context.binding.serviceKind, "identity.oidc@v1");
          return oidcService;
        },
      },
      providers: {
        async apply(context) {
          providerSawSourceDirectory = true;
          assert.equal(context.source.kind, "git");
          assert.equal(context.source.commit, fixture.commit);
          assert.equal(await pathExists(`${context.sourceDirectory}/outputs.tf`), true);
          assert.equal(
            await pathExists(`${context.sourceDirectory}/tofu-output.json`),
            true,
          );
          assert.equal(
            await pathExists(`${context.sourceDirectory}/.takosumi`),
            false,
          );
          assert.equal(
            await pathExists(`${context.sourceDirectory}/.takosumi.yml`),
            false,
          );
          return {
            outputs: {
              public: {
                oidc: oidcService.material ?? {},
              },
            },
          };
        },
      },
    });

    const source = { kind: "git" as const, url: sourceUrl, ref: "HEAD" };
    const dryRun = await pipeline.installationDryRun({
      spaceId: "space_test",
      source,
      bindings: [{
        name: "oidc",
        serviceKind: "identity.oidc@v1",
        required: true,
      }],
    });

    assert.equal(dryRun.source.kind, "git");
    assert.equal(dryRun.source.url, sourceUrl);
    assert.equal(dryRun.source.ref, "HEAD");
    assert.equal(dryRun.source.commit, fixture.commit);
    assert.equal(dryRun.installPlan.repo.name, "@takos-fixtures/opentofu-only-app");
    assert.equal(dryRun.installPlan.repo.version, "0.1.0");
    assert.equal(dryRun.installPlan.resolvedBindings.length, 1);
    assert.equal(
      dryRun.installPlan.resolvedBindings[0]?.services[0]?.path,
      "identity.fixture.oidc",
    );
    assert.deepEqual(dryRun.expected, {
      commit: fixture.commit,
      planSnapshotDigest: dryRun.planSnapshotDigest,
    });

    const applied = await pipeline.installationApply({
      spaceId: "space_test",
      source,
      expected: dryRun.expected,
      bindings: [{
        name: "oidc",
        serviceKind: "identity.oidc@v1",
        required: true,
      }],
    });

    assert.equal(providerSawSourceDirectory, true);
    assert.equal(applied.installation.status, "ready");
    assert.equal(applied.deployment.source.kind, "git");
    assert.equal(applied.deployment.source.commit, fixture.commit);
    assert.equal(
      applied.deployment.planSnapshotDigest,
      dryRun.planSnapshotDigest,
    );
    assert.equal(
      applied.deployment.planSnapshot.repo.name,
      "@takos-fixtures/opentofu-only-app",
    );
    assert.equal(applied.deployment.bindingsSnapshot.length, 1);
    assert.deepEqual(applied.deployment.outputs.public?.oidc, {
      issuerUrl: "https://id.fixture.example",
      clientId: "fixture-client",
    });
  });
});

async function withTempSource(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-installer-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createOpenTofuOnlyGitFixture(
  root: string,
): Promise<{ repo: string; commit: string }> {
  const repo = join(root, "opentofu-only-origin");
  await mkdir(repo, { recursive: true });
  await writeFile(
    `${repo}/package.json`,
    JSON.stringify(
      {
        name: "@takos-fixtures/opentofu-only-app",
        version: "0.1.0",
        private: true,
        description: "OpenTofu-only InstallerPipeline fixture",
      },
      null,
      2,
    ),
  );
  await writeFile(
    `${repo}/outputs.tf`,
    `output "oidc_service" {
  value = {
    path = "identity.fixture.oidc"
    kind = "identity.oidc@v1"
    material = {
      issuerUrl = "https://id.fixture.example"
      clientId  = "fixture-client"
    }
  }
}
`,
  );
  await writeFile(
    `${repo}/tofu-output.json`,
    JSON.stringify(
      {
        oidc_service: {
          sensitive: false,
          type: "object",
          value: {
            path: "identity.fixture.oidc",
            kind: "identity.oidc@v1",
            material: {
              issuerUrl: "https://id.fixture.example",
              clientId: "fixture-client",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  assert.equal(await pathExists(`${repo}/.takosumi`), false);
  assert.equal(await pathExists(`${repo}/.takosumi.yml`), false);

  runGit(["init"], repo);
  runGit(["config", "user.email", "fixture@example.test"], repo);
  runGit(["config", "user.name", "Takosumi Fixture"], repo);
  runGit(["add", "package.json", "outputs.tf", "tofu-output.json"], repo);
  runGit(["commit", "-m", "Add OpenTofu-only fixture"], repo);

  return { repo, commit: runGit(["rev-parse", "HEAD"], repo).trim() };
}

function rewriteGitCloneUrl(sourceUrl: string, localRepo: string): GitRunner {
  return {
    async run(args, cwd) {
      const rewritten = args.map((arg) => arg === sourceUrl ? localRepo : arg);
      const result = Bun.spawnSync(["git", ...rewritten], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
  };
}

function runGit(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit ${result.exitCode}\nstdout:\n${
        result.stdout.toString()
      }\nstderr:\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

function runTar(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["tar", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `tar ${args.join(" ")} failed with exit ${result.exitCode}\nstdout:\n${
        result.stdout.toString()
      }\nstderr:\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

async function withFetchBytes(
  url: string,
  bytes: Uint8Array,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (requestUrl !== url) {
      return new Response("unexpected prepared source URL", { status: 404 });
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
      },
    });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function readOpenTofuPlatformService(path: string): Promise<{
  path: string;
  kind: string;
  material: Record<string, string>;
}> {
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    oidc_service?: {
      sensitive?: boolean;
      value?: {
        path?: unknown;
        kind?: unknown;
        material?: unknown;
      };
    };
  };
  assert.equal(raw.oidc_service?.sensitive, false);
  const value = raw.oidc_service?.value;
  assert.equal(typeof value?.path, "string");
  assert.equal(typeof value?.kind, "string");
  assert.equal(typeof value?.material, "object");
  assert.notEqual(value?.material, null);
  return value as {
    path: string;
    kind: string;
    material: Record<string, string>;
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
