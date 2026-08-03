import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../../../../dashboard/src/views/account/components/auth/AuthGuard.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("AuthGuard session failure boundary", () => {
  test("renders maintenance/error states through the existing auth panel", () => {
    expect(source).toContain("onSessionStateChange");
    expect(source).toContain('state() === "maintenance" || state() === "error"');
    expect(source).toContain('<main class="auth-page">');
    expect(source).toContain('<div class="sign-in-panel notfound-panel">');
    expect(source).toContain('t("auth.sessionMaintenanceTitle")');
    expect(source).toContain('t("errorBoundary.title")');
    expect(source).toContain('{t("common.retry")}');
  });

  test("only unauthenticated state redirects to sign-in", () => {
    const failureBranch = source.slice(
      source.indexOf('setState(next.kind);'),
      source.indexOf('const retrySession'),
    );
    expect(failureBranch).toContain('next.kind === "unauthenticated"');
    expect(failureBranch).toContain("redirectToSignIn(preserveReturn)");
    expect(failureBranch).not.toContain('next.kind === "maintenance"');
    expect(failureBranch).not.toContain('next.kind === "error"');
  });
});
