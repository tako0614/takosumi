import { describe, expect, it } from "vitest";
import { isLocalDashboardHost, shouldShowDevSignIn } from "./dev-sign-in";

describe("isLocalDashboardHost", () => {
  it("accepts local dashboard hosts", () => {
    expect(isLocalDashboardHost("localhost")).toBe(true);
    expect(isLocalDashboardHost("127.0.0.1")).toBe(true);
    expect(isLocalDashboardHost("[::1]")).toBe(true);
    expect(isLocalDashboardHost("accounts.takosumi.test")).toBe(true);
    expect(isLocalDashboardHost("app.localhost")).toBe(true);
  });

  it("rejects public dashboard hosts", () => {
    expect(isLocalDashboardHost("accounts.takosumi.com")).toBe(false);
    expect(isLocalDashboardHost("dashboard.example.com")).toBe(false);
  });
});

describe("shouldShowDevSignIn", () => {
  it("hides the bypass on public hosts even when a build flag is set", () => {
    expect(
      shouldShowDevSignIn({
        isDevBuild: true,
        flag: "true",
        hostname: "accounts.takosumi.com",
      }),
    ).toBe(false);
  });

  it("shows the bypass only for local dev builds or explicit local-substrate builds", () => {
    expect(
      shouldShowDevSignIn({
        isDevBuild: true,
        hostname: "localhost",
      }),
    ).toBe(true);
    expect(
      shouldShowDevSignIn({
        isDevBuild: false,
        flag: "true",
        hostname: "accounts.takosumi.test",
      }),
    ).toBe(true);
    expect(
      shouldShowDevSignIn({
        isDevBuild: false,
        hostname: "accounts.takosumi.test",
      }),
    ).toBe(false);
  });
});
