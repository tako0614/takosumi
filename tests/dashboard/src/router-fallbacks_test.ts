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
    // A spot-check of pre-existing routes the fix must not disturb.
    for (const p of [
      "/",
      "/home",
      "/installations",
      "/connections",
      "/billing",
      "/runs",
      "/advanced/workspace",
      "/account",
    ]) {
      expect(paths).toContain(p);
    }
  });

  test("normal connection and billing routes stay first-class", () => {
    expect(source).toContain(
      '<Route path="/connections" component={ConnectionsView} />',
    );
    expect(source).toContain(
      '<Route path="/billing" component={BillingView} />',
    );
    expect(source).toContain(
      '<Route path="/advanced/workspace" component={AdvancedWorkspaceView} />',
    );
  });

  test("Navigate is imported from @solidjs/router", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bNavigate\b[^}]*\}\s*from\s*"@solidjs\/router"/,
    );
  });
});
