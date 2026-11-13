import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAY = 24 * 60 * 60 * 1_000;
const runtime = fileURLToPath(new URL("../fixtures/refresh-retention-runtime.ts", import.meta.url));
for (const backend of ["memory", "d1", "postgres"] as const) {
  for (const scenario of ["access-only", "rotated-family"] as const) {
    test(`${backend} actual code replay revokes live ${scenario} after shortened retention`, () => {
      let output: string;
      try {
        // Module-load issuer TTLs and the virtual clock stay in this disposable
        // process; other portable test modules cannot inherit the configuration.
        output = execFileSync(process.execPath, ["--no-env-file", runtime, backend, scenario], {
          encoding: "utf8", timeout: 40_000, killSignal: "SIGKILL", maxBuffer: 64 * 1_024,
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
            TAKOSUMI_ACCOUNTS_ACCESS_TOKEN_TTL_MS: String((scenario === "access-only" ? 60 : 1) * DAY),
            TAKOSUMI_ACCOUNTS_REFRESH_TOKEN_TTL_MS: String(60 * DAY),
          },
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        throw new Error(`${backend}/${scenario} fixture failed\n${String(failure.stdout ?? "").slice(0, 4_096)}\n${String(failure.stderr ?? "").slice(0, 4_096)}`);
      }
      const facts = JSON.parse(output);
      expect(facts).toMatchObject({ backend, scenario, markerRetained: true, replayStatus: 400,
        beforeUserInfo: 200, afterUserInfo: 401, originalAccessRevoked: true,
        currentAccessRevoked: true, currentRefreshRevoked: true,
        consumedMarkersDeleted: 0, codeLinksDeleted: 0 });
    }, 45_000);
  }
}
