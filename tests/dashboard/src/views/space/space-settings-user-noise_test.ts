import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const viewRoot = resolve(import.meta.dir, "../../../../../dashboard/src/views");

const spaceSettingsSource = readFileSync(
  resolve(viewRoot, "space/SpaceSettingsView.tsx"),
  "utf8",
);
const generalTabSource = readFileSync(
  resolve(viewRoot, "space/tabs/GeneralTab.tsx"),
  "utf8",
);
const connectionsTabSource = readFileSync(
  resolve(viewRoot, "space/tabs/ConnectionsTab.tsx"),
  "utf8",
);
const userMenuSource = readFileSync(
  resolve(viewRoot, "account/components/auth/UserMenu.tsx"),
  "utf8",
);

describe("Workspace settings user-facing noise", () => {
  test("keeps recovery/share implementation routes out of the normal settings tabs", () => {
    expect(spaceSettingsSource).toContain('tab() === "backups"');
    expect(spaceSettingsSource).toContain('tab() === "shares"');
    expect(spaceSettingsSource).not.toContain(
      'href: "/advanced/workspace/backups"',
    );
    expect(spaceSettingsSource).not.toContain(
      'href: "/advanced/workspace/shares"',
    );
    expect(en["spaceSettings.subtitle"]).not.toContain("recovery");
    expect(en["spaceSettings.subtitle"]).not.toContain("sharing");
    expect(ja["spaceSettings.subtitle"]).not.toContain("復元");
    expect(ja["spaceSettings.subtitle"]).not.toContain("共有");
  });

  test("does not expose policy JSON editing on the general settings form", () => {
    expect(generalTabSource).toContain(
      "updateSpace(current.id, { displayName })",
    );
    expect(generalTabSource).not.toContain("policyDraft");
    expect(generalTabSource).not.toContain("Textarea");
    expect(generalTabSource).not.toContain("wc-policy-editor");
    expect(generalTabSource).not.toContain(
      '"spaceSettings.general.policyAdvanced"',
    );
  });

  test("does not render raw provider connection ids, sources, or env names in the cloud account list", () => {
    expect(connectionsTabSource).toContain("providerConnectionProviderLabel");
    expect(connectionsTabSource).not.toContain(
      '<code class="wc-code">{connection.id}</code>',
    );
    expect(connectionsTabSource).not.toContain("{connection.providerSource}");
    expect(connectionsTabSource).not.toContain("connectionEnvNames");
    expect(connectionsTabSource).not.toContain("c.envNames.join");
  });

  test("keeps connection creation behind an explicit action", () => {
    expect(connectionsTabSource).toContain("const shouldShowCreateForm = ()");
    expect(connectionsTabSource).toContain("const hasProviderConnections = ()");
    expect(connectionsTabSource).toContain("setCreateFormOpen(true)");
    expect(connectionsTabSource).toContain("setCreateFormOpen(false)");
    expect(connectionsTabSource).toContain('t("conn.empty.title")');
    expect(connectionsTabSource).toContain('t("conn.empty.message")');
    expect(connectionsTabSource).toContain('t("conn.add.open")');
    expect(connectionsTabSource).toContain('t("conn.add.close")');
    expect(connectionsTabSource).toContain(
      "const shouldShowCreateForm = () => createFormOpen();",
    );
    expect(en["conn.add.open"]).toBe("Add hosting access");
    expect(ja["conn.add.open"]).toBe("ホスト接続を追加");
    expect(en["conn.empty.title"]).toBe("No hosting access yet");
    expect(ja["conn.empty.title"]).toBe("ホスト接続はまだありません");
  });

  test("keeps raw account subjects out of the always-visible user menu", () => {
    expect(userMenuSource).toContain("session()?.email");
    expect(userMenuSource).not.toContain("{sub()}</div>");
    expect(userMenuSource).not.toContain("session()?.subject}");
  });
});
