import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const workloadListViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/apps/WorkloadListView.tsx"),
  "utf8",
);
const installViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/new/InstallView.tsx"),
  "utf8",
);

describe("service add install posture", () => {
  test("routes service creation through the app-like install flow", () => {
    expect(workloadListViewSource).toContain('href="/new"');
    expect(workloadListViewSource).not.toContain('href="/store"');
    expect(workloadListViewSource).not.toContain('href="/workloads/new"');
    expect(workloadListViewSource).not.toContain("createService(");
    expect(installViewSource).toContain("StoreBrowser");
    expect(installViewSource).toContain("prepareInstall");
    expect(en["installStore.browseTitle"]).toBe("Find a service");
    expect(ja["installStore.browseTitle"]).toBe("サービスを探す");
  });
});
