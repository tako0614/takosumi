import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("../fixtures/refresh-retention-properties.ts", import.meta.url));
for (const backend of ["memory", "d1", "postgres"] as const) {
  const scenarios = ["exact-expiry", "prefix-root", "long-access", "revoked-residue", "large-family", "live-code-row", "unknown-expiry",
    ...(backend === "d1" ? ["incomplete-index", "invalid-link-root", "invalid-link-time"] : [])];
  for (const scenario of scenarios) {
    test(`${backend} retention preserves ${scenario} and bounded cleanup`, () => {
      let output: string;
      try {
        output = execFileSync(process.execPath, ["--no-env-file", runtime, backend, scenario], {
          encoding: "utf8", timeout: 40_000, killSignal: "SIGKILL", maxBuffer: 64 * 1_024,
          env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH },
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        throw new Error(`${backend}/${scenario} fixture failed\n${String(failure.stdout ?? "").slice(0, 4_096)}\n${String(failure.stderr ?? "").slice(0, 4_096)}`);
      }
      expect(JSON.parse(output)).toEqual({ backend, scenario, pass: true });
    }, 45_000);
  }
}
