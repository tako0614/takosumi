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
        headers: { "content-type": "application/json" },
        body,
      });
    const result = await handleRunnerRequest(applyRequest());
    expect(result.status).toBe(200);
    expect((await result.json()).status).toBe("succeeded");
    expect(
      await readFile(
        join(workspace.generatedRootDir, ".terraform.lock.hcl"),
        "utf8",
      ),
    ).toBe(LOCK);

    await writeFile(
      join(workspace.sourceRoot, ".terraform.lock.hcl"),
      'provider "registry.opentofu.org/hashicorp/null" { version = "0.0.0" }\n',
    );
    const conflicted = await handleRunnerRequest(applyRequest());
    expect(conflicted.status).toBe(500);
    expect((await conflicted.json()).stderr).toContain(
      "source module lockfile conflicts with reviewed Plan lockfile",
    );
    await rm(join(workspace.sourceRoot, ".terraform.lock.hcl"));
    await rm(join(workspace.root, "restored-provider-lockfile.hcl"));
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
