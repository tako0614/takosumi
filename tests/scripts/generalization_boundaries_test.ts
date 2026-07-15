import { describe, expect, test } from "bun:test";
import { findGeneralizationBoundaryViolations } from "../../scripts/lib/generalization-boundaries";

describe("generalization boundary scanner", () => {
  test("rejects aliases to removed contract modules", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "tsconfig.json",
        content:
          '"takosumi-contract/deployments": ["./contract/deployments.ts"]',
      },
      {
        path: "core/example.ts",
        content:
          'import type { Capsule } from "../../contract/installations.ts";',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "retired-contract-subpath",
      "retired-contract-subpath",
    ]);
  });

  test("rejects active aliases, output magic, and commercial billing coupling", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "contract/install-configs.ts",
        content: "const sourceKind = input.sourceKind;",
      },
      {
        path: "core/domains/deploy-control/projection.ts",
        content: 'if (kind.endsWith("_url")) return true;',
      },
      {
        path: "lib/rootgen/src/mod.ts",
        content:
          "const injectedVariables = SERVICE_CONNECTION_VARIABLES.filter(Boolean);",
      },
      {
        path: "core/adapters/storage/drizzle/schema/postgres.ts",
        content: 'providerTransactionId: text("stripePaymentIntentId")',
      },
      {
        path: "core/bootstrap.ts",
        content:
          "if (strict && !input.allowUnsafeProductionDefaults) throw fail;",
      },
      {
        path: "worker/src/bindings.ts",
        content:
          "interface WorkersForPlatformsDispatchNamespace { get(name: string): unknown }",
      },
      {
        path: "runner/lib/backup.ts",
        content:
          "const env = { TAKOSUMI_CLOUD_BILLING_WORKSPACE_ID: workspaceId };",
      },
      {
        path: "accounts/service/src/privacy-routes.ts",
        content: 'const policyRef = "takosumi-cloud-privacy-retention@v1";',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "commercial-billing-in-oss",
      "retired-authority-key",
      "commercial-billing-in-oss",
      "production-dev-mode-bypass",
      "output-name-magic",
      "reserved-service-input",
      "commercial-billing-in-oss",
      "commercial-billing-in-oss",
    ]);
  });

  test("rejects renamed Output Sync runtime registries without blocking Source sync", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "accounts/service/src/control/runtime-projection.ts",
        content: [
          "const runtime_projection = { outputName };",
          "const projection_grant = { capsuleId };",
        ].join("\n"),
      },
      {
        path: "core/api/deploy_control_run_group_routes.ts",
        content: 'router.post("/output-sync", runOutputSync);',
      },
      {
        path: "core/domains/interfaces/service-publication.ts",
        content:
          "interface ServicePublication { capsuleId: string; outputName: string }",
      },
      {
        path: "runner/lib/source_sync.ts",
        content:
          "export async function syncSourceSnapshot() { return fetchGitSource(); }",
      },
      {
        path: "dashboard/src/lib/editor-sync.ts",
        content:
          "export function syncClientDocument() { return persistLocalDraft(); }",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "retired-runtime-discovery",
      "retired-runtime-discovery",
      "retired-runtime-discovery",
      "retired-runtime-discovery",
    ]);
  });

  test("rejects reserved Output inference in operational probes and templates", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "scripts/smoke-platform-control-plane.ts",
        content: [
          'const publicUrl = firstStringValue(publicOutputs, ["url", "public_url"]);',
          "childEnv.TAKOSUMI_CAPSULE_PUBLIC_URL = publicUrl;",
          "const outputUrl = publicOutputs?.url;",
          "const workerName = options.vars.worker_name;",
          'for (const outputName of ["worker_name", "service_runtime_name"]) {}',
          'Object.prototype.hasOwnProperty.call(options.outputAllowlist, "worker_name");',
        ].join("\n"),
      },
      {
        path: "scripts/validate-release-activation-evidence.ts",
        content: 'nonSensitiveOutputKeys: ["public_url"],',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "operational-output-name-inference",
      "operational-output-name-inference",
      "operational-output-name-inference",
      "operational-output-name-inference",
      "operational-output-name-inference",
      "operational-output-name-inference",
      "operational-output-name-inference",
    ]);
  });

  test("rejects launcher URL authority reconstructed from Outputs or Store metadata", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "dashboard/src/views/apps/AppListView.tsx",
        content: [
          "const url = stateVersion.publicOutputs.launch_url;",
          'const fallback = output.workspaceOutputs["app_url"];',
          "const surface = appSurfaceFromInstallConfigStore(config);",
        ].join("\n"),
      },
      {
        path: "dashboard/src/views/runs/RunView.tsx",
        content: "const url = launchUrlFromDeployment(deployment);",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "output-name-magic",
      "output-name-magic",
      "output-name-magic",
      "output-name-magic",
    ]);
  });

  test("rejects official-hostname environment inference in operator smoke tooling", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "scripts/smoke-platform-control-plane.ts",
        content: [
          "const environment = defaultSmokeEnvironment(url);",
          'if (hostname === "app-staging.takosumi.com") return "staging";',
        ].join("\n"),
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "hosted-environment-inference",
      "hosted-environment-inference",
    ]);
  });

  test("rejects implicit provider defaults and repository-path inference in control-plane smoke tooling", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "scripts/smoke-platform-control-plane.ts",
        content: [
          'if (value === undefined || value === "guided") return "guided";',
          'if (value === undefined || value === "cloudflare-worker") return "cloudflare-worker";',
          "const style = defaultSmokeVariableStyle(input);",
          'if (moduleKey.includes("providers/cloudflare/modules/worker")) return legacy;',
          'if (installConfigId === "cloudflare-hello-worker") return legacy;',
          'const appName = stringRecordValue(explicitVars, "project_name");',
        ].join("\n"),
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "implicit-provider-smoke-default",
      "implicit-provider-smoke-default",
      "implicit-provider-smoke-default",
      "implicit-provider-smoke-default",
      "implicit-provider-smoke-default",
      "implicit-provider-smoke-default",
    ]);
  });

  test("rejects list-order and id-shape InstallConfig selection in control-plane smoke tooling", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "scripts/smoke-platform-control-plane.ts",
        content: [
          "const match = configs.find(isSelectableCapsuleInstallConfig);",
          "if (config.workspaceId !== undefined && /^icfg_/.test(config.id)) return false;",
        ].join("\n"),
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "implicit-install-config-selection",
      "implicit-install-config-selection",
    ]);
  });

  test("allows explicit provider adapters, Resource Shape Space, and migration history", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "providers/cloudflare/connection.ts",
        content: "export const cloudflareCredentialDriver = {};",
      },
      {
        path: "contract/resource-shape.ts",
        content: "export interface Space { id: string }",
      },
      {
        path: "cli/src/cli-resource-shape-commands.ts",
        content: "const resourceSpace = record.spaceId;",
      },
      {
        path: "core/adapters/storage/migrations.ts",
        content: "create table stripe_legacy; type Installation = unknown;",
      },
      {
        path: "core/domains/deploy-control/provider_policy.ts",
        content: "const providerInstallationPolicy = explicitPolicy;",
      },
      {
        path: "cli/src/cli-accounts-db.ts",
        content: [
          "// Immutable account-plane schema migration catalog begins.",
          "const sql = `select stripeCustomerId from billing_accounts_by_stripe_customer`;",
          "// Immutable account-plane schema migration catalog ends.",
        ].join("\n"),
      },
    ]);

    expect(violations).toEqual([]);
  });

  test("allows audited Output names inside the explicit service-side InstallConfig composition", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "deploy/reference-app-install-configs.ts",
        content: [
          'outputAllowlist: { mcp_url: { from: "mcp_url" } },',
          'inputs: { endpoint: { source: "capsule_output", outputName: "mcp_url" } },',
        ].join("\n"),
      },
    ]);

    expect(violations).toEqual([]);
  });

  test("allows Resource Shape Space only inside explicit mixed-file regions", () => {
    const allowed = findGeneralizationBoundaryViolations([
      {
        path: "dashboard/src/i18n/en.ts",
        content: [
          "// --- Resource Shape",
          '\"resources.scope.title\": \"Resource Space\",',
          "// --- account",
        ].join("\n"),
      },
      {
        path: "dashboard/src/lib/control-api.ts",
        content: [
          "// --- Resource Shape API",
          "interface ResourceTargetPool { readonly spaceId: string }",
          "// Helpers shared by the control views",
        ].join("\n"),
      },
      {
        path: "deploy/platform/worker.ts",
        content: [
          "async function platformResourceShapeExternalRequest() {",
          '  return Response.json({ error_description: \"Resource Space mismatch\" });',
          "}",
          "function platformInterfaceAccessFailure() {}",
          "function platformResourceShapeRequestedSpaces(url: URL) {",
          '  return url.searchParams.get(\"space\");',
          "}",
          "function platformResourceShapeActorContext() {}",
          "export function createPlatformCanonicalResourceReadAuthority() {",
          '  return url.searchParams.get(\"space\");',
          "}",
          "async function resolveReadyCompatibilityEvidence() {}",
        ].join("\n"),
      },
      {
        path: "core/bootstrap.ts",
        content: [
          "// --- Resource Shape host inventory",
          "const namespace = candidate.spaceId;",
          "// --- End Resource Shape host inventory",
        ].join("\n"),
      },
    ]);

    expect(allowed).toEqual([]);

    const rejected = findGeneralizationBoundaryViolations([
      {
        path: "dashboard/src/lib/control-api.ts",
        content: "interface LegacyStack { readonly spaceId: string }",
      },
      {
        path: "deploy/platform/worker.ts",
        content:
          'const spaceId = url.searchParams.get(\"space\") ?? workspaceId;',
      },
      {
        path: "core/bootstrap.ts",
        content: "const namespace = candidate.spaceId;",
      },
    ]);

    expect(new Set(rejected.map((violation) => violation.ruleId))).toEqual(
      new Set(["retired-stack-alias", "retired-stack-request-alias"]),
    );
  });

  test("rejects retired artifact object-key layouts outside immutable migrations", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/adapters/storage/artifact-references.ts",
        content:
          "return `spaces/${workspaceId}/installations/${capsuleId}/states/current.json`;",
      },
      {
        path: "worker/src/durable/OpenTofuRunnerObject.ts",
        content:
          "return `opentofu-state/${backendId}/installations/${capsuleId}/terraform.tfstate`;",
      },
      {
        path: "core/adapters/storage/migrations.ts",
        content:
          "const historicalRef = 'spaces/ws_1/installations/cap_1/states/1.tfstate';",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "retired-artifact-object-key-layout",
      "retired-artifact-object-key-layout",
    ]);
  });

  test("keeps commercial customer and rated-usage persistence out of OSS Accounts", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "accounts/service/src/store.ts",
        content:
          "export interface BillingAccountRecord { providerCustomerId: string }",
      },
      {
        path: "accounts/service/src/d1-store.ts",
        content:
          'return this.#put("billing_usage_records", record.id, record);',
      },
      {
        path: "accounts/service/src/postgres/internal.ts",
        content: "const dunningStartedAt = row.dunning_started_at;",
      },
      {
        path: "accounts/service/migrations/008_history.sql",
        content:
          "create table accounts_v1.billing_accounts (provider_customer_id text);",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "commercial-accounts-persistence",
      "commercial-accounts-persistence",
      "commercial-accounts-persistence",
    ]);
  });

  test("keeps fixed prices and plan-action weights out of OSS showback", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "contract/billing.ts",
        content: "export const RUNNER_MINUTE_USD_MICROS = 10_000;",
      },
      {
        path: "core/domains/deploy-control/billing_service.ts",
        content:
          "const PLAN_ESTIMATE_BASE_UNITS = 1; function planActionUnits(action: string) { switch (action) { case 'create': return 2; } }",
      },
      {
        path: "core/domains/deploy-control/run-engine/run_engine.ts",
        content: "const usdMicros = runnerMinuteUsdMicros(quantity);",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "fixed-oss-showback-rating",
      "fixed-oss-showback-rating",
      "fixed-oss-showback-rating",
    ]);
  });

  test("keeps hosted and commercial readiness schemas out of the OSS baseline", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "cli/src/cli-platform-readiness-constants.ts",
        content: [
          'const required = ["billing-entitlement", "customer-operations"];',
          'const fields = ["sku", "billingMeterRef", "supportSlaRef"];',
        ].join("\n"),
      },
      {
        path: "cli/src/cli-platform-readiness.ts",
        content:
          'if (type === "entitlement-event") return validateStripeInvoice(value);',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "commercial-readiness-schema-in-oss",
      "commercial-readiness-schema-in-oss",
      "commercial-billing-in-oss",
      "commercial-readiness-schema-in-oss",
    ]);
  });

  test("keeps readiness evidence semantics in explicit schema data", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "cli/src/cli-platform-readiness.ts",
        content: [
          'if (field.endsWith("Digest")) return isSha256(value);',
          "function hasValidStructuredEvidenceCrossFieldShape() {}",
          "switch (type) { case 'load-test': return true; }",
          "switch (entry.id) { case 'fresh-signup': return true; }",
        ].join("\n"),
      },
      {
        path: "contract/platform-readiness.ts",
        content:
          'const format = schema.formats[field]; switch (format) { case "sha256": return true; }',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "readiness-schema-name-inference",
      "readiness-schema-name-inference",
      "readiness-schema-name-inference",
      "readiness-schema-name-inference",
    ]);
  });

  test("keeps retired commercial and support vocabulary out of the readiness baseline", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "cli/src/cli-platform-readiness-constants.ts",
        content: [
          'const domain = "quota-abuse-spend-control";',
          'const legal = "legal-privacy-support";',
          'const release = "support-note";',
          'const security = "vulnerability-sla";',
        ].join("\n"),
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "retired-readiness-baseline-vocabulary",
      "retired-readiness-baseline-vocabulary",
      "retired-readiness-baseline-vocabulary",
      "retired-readiness-baseline-vocabulary",
    ]);
  });

  test("requires exact provider source matching and generic upstream descriptors", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "runner/lib/util.ts",
        content: 'return providerSource.endsWith("/cloudflare");',
      },
      {
        path: "deploy/node-postgres/src/handler.ts",
        content: "env.TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_ID",
      },
      {
        path: "core/api/connection_oauth_helpers.ts",
        content:
          'return { GOOGLE_CREDENTIALS: JSON.stringify({ type: "authorized_user" }) };',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "provider-oauth-mapping-in-core",
      "fixed-upstream-provider",
      "provider-name-inference",
    ]);
  });

  test("keeps managed-provider authority explicit and separate from providerConfig", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "accounts/service/src/control/shared.ts",
        content:
          "return connection.scopeHints?.providerConfig?.base_url !== undefined;",
      },
      {
        path: "dashboard/src/views/new/NewAppView.tsx",
        content:
          "const usable = connection.scopeHints.providerConfig?.base_url;",
      },
      {
        path: "worker/src/worker_service.ts",
        content:
          "createManagedProviderRunToken({ audience: providerBaseUrl });",
      },
      {
        path: "core/shared/managed_provider_tokens.ts",
        content: [
          "readonly expectedProviderBaseUrl?: string;",
          "readonly providerBaseUrlHash?: string;",
        ].join("\n"),
      },
      {
        path: "deploy/platform/worker.ts",
        content:
          "verifyManagedProviderRunToken(token, { expectedProviderBaseUrl: routeUrl });",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "implicit-managed-provider-authority",
      "implicit-managed-provider-authority",
      "implicit-managed-provider-authority",
      "implicit-managed-provider-authority",
      "implicit-managed-provider-authority",
      "implicit-managed-provider-authority",
    ]);
    expect(
      findGeneralizationBoundaryViolations([
        {
          path: "core/domains/deploy-control/plan_resolution.ts",
          content:
            "const configuration = connection.scopeHints?.providerConfig?.base_url;",
        },
        {
          path: "core/domains/resource-shape/opentofu_adapter.ts",
          content: "renderProviderConfig({ base_url: providerBaseUrl });",
        },
        {
          path: "providers/cloudflare/provider_config.ts",
          content: "return { base_url: endpoint };",
        },
      ]),
    ).toEqual([]);
  });

  test("rejects direct managed-provider marker checks in authority consumers", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "dashboard/src/views/new/NewAppView.tsx",
        content: "return connection.scopeHints?.managedProvider === true;",
      },
      {
        path: "core/domains/deploy-control/plan_resolution.ts",
        content:
          "if (entry.connection?.scopeHints?.managedProvider !== true) continue;",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "direct-managed-provider-marker-authority",
      "direct-managed-provider-marker-authority",
    ]);
  });

  test("keeps Provider Connection material out of operator release webhooks", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "worker/src/release_activator.ts",
        content:
          "const credentialEnv = releaseActivationCredentialEnv(input.credentials);\nreturn credentialEnv ? { credentials: credentialEnv } : {};",
      },
      {
        path: "scripts/operator-release-activator.ts",
        content:
          "const credentialEnv = payload.credentials?.env ?? {};\nconst parsed = parsePayloadCredentials(raw);",
      },
      {
        path: "docs/operations/release-artifacts.md",
        content:
          "Use the normal Provider Connection credential from the activation payload.",
      },
    ]);

    expect(new Set(violations.map((violation) => violation.ruleId))).toEqual(
      new Set(["operator-release-credential-boundary"]),
    );
    expect(violations).toHaveLength(5);
  });

  test("keeps credential delivery out of RunnerProfile", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "contract/internal-deploy-control-api.ts",
        content:
          "interface RunnerProfile { credentialRefs: RunnerCredentialReference[]; requireCredentialRefs: boolean }",
      },
      {
        path: "runner/lib/credentials.ts",
        content: 'const ref = "env://CLOUDFLARE_API_TOKEN";',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "runner-credential-authority",
      "runner-credential-authority",
    ]);
  });

  test("keeps retired SQL names behind canonical logical schema keys", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/adapters/storage/drizzle/schema/postgres.ts",
        content:
          'export const installations = pgTable(names.installations, { installationJson: json("installation_json") });',
      },
      {
        path: "worker/src/d1_opentofu_store.ts",
        content: "await db.insert(schema.installationDependencies);",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "retired-logical-storage-alias",
      "retired-logical-storage-alias",
    ]);
  });

  test("rejects the orphaned runtime service-grant model and fixed federation routes", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/domains/security/service.ts",
        content: "export class WorkerAuthzService {}",
      },
      {
        path: "docs/reference/api.md",
        content: "POST /v1/identity/federation/aws",
      },
      {
        path: "contract/security.ts",
        content:
          'const token = "tksvc_example"; const service_grant_signing_key = env.STORAGE_TOKEN_SIGNING_KEY;',
      },
      {
        path: "core/shared/service_scoped_credentials.ts",
        content: "export function mintServiceScopedCredentials() {}",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "retired-workload-authz-model",
      "retired-workload-authz-model",
      "retired-workload-authz-model",
      "retired-workload-authz-model",
    ]);
  });

  test("keeps CredentialRecipe auth modes open", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "docs/en/reference/api.md",
        content:
          "Credentials use `static` / `oidc` / `agent` / `managed` modes.",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "closed-credential-mode-taxonomy",
    ]);
  });

  test("keeps reference Credential Recipe catalogs out of Core defaults", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/bootstrap.ts",
        content:
          "const recipes = options.credentialRecipes ?? BUILT_IN_CREDENTIAL_RECIPES;",
      },
      {
        path: "core/adapters/vault/mod.ts",
        content: "const drivers = REFERENCE_CREDENTIAL_RECIPE_DRIVERS;",
      },
      {
        path: "core/domains/deploy-control/mod.ts",
        content: "const recipes = REFERENCE_CREDENTIAL_RECIPES;",
      },
      {
        path: "core/domains/deploy-control/run_engine.ts",
        content:
          'const declared = connection.credentialRecipe?.id === "generic-env";',
      },
      {
        path: "scripts/operator-release-activator.ts",
        content:
          "const credentialNames = BUILT_IN_CREDENTIAL_RECIPES.flatMap((recipe) => recipe.envNames);",
      },
      {
        path: "core/adapters/vault/provider_registration.ts",
        content:
          'import { validateRegistration } from "@takosumi/providers/generic-env-provider/connection.ts";',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "implicit-credential-recipe-catalog",
      "implicit-credential-recipe-catalog",
      "implicit-credential-recipe-catalog",
      "implicit-credential-recipe-catalog",
      "implicit-credential-recipe-catalog",
      "implicit-credential-recipe-catalog",
    ]);
    expect(
      findGeneralizationBoundaryViolations([
        {
          path: "worker/src/worker_service.ts",
          content: "const installed = REFERENCE_CREDENTIAL_RECIPE_COMPOSITION;",
        },
      ]),
    ).toEqual([]);
  });

  test("keeps unimplemented pre-run modes out of installed reference catalogs", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "providers/registry.ts",
        content: [
          "const reservedDriver = { mint() { throw new Error(); } };",
          "const composition = { credentialRecipes: REFERENCE_CREDENTIAL_RECIPES };",
        ].join("\n"),
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "advertised-unimplemented-pre-run-recipe",
      "advertised-unimplemented-pre-run-recipe",
    ]);
  });

  test("keeps vendor OAuth helper discovery at composition roots", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/bootstrap.ts",
        content:
          "const helpers = options.connectionOAuthHelpers ?? createConnectionOAuthHelpersFromEnv(runtimeEnv);",
      },
      {
        path: "core/api/connection_oauth_helpers.ts",
        content:
          "for (const descriptor of connectionOAuthDescriptorsFromEnv(env)) install(descriptor);",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "implicit-provider-oauth-helper-composition",
      "implicit-provider-oauth-helper-composition",
    ]);
    expect(
      findGeneralizationBoundaryViolations([
        {
          path: "worker/src/worker_service.ts",
          content:
            "const descriptors = connectionOAuthDescriptorsFromEnv(runtimeEnv);",
        },
      ]),
    ).toEqual([]);
  });

  test("keeps hardening evidence open to the operator-installed recipe set", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "scripts/validate-production-hardening-evidence.ts",
        content: [
          'const REQUIRED_CREDENTIAL_RECIPE_IDS = ["aws", "cloudflare"];',
          "genericEnvRecipeVerified: true",
        ].join("\n"),
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "fixed-credential-recipe-evidence-catalog",
      "fixed-credential-recipe-evidence-catalog",
    ]);
  });

  test("keeps host-specific hardening checks in contributions", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "scripts/validate-production-hardening-evidence.ts",
        content:
          'const containerSmoke = { capsuleModule: "cloudflare-hello-worker" };',
      },
      {
        path: "worker/src/bindings.ts",
        content: "TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF?: string;",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "fixed-host-hardening-schema-in-oss",
      "fixed-host-hardening-schema-in-oss",
    ]);
  });

  test("keeps observability scope explicit", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/domains/observability/types.ts",
        content: "interface MetricEvent { spaceId?: string; groupId?: string }",
      },
      {
        path: "core/domains/observability/otlp_exporter.ts",
        content: 'attribute("takosumi.space_id", event.workspaceId)',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "ambiguous-observability-scope",
      "ambiguous-observability-scope",
    ]);
  });

  test("keeps platform scope labels and request authority canonical", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "deploy/platform/worker.ts",
        content: [
          'const workspaceId = request.headers.get("x-takosumi-platform-space-id");',
          'metrics.push({ space_id: workspaceId, operationKind: "apply" });',
        ].join("\n"),
      },
      {
        path: "deploy/observability/grafana/takosumi-deploy-overview.json",
        content:
          '"title": "Runtime Cell", "expr": "{installation_id=~\\\".+\\\"}"',
      },
      {
        path: "core/api/interface_routes.ts",
        content:
          'url.searchParams.get("workspace") ?? url.searchParams.get("workspaceId")',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "retired-stack-request-alias",
      "retired-platform-scope-label",
      "retired-stack-request-alias",
      "retired-platform-scope-label",
    ]);
  });

  test("keeps opaque token prefixes out of platform authorization", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "deploy/platform/worker.ts",
        content: [
          'if (token.startsWith("takpat_")) return verifyPat(token);',
          'if (token.startsWith("takat_")) return verifyOAuth(token);',
          'if (token.startsWith("taksrv_")) return verifyService(token);',
        ].join("\n"),
      },
      {
        path: "accounts/service/src/account-session.ts",
        content:
          'if (token.startsWith("takpat_")) return authenticatePat(token);',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "opaque-token-prefix-authorization",
      "opaque-token-prefix-authorization",
      "opaque-token-prefix-authorization",
      "opaque-token-prefix-authorization",
    ]);
  });

  test("keeps commercial discovery behind open extension tokens", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "contract/capabilities.ts",
        content:
          "interface TakosumiCommercialCapabilities { readonly billing: boolean }",
      },
      {
        path: "dashboard/src/lib/runtime-capabilities.ts",
        content:
          "return runtimeCapabilities()?.commercial.payment_enforcement === true;",
      },
      {
        path: "mobile-kit/src/types.ts",
        content: "readonly commercial?: Record<string, unknown>;",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "fixed-commercial-capability-schema",
      "fixed-commercial-capability-schema",
      "fixed-commercial-capability-schema",
    ]);
  });

  test("keeps the official hosted endpoint out of shared clients", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "mobile-kit/src/url.ts",
        content: 'const hostCenterUrl = "https://app.takosumi.com/install";',
      },
      {
        path: "dashboard/src/lib/operator.ts",
        content: 'return fetch("https://app.takosumi.com/api/v1/session");',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "hosted-endpoint-in-shared-client",
      "hosted-endpoint-in-shared-client",
    ]);
  });

  test("keeps execution semantics out of structured-code prefixes", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "dashboard/src/views/runs/RunView.tsx",
        content: 'if (run.errorCode?.startsWith("billing_")) showBilling();',
      },
      {
        path: "core/domains/sources/capsule_compatibility.ts",
        content: 'if (finding.code.includes("unsupported")) return "blocked";',
      },
      {
        path: "core/domains/deploy-control/run_env_resolver.ts",
        content:
          'if (resolution.status.startsWith("blocked_")) throw new Error();',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "structured-code-prefix-inference",
      "structured-code-prefix-inference",
      "structured-code-prefix-inference",
    ]);
  });

  test("keeps provider token signatures in the canonical redaction boundary", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "dashboard/src/views/runs/RunView.tsx",
        content: "const tokenPattern = /github_pat_|glpat|xox[baprs]/;",
      },
      {
        path: "core/domains/capsules/mod.ts",
        content: "const keyPattern = /gh[pousr]_|AKIA|ASIA/;",
      },
      {
        path: "deploy/node-postgres/src/server.ts",
        content: "const localRedaction = /AKIA|github_pat_/;",
      },
    ]);

    expect(new Set(violations.map((violation) => violation.ruleId))).toEqual(
      new Set(["duplicate-provider-token-redaction-catalog"]),
    );
    expect(
      violations.some(
        (violation) => violation.path === "deploy/node-postgres/src/server.ts",
      ),
    ).toBe(true);
  });

  test("keeps Condition reasons open to installed adapters", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/api/openapi.ts",
        content:
          'reason: { $ref: "#/components/schemas/CoreConditionReason" },\n' +
          "CoreConditionReason: { enum: [...CORE_CONDITION_REASONS] },",
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "closed-condition-reason-taxonomy",
      "closed-condition-reason-taxonomy",
    ]);
  });

  test("keeps InstallConfig presentation hints open", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "contract/install-configs.ts",
        content:
          'export type InstallConfigVariableInputFormat = "text" | "url";',
      },
      {
        path: "accounts/service/src/control/parse.ts",
        content:
          'return value === "text" || value === "url" || value === "sha256" ? value : undefined;',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "closed-install-presentation-format",
      "closed-install-presentation-format",
    ]);
  });

  test("keeps usage producer tokens open", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "contract/billing.ts",
        content:
          'export type UsageEventSource = "runner" | "resource_meter" | "manual_adjustment";',
      },
      {
        path: "core/domains/deploy-control/usage_service.ts",
        content:
          'return value === "resource_meter" || value === "manual_adjustment";',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "closed-usage-source-taxonomy",
      "closed-usage-source-taxonomy",
    ]);
  });

  test("keeps omitted Git refs on symbolic HEAD in control-plane smoke tooling", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "scripts/smoke-platform-control-plane.ts",
        content:
          'const sourceRef = env.TAKOSUMI_SMOKE_SOURCE_REF ?? "main";\nconst reported = sourceRef ?? "main";',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "implicit-git-default-branch",
      "implicit-git-default-branch",
    ]);
  });

  test("keeps SourceSnapshot Git-only", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/domains/deploy-control/run_verification.ts",
        content:
          'return snapshot.url.startsWith("takosumi://generated-root/");',
      },
    ]);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "synthetic-source-snapshot",
    ]);
  });

  test("rejects control decisions derived from human-readable error messages", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "accounts/service/src/control/shared.ts",
        content: 'if (/already claimed/.test(message)) return "conflict";',
      },
      {
        path: "accounts/service/src/control/capsules.ts",
        content: 'if (message.includes("connection pending")) return true;',
      },
      {
        path: "core/api/deploy_control_shared.ts",
        content: 'if (message === "duplicate") return sanitized;',
      },
      {
        path: "dashboard/src/lib/control-api.ts",
        content: "return /source_sync_required/.test(this.message);",
      },
      {
        path: "scripts/smoke-platform-control-plane.ts",
        content:
          'if (error.message.startsWith("cloudflare resource preflight failed:")) return retry;',
      },
    ]);

    expect(violations).toHaveLength(5);
    expect(new Set(violations.map((violation) => violation.ruleId))).toEqual(
      new Set(["control-error-message-inference"]),
    );

    expect(
      findGeneralizationBoundaryViolations([
        {
          path: "dashboard/src/lib/control-api.ts",
          content:
            'return this.status === 409 && this.reason === "duplicate_capsule";',
        },
      ]),
    ).toEqual([]);
  });

  test("rejects Run classification derived from diagnostic or exception prose", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "dashboard/src/views/runs/RunView.tsx",
        content:
          "function accessIssueFromText(value: string) { return value.includes('pending'); }",
      },
      {
        path: "core/domains/deploy-control/projection.ts",
        content:
          "function classifiedErrorDiagnostic(message: string) { return message.includes('credential'); }",
      },
      {
        path: "core/domains/deploy-control/projection_run.ts",
        content: "const code = compactErrorCode(diagnostic.message);",
      },
      {
        path: "core/domains/deploy-control/run_credential_broker.ts",
        content: "if (mapped.message.startsWith('credential_')) throw mapped;",
      },
      {
        path: "dashboard/src/views/new/install-helpers.ts",
        content:
          "if (/provider connection/.test(apiError?.message)) return friendly;",
      },
      {
        path: "core/domains/sources/mod.ts",
        content: "return { errorCode: diagnosticMessage };",
      },
    ]);

    expect(violations).toHaveLength(6);
    expect(new Set(violations.map((violation) => violation.ruleId))).toEqual(
      new Set(["diagnostic-message-inference"]),
    );
  });

  test("limits the worker migration exception to the immutable catalog", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "worker/src/d1_opentofu_store.ts",
        content: [
          "const activeInstallationId = request.installationId;",
          "const D1_OPEN_TOFU_SCHEMA_MIGRATIONS = [",
          '  "alter table installations rename to capsules",',
          "];",
        ].join("\n"),
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.ruleId).toBe("retired-stack-alias");
  });

  test("rejects hidden topology, storage, provider UI, and adapter specialization", () => {
    const violations = findGeneralizationBoundaryViolations([
      {
        path: "core/bootstrap.ts",
        content: "const runtimeCellId = env.TAKOSUMI_RUNTIME_CELL_ID;",
      },
      {
        path: "contract/outputs.ts",
        content:
          'readonly objectKey: string; const ref = "runner-local://run/output"; // R2_ARTIFACTS',
      },
      {
        path: "core/domains/audit-replication/external_log.ts",
        content: "class S3ImmutableLogReplicationSink {}",
      },
      {
        path: "dashboard/src/views/account/lib/connections.ts",
        content:
          'const AWS_CREATE_KEY_URL = "https://console.aws.amazon.com/iam";',
      },
      {
        path: "contract/install-configs.ts",
        content: 'const defaultValue = "service-name-with-workspace";',
      },
      {
        path: "core/domains/sources/mod.ts",
        content: 'const DEFAULT_REF = "main";',
      },
      {
        path: "runner/lib/policy.ts",
        content: 'if (host === "metadata.google.internal") throw blocked;',
      },
      {
        path: "core/api/deploy_control_capsule_routes.ts",
        content: 'return config.trustLevel === "trusted";',
      },
      {
        path: "dashboard/src/lib/tcs-client.ts",
        content: 'type TcsListingKind = "app" | "worker" | "storage";',
      },
      {
        path: "runner/lib/backup.ts",
        content:
          "providerSnapshotCommandEnvNames(PROVIDER_SNAPSHOT_COMMAND_ENV); primaryBackupProvider(config);",
      },
      {
        path: "core/domains/interfaces/service.ts",
        content: "deliveryIsImplemented(delivery, credentialIssuerConfigured);",
      },
      {
        path: "core/domains/interfaces/output_resolver.ts",
        content: "if (resource?.spaceId === workspaceId) return resource;",
      },
      {
        path: "core/domains/deploy-control/run-engine/run_engine.ts",
        content:
          "return /Durable Object reset because its code was updated/i.test(message);",
      },
      {
        path: "core/adapters/storage/encryption.ts",
        content: 'if (url.includes("cloudflare-d1")) return true;',
      },
      {
        path: "dashboard/src/views/new/NewAppView.tsx",
        content:
          'const placeholder = "https://github.com/your-name/service.git";',
      },
      {
        path: "contract/resource-shape.ts",
        content: "export type ResourceShapeKind = BundledResourceShapeKind;",
      },
      {
        path: "deploy/platform/worker.ts",
        content:
          "parseCapabilityList(env.TAKOSUMI_RESOURCE_SHAPES, RESOURCE_CAPABILITY_KEYS);",
      },
      {
        path: "core/domains/resource-shape/planner.ts",
        content: "const SECRET_VALUE_PATTERN = /github_pat_[A-Za-z0-9_]+/;",
      },
      {
        path: "core/domains/resource-shape/resolver.ts",
        content: "export const SHAPE_INTERFACE_REQUIREMENTS = {};",
      },
      {
        path: "contract/target.ts",
        content:
          "export type TargetPoolImplementation = TargetImplementationDescriptor;",
      },
      {
        path: "core/adapters/operator-config/types.ts",
        content: 'type OperatorConfigSource = "env" | "local";',
      },
      {
        path: "dashboard/src/views/new/install-helpers.ts",
        content: 'if (diagnostic.message === "Provider aws failed") return;',
      },
      {
        path: "core/api/deploy_control_connection_routes.ts",
        content: "const { kind: _legacyKind, ...request } = input;",
      },
      {
        path: "contract/provider-resolution.ts",
        content:
          "export const PROVIDER_DELIVERY_MODES = PROVIDER_CONNECTION_MATERIALIZATIONS;",
      },
    ]);

    expect(new Set(violations.map((violation) => violation.ruleId))).toEqual(
      new Set([
        "runtime-cell-model",
        "storage-substrate-contract",
        "embedded-audit-backend",
        "dashboard-provider-catalog",
        "magic-install-default",
        "implicit-git-default-branch",
        "provider-specific-network-policy",
        "hidden-store-admission",
        "closed-store-taxonomy",
        "provider-derived-backup-adapter",
        "fixed-interface-delivery",
        "resource-space-workspace-inference",
        "runner-substrate-message-in-core",
        "database-url-encryption-inference",
        "fixed-forge-placeholder",
        "closed-resource-shape-kind",
        "closed-resource-shape-kind",
        "closed-resource-capability-taxonomy",
        "retired-resource-descriptor-alias",
        "closed-operator-config-source",
        "diagnostic-message-inference",
        "silent-legacy-request-normalization",
        "retired-provider-delivery-alias",
        "provider-token-catalog-in-resource-core",
      ]),
    );
  });
});
