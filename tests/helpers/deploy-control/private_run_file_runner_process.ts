/** Test-owned loopback composition of the real Runner and inherited-OFD supervisor.
 * Container entrypoints retain their private-network bind behavior. */
import { writeFile } from "node:fs/promises";
import { startRunnerHttpServer } from "../../../runner/entrypoint.ts";
import { RUN_ROOT } from "../../../runner/lib/constants.ts";
import { ensureCustodyDirectory } from "../../../runner/lib/run_completion.ts";
import {
  acquireRunRootOwnership,
  adoptRunRootOwnershipFromStdin,
  type RunRootOwnership,
} from "../../../runner/lib/run_root_ownership.ts";
import { PreparationV2ChildSupervisor } from "../../../runner/lib/preparation_v2_child_supervisor.ts";

if (import.meta.main) {
  if (Bun.argv[2] === "--supervisor") await runSupervisor();
  else if (Bun.argv[2] === "--child") await runChild();
  else throw new Error("native Runner composition mode is required");
}

async function runChild(): Promise<void> {
  let running: Awaited<ReturnType<typeof startRunnerHttpServer>> | undefined;
  let owner: RunRootOwnership | undefined;
  try {
    owner = await adoptRunRootOwnershipFromStdin(RUN_ROOT);
    running = await startRunnerHttpServer({
      hostname: "127.0.0.1",
      localPreparationV2: true,
      runRootOwnership: owner,
    });
    owner = undefined;
    const stop = () => {
      void running!.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    const recordPath = Bun.env.TAKOSUMI_TEST_RUNNER_LISTENER_RECORD;
    if (!recordPath) {
      await running.close();
      throw new Error("native listener record path is required");
    }
    await writeFile(recordPath, JSON.stringify({
      pid: process.pid,
      hostname: running.server.hostname,
      port: running.server.port,
    }) + "\n", { mode: 0o600 });
  } catch {
    await running?.close();
    await owner?.close();
    process.stderr.write("native Runner child startup refused\n");
    process.exitCode = 1;
  }
}

async function runSupervisor(): Promise<void> {
  let owner: RunRootOwnership | undefined;
  let supervisor: PreparationV2ChildSupervisor | undefined;
  let launched = false;
  let drained = false;
  let stopRequested = false;
  let removeSignals = () => {};
  try {
    await ensureCustodyDirectory(true);
    owner = await acquireRunRootOwnership(RUN_ROOT);
    supervisor = new PreparationV2ChildSupervisor(RUN_ROOT, owner);
    const stop = () => {
      stopRequested = true;
      void signalOwnedRunner(supervisor);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    removeSignals = () => { process.off("SIGTERM", stop); process.off("SIGINT", stop); };
    if (!stopRequested) {
      launched = true;
      const env = Object.fromEntries(Object.entries(Bun.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ));
      const result = await supervisor.runRunnerUntilDrained(
        process.execPath,
        ["--no-env-file", import.meta.path, "--child"],
        { env, drainTimeoutMs: 30_000, retryIntervalMs: 250 },
      );
      drained = result.drained;
      if (!drained) throw new Error("native Runner tree is not drained");
      if (result.exitCode !== 0 || result.signalCode !== null) process.exitCode = 1;
    }
    await supervisor.close();
    supervisor = undefined;
    await owner.close();
    owner = undefined;
    const recordPath = Bun.env.TAKOSUMI_TEST_RUNNER_SHUTDOWN_RECORD;
    if (recordPath) {
      await writeFile(recordPath, JSON.stringify({
        kind: "takosumi.native-runner-shutdown/v1",
        pid: process.pid, runRoot: RUN_ROOT, launched,
        drained: !launched || drained, ownerClosed: true,
      }) + "\n", { mode: 0o600 });
    }
    removeSignals();
  } catch {
    process.exitCode = 1;
    if (!launched) {
      try {
        await supervisor?.close();
        supervisor = undefined;
        await owner?.close();
        owner = undefined;
        removeSignals();
        return;
      } catch { /* Unknown custody retains the process and ownership below. */ }
    }
    process.stderr.write("native Runner supervision failed; custody closure unproven\n");
    await new Promise<void>(() => { setInterval(() => {}, 60_000); });
  }
}

async function signalOwnedRunner(supervisor: PreparationV2ChildSupervisor | undefined): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (supervisor && performance.now() < deadline) {
    if (supervisor.signalRunner("SIGTERM")) return;
    await Bun.sleep(10);
  }
}
