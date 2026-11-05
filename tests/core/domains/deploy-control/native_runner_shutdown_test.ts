import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stopNativeRunnerProcess, type NativeRunnerShutdownHandle } from "../../../helpers/deploy-control/native_runner_shutdown.ts";

test("uncertain native drain waits without force before cohort cleanup", async () => {
  await proveNativeShutdownWait(false);
});

test("a failed native shutdown signal still waits for custody proof", async () => {
  await proveNativeShutdownWait(true);
});

test("diagnostic failure cannot release uncertain native custody", async () => {
  await proveNativeShutdownWait(false, true);
});

async function proveNativeShutdownWait(
  signalFailure: boolean,
  diagnosticFailure = false,
  completionDiagnosticFailure = false,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-native-shutdown-wait-"));
  const exited = deferred<number>();
  const signals: string[] = [];
  const runner: NativeRunnerShutdownHandle = {
    pid: 4321, runRoot: join(root, "run-root"),
    shutdownRecordPath: join(root, "shutdown.json"),
    child: { exited: exited.promise, kill(signal) {
      signals.push(String(signal));
      if (signalFailure) throw new Error("synthetic signal failure");
      return true;
    } },
    stopped: false,
  };
  const closure = {
    kind: "takosumi.native-runner-shutdown/v1", pid: runner.pid, runRoot: runner.runRoot,
    launched: true, drained: true, ownerClosed: true,
  };
  let diagnosticCalls = 0;
  const stopping = stopNativeRunnerProcess(runner, 1, () => {
    diagnosticCalls += 1;
    if (diagnosticFailure) throw new Error("synthetic diagnostic failure");
  });
  let outcome = "pending";
  void stopping.then(() => { outcome = "closed"; }, () => { outcome = "rejected"; });
  try {
    await Bun.sleep(10);
    expect(outcome).toBe("pending");
    const waitRecord = Bun.file(`${runner.shutdownRecordPath}.wait.json`);
    let waitState: string | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { waitState = (await waitRecord.json()).state; } catch { /* A diagnostic write may still be in flight. */ }
      if (waitState === "waiting-for-drain") break;
      await Bun.sleep(5);
    }
    expect(waitState).toBe("waiting-for-drain");
    expect(diagnosticCalls).toBeGreaterThan(0);
    expect(signals).toEqual(["SIGTERM"]);
    expect(runner.stopped).toBe(false);
    if (completionDiagnosticFailure) {
      await rm(`${runner.shutdownRecordPath}.wait.json`);
      await mkdir(`${runner.shutdownRecordPath}.wait.json`);
    }
    await writeFile(runner.shutdownRecordPath, JSON.stringify(closure));
    exited.resolve(0);
    await stopping;
    expect(runner.stopped).toBe(true);
    if (!completionDiagnosticFailure) expect((await waitRecord.json()).state).toBe("drained");
    await stopNativeRunnerProcess(runner);
    expect(signals).toEqual(["SIGTERM"]);
  } finally {
    await writeFile(runner.shutdownRecordPath, JSON.stringify(closure));
    exited.resolve(0);
    await stopping.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

test("a failed completion diagnostic cannot invalidate proven Runner closure", async () => {
  await proveNativeShutdownWait(false, false, true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
