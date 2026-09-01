/**
 * Every activity action the server emits must have copy that explains it.
 *
 * The server recorded 27 distinct actions while the screen could explain 15;
 * the other 22 rendered as a generic "recorded" line. That is the same shape
 * as dead helper code — the write side is correct and nothing reads it — so it
 * gets the same kind of guard: emitting a new action without copy fails here.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const EMITTING_SOURCES = [
  "../../../../core/domains/capsules/mod.ts",
  "../../../../core/domains/capsules/uninstall_finalize.ts",
  "../../../../core/domains/deploy-control/run-engine/run_engine.ts",
] as const;

const activityView = read("../../../../dashboard/src/views/activity/ActivityView.tsx");

/** Actions the view deliberately leaves on the generic line. */
const INTENTIONALLY_GENERIC = new Set([
  // Bare phase words recorded as run metadata, not user-facing verbs.
  "apply",
  "plan",
  "restore",
]);

function emittedActions(): readonly string[] {
  const actions = new Set<string>();
  for (const relative of EMITTING_SOURCES) {
    for (const match of read(relative).matchAll(/action: "([a-z0-9_.]+)"/gu)) {
      if (match[1]) actions.add(match[1]);
    }
  }
  return [...actions].sort();
}

test("every emitted activity action has copy in the activity view", () => {
  const unexplained = emittedActions().filter(
    (action) =>
      !INTENTIONALLY_GENERIC.has(action) &&
      !activityView.includes(`case "${action}":`),
  );
  expect(unexplained).toEqual([]);
});

test("the pre-destroy export outcome is explained, not silently recorded", () => {
  // The server records whether a scheduled removal exported the data first;
  // that evidence had no reader anywhere in the dashboard.
  for (const outcome of ["completed", "failed", "skipped"] as const) {
    expect(activityView).toContain(
      `case "capsule.pre_destroy_export.${outcome}":`,
    );
  }
});
