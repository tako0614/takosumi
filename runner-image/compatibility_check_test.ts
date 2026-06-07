import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { handleRunnerRequest } from "./entrypoint.ts";

const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";

test("compatibility_check returns restored OpenTofu source files only", async () => {
  const runId = `compat_test_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, runId);
  const sourceRoot = join(root, "source");
  try {
    await mkdir(join(sourceRoot, "nested"), { recursive: true });
    await writeFile(join(sourceRoot, "main.tf"), "terraform {}\n");
    await writeFile(
      join(sourceRoot, "nested", "outputs.tf"),
      'output "x" { value = 1 }\n',
    );
    await writeFile(
      join(sourceRoot, "README.md"),
      "not part of compatibility scan\n",
    );

    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "compatibility_check",
          runId,
          request: {},
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "compatibility_check",
      status: "succeeded",
      exitCode: 0,
    });
    expect(body.files).toEqual([
      { path: "main.tf", text: "terraform {}\n" },
      { path: "nested/outputs.tf", text: 'output "x" { value = 1 }\n' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
