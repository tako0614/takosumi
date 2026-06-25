import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWranglerR2GetArgs,
  parsePayload,
  runReleaseActivation,
} from "../../scripts/operator-release-activator.ts";

test("operator release activator builds remote R2 object fetch args", () => {
  expect(
    buildWranglerR2GetArgs({
      bucket: "takosumi-sources",
      key: "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
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
    "takosumi-sources/spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
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
  ).toThrow("release command env must not include CLOUDFLARE_API_TOKEN");

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
  ).toThrow("release command env must not include activator token");

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
              `await Bun.write(Bun.env.ACTIVATION_RESULT_FILE, [Bun.env.TAKOSUMI_APPLY_RUN_ID, outputs.public_url, context.outputs.public_url, context.applyRunId, context.deployment.id, leakedProvider, leakedToken, process.cwd().split("/").pop()].join(":"))`,
            ].join(";"),
          ],
          env: { ACTIVATION_RESULT_FILE: resultPath },
        }),
        sourceSnapshot: {
          archiveObjectKey:
            "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
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
      "run_apply_1:https://app.example.test:https://app.example.test:run_apply_1:dep_1:missing:missing:source",
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
          archiveObjectKey:
            "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
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
        archiveObjectKey:
          "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
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

function validPayload(
  command: {
    readonly command?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly executor?: "operator" | "runner";
  } = {},
): Record<string, unknown> {
  return {
    kind: "takosumi.operator.release-activation@v1",
    applyRunId: "run_apply_1",
    installation: { id: "inst_1", name: "site" },
    deployment: { id: "dep_1" },
    sourceSnapshot: {
      archiveObjectKey:
        "spaces/space_1/sources/src_1/snapshots/snap_1/source.tar.zst",
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
