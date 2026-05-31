import assert from "node:assert/strict";
import {
  INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLER_INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLER_INSTALLATION_ROLLBACK_PATH,
  INSTALLER_INSTALLATIONS_DRY_RUN_PATH,
  INSTALLER_INSTALLATIONS_PATH,
} from "../src/kernel/api/installer_public_routes.ts";
import { createPaaSOpenApiDocument } from "../src/kernel/api/openapi.ts";

const root = new URL("../", import.meta.url);

const TAKOSUMI_OWNED_PATHS = [
  "docs/reference/public-spec-source-map.md",
  "docs/reference/manifest.md",
  "docs/reference/build-spec.md",
  "docs/reference/core-spec.md",
  "docs/reference/installer-api.md",
  "docs/reference/kernel-http-api.md",
  "docs/reference/spec-boundaries.md",
  "docs/reference/runtime-agent-api.md",
  "docs/reference/kind-bindings.md",
  "docs/reference/takosumi-cloud.md",
  "docs/reference/catalog.md",
  "../takosumi-cloud/docs/ja/spec.md",
  "../takosumi-cloud/docs/en/spec.md",
  "src/contract/catalog.ts",
  "src/kernel/domains/deploy/_internal_manifest_types.ts",
  "src/kernel/domains/deploy/manifest_v1.ts",
  "src/kernel/api/app.ts",
  "src/kernel/api/installer_public_routes.ts",
  "src/kernel/api/artifact_routes.ts",
  "src/kernel/api/internal_routes.ts",
  "src/kernel/api/runtime_agent_routes.ts",
  "src/kernel/api/readiness_routes.ts",
  "src/kernel/api/openapi.ts",
  "docs/kinds/v1/worker.jsonld",
  "docs/kinds/v1/web-service.jsonld",
  "docs/kinds/v1/postgres.jsonld",
  "docs/kinds/v1/sqlite.jsonld",
  "docs/kinds/v1/object-store.jsonld",
  "docs/kinds/v1/kv-store.jsonld",
  "docs/kinds/v1/message-queue.jsonld",
  "docs/kinds/v1/vector-store.jsonld",
  "docs/kinds/v1/gateway.jsonld",
  "docs/kinds/v1/cloudflare-worker.jsonld",
  "package.json",
  "tsconfig.json",
];

const REQUIRED_SPEC_KEYS = [
  "appspec-v1",
  "contract-catalog-v1",
  "installer-api-v1",
  "build-service-input",
  "takosumi-official-catalog-v1",
  "takosumi-cloud-spec-v1",
  "kernel-route-inventory",
  "runtime-agent-envelope",
  "reference-kind-binding-guide",
  "takosumi-npm-package",
];

Deno.test("public spec source map covers required public surfaces", async () => {
  const source = await read("docs/reference/public-spec-source-map.md");

  for (const specKey of REQUIRED_SPEC_KEYS) {
    assert.ok(source.includes(`\`${specKey}\``), `missing ${specKey}`);
  }

  assert.equal(source.includes("deploy-public-api-v1"), false);
  assert.equal(source.includes(`takosumi-${"git"}-workflow-ref-v1`), false);
  assert.equal(source.includes(`takosumi-${"git"}-artifact-uri-v1`), false);
  assert.ok(source.includes("src/contract/app-spec.ts"));
  assert.ok(source.includes("src/contract/catalog.ts"));
  assert.ok(source.includes("docs/kinds/v1/*.jsonld"));
  assert.ok(source.includes("../takosumi-cloud/docs/ja/spec.md"));
  assert.ok(source.includes("../takosumi-cloud/docs/en/spec.md"));
  assert.match(source, /Normative spec/);
  assert.match(source, /Executable conformance targets/);
  assert.match(source, /Repository source/);
  assert.match(source, /Published reference/);
  assert.match(source, /Drift check/);
});

Deno.test("public spec source map covers installer route evidence", async () => {
  const source = await read("docs/reference/public-spec-source-map.md");
  const reference = await read("docs/reference/kernel-http-api.md");
  const openapi = createPaaSOpenApiDocument({
    installerPublicRoutesMounted: true,
  });

  assert.match(source, /`kernel-route-inventory`/);
  assert.match(source, /`installer-api-v1`/);
  assert.ok(
    source.includes("src/kernel/api/installer_public_routes.ts"),
  );
  assert.ok(
    source.includes(
      "src/kernel/api/installer_public_routes_e2e_test.ts",
    ),
  );
  assert.ok(openapi.paths[INSTALLER_INSTALLATIONS_DRY_RUN_PATH]?.post);
  assert.ok(openapi.paths[INSTALLER_INSTALLATIONS_PATH]?.post);
  assert.ok(
    openapi.paths[
      toOpenApiPath(
        INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
      )
    ]?.post,
  );
  assert.ok(
    openapi.paths[toOpenApiPath(INSTALLER_INSTALLATION_DEPLOYMENTS_PATH)]?.post,
  );
  assert.ok(
    openapi.paths[toOpenApiPath(INSTALLER_INSTALLATION_ROLLBACK_PATH)]?.post,
  );
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

Deno.test("public spec source map is kept as maintainer-only reference", async () => {
  const kernelReference = await read("docs/reference/kernel-http-api.md");
  const config = await read("docs/.vitepress/config.ts");

  assert.ok(kernelReference.includes("./public-spec-source-map.md"));
  assert.ok(config.includes("public-spec-source-map"));
});

Deno.test("reference-kernel descriptors stay out of public catalog roots", async () => {
  const docs = await read("docs/reference/public-spec-source-map.md");
  assert.ok(docs.includes("/kinds/v1/*"));
  assert.ok(docs.includes("/contexts/v1.jsonld"));
  assert.match(docs, /reference\s+internal metadata/);

  const descriptorRoot = new URL(
    "src/kernel/domains/deploy/descriptors/",
    root,
  );
  const forbidden = [
    "https://takosumi.com/providers/",
    "https://takosumi.com/contracts/",
    "https://takosumi.com/descriptors/",
    "https://takosumi.com/contexts/deploy.jsonld",
    "https://takosumi.com/vocab/deploy#",
  ];

  for await (const file of walkFiles(descriptorRoot)) {
    const source = await Deno.readTextFile(file);
    for (const snippet of forbidden) {
      assert.equal(
        source.includes(snippet),
        false,
        `${file.pathname} contains public-looking internal descriptor root ${snippet}`,
      );
    }
  }
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

async function* walkFiles(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) {
      yield* walkFiles(child);
    } else if (entry.isFile) {
      yield child;
    }
  }
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}
