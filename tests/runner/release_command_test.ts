import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { handleRunnerRequest, safeRunId } from "../../runner/entrypoint.ts";

const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";

test("release action runs opaque argv commands inside the source snapshot", async () => {
  const runId = `release_cmd_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  try {
    await mkdir(join(sourceRoot, "scripts"), { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "publish",
              command: [
                process.execPath,
                "-e",
                [
                  `await Bun.write("release-output.txt", Bun.env.RELEASE_LABEL + ":" + process.cwd().split("/").pop())`,
                  `console.log("release ok")`,
                ].join(";"),
              ],
              workingDirectory: "scripts",
              env: { RELEASE_LABEL: "public" },
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "release",
      status: "succeeded",
      exitCode: 0,
      commandCount: 1,
    });
    expect(body.stdout).toContain("release ok");
    await expect(
      readFile(join(sourceRoot, "scripts", "release-output.txt"), "utf8"),
    ).resolves.toBe("public:scripts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action rejects provider credential env", async () => {
  const runId = `release_secret_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const secret = "release-command-secret";
  try {
    await mkdir(sourceRoot, { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "should-not-run",
              command: [process.execPath, "-e", `console.log("ran")`],
              env: { CLOUDFLARE_API_TOKEN: secret },
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      action: "release",
      status: "failed",
      exitCode: 1,
    });
    expect(body.stderr).toContain(
      "build phase env unexpectedly carries credential env name CLOUDFLARE_API_TOKEN",
    );
    expect(JSON.stringify(body)).not.toContain(secret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runnerRequest(runId: string, request: unknown): Request {
  return new Request(`https://runner/runs/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "release",
      runId,
      request,
    }),
  });
}
