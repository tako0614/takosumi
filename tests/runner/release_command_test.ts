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
                  `const outputs = JSON.parse(Bun.env.TAKOSUMI_OUTPUTS_JSON)`,
                  `const context = JSON.parse(Bun.env.TAKOSUMI_RELEASE_CONTEXT_JSON)`,
                  `await Bun.write("release-output.txt", [Bun.env.RELEASE_LABEL, process.cwd().split("/").pop(), outputs.public_url, context.outputs.public_url, context.applyRunId, context.deploymentId].join(":"))`,
                  `console.log("release ok")`,
                ].join(";"),
              ],
              workingDirectory: "scripts",
              env: { RELEASE_LABEL: "public" },
            },
          ],
        },
        outputs: { public_url: "https://app.example.test" },
        activation: {
          applyRunId: "run_apply_1",
          installationId: "inst_1",
          deploymentId: "dep_1",
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
    ).resolves.toBe(
      "public:scripts:https://app.example.test:https://app.example.test:run_apply_1:dep_1",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action treats post-apply work as opaque app commands", async () => {
  const runId = `release_task_cmd_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  try {
    await mkdir(join(sourceRoot, "artifacts"), { recursive: true });

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
                  `if (Bun.env.ARTIFACT_DIR !== "artifacts") process.exit(9)`,
                  `const context = JSON.parse(Bun.env.TAKOSUMI_RELEASE_CONTEXT_JSON)`,
                  `await Bun.write("post-apply-ran.txt", ["opaque", context.kind, Bun.env.ARTIFACT_DIR].join(":"))`,
                ].join(";"),
              ],
              env: {
                ARTIFACT_DIR: "artifacts",
                RELEASE_TARGET: "preview",
              },
            },
          ],
        },
        outputs: { artifact_name: "example" },
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
    await expect(
      readFile(join(sourceRoot, "post-apply-ran.txt"), "utf8"),
    ).resolves.toBe("opaque:takosumi.release-context@v1:artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action admits dispatch-only provider credentials", async () => {
  const runId = `release_provider_env_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const secret = "cf-release-token-1234567890";
  try {
    await mkdir(sourceRoot, { recursive: true });

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
                  `if (Bun.env.CLOUDFLARE_API_TOKEN !== ${JSON.stringify(secret)}) process.exit(7)`,
                  `await Bun.write("credential-seen.txt", "yes")`,
                  `console.log("token=" + Bun.env.CLOUDFLARE_API_TOKEN)`,
                ].join(";"),
              ],
            },
          ],
        },
        credentials: {
          env: {
            CLOUDFLARE_API_TOKEN: secret,
          },
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
    expect(body.stdout).toContain("token=[redacted]");
    expect(JSON.stringify(body)).not.toContain(secret);
    await expect(
      readFile(join(sourceRoot, "credential-seen.txt"), "utf8"),
    ).resolves.toBe("yes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action honors command timeoutSeconds", async () => {
  const runId = `release_timeout_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  try {
    await mkdir(sourceRoot, { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "slow-release",
              command: [
                process.execPath,
                "-e",
                `await new Promise((resolve) => setTimeout(resolve, 2000))`,
              ],
              timeoutSeconds: 1,
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
      phase: "release",
      failedCommandId: "slow-release",
    });
    expect(body.stderr).toContain("command timed out after 1000ms");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action rejects invalid command timeoutSeconds", async () => {
  const runId = `release_bad_timeout_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  try {
    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "bad-timeout",
              command: [process.execPath, "-e", `console.log("ran")`],
              timeoutSeconds: 0,
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
      "release.commands[0].timeoutSeconds must be an integer between 1 and 21600",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action rejects provider credential and reserved env", async () => {
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
      "command env unexpectedly carries provider credential env name CLOUDFLARE_API_TOKEN",
    );
    expect(JSON.stringify(body)).not.toContain(secret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const reservedRunId = `release_reserved_${crypto.randomUUID().replace(/-/g, "")}`;
  const reservedRoot = join(RUN_ROOT, safeRunId(reservedRunId));
  try {
    await mkdir(join(reservedRoot, "source"), { recursive: true });
    const response = await handleRunnerRequest(
      runnerRequest(reservedRunId, {
        release: {
          commands: [
            {
              id: "should-not-run",
              command: [process.execPath, "-e", `console.log("ran")`],
              env: { TAKOSUMI_OUTPUTS_JSON: "{}" },
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.stderr).toContain(
      "release command env must not override reserved TAKOSUMI_OUTPUTS_JSON",
    );
  } finally {
    await rm(reservedRoot, { recursive: true, force: true });
  }

  const secretLikeRunId = `release_secret_like_${crypto.randomUUID().replace(/-/g, "")}`;
  const secretLikeRoot = join(RUN_ROOT, safeRunId(secretLikeRunId));
  try {
    await mkdir(join(secretLikeRoot, "source"), { recursive: true });
    const response = await handleRunnerRequest(
      runnerRequest(secretLikeRunId, {
        release: {
          commands: [
            {
              id: "should-not-run",
              command: [process.execPath, "-e", `console.log("ran")`],
              env: { DATABASE_URL: "postgres://localhost/example" },
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.stderr).toContain(
      "release command env must not include secret-like DATABASE_URL",
    );
    expect(JSON.stringify(body)).not.toContain("postgres://localhost/example");
  } finally {
    await rm(secretLikeRoot, { recursive: true, force: true });
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
