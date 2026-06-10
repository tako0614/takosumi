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
 * OpenTofu module, VERIFIED by running the real compatibility analyzer
 * (`src/service/domains/sources/capsule_compatibility.ts`) against the exact git
 * path with the exact policy that flows at install time:
 *   - cloudflare-r2-storage     -> `ready`            (cloudflare_r2_bucket only)
 *   - aws-s3-storage            -> `auto_capsulized`  (aws_s3_bucket only)
 *     Both pass under the instance-wide DEFAULT policy (no installConfigId).
 *   - cloudflare-static-site    -> `ready`       under the curated, BOUNDED
 *     InstallConfig `cfg-official-cloudflare-static-site`
 *     (allowedResourceTypes: ["cloudflare_pages_project"]).
 *   - cloudflare-worker-service -> `needs_patch` under the curated, BOUNDED
 *     InstallConfig `cfg-official-talk`
 *     (allowedResourceTypes: ["cloudflare_workers_script",
 *     "cloudflare_workers_script_subdomain"]); only a `file()` build-artifact
 *     WARNING, NOT an error, so it is NOT `unsupported`.
 * All four are NOT `unsupported`, so `/install`'s `canContinue()` enables, i.e.
 * a live (not dead) install button. The last two carry a curated `installConfig`
 * id so the bounded allowlist (NOT the global default) gates them.
 *
 * Deliberately EXCLUDED (stay coming-soon): `takos` (needs D1/Queue/KV resource
 * types that no safe bounded config covers, plus a separate wrangler step after
 * apply) and the bundled Takos product apps (no terraform/provider/resource
 * blocks at all).
 *
 * `installConfig` is the REQUIRED curated id for entries that only pass under a
 * bounded config, and `undefined` for entries that pass under the default
 * policy. Keep this in sync with the data file; a new installable entry must be
 * added here deliberately AFTER verifying it is not `unsupported`.
 */
const VERIFIED_INSTALLABLE: Record<
  string,
  { git: string; path: string; installConfig?: string }
> = {
  "cloudflare-r2-storage": {
    git: "https://github.com/tako0614/takosumi.git",
    path: "opentofu-modules/cloudflare-r2-storage/module",
  },
  "aws-s3-storage": {
    git: "https://github.com/tako0614/takosumi.git",
    path: "opentofu-modules/aws-s3-storage/module",
  },
  "cloudflare-static-site": {
    git: "https://github.com/tako0614/takosumi.git",
    path: "opentofu-modules/cloudflare-static-site/module",
    installConfig: "cfg-official-cloudflare-static-site",
  },
  "cloudflare-worker-service": {
    git: "https://github.com/tako0614/takosumi.git",
    path: "opentofu-modules/cloudflare-worker-service/module",
    installConfig: "cfg-official-talk",
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
      if (entry.installConfigId) {
        // Curated bounded entries pin their InstallConfig in the deep link.
        expect(params.get("installConfig")).toBe(entry.installConfigId);
        expect([...params.keys()].sort()).toEqual([
          "git",
          "installConfig",
          "path",
          "ref",
        ]);
      } else {
        // Default-policy entries carry no installConfig param.
        expect(params.get("installConfig")).toBeNull();
        expect([...params.keys()].sort()).toEqual(["git", "path", "ref"]);
      }
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
      // Curated bounded entries must carry EXACTLY the verified InstallConfig id
      // (the bounded policy that makes them pass); default-policy entries must
      // not claim one (they pass under the instance-wide default).
      expect(entry.installConfigId).toBe(verified!.installConfig);
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

  test("takos stays coming-soon (no safe bounded one-click config)", () => {
    // takos needs D1/Queue/KV resource types that no safe bounded curated config
    // covers, and a separate wrangler step after `tofu apply`, so a single
    // Takosumi apply is not one-click. It must stay coming-soon.
    const entry = CATALOG.find((e) => e.id === "takos");
    expect(entry).toBeDefined();
    expect(entry!.installable).toBe(false);
    expect(entry!.installConfigId).toBeUndefined();
    expect((entry!.comingSoonReason ?? "").trim().length).toBeGreaterThan(0);
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
        // A coming-soon card must never carry a curated install config (it would
        // be a dead pointer to a bounded policy with no install affordance).
        expect(entry.installConfigId).toBeUndefined();
      }
    }
  });

  test("every curated installConfigId is a known seeded official InstallConfig", () => {
    // Guards against a typo'd or non-existent config id silently producing a
    // default-policy (still `unsupported`) check at install time. These ids are
    // the BOUNDED first-party configs seeded by officialInstallConfigs().
    const KNOWN_OFFICIAL_INSTALL_CONFIG_IDS = new Set([
      "cfg-official-cloudflare-static-site",
      "cfg-official-talk",
    ]);
    for (const entry of CATALOG) {
      if (entry.installConfigId === undefined) continue;
      expect(entry.installable).toBe(true);
      expect(KNOWN_OFFICIAL_INSTALL_CONFIG_IDS.has(entry.installConfigId)).toBe(
        true,
      );
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
