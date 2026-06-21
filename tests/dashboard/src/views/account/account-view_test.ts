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
  test("keeps support and management details folded out of the default account view", () => {
    expect(source).toContain('"account.session.details"');
    expect(source).toContain('class="wb-disclosure wc-advanced-settings"');
    expect(source).toContain('<summary>{t("account.manage.title")}</summary>');
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
    expect(en["account.session.details"]).toBe("Session details");
    expect(ja["account.session.details"]).toBe("セッション詳細");
    expect(en["account.manage.title"]).toBe("Advanced management");
    expect(ja["account.manage.title"]).toBe("高度な管理");
    expect(en["account.session.otherNote"]).not.toContain("coming soon");
    expect(ja["account.session.otherNote"]).not.toContain("準備中");
  });
});
