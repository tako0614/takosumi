import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../dashboard/src");
const router = readFileSync(resolve(root, "index.tsx"), "utf8");

describe("Home", () => {
  test("Home is the all-apps list: /apps and /workloads redirect there; an app's page is /apps/:id", () => {
    expect(router).not.toContain("WorkloadListView");
    expect(router).toContain('path="/" component={AppListView}');
    expect(router).toContain('path="/apps" component={() => <Navigate href="/" />}');
    expect(router).toContain('path="/workloads" component={() => <Navigate href="/" />}');
    expect(router).toContain('path="/apps/:id" component={AppPage}');
    expect(router).toContain('path="/workloads/:id" component={RedirectLegacyAppPage}');
    expect(router).toContain('path="/workloads/:id/:tab" component={RedirectLegacyAppPage}');
  });
});
