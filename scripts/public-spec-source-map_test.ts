import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

const TAKOSUMI_OWNED_PATHS = [
  "docs/reference/public-spec-source-map.md",
  "docs/reference/kernel-http-api.md",
  "docs/reference/runtime-agent-api.md",
  "docs/manifest.md",
  "docs/reference/manifest-validation.md",
  "docs/reference/shapes.md",
  "docs/reference/providers.md",
  "docs/reference/templates.md",
  "docs/reference/artifact-kinds.md",
  "packages/contract/src/manifest-resource.ts",
  "packages/kernel/src/domains/deploy/manifest_v1.ts",
  "packages/kernel/src/api/app.ts",
  "packages/kernel/src/api/public_routes.ts",
  "packages/kernel/src/api/deploy_public_routes.ts",
  "packages/kernel/src/api/artifact_routes.ts",
  "packages/kernel/src/api/internal_routes.ts",
  "packages/kernel/src/api/runtime_agent_routes.ts",
  "packages/kernel/src/api/readiness_routes.ts",
  "packages/kernel/src/api/openapi.ts",
  "packages/plugins/src/shapes",
  "packages/plugins/src/shape-providers",
  "packages/plugins/src/templates",
  "packages/plugins/src/shape-providers/_artifact_kinds_bundled.ts",
  "packages/contract/deno.json",
  "packages/runtime-agent/deno.json",
  "packages/plugins/deno.json",
  "packages/kernel/deno.json",
  "packages/cli/deno.json",
  "packages/all/deno.json",
];

const REQUIRED_SPEC_KEYS = [
  "manifest-v1",
  "shape-catalog-v1",
  "kernel-http-api-v1",
  "takosumi-jsr-packages",
  "takosumi-git-workflow-ref-v0",
  "takosumi-git-artifact-uri-v0",
];

Deno.test("public spec source map covers required public surfaces", async () => {
  const source = await read("docs/reference/public-spec-source-map.md");

  for (const specKey of REQUIRED_SPEC_KEYS) {
    assert.ok(source.includes(`\`${specKey}\``), `missing ${specKey}`);
  }

  assert.equal(
    source.includes("future `takosumi-git/docs/artifact-contract.md`"),
    false,
  );
  assert.ok(source.includes("sibling repo `docs/artifact-contract_test.ts`"));
  assert.ok(
    source.includes("sibling repo `takosumi-git/docs/workflow-ref.md`"),
  );
  assert.match(source, /Source of truth/);
  assert.match(source, /Published reference/);
  assert.match(source, /Drift check/);
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

  assert.match(
    source,
    /The current kernel exposes no workflow, trigger, schedule, or declarable hook\s+HTTP route\./,
  );
});

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, root));
}
