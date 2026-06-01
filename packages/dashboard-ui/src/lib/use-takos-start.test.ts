import { describe, expect, it } from "vitest";
import {
  buildUseTakosStartUrl,
  DEFAULT_USE_TAKOS_TERMS_VERSION,
  defaultTakosUrlForHost,
  safeReturnTo,
  TAKOS_HOST_NOT_CONFIGURED_MESSAGE,
  tryDefaultTakosUrlForHost,
} from "./use-takos-start";

describe("Use Takos start URL", () => {
  it("builds the Cloud-owned /start handoff with terms acceptance", () => {
    const url = new URL(buildUseTakosStartUrl({
      origin: "https://accounts.takosumi.test",
      takosUrl: "https://takos.test",
      subject: "tsub_local",
      accountId: "acct_local",
      spaceId: "space_local",
      installationId: "inst_takos",
      appId: "takos.chat",
      returnTo: "/spaces/space_local/threads",
    }));

    expect(url.origin).toBe("https://accounts.takosumi.test");
    expect(url.pathname).toBe("/start");
    expect(url.searchParams.get("takos_url")).toBe("https://takos.test");
    expect(url.searchParams.get("subject")).toBe("tsub_local");
    expect(url.searchParams.get("account_id")).toBe("acct_local");
    expect(url.searchParams.get("space_id")).toBe("space_local");
    expect(url.searchParams.get("installation_id")).toBe("inst_takos");
    expect(url.searchParams.get("app_id")).toBe("takos.chat");
    expect(url.searchParams.get("terms_version")).toBe(
      DEFAULT_USE_TAKOS_TERMS_VERSION,
    );
    expect(url.searchParams.get("terms_accepted")).toBe("true");
    expect(url.searchParams.get("return_to")).toBe(
      "/spaces/space_local/threads",
    );
  });

  it("uses .test Takos for local-substrate hostnames", () => {
    expect(defaultTakosUrlForHost("accounts.takosumi.test")).toBe(
      "https://takos.test",
    );
    expect(defaultTakosUrlForHost("localhost")).toBe("https://takos.test");
  });

  it("throws a user-facing error for non-local hostnames when no operator env is set", () => {
    // The test environment does not set VITE_TAKOSUMI_DASHBOARD_TAKOS_URL,
    // so production hostnames must NOT silently default to takos.jp; the
    // SPA must surface a configuration error instead.
    expect(() => defaultTakosUrlForHost("accounts.takosumi.com")).toThrow(
      TAKOS_HOST_NOT_CONFIGURED_MESSAGE,
    );
  });

  it("tryDefaultTakosUrlForHost returns undefined without throwing when unconfigured", () => {
    expect(tryDefaultTakosUrlForHost("accounts.takosumi.com")).toBeUndefined();
    expect(tryDefaultTakosUrlForHost("accounts.takosumi.test")).toBe(
      "https://takos.test",
    );
  });

  it("keeps launch return paths local", () => {
    expect(safeReturnTo("/spaces/space_a/threads", "space_a")).toBe(
      "/spaces/space_a/threads",
    );
    expect(safeReturnTo("//evil.example/path", "space_a")).toBe(
      "/spaces/space_a/threads",
    );
    expect(safeReturnTo("https://evil.example/path", "space_a")).toBe(
      "/spaces/space_a/threads",
    );
  });
});
