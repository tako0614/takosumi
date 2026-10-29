import { describe, expect, test } from "bun:test";
import { appActionAllowed, type AppAction } from "../../contract/app-access.ts";

const actions: readonly AppAction[] = [
  "view", "change_settings", "update", "rollback", "choose_connection", "change_interface_link",
  "uninstall", "transfer_ownership", "manage_members",
];

describe("app management permissions", () => {
  test.each(actions)("owner may %s", (action) => {
    expect(appActionAllowed("owner", action)).toBe(true);
  });

  test.each(actions)("member permission for %s", (action) => {
    expect(appActionAllowed("member", action)).toBe(
      !["uninstall", "transfer_ownership", "manage_members"].includes(action),
    );
  });
});
