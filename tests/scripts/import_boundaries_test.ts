import { describe, expect, test } from "bun:test";
import { findImportBoundaryViolations } from "../../scripts/lib/import-boundaries.ts";

describe("TypeScript import boundary scanner", () => {
  test("rejects every Core import form that reaches provider implementations", () => {
    const violations = findImportBoundaryViolations([
      {
        path: "core/runtime.ts",
        content: 'import { registry } from "@takosumi/providers";',
      },
      {
        path: "core/type-only.ts",
        content: 'import type { Driver } from "@takosumi/providers/types";',
      },
      {
        path: "core/deep/reexport.ts",
        content: 'export { driver } from "../../providers/git/driver.ts";',
      },
      {
        path: "core/dynamic.ts",
        content:
          'type Registry = import("@takosumi/providers").Registry; const load = () => import("../providers/registry.ts");',
      },
    ]);

    expect(
      violations.map(({ path, specifier }) => ({ path, specifier })),
    ).toEqual([
      { path: "core/runtime.ts", specifier: "@takosumi/providers" },
      {
        path: "core/type-only.ts",
        specifier: "@takosumi/providers/types",
      },
      {
        path: "core/deep/reexport.ts",
        specifier: "../../providers/git/driver.ts",
      },
      {
        path: "core/dynamic.ts",
        specifier: "@takosumi/providers",
      },
      {
        path: "core/dynamic.ts",
        specifier: "../providers/registry.ts",
      },
    ]);
  });

  test("ignores prose and permits provider implementations at composition roots", () => {
    expect(
      findImportBoundaryViolations([
        {
          path: "core/example.ts",
          content:
            'const documentation = "import from @takosumi/providers"; // @takosumi/providers',
        },
        {
          path: "worker/src/worker_service.ts",
          content: 'import { composition } from "@takosumi/providers";',
        },
        {
          path: "providers/git/driver.ts",
          content:
            'import type { Port } from "../../core/adapters/vault/driver_ports.ts";',
        },
      ]),
    ).toEqual([]);
  });

  test("rejects leaf library imports into every upper implementation layer", () => {
    const violations = findImportBoundaryViolations([
      {
        path: "lib/rootgen/src/core.ts",
        content:
          'import { Controller } from "../../../core/domains/deploy-control/mod.ts";',
      },
      {
        path: "lib/graph/src/providers.ts",
        content: 'import type { Driver } from "@takosumi/providers/types";',
      },
      {
        path: "lib/policy/src/accounts.ts",
        content:
          'export { service } from "../../../accounts/service/src/mod.ts";',
      },
      {
        path: "lib/rootgen/src/worker.ts",
        content: 'type Bindings = import("worker/src/bindings.ts").Bindings;',
      },
      {
        path: "lib/rootgen/src/deploy.ts",
        content: 'const load = () => import("deploy/platform/worker.ts");',
      },
    ]);

    expect(
      violations.map(({ ruleId, path, specifier }) => ({
        ruleId,
        path,
        specifier,
      })),
    ).toEqual([
      {
        ruleId: "lib-upper-layer-import",
        path: "lib/rootgen/src/core.ts",
        specifier: "../../../core/domains/deploy-control/mod.ts",
      },
      {
        ruleId: "lib-upper-layer-import",
        path: "lib/graph/src/providers.ts",
        specifier: "@takosumi/providers/types",
      },
      {
        ruleId: "lib-upper-layer-import",
        path: "lib/policy/src/accounts.ts",
        specifier: "../../../accounts/service/src/mod.ts",
      },
      {
        ruleId: "lib-upper-layer-import",
        path: "lib/rootgen/src/worker.ts",
        specifier: "worker/src/bindings.ts",
      },
      {
        ruleId: "lib-upper-layer-import",
        path: "lib/rootgen/src/deploy.ts",
        specifier: "deploy/platform/worker.ts",
      },
    ]);
  });

  test("leaf libraries may depend on contracts and sibling leaf libraries", () => {
    expect(
      findImportBoundaryViolations([
        {
          path: "lib/rootgen/src/mod.ts",
          content: [
            'import type { DispatchGeneratedRoot } from "@takosumi/internal/deploy-control-api";',
            'import type { JsonValue } from "takosumi-contract";',
            'import { graph } from "../../graph/src/mod.ts";',
          ].join("\n"),
        },
      ]),
    ).toEqual([]);
  });
});
