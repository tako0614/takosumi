import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboardRoot = resolve(import.meta.dir, "../../../../../dashboard/src");
const source = (path: string) => readFileSync(resolve(dashboardRoot, path), "utf8");

test("Resource dashboard surface is no longer mounted or advertised", () => {
  const index = source("index.tsx");
  const nav = source("views/account/components/shell/nav.ts");
  const settings = source("views/settings/SettingsView.tsx");

  expect(index).not.toContain('import("./views/resources/ResourcesView.tsx")');
  expect(index).not.toContain("ResourceDetailView");
  expect(index).not.toContain('path="/resources"');
  expect(index).not.toContain('path="/resources/:kind/:name"');
  expect(nav).not.toContain("nav.resources");
  expect(nav).not.toContain("/^\\/resources");
  expect(settings).not.toContain('href: "/resources"');
  expect(settings).not.toContain('titleKey: "nav.resources"');
  for (const path of [
    "views/resources/ResourcesView.tsx",
    "views/resources/ResourceDetailView.tsx",
    "views/resources/ResourceEditor.tsx",
    "views/resources/components/S3CustomerAccessKeysCard.tsx",
  ]) {
    expect(existsSync(resolve(dashboardRoot, path))).toBe(false);
  }
});
