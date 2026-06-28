import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(resolve(here, "../../../../../dashboard/src", rel), "utf8");

const serviceListSource = read("views/apps/ServiceListView.tsx");
const routerSource = read("index.tsx");
const appViewsCssSource = read("styles/app-views.css");

describe("ServiceListView (/services)", () => {
  test("lists every visible service as a row that opens its detail", () => {
    expect(serviceListSource).toContain("isVisibleServiceCapsule");
    expect(serviceListSource).toContain("listCapsules");
    expect(serviceListSource).toContain('class="av-service-rows"');
    expect(serviceListSource).toContain('class="av-service-row"');
    expect(serviceListSource).toContain(
      "/services/${encodeURIComponent(inst.id)}",
    );
    // Technical surface: status + last-updated, unlike the copy-free launcher.
    expect(serviceListSource).toContain("StatusBadge");
    expect(serviceListSource).toContain("effectiveCapsuleStatus");
    expect(serviceListSource).toContain("relativeTime");
  });

  test("is wired to /services, distinct from the Apps home and the detail", () => {
    expect(routerSource).toContain("ServiceListView");
    expect(routerSource).toContain(
      'path="/services" component={ServiceListView}',
    );
    expect(routerSource).toContain('path="/" component={AppListView}');
    expect(routerSource).toContain(
      'path="/apps" component={() => <Navigate href="/" />}',
    );
    expect(routerSource).toContain(
      'path="/services/:id" component={AppDetailView}',
    );
  });

  test("has dedicated row styling", () => {
    expect(appViewsCssSource).toContain(".av-service-rows");
    expect(appViewsCssSource).toContain(".av-service-row");
  });
});
