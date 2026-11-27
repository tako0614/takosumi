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
    expect(appListSource).toContain("!event.isComposing && event.keyCode !== 229");
    expect(runViewSource).toContain("function DiagnosticPre(");
    expect(runViewSource).toContain('class="wa-pre-copy"');
    expect(runViewSource).toContain('parts.join(" · ")');
    expect(apiKeysSource).toContain("requestAnimationFrame(() => nameInputRef?.focus())");
    expect(apiKeysSource).toContain("requestAnimationFrame(() => createTriggerRef?.focus())");
    expect(shellCss).toMatch(/\.workspace-switcher-retry\s*\{[^}]*min-height:\s*36px;/u);
    expect(shellCss).toContain(".app-shell a:not(.tg-btn)");
  });
});
