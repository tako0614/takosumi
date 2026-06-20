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

  test("lets visitors re-check sign-in method availability without losing the install return", () => {
    expect(signInViewSource).toMatch(
      /providersLoaded\(\)\s*&&\s*!providersLoadFailed\(\)\s*&&\s*!hasEnabledProvider\(\)/,
    );
    expect(signInViewSource).toContain(
      '<button type="button" class="sign-in-retry" onClick={loadProviders}>',
    );
    expect(signInViewSource).toContain('{t("auth.retryProviderCheck")}');
  });

  test("uses Google as the only first-party OAuth button", () => {
    expect(signInViewSource).toContain('type Provider = "google"');
    expect(signInViewSource).toContain('id: "google"');
    expect(signInViewSource).not.toContain('id: "github"');
    expect(signInViewSource).not.toContain("GitHub");
  });

  test("uses the provisional tako.png logo without the old ink placeholder", () => {
    expect(signInViewSource).toContain("function BrandLogoMark()");
    expect(signInViewSource).toContain("auth-brand-mark");
    expect(signInViewSource).toContain("<GeometricMark size={42} />");
    expect(signInViewSource).not.toContain("TemporaryBrandMark");
    expect(signInViewSource).not.toContain("auth.brandDraft");
    expect(signInViewSource).not.toContain("auth.brandDraftMark");
    expect(signInViewSource).not.toContain("InkBackdrop");
    expect(signInViewSource).not.toContain("InkdropMark");
    expect(ja).not.toHaveProperty("auth.brandDraft");
  });
});
