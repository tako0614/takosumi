import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPhaseHome } from "../../runner/lib/phase_home.ts";
import { baseCommandEnv, prepareProviderCredentialFiles } from "../../runner/lib/credentials.ts";
import { enterSourceBuildPhase, readSourceBuildPhaseForTest } from "../../runner/lib/source_build_phase_gate.ts";
import { runSourceBuild } from "../../runner/lib/source_build.ts";
import { createDeterministicArchive } from "../../runner/lib/source_sync.ts";
import { prepareRuntimeSecretFiles } from "../../runner/lib/runtime_secrets.ts";
import type { RunWorkspace } from "../../runner/lib/types.ts";

const exists = async (path: string) => lstat(path).then(() => true, () => false);

test("phase HOME is private, outside the workspace, and cleanup preserves source archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-home-archive-"));
  const archive = join(root, "source.tar.zst");
  try {
    await writeFile(archive, "synthetic-archive");
    const home = await createPhaseHome();
    expect(home.path.startsWith(`${root}/`)).toBe(false);
    expect((await lstat(home.path)).mode & 0o777).toBe(0o700);
    expect((await lstat(home.env.XDG_CONFIG_HOME)).mode & 0o777).toBe(0o700);
    await writeFile(join(home.path, ".npmrc"), "synthetic-config");
    await home.cleanup();
    await home.cleanup();
    expect(await exists(home.path)).toBe(false);
    expect(await readFile(archive, "utf8")).toBe("synthetic-archive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace-local TMPDIR cannot place HOME in a workspace wiped for source sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-home-workspace-tmp-"));
  const runRoot = join(root, "runs");
  const workspace = join(runRoot, "run-one");
  const scratch = join(workspace, "scratch");
  try {
    await mkdir(scratch, { recursive: true });
    const program = `
      import {lstat,rm} from "node:fs/promises";
      import {createPhaseHome} from ${JSON.stringify(new URL("../../runner/lib/phase_home.ts", import.meta.url).href)};
      const workspace=${JSON.stringify(workspace)};
      const home=await createPhaseHome();
      const outside=!home.path.startsWith(workspace+"/");
      await rm(workspace,{recursive:true,force:true});
      const survived=(await lstat(home.path)).isDirectory();
      await home.cleanup();
      console.log(JSON.stringify({outside,survived}));
    `;
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
      env: {
        PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: root,
        TMPDIR: scratch,
        TAKOSUMI_OPENTOFU_RUN_ROOT: runRoot,
        CI: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({ outside: true, survived: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider-free command phases get distinct HOME paths and hold the build gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-home-provider-free-"));
  const workspace = { root: join(root, "run") } as RunWorkspace;
  try {
    const first = await prepareProviderCredentialFiles({ env: {} }, workspace);
    const firstHome = first.context.env.HOME;
    expect(await exists(firstHome)).toBe(true);
    let acquired = false;
    const waitingBuild = enterSourceBuildPhase().then((lease) => { acquired = true; return lease; });
    await Bun.sleep(10);
    expect(acquired).toBe(false);
    await first.cleanup();
    const buildLease = await waitingBuild;
    buildLease.release();
    expect(await exists(firstHome)).toBe(false);

    const second = await prepareProviderCredentialFiles({ env: {} }, workspace);
    expect(second.context.env.HOME).not.toBe(firstHome);
    expect(second.context.env.XDG_CONFIG_HOME).toBe(join(second.context.env.HOME, ".config"));
    await second.cleanup();

    const explicit = await prepareProviderCredentialFiles({ env: { XDG_CONFIG_HOME: "/operator/declared/config" } }, workspace);
    expect(explicit.context.env.XDG_CONFIG_HOME).toBe("/operator/declared/config");
    expect(explicit.context.env.HOME).not.toBe(firstHome);
    await explicit.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime secret preparation borrows its parent's phase while a build is queued", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-home-runtime-borrow-"));
  const workspace = { root: join(root, "run") } as RunWorkspace;
  const parent = await prepareProviderCredentialFiles({ env: {} }, workspace);
  let buildAcquired = false;
  const pendingBuild = enterSourceBuildPhase().then((lease) => {
    buildAcquired = true;
    return lease;
  });
  let runtime: Awaited<ReturnType<typeof prepareRuntimeSecretFiles>> | undefined;
  try {
    expect(readSourceBuildPhaseForTest().queuedBuilds).toBe(1);
    runtime = await prepareRuntimeSecretFiles(
      parent.context,
      workspace,
      {
        contract: "takosumi.runner-runtime-secret-files/v1",
        profileDigest: `sha256:${"a".repeat(64)}`,
        files: [{
          path: "synthetic.json",
          mode: 0o600,
          content: '{"SYNTHETIC":"synthetic-value"}',
          envName: "TAKOS_RUNTIME_SECRETS_FILE",
          secretNames: ["SYNTHETIC"],
        }],
      },
      {},
      parent.phaseBorrow,
    );
    expect(buildAcquired).toBe(false);
    await runtime.cleanup();
    runtime = undefined;
    expect(buildAcquired).toBe(false);
    await parent.cleanup();
    const buildLease = await pendingBuild;
    expect(buildAcquired).toBe(true);
    buildLease.release();
  } finally {
    await runtime?.cleanup().catch(() => {});
    await parent.cleanup().catch(() => {});
    if (buildAcquired) (await pendingBuild).release();
    await rm(root, { recursive: true, force: true });
  }
});

test("source archive validation uses phase HOME without carrying Git credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-home-archive-validation-"));
  const source = join(root, "source");
  const shim = join(root, "bin");
  const archive = join(root, "source.tar.zst");
  const log = join(root, "tar-env.log");
  const oldPath = Bun.env.PATH;
  const oldHome = Bun.env.HOME;
  const oldConfig = Bun.env.XDG_CONFIG_HOME;
  const tar = Bun.which("tar");
  if (!tar) throw new Error("tar is required for the source archive fixture");
  let home: Awaited<ReturnType<typeof createPhaseHome>> | undefined;
  try {
    await mkdir(source);
    await mkdir(shim);
    await writeFile(join(source, "main.tf"), "terraform {}\n");
    await writeFile(join(shim, "tar"), [
      "#!/bin/sh",
      `printf '%s|%s|%s|%s\\n' "$1" "$HOME" "$XDG_CONFIG_HOME" "\${GIT_HTTPS_TOKEN-unset}" >> '${log}'`,
      `exec '${tar}' "$@"`,
      "",
    ].join("\n"));
    await chmod(join(shim, "tar"), 0o755);
    Bun.env.PATH = `${shim}:${oldPath ?? "/usr/local/bin:/usr/bin:/bin"}`;
    Bun.env.HOME = join(root, "ambient");
    Bun.env.XDG_CONFIG_HOME = join(root, "ambient-config");
    home = await createPhaseHome();
    await createDeterministicArchive(source, archive, {
      context: { env: { ...baseCommandEnv(), ...home.env, GIT_HTTPS_TOKEN: "SYNTHETIC_GIT_TOKEN" } },
    });
    const rows = (await readFile(log, "utf8")).trim().split("\n");
    const validation = rows.find((row) => row.startsWith("-t|"));
    expect(validation).toBe(`-t|${home.path}|${home.env.XDG_CONFIG_HOME}|unset`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  } finally {
    if (oldPath === undefined) delete Bun.env.PATH; else Bun.env.PATH = oldPath;
    if (oldHome === undefined) delete Bun.env.HOME; else Bun.env.HOME = oldHome;
    if (oldConfig === undefined) delete Bun.env.XDG_CONFIG_HOME; else Bun.env.XDG_CONFIG_HOME = oldConfig;
    await home?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("source commands share one fresh HOME, ignore ambient config, and remove it after drain", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-home-source-"));
  const sourceRoot = join(root, "source");
  const ambient = join(root, "ambient");
  const oldHome = Bun.env.HOME;
  const oldConfig = Bun.env.XDG_CONFIG_HOME;
  try {
    await mkdir(sourceRoot);
    await mkdir(join(ambient, ".config"), { recursive: true });
    await writeFile(join(ambient, ".npmrc"), "AMBIENT_NPM_CANARY");
    await writeFile(join(ambient, ".config", "config-canary"), "AMBIENT_XDG_CANARY");
    Bun.env.HOME = ambient;
    Bun.env.XDG_CONFIG_HOME = join(ambient, ".config");
    const build = {
      commands: [
        { argv: [process.execPath, "-e", `import {writeFileSync} from "node:fs"; writeFileSync("first.json", JSON.stringify({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME})); writeFileSync(process.env.HOME+"/between", "shared");`] },
        { argv: [process.execPath, "-e", `import {existsSync,readFileSync,writeFileSync} from "node:fs"; const first=JSON.parse(readFileSync("first.json","utf8")); writeFileSync("result.json", JSON.stringify({home:process.env.HOME, config:process.env.XDG_CONFIG_HOME, same:first.home===process.env.HOME, shared:readFileSync(process.env.HOME+"/between","utf8"), ambientNpm:existsSync(process.env.HOME+"/.npmrc"), ambientXdg:existsSync(process.env.XDG_CONFIG_HOME+"/config-canary")}));`] },
      ],
      outputs: ["result.json"],
    };
    await runSourceBuild(build, sourceRoot);
    const first = JSON.parse(await readFile(join(sourceRoot, "result.json"), "utf8"));
    expect(first).toMatchObject({ same: true, shared: "shared", ambientNpm: false, ambientXdg: false });
    expect(first.config).toBe(join(first.home, ".config"));
    expect(await exists(first.home)).toBe(false);
    await runSourceBuild(build, sourceRoot);
    const second = JSON.parse(await readFile(join(sourceRoot, "result.json"), "utf8"));
    expect(second.home).not.toBe(first.home);
    expect(await exists(second.home)).toBe(false);
  } finally {
    if (oldHome === undefined) delete Bun.env.HOME; else Bun.env.HOME = oldHome;
    if (oldConfig === undefined) delete Bun.env.XDG_CONFIG_HOME; else Bun.env.XDG_CONFIG_HOME = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test("HOME cleanup ownership failure preserves the result and refuses later phases", async () => {
  const program = `
    import {mkdtemp,rename,symlink,rm,readFile,writeFile} from "node:fs/promises";
    import {tmpdir} from "node:os";
    import {join} from "node:path";
    import {prepareProviderCredentialFiles} from ${JSON.stringify(new URL("../../runner/lib/credentials.ts", import.meta.url).href)};
    import {enterSourceBuildPhase} from ${JSON.stringify(new URL("../../runner/lib/source_build_phase_gate.ts", import.meta.url).href)};
    const root=await mkdtemp(join(tmpdir(),"phase-home-failure-"));
    const outside=join(root,"outside");
    const saved=join(root,"saved");
    await writeFile(outside,"SYNTHETIC_OUTSIDE_CANARY");
    const prepared=await prepareProviderCredentialFiles({env:{}},{root:join(root,"run")});
    const home=prepared.context.env.HOME;
    const completedResult={status:"succeeded"};
    await rename(home,saved);
    await symlink(outside,home);
    await prepared.cleanup();
    const refused=await enterSourceBuildPhase().then(()=>false,e=>e.message==="source build isolation is unavailable");
    console.log(JSON.stringify({completedResult,refused,outside:await readFile(outside,"utf8")}));
    await rm(home,{force:true});
    await rm(root,{recursive:true,force:true});
  `;
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
    env: { PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir(), CI: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
    completedResult: { status: "succeeded" },
    refused: true,
    outside: "SYNTHETIC_OUTSIDE_CANARY",
  });
});
