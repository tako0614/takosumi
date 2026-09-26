import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { handleRunnerRequest } from "../../runner/entrypoint.ts";
import { workspaceForRun } from "../../runner/lib/artifacts.ts";

test("Plan reports sourceBuild separately from OpenTofu init and plan", async () => {
  const runId = `source-build-timing-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const bin = await mkdtemp(join(tmpdir(), "takosumi-source-build-timing-"));
  const oldPath = Bun.env.PATH;
  try {
    await mkdir(workspace.sourceRoot, { recursive: true });
    await writeFile(join(workspace.sourceRoot, "main.tf"), "terraform {}\n");
    await writeFile(
      join(bin, "tofu"),
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init) exit 0 ;;
  plan)
    out=""
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "-out" ]; then out="$arg"; fi
      previous="$arg"
    done
    test -n "$out"
    printf 'fake-plan' > "$out"
    ;;
  show) printf '{"format_version":"1.2","resource_changes":[]}' ;;
  *) exit 2 ;;
esac
`,
    );
    await chmod(join(bin, "tofu"), 0o755);
    Bun.env.PATH = `${bin}:${oldPath ?? "/usr/bin:/bin"}`;

    const response = await handleRunnerRequest(
      new Request(`https://runner.internal/runs/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "plan",
          runId,
          request: {
            planRun: {
              source: {
                kind: "git",
                url: "https://git.example.test/repo.git",
                commit: "1".repeat(40),
              },
              requiredProviders: [],
            },
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
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("succeeded");
    expect(body.phaseTimings.map((timing: { phase: string }) => timing.phase)).toEqual(
      expect.arrayContaining(["source_build", "tofu_init", "tofu_plan"]),
    );
  } finally {
    if (oldPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = oldPath;
    await rm(workspace.root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});
