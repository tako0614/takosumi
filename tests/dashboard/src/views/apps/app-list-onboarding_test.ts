import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const appListSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/apps/AppListView.tsx"),
  "utf8",
);
const appViewsCssSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/styles/app-views.css"),
  "utf8",
);

describe("AppListView Workspace starter", () => {
  test("keeps the first-run cloud workflow visible from home", () => {
    expect(appListSource).toContain("function WorkspaceStartPanel");
    expect(appListSource).toContain('href="/new"');
    expect(appListSource).toContain('href="/workspace/settings/connections"');
    expect(appListSource).toContain('t("apps.start.stepSource")');
    expect(appListSource).toContain('t("apps.start.stepConnection")');
    expect(appListSource).toContain('t("apps.start.stepDeploy")');
  });

  test("keeps starter copy action-oriented in both locales", () => {
    expect(en["apps.start.add"]).toBe("Add from Git");
    expect(en["apps.start.connections"].toLowerCase()).toContain("connections");
    expect(ja["apps.start.add"]).toContain("Git");
    expect(ja["apps.start.connections"]).toContain("クラウド接続");
  });

  test("keeps the starter responsive on mobile", () => {
    expect(appViewsCssSource).toContain(".av-start");
    expect(appViewsCssSource).toContain("grid-template-columns: 1fr;");
    expect(appViewsCssSource).toContain(".av-start-actions .tg-btn");
    expect(appViewsCssSource).toContain("flex: 1 1 100%;");
  });
});
