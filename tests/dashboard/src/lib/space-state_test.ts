import { expect, test } from "bun:test";
import { selectAvailableSpaceId } from "../../../../dashboard/src/lib/space-state.ts";

test("selectAvailableSpaceId keeps an accessible Workspace id", () => {
  expect(
    selectAvailableSpaceId("space_b", [{ id: "space_a" }, { id: "space_b" }]),
  ).toBe("space_b");
});

test("selectAvailableSpaceId replaces stale persisted Workspace ids", () => {
  expect(
    selectAvailableSpaceId("space_old", [
      { id: "space_new" },
      { id: "space_other" },
    ]),
  ).toBe("space_new");
});

test("selectAvailableSpaceId clears when no Workspaces are accessible", () => {
  expect(selectAvailableSpaceId("space_old", [])).toBe("");
});
