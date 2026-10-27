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

  test("the four behaviors are first-class routes", () => {
    expect(source).toContain('<Route path="/" component={AppListView} />');
    expect(source).toContain('<Route path="/new" component={InstallView} />');
    expect(source).toContain(
      '<Route path="/connections" component={ConnectionsView} />',
    );
    expect(source).toContain('<Route path="/account" component={AccountView} />');
    expect(source).toContain(
      '<Route path="/account/:section" component={AccountView} />',
    );
    // An app's page and the details opened from its history stay routable.
    expect(source).toContain(
      '<Route path="/workloads/:id" component={WorkloadDetailView} />',
    );
    expect(source).toContain(
      '<Route path="/workloads/:id/:tab" component={WorkloadDetailView} />',
    );
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
      ["/advanced/workspace", "/account/space"],
      ["/workspace/settings", "/account/space"],
      ["/members", "/account/members"],
      ["/backups", "/account/space"],
      ["/output-shares", "/account/space"],
      ["/providers", "/connections"],
      ["/account/settings", "/account/space"],
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
    // Billing keeps its query (a payment provider's return carries it).
    for (const from of ["/billing", "/settings/billing"]) {
      expect(source).toMatch(
        new RegExp(
          `<Route\\s+path="${from.replace(/[/]/gu, "\\/")}"\\s+component=\\{\\(\\)\\s*=>\\s*<RedirectWithQuery\\s+to="\\/account\\/billing"\\s*\\/>\\}\\s*\\/>`,
        ),
      );
    }
    // Old Workspace-settings tabs map onto 接続 and アカウント sections.
    expect(source).toContain('<Route\n        path="/advanced/workspace/:tab"');
    expect(source).toContain('<Route\n        path="/workspace/settings/:tab"');
    expect(source).toContain('case "members":\n      return "/account/members";');
    expect(source).toContain('case "connections":\n      return "/connections";');
    expect(source).toContain('case "billing":\n      return "/account/billing";');
    expect(source).toContain('case "interface-recovery":\n      return "/";');
    expect(source).toContain('default:\n      return "/account/space";');
    // No removed screen is still mounted.
    for (const removed of [
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
