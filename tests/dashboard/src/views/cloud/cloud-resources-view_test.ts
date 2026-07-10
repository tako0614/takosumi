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

  test("has usage-first resource-management copy in both locales", () => {
    expect(en["cloudResources.title"]).toBe("Cloud resources");
    expect(ja["cloudResources.title"]).toBe("クラウドリソース");
    expect(en["cloudResources.subtitle"]).not.toContain("external keys");
    expect(ja["cloudResources.subtitle"]).not.toContain("外部キー");
    expect(en["cloudResources.subtitle"]).toContain("usage");
    expect(ja["cloudResources.subtitle"]).toContain("使用量");
    expect(en["workspaceSettings.tab.cloud"]).toBe("Cloud resources");
    expect(ja["workspaceSettings.tab.cloud"]).toBe("クラウドリソース");
    expect(en["workspaceSettings.tab.keys"]).toBe("API keys");
    expect(ja["workspaceSettings.tab.keys"]).toBe("APIキー");
    expect(en["cloudResources.keys.createdNotice"]).toContain("only once");
    expect(ja["cloudResources.keys.createdNotice"]).toContain("一度だけ");
    expect(en["cloudResources.keys.secretNotice"]).toContain("prefix");
    expect(ja["cloudResources.keys.secretNotice"]).toContain("prefix");
    expect(en["cloudResources.usage.tableTitle"]).toBe(
      "Usage by resource type",
    );
    expect(ja["cloudResources.usage.tableTitle"]).toBe("種類別の使用量");
    expect(en["cloudResources.usage.estimatedCost"]).toBe("Estimated cost");
    expect(ja["cloudResources.usage.estimatedCost"]).toBe("見積費用");
    expect(en["cloudResources.inventory.showAll"]).toContain("{count}");
    expect(en["cloudResources.inventory.remaining"]).toContain("{count}");
    expect(ja["cloudResources.inventory.showAll"]).toContain("{count}");
    expect(ja["cloudResources.inventory.remaining"]).toContain("{count}");
    expect(en["common.refresh"]).toBe("Refresh");
    expect(ja["common.refresh"]).toBe("更新");
    expect(ja["cloudResources.inventory.title"]).toBe("リソース一覧");
    expect(ja["cloudResources.keys.title"]).toBe("外部APIキー");
    expect(ja["cloudResources.keys.empty"]).toBe(
      "まだ外部APIキーはありません。",
    );
  });

  test("surfaces clipboard failures instead of an unhandledrejection", () => {
    // navigator.clipboard.writeText can reject (permissions / insecure
    // context) — and this is the copy path for the once-only API-key token.
    expect(cloudResourcesViewSource).toMatch(
      /try \{\s*await navigator\.clipboard\.writeText\(value\);\s*\} catch \{/,
    );
    expect(cloudResourcesViewSource).not.toMatch(
      /await navigator\.clipboard\.writeText\(value\);\s*setCopied\(key\);/,
    );
    expect(cloudResourcesViewSource).toContain(
      "const [copyFailed, setCopyFailed]",
    );
    expect(cloudResourcesViewSource).toContain("setCopyFailed(true);");
    // Both copy surfaces render the announced error toast.
    expect(cloudResourcesViewSource).toContain(
      '<Toast tone="error">{t("cloudResources.copyFailed")}</Toast>',
    );
    expect(cloudResourcesViewSource).toContain(
      "<Show when={props.copyFailed}>",
    );
    expect(cloudResourcesViewSource).toContain("<Show when={copyFailed()}>");
    expect(en["cloudResources.copyFailed"]).toContain("Copy failed");
    expect(ja["cloudResources.copyFailed"]).toContain("コピーできませんでした");
  });

  test("loads resources and API keys as separate surfaces", () => {
    expect(cloudResourcesViewSource).toContain(
      "export function CloudResourcesPanel",
    );
    expect(cloudResourcesViewSource).toContain(
      "export function CloudApiKeysPanel",
    );
    expect(cloudResourcesViewSource).toContain("getCloudResourcesSnapshot");
    expect(cloudResourcesViewSource).toContain("getCloudResourceUsageSnapshot");
    expect(cloudResourcesViewSource).toContain("mergeCloudResourceUsageRows");
    expect(cloudResourcesViewSource).toContain("getCloudApiKeysSnapshot");
    expect(cloudResourcesViewSource).toContain(
      "getProviderCompatCloudflareWorkersInventory",
    );
    expect(cloudResourcesViewSource).toContain("inventoryLoading");
  });

  test("leaves docs-owned endpoints and key management off the resources body", () => {
    const bodyStart = cloudResourcesViewSource.indexOf(
      "function CloudResourceBody",
    );
    const keyCardStart = cloudResourcesViewSource.indexOf(
      "function ApiKeysCard",
    );
    const bodySource = cloudResourcesViewSource.slice(bodyStart, keyCardStart);

    expect(bodySource).toContain('t("cloudResources.usage.title")');
    expect(bodySource).toContain('t("cloudResources.management.title")');
    expect(bodySource).toContain("<UsageByResourceCard");
    expect(bodySource).toContain("<ResourcesCard");
    expect(bodySource).not.toContain("<ApiKeysCard");
    expect(bodySource).not.toContain('t("cloudResources.compat.title")');
    expect(bodySource).not.toContain('t("cloudResources.provider.title")');
    expect(cloudResourcesViewSource).not.toContain('t("cloudResources.ai.');
    expect(cloudResourcesViewSource).not.toContain('t("cloudResources.s3.');
    expect(cloudResourcesViewSource).not.toContain(
      't("cloudResources.baseUrl")',
    );
    expect(cloudResourcesViewSource).not.toContain("EndpointRow");
  });

  test("renders the page header before the auth-gated cloud body", () => {
    const headerIndex = cloudResourcesViewSource.indexOf(
      "<CloudResourcesHeader",
    );
    const authIndex = cloudResourcesViewSource.indexOf(
      "<AuthGuard loadingFallback={<CloudResourcesLoading />}>",
    );
    expect(headerIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(-1);
    expect(headerIndex).toBeLessThan(authIndex);
    expect(cloudResourcesViewSource).toContain("showHeader={false}");
  });

  test("links from cloud resources to the API keys surface", () => {
    const headerStart = cloudResourcesViewSource.indexOf(
      "function CloudResourcesHeader",
    );
    const loadingStart = cloudResourcesViewSource.indexOf(
      "function CloudApiKeysHeader",
    );
    const headerSource = cloudResourcesViewSource.slice(
      headerStart,
      loadingStart,
    );

    expect(headerSource).toContain('href="/advanced/workspace/keys"');
    expect(headerSource).toContain('t("workspaceSettings.tab.keys")');
    expect(headerSource).toContain("<KeyRound");
  });

  test("keeps raw resource identifiers behind an explicit copy action", () => {
    expect(cloudResourcesViewSource).toContain(
      't("cloudResources.resources.copyId")',
    );
    expect(cloudResourcesViewSource).not.toContain("av-cloud-res-id");
    expect(appViewsCssSource).not.toContain(".av-cloud-res-id");
  });

  test("uses current inventory groups as detail rows without making them the resource taxonomy", () => {
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
    expect(cloudResourcesViewSource).toContain("RESOURCE_FAMILY_LABEL_KEYS");
    expect(cloudResourcesViewSource).toContain("friendlyResourceFamilyName");
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
      "activeCloudApiTokens(result.data)",
    );
    expect(cloudResourcesViewSource).toContain(
      't("cloudResources.keys.createdNotice")',
    );
    expect(cloudResourcesViewSource).toContain(
      't("cloudResources.keys.secretNotice")',
    );
    expect(cloudResourcesViewSource).toContain("value={token()}");
    expect(cloudResourcesViewSource).toContain("{token.prefix}...");
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
    expect(cloudResourcesViewSource).toContain("setCreatedToken(null)");
    expect(en["cloudResources.keys.revoke"]).toBe("Revoke");
    expect(ja["cloudResources.keys.revoke"]).toBe("取り消し");
  });

  test("keeps compact resource controls responsive on mobile", () => {
    expect(appViewsCssSource).toContain(".av-cloud-res-group-title");
    expect(appViewsCssSource).toContain(".av-cloud-res-more");
    expect(appViewsCssSource).toContain(".av-cloud-res-group-head .tg-btn");
  });

  test("revoking another key does not destroy the once-only created-token display", () => {
    // The created token is shown exactly once; clearing it must be gated on
    // the revoked id matching the key it belongs to.
    expect(cloudResourcesViewSource).toContain(
      "const [createdTokenId, setCreatedTokenId]",
    );
    expect(cloudResourcesViewSource).toContain(
      "setCreatedTokenId(response.token_record.id);",
    );
    expect(cloudResourcesViewSource).toMatch(
      /if \(createdTokenId\(\) === tokenId\) \{\s*setCreatedToken\(null\);\s*setCreatedTokenId\(null\);\s*\}/,
    );
    // No unconditional clear remains in the revoke path.
    expect(cloudResourcesViewSource).not.toMatch(
      /revokeCloudApiKey\(tokenId\);\s*setCreatedToken\(null\);/,
    );
  });
});
