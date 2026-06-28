import { expect, test } from "bun:test";
import { selectAvailableWorkspaceId } from "../../../../dashboard/src/lib/workspace-state.ts";

test("selectAvailableWorkspaceId keeps an accessible Workspace id", () => {
  expect(
    selectAvailableWorkspaceId("space_b", [{ id: "space_a" }, { id: "space_b" }]),
  ).toBe("space_b");
});

test("selectAvailableWorkspaceId replaces stale persisted Workspace ids", () => {
  expect(
    selectAvailableWorkspaceId("space_old", [
      { id: "space_new" },
      { id: "space_other" },
    ]),
  ).toBe("space_new");
});

test("selectAvailableWorkspaceId clears when no Workspaces are accessible", () => {
  expect(selectAvailableWorkspaceId("space_old", [])).toBe("");
});
