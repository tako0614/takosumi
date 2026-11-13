import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import type { FullConfig, FullResult, Suite, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import DashboardTimingReporter, { dashboardTimingReporters, projectDashboardStep } from "../dashboard/e2e/timing-reporter.ts";

const source = { file: resolve(import.meta.dir, "../dashboard/e2e/dashboard_test.ts"), line: 41, column: 3 };
const poison = "https://private.example/?token=secret-payload Bearer secret-header body attachment error";
const step = (input: object = {}) => ({ category: "pw:api", title: poison, duration: 12,
  location: source, steps: [], attachments: [{ body: poison }], ...input }) as unknown as TestStep;

test("timing projection keeps fixed categories, source and hierarchy without runtime values", () => {
  const value = projectDashboardStep(step({ steps: [step({ category: "expect", duration: 4, error: { message: poison } })] }));
  expect(value).toEqual({ category: "pw:api", source: { file: "dashboard_test.ts", line: 41 }, durationMs: 12,
    status: "passed", steps: [{ category: "expect", source: { file: "dashboard_test.ts", line: 41 }, durationMs: 4, status: "failed", steps: [] }] });
  expect(JSON.stringify(value)).not.toContain(poison);
  expect(projectDashboardStep(step({ category: poison, location: { file: poison, line: 1 }, duration: NaN })))
    .toEqual({ category: "other", source: undefined, durationMs: null, status: "unknown", steps: [] });
});

test("portable timing evidence requires an explicit opt-in and never enables live profiles", () => {
  expect(dashboardTimingReporters("portable")).toBe("line");
  expect(dashboardTimingReporters("live", "/private")).toBe("line");
  expect(dashboardTimingReporters("public-live", "/private")).toBe("line");
  const reporters = dashboardTimingReporters("portable", "/private");
  expect(reporters[0]).toEqual(["line"]);
  expect(reporters[1]?.[1]).toEqual({ outputDir: "/private" });
});

test("private reports distinguish success and failure without serializing raw test data", async () => {
  for (const status of ["passed", "failed"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "dashboard-timings-"));
    try {
      const reporter = new DashboardTimingReporter({ outputDir: directory });
      const test = { location: source, title: poison, expectedStatus: "passed" } as TestCase;
      reporter.onBegin({} as FullConfig, { allTests: () => [test] } as Suite);
      reporter.onTestEnd(test,
        { duration: 19, status, steps: [step()], errors: [{ message: poison }], stdout: [poison], attachments: [{ body: poison }] } as unknown as TestResult);
      expect(await reporter.onEnd({ duration: 27, status } as FullResult)).toBeUndefined();
      const text = await readFile(join(directory, "timings.json"), "utf8");
      const data = JSON.parse(text);
      expect(data.status).toBe(status); expect(data.cases[0].status).toBe(status);
      expect(data.selectedCases).toBe(1);
      expect(data.cases[0].durationMs).toBe(19); expect(text).not.toContain(poison);
      const provenance = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"));
      expect(provenance.complete).toBe(status === "passed");
      expect(provenance.source.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect((await stat(join(directory, "timings.json"))).mode & 0o777).toBe(0o600);
      expect(() => new DashboardTimingReporter({ outputDir: directory })).toThrow("already exist");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("an empty observation cannot claim a complete browser cohort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-empty-timings-"));
  try {
    const reporter = new DashboardTimingReporter({ outputDir: directory });
    reporter.onBegin({} as FullConfig, { allTests: () => [] } as unknown as Suite);
    await reporter.onEnd({ duration: 0, status: "passed" } as FullResult);
    const provenance = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"));
    expect(provenance.complete).toBe(false); expect(provenance.cases).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("actual Playwright multiplexer fails partial evidence without replacing existing failure status", async () => {
  const require = createRequire(realpathSync(resolve(import.meta.dir, "../../node_modules/@playwright/test/package.json")));
  const { Multiplexer } = require(join(dirname(require.resolve("playwright/package.json")), "lib/reporters/multiplexer.js")) as {
    Multiplexer: new (reporters: DashboardTimingReporter[]) => { onEnd(result: FullResult): Promise<FullResult> };
  };
  for (const original of ["passed", "failed", "timedout", "interrupted"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "dashboard-partial-timings-"));
    try {
      const reporter = new DashboardTimingReporter({ outputDir: directory });
      // Force failure after timings.json has been written, without a permission
      // simulation or an image/browser/network operation.
      await writeFile(join(directory, "provenance.json"), "blocked");
      const result = await new Multiplexer([reporter]).onEnd({ duration: 1, status: original } as FullResult);
      expect(result.status).toBe(original === "passed" ? "failed" : original);
      expect(JSON.parse(await readFile(join(directory, "timings.json"), "utf8")).status).toBe(original);
      expect(await readFile(join(directory, "provenance.json"), "utf8")).toBe("blocked");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
