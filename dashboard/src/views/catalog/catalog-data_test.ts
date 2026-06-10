/**
 * Catalog data + prefill→install contract tests.
 *
 * These are pure-logic tests (no DOM / SolidJS) in the same style as
 * `dashboard/src/router-fallbacks_test.ts`, runnable under `bun test`. They lock
 * in the two load-bearing honesty/behaviour invariants of the Capsule Catalog:
 *
 *   1. The prefill deep link (`installHref`) matches the exact contract the
 *      InstallFromGitView `readPrefill()` reader expects: a `/install` path
 *      route with `git` / `ref` / `path` query params. If that drifts, the
 *      catalog "インストール" buttons would silently stop pre-filling.
 *
 *   2. The honesty contract: installable entries point at a known-good
 *      Git-fetchable OpenTofu Capsule (real first-party module path or the takos
 *      self-host Capsule), and coming-soon entries carry a reason and are NOT
 *      treated as installable. This guards against a future edit flipping a
 *      bundled-app card to `installable: true` (which would be a dead button
 *      that returns an Unsupported / empty-provision compatibility result).
 */
import { describe, expect, test } from "bun:test";
import {
  CATALOG,
  type CatalogEntry,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  installHref,
} from "./catalog-data.ts";

/** The git remotes that are genuinely Capsule-installable in this ecosystem. */
const KNOWN_GIT_REMOTES = new Set([
  "https://github.com/tako0614/takos.git",
  "https://github.com/tako0614/takosumi.git",
  "https://github.com/tako0614/yurucommu.git",
  "https://github.com/tako0614/road-to-me.git",
  "https://github.com/tako0614/takos-docs.git",
  "https://github.com/tako0614/takos-slide.git",
  "https://github.com/tako0614/takos-excel.git",
  "https://github.com/tako0614/takos-computer.git",
]);

/**
 * Entries whose `installable: true` claim is backed by an actual Gate-passing
 * OpenTofu module, VERIFIED by running the real default-policy compatibility
 * analyzer (`src/service/domains/sources/capsule_compatibility.ts`) against the
 * exact git path:
 *   - cloudflare-r2-storage -> `ready`           (cloudflare_r2_bucket only)
 *   - aws-s3-storage        -> `auto_capsulized` (aws_s3_bucket only)
 * Both are NOT `unsupported`, so `/install`'s `canContinue()` enables, i.e. a
 * live (not dead) install button.
 *
 * Deliberately EXCLUDED because the same analyzer returns `unsupported` under
 * the default policy (would be a dead button):
 *   - takos                     (cloudflare_d1_database / _queue / _workers_kv_namespace)
 *   - cloudflare-static-site    (cloudflare_pages_project)
 *   - cloudflare-worker-service (cloudflare_workers_script_subdomain)
 *
 * Keep this list in sync with the data file; a new installable entry must be
 * added here deliberately AFTER verifying it is not `unsupported`.
 */
const VERIFIED_INSTALLABLE: Record<string, { git: string; path: string }> = {
  "cloudflare-r2-storage": {
    git: "https://github.com/tako0614/takosumi.git",
    path: "opentofu-modules/cloudflare-r2-storage/module",
  },
  "aws-s3-storage": {
    git: "https://github.com/tako0614/takosumi.git",
    path: "opentofu-modules/aws-s3-storage/module",
  },
};

function parseHref(href: string): {
  pathname: string;
  params: URLSearchParams;
} {
  // Resolve against a dummy origin so URLSearchParams parses the query.
  const url = new URL(href, "https://app.takosumi.test");
  return { pathname: url.pathname, params: url.searchParams };
}

describe("installHref — prefill→install contract", () => {
  test("targets the /install path route with git/ref/path query params", () => {
    const entry = CATALOG.find((e) => e.id === "takos")!;
    const { pathname, params } = parseHref(installHref(entry));
    expect(pathname).toBe("/install");
    expect(params.get("git")).toBe(entry.gitUrl);
    expect(params.get("ref")).toBe(entry.ref);
    expect(params.get("path")).toBe(entry.path);
  });

  test("round-trips every installable entry exactly (no lost/extra params)", () => {
    for (const entry of CATALOG.filter((e) => e.installable)) {
      const { pathname, params } = parseHref(installHref(entry));
      expect(pathname).toBe("/install");
      expect(params.get("git")).toBe(entry.gitUrl);
      expect(params.get("ref")).toBe(entry.ref);
      expect(params.get("path")).toBe(entry.path);
      // No accidental extra keys beyond the three the reader consumes.
      expect([...params.keys()].sort()).toEqual(["git", "path", "ref"]);
    }
  });
});

describe("catalog data integrity", () => {
  test("ids are unique", () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every entry has plain-Japanese title + summary and a known git remote", () => {
    for (const entry of CATALOG) {
      expect(entry.title.trim().length).toBeGreaterThan(0);
      expect(entry.summary.trim().length).toBeGreaterThan(0);
      expect(entry.ref.trim().length).toBeGreaterThan(0);
      expect(entry.path.trim().length).toBeGreaterThan(0);
      expect(KNOWN_GIT_REMOTES.has(entry.gitUrl)).toBe(true);
    }
  });

  test("every category is one of the declared CATEGORY_ORDER values", () => {
    for (const entry of CATALOG) {
      expect(CATEGORY_ORDER).toContain(entry.category);
      expect(CATEGORY_LABELS[entry.category]).toBeDefined();
    }
  });

  test("there is at least one genuinely installable entry", () => {
    expect(CATALOG.some((e) => e.installable)).toBe(true);
  });
});

describe("honesty contract", () => {
  test("each installable entry matches a verified Gate-passing Capsule path", () => {
    for (const entry of CATALOG.filter((e) => e.installable)) {
      const verified = VERIFIED_INSTALLABLE[entry.id];
      expect(verified).toBeDefined();
      expect(entry.gitUrl).toBe(verified!.git);
      expect(entry.path).toBe(verified!.path);
    }
  });

  test("no entry is installable unless it is in the verified set", () => {
    // A new installable entry MUST be added to VERIFIED_INSTALLABLE on purpose;
    // this fails loudly if someone flips a bundled-app card to installable
    // without verifying it is a real Capsule.
    const installableIds = CATALOG.filter((e) => e.installable).map(
      (e) => e.id,
    );
    for (const id of installableIds) {
      expect(Object.keys(VERIFIED_INSTALLABLE)).toContain(id);
    }
  });

  test("policy-blocked Capsules stay coming-soon (verified unsupported)", () => {
    // These resolve to `unsupported` under the default compatibility policy, so
    // an install button would be dead. Lock them as coming-soon.
    const blocked = [
      "takos",
      "cloudflare-static-site",
      "cloudflare-worker-service",
    ];
    for (const id of blocked) {
      const entry = CATALOG.find((e) => e.id === id);
      expect(entry).toBeDefined();
      expect(entry!.installable).toBe(false);
      expect((entry!.comingSoonReason ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  test("the bundled Takos apps are coming-soon (not dead install buttons)", () => {
    // These ship only a `takos_app_manifest` outputs.tf (no terraform/provider/
    // resource blocks), so they are Takos product apps, not Takosumi Capsules.
    // They must stay coming-soon with a reason and no install affordance.
    const bundled = [
      "yurucommu",
      "road-to-me",
      "takos-docs",
      "takos-slide",
      "takos-excel",
      "takos-computer",
    ];
    for (const id of bundled) {
      const entry = CATALOG.find((e) => e.id === id);
      expect(entry).toBeDefined();
      expect(entry!.installable).toBe(false);
      expect((entry!.comingSoonReason ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  test("coming-soon entries always carry a reason; installable ones never claim one", () => {
    for (const entry of CATALOG) {
      if (entry.installable) {
        expect(entry.comingSoonReason).toBeUndefined();
      } else {
        expect((entry.comingSoonReason ?? "").trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("route wiring guard", () => {
  test("index.tsx wires the /catalog route to CatalogView", () => {
    const indexSrc = require("node:fs").readFileSync(
      new URL("../../index.tsx", import.meta.url),
      "utf8",
    ) as string;
    expect(indexSrc).toMatch(
      /<Route\s+path="\/catalog"\s+component=\{CatalogView\}\s*\/>/,
    );
    expect(indexSrc).toMatch(
      /import\("\.\/views\/catalog\/CatalogView\.tsx"\)/,
    );
  });
});

// Touch the CatalogEntry type so a `noUnusedLocals` build stays clean while
// keeping the import available for readers of this test.
const _typecheckProbe: CatalogEntry | undefined = CATALOG[0];
void _typecheckProbe;
