import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandContextFromRequest, prepareProviderCredentialFiles } from "../../runner/lib/credentials.ts";
import { runCommand, runOpenTofuCommand } from "../../runner/lib/exec.ts";
import { gitRevParseHead } from "../../runner/lib/source_sync.ts";
import { runSourceBuild } from "../../runner/entrypoint.ts";

const grant = "signed-private-run-file-grant";
const descriptor = [{
  slot: "worker-state",
  endpoint: "https://core.example/internal/private-run-files/v1",
  grant,
}];

test("private Run file grant env reaches only explicit OpenTofu invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-file-env-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const tofuPath = join(bin, "tofu");
  await writeFile(tofuPath, "#!/bin/sh\nif [ -n \"$TAKOSUMI_PRIVATE_RUN_FILES_FILE\" ]; then cat \"$TAKOSUMI_PRIVATE_RUN_FILES_FILE\"; fi\n");
  await chmod(tofuPath, 0o700);
  const gitPath = join(bin, "git");
  await writeFile(gitPath, "#!/bin/sh\nif [ -n \"$TAKOSUMI_PRIVATE_RUN_FILES\" ] || [ -n \"$TAKOSUMI_PRIVATE_RUN_FILES_FILE\" ]; then exit 9; fi\nprintf '0123456789abcdef0123456789abcdef01234567'\n");
  await chmod(gitPath, 0o700);
  const runId = "run_private_grant";
  const requestContext = commandContextFromRequest(
    { privateRunFiles: descriptor }, undefined, undefined, runId,
  );
  const context = {
    ...requestContext,
    env: { ...requestContext.env, PATH: `${bin}:/usr/bin:/bin` },
  };

  try {
    const prepared = await prepareProviderCredentialFiles(context, {
      root,
      sourceRoot: root,
      generatedRootDir: root,
      moduleDir: root,
      planPath: join(root, "tfplan"),
      providerLockfilePath: join(root, "lock.hcl"),
      restoredStatePath: join(root, "state.json"),
      moduleInfoPath: join(root, "module.json"),
      childModuleDir: join(root, "child"),
      artifactDir: join(root, "artifacts"),
      depsDir: join(root, "deps"),
    }, runId);
    try {
      const tofu = await runOpenTofuCommand(["tofu", "plan"], {
        cwd: root,
        context: prepared.context,
      });
      expect(tofu.exitCode).toBe(0);
      expect(tofu.stdout).toBe(JSON.stringify({ version: 1, sequence: 0, files: descriptor }));

      const ordinary = await runCommand(["tofu", "plan"], {
        cwd: root,
        context: prepared.context,
      });
      expect(ordinary.exitCode).toBe(0);
      expect(ordinary.stdout).toBe("");

      expect(await gitRevParseHead(root, prepared.context)).toBe(
        "0123456789abcdef0123456789abcdef01234567",
      );
      expect(prepared.context.env.TAKOSUMI_PRIVATE_RUN_FILES_FILE).toBeUndefined();
      expect(prepared.context.privateRunFilesFile).toBeDefined();
    } finally {
      await prepared.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-build subprocesses do not inherit private Run file grant env", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-file-source-build-"));
  const sourceRoot = join(root, "source");
  const previousGrant = Bun.env.TAKOSUMI_PRIVATE_RUN_FILES;
  const previousFile = Bun.env.TAKOSUMI_PRIVATE_RUN_FILES_FILE;
  try {
    await mkdir(sourceRoot);
    Bun.env.TAKOSUMI_PRIVATE_RUN_FILES = JSON.stringify(descriptor);
    Bun.env.TAKOSUMI_PRIVATE_RUN_FILES_FILE = "/private/runner/path/descriptor.json";
    await runSourceBuild({
      commands: [{
        argv: [
          process.execPath,
          "-e",
          `import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", {recursive:true}); writeFileSync("dist/env.txt", JSON.stringify({static:process.env.TAKOSUMI_PRIVATE_RUN_FILES ?? "absent",file:process.env.TAKOSUMI_PRIVATE_RUN_FILES_FILE ?? "absent"}));`,
        ],
      }],
      outputs: ["dist/env.txt"],
    }, sourceRoot);
    expect(await readFile(join(sourceRoot, "dist/env.txt"), "utf8")).toBe(
      JSON.stringify({ static: "absent", file: "absent" }),
    );
  } finally {
    if (previousGrant === undefined) delete Bun.env.TAKOSUMI_PRIVATE_RUN_FILES;
    else Bun.env.TAKOSUMI_PRIVATE_RUN_FILES = previousGrant;
    if (previousFile === undefined) delete Bun.env.TAKOSUMI_PRIVATE_RUN_FILES_FILE;
    else Bun.env.TAKOSUMI_PRIVATE_RUN_FILES_FILE = previousFile;
    await rm(root, { recursive: true, force: true });
  }
});
