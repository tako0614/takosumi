/**
 * Source-level invariants of 「スマホで使う」: it appears wherever the dashboard
 * already offers to open an app's screen, shows everything without a
 * disclosure, keeps both phones' add-to-home-screen steps on screen, and on a
 * phone is the chooser of how the screen opens (TASK-0119 step 4).
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
const appUi = read("views/app/app-ui.tsx");
const home = read("views/apps/AppListView.tsx");
const install = read("views/new/InstallView.tsx");
const run = read("views/runs/RunView.tsx");
const indexHtml = readFileSync(resolve(root, "../index.html"), "utf8");

describe("use on your phone", () => {
  test("the app page shows it after the problems, for the screen Open offers or the URL names", () => {
    const attention = page.indexOf("<AppAttentionSection");
    const phone = page.indexOf("<AppPhoneSection");
    const version = page.indexOf("<AppVersionSection");
    expect(attention).toBeGreaterThan(0);
    expect(phone).toBeGreaterThan(attention);
    expect(version).toBeGreaterThan(phone);
    expect(page).toContain('view().primaryAction === "open" || secondaryScreens(view()) ? chooserScreen() : undefined');
    // The chooser is for the screen the URL (`?open=`) or Open named, else the primary one.
    expect(page).toContain("list.find((screen) => screen.interfaceId === wanted) ?? list[0]");
    // It knows the app, the screen and its server-verified native clients.
    const mount = page.slice(phone, phone + 600);
    for (const prop of ["capsuleId={capsuleId()}", "interfaceId={screen().interfaceId}", "clients={screen().clients}"]) {
      expect({ prop, found: mount.includes(prop) }).toEqual({ prop, found: true });
    }
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
      "phoneGuidanceOrder(phone)",
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

  test("on a phone the options follow the design's order: native app, web, QR and sharing, remember", () => {
    const order = [
      'data-testid="app-phone-native"',
      'data-testid="app-phone-web"',
      "<Show when={phone}>{qrBlock()}</Show>",
      'data-testid="app-phone-remember"',
    ].map((marker) => section.indexOf(marker));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // On a computer the QR code comes before the steps, as before.
    expect(section.indexOf("<Show when={!phone}>{qrBlock()}</Show>")).toBeLessThan(section.indexOf('data-testid="app-phone-web"'));
    // Opening in a browser view or inside Takosumi is Takosumi Mobile's, not offered here.
    for (const value of Object.entries(ja).filter(([key]) => key.startsWith("app.phone.")).map(([, text]) => text)) {
      expect({ value, inside: value.includes("中で見る") || value.includes("ブラウザの画面") }).toEqual({ value, inside: false });
    }
  });

  test("an unverified app shows where it goes, needs an explicit confirmation and is never remembered", () => {
    // The destination is on screen whenever the app is unverified, not only while confirming.
    const unverified = section.indexOf("<Show when={!value().verified}>");
    expect(unverified).toBeGreaterThan(0);
    expect(section.slice(unverified, unverified + 300)).toContain("{destination(value())}");
    for (const field of ["value.target.package", "value.target.scheme", "value.target.host", "storeDestination(value.storeUrl)"]) {
      expect({ field, found: section.includes(field) }).toEqual({ field, found: true });
    }
    // A tap on the unverified app is a button that asks; the link exists only inside the confirmation.
    expect(section).toContain("onClick={askToOpenUnverified}");
    const confirm = section.indexOf("<Show when={!value().verified && confirming() ? nativeHref() : undefined}>");
    const link = section.indexOf('data-open-choice="native-unverified"');
    expect(confirm).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(confirm);
    // The confirmed link remembers nothing; only rememberableChoice decides what is kept.
    expect(section.slice(link - 400, link + 200)).not.toContain("keep(");
    expect(section).toContain("const value = rememberableChoice(choice, client(), platform);");
    // Its label is the checked name or a neutral one, never the screen's title or app name.
    expect(section).toContain('return client.name ?? t("app.phone.unverifiedName");');
  });

  test("Open and the Home tile open the way this device chose, and a computer keeps the new tab", () => {
    expect(appUi).toContain("screenOpenRoute(props.capsuleId, surface)");
    expect(appUi).toContain('return { href: route.href, target: "_blank", rel: "noreferrer noopener" };');
    expect(home).toContain("screenOpenRoute(props.app.inst.id, surface)");
    expect(home).toContain("{...openRouteAnchor(route())}");
    // 「開き方を変える」 next to Open leads to the chooser.
    expect(page).toContain('data-testid="app-open-change"');
    expect(page).toContain('{t("app.open.change")}');
  });

  test("no Smart App Banner: one page cannot name every app's native app", () => {
    expect(indexHtml).not.toContain("apple-itunes-app");
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

  test("the chooser's copy matches the design's words", () => {
    expect(ja["app.phone.nativeOpen"]).toBe("{name}で開く");
    expect(ja["app.phone.nativeInstall"]).toBe("{name}を入れる");
    expect(ja["app.phone.storeAppStore"]).toBe("App Storeで入れる");
    expect(ja["app.phone.webOpen"]).toBe("ブラウザで開く");
    expect(ja["app.phone.remember"]).toBe("この端末で覚える");
    expect(ja["app.open.change"]).toBe("開き方を変える");
    expect(ja["app.phone.unverifiedName"]).toBe("未確認のアプリ");
    expect(en["app.phone.unverifiedName"]).toBe("Unverified app");
    // Where notifications go is said for each way of opening.
    expect(ja["app.phone.nativeNotify"]).toContain("専用アプリ");
    expect(ja["app.phone.webNotify"]).toContain("ホーム画面に追加したときだけ");
  });
});
