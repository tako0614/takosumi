import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "bun:test";

const ROOT = new URL("../../", import.meta.url);

const REQUIRED_PUBLIC_DOCS = [
  "docs/index.md",
  "docs/getting-started/quickstart.md",
  "docs/concepts/index.md",
  "docs/concepts/sources.md",
  "docs/concepts/run-model.md",
  "docs/concepts/state-and-outputs.md",
  "docs/concepts/credentials.md",
  "docs/concepts/resources.md",
  "docs/concepts/interfaces.md",
  "docs/concepts/usage-and-billing.md",
  "docs/concepts/self-host.md",
  "docs/concepts/boundaries.md",
  "docs/reference/api.md",
  "docs/reference/cli.md",
  "docs/reference/takoform-host.md",
  "docs/reference/configuration.md",
  "docs/reference/capsule-source-options.md",
  "docs/reference/operator-control-mcp.md",
  "docs/reference/app-handoff.md",
  "docs/reference/glossary.md",
  "docs/en/index.md",
  "docs/en/getting-started/quickstart.md",
  "docs/en/concepts/index.md",
  "docs/en/concepts/sources.md",
  "docs/en/concepts/run-model.md",
  "docs/en/concepts/state-and-outputs.md",
  "docs/en/concepts/credentials.md",
  "docs/en/concepts/resources.md",
  "docs/en/concepts/interfaces.md",
  "docs/en/concepts/usage-and-billing.md",
  "docs/en/concepts/self-host.md",
  "docs/en/concepts/boundaries.md",
  "docs/en/reference/api.md",
  "docs/en/reference/cli.md",
  "docs/en/reference/capsule-source-options.md",
  "docs/en/reference/operator-control-mcp.md",
  "docs/en/reference/app-handoff.md",
  "docs/en/reference/glossary.md",
] as const;

const REQUIRED_ARCHIVED_APP_DOCS = [
  "app-docs/index.md",
  "app-docs/resources.md",
  "app-docs/endpoints.md",
  "app-docs/pricing.md",
  "app-docs/en/index.md",
  "app-docs/en/resources.md",
  "app-docs/en/endpoints.md",
  "app-docs/en/pricing.md",
  "app-docs/support.md",
  "app-docs/sla.md",
  "app-docs/en/support.md",
  "app-docs/en/sla.md",
] as const;

const REQUIRED_INTERNAL_DOCS = [
  "docs/internal/README.md",
  "docs/internal/product-goal.md",
  "docs/internal/final-plan.md",
  "docs/internal/core-spec.md",
  "docs/internal/core-conformance.md",
  "docs/internal/architecture.md",
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
  docPath("reference", "model.md"),
  docPath("reference", "deploy-control-api.md"),
  docPath("reference", "operator-execution-boundaries.md"),
  docPath("reference", "operator.md"),
  docPath("en", "reference", "model.md"),
  docPath("en", "reference", "deploy-control-api.md"),
  docPath("en", "reference", "operator-execution-boundaries.md"),
  docPath("en", "reference", "operator.md"),
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

test("Takosumi public docs are rebuilt around the current public surface", async () => {
  for (const path of REQUIRED_PUBLIC_DOCS) {
    const entry = await stat(new URL(path, ROOT));
    assert.equal(entry.isFile(), true, `missing ${path}`);
  }
  for (const path of REQUIRED_ARCHIVED_APP_DOCS) {
    const entry = await stat(new URL(path, ROOT));
    assert.equal(entry.isFile(), true, `missing archived app doc ${path}`);
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
  assert.match(docs, /plain OpenTofu(?:\s*\/\s*Terraform)? (?:module|source)/);
  assert.match(docs, /compatibility_profiles|compatibilityProfiles/);
  assert.match(docs, /ordinary provider|通常の provider|通常の OpenTofu provider/);
  assert.match(docs, /provider[- ]neutral|provider configuration|provider selection/i);
  assert.match(docs, /second resource ledger|別の resource ledger|第二の Resource ledger/iu);
  assert.doesNotMatch(docs, /Compatibility API framework/);
  assert.doesNotMatch(docs, /Resource Shape API/);
  for (const concept of FINAL_PUBLIC_CONCEPTS) {
    assert.match(docs, new RegExp(`\\b${concept}\\b`), `missing ${concept}`);
  }
});

test("app docs are clearly archived and do not claim current Cloud authority", async () => {
  for (const path of REQUIRED_ARCHIVED_APP_DOCS) {
    const doc = await readText(new URL(path, ROOT));
    const notice = doc.slice(0, 1_200);
    assert.match(
      notice,
      /Historical archive|歴史資料（アーカイブ）/iu,
      `${path} must carry the archive marker near the title`,
    );
    assert.match(
      notice,
      /not current authority|現行の正本ではありません/iu,
      `${path} must say that it is not current authority`,
    );
    assert.match(
      notice,
      /(?:退役した[\s>]*|retired[\s>]+)Takosumi Cloud|Takosumi Cloud[\s\S]{0,300}(?:retired|退役|historical|歴史)/iu,
      `${path} must identify retired Takosumi Cloud`,
    );
    assert.match(
      notice,
      /(?:not current (?:availability|pricing|SLA|support|production)|(?:availability|pricing|SLA|support)[\s\S]{0,180}(?:not current authority|current authority ではありません|示しません)|現行サービスの根拠に使わない)/iu,
      `${path} must deny current Cloud availability/pricing/SLA/support authority`,
    );
    assert.match(
      notice,
      /Takosumi Hosted[\s\S]{0,320}(?:retail|commerce|client)/iu,
      `${path} must send current retail/client docs to Takosumi Hosted`,
    );
    assert.match(
      notice,
      /Takoserver[\s\S]{0,360}(?:managed supply|capacity|provider credential|Offerings?)|(?:managed supply|capacity|provider credential|Offerings?)[\s\S]{0,360}Takoserver/iu,
      `${path} must send managed supply authority to Takoserver`,
    );
  }
});

test("Form package operations require exact Host Support facts, not retired admission authority", async () => {
  const runbook = await readText(
    new URL("docs/operations/form-package-installation.md", ROOT),
  );
  assert.match(runbook, /superseded/);
  assert.match(runbook, /(?:does not|no longer) host(?:s)? a Form Registry/);
  assert.match(runbook, /Takoserver\s+or\s+another\s+external\s+Host/);
  assert.match(runbook, /exact `FormRef` and `packageDigest`/);
  assert.doesNotMatch(runbook, /exact `FormActivation` with principal audience/);
});

test("public docs mark Generic Offering and Resource/Form Host as migration gaps", async () => {
  const paths = [
    "README.md",
    "README.en.md",
    "docs/concepts/boundaries.md",
    "docs/en/concepts/boundaries.md",
    "docs/concepts/resources.md",
    "docs/en/concepts/resources.md",
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

  const combined = docs.map(({ text }) => text).join("\n");
  assert.match(
    combined,
    /Generic Offering[\s\S]{0,360}(?:not a supported|not .*Core|conformance gap|migration-only)/iu,
  );
  assert.match(
    combined,
    /Resource Shape[\s\S]{0,300}(?:migration internals|migration-only|not a supported)/iu,
  );
  assert.match(
    combined,
    /Takoserver[\s\S]{0,360}(?:managed(?:-service)? Offering|managed supply)/iu,
  );
  assert.match(
    combined,
    /Takosumi Hosted[\s\S]{0,260}(?:retail|commerce|client composition)/iu,
  );
  assert.doesNotMatch(
    combined,
    /Generic Offering(?: catalog)? is (?:a )?supported (?:Core )?(?:authority|surface)/iu,
  );
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

test("Takosumi standalone package does not proxy hosted GA automation", async () => {
  const packageJson = JSON.parse(
    await readText(new URL("package.json", ROOT)),
  ) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};
  assert.deepEqual(
    Object.keys(scripts).filter((name) => name.startsWith("ga:")),
    [],
  );
  const readme = await readText(new URL("README.md", ROOT));
  const englishReadme = await readText(new URL("README.en.md", ROOT));
  assert.doesNotMatch(readme, /bun run ga:/);
  assert.doesNotMatch(englishReadme, /bun run ga:/);
  assert.match(readme, /standalone OSS clone/);
  assert.match(englishReadme, /standalone OSS clone/);
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
  assert.match(internalReadme, /excluded from the published/);
  assert.match(internalReadme, /Product Goal/);
  assert.match(internalReadme, /current OSS contract/);

  const productGoal = await readText(
    new URL("docs/internal/product-goal.md", ROOT),
  );
  assert.match(productGoal, /active product destination and definition of done/);
  assert.match(productGoal, /not a\s+contract[\s\S]*roadmap\/backlog/);
  assert.match(productGoal, /(?:current )?public Takoform contract/);
  assert.match(productGoal, /source candidate[\s\S]*as a Registry release/);
  assert.match(productGoal, /staging before production/);
  assert.match(productGoal, /self-host[\s\S]*(?:Takosumi Hosted|Takoserver)/i);
  assert.match(productGoal, /Core Spec/);
  assert.match(productGoal, /Takosumi\s+Cloud[\s\S]{0,80}retired\s+historical identity/);
  assert.doesNotMatch(productGoal, /Final Plan.*current|authoritative.*roadmap/i);

  const context = await readText(new URL("CONTEXT.md", ROOT));
  assert.match(context, /BYOC[\s\S]{0,240}customer owns the vendor account and credential/i);
  assert.match(context, /Takoserver is not part of a BYOC path/i);
  assert.match(context, /Takoserver Host[\s\S]{0,360}(?:managed-service Offering|Workers for Platforms)/i);

  const architecture = await readText(
    new URL("docs/internal/architecture.md", ROOT),
  );
  assert.match(architecture, /customer BYOC control plane/i);
  assert.match(
    architecture,
    /Generic Offering authority[\s\S]{0,500}(?:deletion\/migration custody|conformance gap)/iu,
  );
  assert.match(
    architecture,
    /Resource\/Form lifecycle[\s\S]{0,500}(?:migration|Freeze new desired state)/iu,
  );
  assert.match(architecture, /managed customer `ModuleWorker`[\s\S]{0,260}Takoserver/i);

  const historicalFormEvidence = await readText(
    new URL("docs/internal/form-lifecycle-and-host-evidence.md", ROOT),
  );
  assert.match(historicalFormEvidence, /superseded historical evidence note/);
  assert.match(historicalFormEvidence, /does not define a current OSS Form Host/);
  assert.doesNotMatch(historicalFormEvidence, /Takosumi owns one host lifecycle/);

  const finalPlan = await readText(
    new URL("docs/internal/final-plan.md", ROOT),
  );
  assert.match(finalPlan, /historical planning record|superseded/);
  assert.match(finalPlan, /present contract is \[Core Spec\]|current Takosumi OSS contract/);
  assert.match(finalPlan, /TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1/);
  assert.match(finalPlan, /Generic Offering[\s\S]{0,260}(?:conformance gap|migration-only)/i);
  assert.match(finalPlan, /Takosumi Hosted[\s\S]{0,120}retail/i);
  assert.match(finalPlan, /Takosumi\s+Cloud[\s\S]{0,80}retired\s+historical identity/i);
  assert.doesNotMatch(finalPlan, /authoritative Takosumi product direction/);
  assert.doesNotMatch(finalPlan, /## 11\.|## 14\./);
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

test("core spec names the final OSS model and excludes operator-provided capacity", async () => {
  const coreSpec = await readText(new URL("docs/internal/core-spec.md", ROOT));

  for (const concept of FINAL_PUBLIC_CONCEPTS) {
    assert.match(
      coreSpec,
      new RegExp(`\\b${concept}\\b`),
      `missing ${concept}`,
    );
  }
  assert.match(coreSpec, /ProviderConnection/);
  assert.match(coreSpec, /CredentialRecipe/);
  assert.match(coreSpec, /ProviderBinding/);
  assert.match(coreSpec, /StateVersion storage and locking/);
  assert.match(coreSpec, /Protocol-specific data paths may be composed/);
  assert.match(coreSpec, /not a second deployment lifecycle/);
  assert.doesNotMatch(coreSpec, /Compatibility API framework is core/);
  assert.match(coreSpec, /invoice \/ payment integration/);
  assert.match(coreSpec, /rated billing and payment enforcement/);
  assert.match(coreSpec, /operator-provided deployment target capacity/);
  assert.match(coreSpec, /Takoserver native managed-resource identities or internals/);
  assert.match(coreSpec, /official SLA \/ support \/ abuse tooling/);
  assert.match(coreSpec, /one supported\s+Git\/OpenTofu\/Terraform deployment\s+flow/);
  assert.match(coreSpec, /any runner-installable OpenTofu\/Terraform\s+provider/);
  assert.match(coreSpec, /Takoform is an ordinary external provider/);
  assert.match(coreSpec, /does not host a Form Registry/);
  assert.match(coreSpec, /Takoserver[\s\S]{0,180}external\s+Host/);
  assert.match(coreSpec, /TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1/);
  assert.match(coreSpec, /recognized but retired operations return\s+`410`/);
  assert.doesNotMatch(coreSpec, /Final Plan.*current direction|Final Plan.*authoritative/);
});

test("Service Form migration docs keep portable identity separate from the old Resource wire", async () => {
  const coreSpec = await readText(new URL("docs/internal/core-spec.md", ROOT));
  const conformance = await readText(
    new URL("docs/internal/core-conformance.md", ROOT),
  );

  for (const doc of [coreSpec]) {
    assert.match(doc, /forms\.takoform\.com\/v1alpha1/);
    assert.match(doc, /0\.0\.0-legacy\.1/);
    assert.match(doc, /packageDigest/);
    assert.match(doc, /historical package evidence alone/i);
  }

  assert.match(coreSpec, /"packageDigest": "sha256:<exact-package-digest>"/);
  assert.match(
    coreSpec,
    /old Resource wire-to-FormRef mapping remains\s+migration data/,
  );
  assert.match(
    await readText(new URL("docs/operations/exact-formref-migration.md", ROOT)),
    /old Resource wire-to-FormRef mapping remains\s+migration data/,
  );
  assert.match(conformance, /Takoform owns portable Form(?: definitions|\/provider semantics| semantics)/);
  assert.match(
    conformance,
    /Takosumi has no parent Host credential,[\s\S]{0,220}(?:provider installation|backend|capacity|WfP namespace|native identity)/iu,
  );
});

test("current docs keep the legacy drain bounded and externalize Form hosting", async () => {
  const paths = [
    "docs/internal/core-spec.md",
    "docs/reference/configuration.md",
    "docs/operations/form-host-support.md",
    "docs/operations/form-package-installation.md",
    "docs/operations/exact-formref-migration.md",
    "docs/operations/platform-worker-deploy.md",
  ] as const;
  const docs = await Promise.all(
    paths.map(async (path) => ({ path, text: await readText(new URL(path, ROOT)) })),
  );
  const combined = docs.map(({ text }) => text).join("\n");

  assert.match(combined, /TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1/);
  assert.match(combined, /Resource.*list\/read.*events.*observe.*delete/s);
  assert.match(combined, /TargetPool\/SpacePolicy.*GET.*HEAD.*DELETE/s);
  assert.match(combined, /default(?:s)?[^\n]*`404`|`404`[^\n]*default/s);
  assert.match(combined, /discovery[^\n]*(?:unavailable|remain unavailable)/i);
  assert.match(combined, /writes[^\n]*(?:unavailable|remain unavailable|disabled)/i);
  assert.match(combined, /Takoserver[\s\S]{0,240}external\s+Host|external\s+Host[\s\S]{0,240}ordinary provider/i);
  assert.match(combined, /ordinary provider/i);

  const config = docs.find(({ path }) => path === "docs/reference/configuration.md")?.text ?? "";
  assert.doesNotMatch(config, /TAKOSUMI_RESOURCE_SHAPES.*\/v1\/resources.*(?:出す|enable|publish)/is);
  const runbook = docs.find(({ path }) => path === "docs/operations/form-package-installation.md")?.text ?? "";
  assert.doesNotMatch(runbook, /POST\s+\/internal\/v1\/form-packages\/install/);
  assert.doesNotMatch(runbook, /production.*FormActivation.*reviewed/i);
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

test("archived Cloud SLA and support retain provenance without current authority", async () => {
  const jaSla = await readText(new URL("app-docs/sla.md", ROOT));
  const enSla = await readText(new URL("app-docs/en/sla.md", ROOT));
  const jaSupport = await readText(new URL("app-docs/support.md", ROOT));
  const enSupport = await readText(new URL("app-docs/en/support.md", ROOT));
  const config = await readText(new URL("app-docs/.vitepress/config.ts", ROOT));

  for (const sla of [jaSla, enSla]) {
    assert.match(sla, /(?:歴史資料|Historical archive)/);
    assert.match(sla, /(?:現行の正本ではありません|not current authority)/);
    assert.match(sla, /99\.9%/);
    assert.match(sla, /99\.5%/);
    assert.match(sla, /status\.takosumi\.com/);
    assert.match(sla, /48/);
    assert.doesNotMatch(sla, /\b(?:Lite|Plus|Pro)\b/);
  }
  assert.match(jaSla, /金銭返金.*提供しません/s);
  assert.match(enSla, /does not create a monetary refund/);
  for (const support of [jaSupport, enSupport]) {
    assert.match(support, /support@takosumi\.com/);
    assert.match(support, /status\.takosumi\.com/);
  }
  assert.match(jaSupport, /API key.*送らない/s);
  assert.match(enSupport, /Do not send API keys/);
  for (const route of ["/support", "/sla", "/en/support", "/en/sla"]) {
    assert.match(config, new RegExp(`link: "${route}"`));
  }
  assert.match(config, /documentation archive/);
  assert.match(config, /not current (?:service )?authority/);
});

test("OSS readiness uses quota-policy vocabulary without owning retail pricing", async () => {
  const readiness = await readText(
    new URL("cli/src/cli-platform-readiness-constants.ts", ROOT),
  );
  assert.match(readiness, /"quota-policy"/);
  assert.match(readiness, /quotaPolicyRef/);
  assert.doesNotMatch(readiness, /"quota-plan"/);
  assert.doesNotMatch(readiness, /\bplanId\b/);
  assert.doesNotMatch(readiness, /\bquotaPlanRef\b/);

  const readinessFixtures = await readText(
    new URL("tests/cli/src/main_test.ts", ROOT),
  );
  assert.doesNotMatch(readinessFixtures, /platform-capsule-lite/);
  assert.doesNotMatch(readinessFixtures, /policy:\/\/[^"\s]*lite/);

  const boundaries = await readText(
    new URL("docs/en/concepts/boundaries.md", ROOT),
  );
  assert.match(boundaries, /Takosumi Hosted[\s\S]{0,200}retail/);
  assert.match(boundaries, /Takoserver[\s\S]{0,240}managed supply/);
  assert.match(boundaries, /Takosumi Cloud[\s\S]{0,200}retired historical identity/);
});

test("repository manifest uses the general closed envelope and keeps install options separate", async () => {
  const contract = await readText(
    new URL("contract/repository-manifest.ts", ROOT),
  );
  assert.match(contract, /"takosumi\.com\/v1"/);
  assert.match(contract, /"Repository"/);
  assert.match(contract, /readonly install: RepositoryManifestInstall/);
  assert.doesNotMatch(contract, /TAKOSUMI_INSTALL_UX_SCHEMA_VERSION/);
  assert.equal(
    await Bun.file(new URL("contract/install-ux.ts", ROOT)).exists(),
    false,
  );
  const sourceContract = await readText(new URL("contract/sources.ts", ROOT));
  assert.match(
    sourceContract,
    /readonly repositoryManifest\?: RepositoryManifestSnapshot/,
  );
  assert.doesNotMatch(sourceContract, /RepositoryInstallUxSnapshot/);
  const sourceSync = await readText(new URL("runner/lib/source_sync.ts", ROOT));
  assert.match(sourceSync, /source_repository_manifest/);
  assert.doesNotMatch(sourceSync, /source_repository_install_ux/);
  const openapi = await readText(new URL("core/api/openapi.ts", ROOT));
  const sourceSnapshotSchema = openapi.slice(
    openapi.indexOf("    SourceSnapshot: {"),
    openapi.indexOf("    SourceSyncRun: {"),
  );
  assert.match(sourceSnapshotSchema, /repositoryManifest:/);
  assert.doesNotMatch(sourceSnapshotSchema, /repositoryInstallUx:/);

  for (const path of [
    "docs/reference/repository-manifest.md",
    "docs/en/reference/repository-manifest.md",
  ]) {
    const doc = await readText(new URL(path, ROOT));
    assert.match(doc, /takosumi\.com\/v1alpha1/);
    assert.match(doc, /CapsuleSourceOptions/);
    assert.match(doc, /InstallConfig/);
    assert.match(doc, /\$schema/);
  }
});

async function readPublicDocs(): Promise<string> {
  const chunks: string[] = [];
  // `app-docs/` is a separate historical archive and is checked for an
  // explicit notice above; it must not be folded into the current OSS surface.
  for (const root of [new URL("docs/", ROOT)]) {
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
