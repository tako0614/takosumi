/**
 * Source-level invariants of 「スマホで使う」: it appears wherever the dashboard
 * already offers to open an app's screen, shows everything without a
 * disclosure, and keeps both phones' add-to-home-screen steps on screen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const root = resolve(import.meta.dir, "../../../../../dashboard/src");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const section = read("views/app/AppPhoneSection.tsx");
const css = read("views/app/app-phone.css");
const page = read("views/app/AppManagePage.tsx");
const install = read("views/new/InstallView.tsx");
const run = read("views/runs/RunView.tsx");

describe("use on your phone", () => {
  test("the app page shows it after the problems, for the screen Open offers", () => {
    const attention = page.indexOf("<AppAttentionSection");
    const phone = page.indexOf("<AppPhoneSection");
    const version = page.indexOf("<AppVersionSection");
    expect(attention).toBeGreaterThan(0);
    expect(phone).toBeGreaterThan(attention);
    expect(version).toBeGreaterThan(phone);
    expect(page).toContain('view().primaryAction === "open" || secondaryScreens(view()) ? screens()[0] : undefined');
  });

  test("the end of an install and of an applied run show it with the screen they open", () => {
    expect(install).toContain("<Show when={!handoff() && done().url}>");
    expect(install).toContain("<AppPhoneSection url={url()}");
    // Outside the completion's live region, so it is not read out whole.
    expect(install.indexOf("<AppPhoneSection")).toBeGreaterThan(install.indexOf('data-testid="install-complete"'));
    expect(install.slice(install.indexOf('data-testid="install-complete"'), install.indexOf("<AppPhoneSection"))).toContain("</section>");
    expect(run).toContain('r().status === "succeeded" && r().type === "apply" && completedRunLaunchUrl()');
    expect(run).toContain("<AppPhoneSection url={url()}");
  });

  test("everything is on screen: QR code, URL, share, both phones and the users-only sentence", () => {
    for (const marker of [
      'data-testid="app-phone-qr"',
      'data-testid="app-phone-url"',
      '"app.phone.share"',
      '"app.phone.copy"',
      '"app.phone.usersOnly"',
      '"app.phone.iosSteps"',
      '"app.phone.androidSteps"',
      "phoneGuidanceOrder(current)",
    ]) {
      expect({ marker, found: section.includes(marker) }).toEqual({ marker, found: true });
    }
    // The owner rule: nothing behind a disclosure, toggle or accordion.
    for (const hidden of ["<details", "<summary", "aria-expanded", "setExpanded", "setOpen"]) {
      expect({ hidden, found: section.includes(hidden) }).toEqual({ hidden, found: false });
    }
    expect(section).not.toContain("innerHTML");
    // Only a URL Open would offer reaches the QR code or the share sheet.
    expect(section).toContain("<Show when={phoneLaunchUrl(props.url)}>");
  });

  test("copying gives visible feedback in a live region", () => {
    expect(section).toContain('role="status"');
    expect(section).toContain('"app.phone.copied"');
    expect(section).toContain('"app.phone.copyFailed"');
  });

  test("the code stays dark on light in both themes and stacks on a phone", () => {
    expect(css).toContain("var(--tg-fixed-light-bg)");
    expect(css).toContain("var(--tg-fixed-light-fg)");
    expect(css).toMatch(/@media \(max-width: 39\.99rem\)[\s\S]*\.ap-phone \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  });

  test("the copy names the steps on both phones and that users need only the URL", () => {
    expect(ja["app.phone.title"]).toBe("スマホで使う");
    expect(en["app.phone.title"]).toBe("Use on your phone");
    expect(ja["app.phone.iosSteps"]).toContain("ホーム画面に追加");
    expect(ja["app.phone.androidSteps"]).toContain("ホーム画面に追加");
    expect(ja["app.phone.androidSteps"]).toContain("アプリをインストール");
    expect(en["app.phone.iosSteps"]).toContain("Add to Home Screen");
    expect(en["app.phone.androidSteps"]).toContain("Install app");
    expect(ja["app.phone.usersOnly"]).toContain("URL");
    expect(ja["app.phone.usersOnly"]).toContain("メンバー");
    expect(en["app.phone.usersOnly"]).toContain("members");
  });
});
