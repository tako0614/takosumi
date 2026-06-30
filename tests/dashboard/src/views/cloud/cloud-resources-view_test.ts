import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cloudResourcesViewSource = readFileSync(
  resolve(
    here,
    "../../../../../dashboard/src/views/cloud/CloudResourcesView.tsx",
  ),
  "utf8",
);
const appViewsCssSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/styles/app-views.css"),
  "utf8",
);

describe("Cloud resources view", () => {
  test("keeps resource inventory compact until a user expands it", () => {
    expect(cloudResourcesViewSource).toContain(
      "const RESOURCE_PREVIEW_LIMIT = 5",
    );
    expect(cloudResourcesViewSource).toContain("expandedGroups");
    expect(cloudResourcesViewSource).toContain(
      "allItems().slice(0, RESOURCE_PREVIEW_LIMIT)",
    );
    expect(cloudResourcesViewSource).toContain(
      't("cloudResources.inventory.showAll"',
    );
    expect(cloudResourcesViewSource).toContain(
      't("cloudResources.inventory.remaining"',
    );
    expect(cloudResourcesViewSource).toContain(
      't("cloudResources.inventory.showLess")',
    );
  });

  test("has compact inventory copy in both locales", () => {
    expect(en["cloudResources.title"]).toBe("Takosumi Cloud");
    expect(ja["cloudResources.title"]).toBe("Takosumi Cloud");
    expect(en["cloudResources.subtitle"]).not.toContain("Worker-compatible");
    expect(ja["cloudResources.subtitle"]).not.toContain("Worker-compatible");
    expect(en["cloudResources.inventory.showAll"]).toContain("{count}");
    expect(en["cloudResources.inventory.remaining"]).toContain("{count}");
    expect(ja["cloudResources.inventory.showAll"]).toContain("{count}");
    expect(ja["cloudResources.inventory.remaining"]).toContain("{count}");
    expect(en["common.refresh"]).toBe("Refresh");
    expect(ja["common.refresh"]).toBe("更新");
    expect(ja["cloudResources.inventory.title"]).toBe("クラウドリソース");
    expect(ja["cloudResources.keys.title"]).toBe("外部APIキー");
    expect(ja["cloudResources.keys.empty"]).toBe("まだ外部APIキーはありません。");
    expect(en["cloudResources.s3.buckets"]).toBe("Buckets");
    expect(en["cloudResources.s3.configuredBuckets"]).toBe("Ready buckets");
    expect(ja["cloudResources.s3.buckets"]).toBe("Bucket数");
    expect(ja["cloudResources.s3.configuredBuckets"]).toBe("利用可能Bucket");
  });

  test("loads resource inventory separately from the endpoint overview", () => {
    expect(cloudResourcesViewSource).toContain(
      "export function CloudResourcesPanel",
    );
    expect(cloudResourcesViewSource).toContain(
      "getCloudResourcesSnapshot",
    );
    expect(cloudResourcesViewSource).toContain(
      "getCloudflareCompatInventory",
    );
    expect(cloudResourcesViewSource).toContain("inventoryLoading");
  });

  test("keeps raw resource identifiers behind an explicit copy action", () => {
    expect(cloudResourcesViewSource).toContain(
      't("cloudResources.resources.copyId")',
    );
    expect(cloudResourcesViewSource).not.toContain("av-cloud-res-id");
    expect(appViewsCssSource).not.toContain(".av-cloud-res-id");
  });

  test("only exposes currently materialized Cloudflare compat resource groups", () => {
    for (const key of ["kv", "r2", "d1", "queues", "workflows", "workers"]) {
      expect(cloudResourcesViewSource).toContain(
        `t("cloudResources.inventory.${key}")`,
      );
      expect(
        en[`cloudResources.inventory.${key}` as keyof typeof en],
      ).toBeTruthy();
      expect(
        ja[`cloudResources.inventory.${key}` as keyof typeof ja],
      ).toBeTruthy();
    }
    for (const key of ["containers", "durableObjects"]) {
      expect(cloudResourcesViewSource).not.toContain(`inv.${key}`);
      expect(
        en[`cloudResources.inventory.${key}` as keyof typeof en],
      ).toBeUndefined();
      expect(
        ja[`cloudResources.inventory.${key}` as keyof typeof ja],
      ).toBeUndefined();
    }
  });

  test("requires confirmation before revoking Cloud API keys", () => {
    expect(cloudResourcesViewSource).toContain(
      "const { confirm } = useConfirmDialog()",
    );
    expect(cloudResourcesViewSource).toContain(
      'title: t("cloudResources.keys.revokeTitle")',
    );
    expect(cloudResourcesViewSource).toContain(
      'message: t("cloudResources.keys.revokeMessage"',
    );
    expect(cloudResourcesViewSource).toContain("if (!ok) return;");
    expect(cloudResourcesViewSource).toContain(
      't("cloudResources.keys.revoke")',
    );
    expect(en["cloudResources.keys.revoke"]).toBe("Revoke");
    expect(ja["cloudResources.keys.revoke"]).toBe("取り消し");
  });

  test("keeps compact resource controls responsive on mobile", () => {
    expect(appViewsCssSource).toContain(".av-cloud-res-group-title");
    expect(appViewsCssSource).toContain(".av-cloud-res-more");
    expect(appViewsCssSource).toContain(".av-cloud-res-group-head .tg-btn");
  });
});
