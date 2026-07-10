import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const sourcePath = resolve(
  import.meta.dir,
  "../../../../../dashboard/src/views/account/AccountView.tsx",
);

const source = readFileSync(sourcePath, "utf8");

describe("AccountView", () => {
  test("keeps support details folded and team management out of account settings", () => {
    expect(source).toContain('"account.session.details"');
    expect(source).toContain('class="wb-disclosure wc-advanced-settings"');
    expect(source).not.toContain(
      '<summary>{t("account.manage.title")}</summary>',
    );
    expect(source).not.toContain('href="/billing"');
    expect(source).not.toContain('href="/connections"');
    expect(source).not.toContain('href="/activity"');
    expect(source).toContain('label: t("account.profile.displayName")');
    expect(source).toContain('label: t("account.profile.email")');
    expect(source).toContain('t("account.session.debug")');
    expect(
      source.indexOf('label: t("account.profile.provider")'),
    ).toBeGreaterThan(source.indexOf('t("account.session.debug")'));
    expect(
      source.indexOf('label: t("account.profile.subject")'),
    ).toBeGreaterThan(source.indexOf('t("account.session.debug")'));
    expect(source.indexOf('label: t("account.session.id")')).toBeGreaterThan(
      source.indexOf('t("account.session.debug")'),
    );
    expect(en["account.session.details"]).toBe("Session details");
    expect(ja["account.session.details"]).toBe("セッション詳細");
    expect(en["account.session.debug"]).toBe("Reference ID");
    expect(ja["account.session.debug"]).toBe("参照 ID");
    expect(en).not.toHaveProperty("account.manage.title");
    expect(ja).not.toHaveProperty("account.manage.title");
    expect(en["account.session.otherNote"]).not.toContain("coming soon");
    expect(ja["account.session.otherNote"]).not.toContain("準備中");
  });

  test("missing profile data reads as 未設定 / Not set, not a bare dash", () => {
    expect(source).toContain('t("account.profile.notSet")');
    // Neither sign-in-info row may fall back to the broken-looking "—".
    expect(source).not.toContain('props.session.displayName ?? "—"');
    expect(source).not.toContain('props.session.email ?? "—"');
    expect(en["account.profile.notSet"]).toBe("Not set");
    expect(ja["account.profile.notSet"]).toBe("未設定");
  });
});
