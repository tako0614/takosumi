import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const signInViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/auth/SignInView.tsx"),
  "utf8",
);
const shellCssSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/styles/shell.css"),
  "utf8",
);
const runtimeCapabilitiesSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/lib/runtime-capabilities.ts"),
  "utf8",
);

describe("SignInView disabled OAuth guidance", () => {
  test("uses install-specific disabled-provider copy only when a return install is pending", () => {
    expect(signInViewSource).toContain("const noProvidersMessage = () =>");
    expect(signInViewSource).toContain(
      "const providersLoadFailedMessage = () =>",
    );
    expect(signInViewSource).toContain(
      '? "auth.noProvidersMessageWithInstall"',
    );
    expect(signInViewSource).toContain(
      '? "auth.providersLoadFailedMessageWithInstall"',
    );
    expect(signInViewSource).toContain(': "auth.noProvidersMessage"');
    expect(signInViewSource).toContain(': "auth.providersLoadFailedMessage"');
  });

  test("keeps normal sign-in copy free of install assumptions", () => {
    expect(en["auth.noProvidersMessage"].toLowerCase()).not.toContain(
      "install",
    );
    expect(en["auth.providersLoadFailedMessage"].toLowerCase()).not.toContain(
      "install",
    );
    expect(ja["auth.noProvidersMessage"]).not.toContain("追加内容");
    expect(ja["auth.providersLoadFailedMessage"]).not.toContain("追加内容");
  });

  test("keeps pending install copy explicit that the install details are preserved", () => {
    expect(en["auth.noProvidersMessageWithInstall"].toLowerCase()).toContain(
      "install details",
    );
    expect(
      en["auth.providersLoadFailedMessageWithInstall"].toLowerCase(),
    ).toContain("install details");
    expect(ja["auth.noProvidersMessageWithInstall"]).toContain("追加内容");
    expect(ja["auth.providersLoadFailedMessageWithInstall"]).toContain(
      "追加内容",
    );
  });

  test("uses retry-oriented OAuth callback failure copy instead of protocol details", () => {
    expect(signInViewSource).toContain("signInErrorMessage");
    expect(signInViewSource).toContain('"auth.retryableCallbackFailure"');
    expect(signInViewSource).toContain(
      '"auth.retryableCallbackFailureWithDetail"',
    );
    expect(en["auth.retryableCallbackFailure"]).not.toMatch(
      /code|state|provider|oauth/i,
    );
    expect(ja["auth.retryableCallbackFailure"]).not.toMatch(
      /code|state|provider|oauth/i,
    );
  });

  test("lets visitors re-check sign-in method availability without losing the install return", () => {
    expect(signInViewSource).toMatch(
      /providersLoaded\(\)\s*&&\s*!providersLoadFailed\(\)\s*&&\s*!hasEnabledProvider\(\)/,
    );
    expect(signInViewSource).toContain(
      '<button type="button" class="sign-in-retry" onClick={loadProviders}>',
    );
    expect(signInViewSource).toContain('{t("auth.retryProviderCheck")}');
  });

  test("shows the pending install target name on the sign-in context", () => {
    expect(signInViewSource).toContain(
      '{pendingInstall()?.label ?? t("auth.installContextTitle")}',
    );
    expect(signInViewSource).not.toContain("ctx.sourceLabel");
    expect(en["auth.installContextAria"].toLowerCase()).toContain("service");
    expect(en["auth.installContextRootPath"].toLowerCase()).not.toContain(
      "module",
    );
    expect(ja["auth.installContextAria"]).toContain("サービス");
    expect(ja["auth.installContextRootPath"]).not.toContain("module");
  });

  test("renders generic provider descriptors returned by discovery", () => {
    expect(signInViewSource).toContain(
      "readonly TakosumiAccountsAuthProvider[]",
    );
    expect(signInViewSource).toContain(
      "setProviders(res.providers.filter(isDashboardOAuthProvider))",
    );
    expect(signInViewSource).toContain(
      'p.label?.trim() || t("auth.singleSignOn")',
    );
    expect(signInViewSource).not.toContain('type Provider = "google"');
    expect(signInViewSource).not.toContain('fill="#4285f4"');
  });

  test("auto-starts any sole configured OAuth method with a manual escape hatch", () => {
    expect(signInViewSource).toContain("createEffect(() =>");
    expect(signInViewSource).toContain("const shouldAutoStart = ():");
    expect(signInViewSource).toContain(
      'if (params.manual === "1") return false',
    );
    expect(signInViewSource).toContain(
      "return enabledProviders().length === 1",
    );
    expect(signInViewSource).toContain("select(provider.id)");
  });

  test("auto-start cannot become an inescapable OAuth-failure loop", () => {
    // A prior auto-start this session that never signed us in must not re-fire
    // (session-scoped breaker), and the callback retry link suppresses it too.
    expect(signInViewSource).toContain("autoStartAlreadyAttempted()");
    expect(signInViewSource).toContain("markAutoStartAttempted()");
    expect(signInViewSource).toContain("clearAutoStartAttempt()");
    expect(signInViewSource).toContain('"/sign-in?manual=1"');
    expect(signInViewSource).toContain(
      "`/sign-in?return=${encodeURIComponent(returnTo)}&manual=1`",
    );
  });

  test("uses document navigation when returning to the server-owned OIDC authorize route", () => {
    expect(signInViewSource).toContain(
      "function requiresDocumentNavigation(returnTo: string): boolean",
    );
    expect(signInViewSource).toContain('returnTo.startsWith("/oauth/")');
    expect(signInViewSource).toContain("location.assign(returnTo);");
    expect(signInViewSource).toContain("nav(returnTo, { replace: true });");
  });

  test("accepts legacy return_to links while normalizing onto the sign-in screen", () => {
    expect(signInViewSource).toContain("return_to?: string");
    expect(signInViewSource).toContain("params.return || params.return_to");
  });

  test("keeps provider-neutral copy in the OSS sign-in surface", () => {
    expect(signInViewSource).toContain("dashboardProductName()");
    expect(signInViewSource).toContain('t("auth.signInSub")');
    expect(signInViewSource).not.toContain("auth.signInCloud");
    expect(signInViewSource).not.toContain("isTakosumiCloudRuntime");
    expect(en["auth.signInSub"]).toContain("identity provider");
    expect(ja["auth.signInSub"]).toContain("ID プロバイダー");
    expect(en["auth.signInSub"].toLowerCase()).not.toContain("google");
    expect(ja["auth.signInSub"]).not.toContain("Google");
    expect(runtimeCapabilitiesSource).toContain(
      "initializeTakosumiRuntimeCapabilities",
    );
    expect(runtimeCapabilitiesSource).toContain("/v1/capabilities");
    expect(runtimeCapabilitiesSource).not.toContain("VITE_TAKOSUMI_CLOUD");
    expect(runtimeCapabilitiesSource).not.toContain("app-staging.takosumi.com");
    expect(runtimeCapabilitiesSource).not.toContain(
      "as Record<string, string | undefined>",
    );
  });

  test("uses the provided tako.png logo without the old ink placeholder", () => {
    expect(signInViewSource).toContain("function BrandLogoMark()");
    expect(signInViewSource).toContain("auth-brand-mark");
    expect(signInViewSource).toContain(
      "<LogoMark size={48} title={dashboardProductName()} />",
    );
    expect(signInViewSource).not.toContain("img src");
    expect(signInViewSource).not.toContain("TemporaryBrandMark");
    expect(signInViewSource).not.toContain("auth.brandDraft");
    expect(signInViewSource).not.toContain("auth.brandDraftMark");
    expect(signInViewSource).not.toContain("InkBackdrop");
    expect(signInViewSource).not.toContain("InkdropMark");
    expect(ja).not.toHaveProperty("auth.brandDraft");
  });

  test("keeps the sign-in screen centered with mobile-visible appearance controls", () => {
    expect(signInViewSource).toMatch(
      /<div class="auth-flow">[\s\S]*<SignInPanel \/>[\s\S]*<ThemeSwitcher \/>[\s\S]*<\/div>/,
    );
    expect(shellCssSource).toContain("justify-content: center;");
    expect(shellCssSource).toContain("width: min(100%, 416px);");
    expect(shellCssSource).toContain("translateY(clamp(10px, 4svh, 36px))");
    expect(shellCssSource).toContain("background: transparent;");
    expect(shellCssSource).not.toContain(
      "border: 1px dashed var(--tg-line-strong)",
    );
    expect(shellCssSource).not.toContain("repeating-linear-gradient");
    expect(shellCssSource).not.toMatch(
      /\.auth-theme-switcher\s*\{[\s\S]*?display:\s*none;/,
    );
  });
});
