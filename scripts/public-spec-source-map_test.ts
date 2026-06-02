import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "bun:test";
import {
  INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLER_INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLER_INSTALLATION_ROLLBACK_PATH,
  INSTALLER_INSTALLATIONS_DRY_RUN_PATH,
  INSTALLER_INSTALLATIONS_PATH,
} from "../src/service/api/installer_public_routes.ts";
import { createTakosumiOpenApiDocument } from "../src/service/api/openapi.ts";

const root = new URL("../", import.meta.url);

const TAKOSUMI_OWNED_PATHS = [
  "docs/reference/public-spec-source-map.md",
  "docs/reference/manifest.md",
  "docs/reference/build-spec.md",
  "docs/reference/takosumi-v1.md",
  "docs/reference/installer-api.md",
  "docs/reference/service-http-api.md",
  "docs/reference/spec-boundaries.md",
  "docs/reference/runtime-agent-api.md",
  "docs/reference/kind-bindings.md",
  "docs/reference/accounts.md",
  "docs/accounts/ja/spec.md",
  "docs/accounts/en/spec.md",
  "src/service/domains/deploy/_internal_manifest_types.ts",
  "src/service/domains/deploy/manifest_v1.ts",
  "src/service/api/app.ts",
  "src/service/api/installer_public_routes.ts",
  "src/service/api/artifact_routes.ts",
  "src/service/api/internal_routes.ts",
  "src/service/api/runtime_agent_routes.ts",
  "src/service/api/readiness_routes.ts",
  "src/service/api/openapi.ts",
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
  "installer-api-v1",
  "source-contract-v1",
  "platform-service-v1",
  "build-service-input",
  "reference-adapter-metadata-v1",
  "takosumi-spec-v1",
  "service-route-inventory",
  "runtime-agent-envelope",
  "reference-adapter-guide",
  "takosumi-npm-package",
];

test("public spec source map covers required public surfaces", async () => {
  const source = await read("docs/reference/public-spec-source-map.md");

  for (const specKey of REQUIRED_SPEC_KEYS) {
    assert.ok(source.includes(`\`${specKey}\``), `missing ${specKey}`);
  }

  assert.equal(source.includes("deploy-public-api-v1"), false);
  assert.equal(source.includes(`takosumi-${"git"}-workflow-ref-v1`), false);
  assert.equal(source.includes(`takosumi-${"git"}-artifact-uri-v1`), false);
  assert.equal(source.includes("src/contract/app-spec.ts"), false);
  assert.equal(source.includes("src/installer/yaml-parser.ts"), false);
  assert.ok(source.includes("src/contract/installer-api.ts"));
  assert.ok(source.includes("docs/kinds/v1/*.jsonld"));
  assert.ok(source.includes("docs/accounts/ja/spec.md"));
  assert.ok(source.includes("docs/accounts/en/spec.md"));
  assert.match(source, /Normative reference/);
  assert.match(source, /Executable conformance targets/);
  assert.match(source, /Repository source/);
  assert.match(source, /Published reference/);
  assert.match(source, /Drift Check/);
});

test("public spec source map covers installer route evidence", async () => {
  const source = await read("docs/reference/public-spec-source-map.md");
  const reference = await read("docs/reference/service-http-api.md");
  const openapi = createTakosumiOpenApiDocument({
    installerPublicRoutesMounted: true,
  });

  assert.match(source, /`service-route-inventory`/);
  assert.match(source, /`installer-api-v1`/);
  assert.ok(
    source.includes("src/service/api/installer_public_routes.ts"),
  );
  assert.ok(
    source.includes(
      "src/service/api/installer_public_routes_e2e_test.ts",
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

test("public spec source map Takosumi-owned paths exist", async () => {
  for (const path of TAKOSUMI_OWNED_PATHS) {
    const entry = await stat(new URL(path, root));
    assert.ok(entry.isFile() || entry.isDirectory(), `missing ${path}`);
  }
});

test("public spec source map is kept as maintainer-only reference", async () => {
  const serviceReference = await read("docs/reference/service-http-api.md");
  const config = await read("docs/.vitepress/config.ts");

  assert.ok(serviceReference.includes("./public-spec-source-map.md"));
  assert.ok(config.includes("public-spec-source-map"));
});

test("reference service descriptors stay out of public catalog roots", async () => {
  const docs = await read("docs/reference/public-spec-source-map.md");
  assert.ok(docs.includes("docs/kinds/v1/*.jsonld"));
  assert.ok(docs.includes("/contexts/v1.jsonld"));
  assert.match(docs, /Reference adapter metadata/);

  const descriptorRoot = new URL(
    "src/service/domains/deploy/descriptors/",
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
    const source = await readText(file);
    for (const snippet of forbidden) {
      assert.equal(
        source.includes(snippet),
        false,
        `${file.pathname} contains public-looking internal descriptor root ${snippet}`,
      );
    }
  }
});

test("service HTTP API does not reintroduce workflow trigger endpoint specs", async () => {
  const source = await read("docs/reference/service-http-api.md");
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
  return await readText(new URL(path, root));
}

async function* walkFiles(dir: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) {
      yield* walkFiles(child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

async function readText(path: URL | string): Promise<string> {
  return readFile(path, "utf8");
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}
