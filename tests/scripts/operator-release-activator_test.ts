import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  buildWranglerR2GetArgs,
  createReleaseActivatorFetchHandler,
  loadReleaseActivatorTokenFile,
  parsePayload,
  parseReleaseActivatorTokenConfig,
  releaseActivatorChildEnv,
  runReleaseActivation,
} from "../../scripts/operator-release-activator.ts";

const LEGACY_ACTIVATOR_TOKEN = "legacy_5ybGqZ1Hfx8nVc4Mt2Kr9Pw7Ld3Sj6Ua";
const PRODUCTION_ACTIVATOR_TOKEN = "production_7mQ2xK9cV4pL8sD1fH6jN3rT5wY0bGz";
const STAGING_ACTIVATOR_TOKEN = "staging_4vN8kR2mX7cP1sL6hD9qT3yF5wJ0bGa";

test("operator release activator help exits successfully", () => {
  const result = spawnSync(
    "bun",
    ["scripts/operator-release-activator.ts", "--help"],
    {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "usage: operator-release-activator.ts <serve|run|tokens-check> ...",
  );
  expect(result.stderr).toBe("");
});

test("operator release activator rejects a raw token argument in every mode", () => {
  for (const mode of ["run", "serve", "tokens-check"]) {
    for (const tokenArgs of [
      ["--token", LEGACY_ACTIVATOR_TOKEN],
      [`--token=${LEGACY_ACTIVATOR_TOKEN}`],
    ]) {
      const result = spawnSync(
        "bun",
        ["scripts/operator-release-activator.ts", mode, ...tokenArgs],
        {
          cwd: new URL("../..", import.meta.url),
          encoding: "utf8",
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "--token is forbidden because secret values must not be passed in argv",
      );
      expect(result.stdout).not.toContain(LEGACY_ACTIVATOR_TOKEN);
      expect(result.stderr).not.toContain(LEGACY_ACTIVATOR_TOKEN);
    }
  }
});

test("operator release activator builds remote R2 object fetch args", () => {
  expect(
    buildWranglerR2GetArgs({
      bucket: "takosumi-sources",
      key: "workspaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
      file: "/tmp/source.tar.zst",
      config: "../takosumi-private/platform/wrangler.staging.toml",
      env: "staging",
      jurisdiction: "eu",
    }),
  ).toEqual([
    "wrangler",
    "r2",
    "object",
    "get",
    "takosumi-sources/workspaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
    "--file",
    "/tmp/source.tar.zst",
    "--remote",
    "--config",
    "../takosumi-private/platform/wrangler.staging.toml",
    "--env",
    "staging",
    "--jurisdiction",
    "eu",
  ]);
});

test("operator release activator rejects credential and reserved command env", () => {
  expect(() =>
    parsePayload(
      validPayload({
        env: { CLOUDFLARE_API_TOKEN: "secret" },
      }),
    ),
  ).toThrow(
    "release command env must not include secret-like CLOUDFLARE_API_TOKEN",
  );

  expect(() =>
    parsePayload(
      validPayload({
        env: { TAKOSUMI_OUTPUTS_JSON: "{}" },
      }),
    ),
  ).toThrow(
    "release command env must not override reserved TAKOSUMI_OUTPUTS_JSON",
  );

  expect(() =>
    parsePayload(
      validPayload({
        env: { TAKOSUMI_RELEASE_ACTIVATOR_TOKEN: "secret" },
      }),
    ),
  ).toThrow(
    "release command env must not include activator authentication config",
  );

  expect(() =>
    parsePayload(
      validPayload({
        env: { DATABASE_URL: "postgres://localhost/example" },
      }),
    ),
  ).toThrow("release command env must not include secret-like DATABASE_URL");

  expect(() =>
    parsePayload(
      validPayload({
        env: { RELEASE_TARGET: "postgres://user:pass@db.example/app" },
      }),
    ),
  ).toThrow("release command env value for RELEASE_TARGET looks secret-like");
});

test("operator release activator rejects Provider Connection credentials", () => {
  expect(() =>
    parsePayload({
      ...validPayload(),
      credentials: {
        env: {
          ACME_CLIENT_CREDENTIAL: "must-not-cross-operator-boundary",
        },
      },
    }),
  ).toThrow(
    "operator release activation payload must not include Provider Connection credentials",
  );
});

test("operator release activator rejects non-operator commands", () => {
  expect(() =>
    parsePayload(
      validPayload({
        executor: "runner",
      }),
    ),
  ).toThrow(
    "commands[0].executor must be operator for operator release activation",
  );

  const payload = validPayload();
  const command = (payload.commands as Record<string, unknown>[])[0]!;
  delete command.executor;
  expect(() => parsePayload(payload)).toThrow(
    "commands[0].executor must be operator for operator release activation",
  );
});

test("operator release activator accepts only the canonical v2 identity model", () => {
  expect(() =>
    parsePayload({
      ...validPayload(),
      kind: "takosumi.operator.release-activation@v1",
    }),
  ).toThrow("release activation payload kind is invalid");

  const legacyPayload = validPayload();
  delete legacyPayload.workspaceId;
  delete legacyPayload.capsule;
  delete legacyPayload.stateVersion;
  delete legacyPayload.output;
  legacyPayload.spaceId = "space_1";
  legacyPayload.installation = { id: "inst_1" };
  legacyPayload.deployment = { id: "dep_1" };

  expect(() => parsePayload(legacyPayload)).toThrow(
    "workspaceId must be a non-empty string",
  );
});

test("operator release activator restores source archive and runs opaque argv only", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-operator-release-"));
  try {
    const sourceDir = join(tempDir, "src");
    const archivePath = join(tempDir, "source.tar.zst");
    const resultPath = join(tempDir, "activation-result.txt");
    await mkdir(join(sourceDir, "scripts"), { recursive: true });
    await writeFile(
      join(sourceDir, "scripts", "placeholder.txt"),
      "plain OpenTofu source\n",
    );
    createArchive(sourceDir, archivePath);
    const digest = await sha256File(archivePath);

    const result = await runReleaseActivation(
      {
        ...validPayload({
          command: [
            process.execPath,
            "-e",
            [
              `const outputs = JSON.parse(Bun.env.TAKOSUMI_OUTPUTS_JSON)`,
              `const context = JSON.parse(Bun.env.TAKOSUMI_RELEASE_CONTEXT_JSON)`,
              `const leakedProvider = Bun.env.CLOUDFLARE_API_TOKEN ?? "missing"`,
              `const leakedToken = Bun.env.TAKOSUMI_RELEASE_ACTIVATOR_TOKEN ?? "missing"`,
              `await Bun.write(Bun.env.ACTIVATION_RESULT_FILE, [Bun.env.TAKOSUMI_APPLY_RUN_ID, outputs.public_url, context.outputs.public_url, context.applyRunId, context.workspaceId, Bun.env.TAKOSUMI_WORKSPACE_ID, context.capsuleId, Bun.env.TAKOSUMI_CAPSULE_ID, context.stateVersionId, Bun.env.TAKOSUMI_STATE_VERSION_ID, context.outputId, leakedProvider, leakedToken, process.cwd().split("/").pop()].join(":"))`,
            ].join(";"),
          ],
          env: { ACTIVATION_RESULT_FILE: resultPath },
        }),
        sourceSnapshot: {
          archiveRef:
            "workspaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
          archiveDigest: digest,
        },
      },
      {
        commandEnv: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLOUDFLARE_API_TOKEN: "must-not-leak",
          TAKOSUMI_RELEASE_ACTIVATOR_TOKEN: "must-not-leak",
        },
        downloadArchive: async (_payload, targetPath) => {
          await writeFile(targetPath, await readFile(archivePath));
        },
        workRoot: join(tempDir, "work"),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      kind: "takosumi.operator.release-commands@v1",
      metadata: {
        applyRunId: "run_apply_1",
        commandCount: 1,
        commandIds: ["publish"],
      },
    });
    await expect(readFile(resultPath, "utf8")).resolves.toBe(
      "run_apply_1:https://app.example.test:https://app.example.test:run_apply_1:space_1:space_1:inst_1:inst_1:state_1:state_1:out_1:missing:missing:source",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("operator release activator forwards only explicitly allowlisted operator env", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "takosumi-operator-release-env-"),
  );
  try {
    const sourceDir = join(tempDir, "src");
    const archivePath = join(tempDir, "source.tar.zst");
    const resultPath = join(tempDir, "activation-env.txt");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "app.txt"), "plain source\n");
    createArchive(sourceDir, archivePath);
    const digest = await sha256File(archivePath);

    const result = await runReleaseActivation(
      {
        ...validPayload({
          command: [
            process.execPath,
            "-e",
            [
              `await Bun.write(Bun.env.ACTIVATION_RESULT_FILE, [Bun.env.CLOUDFLARE_API_TOKEN ?? "missing", Bun.env.CLOUDFLARE_ACCOUNT_ID ?? "missing", Bun.env.NOT_ALLOWLISTED ?? "missing", Bun.env.TAKOSUMI_APPLY_RUN_ID].join(":"))`,
            ].join(";"),
          ],
          env: { ACTIVATION_RESULT_FILE: resultPath },
        }),
        sourceSnapshot: {
          archiveRef:
            "workspaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
          archiveDigest: digest,
        },
      },
      {
        commandEnv: {
          PATH: process.env.PATH,
          CLOUDFLARE_API_TOKEN: "operator-token",
          CLOUDFLARE_ACCOUNT_ID: "operator-account",
          NOT_ALLOWLISTED: "must-not-forward",
        },
        commandEnvAllowlist: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
        downloadArchive: async (_payload, targetPath) => {
          await writeFile(targetPath, await readFile(archivePath));
        },
        workRoot: join(tempDir, "work"),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      kind: "takosumi.operator.release-commands@v1",
      metadata: {
        applyRunId: "run_apply_1",
        commandCount: 1,
        commandIds: ["publish"],
      },
    });
    await expect(readFile(resultPath, "utf8")).resolves.toBe(
      "operator-token:operator-account:missing:run_apply_1",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("operator release activator redacts explicitly allowlisted operator secrets on failure", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "takosumi-operator-release-redaction-"),
  );
  try {
    const sourceDir = join(tempDir, "src");
    const archivePath = join(tempDir, "source.tar.zst");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "app.txt"), "plain source\n");
    createArchive(sourceDir, archivePath);
    const digest = await sha256File(archivePath);
    const operatorToken = "operator-token-to-redact";

    await expect(
      runReleaseActivation(
        {
          ...validPayload({
            command: [
              process.execPath,
              "-e",
              [
                `console.log("stdout " + Bun.env.CLOUDFLARE_API_TOKEN)`,
                `console.error("stderr " + Bun.env.CLOUDFLARE_API_TOKEN)`,
                `process.exit(1)`,
              ].join(";"),
            ],
          }),
          sourceSnapshot: {
            archiveRef:
              "workspaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
            archiveDigest: digest,
          },
        },
        {
          commandEnv: {
            PATH: process.env.PATH,
            CLOUDFLARE_API_TOKEN: operatorToken,
          },
          commandEnvAllowlist: ["CLOUDFLARE_API_TOKEN"],
          downloadArchive: async (_payload, targetPath) => {
            await writeFile(targetPath, await readFile(archivePath));
          },
          workRoot: join(tempDir, "work"),
        },
      ),
    ).rejects.toThrow("stdout [REDACTED]");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("operator release activator pins temporary and Bun cache dirs to the job workdir", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "takosumi-operator-release-runtime-"),
  );
  try {
    const sourceDir = join(tempDir, "src");
    const archivePath = join(tempDir, "source.tar.zst");
    const resultPath = join(tempDir, "activation-runtime.txt");
    const workRoot = join(tempDir, "work");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "app.txt"), "plain source\n");
    createArchive(sourceDir, archivePath);
    const digest = await sha256File(archivePath);

    const result = await runReleaseActivation(
      {
        ...validPayload({
          command: [
            process.execPath,
            "-e",
            [
              `const names = ["TMPDIR", "TEMP", "TMP", "BUN_INSTALL_CACHE_DIR", "BUN_TMPDIR", "XDG_CACHE_HOME", "NODE_COMPILE_CACHE"]`,
              `await Bun.write(Bun.env.ACTIVATION_RESULT_FILE, names.map((name) => name + "=" + Bun.env[name]).join("\\n"))`,
            ].join(";"),
          ],
          env: { ACTIVATION_RESULT_FILE: resultPath },
        }),
        sourceSnapshot: {
          archiveRef:
            "workspaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
          archiveDigest: digest,
        },
      },
      {
        commandEnv: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: "/tmp/parent-tmp-must-not-leak",
          BUN_INSTALL_CACHE_DIR: "/tmp/parent-cache-must-not-leak",
        },
        downloadArchive: async (_payload, targetPath) => {
          await writeFile(targetPath, await readFile(archivePath));
        },
        workRoot,
      },
    );

    expect(result.status).toBe("succeeded");
    const values = (await readFile(resultPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split("=").at(1) ?? "");
    expect(values.length).toBe(7);
    for (const value of values) {
      expect(value.startsWith(workRoot)).toBe(true);
      expect(value).toContain("/release-");
      expect(value).not.toContain("parent-tmp-must-not-leak");
      expect(value).not.toContain("parent-cache-must-not-leak");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("operator release activator accepts async jobs and exposes status", async () => {
  let invoked = 0;
  const handler = createReleaseActivatorFetchHandler({
    token: LEGACY_ACTIVATOR_TOKEN,
    host: "127.0.0.1",
    port: 8797,
    runActivation: async () => {
      invoked += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        status: "succeeded",
        kind: "takosumi.operator.release-commands@v1",
        message: "ran 1 operator release command(s)",
        metadata: { commandCount: 1 },
      };
    },
  });
  const post = await handler(
    new Request("http://localhost/activate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${LEGACY_ACTIVATOR_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(validPayload()),
    }),
  );

  expect(post.status).toBe(202);
  const accepted = (await post.json()) as {
    readonly status: string;
    readonly jobId: string;
    readonly statusUrl: string;
  };
  expect(accepted.status).toBe("pending");
  expect(accepted.jobId).toStartWith("rel_");
  expect(accepted.statusUrl).toContain(`jobId=${accepted.jobId}`);

  let latest:
    { readonly status: string; readonly message?: string } | undefined;
  for (let index = 0; index < 20; index += 1) {
    const status = await handler(
      new Request(accepted.statusUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${LEGACY_ACTIVATOR_TOKEN}` },
      }),
    );
    expect(status.status).toBe(200);
    latest = (await status.json()) as {
      readonly status: string;
      readonly message?: string;
    };
    if (latest.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  expect(invoked).toBe(1);
  expect(latest).toMatchObject({
    status: "succeeded",
    message: "ran 1 operator release command(s)",
  });
});

test("operator release activator isolates identical jobs by token label and principal", async () => {
  let invoked = 0;
  const handler = createReleaseActivatorFetchHandler({
    tokens: [
      {
        label: "production",
        principal: "takosumi-cloud/production",
        token: PRODUCTION_ACTIVATOR_TOKEN,
      },
      {
        label: "staging",
        principal: "takosumi-cloud/staging",
        token: STAGING_ACTIVATOR_TOKEN,
      },
    ],
    host: "127.0.0.1",
    port: 8797,
    runActivation: async (_payload, options) => {
      invoked += 1;
      expect("token" in options).toBe(false);
      expect("tokens" in options).toBe(false);
      return {
        status: "succeeded",
        kind: "takosumi.operator.release-commands@v1",
        message: "isolated activation succeeded",
      };
    },
  });
  const postFor = async (token: string) =>
    handler(
      new Request("http://localhost/activate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(validPayload()),
      }),
    );

  const productionPost = await postFor(PRODUCTION_ACTIVATOR_TOKEN);
  expect(productionPost.status).toBe(202);
  const productionJob = (await productionPost.json()) as {
    readonly jobId: string;
    readonly statusUrl: string;
    readonly metadata: {
      readonly tokenLabel: string;
      readonly principal: string;
    };
  };
  expect(productionJob.metadata).toMatchObject({
    tokenLabel: "production",
    principal: "takosumi-cloud/production",
  });

  const crossPrincipalRead = await handler(
    new Request(productionJob.statusUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${STAGING_ACTIVATOR_TOKEN}` },
    }),
  );
  expect(crossPrincipalRead.status).toBe(404);

  const stagingPost = await postFor(STAGING_ACTIVATOR_TOKEN);
  expect(stagingPost.status).toBe(202);
  const stagingJob = (await stagingPost.json()) as {
    readonly jobId: string;
    readonly statusUrl: string;
    readonly metadata: {
      readonly tokenLabel: string;
      readonly principal: string;
    };
  };
  expect(stagingJob.jobId).not.toBe(productionJob.jobId);
  expect(stagingJob.metadata).toMatchObject({
    tokenLabel: "staging",
    principal: "takosumi-cloud/staging",
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const productionRead = await handler(
    new Request(productionJob.statusUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${PRODUCTION_ACTIVATOR_TOKEN}` },
    }),
  );
  const stagingRead = await handler(
    new Request(stagingJob.statusUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${STAGING_ACTIVATOR_TOKEN}` },
    }),
  );
  expect(productionRead.status).toBe(200);
  expect(stagingRead.status).toBe(200);
  expect(await productionRead.json()).toMatchObject({
    status: "succeeded",
    metadata: {
      tokenLabel: "production",
      principal: "takosumi-cloud/production",
    },
  });
  expect(await stagingRead.json()).toMatchObject({
    status: "succeeded",
    metadata: {
      tokenLabel: "staging",
      principal: "takosumi-cloud/staging",
    },
  });
  expect(invoked).toBe(2);
});

test("operator release activator rejects invalid auth without length-sensitive comparison errors", async () => {
  const handler = createReleaseActivatorFetchHandler({
    tokens: [
      {
        label: "production",
        principal: "takosumi-cloud/production",
        token: PRODUCTION_ACTIVATOR_TOKEN,
      },
    ],
    host: "127.0.0.1",
    port: 8797,
  });
  for (const authorization of ["", "Bearer x", "Basic ignored"]) {
    const response = await handler(
      new Request("http://localhost/activate", {
        method: "POST",
        headers: authorization ? { authorization } : {},
      }),
    );
    expect(response.status).toBe(401);
  }
});

test("operator release activator token config fails closed on invalid duplicate or weak entries", () => {
  const valid = {
    kind: "takosumi.operator.release-activator-tokens@v1",
    tokens: [
      {
        label: "production",
        principal: "takosumi-cloud/production",
        token: PRODUCTION_ACTIVATOR_TOKEN,
      },
    ],
  };
  expect(parseReleaseActivatorTokenConfig(valid)).toHaveLength(1);
  expect(() =>
    parseReleaseActivatorTokenConfig({ ...valid, unexpected: true }),
  ).toThrow("release activator token file fields are invalid");
  expect(() =>
    parseReleaseActivatorTokenConfig({
      ...valid,
      tokens: [{ ...valid.tokens[0], token: "short-token" }],
    }),
  ).toThrow("tokens[0].token is weak or invalid");
  expect(() =>
    parseReleaseActivatorTokenConfig({
      ...valid,
      tokens: [valid.tokens[0], { ...valid.tokens[0] }],
    }),
  ).toThrow("release activator token labels must be unique");
  expect(() =>
    parseReleaseActivatorTokenConfig({
      ...valid,
      tokens: [
        valid.tokens[0],
        {
          label: "staging",
          principal: "takosumi-cloud/production",
          token: STAGING_ACTIVATOR_TOKEN,
        },
      ],
    }),
  ).toThrow("release activator token principals must be unique");
  expect(() =>
    parseReleaseActivatorTokenConfig({
      ...valid,
      tokens: [
        valid.tokens[0],
        {
          label: "staging",
          principal: "takosumi-cloud/staging",
          token: PRODUCTION_ACTIVATOR_TOKEN,
        },
      ],
    }),
  ).toThrow("release activator token secrets must be unique");
  expect(() =>
    createReleaseActivatorFetchHandler({
      token: LEGACY_ACTIVATOR_TOKEN,
      tokens: valid.tokens,
      host: "127.0.0.1",
      port: 8797,
    }),
  ).toThrow(
    "release activator legacy token and token map are mutually exclusive",
  );
});

test("operator release activator reads only a repo-external 0600 token file and CLI redacts secrets", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-activator-tokens-"));
  try {
    const tokenFile = join(tempDir, "tokens.json");
    await writeFile(
      tokenFile,
      JSON.stringify({
        kind: "takosumi.operator.release-activator-tokens@v1",
        tokens: [
          {
            label: "production",
            principal: "takosumi-cloud/production",
            token: PRODUCTION_ACTIVATOR_TOKEN,
          },
          {
            label: "staging",
            principal: "takosumi-cloud/staging",
            token: STAGING_ACTIVATOR_TOKEN,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(tokenFile, 0o600);
    await expect(
      loadReleaseActivatorTokenFile(tokenFile),
    ).resolves.toHaveLength(2);

    const childEnv = { ...process.env };
    delete childEnv.TAKOSUMI_RELEASE_ACTIVATOR_TOKEN;
    delete childEnv.TAKOSUMI_RELEASE_ACTIVATOR_TOKEN_FILE;
    const check = spawnSync(
      "bun",
      [
        "scripts/operator-release-activator.ts",
        "tokens-check",
        "--token-file",
        tokenFile,
      ],
      {
        cwd: new URL("../..", import.meta.url),
        encoding: "utf8",
        env: childEnv,
      },
    );
    expect(check.status).toBe(0);
    expect(check.stderr).toBe("");
    expect(check.stdout).toContain('"tokenCount": 2');
    expect(check.stdout).toContain('"label": "production"');
    expect(check.stdout).toContain('"principal": "takosumi-cloud/staging"');
    expect(check.stdout).not.toContain(PRODUCTION_ACTIVATOR_TOKEN);
    expect(check.stdout).not.toContain(STAGING_ACTIVATOR_TOKEN);

    await chmod(tokenFile, 0o640);
    await expect(loadReleaseActivatorTokenFile(tokenFile)).rejects.toThrow(
      "release activator token file must have mode 0600",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("operator release activator strips authentication config from child env", () => {
  expect(
    releaseActivatorChildEnv({
      PATH: "/usr/bin",
      TAKOSUMI_RELEASE_ACTIVATOR_TOKEN: LEGACY_ACTIVATOR_TOKEN,
      TAKOSUMI_RELEASE_ACTIVATOR_TOKEN_FILE: "/run/secrets/tokens.json",
    }),
  ).toEqual({ PATH: "/usr/bin" });
});

test("operator release activator rejects reserved operator env allowlist entries", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "takosumi-operator-release-env-"),
  );
  try {
    const sourceDir = join(tempDir, "src");
    const archivePath = join(tempDir, "source.tar.zst");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "app.txt"), "plain source\n");
    createArchive(sourceDir, archivePath);
    const digest = await sha256File(archivePath);
    const payload = {
      ...validPayload(),
      sourceSnapshot: {
        archiveRef:
          "workspaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
        archiveDigest: digest,
      },
    };

    await expect(
      runReleaseActivation(payload, {
        commandEnv: { TAKOSUMI_OUTPUTS_JSON: "{}" },
        commandEnvAllowlist: ["TAKOSUMI_OUTPUTS_JSON"],
        downloadArchive: async (_payload, targetPath) => {
          await writeFile(targetPath, await readFile(archivePath));
        },
        workRoot: join(tempDir, "work-reserved"),
      }),
    ).rejects.toThrow(
      "release command env allowlist must not include reserved TAKOSUMI_OUTPUTS_JSON",
    );

    await expect(
      runReleaseActivation(payload, {
        commandEnv: { "bad-name": "value" },
        commandEnvAllowlist: ["bad-name"],
        downloadArchive: async (_payload, targetPath) => {
          await writeFile(targetPath, await readFile(archivePath));
        },
        workRoot: join(tempDir, "work-invalid"),
      }),
    ).rejects.toThrow(
      "release command env allowlist entry is invalid: bad-name",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("operator release activator accepts a safe source archive bucket hint", async () => {
  const payload = validPayload();
  (payload.sourceSnapshot as Record<string, unknown>).archiveBucket =
    "takosumi-source-staging";

  const parsed = parsePayload(payload);

  expect(parsed.sourceSnapshot.archiveBucket).toBe("takosumi-source-staging");
});

test("operator release activator rejects unsafe source archive bucket hints", () => {
  const payload = validPayload();
  (payload.sourceSnapshot as Record<string, unknown>).archiveBucket =
    "../takosumi-source";

  expect(() => parsePayload(payload)).toThrow(
    "sourceSnapshot.archiveBucket is invalid",
  );
});

test("operator release activator passes the source archive bucket hint to downloads", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-release-bucket-"));
  try {
    const sourceDir = join(tempDir, "src");
    const archivePath = join(tempDir, "source.tar.zst");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "app.txt"), "plain source\n");
    createArchive(sourceDir, archivePath);
    const digest = await sha256File(archivePath);
    const payload = validPayload();
    (payload.sourceSnapshot as Record<string, unknown>).archiveBucket =
      "takosumi-source-staging";
    (payload.sourceSnapshot as Record<string, unknown>).archiveDigest = digest;
    let observedBucket = "";

    await runReleaseActivation(payload, {
      downloadArchive: async (activationPayload, targetPath) => {
        observedBucket =
          activationPayload.sourceSnapshot.archiveBucket ?? "missing";
        await writeFile(targetPath, await readFile(archivePath));
      },
      sourceBucket: "takosumi-source",
      sourceBucketAllowlist: ["takosumi-source-staging"],
      workRoot: join(tempDir, "work"),
    });

    expect(observedBucket).toBe("takosumi-source-staging");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function validPayload(
  command: {
    readonly command?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly executor?: "operator" | "runner";
  } = {},
): Record<string, unknown> {
  return {
    kind: "takosumi.operator.release-activation@v2",
    planRunId: "run_plan_1",
    applyRunId: "run_apply_1",
    workspaceId: "space_1",
    capsule: {
      id: "inst_1",
      name: "site",
      environment: "production",
      sourceId: "src_1",
      installConfigId: "cfg_1",
    },
    stateVersion: {
      id: "state_1",
      generation: 3,
      digest: "sha256:state",
      createdByRunId: "run_apply_1",
    },
    output: {
      id: "out_1",
      stateGeneration: 3,
      outputDigest: "sha256:outputs",
    },
    sourceSnapshot: {
      archiveRef:
        "workspaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
      archiveDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    nonSensitiveOutputs: {
      public_url: "https://app.example.test",
    },
    commands: [
      {
        id: "publish",
        executor: command.executor ?? "operator",
        command: command.command ?? [process.execPath, "-e", "console.log(1)"],
        ...(command.env ? { env: command.env } : {}),
      },
    ],
  };
}

function createArchive(sourceDir: string, archivePath: string): void {
  const result = spawnSync(
    "tar",
    ["--zstd", "-cf", archivePath, "-C", sourceDir, "."],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`tar archive failed: ${result.stderr}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
}
