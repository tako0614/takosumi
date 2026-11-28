import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(resolve(here, "../../../../../dashboard/src", rel), "utf8");

const formSource = read("components/ui/Form.tsx");
const spinnerSource = read("components/ui/Spinner.tsx");
const componentsCss = read("styles/components.css");
const appPageCss = read("views/app/app-page.css");
const installViewCss = read("views/new/install-view.css");
const accountViewSource = read("views/account/AccountView.tsx");
const appListSource = read("views/apps/AppListView.tsx");
const profileSource = read("views/account/sections/ProfileSection.tsx");
const versionSource = read("views/app/AppVersionSection.tsx");
const phoneSource = read("views/app/AppPhoneSection.tsx");

describe("dashboard form, spinner, title, and touch-target accessibility", () => {
  test("FormField links hints via aria-describedby without clobbering caller tokens", () => {
    expect(formSource).toContain("const hintId = createUniqueId();");
    expect(formSource).toContain('<span class="tg-field-hint" id={hintId}>');
    expect(formSource).toContain("const owned = new Set([hintId, errorId]);");
    expect(formSource).toContain("if (props.error) existing.push(errorId);");
    expect(formSource).toContain("else if (props.hint) existing.push(hintId);");
  });

  test("Form primitives guarantee an id when neither id nor name is supplied", () => {
    expect(formSource.match(/const resolvedId = \(\) => local\.id \?\? \(rest\.name \? undefined : fallbackId\);/gu))
      .toHaveLength(4);
    expect(appListSource).toContain('name="homeSearch"');
    expect(profileSource).toContain('name="language"');
    expect(profileSource).toContain('name="theme"');
    expect(versionSource).toContain('name="autoUpdate"');
    expect(versionSource).toContain('name="versionRef"');
    expect(phoneSource).toContain('name="rememberOpenChoice"');
  });

  test("Spinner hides its decorative SVG and supports decorative mode inside status regions", () => {
    expect(spinnerSource).toContain("decorative?: boolean;");
    expect(spinnerSource).toContain('<Loader2 size={props.size ?? 18} aria-hidden="true" />');
    expect(spinnerSource).toContain('aria-hidden={props.decorative ? "true" : undefined}');
  });

  test("Account sections update the browser document title", () => {
    expect(accountViewSource).toContain("setDocumentTitle(title())");
  });

  test("mobile touch targets stay at least 44px on wordmark, history detail, and git example links", () => {
    expect(componentsCss).toContain("a.wordmark {\n  min-height: var(--tg-control-height);\n}");
    expect(appPageCss).toMatch(/\.ap-history-link\s*\{[^}]*min-height:\s*44px;/u);
    expect(installViewCss).toMatch(/\.iv-git-example a\s*\{[^}]*min-height:\s*44px;/u);
    expect(installViewCss).toContain(".iv-app-intro p.iv-app-badge");
  });

  test("Wave 2 ergonomics: Home empty search recovery, RunView title & diagnostic copy, API key focus handoff, WorkspaceSwitcher retry target", () => {
    const runViewSource = read("views/runs/RunView.tsx");
    const apiKeysSource = read("views/account/components/TakosumiApiKeysCard.tsx");
    const shellCss = read("styles/shell.css");
    expect(appListSource).toContain('class="av-search-empty-wrap"');
    expect(appListSource).toContain('t("apps.showAllApps")');
    expect(appListSource).toContain("!isImeComposing(event)");
    expect(runViewSource).toContain("function DiagnosticPre(");
    expect(runViewSource).toContain('class="wa-pre-copy"');
    expect(runViewSource).toContain('parts.join(" · ")');
    expect(apiKeysSource).toContain("requestAnimationFrame(() => nameInputRef?.focus())");
    expect(apiKeysSource).toContain("requestAnimationFrame(() => createTriggerRef?.focus())");
    expect(shellCss).toMatch(/\.workspace-switcher-retry\s*\{[^}]*min-height:\s*36px;/u);
    expect(shellCss).toContain(".app-shell a:not(.tg-btn, .skip-link)");
  });

  test("Wave 3: skip link contrast, IME-safe Enter/Escape, sign-in targets, callback failure, page-level empty states, touch targets", () => {
    const shellCss = read("styles/shell.css");
    const baseCss = read("styles/base.css");
    const appViewsCss = read("styles/app-views.css");
    const accountViewsCss = read("styles/account-views.css");
    const storeBrowserCss = read("views/store/StoreBrowser.css");
    const installSheetSource = read("views/new/InstallSheet.tsx");
    const modalDialogSource = read("lib/modal-dialog.ts");
    const userMenuSource = read("views/account/components/auth/UserMenu.tsx");
    const appUiSource = read("views/app/app-ui.tsx");
    const signInSource = read("views/auth/SignInView.tsx");
    const billingTabSource = read("views/workspace/tabs/BillingTab.tsx");
    const emptyStateSource = read("components/ui/EmptyState.tsx");
    const appManageSource = read("views/app/AppManagePage.tsx");
    const routeErrorBoundarySource = read("components/RouteErrorBoundary.tsx");
    const legalViewSource = read("views/legal/LegalView.tsx");

    // The shell link reset must not repaint the skip link's white label.
    expect(shellCss).not.toMatch(/\.app-shell a:not\(\.tg-btn\)\s*[{:]/u);
    expect(baseCss).toMatch(/\.skip-link\s*\{[^}]*color:\s*var\(--tg-accent-fg\);/u);

    // Enter/Escape that belongs to an IME conversion is left alone.
    expect(installSheetSource.match(/event\.key === "Enter" && !isImeComposing\(event\)/gu)?.length).toBe(3);
    expect(installSheetSource).not.toMatch(/event\.key === "Enter"\)/u);
    expect(modalDialogSource).toContain("if (isImeComposing(event)) return;");
    expect(userMenuSource).toContain('e.key === "Escape" && !isImeComposing(e)');
    expect(appUiSource).toContain('event.key === "Escape" && !isImeComposing(event)');

    // First-run sign-in controls reach 44px on touch, decorative arrows are
    // hidden from AT, and long JA titles wrap cleanly.
    expect(shellCss).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*\.auth-theme-btn\s*\{\s*width:\s*44px;\s*height:\s*44px;/u);
    expect(shellCss).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*\.sign-in-retry\s*\{\s*min-height:\s*var\(--tg-control-height\);/u);
    expect(shellCss).toMatch(/\.sign-in-title\s*\{[^}]*overflow-wrap:\s*anywhere;/u);
    expect(signInSource.match(/class="sign-in-arrow"[\s\S]*?aria-hidden="true"/gu)?.length).toBe(2);

    // The OAuth callback failure is a landmark with its own tab title, and
    // no dashboard view renders the legacy `.btn btn-secondary` class.
    expect(signInSource).toContain('if (error()) setDocumentTitle(t("auth.failed"));');
    expect(signInSource).toContain('<main class="auth-page">');
    expect(signInSource).not.toContain('class="btn btn-secondary"');
    expect(billingTabSource).not.toContain('class="btn btn-secondary"');
    expect(billingTabSource).toContain('class="tg-btn tg-btn-secondary"');

    // Page-level empty/error states still provide one h1 and an accurate title.
    expect(emptyStateSource).toContain('props.headingLevel === 1 ? "h1" : "h2"');
    expect(appManageSource.match(/headingLevel=\{1\}/gu)?.length).toBe(2);
    expect(appManageSource).toContain('notFound() ? t("app.notFound") : t("app.loadFailedTitle")');
    expect(routeErrorBoundarySource).toContain("headingLevel={1}");
    expect(appListSource).toContain('<Show when={!showSearch()}>\n              <div class="av-section-head">');

    // Legal navigation announces the current page and mobile touch targets
    // meet 44px across Legal, Store, Account tips, checkboxes, and toasts.
    expect(legalViewSource).toContain('aria-current={page() === key ? "page" : undefined}');
    expect(appViewsCss).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\.legal-brand,/u);
    expect(storeBrowserCss).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\.tcs-btn,[\s\S]*?min-height:\s*44px;/u);
    expect(accountViewsCss).toMatch(/\.tg-settings-tip > summary\s*\{[^}]*min-width:\s*var\(--tg-control-height\);/u);
    expect(componentsCss).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*\.tg-checkbox\s*\{\s*min-height:\s*var\(--tg-control-height\);/u);
    expect(componentsCss).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*\.tg-toast-dismiss\s*\{\s*min-width:\s*var\(--tg-control-height\);\s*min-height:\s*var\(--tg-control-height\);/u);
  });

  test("Wave 4: inline confirm focus/labels, empty-state cancel, nested main guard, reactive notifications ack, shared IME helper, touch targets, and CSS tokens", () => {
    const apiKeysSource = read("views/account/components/TakosumiApiKeysCard.tsx");
    const devicesSource = read("views/account/components/NotificationDevicesCard.tsx");
    const connectionsTabSource = read("views/workspace/tabs/ConnectionsTab.tsx");
    const pageSource = read("views/account/components/auth/Page.tsx");
    const authGuardSource = read("views/account/components/auth/AuthGuard.tsx");
    const storeBrowserSource = read("views/store/StoreBrowser.tsx");
    const notificationsLibSource = read("lib/notifications.ts");
    const notificationsViewSource = read("views/notifications/NotificationsView.tsx");
    const baseCss = read("styles/base.css");
    const waveBCss = read("styles/wave-b.css");
    const waveCCss = read("styles/wave-c.css");
    const appViewsCss = read("styles/app-views.css");

    // Inline confirms hand focus to Cancel on open, restore to trigger on
    // cancel, disable Cancel while busy, and give role="group" an aria-label.
    expect(apiKeysSource).toContain("requestAnimationFrame(() => cancelRevokeRef?.focus())");
    expect(apiKeysSource).toContain("requestAnimationFrame(() => revokeTriggerRef?.focus())");
    expect(apiKeysSource).toContain('aria-label={`${t("account.apiKeys.revoke")}: ${key.name}`}');
    expect(devicesSource).toContain("requestAnimationFrame(() => cancelRemoveRef?.focus())");
    expect(devicesSource).toContain("requestAnimationFrame(() => removeTriggerRef?.focus())");
    expect(devicesSource).toContain('aria-label={`${t("account.devices.remove")}: ${pusher.device_display_name}`}');

    // Empty-state connection creation can be closed back to EmptyState.
    expect(connectionsTabSource).toContain("!props.embedded || hasProviderConnections()");

    // AuthGuard inside Page.tsx renders <div> instead of nested <main>.
    expect(pageSource).toContain("<AuthGuard insideMain>");
    expect(authGuardSource).toContain('props.insideMain ? (\n              <div class="auth-page">{panel}</div>');

    // Remaining IME checks use the shared isImeComposing helper.
    expect(appListSource).toContain("isImeComposing(event)");
    expect(appListSource).not.toContain("keyCode !== 229");
    expect(storeBrowserSource.match(/!isImeComposing\(e\)/gu)?.length).toBe(3);
    expect(storeBrowserSource).not.toContain("keyCode !== 229");

    // Notifications page reacts to mark-all-read and preserves focus + SR announcement.
    expect(notificationsLibSource).toContain("void acknowledgedVersion();");
    expect(notificationsLibSource).toContain("setAcknowledgedVersion((n) => n + 1);");
    expect(notificationsViewSource).toContain('t("notif.attention", { n: 0 })');
    expect(notificationsViewSource).toContain('document.getElementById("main")?.focus()');

    // Disclosure summaries and skip link reach 44px on touch; undefined tokens are fixed.
    expect(baseCss).toMatch(/\.skip-link\s*\{[^}]*min-height:\s*var\(--tg-control-height\);/u);
    expect(waveBCss).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\.wb-disclosure > summary,\s*\.wb-inline-details > summary/u);
    expect(waveCCss).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\.wc-inline-details > summary,\s*\.wc-conn-test-detail > summary/u);
    expect(waveBCss).not.toContain("var(--tg-bg-elevated)");
    expect(waveBCss).toContain(".wb-billing-amount.tg-btn-primary span");
    expect(appViewsCss).not.toContain("var(--tg-fs-md)");
  });
});
