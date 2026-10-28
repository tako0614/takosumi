/**
 * アカウント (`/account[/:section]`): you, members, billing & usage, the
 * workspace, and CLI/API keys as one page with sections. Source-text tests, like
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
const currentWorkspaceSource = read("views/account/lib/current-workspace.tsx");

describe("AccountView", () => {
  test("one page with the five account sections as sub-routes", () => {
    for (const [href, key] of [
      ["/account", "account.section.me"],
      ["/account/members", "account.section.members"],
      ["/account/billing", "account.section.billing"],
      ["/account/workspace", "account.section.workspace"],
      ["/account/cli", "account.section.cli"],
    ] as const) {
      expect(source).toContain(`href: "${href}", labelKey: "${key}"`);
    }
    expect(source).toContain("<Tabs");
    expect(source).toContain("<ProfileSection session={props.session} />");
    expect(source).toContain(
      "<MembersTab workspaceId={workspaceId} session={props.session} />",
    );
    expect(source).toContain("<BillingTab workspaceId={workspaceId} />");
    expect(source).toContain("<WorkspaceTab />");
    expect(source).toContain("TakosumiApiKeysCard");
    expect(source).toContain("workspaceId={currentWorkspaceId() || undefined}");
    // An unknown section returns to the account page instead of a blank one.
    expect(source).toContain('fallback={<Navigate href="/account" />}');
    expect(ja["account.section.cli"]).toBe("CLI・APIから使う");
    expect(ja["account.section.billing"]).toBe("料金と利用量");
    expect(ja["account.section.workspace"]).toBe("スペース");
  });

  test("workspace-scoped sections name their workspace only when there are two or more", () => {
    expect(source).toContain("<WorkspaceScopeNote context={currentWorkspace} />");
    expect(currentWorkspaceSource).toContain("list().length >= 2");
    expect(currentWorkspaceSource).toContain(
      "props.context.multiple() ? props.context.current() : undefined",
    );
    // Without a workspace, the page offers the next step instead of a dead end.
    expect(source).toContain('t("workspace.noneCta")');
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
    expect(ja["account.profile.nameHint"]).toContain("オーナーと管理者");
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
