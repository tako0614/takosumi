import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

test("local HTTP runner keeps its entire run root on a named volume", async () => {
  const composePath = resolve(
    import.meta.dir,
    "../../../deploy/local-substrate/compose.substrate.yml",
  );
  const compose = parse(await readFile(composePath, "utf8")) as {
    services?: Record<
      string,
      { environment?: Record<string, string>; volumes?: string[] }
    >;
    volumes?: Record<string, unknown>;
  };
  const runner = compose.services?.["opentofu-runner"];
  expect(runner?.environment?.TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE).toBe(
    "local-http",
  );
  const runRoot = runner?.environment?.TAKOSUMI_OPENTOFU_RUN_ROOT;
  expect(runRoot).toBe("/tmp/takosumi-runs");
  const mounts = (runner?.volumes ?? []).filter(
    (mount) => mount.split(":")[1] === runRoot,
  );
  expect(mounts).toEqual(["substrate-opentofu-runner-runs:/tmp/takosumi-runs"]);
  expect(compose.volumes).toHaveProperty("substrate-opentofu-runner-runs");
  for (const [name, service] of Object.entries(compose.services ?? {})) {
    if (name === "opentofu-runner") continue;
    expect(
      (service.volumes ?? []).some(
        (mount) => mount.split(":")[0] === "substrate-opentofu-runner-runs",
      ),
    ).toBe(false);
  }
});

test("private runner preparation v2 changes only the runner startup command", async () => {
  const basePath = resolve(
    import.meta.dir,
    "../../../deploy/local-substrate/compose.substrate.yml",
  );
  const overlayPath = resolve(
    import.meta.dir,
    "../../../deploy/local-substrate/compose.runner-preparation-v2.yml",
  );
  const base = parse(await readFile(basePath, "utf8")) as {
    services?: Record<string, Record<string, unknown>>;
  };
  const overlay = parse(await readFile(overlayPath, "utf8")) as {
    services?: Record<string, Record<string, unknown>>;
  };
  expect(overlay).toEqual({
    services: {
      "opentofu-runner": {
        command: ["--local-preparation-v2-supervisor"],
      },
    },
  });
  expect(base.services?.["opentofu-runner"]?.command).toBeUndefined();
  expect(base.services?.["opentofu-runner"]?.volumes).toEqual([
    "substrate-opentofu-runner-runs:/tmp/takosumi-runs",
  ]);
});

test("v2 opt-in composes only for postgres and rejects conflicting profiles before Docker", async () => {
  const helperPath = resolve(
    import.meta.dir,
    "../../../deploy/local-substrate/scripts/compose-helpers.sh",
  );
  const temp = await mkdtemp(resolve(tmpdir(), "takosumi-compose-helper-"));
  const substrateDir = resolve(
    import.meta.dir,
    "../../../deploy/local-substrate",
  );
  const dockerPath = resolve(temp, "docker");
  const callsPath = resolve(temp, "calls");
  await writeFile(
    dockerPath,
    "#!/bin/bash\nprintf '%s\\0' \"$@\" >>\"$DOCKER_CALLS\"\n",
  );
  await chmod(dockerPath, 0o755);
  const invoke = (
    profileArgs: string[],
    profileEnv = "postgres",
    preparation: string | null = "v2",
  ) => {
    const childEnv = { ...process.env };
    delete childEnv.TAKOSUMI_LOCAL_SUBSTRATE_RUNNER_PREPARATION;
    return spawnSync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; shift; cd "$1"; shift; compose_substrate "$@"',
        "--",
        helperPath,
        substrateDir,
        ...profileArgs,
      ],
      {
        encoding: "utf8",
        env: {
          ...childEnv,
          PATH: temp,
          DOCKER_CALLS: callsPath,
          ...(preparation === null
            ? {}
            : { TAKOSUMI_LOCAL_SUBSTRATE_RUNNER_PREPARATION: preparation }),
          TAKOSUMI_LOCAL_SUBSTRATE_PROFILE: profileEnv,
        },
      },
    );
  };

  try {
    const postgres = invoke(["--profile", "postgres", "ps", "-q", "opentofu-runner"]);
    expect(postgres.status).toBe(0);
    const args = (await readFile(callsPath)).toString().split("\0").filter(Boolean);
    expect(args).toEqual([
      "compose",
      "-f",
      "compose.substrate.yml",
      "-f",
      "compose.runner-preparation-v2.yml",
      "--profile",
      "postgres",
      "ps",
      "-q",
      "opentofu-runner",
    ]);

    await rm(callsPath);
    const v1 = invoke(["--profile", "postgres", "ps", "-q", "opentofu-runner"], "postgres", "v1");
    expect(v1.status).toBe(0);
    expect((await readFile(callsPath)).toString().split("\0").filter(Boolean)).toEqual([
      "compose",
      "-f",
      "compose.substrate.yml",
      "--profile",
      "postgres",
      "ps",
      "-q",
      "opentofu-runner",
    ]);

    await rm(callsPath);
    const defaultMode = invoke(
      ["--profile", "postgres", "ps", "-q", "opentofu-runner"],
      "postgres",
      null,
    );
    expect(defaultMode.status).toBe(0);
    expect((await readFile(callsPath)).toString().split("\0").filter(Boolean)).toEqual([
      "compose",
      "-f",
      "compose.substrate.yml",
      "--profile",
      "postgres",
      "ps",
      "-q",
      "opentofu-runner",
    ]);

    await rm(callsPath);
    const down = invoke(["--profile", "postgres", "--profile", "workers", "down"]);
    expect(down.status).toBe(0);
    expect((await readFile(callsPath)).toString().split("\0").filter(Boolean)).toEqual([
      "compose",
      "-f",
      "compose.substrate.yml",
      "-f",
      "compose.runner-preparation-v2.yml",
      "--profile",
      "postgres",
      "--profile",
      "workers",
      "down",
    ]);

    await rm(callsPath);
    const workers = invoke(["--profile", "workers", "up", "-d"], "workers");
    expect(workers.status).not.toBe(0);
    expect(await readFile(callsPath).catch(() => Buffer.alloc(0))).toHaveLength(0);

    const mismatch = invoke(["--profile", "postgres", "up", "-d"], "workers");
    expect(mismatch.status).not.toBe(0);
    expect(await readFile(callsPath).catch(() => Buffer.alloc(0))).toHaveLength(0);

    const invalidMode = invoke(["--profile", "postgres", "up", "-d"], "postgres", "v3");
    expect(invalidMode.status).not.toBe(0);
    expect(await readFile(callsPath).catch(() => Buffer.alloc(0))).toHaveLength(0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("down rejects an invalid runner preparation mode before suppressing compose failures", async () => {
  const substrateDir = resolve(
    import.meta.dir,
    "../../../deploy/local-substrate",
  );
  const downPath = resolve(substrateDir, "scripts/down.sh");
  const temp = await mkdtemp(resolve(tmpdir(), "takosumi-down-invalid-mode-"));
  const dockerPath = resolve(temp, "docker");
  const dirnamePath = resolve(temp, "dirname");
  const callsPath = resolve(temp, "calls");
  await writeFile(
    dockerPath,
    "#!/bin/bash\nprintf '%s\\0' \"$@\" >>\"$DOCKER_CALLS\"\n",
  );
  await writeFile(
    dirnamePath,
    "#!/bin/bash\nprintf '%s\\n' \"${1%/*}\"\n",
  );
  await chmod(dockerPath, 0o755);
  await chmod(dirnamePath, 0o755);

  try {
    const result = spawnSync("/bin/bash", [downPath], {
      encoding: "utf8",
      env: {
        PATH: temp,
        DOCKER_CALLS: callsPath,
        TAKOSUMI_LOCAL_SUBSTRATE_RUNNER_PREPARATION: "v3",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "TAKOSUMI_LOCAL_SUBSTRATE_RUNNER_PREPARATION must be v1 or v2",
    );
    expect(await readFile(callsPath).catch(() => Buffer.alloc(0))).toHaveLength(0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
