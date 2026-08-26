import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { handleRunnerRequest, safeRunId } from "../../runner/entrypoint.ts";
import { handleRunnerRequestWithDependencies } from "../../runner/lib/http_server.ts";
import type { RuntimeSecretFileSystem } from "../../runner/lib/runtime_secrets.ts";

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
                  `const providerConfigs = JSON.parse(Bun.env.TAKOSUMI_PROVIDER_CONFIGS_JSON)`,
                  `await Bun.write("release-output.txt", [Bun.env.RELEASE_LABEL, process.cwd().split("/").pop(), outputs.public_url, context.outputs.public_url, context.applyRunId, context.workspaceId, Bun.env.TAKOSUMI_WORKSPACE_ID, context.capsuleId, Bun.env.TAKOSUMI_CAPSULE_ID, context.stateVersionId, Bun.env.TAKOSUMI_STATE_VERSION_ID, providerConfigs.format, providerConfigs.providers[0].provider, providerConfigs.providers[0].alias, providerConfigs.providers[0].configuration.base_url].join(":"))`,
                  `console.log("release ok")`,
                ].join(";"),
              ],
              workingDirectory: "scripts",
              env: { RELEASE_LABEL: "public" },
            },
          ],
        },
        outputs: { public_url: "https://app.example.test" },
        providerConfigurations: {
          format: "takosumi.provider-configurations@v1",
          providers: [
            {
              provider: "cloudflare/cloudflare",
              alias: "edge",
              configuration: {
                retries: 3,
                base_url: "https://provider.example.test/api",
              },
            },
          ],
        },
        activation: {
          applyRunId: "run_apply_1",
          workspaceId: "space_1",
          capsuleId: "inst_1",
          stateVersionId: "state_1",
          sourceSnapshotId: "snap_01234567",
          sourceCommit: "0123456789abcdef0123456789abcdef01234567",
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
      "public:scripts:https://app.example.test:https://app.example.test:run_apply_1:space_1:space_1:inst_1:inst_1:state_1:state_1:takosumi.provider-configurations@v1:registry.opentofu.org/cloudflare/cloudflare:edge:https://provider.example.test/api",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action exposes SourceSnapshot identity only as process-local env", async () => {
  const runId = `release_source_identity_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const sourceSnapshotId = "snap_01234567";
  const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
  try {
    await mkdir(sourceRoot, { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "capture-source-identity",
              command: [
                process.execPath,
                "-e",
                [
                  `const context = JSON.parse(Bun.env.TAKOSUMI_RELEASE_CONTEXT_JSON)`,
                  `await Bun.write("source-identity.json", JSON.stringify({ snapshotId: Bun.env.TAKOSUMI_SOURCE_SNAPSHOT_ID, sourceCommit: Bun.env.TAKOSUMI_SOURCE_COMMIT, context }))`,
                  `console.log("source=" + Bun.env.TAKOSUMI_SOURCE_SNAPSHOT_ID + ":" + Bun.env.TAKOSUMI_SOURCE_COMMIT)`,
                ].join(";"),
              ],
            },
          ],
        },
        activation: { sourceSnapshotId, sourceCommit },
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
    expect(JSON.stringify(body)).not.toContain(sourceSnapshotId);
    expect(JSON.stringify(body)).not.toContain(sourceCommit);
    expect(body.stdout).toContain("source=[redacted]:[redacted]");
    await expect(
      readFile(join(sourceRoot, "source-identity.json"), "utf8"),
    ).resolves.toBe(
      JSON.stringify({
        snapshotId: sourceSnapshotId,
        sourceCommit,
        context: {
          kind: "takosumi.release-context@v1",
          releaseRunId: runId,
          outputs: {},
        },
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action runs sourceBuild before provider credentials are prepared", async () => {
  const runId = `release_source_build_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const secret = "release-source-build-token-1234567890";
  try {
    await mkdir(sourceRoot, { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          sourceBuild: {
            commands: [
              {
                argv: [
                  process.execPath,
                  "-e",
                  [
                    `import { mkdirSync } from "node:fs"`,
                    `if (Bun.env.CLOUDFLARE_API_TOKEN !== undefined) process.exit(7)`,
                    `mkdirSync("dist", { recursive: true })`,
                    `console.log("snap_1")`,
                    `console.log("0123456789abcdef0123456789abcdef01234567")`,
                    `await Bun.write("dist/built.txt", "built-without-credentials")`,
                  ].join(";"),
                ],
              },
            ],
            outputs: ["dist/built.txt"],
          },
          commands: [
            {
              id: "publish",
              command: [
                process.execPath,
                "-e",
                [
                  `if (Bun.env.CLOUDFLARE_API_TOKEN !== ${JSON.stringify(secret)}) process.exit(8)`,
                  `const built = await Bun.file("dist/built.txt").text()`,
                  `await Bun.write("release.txt", built + ":released")`,
                ].join(";"),
              ],
            },
          ],
        },
        activation: {
          sourceSnapshotId: "snap_1",
          sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        },
        credentials: {
          env: { CLOUDFLARE_API_TOKEN: secret },
          manifest: {
            bindings: [
              {
                providerSource: "registry.opentofu.org/cloudflare/cloudflare",
                connectionId: "conn_release_source_build",
                recipeId: "cloudflare",
                authMode: "api_token",
                envNames: ["CLOUDFLARE_API_TOKEN"],
                fileEnvNames: [],
                requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
              },
            ],
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("snap_1");
    expect(JSON.stringify(body)).not.toContain(
      "0123456789abcdef0123456789abcdef01234567",
    );
    await expect(readFile(join(sourceRoot, "release.txt"), "utf8")).resolves.toBe(
      "built-without-credentials:released",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action materializes one exact mode-0600 runtime secret file after sourceBuild and cleans it up", async () => {
  const runId = `release_runtime_secrets_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const values = {
    ENCRYPTION_KEY: "runtime-encryption-key-0123456789abcdef",
    PLATFORM_PRIVATE_KEY: "runtime-private-key-0123456789abcdef",
    PLATFORM_PUBLIC_KEY: "runtime-public-key-0123456789abcdef",
    TAKOS_AGENT_START_TOKEN: "runtime-agent-token-0123456789abcdef",
    TAKOS_INTERNAL_API_SECRET: "runtime-api-secret-0123456789abcdef",
  } as const;
  const secretNames = Object.keys(values).sort();
  try {
    await mkdir(sourceRoot, { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          sourceBuild: {
            commands: [
              {
                argv: [
                  process.execPath,
                  "-e",
                  `if (Bun.env.TAKOS_RUNTIME_SECRETS_FILE !== undefined) process.exit(31); await Bun.write("built.txt", "ok")`,
                ],
              },
            ],
            outputs: ["built.txt"],
          },
          commands: [
            {
              id: "activate",
              command: [
                process.execPath,
                "-e",
                [
                  `import { stat } from "node:fs/promises"`,
                  `import { dirname } from "node:path"`,
                  `const path = Bun.env.TAKOS_RUNTIME_SECRETS_FILE`,
                  `if (!path) process.exit(32)`,
                  `const info = await stat(path)`,
                  `const dirInfo = await stat(dirname(path))`,
                  `if ((info.mode & 0o777) !== 0o600) process.exit(33)`,
                  `if ((dirInfo.mode & 0o777) !== 0o700) process.exit(36)`,
                  `const values = await Bun.file(path).json()`,
                  `const expectedNames = ${JSON.stringify(secretNames)}`,
                  `if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expectedNames)) process.exit(34)`,
                  `if (expectedNames.some((name) => Bun.env[name] !== undefined)) process.exit(35)`,
                  `await Bun.write("runtime-secret-observation.json", JSON.stringify({ path, mode: info.mode & 0o777, dirMode: dirInfo.mode & 0o777 }))`,
                  `for (const name of expectedNames) console.log(name + "=" + values[name])`,
                ].join(";"),
              ],
            },
          ],
        },
        runtimeSecrets: {
          contract: "takosumi.runner-runtime-secret-files/v1",
          profileDigest: `sha256:${"a".repeat(64)}`,
          files: [
            {
              path: "takos-runtime-secrets.json",
              mode: 0o600,
              content: `${JSON.stringify(values)}\n`,
              envName: "TAKOS_RUNTIME_SECRETS_FILE",
              secretNames,
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "succeeded", commandCount: 1 });
    for (const value of Object.values(values)) {
      expect(JSON.stringify(body)).not.toContain(value);
    }
    expect(body.stdout).toContain("ENCRYPTION_KEY=[redacted]");
    const observation = JSON.parse(
      await readFile(join(sourceRoot, "runtime-secret-observation.json"), "utf8"),
    ) as { path: string; mode: number; dirMode: number };
    expect(observation.mode).toBe(0o600);
    expect(observation.dirMode).toBe(0o700);
    await expect(stat(observation.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action kills a background descendant before secret cleanup after direct success", async () => {
  if (process.platform === "win32") return;
  const fixture = releaseDescendantFixture("direct", {
    childDelayMs: 500,
    parentWaitMs: 0,
  });
  let childPid: number | undefined;
  try {
    await mkdir(fixture.sourceRoot, { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(fixture.runId, fixture.request),
    );
    childPid = Number(await readFile(fixture.childPidPath, "utf8"));
    const runtimePath = await readFile(fixture.runtimePathRecord, "utf8");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "succeeded", commandCount: 1 });
    await Bun.sleep(700);
    expect(await processIsGone(childPid)).toBe(true);
    await expect(stat(fixture.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await providerCredentialDirectories(fixture.runId)).toEqual([]);
    assertReleaseDescendantResponseIsValueFree(body, fixture, runtimePath);
  } finally {
    await killFixtureProcess(childPid);
    await cleanupReleaseDescendantFixture(fixture);
  }
});

test("release action kills and reaps descendants on command timeout before cleanup", async () => {
  if (process.platform === "win32") return;
  const fixture = releaseDescendantFixture("timeout", {
    childDelayMs: 1_500,
    parentWaitMs: 5_000,
    timeoutSeconds: 1,
  });
  let childPid: number | undefined;
  try {
    await mkdir(fixture.sourceRoot, { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(fixture.runId, fixture.request),
    );
    childPid = Number(await readFile(fixture.childPidPath, "utf8"));
    const runtimePath = await readFile(fixture.runtimePathRecord, "utf8");

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "failed",
      phase: "release",
      failedCommandId: "descendant-timeout",
    });
    expect(body.stderr).toContain("command timed out after 1000ms");
    await Bun.sleep(700);
    expect(await processIsGone(childPid)).toBe(true);
    await expect(stat(fixture.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await providerCredentialDirectories(fixture.runId)).toEqual([]);
    assertReleaseDescendantResponseIsValueFree(body, fixture, runtimePath);
  } finally {
    await killFixtureProcess(childPid);
    await cleanupReleaseDescendantFixture(fixture);
  }
});

test("release action abort kills and reaps descendants before cleanup", async () => {
  if (process.platform === "win32") return;
  const fixture = releaseDescendantFixture("abort", {
    childDelayMs: 1_000,
    parentWaitMs: 5_000,
    timeoutSeconds: 2,
  });
  const controller = new AbortController();
  let childPid: number | undefined;
  try {
    await mkdir(fixture.sourceRoot, { recursive: true });

    const responsePromise = handleRunnerRequest(
      runnerRequest(fixture.runId, fixture.request, controller.signal),
    );
    await waitForFile(fixture.commandStartedPath);
    childPid = Number(await readFile(fixture.childPidPath, "utf8"));
    controller.abort();
    const response = await responsePromise;
    const runtimePath = await readFile(fixture.runtimePathRecord, "utf8");

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "failed",
      phase: "release",
      failedCommandId: "descendant-abort",
    });
    expect(body.stderr).toContain("command aborted");
    expect(body.stderr).not.toContain("timed out");
    await Bun.sleep(1_200);
    expect(await processIsGone(childPid)).toBe(true);
    await expect(stat(fixture.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await providerCredentialDirectories(fixture.runId)).toEqual([]);
    assertReleaseDescendantResponseIsValueFree(body, fixture, runtimePath);
  } finally {
    controller.abort();
    await killFixtureProcess(childPid);
    await cleanupReleaseDescendantFixture(fixture);
  }
});

test("release action fails closed when the runtime secret sandbox cannot be cleaned", async () => {
  const runId = `release_runtime_secret_cleanup_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const secret = "cleanup-failure-secret-0123456789abcdef";
  try {
    await mkdir(sourceRoot, { recursive: true });

    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "tamper-runtime-sandbox",
              command: [
                process.execPath,
                "-e",
                [
                  `import { rm } from "node:fs/promises"`,
                  `const path = Bun.env.TAKOS_RUNTIME_SECRETS_FILE`,
                  `if (!path) process.exit(41)`,
                  `await Bun.write("runtime-secret-path.txt", path)`,
                  `await rm(path)`,
                ].join(";"),
              ],
            },
          ],
        },
        runtimeSecrets: runtimeSecretsFixture({
          content: `${JSON.stringify({ ONLY_SECRET: secret })}\n`,
        }),
      }),
    );

    const runtimePath = await readFile(
      join(sourceRoot, "runtime-secret-path.txt"),
      "utf8",
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.stderr).toBe("runtime secret sandbox cleanup failed");
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain(runtimePath);
    await expect(stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action redacts a runtime secret sandbox creation failure", async () => {
  const runId =
    `release_runtime_secret_setup_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const runtimeDir = `${root}-runtime-secrets-path-must-not-leak`;
  const target = join(runtimeDir, "runtime.json");
  const secret = "setup-failure-secret-0123456789abcdef";
  try {
    await mkdir(sourceRoot, { recursive: true });

    const response = await handleRunnerRequestWithDependencies(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "must-not-run",
              command: [
                process.execPath,
                "-e",
                `await Bun.write("runtime-setup-ran", "yes")`,
              ],
            },
          ],
        },
        runtimeSecrets: runtimeSecretsFixture({
          content: JSON.stringify({ ONLY_SECRET: secret }),
        }),
      }),
      {
        runtimeSecretFileSystem: {
          mkdtemp: () =>
            Promise.reject(
              new Error(
                `mkdtemp failed for ${runtimeDir}/${target}: ${secret}`,
              ),
            ),
        },
      },
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.stderr).toBe("runtime secret sandbox setup failed");
    for (const leaked of [root, runtimeDir, target, "runtime.json", secret]) {
      expect(JSON.stringify(body)).not.toContain(leaked);
    }
    await expect(stat(join(sourceRoot, "runtime-setup-ran"))).rejects
      .toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release action cleans partial runtime secret setup failures without leaking paths or values", async () => {
  const stages = ["directory-chmod", "write-file", "file-chmod"] as const;

  for (const stage of stages) {
    const runId =
      `release_runtime_secret_${stage}_${crypto.randomUUID().replace(/-/g, "")}`;
    const root = join(RUN_ROOT, safeRunId(runId));
    const sourceRoot = join(root, "source");
    const runtimeSecret = `runtime-setup-${stage}-secret-0123456789abcdef`;
    const runtimeContent = JSON.stringify({ ONLY_SECRET: runtimeSecret });
    const providerSecret =
      `provider-setup-${stage}-secret-0123456789abcdef`;
    const credentialPrefix = `${safeRunId(runId)}-credentials-`;
    let runtimeDir = "";
    let target = "";
    let chmodCalls = 0;
    let credentialDirsBeforeFailure: string[] = [];
    const setupError = (operation: string, path: string) =>
      new Error(
        `${operation} failed for ${path}; dir=${runtimeDir}; target=${target}; content=${runtimeContent}; value=${runtimeSecret}`,
      );
    const runtimeSecretFileSystem: Partial<RuntimeSecretFileSystem> = {
      mkdtemp: async (prefix) => {
        credentialDirsBeforeFailure = (await readdir(RUN_ROOT)).filter(
          (entry) => entry.startsWith(credentialPrefix),
        );
        runtimeDir = await mkdtemp(prefix);
        target = join(runtimeDir, "runtime.json");
        return runtimeDir;
      },
      ...(stage === "write-file"
        ? {
          writeFile: async (path: string) => {
            target = path;
            throw setupError("writeFile", path);
          },
        }
        : {
          chmod: async (path: string, mode: number) => {
            chmodCalls += 1;
            if (
              (stage === "directory-chmod" && chmodCalls === 1) ||
              (stage === "file-chmod" && chmodCalls === 2)
            ) {
              throw setupError("chmod", path);
            }
            await chmod(path, mode);
          },
        }),
    };
    try {
      await mkdir(sourceRoot, { recursive: true });

      const response = await handleRunnerRequestWithDependencies(
        runnerRequest(runId, {
          release: {
            commands: [
              {
                id: "must-not-run",
                command: [
                  process.execPath,
                  "-e",
                  `await Bun.write("runtime-setup-ran", "yes")`,
                ],
              },
            ],
          },
          credentials: {
            files: [
              {
                path: "provider-token.json",
                mode: 0o600,
                content: providerSecret,
                envName: "CLOUDFLARE_API_TOKEN_FILE",
              },
            ],
            manifest: {
              bindings: [
                {
                  providerSource:
                    "registry.opentofu.org/cloudflare/cloudflare",
                  connectionId: `conn_runtime_setup_${stage}`,
                  recipeId: "cloudflare",
                  authMode: "api_token_file",
                  envNames: ["CLOUDFLARE_API_TOKEN_FILE"],
                  fileEnvNames: ["CLOUDFLARE_API_TOKEN_FILE"],
                  requiredEnvGroups: [["CLOUDFLARE_API_TOKEN_FILE"]],
                },
              ],
              files: [
                {
                  path: "provider-token.json",
                  mode: 0o600,
                  envName: "CLOUDFLARE_API_TOKEN_FILE",
                },
              ],
            },
          },
          runtimeSecrets: runtimeSecretsFixture({ content: runtimeContent }),
        }),
        { runtimeSecretFileSystem },
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.stderr).toBe("runtime secret sandbox setup failed");
      for (const leaked of [
        root,
        runtimeDir,
        target,
        "runtime.json",
        runtimeContent,
        runtimeSecret,
        providerSecret,
      ]) {
        expect(JSON.stringify(body)).not.toContain(leaked);
        expect(body.stderr).not.toContain(leaked);
      }
      expect(credentialDirsBeforeFailure).toHaveLength(1);
      expect(
        (await readdir(RUN_ROOT)).filter((entry) =>
          entry.startsWith(credentialPrefix),
        ),
      ).toHaveLength(0);
      await expect(stat(runtimeDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(sourceRoot, "runtime-setup-ran"))).rejects
        .toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      for (const entry of await readdir(RUN_ROOT)) {
        if (entry.startsWith(credentialPrefix)) {
          await rm(join(RUN_ROOT, entry), { recursive: true, force: true });
        }
      }
      if (runtimeDir !== "") {
        await rm(runtimeDir, { recursive: true, force: true });
      }
    }
  }
});

test("release action rejects malformed runtime secret files before command execution", async () => {
  const secretNames = ["ONLY_SECRET"];
  const cases = [
    {
      label: "mode",
      runtimeSecrets: runtimeSecretsFixture({ mode: 0o644 }),
      message: "runtime secret file mode must be 0600",
    },
    {
      label: "path",
      runtimeSecrets: runtimeSecretsFixture({ path: "../escaped.json" }),
      message: "runtime secret file path is unsafe",
    },
    {
      label: "content",
      runtimeSecrets: runtimeSecretsFixture({
        content: JSON.stringify({ ONLY_SECRET: "fixture-value", EXTRA: "no" }),
        secretNames,
      }),
      message: "runtime secret file content differs from secretNames",
    },
  ] as const;

  for (const invalid of cases) {
    const runId = `release_runtime_secret_invalid_${invalid.label}_${crypto.randomUUID().replace(/-/g, "")}`;
    const root = join(RUN_ROOT, safeRunId(runId));
    try {
      await mkdir(join(root, "source"), { recursive: true });
      const response = await handleRunnerRequest(
        runnerRequest(runId, {
          release: {
            commands: [
              {
                id: "must-not-run",
                command: [process.execPath, "-e", `await Bun.write("ran", "yes")`],
              },
            ],
          },
          runtimeSecrets: invalid.runtimeSecrets,
        }),
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.stderr).toContain(invalid.message);
      await expect(stat(join(root, "source", "ran"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const overrideRunId = `release_runtime_secret_override_${crypto.randomUUID().replace(/-/g, "")}`;
  const overrideRoot = join(RUN_ROOT, safeRunId(overrideRunId));
  try {
    await mkdir(join(overrideRoot, "source"), { recursive: true });
    const response = await handleRunnerRequest(
      runnerRequest(overrideRunId, {
        release: {
          commands: [
            {
              id: "must-not-run",
              command: [process.execPath, "-e", `await Bun.write("ran", "yes")`],
              env: { TAKOS_RUNTIME_SECRETS_FILE: "/tmp/attacker-file" },
            },
          ],
        },
        runtimeSecrets: runtimeSecretsFixture(),
      }),
    );
    expect(response.status).toBe(500);
    expect((await response.json()).stderr).toContain(
      "release command env must not override runtime secret file env",
    );
    await expect(stat(join(overrideRoot, "source", "ran"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(overrideRoot, { recursive: true, force: true });
  }
});

test("release action validates optional SourceSnapshot identity fields", async () => {
  const invalidCases = [
    {
      field: "sourceSnapshotId",
      value: " ",
      message: "release.activation.sourceSnapshotId must be a non-empty string",
    },
    {
      field: "sourceCommit",
      value: "0123456789ABCDEF0123456789ABCDEF01234567",
      message:
        "release.activation.sourceCommit must be a lowercase 40- or 64-character hexadecimal commit",
    },
    {
      field: "sourceCommit",
      value: "0123456789abcdef",
      message:
        "release.activation.sourceCommit must be a lowercase 40- or 64-character hexadecimal commit",
    },
  ] as const;

  for (const [index, invalid] of invalidCases.entries()) {
    const runId = `release_source_identity_invalid_${index}_${crypto.randomUUID().replace(/-/g, "")}`;
    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "should-not-run",
              command: [process.execPath, "-e", `console.log("ran")`],
            },
          ],
        },
        activation: { [invalid.field]: invalid.value },
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.stderr).toContain(invalid.message);
  }

  const lifecycleRunId = `release_source_identity_lifecycle_${crypto.randomUUID().replace(/-/g, "")}`;
  const lifecycleResponse = await handleRunnerRequest(
    runnerRequest(lifecycleRunId, {
      release: {
        commands: [
          {
            id: "should-not-run",
            command: [process.execPath, "-e", `console.log("ran")`],
          },
        ],
      },
      activation: { applyRunId: "apply_1" },
    }),
  );
  expect(lifecycleResponse.status).toBe(500);
  const lifecycleBody = await lifecycleResponse.json();
  expect(lifecycleBody.stderr).toContain(
    "release.activation.sourceSnapshotId and sourceCommit are required for lifecycle releases",
  );
});

test("release action accepts a 64-character SourceSnapshot commit for lifecycle activation", async () => {
  const runId = `release_source_identity_sha256_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const sourceCommit = "a".repeat(64);
  try {
    await mkdir(sourceRoot, { recursive: true });
    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "accept-sha256-source",
              command: [
                process.execPath,
                "-e",
                `if (Bun.env.TAKOSUMI_SOURCE_COMMIT !== ${JSON.stringify(sourceCommit)}) process.exit(11)`,
              ],
            },
          ],
        },
        activation: { sourceSnapshotId: "snap_sha256", sourceCommit },
      }),
    );
    expect(response.status).toBe(200);
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
                  `const providerConfigs = JSON.parse(Bun.env.TAKOSUMI_PROVIDER_CONFIGS_JSON)`,
                  `if (providerConfigs.format !== "takosumi.provider-configurations@v1" || providerConfigs.providers.length !== 0) process.exit(8)`,
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
          manifest: {
            bindings: [
              {
                providerSource: "registry.opentofu.org/cloudflare/cloudflare",
                connectionId: "conn_release_fixture",
                recipeId: "cloudflare",
                authMode: "api_token",
                envNames: ["CLOUDFLARE_API_TOKEN"],
                fileEnvNames: [],
                requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
              },
            ],
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
      "release command env must not include secret-like CLOUDFLARE_API_TOKEN",
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

  const providerConfigsRunId = `release_provider_configs_reserved_${crypto.randomUUID().replace(/-/g, "")}`;
  const providerConfigsRoot = join(RUN_ROOT, safeRunId(providerConfigsRunId));
  try {
    await mkdir(join(providerConfigsRoot, "source"), { recursive: true });
    const response = await handleRunnerRequest(
      runnerRequest(providerConfigsRunId, {
        release: {
          commands: [
            {
              id: "should-not-run",
              command: [process.execPath, "-e", `console.log("ran")`],
              env: { TAKOSUMI_PROVIDER_CONFIGS_JSON: "{}" },
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.stderr).toContain(
      "release command env must not override reserved TAKOSUMI_PROVIDER_CONFIGS_JSON",
    );
  } finally {
    await rm(providerConfigsRoot, { recursive: true, force: true });
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

test("release action keeps SourceSnapshot identity env names reserved", async () => {
  for (const envName of [
    "TAKOSUMI_SOURCE_SNAPSHOT_ID",
    "TAKOSUMI_SOURCE_COMMIT",
  ]) {
    const runId = `release_source_identity_reserved_${crypto.randomUUID().replace(/-/g, "")}`;
    const response = await handleRunnerRequest(
      runnerRequest(runId, {
        release: {
          commands: [
            {
              id: "should-not-run",
              command: [process.execPath, "-e", `console.log("ran")`],
              env: { [envName]: "attempted-override" },
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.stderr).toContain(
      `release command env must not override reserved ${envName}`,
    );
  }
});

test("release action rejects secret-like provider configuration payloads", async () => {
  const secret = "postgres://user:password@example.test/database";
  for (const [suffix, configuration] of [
    ["key", { api_token: "must-never-leak" }],
    ["value", { endpoint: secret }],
  ] as const) {
    const runId = `release_provider_config_secret_${suffix}_${crypto.randomUUID().replace(/-/g, "")}`;
    const root = join(RUN_ROOT, safeRunId(runId));
    try {
      await mkdir(join(root, "source"), { recursive: true });
      const response = await handleRunnerRequest(
        runnerRequest(runId, {
          release: {
            commands: [
              {
                id: "should-not-run",
                command: [process.execPath, "-e", `console.log("ran")`],
              },
            ],
          },
          providerConfigurations: {
            format: "takosumi.provider-configurations@v1",
            providers: [
              {
                provider: "cloudflare/cloudflare",
                alias: null,
                configuration,
              },
            ],
          },
        }),
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.stderr).toContain("secret-like");
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain("must-never-leak");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function runnerRequest(
  runId: string,
  request: unknown,
  signal?: AbortSignal,
): Request {
  return new Request(`https://runner/runs/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "release",
      runId,
      request,
    }),
    ...(signal ? { signal } : {}),
  });
}

interface ReleaseDescendantFixture {
  readonly runId: string;
  readonly root: string;
  readonly sourceRoot: string;
  readonly childPidPath: string;
  readonly runtimePathRecord: string;
  readonly commandStartedPath: string;
  readonly markerPath: string;
  readonly runtimeSecret: string;
  readonly providerSecret: string;
  readonly request: unknown;
}

function releaseDescendantFixture(
  label: string,
  options: {
    readonly childDelayMs: number;
    readonly parentWaitMs: number;
    readonly timeoutSeconds?: number;
  },
): ReleaseDescendantFixture {
  const runId =
    `release_descendant_${label}_${crypto.randomUUID().replace(/-/g, "")}`;
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  const childPidName = `descendant-${label}.pid`;
  const runtimePathRecordName = `runtime-path-${label}.txt`;
  const commandStartedName = `command-started-${label}.txt`;
  const markerName = `descendant-marker-${label}.txt`;
  const runtimeSecret =
    `runtime-descendant-${label}-secret-0123456789abcdef`;
  const providerSecret =
    `provider-descendant-${label}-secret-0123456789abcdef`;
  const parentScript = [
    `(retained_secret="$(cat "$TAKOS_RUNTIME_SECRETS_FILE")"; sleep ${options.childDelayMs / 1_000}; printf '%s' "$retained_secret" > ${JSON.stringify(markerName)}) >/dev/null 2>&1 &`,
    `child_pid=$!`,
    `printf '%s' "$child_pid" > ${JSON.stringify(childPidName)}`,
    `printf '%s' "$TAKOS_RUNTIME_SECRETS_FILE" > ${JSON.stringify(runtimePathRecordName)}`,
    `printf '%s' started > ${JSON.stringify(commandStartedName)}`,
    ...(options.parentWaitMs > 0
      ? [`sleep ${options.parentWaitMs / 1_000}`]
      : []),
  ].join("\n");
  return {
    runId,
    root,
    sourceRoot,
    childPidPath: join(sourceRoot, childPidName),
    runtimePathRecord: join(sourceRoot, runtimePathRecordName),
    commandStartedPath: join(sourceRoot, commandStartedName),
    markerPath: join(sourceRoot, markerName),
    runtimeSecret,
    providerSecret,
    request: {
      release: {
        commands: [
          {
            id: `descendant-${label}`,
            command: ["bash", "-c", parentScript],
            ...(options.timeoutSeconds
              ? { timeoutSeconds: options.timeoutSeconds }
              : {}),
          },
        ],
      },
      credentials: {
        files: [
          {
            path: "provider-token.json",
            mode: 0o600,
            content: providerSecret,
            envName: "CLOUDFLARE_API_TOKEN_FILE",
          },
        ],
        manifest: {
          bindings: [
            {
              providerSource: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: `conn_descendant_${label}`,
              recipeId: "cloudflare",
              authMode: "api_token_file",
              envNames: ["CLOUDFLARE_API_TOKEN_FILE"],
              fileEnvNames: ["CLOUDFLARE_API_TOKEN_FILE"],
              requiredEnvGroups: [["CLOUDFLARE_API_TOKEN_FILE"]],
            },
          ],
          files: [
            {
              path: "provider-token.json",
              mode: 0o600,
              envName: "CLOUDFLARE_API_TOKEN_FILE",
            },
          ],
        },
      },
      runtimeSecrets: runtimeSecretsFixture({
        content: JSON.stringify({ ONLY_SECRET: runtimeSecret }),
      }),
    },
  };
}

async function providerCredentialDirectories(runId: string): Promise<string[]> {
  const prefix = `${safeRunId(runId)}-credentials-`;
  return (await readdir(RUN_ROOT)).filter((entry) => entry.startsWith(prefix));
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error("release descendant fixture did not start");
}

async function processIsGone(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(20);
    } catch {
      return true;
    }
  }
  return false;
}

async function killFixtureProcess(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already terminated by the isolated process group under test.
  }
}

async function cleanupReleaseDescendantFixture(
  fixture: ReleaseDescendantFixture,
): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
  for (const directory of await providerCredentialDirectories(fixture.runId)) {
    await rm(join(RUN_ROOT, directory), { recursive: true, force: true });
  }
}

function assertReleaseDescendantResponseIsValueFree(
  body: Record<string, unknown>,
  fixture: ReleaseDescendantFixture,
  runtimePath: string,
): void {
  for (const value of [
    fixture.root,
    runtimePath,
    fixture.runtimeSecret,
    fixture.providerSecret,
  ]) {
    expect(JSON.stringify(body)).not.toContain(value);
  }
}

function runtimeSecretsFixture(
  fileOverrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    contract: "takosumi.runner-runtime-secret-files/v1",
    profileDigest: `sha256:${"a".repeat(64)}`,
    files: [
      {
        path: "runtime.json",
        mode: 0o600,
        content: JSON.stringify({ ONLY_SECRET: "fixture-value" }),
        envName: "TAKOS_RUNTIME_SECRETS_FILE",
        secretNames: ["ONLY_SECRET"],
        ...fileOverrides,
      },
    ],
  };
}
