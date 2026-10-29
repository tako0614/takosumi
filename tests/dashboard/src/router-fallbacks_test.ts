/**
 * Regression tests for FATAL FIX 3 — the dashboard router must never leave a
 * visitor on a blank screen. Older external links used `/signup` and `/login`,
 * but this SPA only ships a single `/sign-in` screen, and the SPA host serves a
 * 200 fallback for unknown paths.
 * Without redirect aliases and a catch-all, those CTA targets (and any typo
 * URL) mount the bundle with no matching <Route> and paint nothing.
 *
 * These are pure-source assertions (no DOM / SolidJS), runnable under
 * `bun test`, in the same style as `views/graph/graph-layering_test.ts`. They
 * read `index.tsx` and assert the route table keeps the fallback wiring, so a
 * future edit that drops a redirect or the catch-all fails loudly instead of
 * silently regressing to the white-screen bug.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveLegacyAppUrl } from "../../../dashboard/src/lib/app-links.ts";

const source = readFileSync(
  new URL("../../../dashboard/src/index.tsx", import.meta.url),
  "utf8",
);

/** Collect the `path="..."` values in document order from the route table. */
function routePaths(src: string): string[] {
  const paths: string[] = [];
  const re = /<Route\s+path="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) paths.push(m[1]);
  return paths;
}

describe("dashboard router fallbacks (FATAL FIX 3)", () => {
  test("/signup redirects to /sign-in (legacy external alias)", () => {
    expect(source).toMatch(
      /<Route\s+path="\/signup"\s+component=\{\(\)\s*=>\s*<RedirectWithQuery\s+to="\/sign-in"\s*\/>\}\s*\/>/,
    );
  });

  test("/login redirects to /sign-in (legacy external alias)", () => {
    expect(source).toMatch(
      /<Route\s+path="\/login"\s+component=\{\(\)\s*=>\s*<RedirectWithQuery\s+to="\/sign-in"\s*\/>\}\s*\/>/,
    );
  });

  test("a catch-all route exists so unknown paths never blank-screen", () => {
    const paths = routePaths(source);
    expect(paths).toContain("*");
  });

  test("server-owned OIDC routes force document navigation before NotFound", () => {
    const paths = routePaths(source);
    expect(paths).toContain("/oauth");
    expect(paths).toContain("/oauth/*path");
    expect(paths.indexOf("/oauth")).toBeLessThan(paths.indexOf("*"));
    expect(paths.indexOf("/oauth/*path")).toBeLessThan(paths.indexOf("*"));
    expect(source).toContain("function ServerOwnedRouteReload()");
    expect(source).toContain("window.location.replace(href);");
  });

  test("the catch-all is the LAST route so it never shadows a real route", () => {
    const paths = routePaths(source);
    expect(paths.indexOf("*")).toBe(paths.length - 1);
    // The wildcard must appear exactly once.
    expect(paths.filter((p) => p === "*").length).toBe(1);
  });

  test("the redirect target and existing core routes are still wired", () => {
    const paths = routePaths(source);
    // The redirect destination must be a real route, not another dead link.
    expect(paths).toContain("/sign-in");
    // A spot-check of routes the fix must not disturb, including old URLs
    // that now redirect.
    for (const p of [
      "/",
      "/home",
      "/capsules",
      "/connections",
      "/billing",
      "/runs",
      "/advanced/workspace",
      "/account",
    ]) {
      expect(paths).toContain(p);
    }
  });

  test("home, store and account are first-class routes; legacy connections redirect to Account", () => {
    expect(source).toContain('<Route path="/" component={AppListView} />');
    // `/new` is the store and install page; an old `?capsule=` locator alone
    // opens that app's page instead.
    expect(source).toContain('<Route path="/new" component={NewRoute} />');
    expect(source).toContain('resolveLegacyAppUrl("/new", untrack(() => location.search))');
    expect(source).toContain("appPage ? <Navigate href={appPage} /> : <InstallView />");
    expect(source).toContain(
      '<Route path="/connections" component={() => <RedirectWithQuery to="/account/connections" />} />',
    );
    expect(source).toContain('<Route path="/account" component={AccountView} />');
    expect(source).toContain('<Route path="/account/billing" component={() => <RedirectWithQuery to="/account/usage" />} />');
    expect(source).toContain(
      '<Route path="/account/:section" component={AccountView} />',
    );
    // An app's page (canonical `/apps/:id`) and the details opened from its
    // history stay routable.
    expect(source).toContain('<Route path="/apps/:id" component={AppPage} />');
    expect(source).toContain('<Route path="/runs/:id" component={RunView} />');
    expect(source).toContain(
      '<Route path="/run-groups/:id" component={RunGroupView} />',
    );
    expect(source).toContain(
      '<Route path="/notifications" component={NotificationsView} />',
    );
  });

  test("screens that were internal concepts redirect to where the behavior lives", () => {
    const redirects: readonly (readonly [string, string])[] = [
      ["/runs", "/"],
      ["/activity", "/"],
      ["/graph", "/"],
      ["/workloads", "/"],
      ["/services", "/"],
      ["/capsules", "/"],
      ["/settings", "/account"],
      ["/settings/account", "/account"],
      ["/settings/manage", "/account"],
      ["/settings/manage/hosted-resources", "/"],
      ["/advanced/workspace", "/account"],
      ["/workspace/settings", "/account"],
      ["/members", "/account"],
      ["/backups", "/account"],
      ["/output-shares", "/account"],
      ["/providers", "/account/connections"],
      ["/account/settings", "/account"],
      ["/account/profile", "/account"],
      ["/account/sessions", "/account"],
    ];
    for (const [from, to] of redirects) {
      expect(source).toMatch(
        new RegExp(
          `<Route\\s+path="${from.replace(/[/]/gu, "\\/")}"\\s+component=\\{\\(\\)\\s*=>\\s*<Navigate\\s+href="${to.replace(/[/]/gu, "\\/")}"\\s*\\/>\\}\\s*\\/>`,
        ),
      );
    }
    // Legacy billing URLs keep query parameters while opening personal usage.
    for (const from of ["/billing", "/settings/billing"]) {
      expect(source).toMatch(
        new RegExp(
          `<Route\\s+path="${from.replace(/[/]/gu, "\\/")}"\\s+component=\\{\\(\\)\\s*=>\\s*<RedirectWithQuery\\s+to="\\/account\\/usage"\\s*\\/>\\}\\s*\\/>`,
        ),
      );
    }
    // Old Workspace-settings tabs land on personal Account sections.
    expect(source).toContain('<Route\n        path="/advanced/workspace/:tab"');
    expect(source).toContain('<Route\n        path="/workspace/settings/:tab"');
    expect(source).toContain('case "members":\n      return "/account";');
    expect(source).toContain('case "connections":\n      return "/account/connections";');
    expect(source).toContain('case "billing":\n      return "/account/usage";');
    expect(source).toContain('case "interface-recovery":\n      return "/";');
    expect(source).toContain('default:\n      return "/account";');
    // Older app-page URLs land on the canonical page, their tab as a section.
    for (const from of [
      "/apps/:id/:tab",
      "/workloads/:id",
      "/workloads/:id/:tab",
      "/services/:id",
      "/services/:id/:tab",
      "/capsules/:id",
      "/capsules/:id/:tab",
    ]) {
      expect(source).toContain(`<Route path="${from}" component={RedirectLegacyAppPage} />`);
    }
    expect(source).toContain('<Navigate href={resolveLegacyAppUrl(location.pathname) ?? "/"} />');
    expect(source).toContain('<Route path="/apps" component={() => <Navigate href="/" />} />');
    // No removed screen is still mounted.
    for (const removed of [
      "WorkloadDetailView",
      "RunsListView",
      "ActivityView",
      "GraphView",
      "WorkloadListView",
      "SettingsView",
      "ManageView",
      "HostedResourcesView",
      "WorkspaceSettingsView",
      "AdvancedWorkspaceView",
    ]) {
      expect(source).not.toContain(removed);
    }
  });

  test("Navigate is imported from @solidjs/router", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bNavigate\b[^}]*\}\s*from\s*"@solidjs\/router"/,
    );
  });
});

describe("older app URLs resolve to the canonical app page", () => {
  test("app detail paths keep the app and turn the old tab into a section", () => {
    const cases: readonly (readonly [string, string, string | undefined])[] = [
      ["/workloads/cap_a", "", "/apps/cap_a"],
      ["/workloads/cap_a/danger", "", "/apps/cap_a#danger"],
      ["/workloads/cap_a/settings", "", "/apps/cap_a#settings"],
      ["/workloads/cap_a/deploys", "", "/apps/cap_a#version"],
      ["/services/cap_a/history", "", "/apps/cap_a#history"],
      ["/capsules/cap_a", "", "/apps/cap_a"],
      ["/apps/cap_a/connections", "", "/apps/cap_a#connections"],
      ["/apps/cap_a/overview", "", "/apps/cap_a"],
      ["/workloads/cap%20a", "", "/apps/cap%20a"],
      // The canonical page and non-app paths are not redirected.
      ["/apps/cap_a", "", undefined],
      ["/runs/run_a", "", undefined],
      ["/workloads", "", undefined],
    ];
    for (const [pathname, search, expected] of cases) {
      expect({ pathname, target: resolveLegacyAppUrl(pathname, search) }).toEqual({ pathname, target: expected });
    }
  });

  test("only a bare /new?capsule= locator leaves the install page", () => {
    expect(resolveLegacyAppUrl("/new", "?capsule=cap_a")).toBe("/apps/cap_a");
    expect(resolveLegacyAppUrl("/new", "")).toBeUndefined();
    expect(resolveLegacyAppUrl("/new", "?capsule=cap_a&git=https%3A%2F%2Fgithub.com%2Fo%2Fr")).toBeUndefined();
    expect(resolveLegacyAppUrl("/new", "?capsule=javascript:alert(1)")).toBeUndefined();
    // A resolved target never leaves the dashboard origin.
    for (const path of ["/workloads/%2F%2Fevil.test", "/workloads/..%2F..%2Fx"]) {
      const target = resolveLegacyAppUrl(path) ?? "";
      expect(target.startsWith("/apps/")).toBe(true);
      expect(new URL(target, "https://dashboard.test").origin).toBe("https://dashboard.test");
    }
  });
});
