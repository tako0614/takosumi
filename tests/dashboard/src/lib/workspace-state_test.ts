import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectAvailableWorkspaceId } from "../../../../dashboard/src/lib/workspace-state.ts";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceStateSource = readFileSync(
  resolve(here, "../../../../dashboard/src/lib/workspace-state.ts"),
  "utf8",
);

test("selectAvailableWorkspaceId keeps an accessible Workspace id", () => {
  expect(
    selectAvailableWorkspaceId("ws_b", [{ id: "ws_a" }, { id: "ws_b" }]),
  ).toBe("ws_b");
});

test("selectAvailableWorkspaceId replaces stale persisted Workspace ids", () => {
  expect(
    selectAvailableWorkspaceId("ws_old", [
      { id: "ws_new" },
      { id: "ws_other" },
    ]),
  ).toBe("ws_new");
});

test("selectAvailableWorkspaceId clears when no Workspaces are accessible", () => {
  expect(selectAvailableWorkspaceId("ws_old", [])).toBe("");
});

test("current Workspace storage uses one canonical key", () => {
  expect(workspaceStateSource).toContain(
    'const STORAGE_KEY = "takosumi.currentWorkspaceId"',
  );
  expect(workspaceStateSource).not.toContain("LEGACY_STORAGE_KEYS");
  expect(workspaceStateSource).not.toContain("tg_apps_space_id");
});
