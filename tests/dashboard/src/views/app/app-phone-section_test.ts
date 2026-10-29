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

  test("the end of an install shows it with the screen it opens, outside the completion's live region", () => {
    // An App Handoff return goes back to the app that sent the person here.
    expect(install).toContain("<Show when={!handoff() && done().url}>");
    expect(install).toContain("<AppPhoneSection url={url()}");
    // Outside the completion's live region, so it is not read out whole.
    expect(install.indexOf("<AppPhoneSection")).toBeGreaterThan(install.indexOf('data-testid="install-complete"'));
    expect(install.slice(install.indexOf('data-testid="install-complete"'), install.indexOf("<AppPhoneSection"))).toContain("</section>");
  });

  test("the end of an applied run shows it beside the summary card, never during an App Handoff return", () => {
    const mount = run.indexOf("<AppPhoneSection");
    expect(mount).toBeGreaterThan(0);
    expect(run.indexOf("<AppPhoneSection", mount + 1)).toBe(-1);
    // The exact condition, App Handoff exclusion first.
    const condition = '<Show when={!appHandoff && r().status === "succeeded" && r().type === "apply" && completedRunLaunchUrl()}>';
    expect(run).toContain(condition);
    expect(run.lastIndexOf("<Show when=", mount)).toBe(run.indexOf(condition));
    // Its own card: the nearest Card before it is already closed.
    const before = run.slice(0, mount);
    expect(before.lastIndexOf("</Card>")).toBeGreaterThan(before.lastIndexOf("<Card>"));
    // The screen's display name, then the app's name; the section has its own fallback.
    expect(run.slice(mount, mount + 300)).toContain("completedRunUiSurfaces()?.[0]?.name) ?? appName()");
    expect(section).toContain('t("app.phone.qrAriaUnnamed")');
  });

  test("next to Open, the section's actions stay secondary", () => {
    expect(section).not.toContain('variant="primary"');
    expect(section.match(/variant="secondary"/gu)?.length).toBe(2);
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

  test("at the end of an install it takes the install card's width with a gap", () => {
    const installCss = read("views/new/install-view.css");
    expect(installCss).toContain(".iv-workbench { width: min(100%, 46rem);");
    expect(css).toContain(".iv-page > .ap-phone-section { width: min(100%, 46rem); margin: var(--tg-s-5) auto 0; }");
    expect(section).toContain('class="ap-phone-section"');
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
