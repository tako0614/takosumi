import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const serviceListViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/apps/ServiceListView.tsx"),
  "utf8",
);
const newAppViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/new/NewAppView.tsx"),
  "utf8",
);

describe("service add install posture", () => {
  test("routes service creation through the app-like install flow", () => {
    expect(serviceListViewSource).toContain('href="/store"');
    expect(serviceListViewSource).not.toContain('href="/services/new"');
    expect(serviceListViewSource).not.toContain("createService(");
    expect(newAppViewSource).toContain("StoreBrowser");
    expect(newAppViewSource).toContain("startLinkImport");
    expect(en["new.discovery.title"]).toBe("Choose a service to add");
    expect(en["new.git.url"]).toBe("Install link");
    expect(ja["new.discovery.title"]).toBe("追加するサービスを選ぶ");
    expect(ja["new.git.url"]).toBe("インストールリンク");
  });
});
