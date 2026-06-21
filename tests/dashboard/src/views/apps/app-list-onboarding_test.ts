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
  test("keeps first-run home focused on choosing a service, not a deploy procedure", () => {
    expect(appListSource).toContain("function WorkspaceStartPanel");
    expect(appListSource).toContain("when={list().length === 0}");
    expect(appListSource).toContain('href="/new"');
    expect(appListSource).toContain('t("apps.start.optionCatalog")');
    expect(appListSource).not.toContain('href="/new?mode=link"');
    expect(appListSource).not.toContain('t("apps.start.optionLink")');
    expect(appListSource).not.toContain('t("apps.start.add")');
    expect(appListSource).not.toContain('href="/connections"');
    expect(appListSource).not.toContain('t("apps.start.stepSource")');
    expect(appListSource).not.toContain('t("apps.start.stepConnection")');
    expect(appListSource).not.toContain('t("apps.start.stepDeploy")');
  });

  test("uses a launcher summary for workspaces that already have services", () => {
    expect(appListSource).toContain("function ServiceLauncherHeader");
    expect(appListSource).toContain("<ServiceLauncherHeader");
    expect(appListSource).toContain("<ServiceList");
    expect(appListSource).toContain('class="av-service-grid"');
    expect(appListSource).toContain('class="av-service-card"');
    expect(appListSource).toContain('t("apps.summary.title")');
    expect(appListSource).toContain('t("apps.summary.body"');
    expect(appListSource).toContain('t("apps.summary.clear")');
    expect(appListSource).not.toContain('t("apps.graphLink")');
    expect(appListSource).not.toContain('t("apps.dependsOn"');
    expect(appListSource).not.toContain("getSpaceGraph");
    expect(appListSource).not.toContain("apps.start.titleWithServices");
    expect(appListSource).not.toContain("apps.start.bodyWithServices");
  });

  test("keeps starter copy action-oriented and non-procedural in both locales", () => {
    expect(en).not.toHaveProperty("apps.start.add");
    expect(en).not.toHaveProperty("apps.start.stepSource");
    expect(ja).not.toHaveProperty("apps.start.add");
    expect(ja).not.toHaveProperty("apps.start.stepSource");
    expect(en["apps.summary.clear"]).toContain("No attention");
    expect(ja["apps.summary.clear"]).toContain("要対応なし");
    expect(en["apps.subtitle"]).not.toContain("manage");
    expect(ja["apps.subtitle"]).not.toContain("管理");
    expect(en).not.toHaveProperty("apps.start.optionLink");
    expect(ja).not.toHaveProperty("apps.start.optionLink");
  });

  test("keeps the starter responsive on mobile", () => {
    expect(appViewsCssSource).toContain(".av-start");
    expect(appViewsCssSource).toContain(".av-summary");
    expect(appViewsCssSource).toContain(".av-service-grid");
    expect(appViewsCssSource).toContain(".av-service-card");
    expect(appViewsCssSource).toContain(".av-service-actions .tg-btn");
    expect(appViewsCssSource).toContain("grid-template-columns: 1fr;");
    expect(appViewsCssSource).not.toContain(".av-start-actions");
    expect(appViewsCssSource).toContain("flex: 1 1 auto;");
    expect(appViewsCssSource).toContain("flex-direction: column;");
  });

  test("keeps open as the first-class row action when a public link exists", () => {
    expect(appListSource).toContain('t("apps.openApp")');
    expect(appListSource).not.toContain('t("apps.noOpenLink")');
    expect(appListSource).toContain("<Show when={props.launchUrls.get(inst.id)}>");
    expect(appListSource).toContain('class="av-service-actions"');
    expect(appListSource).toContain("icon={<ExternalLink size={14} />}");
    expect(appListSource).toContain('target="_blank"');
    expect(appListSource).toContain("onClick={() => props.openDetail(inst)}");
    expect(appListSource).not.toContain("window.open");
    expect(appListSource).not.toContain('t("apps.viewDetails")');
  });
});
