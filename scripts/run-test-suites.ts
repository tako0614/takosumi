#!/usr/bin/env bun
/**
 * Run every Takosumi test stage and report all of them.
 *
 * The stages are split because a few files need `--isolate` and a real
 * workerd / OpenTofu process, which the portable sweep cannot give them. They
 * used to be chained with `&&`, so a single slow start in the small isolated
 * stage hid the result of the other ~4,300 tests. Stages now run to
 * completion independently and the process fails if any of them failed.
 */

export interface TestStage {
  readonly name: string;
  readonly script: string;
}

export const TEST_STAGES: readonly TestStage[] = [
  { name: "portable", script: "test:portable" },
  { name: "workerd", script: "test:workerd" },
];

export interface TestStageResult {
  readonly name: string;
  readonly exitCode: number;
  readonly durationMilliseconds: number;
}

export function summarizeStages(
  results: readonly TestStageResult[],
): { readonly failed: readonly string[]; readonly lines: readonly string[] } {
  const failed = results
    .filter((result) => result.exitCode !== 0)
    .map((result) => result.name);
  const lines = results.map((result) =>
    `[test] ${result.exitCode === 0 ? "✓" : "✗"} ${result.name} (${
      (result.durationMilliseconds / 1000).toFixed(2)
    }s${result.exitCode === 0 ? "" : `, exit ${result.exitCode}`})`
  );
  return { failed, lines };
}

async function runStage(stage: TestStage): Promise<TestStageResult> {
  const startedAt = performance.now();
  console.error(`[test] ▶ ${stage.name}: bun run ${stage.script}`);
  const child = Bun.spawn(["bun", "run", stage.script], {
    cwd: new URL("..", import.meta.url).pathname,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  return {
    name: stage.name,
    exitCode,
    durationMilliseconds: performance.now() - startedAt,
  };
}

if (import.meta.main) {
  const results: TestStageResult[] = [];
  for (const stage of TEST_STAGES) {
    results.push(await runStage(stage));
  }
  const { failed, lines } = summarizeStages(results);
  for (const line of lines) console.error(line);
  if (failed.length > 0) {
    console.error(`[test] failed stage(s): ${failed.join(", ")}`);
    process.exit(1);
  }
}
