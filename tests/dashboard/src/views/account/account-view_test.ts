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
    expect(source).not.toContain('<summary>{t("account.manage.title")}</summary>');
    expect(source).not.toContain('href="/billing"');
    expect(source).not.toContain('href="/connections"');
    expect(source).not.toContain('href="/activity"');
    expect(source).toContain('label: t("account.profile.displayName")');
    expect(source).toContain('label: t("account.profile.email")');
    expect(source).not.toContain(
      'label: t("account.profile.provider"),\n                value: props.session.provider ?? "—"',
    );
    expect(source).toContain(
      'label: t("account.profile.provider"),\n                    value: props.session.provider ?? "—"',
    );
    expect(source).not.toContain(
      'label: t("account.profile.subject"),\n                value: <code class="wc-code">{props.session.subject}</code>',
    );
    expect(source).toContain(
      'label: t("account.profile.subject"),\n                    value: <code class="wc-code">{props.session.subject}</code>',
    );
    expect(en["account.session.details"]).toBe("Support info");
    expect(ja["account.session.details"]).toBe("サポート情報");
    expect(en).not.toHaveProperty("account.manage.title");
    expect(ja).not.toHaveProperty("account.manage.title");
    expect(en["account.session.otherNote"]).not.toContain("coming soon");
    expect(ja["account.session.otherNote"]).not.toContain("準備中");
  });
});
