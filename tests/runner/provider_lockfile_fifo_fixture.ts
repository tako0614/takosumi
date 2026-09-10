import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleProviderLockfileArtifactRequest } from "../../runner/lib/artifacts.ts";
import { initPlanAndBuildResponse } from "../../runner/lib/plan_apply.ts";
import {
  requiredProviderSourcesFromTerraformTree,
} from "../../runner/lib/providers.ts";
import type { RunWorkspace } from "../../runner/lib/types.ts";

const CHILD_FLAG = "--provider-lockfile-fifo-child";
const CHILD_STARTUP_TIMEOUT_MS = 3_000;
const CHILD_OPERATION_TIMEOUT_MS = 1_000;
const CHILD_POLL_MS = 10;

export type ProviderLockfileFifoMode = "pipeline" | "relay";

export type ProviderLockfileFifoChildResult = {
  readonly phase: "completed" | "startup-timeout" | "operation-timeout";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export async function runProviderLockfileFifoChild(options: {
  readonly mode: ProviderLockfileFifoMode;
  readonly root: string;
  readonly runId: string;
  readonly readyPath: string;
  readonly fakeTofuBin?: string;
}): Promise<ProviderLockfileFifoChildResult> {
  const helperPath = fileURLToPath(import.meta.url);
  await rm(options.readyPath, { force: true });
  const child = Bun.spawn(
    [process.execPath, helperPath, CHILD_FLAG, options.mode],
    {
      cwd: options.root,
      env: {
        PATH: Bun.env.PATH ?? "",
        FIFO_ROOT: options.root,
        FIFO_RUN_ID: options.runId,
        FIFO_READY_PATH: options.readyPath,
        ...(options.fakeTofuBin
          ? { FIFO_FAKE_TOFU_BIN: options.fakeTofuBin }
          : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let exitCode: number | undefined;
  const childExited = child.exited.then((code) => {
    exitCode = code;
    return code;
  });
  let phase: ProviderLockfileFifoChildResult["phase"] = "startup-timeout";

  try {
    // The fixture-specific marker is emitted after setup (fake init for the
    // pipeline, module load for the relay), so this deadline covers only the
    // production FIFO operation and not cold startup.
    const ready = await waitForReady(options.readyPath, childExited);
    if (ready) {
      const operation = await Promise.race([
        childExited.then(() => "completed" as const),
        Bun.sleep(CHILD_OPERATION_TIMEOUT_MS).then(() => "timeout" as const),
      ]);
      phase = operation === "completed" ? "completed" : "operation-timeout";
    }
  } finally {
    // A FIFO regression leaves the child blocked in the production open().
    // Kill and reap that disposable process; never unblock it with a writer.
    if (exitCode === undefined) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child can exit between the check and kill call.
      }
    }
    await childExited;
  }

  return {
    phase,
    exitCode: exitCode ?? -1,
    stdout: await stdoutPromise,
    stderr: await stderrPromise,
  };
}

async function waitForReady(
  path: string,
  childExited: Promise<number>,
): Promise<boolean> {
  const deadline = Date.now() + CHILD_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return true;
    const exited = await Promise.race([
      childExited.then(() => true),
      Bun.sleep(CHILD_POLL_MS).then(() => false),
    ]);
    if (exited) return await Bun.file(path).exists();
  }
  return await Bun.file(path).exists();
}

function pipelineWorkspace(root: string): RunWorkspace {
  return {
    root,
    sourceRoot: root,
    moduleDir: root,
    planPath: join(root, "tfplan"),
    providerLockfilePath: join(root, "provider-lockfile.hcl"),
    restoredStatePath: join(root, "terraform.tfstate"),
    moduleInfoPath: join(root, "module-info.json"),
    generatedRootDir: join(root, "generated-root"),
    childModuleDir: join(root, "generated-root", "module"),
    artifactDir: join(root, "artifact"),
    depsDir: join(root, "deps"),
  };
}

async function runChild(mode: ProviderLockfileFifoMode): Promise<void> {
  const root = requiredEnv("FIFO_ROOT");
  const runId = requiredEnv("FIFO_RUN_ID");
  const readyPath = requiredEnv("FIFO_READY_PATH");

  if (mode === "pipeline") {
    const fakeTofuBin = requiredEnv("FIFO_FAKE_TOFU_BIN");
    const providerScan = await requiredProviderSourcesFromTerraformTree(root);
    const outcome = await initPlanAndBuildResponse(
      runId,
      pipelineWorkspace(root),
      root,
      {
        operation: "create",
        commandContext: {
          env: {
            PATH: `${fakeTofuBin}:${Bun.env.PATH ?? ""}`,
            FIFO_READY_PATH: readyPath,
          },
        },
        requiredProviders: providerScan.providers,
        providerScan,
      },
    ).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );
    console.log(JSON.stringify(outcome));
    return;
  }

  await Bun.write(readyPath, "ready\n");
  const response = await handleProviderLockfileArtifactRequest(
    runId,
    new Request(
      `http://runner.test/runs/${encodeURIComponent(runId)}/artifacts/tf-lockfile`,
      { method: "GET" },
    ),
  );
  console.log(
    JSON.stringify({ status: response.status, body: await response.text() }),
  );
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`missing child environment variable ${name}`);
  return value;
}

if (import.meta.main && process.argv[2] === CHILD_FLAG) {
  const mode = process.argv[3];
  if (mode !== "pipeline" && mode !== "relay") {
    throw new Error(`unknown provider lockfile FIFO child mode: ${mode ?? ""}`);
  }
  await runChild(mode);
}
