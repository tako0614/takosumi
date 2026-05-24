import assert from "node:assert/strict";
import {
  INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLER_INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLER_INSTALLATION_ROLLBACK_PATH,
  INSTALLER_INSTALLATIONS_DRY_RUN_PATH,
  INSTALLER_INSTALLATIONS_PATH,
} from "../packages/kernel/src/api/installer_public_routes.ts";
import { createPaaSOpenApiDocument } from "../packages/kernel/src/api/openapi.ts";

const root = new URL("../", import.meta.url);

const TAKOSUMI_OWNED_PATHS = [
  "docs/reference/public-spec-source-map.md",
  "docs/reference/app-spec.md",
  "docs/reference/build-spec.md",
  "docs/reference/installer-api.md",
  "docs/reference/kernel-http-api.md",
  "docs/reference/runtime-agent-api.md",
  "docs/reference/providers.md",
  // Reference kind descriptors live in @takos/takosumi-plugins rather than
  // the Takosumi AppSpec contract.
  "docs/reference/kind-registry.md",
  "packages/kernel/src/domains/deploy/_internal_manifest_types.ts",
  "packages/kernel/src/domains/deploy/manifest_v1.ts",
  "packages/kernel/src/api/app.ts",
  "packages/kernel/src/api/installer_public_routes.ts",
  "packages/kernel/src/api/artifact_routes.ts",
  "packages/kernel/src/api/internal_routes.ts",
  "packages/kernel/src/api/runtime_agent_routes.ts",
  "packages/kernel/src/api/readiness_routes.ts",
  "packages/kernel/src/api/openapi.ts",
  "packages/plugins/spec/kinds",
  "packages/plugins/src/kinds",
  "packages/plugins/src/shape-providers",
  "packages/plugins/src/shape-providers/_artifact_kinds_bundled.ts",
  "packages/contract/deno.json",
  "packages/runtime-agent/deno.json",
  "packages/plugins/deno.json",
  "packages/kernel/deno.json",
  "packages/cli/deno.json",
  "packages/all/deno.json",
];

const REQUIRED_SPEC_KEYS = [
  "appspec-v1",
  "build-service-input-v1",
  "reference-kind-examples-v1",
  "kernel-http-api-v1",
  "installer-api-v1",
  "runtime-agent-api-v1",
  "reference-providers-v1",
  "takosumi-jsr-packages",
];

Deno.test("public spec source map covers required public surfaces", async () => {
  const source = await read("docs/reference/public-spec-source-map.md");

  for (const specKey of REQUIRED_SPEC_KEYS) {
    assert.ok(source.includes(`\`${specKey}\``), `missing ${specKey}`);
  }

  assert.equal(source.includes("deploy-public-api-v1"), false);
  assert.equal(source.includes(`takosumi-${"git"}-workflow-ref-v1`), false);
  assert.equal(source.includes(`takosumi-${"git"}-artifact-uri-v1`), false);
  assert.ok(source.includes("packages/installer/src/yaml-parser.ts"));
  assert.match(source, /Source of truth/);
  assert.match(source, /Published reference/);
  assert.match(source, /Drift check/);
});

Deno.test("public spec source map covers installer OpenAPI routes", async () => {
  const source = await read("docs/reference/public-spec-source-map.md");
  const reference = await read("docs/reference/kernel-http-api.md");
  const openapi = createPaaSOpenApiDocument({
    installerPublicRoutesMounted: true,
  });

  assert.match(source, /`kernel-http-api-v1`/);
  assert.match(source, /`installer-api-v1`/);
  assert.ok(source.includes("packages/kernel/src/api/openapi.ts"));
  assert.ok(
    source.includes("packages/kernel/src/api/installer_public_routes.ts"),
  );
  assert.ok(source.includes("INSTALLER_INSTALLATIONS_PATH"));
  assert.ok(source.includes("dryRunInstallation"));
  assert.ok(
    source.includes(
      "packages/kernel/src/api/installer_public_routes_e2e_test.ts",
    ),
  );
  assert.ok(openapi.paths[INSTALLER_INSTALLATIONS_DRY_RUN_PATH]?.post);
  assert.ok(openapi.paths[INSTALLER_INSTALLATIONS_PATH]?.post);
  assert.ok(
    openapi.paths[INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH]?.post,
  );
  assert.ok(openapi.paths[INSTALLER_INSTALLATION_DEPLOYMENTS_PATH]?.post);
  assert.ok(openapi.paths[INSTALLER_INSTALLATION_ROLLBACK_PATH]?.post);
  assert.ok(reference.includes("POST   | `/v1/installations/dry-run`"));
  assert.ok(
    reference.includes("POST   | `/v1/installations/{id}/deployments`"),
  );
  assert.equal(openapi.paths["/api/public/v1/deployments"], undefined);
  assert.equal(openapi.paths["/v1/deployments"], undefined);
});

Deno.test("public spec source map Takosumi-owned paths exist", async () => {
  for (const path of TAKOSUMI_OWNED_PATHS) {
    const stat = await Deno.stat(new URL(path, root));
    assert.ok(stat.isFile || stat.isDirectory, `missing ${path}`);
  }
});

Deno.test("public spec source map is linked from reference navigation", async () => {
  const index = await read("docs/reference/index.md");
  const config = await read("docs/.vitepress/config.ts");

  assert.ok(index.includes("./public-spec-source-map"));
  assert.ok(config.includes("/reference/public-spec-source-map"));
});

Deno.test("kernel HTTP API does not reintroduce workflow trigger endpoint specs", async () => {
  const source = await read("docs/reference/kernel-http-api.md");
  const forbidden = [
    "## Workflow & Trigger",
    "### `POST /v1/triggers/manual`",
    "### `POST /v1/triggers/external`",
    "### `POST /api/internal/v1/triggers/external`",
    "### `POST /api/internal/v1/triggers/schedule`",
    "### `DELETE /api/internal/v1/triggers/:id`",
    "### `GET /api/internal/v1/hook-bindings`",
    "workflow extension primitive endpoints",
    "RBAC Policy — workflow extension primitive operation rows",
  ];

  for (const snippet of forbidden) {
    assert.equal(source.includes(snippet), false, `unexpected ${snippet}`);
  }

  assert.match(source, /workflow \/ trigger \/ schedule \/ declarable hook/);
  assert.match(source, /Installer API に渡します/);
});

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, root));
}
