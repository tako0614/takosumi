import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const homeSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/apps/AppListView.tsx"),
  "utf8",
);
const installViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/new/InstallView.tsx"),
  "utf8",
);

describe("app install posture", () => {
  test("routes installing an app through the one install flow", () => {
    expect(homeSource).toContain('href="/new"');
    expect(homeSource).not.toContain('href="/store"');
    expect(homeSource).not.toContain('href="/workloads/new"');
    expect(homeSource).not.toContain("createService(");
    expect(installViewSource).toContain("StoreBrowser");
    expect(installViewSource).toContain("attempt.start(");
    expect(en["installStore.browseTitle"]).toBe("Find apps");
    expect(ja["installStore.browseTitle"]).toBe("アプリを探す");
  });
});
