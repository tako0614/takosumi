import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface NativeRunnerShutdownHandle {
  readonly pid: number;
  readonly child: Pick<ReturnType<typeof Bun.spawn>, "kill" | "exited">;
  readonly runRoot: string;
  readonly shutdownRecordPath: string;
  stopped: boolean;
  shutdownError?: Error;
  shutdownRecord?: Readonly<Record<string, unknown>>;
}

export async function stopNativeRunnerProcess(
  runner: NativeRunnerShutdownHandle,
  observationBudgetMs = 15_000,
  report: (message: string) => void = (message) => console.error(message),
): Promise<void> {
  if (runner.stopped) {
    if (runner.shutdownError) throw runner.shutdownError;
    return;
  }
  const reportSafely = (message: string) => { try { report(message); } catch { /* Custody outranks diagnostics. */ } };
  try { runner.child.kill("SIGTERM"); } catch {
    reportSafely("native Runner signal failed; waiting for custody closure proof");
  }
  const waitPath = `${runner.shutdownRecordPath}.wait.json`;
  let observation: Promise<void> | undefined;
  const timer = setTimeout(() => {
    try {
      observation = writeFile(waitPath, JSON.stringify({
        state: "waiting-for-drain", pid: runner.pid, runRoot: runner.runRoot,
        cohortPid: process.pid,
      }) + "\n", { mode: 0o600 }).catch(() => {});
    } catch { /* A diagnostic failure never releases the cohort. */ }
    reportSafely(`native Runner drain remains pending; cohort retained at ${dirname(runner.shutdownRecordPath)}`);
  }, observationBudgetMs);
  let exitCode: number | undefined;
  try {
    exitCode = await runner.child.exited;
  } catch {
    reportSafely("native Runner exit observation failed; custody remains unproven");
  } finally {
    clearTimeout(timer);
  }
  await observation;
  let closure: Record<string, unknown> | undefined;
  try {
    closure = JSON.parse(await readFile(runner.shutdownRecordPath, "utf8")) as Record<string, unknown>;
  } catch {
    // Exit alone does not prove that the supervised tree and owner closed.
  }
  if (exitCode === undefined || closure?.kind !== "takosumi.native-runner-shutdown/v1" || closure.pid !== runner.pid ||
    closure.runRoot !== runner.runRoot || closure.drained !== true || closure.ownerClosed !== true) {
    try {
      await writeFile(join(dirname(runner.shutdownRecordPath), "HOLD.json"), JSON.stringify({
        state: "HOLD", reason: "native shutdown custody unproven", pid: process.pid,
        supervisorPid: runner.pid, runRoot: runner.runRoot,
      }) + "\n", { mode: 0o600 });
    } catch { /* Preserve the live Core/PG/keys even if diagnostic writes fail. */ }
    reportSafely("native Runner shutdown custody unproven; cohort HOLD");
    await new Promise<never>(() => { setInterval(() => {}, 60_000); });
  }
  runner.shutdownRecord = closure;
  if (observation) {
    try {
      await writeFile(waitPath, JSON.stringify({
        state: "drained", pid: runner.pid, runRoot: runner.runRoot,
        ownerClosed: true, cohortPid: process.pid,
      }) + "\n", { mode: 0o600 });
    } catch {
      // The matching closure receipt and child exit prove custody; an
      // observation-file failure cannot turn that proof into a failed stop.
      reportSafely("native Runner closure proven; completion diagnostic unavailable");
    }
  }
  runner.stopped = true;
  if (exitCode !== 0) {
    runner.shutdownError = new Error("local Runner entrypoint did not exit cleanly");
    throw runner.shutdownError;
  }
}
