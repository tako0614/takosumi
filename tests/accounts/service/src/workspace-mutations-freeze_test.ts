import { expect, test } from "bun:test";
import { parseWorkspaceMutationsFrozen } from "../../../../accounts/service/src/workspace-mutations-freeze.ts";

test("Workspace mutation freeze defaults on and only opens for explicit false values", () => {
  expect(parseWorkspaceMutationsFrozen()).toBe(true);
  expect(parseWorkspaceMutationsFrozen("")).toBe(true);
  expect(parseWorkspaceMutationsFrozen("true")).toBe(true);
  expect(parseWorkspaceMutationsFrozen("off")).toBe(false);
  expect(parseWorkspaceMutationsFrozen("0")).toBe(false);
  expect(() => parseWorkspaceMutationsFrozen("sometimes")).toThrow(/must be one of/);
});
