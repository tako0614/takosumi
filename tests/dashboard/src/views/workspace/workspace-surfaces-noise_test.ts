/**
 * 接続 / アカウント stay free of developer noise (TASK-0115): no generated
 * handles, no raw ids or env names, no folded "advanced" layers, and the
 * screens that were internal concepts are gone rather than hidden.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const viewRoot = resolve(import.meta.dir, "../../../../../dashboard/src/views");
const read = (path: string) => readFileSync(resolve(viewRoot, path), "utf8");

const connectionsTabSource = read("workspace/tabs/ConnectionsTab.tsx");
const connectionCreateFormSource = read(
  "workspace/connections/ConnectionCreateForm.tsx",
);
const accountViewSource = read("account/AccountView.tsx");
const sidebarSource = read("account/components/shell/Sidebar.tsx");
const topBarSource = read("account/components/shell/TopBar.tsx");
const userMenuSource = read("account/components/auth/UserMenu.tsx");

describe("workspace and account surfaces", () => {
  test("screens that no behavior needs are removed, not folded away", () => {
    for (const removed of [
      "workspace/WorkspaceSettingsView.tsx",
      "account/components/WorkspaceCreateForm.tsx",
      "account/components/shell/WorkspaceSwitcher.tsx",
      "account/lib/current-workspace.tsx",
      "workspace/tabs/WorkspaceTab.tsx",
      "workspace/tabs/MembersTab.tsx",
      "workspace/tabs/BackupsTab.tsx",
      "workspace/tabs/SharesTab.tsx",
      "workspace/tabs/InterfaceRecoveryTab.tsx",
      "settings/SettingsView.tsx",
      "settings/ManageView.tsx",
      "settings/HostedResourcesView.tsx",
      "activity/ActivityView.tsx",
      "graph/GraphView.tsx",
      "runs/RunsListView.tsx",
    ]) {
      expect({ removed, exists: existsSync(resolve(viewRoot, removed)) }).toEqual({
        removed,
        exists: false,
      });
    }
  });

  test("the live Account shell has no workspace or member management surface", () => {
    expect(accountViewSource).not.toContain("WorkspaceTab");
    expect(accountViewSource).not.toContain("MembersTab");
    expect(accountViewSource).not.toContain("WorkspaceCreateForm");
    expect(sidebarSource).not.toContain("WorkspaceSwitcher");
    expect(topBarSource).not.toContain("WorkspaceSwitcher");
  });

  test("connections never render raw ids, sources, or env names", () => {
    expect(connectionsTabSource).toContain("providerConnectionProviderLabel");
    expect(connectionsTabSource).toContain("providerConnectionDisplayName");
    expect(connectionsTabSource).not.toContain("managedProvider");
    expect(connectionsTabSource).not.toContain("{connection.id}");
    expect(connectionsTabSource).not.toContain("{connection.providerSource}");
    expect(connectionsTabSource).not.toContain("connectionEnvNames");
    expect(connectionsTabSource).not.toContain("c.envNames.join");
    expect(connectionCreateFormSource).not.toContain("managedProvider");
    expect(connectionCreateFormSource).not.toContain("connectionEnvNames");
    expect(connectionsTabSource).toContain(
      "onClick={() => void refetchProviderConnections()}",
    );
  });

  test("connection creation opens on an explicit action", () => {
    expect(connectionsTabSource).toContain(
      "const shouldShowCreateForm = () => createFormOpen();",
    );
    expect(connectionsTabSource).toContain("open={shouldShowCreateForm()}");
    expect(connectionsTabSource).toContain(
      "hasProviderConnections() ? () => setCreateFormOpen(false) : undefined",
    );
    expect(connectionCreateFormSource).toContain("<Show when={props.open ?? true}>");
    expect(connectionCreateFormSource).toContain("<Show when={props.onCancel}>");
    expect(en["conn.add.open"]).toBe("Add a connection");
    expect(ja["conn.add.open"]).toBe("接続を追加");
    expect(ja["conn.empty.title"]).toBe("まだクラウドをつないでいません");
    expect(ja["conn.empty.message"]).not.toMatch(/policy|approval|billing/u);
  });

  test("workspace and account copy uses スペース and the app vocabulary", () => {
    const keys = (Object.keys(ja) as Array<keyof typeof ja>).filter((key) =>
      ["nav.", "conn.", "account.", "notif."].some(
        (prefix) => key.startsWith(prefix),
      ),
    );
    expect(keys.length).toBeGreaterThan(50);
    for (const key of keys) {
      expect({ key, value: ja[key] }).not.toEqual(
        expect.objectContaining({
          value: expect.stringMatching(
            /ワークスペース|サービス|ワークロード|デプロイ|公開(?!リポジトリ)|反映/u,
          ),
        }),
      );
      expect({ key, value: en[key] }).not.toEqual(
        expect.objectContaining({
          value: expect.stringMatching(
            /\b(?:services?|workloads?|deploy(?:s|ed|ing)?)\b/iu,
          ),
        }),
      );
    }
  });

  test("keeps raw account subjects out of the always-visible user menu", () => {
    expect(userMenuSource).toContain("session()?.email");
    expect(userMenuSource).not.toContain("{sub()}</div>");
    expect(userMenuSource).not.toContain("session()?.subject}");
  });
});
