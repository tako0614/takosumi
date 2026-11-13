import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("../fixtures/refresh-retention-scheduler.ts", import.meta.url));
for (const scenario of ["held-progress", "checkpoint-failure", "lost-ack", "overlap"]) {
  test(`scheduled retention handles ${scenario} across its actual bounded ticks`, () => {
    const output = execFileSync(process.execPath, ["--no-env-file", runtime, scenario], {
      encoding: "utf8", timeout: 40_000, killSignal: "SIGKILL", maxBuffer: 64 * 1_024,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH },
    });
    const finalLine = output.trim().split("\n").at(-1)!;
    expect(JSON.parse(finalLine)).toEqual({ scenario, pass: true,
      heldRowRetained: true, expiredRowCollected: true, runtimeDdl: 0,
      checkpointGeneration: scenario === "lost-ack" ? 4 : 2 });
  }, 45_000);
}
