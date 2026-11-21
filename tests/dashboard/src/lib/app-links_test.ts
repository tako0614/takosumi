/**
 * The installed app's canonical URL and the older links that redirect to it
 * (TASK-0115 Phase 3a).
 */
import { describe, expect, test } from "bun:test";
import {
  APP_PAGE_SECTIONS,
  appPageHref,
  appPageSectionFromHash,
  installAttemptHref,
  isSameAppPaneNavigation,
  legacyAppTabSection,
  legacyInstallLocatorCapsuleId,
  reinstallHref,
  uninstallConnectionsHref,
  uninstallReturnHref,
} from "../../../../dashboard/src/lib/app-links.ts";
import { parseInstallPrefill } from "../../../../dashboard/src/lib/install-link.ts";

describe("install attempt links", () => {
  test("an unfinished install opens its install page by its id alone", () => {
    expect(installAttemptHref("gip_0123456789abcdef")).toBe("/new?installPlan=gip_0123456789abcdef");
    expect(() => installAttemptHref("gip_../x")).toThrow();
  });
});

describe("uninstall connection links", () => {
  test("an app id carries a return destination through connection setup", () => {
    const href = uninstallConnectionsHref("cap_states_e");
    expect(href).toBe("/connections?uninstallApp=cap_states_e");
    expect(uninstallReturnHref(new URL(href, "https://dashboard.example").search)).toBe("/apps/cap_states_e");
    expect(uninstallConnectionsHref("old app/id")).toBe("/connections");
  });

  test("other destinations, ambiguous ids and invalid app ids have no uninstall return", () => {
    for (const search of [
      "?return=%2Fnew", "?uninstallApp=%2F%2Fexample.invalid", "?uninstallApp=cap_a%2F..",
      "?uninstallApp=cap_a&uninstallApp=cap_b", "?uninstallApp=cap_",
      "?uninstallApp=cap_" + "a".repeat(129),
    ]) expect(uninstallReturnHref(search)).toBeUndefined();
  });
});

describe("app page links", () => {
  test("an app's page is /apps/:id, its sections are fragments", () => {
    expect(appPageHref("cap_a")).toBe("/apps/cap_a");
    expect(appPageHref("cap a/b")).toBe("/apps/cap%20a%2Fb");
    expect(appPageHref("cap_a", "settings")).toBe("/apps/cap_a#settings");
    expect(appPageHref("cap_a", "danger")).toBe("/apps/cap_a#danger");
    for (const section of Object.keys(APP_PAGE_SECTIONS)) {
      expect(appPageSectionFromHash(`#${section}`)).toBe(section);
    }
    expect(appPageSectionFromHash("")).toBeUndefined();
    expect(appPageSectionFromHash("#linked")).toBeUndefined();
    expect(appPageSectionFromHash("#constructor")).toBeUndefined();
    expect(appPageSectionFromHash("#app-settings")).toBeUndefined();
  });

  test("the draft stays on the canonical app while moving among its panes and overview", () => {
    const from = { pathname: "/apps/cap_a", search: "?experiment=1", hash: "#settings" };
    const connections = { ...from, hash: "#connections" };
    const overview = { ...from, hash: "" };
    expect(isSameAppPaneNavigation("cap_a", from, connections)).toBe(true);
    expect(isSameAppPaneNavigation("cap_a", connections, from)).toBe(true);
    expect(isSameAppPaneNavigation("cap_a", from, overview)).toBe(true);
    expect(isSameAppPaneNavigation("cap_a", overview, from)).toBe(true);
  });

  test("a changed route, query, or unknown fragment is not a pane switch", () => {
    const from = { pathname: "/apps/cap_a", search: "", hash: "#settings" };
    for (const to of [
      { ...from, pathname: "/apps/cap_b", hash: "#connections" },
      { ...from, pathname: "/workloads/cap_a/connections", hash: "" },
      { ...from, pathname: "/", hash: "" },
      { ...from, search: "?experiment=1", hash: "#connections" },
      { ...from, hash: "#unknown" },
      from,
    ]) {
      expect(isSameAppPaneNavigation("cap_a", from, to)).toBe(false);
    }
  });

  test("old tab routes keep landing on the part of the page they meant", () => {
    expect(legacyAppTabSection("settings")).toBe("settings");
    expect(legacyAppTabSection("history")).toBe("history");
    expect(legacyAppTabSection("danger")).toBe("danger");
    expect(legacyAppTabSection("deploys")).toBe("version");
    expect(legacyAppTabSection("connections")).toBe("connections");
    expect(legacyAppTabSection(undefined)).toBeUndefined();
    expect(legacyAppTabSection("overview")).toBeUndefined();
  });

  test("only a bare /new?capsule= locator opens the app page", () => {
    expect(legacyInstallLocatorCapsuleId("?capsule=cap_abc")).toBe("cap_abc");
    expect(legacyInstallLocatorCapsuleId("")).toBeUndefined();
    expect(legacyInstallLocatorCapsuleId("?capsule=cap_a&capsule=cap_b")).toBeUndefined();
    expect(legacyInstallLocatorCapsuleId("?capsule=https://evil.test")).toBeUndefined();
    expect(legacyInstallLocatorCapsuleId("?capsule=../secret")).toBeUndefined();
    // An app handoff or install prefill stays with the install page.
    expect(legacyInstallLocatorCapsuleId("?capsule=cap_a&product=takos&return_uri=https%3A%2F%2Fx.test")).toBeUndefined();
    expect(legacyInstallLocatorCapsuleId("?capsule=cap_a&git=https%3A%2F%2Fgithub.com%2Fo%2Fr")).toBeUndefined();
  });

  test("installing again pre-fills the repository on the install page and starts nothing", () => {
    const href = reinstallHref({ repositoryUrl: "https://github.com/example/office.git", ref: "main", name: "office" });
    expect(href.startsWith("/new?")).toBe(true);
    expect(parseInstallPrefill(href.slice("/new".length))).toEqual({
      git: "https://github.com/example/office.git",
      ref: "main",
      sourcePath: ".",
      path: "",
      name: "office",
    });
    // The Source subtree and module path come along; an unsafe path does not.
    const withPaths = reinstallHref({ repositoryUrl: "https://github.com/example/office.git", ref: "v2", sourcePath: "apps", path: "deploy/opentofu" });
    expect(parseInstallPrefill(withPaths.slice("/new".length))).toEqual({
      git: "https://github.com/example/office.git", ref: "v2", sourcePath: "apps", path: "deploy/opentofu",
    });
    expect(new URL(reinstallHref({ repositoryUrl: "https://github.com/example/office.git", path: "../escape" }), "https://d.test").searchParams.has("path")).toBe(false);
    // No known ref: none is invented.
    expect(new URL(reinstallHref({ repositoryUrl: "https://github.com/example/office.git" }), "https://d.test").searchParams.has("ref")).toBe(false);
    // A stored URL never carries credentials into the link.
    const scrubbed = new URL(reinstallHref({ repositoryUrl: "https://user:secret@github.com/example/office.git?access_token=abc#frag" }), "https://d.test");
    expect(scrubbed.searchParams.get("git")).toBe("https://github.com/example/office.git");
    expect(reinstallHref({})).toBe("/new");
    expect(reinstallHref({ repositoryUrl: "http://insecure.test/repo.git" })).toBe("/new");
  });
});
