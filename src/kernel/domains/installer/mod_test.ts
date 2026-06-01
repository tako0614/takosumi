import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
