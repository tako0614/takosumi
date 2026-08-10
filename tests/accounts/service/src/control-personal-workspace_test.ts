import { expect, test } from "bun:test";

import { personalWorkspaceHandle } from "../../../../accounts/service/src/control-personal-workspace.ts";

test("personalWorkspaceHandle keeps subject fallback stable and valid", () => {
  const input = {
    subject: "Subject/with a very long suffix_2026!",
    displayName: "---",
    email: "@example.test",
  };

  const first = personalWorkspaceHandle(input);
  const second = personalWorkspaceHandle(input);

  expect(first).toBe(second);
  expect(first).toMatch(/^[a-z0-9][a-z0-9-]{1,38}$/u);
  expect(first.length).toBeLessThanOrEqual(39);
  expect(first).toBe("u-subjectwithaverylongsuffix2026");
});
