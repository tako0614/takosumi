import { expect, test } from "bun:test";
import type { CloudflareWorkerEnv } from "./bindings.ts";
import { CloudflareContainerOpenTofuRunner } from "./container_runner.ts";

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
        "TF_VAR_cloudflare_compute_api_token=diag-tf-var token=diag-token " +
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

function envReturning(payload: Record<string, unknown>): CloudflareWorkerEnv {
  return {
    RUNNER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () =>
          Promise.resolve(
            Response.json(payload, {
              status: 200,
            }),
          ),
      }),
    },
  } as unknown as CloudflareWorkerEnv;
}
