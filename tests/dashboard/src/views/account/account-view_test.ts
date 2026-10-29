/**
 * アカウント (`/account[/:section]`): profile, usage,
 * and CLI/API keys as one page with sections. Source-text tests, like
 * the rest of the dashboard view suite.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const read = (relativePath: string) =>
  readFileSync(
    resolve(import.meta.dir, "../../../../../dashboard/src", relativePath),
    "utf8",
  );

const source = read("views/account/AccountView.tsx");
const profile = read("views/account/sections/ProfileSection.tsx");

describe("AccountView", () => {
  test("one page with personal sections as sub-routes", () => {
    for (const [href, key] of [
      ["/account", "account.section.me"],
      ["/account/usage", "account.section.usage"],
      ["/account/cli", "account.section.cli"],
    ] as const) {
      expect(source).toContain(`href: "${href}", labelKey: "${key}"`);
    }
    expect(source).toContain("<Tabs");
    expect(source).toContain("<ProfileSection session={props.session} />");
    expect(source).not.toContain("ConnectionsTab");
    expect(source).not.toContain("/account/connections");
    expect(source).toContain("<BillingTab />");
    expect(source).not.toContain("MembersTab");
    expect(source).not.toContain("WorkspaceTab");
    expect(source).toContain("TakosumiApiKeysCard");
    expect(source).not.toContain("currentWorkspaceId");
    // An unknown section returns to the account page instead of a blank one.
    expect(source).toContain('fallback={<Navigate href="/account" />}');
    expect(ja["account.section.cli"]).toBe("CLI・APIから使う");
    expect(ja["account.section.usage"]).toBe("料金と利用量");
    expect(en["account.section.usage"]).toBe("Billing and usage");
  });

  test("personal account sections do not load or ask the visitor to select a workspace", () => {
    expect(source).not.toContain("WorkspaceScopeNote");
    expect(source).not.toContain("createCurrentWorkspace");
    expect(source).not.toContain("workspace.noneCta");
  });

  test("自分 shows the profile plainly and signs out last, not as a red headline", () => {
    expect(profile).toContain('label: t("account.profile.displayName")');
    expect(profile).toContain('label: t("account.profile.email")');
    // No folded session/debug layer: subject ids and user agents are gone.
    expect(profile).not.toContain("<details");
    expect(profile).not.toContain("account.profile.subject");
    expect(profile).not.toContain("navigator.userAgent");
    // Sign-out is the last card and a secondary action with a confirmation.
    const signOutCard = profile.indexOf('t("account.signOut.title")');
    expect(signOutCard).toBeGreaterThan(profile.indexOf('t("account.preferences.title")'));
    expect(signOutCard).toBeGreaterThan(profile.indexOf('t("account.installTarget.title")'));
    expect(profile).not.toContain('variant="danger"');
    expect(profile).toContain('t("account.signOut.confirm")');
    // Who sees your name and email is stated where you read them.
    expect(ja["account.profile.nameHint"]).toContain("アプリの所有者");
  });

  test("operator account pages stay listed and leave the SPA", () => {
    expect(profile).toContain('"navigation.manage"');
    expect(profile).toContain('rel="external"');
  });

  test("missing profile data reads as 未設定 / Not set, not a bare dash", () => {
    expect(profile).toContain('t("account.profile.notSet")');
    expect(profile).not.toContain('props.session.displayName ?? "—"');
    expect(profile).not.toContain('props.session.email ?? "—"');
    expect(en["account.profile.notSet"]).toBe("Not set");
    expect(ja["account.profile.notSet"]).toBe("未設定");
  });
});
