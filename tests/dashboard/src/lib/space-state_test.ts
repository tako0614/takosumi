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
    selectAvailableWorkspaceId("space_b", [
      { id: "space_a" },
      { id: "space_b" },
    ]),
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

test("current Workspace storage retires the old per-session key", () => {
  expect(workspaceStateSource).toContain(
    'const STORAGE_KEY = "tg_apps_space_id"',
  );
  expect(workspaceStateSource).toContain('"takosumi.currentWorkspaceId"');
  expect(workspaceStateSource).toContain("clearLegacyWorkspaceStorageKeys()");
  expect(workspaceStateSource).toContain("localStorage.removeItem(key)");
  expect(workspaceStateSource).not.toContain(
    'localStorage.getItem("takosumi.currentWorkspaceId")',
  );
});
