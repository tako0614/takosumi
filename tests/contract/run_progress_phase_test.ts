import { expect, test } from "bun:test";

import {
  IN_FLIGHT_RUN_STATUSES,
  RUN_PROGRESS_PHASE,
  runIsInFlight,
  runProgressPhase,
  type RunStatus,
} from "takosumi-contract/runs";
import {
  NON_TERMINAL_RUN_STATUSES,
  isTerminalStatus,
} from "../../core/domains/deploy-control/mod.ts";

/**
 * These assert RELATIONS between the derived views, never a pasted copy of the
 * status list. A copy would have to be edited alongside the map, and that edit
 * is what made three independent classifications of one lifecycle possible.
 */

const ALL_STATUSES = Object.keys(RUN_PROGRESS_PHASE) as RunStatus[];

test("every run status is classified exactly once, and the two halves partition it", () => {
  const inFlight = ALL_STATUSES.filter(
    (status) => runProgressPhase(status) === "in-flight",
  );
  const settled = ALL_STATUSES.filter(
    (status) => runProgressPhase(status) === "settled",
  );
  expect(inFlight.length + settled.length).toBe(ALL_STATUSES.length);
  expect(new Set([...inFlight, ...settled]).size).toBe(ALL_STATUSES.length);
});

test("the terminal-transition from-list is exactly the in-flight half", () => {
  expect([...NON_TERMINAL_RUN_STATUSES].sort()).toEqual(
    [...IN_FLIGHT_RUN_STATUSES].sort(),
  );
  for (const status of ALL_STATUSES) {
    expect(NON_TERMINAL_RUN_STATUSES.includes(status)).toBe(
      runIsInFlight(status),
    );
  }
});

test("isTerminalStatus is the exact complement of runIsInFlight", () => {
  for (const status of ALL_STATUSES) {
    expect(isTerminalStatus(status)).toBe(!runIsInFlight(status));
  }
});

test("an unknown status is not in flight", () => {
  expect(runIsInFlight(undefined)).toBe(false);
  expect(runIsInFlight("not_a_status" as RunStatus)).toBe(false);
});
