import { expect, test } from "bun:test";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { CloudflareContainerOpenTofuRunner } from "../../../worker/src/container_runner.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("container runner redacts stderr before plan diagnostics are returned", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envReturning({
      planDigest: PLAN_DIGEST,
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_diag/tfplan",
        digest: PLAN_DIGEST,
      },
      stderr:
        "TF_VAR_cloudflare_main_api_token=diag-tf-var token=diag-token " +
        "CLOUDFLARE_API_TOKEN=diag-cf-token AWS_SECRET_ACCESS_KEY=diag-aws-secret " +
        "DATABASE_URL=postgres://user:diag-db-pass@db.example/takos " +
        "Authorization: Bearer diag-auth",
    }),
  );

  const result = await runner.plan({
    planRun: { id: "plan_diag" },
  } as Parameters<CloudflareContainerOpenTofuRunner["plan"]>[0]);

  const diagnostics = JSON.stringify(result.diagnostics);
  expect(diagnostics).not.toContain("diag-tf-var");
  expect(diagnostics).not.toContain("diag-token");
  expect(diagnostics).not.toContain("diag-cf-token");
  expect(diagnostics).not.toContain("diag-aws-secret");
  expect(diagnostics).not.toContain("diag-db-pass");
  expect(diagnostics).not.toContain("diag-auth");
  expect(diagnostics).toContain("[redacted]");
});

test("container runner returns provider installation attestation from plan result", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envReturning({
      planDigest: PLAN_DIGEST,
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_provider/tfplan",
        digest: PLAN_DIGEST,
      },
      providerInstallation: [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          mirrored: true,
          installationMethod: "filesystem_mirror",
          attested: true,
          attestationMethod: "forced_filesystem_mirror_init",
          mirrorPath:
            "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
          cliConfigDigest: PLAN_DIGEST,
          installedPath:
            "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
        },
      ],
    }),
  );

  const result = await runner.plan({
    planRun: { id: "plan_provider" },
  } as Parameters<CloudflareContainerOpenTofuRunner["plan"]>[0]);

  expect(result.providerInstallation?.[0]).toMatchObject({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    mirrored: true,
    installationMethod: "filesystem_mirror",
    attested: true,
    attestationMethod: "forced_filesystem_mirror_init",
    cliConfigDigest: PLAN_DIGEST,
  });
});

test("container runner returns provider installation attestation from apply and destroy results", async () => {
  const providerInstallation = [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      mirrored: true,
      installationMethod: "filesystem_mirror",
      attested: true,
      attestationMethod: "forced_filesystem_mirror_init",
      mirrorPath:
        "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
      cliConfigDigest: PLAN_DIGEST,
    },
  ];
  const runner = new CloudflareContainerOpenTofuRunner(
    envReturning({ providerInstallation }),
  );

  const apply = await runner.apply({
    planRun: { id: "apply_provider" },
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://apply_provider/tfplan",
      digest: PLAN_DIGEST,
    },
  } as Parameters<CloudflareContainerOpenTofuRunner["apply"]>[0]);
  const destroy = await runner.destroy({
    planRun: { id: "destroy_provider" },
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://destroy_provider/tfplan",
      digest: PLAN_DIGEST,
    },
  } as Parameters<CloudflareContainerOpenTofuRunner["destroy"]>[0]);

  expect(apply.providerInstallation?.[0]).toMatchObject({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    mirrored: true,
    attested: true,
  });
  expect(destroy.providerInstallation?.[0]).toMatchObject({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    mirrored: true,
    attested: true,
  });
});

test("container runner redacts stderr before apply diagnostics are returned", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envReturning({
      stderr:
        "password=apply-diag-password Authorization: Bearer apply-diag-auth",
    }),
  );

  const result = await runner.apply({
    planRun: { id: "apply_diag" },
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://apply_diag/tfplan",
      digest: PLAN_DIGEST,
    },
  } as Parameters<CloudflareContainerOpenTofuRunner["apply"]>[0]);

  const diagnostics = JSON.stringify(result.diagnostics);
  expect(diagnostics).not.toContain("apply-diag-password");
  expect(diagnostics).not.toContain("apply-diag-auth");
  expect(diagnostics).toContain("[redacted]");
});

test("container runner surfaces non-2xx apply stderr instead of raw JSON envelope", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envReturning(
      {
        status: "failed",
        exitCode: 1,
        providerInstallation: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            mirrored: true,
            installationMethod: "filesystem_mirror",
            installedPath:
              "/tmp/takosumi-provider-cache/registry.opentofu.org/cloudflare/cloudflare/5.0.0",
          },
        ],
        stderr:
          "cloudflare_r2_bucket.assets: Error creating bucket: API token=apply-secret denied",
      },
      undefined,
      500,
    ),
  );

  let error: unknown;
  try {
    await runner.apply({
      planRun: { id: "apply_failed" },
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://apply_failed/tfplan",
        digest: PLAN_DIGEST,
      },
    } as Parameters<CloudflareContainerOpenTofuRunner["apply"]>[0]);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toContain("cloudflare_r2_bucket.assets");
  expect(message).toContain("Error creating bucket");
  expect(message).not.toContain("providerInstallation");
  expect(message).not.toContain("apply-secret");
  expect(message).toContain("[redacted]");
});

test("container runner reads Capsule compatibility source files", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envReturning({
      files: [
        { path: "main.tf", text: "terraform {}\n" },
        { path: "outputs.tf", text: 'output "x" { value = 1 }\n' },
      ],
    }),
  );

  const files = await runner.readCapsuleSourceFiles({
    runId: "compat_snap_1",
    sourceSnapshot: {
      id: "snap_1",
      sourceId: "src_1",
      url: "https://github.com/acme/repo.git",
      ref: "main",
      resolvedCommit: "abc123",
      path: ".",
      archiveObjectKey:
        "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
      archiveDigest: `sha256:${"a".repeat(64)}`,
      archiveSizeBytes: 128,
      fetchedByRunId: "ssr_1",
      fetchedAt: "2026-06-07T00:00:00.000Z",
    },
  });

  expect(files).toEqual([
    { path: "main.tf", text: "terraform {}\n" },
    { path: "outputs.tf", text: 'output "x" { value = 1 }\n' },
  ]);
});

test("container runner dispatches custom_command service-data backups to the backup action", async () => {
  let captured: Record<string, unknown> | undefined;
  const runner = new CloudflareContainerOpenTofuRunner(
    envReturning({
      status: "succeeded",
      artifact: {
        ref: "r2://service-data/exports/backup.tar.zst.enc",
        digest: PLAN_DIGEST,
        sizeBytes: 42,
      },
    }, (body) => {
      captured = body;
    }),
  );

  const result = await runner.run({
    spaceId: "space_1",
    capturedAt: "2026-06-07T00:00:00.000Z",
    installation: {
      id: "inst_1",
      sourceId: "src_1",
      name: "talk",
      environment: "production",
    } as Parameters<CloudflareContainerOpenTofuRunner["run"]>[0][
      "installation"
    ],
    installConfig: {
      id: "cfg_1",
      name: "talk",
    } as Parameters<CloudflareContainerOpenTofuRunner["run"]>[0][
      "installConfig"
    ],
    sourceSnapshot: {
      id: "snap_1",
      sourceId: "src_1",
      url: "https://github.com/acme/repo.git",
      ref: "main",
      resolvedCommit: "abc123",
      path: ".",
      archiveObjectKey:
        "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
      archiveDigest: `sha256:${"a".repeat(64)}`,
      archiveSizeBytes: 128,
      fetchedByRunId: "ssr_1",
      fetchedAt: "2026-06-07T00:00:00.000Z",
    },
    mode: "custom_command",
    outputPath: "backup.artifact",
    command: ["bun run backup"],
  });

  expect(result.status).toEqual("exported");
  expect(result.status === "exported" ? result.artifact.ref : undefined)
    .toEqual("r2://service-data/exports/backup.tar.zst.enc");
  expect(captured?.action).toEqual("backup");
  expect((captured?.request as Record<string, unknown>).backup).toEqual({
    mode: "custom_command",
    outputPath: "backup.artifact",
    command: ["bun run backup"],
  });
  expect((captured?.request as Record<string, unknown>).sourceArchive).toEqual({
    objectKey: "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
    digest: `sha256:${"a".repeat(64)}`,
  });
});

test("container runner dispatches provider_snapshot service-data backups without source archive", async () => {
  let captured: Record<string, unknown> | undefined;
  const runner = new CloudflareContainerOpenTofuRunner(
    envReturning({
      status: "succeeded",
      artifact: {
        ref: "r2://service-data/provider/provider.tar.zst.enc",
        digest: PLAN_DIGEST,
        sizeBytes: 64,
      },
    }, (body) => {
      captured = body;
    }),
  );

  const result = await runner.run({
    spaceId: "space_1",
    capturedAt: "2026-06-07T00:00:00.000Z",
    installation: {
      id: "inst_1",
      sourceId: "src_1",
      name: "talk",
      environment: "production",
    } as Parameters<CloudflareContainerOpenTofuRunner["run"]>[0][
      "installation"
    ],
    installConfig: {
      id: "cfg_1",
      name: "talk",
    } as Parameters<CloudflareContainerOpenTofuRunner["run"]>[0][
      "installConfig"
    ],
    mode: "provider_snapshot",
    outputPath: "provider.snapshot",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
  });

  expect(result.status).toEqual("exported");
  expect(result.status === "exported" ? result.artifact.ref : undefined)
    .toEqual("r2://service-data/provider/provider.tar.zst.enc");
  expect(captured?.action).toEqual("backup");
  expect((captured?.request as Record<string, unknown>).backup).toEqual({
    mode: "provider_snapshot",
    outputPath: "provider.snapshot",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
  });
  expect((captured?.request as Record<string, unknown>).sourceArchive)
    .toBeUndefined();
});

function envReturning(
  payload: Record<string, unknown>,
  onRequest?: (body: Record<string, unknown>) => void,
  status = 200,
): CloudflareWorkerEnv {
  return {
    RUNNER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          onRequest?.(await request.json() as Record<string, unknown>);
          return Promise.resolve(
            Response.json(payload, {
              status,
            }),
          );
        },
      }),
    },
  } as unknown as CloudflareWorkerEnv;
}
