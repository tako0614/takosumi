import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { handleRunnerRequest } from "../../runner/entrypoint.ts";
import { workspaceForRun } from "../../runner/lib/artifacts.ts";
import { PROVIDER_LOCK_RESTORE_DIGEST_HEADER } from "../../runner/lib/transport.ts";

const LOCK = `provider "registry.opentofu.org/hashicorp/null" {
  version = "3.2.4"
  hashes = ["h1:fixture"]
}
`;
const PROVIDER = "registry.opentofu.org/hashicorp/null";

async function digest(bytes: Uint8Array): Promise<string> {
  return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

test("apply restores the exact reviewed lock and initializes without registry resolution", async () => {
  const runId = `reviewed-lock-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const bin = await mkdtemp(join(tmpdir(), "takosumi-reviewed-lock-bin-"));
  const oldPath = Bun.env.PATH;
  const lockBytes = new TextEncoder().encode(LOCK);
  const lockDigest = await digest(lockBytes);
  const planBytes = new TextEncoder().encode("reviewed-plan");
  try {
    await mkdir(workspace.sourceRoot, { recursive: true });
    await writeFile(
      join(workspace.sourceRoot, "main.tf"),
      `terraform { required_providers { null = { source = "hashicorp/null" } } }\nresource "null_resource" "example" {}\n`,
    );
    // The nested module lock is not the generated root's dependency lock.
    // A successful Plan may legitimately seal different root lock bytes.
    await writeFile(
      join(workspace.sourceRoot, ".terraform.lock.hcl"),
      'provider "registry.opentofu.org/hashicorp/null" { version = "0.0.0" }\n',
    );
    await writeFile(workspace.planPath, planBytes);
    await writeFile(
      join(bin, "tofu"),
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    case " $* " in *" -lockfile=readonly "*) ;; *) echo "init did not use reviewed lock" >&2; exit 31;; esac
    grep -Fq 'registry.opentofu.org/hashicorp/null' .terraform.lock.hcl
    ;;
  show) printf '{"resource_changes":[]}' ;;
  state) exit 0 ;;
  apply) exit 0 ;;
  output) printf '{}' ;;
  *) echo "unexpected tofu command" >&2; exit 32 ;;
esac
`,
    );
    await chmod(join(bin, "tofu"), 0o755);
    Bun.env.PATH = `${bin}:${oldPath ?? "/usr/bin:/bin"}`;

    const restored = await handleRunnerRequest(
      new Request(
        `https://runner.internal/runs/${encodeURIComponent(runId)}/provider-lockfile/restore`,
        { method: "PUT", body: lockBytes },
      ),
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).digest).toBe(lockDigest);

    const body = JSON.stringify({
      action: "apply",
      runId,
      request: {
        sourceBuild: {
          commands: [
            {
              argv: [
                process.execPath,
                "-e",
                "await Bun.write('build.marker', 'ready')",
              ],
            },
          ],
          outputs: ["build.marker"],
        },
        generatedRoot: {
          files: {
            "main.tf":
              'terraform {}\nmodule "service" { source = "./module" }\n',
          },
        },
        planRun: {
          source: {
            kind: "git",
            url: "https://git.example.test/repo.git",
            commit: "1".repeat(40),
          },
          requiredProviders: [PROVIDER],
          providerLockDigest: lockDigest,
          providerLockArtifact: { kind: "object-storage", digest: lockDigest },
        },
        planArtifact: { digest: await digest(planBytes) },
      },
    });
    const applyRequest = () =>
      new Request(`https://runner.internal/runs/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [PROVIDER_LOCK_RESTORE_DIGEST_HEADER]: lockDigest,
        },
        body,
      });
    const result = await handleRunnerRequest(applyRequest());
    expect(result.status).toBe(200);
    const resultBody = await result.json();
    expect(resultBody.status).toBe("succeeded");
    expect(
      resultBody.phaseTimings.some(
        (timing: { phase: string; durationMs: number }) =>
          timing.phase === "source_build" && timing.durationMs >= 0,
      ),
    ).toBe(true);
    expect(
      await readFile(
        join(workspace.generatedRootDir, ".terraform.lock.hcl"),
        "utf8",
      ),
    ).toBe(LOCK);

    const invalidMarker = applyRequest();
    invalidMarker.headers.set(PROVIDER_LOCK_RESTORE_DIGEST_HEADER, `sha256:${"0".repeat(64)}`);
    const markerMismatch = await handleRunnerRequest(invalidMarker);
    expect(markerMismatch.status).toBe(500);
    expect((await markerMismatch.json()).stderr).toContain(
      "provider lock restore marker differs from reviewed Plan",
    );

    const restoredPath = join(workspace.root, "restored-provider-lockfile.hcl");
    await writeFile(restoredPath, LOCK.replace("3.2.4", "3.2.5"));
    const wrongBytes = await handleRunnerRequest(applyRequest());
    expect(wrongBytes.status).toBe(500);
    expect((await wrongBytes.json()).stderr).toContain(
      "reviewed Plan provider lock bytes were not restored exactly",
    );
    await writeFile(restoredPath, LOCK);

    await writeFile(
      join(workspace.generatedRootDir, ".terraform.lock.hcl"),
      'provider "registry.opentofu.org/hashicorp/null" { version = "0.0.0" }\n',
    );
    const conflicted = await handleRunnerRequest(applyRequest());
    expect(conflicted.status).toBe(500);
    expect((await conflicted.json()).stderr).toContain(
      "source module lockfile conflicts with reviewed Plan lockfile",
    );
    await writeFile(join(workspace.generatedRootDir, ".terraform.lock.hcl"), LOCK);
    await rm(restoredPath);
    const missing = await handleRunnerRequest(applyRequest());
    expect(missing.status).toBe(500);
    expect((await missing.json()).stderr).toContain(
      "reviewed Plan provider lock bytes were not restored exactly",
    );
  } finally {
    if (oldPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = oldPath;
    await rm(workspace.root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});

for (const artifactMode of ["artifact", "digest-only"] as const) {
  for (const lockMatches of [true, false]) {
    test(`legacy DO with new runner checks post-init ${artifactMode} digest (${lockMatches ? "match" : "mismatch"}) before apply`, async () => {
      const runId = `legacy-lock-${crypto.randomUUID()}`;
      const workspace = workspaceForRun(runId);
      const bin = await mkdtemp(join(tmpdir(), "takosumi-legacy-lock-bin-"));
      const oldPath = Bun.env.PATH;
      const lockDigest = await digest(new TextEncoder().encode(LOCK));
      try {
        await mkdir(workspace.sourceRoot, { recursive: true });
        await writeFile(join(workspace.sourceRoot, "main.tf"),
          `terraform { required_providers { null = { source = "hashicorp/null" } } }\nresource "null_resource" "example" {}\n`);
        const planBytes = new TextEncoder().encode("reviewed-plan");
        await writeFile(workspace.planPath, planBytes);
        await writeFile(join(bin, "tofu"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    case " $* " in *" -lockfile=readonly "*) exit 31;; esac
    printf '%s' '${(lockMatches ? LOCK : LOCK.replace("3.2.4", "3.2.5")).replaceAll("'", "'\"'\"'")}' > .terraform.lock.hcl
    ;;
  show) printf '{"resource_changes":[]}' ;;
  state) exit 0 ;;
  apply) touch '${join(workspace.root, "applied")}' ;;
  output) printf '{}' ;;
  *) exit 32 ;;
esac
`);
        await chmod(join(bin, "tofu"), 0o755);
        Bun.env.PATH = `${bin}:${oldPath ?? "/usr/bin:/bin"}`;
        const response = await handleRunnerRequest(new Request(
          `https://runner.internal/runs/${encodeURIComponent(runId)}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
            action: "apply", runId, request: {
              generatedRoot: { files: { "main.tf": 'terraform {}\nmodule "service" { source = "./module" }\n' } },
              planRun: {
                id: runId,
                source: { kind: "git", url: "https://git.example.test/repo.git", commit: "1".repeat(40) },
                requiredProviders: [PROVIDER], providerLockDigest: lockDigest,
                ...(artifactMode === "artifact" ? { providerLockArtifact: { kind: "object-storage", digest: lockDigest } } : {}),
              },
              planArtifact: { digest: await digest(planBytes) },
            },
          }) },
        ));
        expect(response.status).toBe(lockMatches ? 200 : 500);
        if (!lockMatches) {
          expect((await response.json()).stderr).toContain("OpenTofu dependency lock differs from reviewed Plan");
          expect(await Bun.file(join(workspace.root, "applied")).exists()).toBe(false);
        }
      } finally {
        if (oldPath === undefined) delete Bun.env.PATH;
        else Bun.env.PATH = oldPath;
        await rm(workspace.root, { recursive: true, force: true });
        await rm(bin, { recursive: true, force: true });
      }
    });
  }
}

for (const providerLockArtifact of [null, undefined]) {
  test(`provider-free Plan ${providerLockArtifact === null ? "explicitly absent" : "legacy without lock fields"} still applies without readonly init`, async () => {
    const runId = `provider-free-lock-${crypto.randomUUID()}`;
    const workspace = workspaceForRun(runId);
    const bin = await mkdtemp(join(tmpdir(), "takosumi-provider-free-bin-"));
    const oldPath = Bun.env.PATH;
    try {
      await mkdir(workspace.sourceRoot, { recursive: true });
      await writeFile(join(workspace.sourceRoot, "main.tf"), 'output "value" { value = "ok" }\n');
      const planBytes = new TextEncoder().encode("reviewed-plan");
      await writeFile(workspace.planPath, planBytes);
      await writeFile(join(bin, "tofu"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init) case " $* " in *" -lockfile=readonly "*) exit 31;; esac ;;
  show) printf '{"resource_changes":[]}' ;;
  state) exit 0 ;;
  apply) exit 0 ;;
  output) printf '{}' ;;
  *) exit 32 ;;
esac
`);
      await chmod(join(bin, "tofu"), 0o755);
      Bun.env.PATH = `${bin}:${oldPath ?? "/usr/bin:/bin"}`;
      const response = await handleRunnerRequest(new Request(
        `https://runner.internal/runs/${encodeURIComponent(runId)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          action: "apply", runId, request: {
            generatedRoot: { files: { "main.tf": 'terraform {}\nmodule "service" { source = "./module" }\n' } },
            planRun: {
              id: runId,
              source: { kind: "git", url: "https://git.example.test/repo.git", commit: "1".repeat(40) },
              requiredProviders: [],
              ...(providerLockArtifact === null ? { providerLockArtifact: null } : {}),
            },
            planArtifact: { digest: await digest(planBytes) },
          },
        }) },
      ));
      expect(response.status).toBe(200);
    } finally {
      if (oldPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = oldPath;
      await rm(workspace.root, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });
}

test("private lockfile restore is bounded and exact on retry", async () => {
  const runId = `reviewed-lock-route-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const url = `https://runner.internal/runs/${encodeURIComponent(runId)}/provider-lockfile/restore`;
  const restore = (body: Uint8Array) =>
    handleRunnerRequest(new Request(url, { method: "PUT", body }));
  try {
    const first = await restore(new TextEncoder().encode("# reviewed\n"));
    expect(first.status).toBe(200);
    const retry = await restore(new TextEncoder().encode("# reviewed\n"));
    expect(retry.status).toBe(200);
    const conflict = await restore(new TextEncoder().encode("# different\n"));
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain("reviewed\n");
    const oversized = await restore(new Uint8Array(1024 * 1024 + 1));
    expect(oversized.status).toBe(413);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});
