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
  "website/src/components/EndCTA.tsx",
  "website/src/components/Showcase.tsx",
  "website/src/components/Footer.tsx",
  "website/src/content/why.ts",
  "website/src/content/ecosystem.ts",
  "tests/proofs/opentofu-output-proof.ts",
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
  "opentofu:output-" + "snapshot-proof",
  "opentofu-output-" + "snapshot-proof",
  "takosumi.opentofu-output-" + "snapshot-proof",
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
  "GET    /audit",
] as const;

const CLOUD_GA_SERVICE_FORMS = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "SQLDatabase",
  "Queue",
  "VectorIndex",
  "DurableWorkflow",
  "ContainerService",
  "StatefulActorNamespace",
  "Schedule",
] as const;

const CLOUD_GA_PUBLIC_SERVICES = [
  "Edge Worker",
  "Object Storage",
  "KV",
  "Database",
  "Queue",
  "Vector Index",
  "Durable Workflow",
  "Container",
  "Stateful Actor Namespace",
  "Schedule",
  "AI Gateway",
  "Verified custom domain",
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
  assert.match(docs, /Cloud extension boundary|Cloud extension の境界/);
  assert.match(docs, /sole lifecycle authority|唯一の lifecycle authority/);
  for (const concept of FINAL_PUBLIC_CONCEPTS) {
    assert.match(docs, new RegExp(`\\b${concept}\\b`), `missing ${concept}`);
  }
});

test("hosted Cloud docs keep current usage identity provider neutral", async () => {
  for (const path of ["app-docs/resources.md", "app-docs/en/resources.md"]) {
    const doc = await readText(new URL(path, ROOT));
    assert.match(doc, /`takosumi\.edge_worker`/);
    assert.match(doc, /`takosumi:edge_worker:\*`/);
    assert.doesNotMatch(doc, /takosumi\.entrypoint=/);
    assert.match(doc, /historical|過去/);
  }
});

test("Final Plan and hosted Cloud docs keep one all-or-nothing GA set Pre-GA before evidence activation", async () => {
  const finalPlan = await readText(
    new URL("docs/internal/final-plan.md", ROOT),
  );
  const publicOffering = section(finalPlan, "## 11.", "## 12.");
  const gaContract = section(finalPlan, "## 14.", "## 15.");
  const indexes = await Promise.all(
    ["app-docs/index.md", "app-docs/en/index.md"].map((path) =>
      readText(new URL(path, ROOT)),
    ),
  );
  const pricing = await readText(new URL("app-docs/en/pricing.md", ROOT));
  const resources = await readText(new URL("app-docs/en/resources.md", ROOT));
  const endpoints = await readText(new URL("app-docs/en/endpoints.md", ROOT));

  assert.match(publicOffering, /one\s+all-or-nothing set/);
  assert.match(publicOffering, /Pre-GA \(one all-or-nothing GA set\)/);
  assert.match(
    gaContract,
    /ten-form Service Form Stable set is all-or-nothing/,
  );
  assert.doesNotMatch(publicOffering, /\nStable:\s|\nPreview:\s/);
  for (const service of CLOUD_GA_SERVICE_FORMS) {
    assert.ok(
      publicOffering.includes(service),
      `section 11 omitted ${service}`,
    );
    assert.ok(gaContract.includes(service), `section 14 omitted ${service}`);
  }
  for (const service of ["AI Gateway", "VerifiedDomain"]) {
    assert.ok(
      publicOffering.includes(service),
      `section 11 omitted ${service}`,
    );
    assert.ok(gaContract.includes(service), `section 14 omitted ${service}`);
  }

  for (const index of indexes) {
    assert.match(index, /all-or-nothing GA (?:契約|contract)/);
    assert.match(index, /Pre-GA/);
    assert.doesNotMatch(
      index,
      /seven\s+Stable|7\s*つの Stable|eight offerings/,
    );
    assert.doesNotMatch(index, /\|\s*(?:Stable|Preview)\s*\|/);
    for (const service of CLOUD_GA_PUBLIC_SERVICES) {
      assert.ok(
        index.toLowerCase().includes(service.toLowerCase()),
        `hosted availability matrix omitted ${service}`,
      );
    }
  }

  assert.match(pricing, /unpriced meter, inactive catalog, missing manager/);
  assert.match(resources, /public Resource identity remains `EdgeWorker`/);
  assert.match(resources, /exact OSS OfferingSelection/);
  assert.match(resources, /closed CommercialOfferingBinding/);
  assert.match(endpoints, /ten Service Forms and two non-Form services/);
  assert.doesNotMatch(endpoints, /Preview service forms|seven service forms/);
});

test("public docs keep generic OSS Offering selection separate from the closed Cloud binding", async () => {
  const paths = [
    "README.md",
    "README.en.md",
    "docs/reference/model.md",
    "docs/en/reference/model.md",
    "docs/reference/api.md",
    "docs/en/reference/api.md",
    "docs/reference/glossary.md",
    "docs/en/reference/glossary.md",
  ] as const;
  const docs = await Promise.all(
    paths.map(async (path) => ({
      path,
      text: await readText(new URL(path, ROOT)),
    })),
  );

  for (const { path, text } of docs) {
    assert.match(
      text,
      /OfferingSelection/,
      `${path} omitted OfferingSelection`,
    );
    assert.match(
      text,
      /CommercialOfferingBinding/,
      `${path} omitted CommercialOfferingBinding`,
    );
    assert.doesNotMatch(
      text,
      /ServiceOffering/,
      `${path} restored ServiceOffering`,
    );
  }
  for (const path of ["docs/reference/api.md", "docs/en/reference/api.md"]) {
    const api = docs.find((doc) => doc.path === path)?.text ?? "";
    assert.match(api, /POST \/v1\/offering-catalogs/);
    assert.match(api, /POST \/v1\/offering-availability\/query/);
    assert.match(api, /POST \/v1\/offering-selections\/resolve/);
  }
});

test("self-hosted Takos keeps Takosumi control-plane services outside the product worker", async () => {
  const paths = [
    "AGENTS.md",
    "README.md",
    "README.en.md",
    "CHANGELOG.md",
    "DEPLOY.md",
    "deploy/README.md",
    "deploy/accounts-cloudflare/README.md",
  ] as const;
  const docs = (
    await Promise.all(paths.map((path) => readText(new URL(path, ROOT))))
  ).join("\n");

  for (const stale of [
    /platform worker or (?:a )?self-hosted Takos worker/i,
    /inside the takos product worker/i,
    /Takos product surface composes Takosumi accounts/i,
    /consumed by both targets/i,
  ]) {
    assert.doesNotMatch(docs, stale);
  }

  assert.match(
    docs,
    /does not\s+embed Accounts, deploy-control, the Dashboard, or the runner/,
  );
  assert.match(
    docs,
    /Accounts \/ deploy-control \/ dashboard \/ runner を Takos worker に\s*組み込みません/,
  );
});

test("Takosumi source module exposes the documented hosted billing proxies", async () => {
  const packageJson = JSON.parse(
    await readText(new URL("package.json", ROOT)),
  ) as { scripts?: Record<string, string> };
  assert.equal(
    packageJson.scripts?.["ga:billing-readiness"],
    "bun ../scripts/check-takosumi-billing-readiness.mjs",
  );
  assert.equal(
    packageJson.scripts?.["ga:billing-bootstrap"],
    "bun ../scripts/bootstrap-takosumi-stripe-billing.mjs",
  );
  const readme = await readText(new URL("README.md", ROOT));
  assert.match(readme, /bun run ga:status -- --json/);
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
    /specific compatibility\s+profile is enabled is reported through capabilities/,
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
    assert.doesNotMatch(doc, /^POST\s+\/secrets$/m);
    assert.match(
      doc,
      /独立した `POST \/secrets` API|standalone `POST \/secrets` API/,
    );
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

test("Service Form migration docs keep portable identity separate from the old Resource wire", async () => {
  const finalPlan = await readText(
    new URL("docs/internal/final-plan.md", ROOT),
  );
  const coreSpec = await readText(new URL("docs/internal/core-spec.md", ROOT));
  const conformance = await readText(
    new URL("docs/internal/core-conformance.md", ROOT),
  );
  const deployControl = await readText(
    new URL("docs/reference/deploy-control-api.md", ROOT),
  );

  for (const doc of [finalPlan, coreSpec]) {
    assert.match(doc, /forms\.takoform\.com\/v1alpha1/);
    assert.match(doc, /0\.0\.0-legacy\.1/);
    assert.match(doc, /packageDigest/);
    assert.match(doc, /ten-package legacy compatibility set/);
  }

  assert.match(finalPlan, /"packageDigest": "sha256:<exact-package-digest>"/);
  assert.match(
    finalPlan,
    /Form Package does not own\s+or rewrite this compatibility mapping/,
  );
  assert.match(
    coreSpec,
    /old Resource wire-to-FormRef mapping remains host-owned/,
  );
  assert.match(conformance, /claimed its `tako0614` Public Registry namespace/);
  assert.match(conformance, /registered GPG key `34FC18AC897FB709`/);
  assert.match(deployControl, /ten compatibility kinds/);
  assert.doesNotMatch(deployControl, /bundled.*6 shape/);
});

test("workspace packages stay private source modules", async () => {
  for (const path of [
    "package.json",
    "accounts/contract/package.json",
    "accounts/service/package.json",
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

function section(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return content.slice(startIndex, endIndex);
}
