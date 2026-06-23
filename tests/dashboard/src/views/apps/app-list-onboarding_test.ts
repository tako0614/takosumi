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
const installationsUiSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/lib/installations-ui.ts"),
  "utf8",
);

describe("AppListView app launcher", () => {
  test("keeps first-run home focused on choosing a service, not a deploy procedure", () => {
    expect(appListSource).toContain("function WorkspaceStartPanel");
    expect(appListSource).toContain(
      "when={visibleInstallations().length === 0}",
    );
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

  test("renders existing services as a tappable app launcher, not ops rows", () => {
    expect(appListSource).not.toContain("function ServiceLauncherHeader");
    expect(appListSource).not.toContain("<ServiceLauncherHeader");
    expect(appListSource).toContain("<ServiceList");
    expect(appListSource).toContain("isVisibleServiceInstallation");
    expect(appListSource).toContain("visibleInstallations()");
    expect(installationsUiSource).toContain(
      "export function isVisibleServiceInstallation",
    );
    expect(installationsUiSource).toContain('inst.status !== "destroyed"');
    // Phone-home-screen launcher: an icon grid of tiles + a trailing add tile.
    expect(appListSource).toContain('class="av-launcher"');
    expect(appListSource).toContain('class="av-tile"');
    expect(appListSource).toContain('class="av-tile av-tile-add"');
    expect(appListSource).toContain("av-tile-icon");
    expect(appListSource).toContain("av-tile-name");
    // No admin-console fields on the launcher: no status pill, timestamp, env,
    // or per-row detail/open buttons — the whole tile is the affordance.
    expect(appListSource).not.toContain("StatusBadge");
    expect(appListSource).not.toContain("PageHeader");
    expect(appListSource).not.toContain('t("apps.updated"');
    expect(appListSource).not.toContain("relativeTime");
    expect(appListSource).not.toContain('t("apps.viewDetails")');
    expect(appListSource).not.toContain('t("apps.noOpenLink")');
    expect(appListSource).not.toContain("inst.environment");
    // De-cluttered: the top-bar bell badge + per-tile dot replace the old
    // needs-attention banner entirely.
    expect(appListSource).not.toContain("av-attention");
    expect(appListSource).not.toContain("attentionCount");
    expect(appListSource).not.toContain('t("apps.summary.title")');
    expect(appListSource).not.toContain('t("apps.graphLink")');
    expect(appListSource).not.toContain("getSpaceGraph");
    expect(appListSource).not.toContain("listActivity");
    expect(appListSource).not.toContain("staleReasonFromActivity");
    expect(appListSource).not.toContain("apps.start.titleWithServices");
    expect(appListSource).not.toContain("apps.start.bodyWithServices");
  });

  test("keeps starter copy action-oriented and non-procedural in both locales", () => {
    expect(en).not.toHaveProperty("apps.start.add");
    expect(en).not.toHaveProperty("apps.start.stepSource");
    expect(ja).not.toHaveProperty("apps.start.add");
    expect(ja).not.toHaveProperty("apps.start.stepSource");
    expect(en).not.toHaveProperty("apps.staleReason");
    expect(ja).not.toHaveProperty("apps.staleReason");
    expect(en).not.toHaveProperty("apps.summary.clear");
    expect(ja).not.toHaveProperty("apps.summary.clear");
    expect(en["apps.subtitle"]).not.toContain("manage");
    expect(ja["apps.subtitle"]).not.toContain("管理");
    expect(en).not.toHaveProperty("apps.start.optionLink");
    expect(ja).not.toHaveProperty("apps.start.optionLink");
  });

  test("keeps the launcher responsive on mobile", () => {
    expect(appViewsCssSource).toContain(".av-start");
    expect(appViewsCssSource).not.toContain(".av-summary");
    expect(appViewsCssSource).toContain(".av-launcher");
    expect(appViewsCssSource).toContain(".av-tile");
    expect(appViewsCssSource).toContain(".av-tile-icon");
    expect(appViewsCssSource).toContain(".av-tile-dot");
    expect(appViewsCssSource).not.toContain(".av-service-grid");
    expect(appViewsCssSource).not.toContain(".av-service-card");
    expect(appViewsCssSource).not.toContain(".av-start-actions");
  });

  test("opens the live app when a public link exists, else the service screen", () => {
    // The whole tile is the affordance: an anchor (new tab) when a launch URL
    // exists, otherwise a button that opens the service detail screen.
    expect(appListSource).toContain("function ServiceTile");
    expect(appListSource).toContain("when={props.url}");
    expect(appListSource).toContain("launchUrlFromOutputs");
    expect(appListSource).toContain('target="_blank"');
    expect(appListSource).toContain("props.openDetail(inst)");
    expect(appListSource).not.toContain("window.open");
    // Needs-attention is a corner dot + screen-reader label, not a status pill.
    expect(appListSource).toContain("av-tile-dot");
    expect(appListSource).toContain('t("apps.needsAttention")');
    expect(appListSource).toContain('class="sr-only"');
  });
});
