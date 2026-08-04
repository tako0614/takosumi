import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/settings/SettingsView.tsx",
  ),
  "utf8",
);
const workspaceSettingsSource = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/workspace/WorkspaceSettingsView.tsx",
  ),
  "utf8",
);

test("settings hub keeps billing behind its explicit route", () => {
  expect(source).toContain('href: "/settings/billing"');
  expect(source).not.toContain("BillingSummary");
  expect(source).not.toContain("getWorkspaceBilling");
  expect(source).not.toContain("createResource");
});

test("workspace settings uses the canonical billing destination", () => {
  expect(workspaceSettingsSource).toContain('href: "/settings/billing"');
  expect(workspaceSettingsSource).not.toContain(
    'href: "/advanced/workspace/billing"',
  );
});
