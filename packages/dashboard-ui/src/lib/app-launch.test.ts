import { describe, expect, it } from "vitest";
import type { Installation } from "./api/installations";
import { appDetailLaunchState } from "./app-launch";

const baseInstallation: Installation = {
  installationId: "inst_takos",
  appId: "takos.chat",
  accountId: "acct_local",
  spaceId: "space_local",
  sourceGitUrl: "takos-product://managed/takos",
  status: "ready",
};

describe("app detail launch state", () => {
  it("builds a managed Takos launch handoff for the same installation", () => {
    const state = appDetailLaunchState(baseInstallation, {
      origin: "https://accounts.takosumi.test",
      hostname: "accounts.takosumi.test",
    });
    expect(state.label).toBe("Launch Takos");
    const url = new URL(state.href ?? "");
    expect(url.pathname).toBe("/dashboard/use-takos");
    expect(url.searchParams.get("takos_url")).toBe("https://takos.test");
    expect(url.searchParams.get("account_id")).toBe("acct_local");
    expect(url.searchParams.get("space_id")).toBe("space_local");
    expect(url.searchParams.get("installation_id")).toBe("inst_takos");
    expect(url.searchParams.get("app_id")).toBe("takos.chat");
  });

  it("uses an explicit launch URL when the API provides one", () => {
    const state = appDetailLaunchState({
      ...baseInstallation,
      appId: "example.app",
      sourceGitUrl: "https://github.com/example/app.git",
      launchUrl: "https://app.example.test/_takosumi/launch",
    }, {
      origin: "https://accounts.takosumi.test",
      hostname: "accounts.takosumi.test",
    });
    expect(state.label).toBe("Launch app");
    expect(state.href).toBe("https://app.example.test/_takosumi/launch");
  });

  it("explains non-ready states instead of showing a dead launch action", () => {
    const state = appDetailLaunchState({
      ...baseInstallation,
      status: "suspended",
    }, {
      origin: "https://accounts.takosumi.test",
      hostname: "accounts.takosumi.test",
    });
    expect(state.href).toBeUndefined();
    expect(state.description).toContain("suspended");
  });

  it("renders a graceful unavailable state instead of throwing when no Takos host is configured", () => {
    // Non-local host with VITE_TAKOSUMI_DASHBOARD_TAKOS_URL unset: the
    // throwing defaultTakosUrlForHost would crash the render here, so the
    // launch state must degrade to "unavailable" rather than throw.
    let state: ReturnType<typeof appDetailLaunchState> | undefined;
    expect(() => {
      state = appDetailLaunchState(baseInstallation, {
        origin: "https://accounts.takosumi.com",
        hostname: "accounts.takosumi.com",
      });
    }).not.toThrow();
    expect(state?.label).toBe("Launch unavailable");
    expect(state?.href).toBeUndefined();
    expect(state?.description).toContain("no Takos host is configured");
  });

  it("does not invent a launch URL for ready generic installations", () => {
    const state = appDetailLaunchState({
      ...baseInstallation,
      appId: "example.app",
      sourceGitUrl: "https://github.com/example/app.git",
    }, {
      origin: "https://accounts.takosumi.test",
      hostname: "accounts.takosumi.test",
    });
    expect(state.href).toBeUndefined();
    expect(state.description).toContain("no Cloud launch entry");
  });
});
