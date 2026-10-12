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
  await writeFile(tofuPath, "#!/bin/sh\nprintf '%s' \"$TAKOSUMI_PRIVATE_RUN_FILES\"\n");
  await chmod(tofuPath, 0o700);
  const gitPath = join(bin, "git");
  await writeFile(gitPath, "#!/bin/sh\nif [ -n \"$TAKOSUMI_PRIVATE_RUN_FILES\" ]; then exit 9; fi\nprintf '0123456789abcdef0123456789abcdef01234567'\n");
  await chmod(gitPath, 0o700);
  const requestContext = commandContextFromRequest({ privateRunFiles: descriptor });
  const context = {
    ...requestContext,
    env: { ...requestContext.env, PATH: bin },
  };

  try {
    const tofu = await runOpenTofuCommand(["tofu", "plan"], {
      cwd: root,
      context,
    });
    expect(tofu.exitCode).toBe(0);
    expect(tofu.stdout).toBe(JSON.stringify(descriptor));

    const ordinary = await runCommand(["tofu", "plan"], {
      cwd: root,
      context,
    });
    expect(ordinary.exitCode).toBe(0);
    expect(ordinary.stdout).toBe("");

    expect(await gitRevParseHead(root, context)).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    const credentialManifest = {
      bindings: [],
      files: [{ path: "provider.json", mode: 0o600, envName: "PROVIDER_FILE" }],
    };
    const prepared = await prepareProviderCredentialFiles({
      ...context,
      credentialManifest,
      credentialFiles: [{
        path: "provider.json",
        mode: 0o600,
        envName: "PROVIDER_FILE",
        content: "provider-secret",
      }],
    }, {
      root,
      sourceRoot: root,
      generatedRootDir: root,
      moduleDir: root,
      planPath: join(root, "tfplan"),
    }, "run_private_grant");
    try {
      expect(prepared.context.env.TAKOSUMI_PRIVATE_RUN_FILES).toBeUndefined();
      expect(prepared.context.env.PROVIDER_FILE).toBeDefined();
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
  try {
    await mkdir(sourceRoot);
    Bun.env.TAKOSUMI_PRIVATE_RUN_FILES = JSON.stringify(descriptor);
    await runSourceBuild({
      commands: [{
        argv: [
          process.execPath,
          "-e",
          `import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", {recursive:true}); writeFileSync("dist/env.txt", process.env.TAKOSUMI_PRIVATE_RUN_FILES ?? "absent");`,
        ],
      }],
      outputs: ["dist/env.txt"],
    }, sourceRoot);
    expect(await readFile(join(sourceRoot, "dist/env.txt"), "utf8")).toBe("absent");
  } finally {
    if (previousGrant === undefined) delete Bun.env.TAKOSUMI_PRIVATE_RUN_FILES;
    else Bun.env.TAKOSUMI_PRIVATE_RUN_FILES = previousGrant;
    await rm(root, { recursive: true, force: true });
  }
});
