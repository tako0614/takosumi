/**
 * The install crosses /new → /runs/:id. Before these steps were shared, each
 * route measured progress against its own list, so the bar a visitor watched on
 * /new was thrown away and a second one started near zero on /runs — the same
 * install presenting itself as a fresh one. These tests lock the property that
 * broke: the percentage only ever moves forward across the hand-off.
 */
import { describe, expect, test } from "bun:test";
import {
  INSTALL_HANDOFF_STEP,
  INSTALL_STEPS,
  installStepLabel,
  installStepPercent,
  UPDATE_STEPS,
  type InstallStep,
} from "../../../../dashboard/src/lib/install-steps.ts";

/** The steps /new can reach before it navigates to the run screen. */
const NEW_ROUTE_STEPS: readonly InstallStep[] = ["source", "create", "check"];
/** The steps /runs/:id?auto=install can show. */
const RUN_ROUTE_STEPS: readonly InstallStep[] = ["check", "deploy", "done"];

describe("install steps", () => {
  test("the two routes meet at one shared step and never overlap further", () => {
    expect(NEW_ROUTE_STEPS.at(-1)).toBe(INSTALL_HANDOFF_STEP);
    expect(RUN_ROUTE_STEPS.at(0)).toBe(INSTALL_HANDOFF_STEP);
    // Every step either route shows is on the one list, in the one order.
    for (const step of [...NEW_ROUTE_STEPS, ...RUN_ROUTE_STEPS]) {
      expect(INSTALL_STEPS).toContain(step);
    }
    expect([...NEW_ROUTE_STEPS].map((s) => INSTALL_STEPS.indexOf(s))).toEqual([
      0, 1, 2,
    ]);
    expect([...RUN_ROUTE_STEPS].map((s) => INSTALL_STEPS.indexOf(s))).toEqual([
      2, 3, 4,
    ]);
  });

  test("the bar never goes backwards across the /new → /runs hand-off", () => {
    const walked = [...NEW_ROUTE_STEPS, ...RUN_ROUTE_STEPS].map((step) =>
      installStepPercent(step),
    );
    for (let i = 1; i < walked.length; i += 1) {
      expect(walked[i]).toBeGreaterThanOrEqual(walked[i - 1]!);
    }
    // Concretely: /new hands off at the same fill /runs opens with.
    expect(installStepPercent(INSTALL_HANDOFF_STEP)).toBe(
      installStepPercent(RUN_ROUTE_STEPS[0]!),
    );
  });

  test("a just-started install already reads as moving, and waiting never reads as finished", () => {
    expect(installStepPercent(INSTALL_STEPS[0]!)).toBeGreaterThan(0);
    for (const step of INSTALL_STEPS) {
      expect(installStepPercent(step)).toBeLessThan(100);
    }
    expect(installStepPercent(UPDATE_STEPS[0]!, UPDATE_STEPS)).toBeGreaterThan(
      0,
    );
  });

  test("a 1-tap update fills its own shorter bar instead of opening half-full", () => {
    // Against the full list an update would start at the hand-off point; its
    // own list has to start it near empty.
    expect(installStepPercent(UPDATE_STEPS[0]!, UPDATE_STEPS)).toBeLessThan(
      installStepPercent(INSTALL_HANDOFF_STEP),
    );
    const walked = UPDATE_STEPS.map((step) =>
      installStepPercent(step, UPDATE_STEPS),
    );
    for (let i = 1; i < walked.length; i += 1) {
      expect(walked[i]).toBeGreaterThan(walked[i - 1]!);
    }
  });

  test("an unknown step reads as the start, not as a negative width", () => {
    // "source" is not on the update list — an update that somehow reported it
    // must not render a bar at -17%.
    expect(installStepPercent("source", UPDATE_STEPS)).toBeGreaterThan(0);
  });

  test("every step is labelled, and no two share a label", () => {
    const labels = INSTALL_STEPS.map((step) => installStepLabel(step));
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
