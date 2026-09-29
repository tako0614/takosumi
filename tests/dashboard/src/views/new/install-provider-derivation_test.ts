/**
 * The install entry names the provider set a scanned OpenTofu directory
 * actually requires, derived from that directory's module files.
 *
 * install-view_test.ts pins the view's call site (the chooser option renders
 * `moduleCandidateLabel(module)`). This file pins the inputs and the
 * user-visible text for a real derivation: the shared
 * `discoverOpenTofuModules` scan that SourceSnapshot persists, the
 * fail-closed dashboard normalizer, and the exact chooser label for each
 * candidate. A candidate carries its own provider set, and one module may
 * need more than one provider, so the label must never be a bare path and
 * never a fixed provider.
 */
import { describe, expect, test } from "bun:test";
import { discoverOpenTofuModules } from "../../../../../lib/opentofu-configuration/src/mod.ts";
import { setLocale, t } from "../../../../../dashboard/src/i18n/index.ts";
import {
  installModuleCatalogFromSnapshot,
  providerDisplayName,
  type InstallModuleCatalog,
} from "../../../../../dashboard/src/views/new/install-helpers.ts";

const CLOUDFLARE = `terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.19.1"
    }
  }
}`;

/** Second file in the same directory: the provider set is a union of files. */
const RANDOM = `terraform {
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.0"
    }
  }
}`;

/** Local child module: its providers are reachable, not root-declared. */
const EDGE_MODULE = `terraform {
  required_providers {
    http = {
      source  = "hashicorp/http"
      version = "= 3.6.0"
    }
  }
}`;

const ROOT_WITH_CHILD = `module "edge" {
  source = "./modules/edge"
}`;

const TAKOFORM_MODULE = `terraform {
  required_providers {
    takoform = {
      source  = "registry.opentofu.org/tako0614/takoform"
      version = "= 3.0.0"
    }
  }
}`;

/** A root that needs no provider package at all. */
const PROVIDER_FREE = `output "marker" {
  value = "static"
}`;

const MODULE_FILES = [
  { path: "main.tf", text: CLOUDFLARE },
  { path: "storage.tf", text: RANDOM },
  { path: "root.tf", text: ROOT_WITH_CHILD },
  { path: "modules/edge/main.tf", text: EDGE_MODULE },
  { path: "deploy/takoform/main.tf", text: TAKOFORM_MODULE },
  { path: "examples/static/main.tf", text: PROVIDER_FREE },
] as const;

function catalogFromModuleFiles(): InstallModuleCatalog {
  const discovery = discoverOpenTofuModules({ files: [...MODULE_FILES] });
  expect({ complete: discovery.complete }).toEqual({ complete: true });
  expect(discovery.diagnostics).toEqual([]);
  return installModuleCatalogFromSnapshot({
    status: "ready",
    sourceSnapshotId: "snap_modules",
    scopePath: ".",
    modules: discovery.modules,
  });
}

/**
 * The exact text the chooser option renders, composed the way
 * `moduleCandidateLabel` in InstallView.tsx composes it.
 */
function chooserLabel(module: {
  readonly path: string;
  readonly providerPackages: readonly { readonly source: string }[];
}): string {
  const providers = [
    ...new Set(
      module.providerPackages.map((provider) =>
        providerDisplayName(provider.source),
      ),
    ),
  ];
  return t("installStore.moduleOption", {
    path: module.path,
    providers:
      providers.length > 0
        ? providers.join(", ")
        : t("installStore.moduleNoProviders"),
  });
}

describe("install provider derivation", () => {
  test("derives each candidate provider set from that candidate directory's files", () => {
    const discovery = discoverOpenTofuModules({ files: [...MODULE_FILES] });
    const byPath = new Map(
      discovery.modules.map((module) => [
        module.path,
        module.providerPackages.map((provider) => provider.source),
      ]),
    );
    // A local child module contributes reachable packages but is not itself a
    // candidate root, and a root with no provider needs none.
    expect([...byPath.keys()].sort()).toEqual([
      ".",
      "deploy/takoform",
      "examples/static",
    ]);
    expect(byPath.get(".")).toEqual([
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/http",
      "registry.opentofu.org/hashicorp/random",
    ]);
    expect(byPath.get("deploy/takoform")).toEqual([
      "registry.opentofu.org/tako0614/takoform",
    ]);
    expect(byPath.get("examples/static")).toEqual([]);
  });

  test("labels every candidate with its own derived providers, never a bare path", () => {
    setLocale("ja");
    const catalog = catalogFromModuleFiles();
    if (catalog.status !== "ready") throw new Error(catalog.status);
    const labels = new Map(
      catalog.modules.map((module) => [module.path, chooserLabel(module)]),
    );
    // One module, several providers: the label is the whole derived set.
    expect(labels.get(".")).toBe(". — Cloudflare, Http, Random");
    expect(labels.get("deploy/takoform")).toBe("deploy/takoform — Takoform");
    // A scanned root that needs no provider says so instead of showing nothing.
    expect(labels.get("examples/static")).toBe(
      `examples/static — ${t("installStore.moduleNoProviders")}`,
    );
    expect(t("installStore.moduleNoProviders")).toBe("プロバイダー不要");
    // No candidate label may collapse to the bare directory path.
    for (const [path, label] of labels) {
      expect({ path, label }).not.toEqual({ path, label: path });
    }
  });

  test("keeps the root provider requirements the destination step binds", () => {
    const discovery = discoverOpenTofuModules({ files: [...MODULE_FILES] });
    const root = discovery.modules.find((module) => module.path === ".");
    expect(root?.rootProviderRequirements.map((entry) => entry.source)).toEqual(
      [
        "registry.opentofu.org/cloudflare/cloudflare",
        "registry.opentofu.org/hashicorp/random",
      ],
    );
    // More than one exact identity means more than one destination row is
    // possible for a single selected module.
    expect(root?.rootProviderRequirements.length).toBeGreaterThan(1);
  });

  test("a store-style extra field cannot invent a candidate or a provider", () => {
    const discovery = discoverOpenTofuModules({ files: [...MODULE_FILES] });
    // Store metadata is presentation only: a listing-declared provider must not
    // ride along on a scanned candidate.
    const injected = discovery.modules.map((module) => ({
      ...module,
      provider: "cloudflare",
    }));
    expect(
      installModuleCatalogFromSnapshot({
        status: "ready",
        sourceSnapshotId: "snap_modules",
        scopePath: ".",
        modules: injected,
      }),
    ).toEqual({ status: "invalid", modules: [] });
  });
});
