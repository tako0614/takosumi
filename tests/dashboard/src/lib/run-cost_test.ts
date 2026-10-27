import { describe, expect, test } from "bun:test";
import { locale, setLocale } from "../../../../dashboard/src/i18n/index.ts";
import type { RunCostInfo } from "../../../../dashboard/src/lib/control-api.ts";
import {
  formatUsdMicros,
  readRunCost,
  runCostDisplayHasContent,
  runCostDisplayState,
} from "../../../../dashboard/src/lib/run-cost.ts";

function cost(overrides: Partial<RunCostInfo> = {}): RunCostInfo {
  return {
    runId: "run_1",
    billingMode: "showback",
    estimatedUsdMicros: 0,
    ratingStatus: "rated",
    blocked: false,
    reasons: [],
    ...overrides,
  };
}

describe("readRunCost", () => {
  test("keeps a loaded cost", async () => {
    const loaded = cost({ estimatedUsdMicros: 1_500_000 });
    expect(await readRunCost(async () => loaded)).toEqual({
      status: "loaded",
      cost: loaded,
    });
  });

  test("keeps a failed read as unavailable instead of no cost", async () => {
    const read = await readRunCost(async () => {
      throw new Error("503 Service Unavailable");
    });
    expect(read).toEqual({ status: "unavailable" });
    // The failure never leaks raw error text into the display state.
    expect(JSON.stringify(read)).not.toContain("503");
  });
});

describe("runCostDisplayState", () => {
  test("(a) a rated positive estimate is an estimate", () => {
    const loaded = cost({ estimatedUsdMicros: 2_340_000 });
    expect(runCostDisplayState({ status: "loaded", cost: loaded })).toEqual({
      kind: "estimated",
      cost: loaded,
      estimatedUsdMicros: 2_340_000,
    });
  });

  test("(b) unrated showback stays unknown, never a free zero", () => {
    const loaded = cost({ ratingStatus: "unrated", estimatedUsdMicros: 0 });
    const state = runCostDisplayState({ status: "loaded", cost: loaded });
    expect(state.kind).toBe("unrated");
    expect(runCostDisplayHasContent(state)).toBe(true);
  });

  test("(c) a rated zero and disabled billing are distinct quiet states", () => {
    const ratedZero = runCostDisplayState({
      status: "loaded",
      cost: cost({ ratingStatus: "rated", estimatedUsdMicros: 0 }),
    });
    const notApplicable = runCostDisplayState({
      status: "loaded",
      cost: cost({ billingMode: "disabled", ratingStatus: "not_applicable" }),
    });
    expect(ratedZero.kind).toBe("rated_zero");
    expect(notApplicable.kind).toBe("not_applicable");
    expect(runCostDisplayHasContent(ratedZero)).toBe(false);
    expect(runCostDisplayHasContent(notApplicable)).toBe(false);
  });

  test("(c) a quiet state still shows a blocked decision", () => {
    const state = runCostDisplayState({
      status: "loaded",
      cost: cost({
        ratingStatus: "not_applicable",
        blocked: true,
        reasons: ["quota exceeded"],
      }),
    });
    expect(state.kind).toBe("not_applicable");
    expect(runCostDisplayHasContent(state)).toBe(true);
  });

  test("(d) a failed read is unavailable and always has a line", () => {
    const state = runCostDisplayState({ status: "unavailable" });
    expect(state).toEqual({ kind: "unavailable" });
    expect(runCostDisplayHasContent(state)).toBe(true);
  });

  test("unrated wins over any amount the projection carried", () => {
    // Core forces unrated amounts to zero; the dashboard still never prices
    // an unrated estimate.
    const state = runCostDisplayState({
      status: "loaded",
      cost: cost({ ratingStatus: "unrated", estimatedUsdMicros: 1_000_000 }),
    });
    expect(state.kind).toBe("unrated");
  });
});

describe("formatUsdMicros", () => {
  test("formats micro-dollars in the active locale", () => {
    const previousLocale = locale();
    try {
      setLocale("en");
      expect(formatUsdMicros(2_340_000)).toBe("$2.34");
      expect(formatUsdMicros(1_234_567)).toBe("$1.234567");
      setLocale("ja");
      expect(formatUsdMicros(2_340_000)).toContain("2.34");
    } finally {
      setLocale(previousLocale);
    }
  });
});
