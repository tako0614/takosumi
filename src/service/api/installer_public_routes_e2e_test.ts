import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InstallationApplyResponse,
  InstallationDryRunResponse,
} from "takosumi-contract/installer-api";
import { createTakosumiService } from "../bootstrap.ts";

test("installer e2e exposes manifestless dry-run and apply", async () => {
  await withTempSource(async (dir) => {
    await writeFile(`${dir}/package.json`, '{"name":"route-app"}');
    const { app } = await createTakosumiService({
      role: "takosumi-api",
      runtimeEnv: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_INSTALLER_TOKEN: "installer-token",
      },
      startWorkerDaemon: false,
    });

    const dryRunRes = await app.request("/v1/installations/dry-run", {
      method: "POST",
      headers: {
        authorization: "Bearer installer-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
      }),
    });
    expect(dryRunRes.status).toEqual(200);
    const dryRun = await dryRunRes.json() as InstallationDryRunResponse;
    expect(dryRun.installPlan.repo.name).toEqual("route-app");
    expect(dryRun.planSnapshotDigest.startsWith("sha256:")).toBeTruthy();

    const applyRes = await app.request("/v1/installations", {
      method: "POST",
      headers: {
        authorization: "Bearer installer-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
        expected: dryRun.expected,
      }),
    });
    expect(applyRes.status).toEqual(201);
    const apply = await applyRes.json() as InstallationApplyResponse;
    expect(apply.installation.status).toEqual("ready");
    expect(apply.deployment.planSnapshotDigest).toEqual(
      dryRun.planSnapshotDigest,
    );
  });
});

test("installer e2e rejects mismatched plan snapshot guard", async () => {
  await withTempSource(async (dir) => {
    const { app } = await createTakosumiService({
      role: "takosumi-api",
      runtimeEnv: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_INSTALLER_TOKEN: "installer-token",
      },
      startWorkerDaemon: false,
    });

    const res = await app.request("/v1/installations", {
      method: "POST",
      headers: {
        authorization: "Bearer installer-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: "space_test",
        source: { kind: "local", url: dir },
        expected: { planSnapshotDigest: "sha256:not-a-real-digest" },
      }),
    });
    expect(res.status).toEqual(409);
  });
});

async function withTempSource(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-installer-route-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
