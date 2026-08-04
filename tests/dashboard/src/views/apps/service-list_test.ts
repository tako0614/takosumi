import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(resolve(here, "../../../../../dashboard/src", rel), "utf8");

const serviceListSource = read("views/apps/WorkloadListView.tsx");
const routerSource = read("index.tsx");
const appViewsCssSource = read("styles/app-views.css");

describe("WorkloadListView (/workloads)", () => {
  test("lists every visible service as a row that opens its detail", () => {
    expect(serviceListSource).toContain("isVisibleServiceCapsule");
    expect(serviceListSource).toContain("getDashboardOverviewCached");
    expect(serviceListSource).toContain("overviewData()?.capsules");
    expect(serviceListSource).toContain('class="av-service-rows"');
    expect(serviceListSource).toContain('class="av-service-row"');
    expect(serviceListSource).toContain('class="av-service-row-main"');
    expect(serviceListSource).toContain(
      "/workloads/${encodeURIComponent(inst.id)}",
    );
    // Technical surface: status + last-updated, unlike the copy-free launcher.
    expect(serviceListSource).toContain("StatusBadge");
    expect(serviceListSource).toContain("effectiveCapsuleStatus");
    expect(serviceListSource).toContain("relativeTime");
  });

  test("a failed supplemental full-list fetch is surfaced, not silent truncation", () => {
    expect(serviceListSource).toContain("fullCapsules.error");
    expect(serviceListSource).toContain("refetchFullCapsules");
    expect(serviceListSource).toContain('t("workloads.listIncomplete")');
    expect(serviceListSource).toContain('t("common.retry")');
  });

  test("guards a failed overview before reading its throwing accessor", () => {
    expect(serviceListSource).toContain("const overviewData = createMemo");
    expect(serviceListSource).toContain("if (overview.error) return undefined;");
    expect(serviceListSource).toContain("<Match when={overview.error}>");
    expect(serviceListSource).toContain("fetchFailedMessage(overview.error, t)");
    expect(serviceListSource).toContain("refetchOverview");

    const overviewAccessors = [
      ...serviceListSource.matchAll(/\boverview\(\)/g),
    ];
    expect(overviewAccessors).toHaveLength(1);
    expect(overviewAccessors[0]?.index ?? -1).toBeGreaterThan(
      serviceListSource.indexOf("if (overview.error) return undefined;"),
    );
    expect(serviceListSource).toContain("<Match when={overviewData()}>");
  });

  test("offers deletion review directly from the service list", () => {
    expect(serviceListSource).toContain("function WorkloadListView");
    expect(serviceListSource).toContain("const deleteHref = (inst: Capsule)");
    expect(serviceListSource).toContain(
      "`/workloads/${encodeURIComponent(inst.id)}/danger`",
    );
    expect(serviceListSource).toContain('class="av-service-row-delete"');
    expect(serviceListSource).toContain('t("common.delete")');
    expect(serviceListSource).toContain('t("app.danger.destroyTitle")');
    // Rows repeat the same visible "削除"; the accessible name carries the
    // service so the links are distinguishable to AT.
    expect(serviceListSource).toContain('t("workloads.deleteAria"');
  });

  test("is wired to /workloads, distinct from the Apps home and the detail", () => {
    expect(routerSource).toContain("WorkloadListView");
    expect(routerSource).toContain(
      'path="/workloads" component={WorkloadListView}',
    );
    expect(routerSource).toContain('path="/" component={AppListView}');
    expect(routerSource).toContain(
      'path="/apps" component={() => <Navigate href="/" />}',
    );
    expect(routerSource).toContain(
      'path="/workloads/:id" component={WorkloadDetailView}',
    );
    expect(routerSource).toContain('path="/services"');
    expect(routerSource).toContain('<RedirectWithQuery to="/workloads" />');
  });

  test("has dedicated row styling", () => {
    expect(appViewsCssSource).toContain(".av-service-rows");
    expect(appViewsCssSource).toContain(".av-service-row");
    expect(appViewsCssSource).toContain(".av-service-row-main");
    expect(appViewsCssSource).toContain(".av-service-row-delete");
  });
});
