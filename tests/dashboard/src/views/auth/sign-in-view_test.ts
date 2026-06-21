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
const deploymentBrandSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/lib/deployment-brand.ts"),
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

  test("uses Google as the only first-party OAuth button", () => {
    expect(signInViewSource).toContain('type Provider = "google"');
    expect(signInViewSource).toContain('id: "google"');
    expect(signInViewSource).not.toContain('id: "github"');
    expect(signInViewSource).not.toContain("GitHub");
    expect(signInViewSource).toContain('fill="#4285f4"');
    expect(signInViewSource).toContain('fill="#34a853"');
  });

  test("uses Cloud-specific copy only on the Takosumi Cloud runtime", () => {
    expect(signInViewSource).toContain(
      'isTakosumiCloudRuntime() ? "auth.signInCloud" : "auth.signIn"',
    );
    expect(signInViewSource).toContain(
      'isTakosumiCloudRuntime() ? "auth.signInSubCloud" : "auth.signInSub"',
    );
    expect(en["auth.signInCloud"]).toContain("Takosumi Cloud");
    expect(en["auth.signInSubCloud"]).toContain("Google");
    expect(ja["auth.signInCloud"]).toContain("Takosumi Cloud");
    expect(ja["auth.signInSubCloud"]).toContain("Google");
    expect(deploymentBrandSource).toContain(
      'import.meta.env.VITE_TAKOSUMI_CLOUD === "1"',
    );
    expect(deploymentBrandSource).not.toContain(
      "as Record<string, string | undefined>",
    );
  });

  test("uses the provided tako.png logo without the old ink placeholder", () => {
    expect(signInViewSource).toContain("function BrandLogoMark()");
    expect(signInViewSource).toContain("auth-brand-mark");
    expect(signInViewSource).toContain(
      '<LogoMark size={48} title="Takosumi" />',
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
