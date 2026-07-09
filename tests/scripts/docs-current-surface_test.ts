import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "bun:test";

const ROOT = new URL("../../", import.meta.url);

const REQUIRED_PUBLIC_DOCS = [
  "docs/index.md",
  "docs/getting-started/quickstart.md",
  "docs/reference/api.md",
  "docs/reference/model.md",
  "docs/reference/deploy-control-api.md",
  "docs/reference/operator-execution-boundaries.md",
  "docs/reference/operator.md",
  "docs/reference/cli.md",
  "docs/en/index.md",
  "docs/en/getting-started/quickstart.md",
  "docs/en/reference/api.md",
  "docs/en/reference/model.md",
  "docs/en/reference/deploy-control-api.md",
  "docs/en/reference/operator-execution-boundaries.md",
  "docs/en/reference/operator.md",
  "docs/en/reference/cli.md",
  "app-docs/index.md",
  "app-docs/resources.md",
  "app-docs/endpoints.md",
  "app-docs/pricing.md",
  "app-docs/en/index.md",
  "app-docs/en/resources.md",
  "app-docs/en/endpoints.md",
  "app-docs/en/pricing.md",
] as const;

const REQUIRED_INTERNAL_DOCS = [
  "docs/internal/README.md",
  "docs/internal/final-plan.md",
  "docs/internal/core-spec.md",
  "docs/internal/core-conformance.md",
] as const;

const RETIRED_DOC_PATHS = [
  docPath("accounts"),
  docPath("ki" + "nds"),
  docPath("operator"),
  docPath("reference", "cata" + "log.md"),
  docPath("reference", "ki" + "nd-bindings.md"),
  docPath("reference", "ki" + "nd-packages.md"),
  docPath("reference", "build-spec.md"),
  docPath("reference", "platform-services.md"),
  docPath("reference", "takosumi-v1.md"),
  docPath("reference", "spec-boundaries.md"),
  docPath("reference", "public-spec-source-" + "map.md"),
] as const;

const RETIRED_DOC_TERMS: readonly (string | RegExp)[] = [
  "App" + "Spec",
  // The retired `.takosumi/` in-repo metadata convention (trailing slash keeps
  // legitimate hostnames like app.takosumi.com out of this check).
  "." + "takosumi/",
  "takosumi-" + "plugins",
  "official " + "catalog",
  "kind " + "descriptor",
  "backend " + "plugin",
  "Deno" + "-first",
  "dn" + "t",
];

const SOURCE_DOCS_WITH_PUBLIC_SURFACE_WORDING = [
  "README.md",
  "CONVENTIONS.md",
  "contract/README.md",
  "core/README.md",
  "core/runtime-agent/README.md",
  "website/src/components/EndCTA.tsx",
  "website/src/components/Showcase.tsx",
  "website/src/components/Footer.tsx",
  "website/src/content/why.ts",
  "website/src/content/ecosystem.ts",
  "tests/proofs/opentofu-output-snapshot.ts",
  "package.json",
] as const;

const RETIRED_SOURCE_DOC_TERMS: readonly (string | RegExp)[] = [
  "npm install @takosjp/takosumi",
  "@takosjp/takosumi/contract",
  "@takosjp/takosumi/deploy-control",
  "@takosjp/takosumi/cli",
  "@takosjp/takosumi/server",
  "https://www.npmjs.com/package/@takosjp/takosumi",
  "takosumi install",
  "opentofu:deployment-output-proof",
  "opentofu-deployment-output-proof",
  "takosumi.opentofu-deployment-output-proof",
  "/v1/installations/{installationId}/deployment-outputs",
  "public package surface",
  "deploy-control plane has no public routes",
  /\bCapsule path\b/,
];

const FINAL_PUBLIC_CONCEPTS = [
  "Workspace",
  "Project",
  "Capsule",
  "ProviderConnection",
  "CredentialRecipe",
  "ProviderBinding",
  "Run",
  "StateVersion",
  "Output",
  "AuditEvent",
] as const;

const MINIMAL_API_ROUTES = [
  "POST   /projects",
  "GET    /projects/:id",
  "POST   /capsules",
  "GET    /capsules/:id",
  "POST   /connections",
  "GET    /connections",
  "POST   /runs",
  "GET    /runs/:id",
  "GET    /runs/:id/logs",
  "POST   /runs/:id/approve",
  "POST   /secrets",
  "GET    /audit",
] as const;

test("Takosumi public docs are rebuilt around the current public surface", async () => {
  for (const path of REQUIRED_PUBLIC_DOCS) {
    const entry = await stat(new URL(path, ROOT));
    assert.equal(entry.isFile(), true, `missing ${path}`);
  }

  for (const path of RETIRED_DOC_PATHS) {
    await assert.rejects(
      () => stat(new URL(path, ROOT)),
      `retired docs path must not exist: ${path}`,
    );
  }

  const docs = await readPublicDocs();
  for (const term of RETIRED_DOC_TERMS) {
    const hit =
      typeof term === "string" ? docs.includes(term) : term.test(docs);
    assert.equal(hit, false, `retired docs term: ${term}`);
  }

  assert.match(
    docs,
    /OpenTofu control plane|OpenTofu\/Terraform control plane/,
  );
  assert.match(docs, /plain OpenTofu stacks as-is/);
  assert.match(docs, /Same manifest, different connection/);
  assert.match(docs, /Compatibility API framework/);
  assert.match(docs, /versioned subset|versioned capabilities/);
  assert.match(docs, /official\s+managed (?:capacity|target)/i);
  assert.match(docs, /same hosted Cloud origin|同じ hosted Cloud origin/);
  assert.match(
    docs,
    /shared Cloud extension (?:layer|boundary)|Cloud extension 共通層/,
  );
  for (const concept of FINAL_PUBLIC_CONCEPTS) {
    assert.match(docs, new RegExp(`\\b${concept}\\b`), `missing ${concept}`);
  }
});

test("Takosumi internal authority docs stay outside the public docs surface", async () => {
  for (const path of REQUIRED_INTERNAL_DOCS) {
    const entry = await stat(new URL(path, ROOT));
    assert.equal(entry.isFile(), true, `missing ${path}`);
  }

  const vitepressConfig = await readText(
    new URL("docs/.vitepress/config.ts", ROOT),
  );
  assert.match(vitepressConfig, /srcExclude/);
  assert.match(vitepressConfig, /"internal\/\*\*\/\*\.md"/);
  assert.match(vitepressConfig, /"operations\/\*\*\/\*\.md"/);

  const internalReadme = await readText(
    new URL("docs/internal/README.md", ROOT),
  );
  assert.match(internalReadme, /intentionally excluded/);
  assert.match(internalReadme, /development authority documents/);

  const finalPlan = await readText(
    new URL("docs/internal/final-plan.md", ROOT),
  );
  assert.match(finalPlan, /authoritative Takosumi product direction/);
  assert.match(
    finalPlan,
    /Compatibility APIs are framework capabilities in standard Takosumi/,
  );
  assert.match(
    finalPlan,
    /specific compatibility profile is enabled is reported through capabilities/,
  );
});

test("source docs keep current source-module and modulePath vocabulary", async () => {
  const docs = (
    await Promise.all(
      SOURCE_DOCS_WITH_PUBLIC_SURFACE_WORDING.map((path) =>
        readText(new URL(path, ROOT)),
      ),
    )
  ).join("\n");

  for (const term of RETIRED_SOURCE_DOC_TERMS) {
    const hit =
      typeof term === "string" ? docs.includes(term) : term.test(docs);
    assert.equal(hit, false, `retired source-doc term: ${term}`);
  }

  assert.match(docs, /takosumi-contract/);
  assert.match(docs, /module path/);
});

test("deploy-control API docs enumerate the public session route inventory and connection guards", async () => {
  const docs = [
    await readText(new URL("docs/reference/deploy-control-api.md", ROOT)),
    await readText(new URL("docs/en/reference/deploy-control-api.md", ROOT)),
  ];

  for (const doc of docs) {
    for (const route of MINIMAL_API_ROUTES) {
      assert.ok(doc.includes(route), `missing API route ${route}`);
    }
    assert.match(doc, /resolved_provider_connection/);
    assert.match(doc, /blocked_missing_connection/);
    assert.match(doc, /blocked_policy/);
    assert.doesNotMatch(doc, /gateway-coverages/);
  }
});

test("core spec names the final OSS model and excludes official managed capacity", async () => {
  const coreSpec = await readText(new URL("docs/internal/core-spec.md", ROOT));

  for (const concept of FINAL_PUBLIC_CONCEPTS) {
    assert.match(
      coreSpec,
      new RegExp(`\\b${concept}\\b`),
      `missing ${concept}`,
    );
  }
  assert.match(coreSpec, /Provider Connection/);
  assert.match(coreSpec, /CredentialRecipe/);
  assert.match(coreSpec, /ProviderBinding/);
  assert.match(coreSpec, /StateVersion storage and locking/);
  assert.match(coreSpec, /Compatibility API framework is core/);
  assert.match(coreSpec, /invoice \/ payment integration/);
  assert.match(coreSpec, /rated billing and payment enforcement/);
  assert.match(coreSpec, /official managed target capacity/);
  assert.match(coreSpec, /official Takosumi native resource internals/);
  assert.match(coreSpec, /official SLA \/ support \/ abuse tooling/);
});

test("workspace packages stay private source modules", async () => {
  for (const path of [
    "package.json",
    "accounts/contract/package.json",
    "accounts/service/package.json",
    "accounts/platform-services/package.json",
    "cli/package.json",
    "deploy/node-postgres/package.json",
  ]) {
    const manifest = JSON.parse(await readText(new URL(path, ROOT))) as {
      readonly private?: boolean;
    };
    assert.equal(manifest.private, true, `${path} must be private`);
  }
});

async function readPublicDocs(): Promise<string> {
  const chunks: string[] = [];
  for (const root of [new URL("docs/", ROOT), new URL("app-docs/", ROOT)]) {
    for await (const file of walk(root)) {
      if (!file.pathname.endsWith(".md")) continue;
      if (file.pathname.includes("/docs/internal/")) continue;
      if (file.pathname.includes("/docs/operations/")) continue;
      chunks.push(await readText(file));
    }
  }
  return chunks.join("\n");
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.name === "node_modules" || entry.name === ".vitepress") continue;
    if (entry.isDirectory()) {
      yield* walk(child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

async function readText(path: URL): Promise<string> {
  return await readFile(path, "utf8");
}

function docPath(...segments: readonly string[]): string {
  return ["docs", ...segments].join("/");
}
