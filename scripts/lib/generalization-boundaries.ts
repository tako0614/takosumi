export interface GeneralizationBoundarySource {
  readonly path: string;
  readonly content: string;
}

export interface GeneralizationBoundaryViolation {
  readonly ruleId: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly excerpt: string;
}

interface BoundaryRule {
  readonly id: string;
  readonly message: string;
  readonly appliesTo: (path: string) => boolean;
  readonly patterns: readonly RegExp[];
}

const IMPLEMENTATION_ROOTS = [
  "accounts/",
  "cli/",
  "contract/",
  "core/",
  "dashboard/src/",
  "deploy/",
  "mobile-kit/",
  "provider/",
  "providers/",
  "runner/",
  "scripts/operator-release-activator.ts",
  "worker/",
] as const;

const STACK_FLOW_PREFIXES = [
  "accounts/service/src/control/",
  "cli/",
  "contract/",
  "core/api/deploy_control_",
  "core/bootstrap",
  "core/domains/backups/",
  "core/domains/capsules/",
  "core/domains/dependencies/",
  "core/domains/deploy-control/",
  "core/domains/output-shares/",
  "core/domains/projects/",
  "core/domains/run-groups/",
  "core/domains/sources/",
  "core/domains/workspaces/",
  "dashboard/src/",
  "deploy/",
  "runner/",
  "worker/",
] as const;

const RESOURCE_SHAPE_PATHS = [
  "cli/src/cli-resource-shape-commands.ts",
  "contract/resource-shape.ts",
  "contract/resolution.ts",
  "contract/target.ts",
  "core/api/resource_routes.ts",
  "core/domains/resource-shape/",
  "dashboard/src/lib/resource-shapes.ts",
  "dashboard/src/views/resources/",
  "provider/",
] as const;

const RULES: readonly BoundaryRule[] = [
  {
    id: "retired-contract-subpath",
    message:
      "current imports and path aliases must resolve to canonical Capsule contracts, not removed deployments/installations modules",
    appliesTo: (path) =>
      isImplementationPath(path) ||
      path === "tsconfig.json" ||
      path.endsWith("/tsconfig.json") ||
      path === "package.json" ||
      path.endsWith("/package.json"),
    patterns: [
      /takosumi-contract\/(?:deployments|installations)\b/,
      /(?:\.\.\/|\.\/)?contract\/(?:deployments|installations)\.ts\b/,
    ],
  },
  {
    id: "retired-stack-alias",
    message:
      "source-and-run code must use Workspace/Project/Capsule, not the retired Space/Installation aliases",
    appliesTo: (path) =>
      startsWithAny(path, STACK_FLOW_PREFIXES) &&
      !startsWithAny(path, RESOURCE_SHAPE_PATHS),
    patterns: [
      /\b(?:Installation|installationId|installationIds|getInstallation|putInstallation|patchInstallation|listInstallations|publicInstallation)\b/,
      /\b(?:Space|spaceId|spaceIds|getSpace|putSpace|patchSpace|listSpaces|publicSpace)\b/,
    ],
  },
  {
    id: "retired-authority-key",
    message:
      "Git Source plus service-side configuration is authoritative; retired install/template switches must not be read at runtime",
    appliesTo: isImplementationPath,
    patterns: [
      /\b(?:installType|sourceKind|templateBinding|defaultTemplateRegistry)\b/,
      /\/app\/templates\b/,
      /\bmodule-files\b/,
    ],
  },
  {
    id: "retired-duplicate-ledger",
    message:
      "Run/StateVersion/Output are the only stack execution ledger; retired duplicate records must not return",
    appliesTo: isImplementationPath,
    patterns: [
      /\b(?:Deployment|StateSnapshot|OutputSnapshot|deploymentId|stateSnapshotId|outputSnapshotId)\b/,
    ],
  },
  {
    id: "retired-runtime-discovery",
    message:
      "runtime discovery belongs to service-side Interface/InterfaceBinding, not a runtime-agent, Service Graph, Output Sync, Runtime Projection, or Service Publication ledger",
    appliesTo: isImplementationPath,
    patterns: [
      /\b(?:RuntimeAgent|runtimeAgent|ServiceGraph|serviceGraph|OutputSync|outputSync|RuntimeProjection|runtimeProjection|ServicePublication|servicePublication|projectionGrant|runtimeMaterial)\b/,
      /\b(?:runtime-agent|service_graph|service-graph|output_sync|output-sync|runtime_projection|runtime-projection|service_publication|service-publication|projection_grant|runtime_material)\b/,
    ],
  },
  {
    id: "output-name-magic",
    message:
      "OpenTofu outputs are ordinary return values; runtime behavior must use an explicit Interface input mapping",
    // This composition file is the service-side declaration that performs the
    // explicit mapping the rule requires. Its strings are ordinary, audited
    // module Output names, not runtime inference or a reserved schema.
    appliesTo: (path) =>
      isImplementationPath(path) &&
      path !== "deploy/reference-app-install-configs.ts",
    patterns: [
      /["'`](?:mcp_url|file_handler_url|service_graph|runtime_service)["'`]/,
      /\.endsWith\(\s*["'`](?:_url|_endpoint|_token)["'`]\s*\)/,
      /\b(?:publicOutputs|workspaceOutputs)\s*(?:\.|\?\.)\s*(?:launch_url|app_url|public_url)\b/,
      /\b(?:publicOutputs|workspaceOutputs)\s*\[\s*["'`](?:launch_url|app_url|public_url)["'`]\s*\]/,
      /\b(?:appSurfaceFromInstallConfigStore|launchUrlFromDeployment|publicUrlFromOutputs)\b/,
    ],
  },
  {
    id: "operational-output-name-inference",
    message:
      "operational probes and evidence templates must consume explicitly configured Output names, never reserved-name candidates",
    appliesTo: (path) =>
      path === "scripts/smoke-platform-control-plane.ts" ||
      path === "scripts/validate-release-activation-evidence.ts",
    patterns: [
      /firstStringValue\(\s*publicOutputs\s*,/,
      /TAKOSUMI_CAPSULE_PUBLIC_URL/,
      /publicOutputs\?\.url/,
      /options\.vars\.worker_name/,
      /for\s*\(const outputName of\s*\[/,
      /hasOwnProperty\.call\(\s*options\.outputAllowlist\s*,\s*["'`]worker_name["'`]\s*\)/,
      /nonSensitiveOutputKeys:\s*\[\s*["'`]public_url["'`]\s*\]/,
    ],
  },
  {
    id: "reserved-service-input",
    message:
      "Capsule variables are ordinary OpenTofu inputs; service connectivity requires an explicit Interface/InterfaceBinding mapping",
    appliesTo: (path) =>
      path === "core/domains/deploy-control/run-engine/run_engine.ts" ||
      path === "lib/rootgen/src/mod.ts",
    patterns: [
      /\bSERVICE_CONNECTION_VARIABLES\b/,
      /\b(?:object_storage_api_url|git_http_url)\b/,
      /\binjectedVariables\b/,
    ],
  },
  {
    id: "runner-metadata-selection",
    message:
      "Runner selection must use an explicit RunnerProfile executorId, never provider names or inert labels",
    appliesTo: isImplementationPath,
    patterns: [
      new RegExp(
        "\\b(?:providerEnvRunner|ownKey|own_" +
          "key|runner-class|profile-kind|profile-order)\\b",
      ),
      /takosumi\.com\/profile(?:-|\/)/,
    ],
  },
  {
    id: "runner-credential-authority",
    message:
      "ProviderBinding and CredentialRecipe are the sole credential delivery authority; RunnerProfile must not carry parallel credential refs",
    appliesTo: (path) =>
      path === "contract/internal-deploy-control-api.ts" ||
      path === "core/domains/deploy-control/mod.ts" ||
      path === "core/domains/deploy-control/policy.ts" ||
      path === "core/domains/deploy-control/runner_profiles.ts" ||
      path === "core/domains/deploy-control/run-engine/run_engine.ts" ||
      path === "runner/lib/credentials.ts",
    patterns: [
      /\b(?:RunnerCredentialReference|credentialRefs|requireCredentialRefs)\b/,
      /\benv:\/\//,
    ],
  },
  {
    id: "operator-release-credential-boundary",
    message:
      "operator lifecycle actions use explicitly configured operator env; Provider Connection material must never cross the release webhook boundary",
    appliesTo: (path) =>
      path === "worker/src/release_activator.ts" ||
      path === "scripts/operator-release-activator.ts" ||
      path === "docs/reference/deploy-control-api.md" ||
      path === "docs/operations/release-artifacts.md",
    patterns: [
      /releaseActivationCredentialEnv\(/,
      /payload\.credentials\?\.env/,
      /parsePayloadCredentials\(/,
      /credentialEnv\s*\?\s*\{\s*credentials\s*:/,
      /Provider Connection credential from the activation payload/i,
    ],
  },
  {
    id: "provider-name-inference",
    message:
      "provider behavior must use exact declared source matching or an explicit provider-owned helper",
    appliesTo: isImplementationPath,
    patterns: [
      /\b(?:provider|providerSource|sourceAddress)\s*\.\s*(?:endsWith|startsWith)\(\s*["'`]\//,
    ],
  },
  {
    id: "implicit-managed-provider-authority",
    message:
      "managed-provider usability and run-token authority must use the explicit service-side managedProviderProfile, never opaque providerConfig or route URL inference",
    appliesTo: (path) =>
      path === "core/domains/connections/mod.ts" ||
      path === "accounts/service/src/control/shared.ts" ||
      path === "accounts/service/src/control/providers.ts" ||
      path === "dashboard/src/views/new/NewAppView.tsx" ||
      path === "worker/src/worker_service.ts" ||
      path === "core/shared/managed_provider_tokens.ts" ||
      path === "deploy/platform/worker.ts",
    patterns: [
      /scopeHints\??\.providerConfig\??\.base_url\b/,
      /\baudience\s*:\s*providerBaseUrl\b/,
      /\bexpectedProviderBaseUrl\??\s*:/,
      /\bproviderBaseUrlHash\b/,
    ],
  },
  {
    id: "direct-managed-provider-marker-authority",
    message:
      "managed-provider consumers must use isPublicManagedProviderConnection so marker, profile, and operator ownership stay one authority",
    appliesTo: (path) =>
      path === "accounts/service/src/control/shared.ts" ||
      path === "accounts/service/src/control/providers.ts" ||
      path === "dashboard/src/views/new/NewAppView.tsx" ||
      path === "worker/src/worker_service.ts" ||
      path === "core/domains/deploy-control/plan_resolution.ts" ||
      path === "deploy/platform/worker.ts",
    patterns: [/scopeHints\??\.managedProvider\b/],
  },
  {
    id: "provider-oauth-mapping-in-core",
    message:
      "OAuth state and exchange are generic Core concerns; vendor response fields and credential formats belong to provider-owned mappers",
    appliesTo: (path) => path === "core/api/connection_oauth_helpers.ts",
    patterns: [
      /\b(?:authorized_user|GOOGLE_CREDENTIALS|CLOUDFLARE_API_TOKEN)\b/,
      /tokenResponse\s*\[\s*["'`](?:access_token|refresh_token)["'`]\s*\]/,
      /tokenResponse\.(?:access_token|refresh_token)\b/,
    ],
  },
  {
    id: "implicit-provider-oauth-helper-composition",
    message:
      "Core accepts an explicit OAuth helper registry; vendor descriptor discovery belongs to a host composition root",
    appliesTo: (path) =>
      path === "core/bootstrap.ts" ||
      path === "core/api/connection_oauth_helpers.ts",
    patterns: [
      /\bcreateConnectionOAuthHelpersFromEnv\b/,
      /\bconnectionOAuthDescriptorsFromEnv\b/,
    ],
  },
  {
    id: "implicit-credential-recipe-catalog",
    message:
      "Core and generic operator executors must use only explicitly supplied Credential Recipe declarations; reference provider contributions belong to a composition root",
    appliesTo: (path) =>
      path.startsWith("core/") ||
      path === "scripts/operator-release-activator.ts",
    patterns: [
      /\bBUILT_IN_CREDENTIAL_RECIPES\b/,
      /\bREFERENCE_CREDENTIAL_RECIPES\b/,
      /\bBUILT_IN_CREDENTIAL_RECIPE_DRIVERS\b/,
      /\bREFERENCE_CREDENTIAL_RECIPE_(?:COMPOSITION|DRIVERS)\b/,
      /\blistBuiltInCredentialRecipes\b/,
      /credentialRecipe\??\.id\s*={2,3}\s*["'`]generic-env["'`]/,
      /from\s+["']@takosumi\/providers\/(?:aws|cloudflare|gcp|generic-env-provider)\//,
    ],
  },
  {
    id: "advertised-unimplemented-pre-run-recipe",
    message:
      "reference compositions must filter pre-run recipe modes by an installed mint driver, never advertise them through inert reserved drivers",
    appliesTo: (path) => path === "providers/registry.ts",
    patterns: [
      /\breservedDriver\b/,
      /credentialRecipes:\s*REFERENCE_CREDENTIAL_RECIPES\b/,
    ],
  },
  {
    id: "fixed-credential-recipe-evidence-catalog",
    message:
      "hardening evidence must attest the operator-installed recipe set and declared-env capability, not require a fixed vendor catalog",
    appliesTo: (path) =>
      path === "scripts/validate-production-hardening-evidence.ts",
    patterns: [
      /\bREQUIRED_CREDENTIAL_RECIPE_IDS\b/,
      /genericEnvRecipeVerified/,
    ],
  },
  {
    id: "fixed-host-hardening-schema-in-oss",
    message:
      "OSS hardening uses versioned contribution definitions; Cloudflare Container, official Capsule, and per-check env schemas belong to the composing host contribution",
    appliesTo: (path) =>
      path === "contract/platform-hardening.ts" ||
      path === "deploy/platform/production_hardening.ts" ||
      path === "deploy/platform/worker.ts" ||
      path === "worker/src/bindings.ts" ||
      path === "scripts/validate-production-hardening-evidence.ts" ||
      path === "scripts/verify-production-hardening-gates.ts",
    patterns: [
      /\b(?:containerSmoke|platformControlPlaneSmoke)\b/,
      /\bTAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_[A-Z]+\b/,
      /["'`](?:cloudflare-container|cloudflare-hello-worker)["'`]/i,
      /\bcapsuleModule:\s*["'`]cloudflare-hello-worker["'`]/i,
    ],
  },
  {
    id: "closed-credential-mode-taxonomy",
    message:
      "CredentialRecipe authModes and pre-run driver tokens are operator/provider-defined; Core and reference docs must not publish a fixed credential-mode taxonomy",
    appliesTo: (path) =>
      path === "contract/credential-recipes.ts" ||
      path === "docs/reference/api.md" ||
      path === "docs/en/reference/api.md",
    patterns: [
      /(?:static|static_secret)[`"']?\s*\/\s*[`"']?(?:oidc|oidc_federation)[\s\S]{0,100}(?:agent|agent_local)[\s\S]{0,100}managed/,
      /type\s+Credential(?:Recipe)?AuthMode\w*\s*=\s*["'](?:static|oidc|agent|managed)["']\s*\|/,
    ],
  },
  {
    id: "runner-substrate-message-in-core",
    message:
      "runner adapters classify substrate-specific failures; Core retries only the typed runner infrastructure error contract",
    appliesTo: (path) => path.startsWith("core/domains/deploy-control/"),
    patterns: [
      /Durable Object reset because its code was updated/i,
      /Maximum number of running container instances exceeded/i,
    ],
  },
  {
    id: "forge-or-manifest-authority",
    message:
      "core Source is GitAddress only and a Capsule repository must not require forge identifiers or a Takosumi manifest",
    appliesTo: isImplementationPath,
    patterns: [
      /\b(?:githubInstallationId|githubRepoId|githubOwner|githubWebhookPayload)\b/,
      /\.takosumi\.ya?ml\b/,
    ],
  },
  {
    id: "implicit-git-default-branch",
    message:
      "an omitted Git ref must use symbolic HEAD; Takosumi must not guess a main/master branch convention",
    appliesTo: (path) =>
      path === "contract/sources.ts" ||
      path === "core/domains/sources/mod.ts" ||
      path === "runner/lib/source_sync.ts" ||
      path === "dashboard/src/views/new/NewAppView.tsx" ||
      path === "scripts/smoke-platform-control-plane.ts",
    patterns: [
      /\bIMPLICIT_DEFAULT_REF\b/,
      /\bDEFAULT_REF\s*=\s*["'`]main["'`]/,
      /placeholder\s*=\s*["'`]main["'`]/,
      /Defaults to [`"']main[`"'] when omitted/,
      /TAKOSUMI_SMOKE_SOURCE_REF\s*\?\?\s*["'`]main["'`]/,
      /sourceRef\s*\?\?\s*["'`]main["'`]/,
    ],
  },
  {
    id: "synthetic-source-snapshot",
    message:
      "SourceSnapshot is Git-only; generated roots are run artifacts and must not masquerade as a synthetic Source URL",
    appliesTo: (path) =>
      path.startsWith("core/domains/deploy-control/") ||
      path === "contract/sources.ts",
    patterns: [
      /takosumi:\/\/generated-root/,
      /\bisGeneratedRootOnlySnapshot\b/,
    ],
  },
  {
    id: "provider-specific-network-policy",
    message:
      "source and runner network policy must classify addresses and internal namespaces generically, not enumerate provider metadata hostnames",
    appliesTo: (path) =>
      path === "runner/lib/policy.ts" ||
      path === "core/domains/sources/url-policy.ts",
    patterns: [/metadata\.google\.internal/i],
  },
  {
    id: "storage-substrate-contract",
    message:
      "portable contracts and core domains must expose opaque artifact refs; R2 names and object-key layouts belong to a storage adapter",
    appliesTo: (path) =>
      path.startsWith("contract/") ||
      (path.startsWith("core/") &&
        !path.startsWith("core/adapters/storage/") &&
        !path.startsWith("core/scripts/")),
    patterns: [
      /\b(?:archiveObjectKey|rawOutputArtifactKey|rawOutputsKey|stateObjectKey|producerStateObjectKey|planArtifactKey|artifactKey|objectKey)\b/,
      /\bR2_(?:SOURCE|STATE|ARTIFACTS|BACKUPS)\b/,
      /\br2:\/\//,
      /\brunner-local:\/\//,
    ],
  },
  {
    id: "retired-artifact-object-key-layout",
    message:
      "current artifact storage must allocate canonical Workspace/Capsule/Resource keys; retired Space/Installation layouts are migration data only",
    appliesTo: (path) =>
      path.startsWith("core/adapters/storage/") ||
      path.startsWith("worker/") ||
      path === "deploy/node-postgres/src/local-opentofu-runner.ts",
    patterns: [/\bspaces\//, /\binstallations\//],
  },
  {
    id: "retired-logical-storage-alias",
    message:
      "storage adapters may retain frozen physical SQL names, but their logical schema API must use Workspace/Capsule/ProviderBinding vocabulary",
    appliesTo: (path) =>
      path.startsWith("core/adapters/storage/drizzle/schema/") ||
      path === "core/domains/backups/mod.ts" ||
      path === "core/domains/deploy-control/store.ts" ||
      path === "core/domains/deploy-control/store_sql.ts" ||
      path === "worker/src/d1_opentofu_store.ts",
    patterns: [
      /\b(?:installationDependencies|providerEnvBindingSets|runsInputs|producerInstallationId|consumerInstallationId|fromSpaceId|toSpaceId|installationJson|installationName)\b/,
      /\b(?:schema|pgSchema|d1Schema)\.(?:spaces|installations)\b/,
      /\bexport\s+const\s+(?:spaces|installations)\b/,
      /\bnames\.(?:spaces|installations)\b/,
    ],
  },
  {
    id: "database-url-encryption-inference",
    message:
      "at-rest encryption requires explicit adapter/operator evidence; database URLs and backend names are not security attestations",
    appliesTo: (path) => path === "core/adapters/storage/encryption.ts",
    patterns: [
      /\bdetectEncryptionEvidence\b/,
      /\b(?:sslmode|cloudflare-d1|d1-managed-encryption)\b/i,
      /encrypted=true/i,
    ],
  },
  {
    id: "runtime-cell-model",
    message:
      "execution topology must use explicit RunnerProfile/executor/pool identity, not a retired shared or dedicated runtime-cell model",
    appliesTo: isImplementationPath,
    patterns: [
      /\b(?:runtimeCellId|runtime_cell_id|TAKOSUMI_RUNTIME_CELL(?:_ID)?)\b/,
      /\b(?:shared-cell|dedicated-materialize)\b/,
    ],
  },
  {
    id: "retired-platform-scope-label",
    message:
      "platform metrics and dashboards must name Stack Workspace/Capsule/RunnerProfile explicitly, not retired Space/Installation/runtime-cell labels",
    appliesTo: (path) =>
      path === "deploy/platform/worker.ts" ||
      path === "deploy/observability/grafana/takosumi-deploy-overview.json",
    patterns: [
      /\b(?:space_id|installation_id|operationKind)\b/,
      /Runtime Cell/i,
    ],
  },
  {
    id: "retired-stack-request-alias",
    message:
      "current Stack APIs must accept the canonical workspaceId authority only; retired Space and ambiguous workspace query aliases must not return",
    appliesTo: (path) =>
      path === "deploy/platform/worker.ts" ||
      path === "core/api/interface_routes.ts",
    patterns: [
      /\bPLATFORM_EXTENSION_SPACE_ID_HEADER\b/,
      /x-takosumi-platform-space-id/i,
      /\bplatformResourceShapeRequestSpaceId\b/,
      /searchParams\.get\(\s*["'`]space["'`]\s*\)/,
      /searchParams\.get\(\s*["'`]workspace["'`]\s*\)/,
    ],
  },
  {
    id: "opaque-token-prefix-authorization",
    message:
      "the platform must derive opaque bearer identity from authenticated introspection claims; token generation prefixes are not routing or authorization authority",
    appliesTo: (path) =>
      path === "deploy/platform/worker.ts" ||
      path === "accounts/service/src/account-session.ts",
    patterns: [/tak(?:pat|at|srv)_/],
  },
  {
    id: "retired-workload-authz-model",
    message:
      "runtime authorization belongs to OIDC principals, InterfaceBinding, RunnerProfile, and Resource Policy; the orphaned group/activation service-grant model must not return",
    appliesTo: (path) =>
      isImplementationPath(path) ||
      path === "docs/reference/api.md" ||
      path === "docs/en/reference/api.md",
    patterns: [
      /\b(?:WorkerAuthzService|NetworkServiceGrant|RuntimeNetworkPolicy)\b/,
      /\btksvc_[A-Za-z0-9_-]*\b/,
      /\b(?:service_grant_signing_key|STORAGE_TOKEN_SIGNING_KEY|GIT_TOKEN_SIGNING_KEY)\b/,
      /\bservice_scoped_credentials\b/,
      /\b(?:ServiceScopedCredentials|mintServiceScopedCredentials)\b/,
      /\/v1\/identity\/federation\/(?:aws|gcp|kubernetes)\b/,
    ],
  },
  {
    id: "magic-install-default",
    message:
      "InstallConfig defaults must use a discriminated literal or explicit value source, not reserved string values interpreted by the dashboard",
    appliesTo: (path) =>
      path === "contract/install-configs.ts" ||
      path === "accounts/service/src/control/workspaces.ts" ||
      path.startsWith("dashboard/src/views/new/") ||
      path.startsWith("core/domains/capsules/") ||
      path.startsWith("core/domains/deploy-control/"),
    patterns: [
      /["'`]service-name["'`]/,
      /["'`]service-name-with-(?:space|workspace)["'`]/,
      /\bcanonicalizePersistedInstallConfigDefaults\b/,
    ],
  },
  {
    id: "closed-install-presentation-format",
    message:
      "InstallConfig variable format is an open presentation hint with a safe generic fallback, not a closed execution taxonomy",
    appliesTo: (path) =>
      path === "contract/install-configs.ts" ||
      path === "accounts/service/src/control/parse.ts" ||
      path === "core/api/openapi.ts",
    patterns: [
      /export\s+type\s+InstallConfigVariableInputFormat\s*=\s*["'`]text["'`]\s*\|/,
      /value\s*===\s*["'`]text["'`][\s\S]{0,300}value\s*===\s*["'`]sha256["'`]/,
      /format:\s*\{[\s\S]{0,200}\benum\s*:\s*\[[\s\S]{0,200}["'`]subdomain["'`]/,
    ],
  },
  {
    id: "closed-usage-source-taxonomy",
    message:
      "usage producers are open operator-installed tokens; only the Core-owned runner token is reserved",
    appliesTo: (path) =>
      path === "contract/billing.ts" ||
      path === "core/domains/deploy-control/usage_service.ts" ||
      path === "core/api/openapi.ts",
    patterns: [
      /export\s+type\s+UsageEventSource\s*=\s*["'`]runner["'`]\s*\|/,
      /value\s*===\s*["'`]resource_meter["'`]\s*\|\|\s*value\s*===\s*["'`]manual_adjustment["'`]/,
      /source:\s*\{[\s\S]{0,80}enum:\s*\[\s*["'`]runner["'`]/,
    ],
  },
  {
    id: "hidden-store-admission",
    message:
      "Store visibility is an explicit presentation property; a trust tier must not admit execution or discovery",
    appliesTo: (path) =>
      path === "contract/install-configs.ts" ||
      path.startsWith("accounts/service/src/control/") ||
      path.startsWith("core/domains/capsules/") ||
      path.startsWith("core/api/deploy_control_capsule") ||
      path.startsWith("dashboard/src/"),
    patterns: [/\b(?:TrustLevel|trustLevel)\b/],
  },
  {
    id: "closed-store-taxonomy",
    message:
      "Store kind and surface are open presentation tokens; unknown values must not be collapsed into a built-in taxonomy",
    appliesTo: (path) =>
      path === "dashboard/src/lib/tcs-client.ts" ||
      path === "dashboard/src/views/new/install-helpers.ts",
    patterns: [
      /type\s+TcsListingKind\s*=\s*["']app["']\s*\|/,
      /type\s+TcsListingSurface\s*=\s*["']service["']\s*\|/,
      /if\s*\(kind\s*===\s*["']storage["']\)\s*return/,
      /if\s*\(surface\s*===\s*["']building_block["']\)\s*return/,
    ],
  },
  {
    id: "provider-derived-backup-adapter",
    message:
      "backup producers must be explicitly selected adapters or commands, never provider-derived environment variable names",
    appliesTo: (path) =>
      path === "runner/lib/backup.ts" ||
      path.startsWith("core/domains/backups/"),
    patterns: [
      /\bPROVIDER_SNAPSHOT_COMMAND_ENV(?:_PREFIX)?\b/,
      /\bproviderSnapshotCommandEnvNames\b/,
      /\bprimaryBackupProvider\b/,
      /\b(?:backup|input)\.provider\b/,
    ],
  },
  {
    id: "fixed-interface-delivery",
    message:
      "InterfaceBinding delivery readiness must dispatch through an explicit handler registry, not a fixed type switch",
    appliesTo: (path) => path === "core/domains/interfaces/service.ts",
    patterns: [/\bdeliveryIsImplemented\b/],
  },
  {
    id: "resource-space-workspace-inference",
    message:
      "Resource Shape Space and Stack Workspace are separate namespaces; Interface ownership requires an explicit service-side mapping",
    appliesTo: (path) =>
      path === "core/bootstrap.ts" ||
      path === "core/domains/interfaces/output_resolver.ts",
    patterns: [
      /resource\??\.spaceId\s*={2,3}\s*workspaceId/,
      /workspaceId\s*={2,3}\s*resource\??\.spaceId/,
      /interfaceService\.(?:reconcileResource|markResourceUnknown|markResourceTerminating|retireResource)\(\s*event\.spaceId/,
    ],
  },
  {
    id: "closed-resource-shape-kind",
    message:
      "bundled typed shapes are not a global enum; operator shape tokens require an explicit schema registry and adapter/plugin",
    appliesTo: (path) =>
      path === "contract/resource-shape.ts" ||
      path === "core/domains/resource-shape/resolver.ts" ||
      path === "core/domains/resource-shape/service.ts" ||
      path === "deploy/platform/worker.ts",
    patterns: [
      /export\s+type\s+ResourceShapeKind\s*=\s*BundledResourceShapeKind\b/,
      /RESOURCE_SHAPE_KINDS[^\n]*\.includes\([^\n]*(?:resource\.kind|shape)/,
      /parseCapabilityList\(\s*env\.TAKOSUMI_RESOURCE_SHAPES\s*,\s*RESOURCE_CAPABILITY_KEYS\s*\)/,
    ],
  },
  {
    id: "closed-resource-capability-taxonomy",
    message:
      "Resource connection, projection, manager, and engine values are open capability tokens whose execution requires explicit Target evidence",
    appliesTo: (path) =>
      path === "contract/resource-shape.ts" ||
      path === "core/domains/resource-shape/planner.ts" ||
      path === "core/domains/resource-shape/resolver.ts" ||
      path === "provider/internal/provider/resource_connection.go" ||
      path === "provider/internal/provider/service_shape_resources.go",
    patterns: [
      /type\s+ResourceManagedBy\s*=\s*["']opentofu["']\s*\|/,
      /\bRESOURCE_(?:CONNECTION_PERMISSIONS|PROJECTION_KINDS)\b/,
      /\bSHAPE_INTERFACE_REQUIREMENTS\b/,
      /StringOneOf\(\s*["']sqlite["']\s*,\s*["']postgres["']\s*,\s*["']mysql["']\s*\)/,
      /SetStringsOneOf\(\s*1\s*,\s*["']read["']/,
      /engine\s*===?\s*["']postgres["']\s*\?\s*["']postgres_protocol["']/,
    ],
  },
  {
    id: "closed-condition-reason-taxonomy",
    message:
      "Condition.reason is an open adapter-extensible token; OpenAPI must not expose the Core reason catalog as a closed enum",
    appliesTo: (path) => path === "core/api/openapi.ts",
    patterns: [
      /reason:\s*\{\s*\$ref:\s*["'`]#\/components\/schemas\/CoreConditionReason["'`]/,
      /CoreConditionReason:\s*\{[\s\S]{0,160}\benum\s*:/,
    ],
  },
  {
    id: "retired-resource-descriptor-alias",
    message:
      "the canonical operator implementation record is TargetImplementationDescriptor; pre-v1 compatibility aliases must not remain active",
    appliesTo: (path) =>
      path === "contract/target.ts" || path.startsWith("provider/internal/"),
    patterns: [/\bTargetPoolImplementation\b/, /\bTargetPoolModuleOutput\b/],
  },
  {
    id: "provider-token-catalog-in-resource-core",
    message:
      "Resource Shape secret guards must be provider-neutral; provider token formats belong to Credential/Adapter validation",
    appliesTo: (path) => path.startsWith("core/domains/resource-shape/"),
    patterns: [
      /github_pat_/,
      /gh\[pousr\]/,
      /xox\[baprs\]/,
      /AKIA\[0-9A-Z\]/,
      /ASIA\[0-9A-Z\]/,
      /sk-\[A-Za-z0-9_/,
    ],
  },
  {
    id: "duplicate-provider-token-redaction-catalog",
    message:
      "Core and shared clients must use the canonical redaction contract; provider token signatures must not be duplicated into feature-specific policy or UI code",
    appliesTo: (path) =>
      (path.startsWith("core/") ||
        path.startsWith("accounts/") ||
        path.startsWith("dashboard/src/") ||
        path.startsWith("deploy/node-postgres/")) &&
      path !== "contract/redaction.ts" &&
      !path.startsWith("core/domains/resource-shape/"),
    patterns: [
      /github_pat_/,
      /gh\[pousr\]/,
      /xox\[baprs\]/,
      /\bAKIA\b/,
      /\bASIA\b/,
      /\bglpat\b/,
    ],
  },
  {
    id: "embedded-audit-backend",
    message:
      "the audit domain owns a generic append-only sink port; S3 configuration and implementation belong to an adapter",
    appliesTo: (path) => path.startsWith("core/domains/audit-replication/"),
    patterns: [
      /\bS3ImmutableLog(?:Port|ReplicationSink)\b/,
      /\bTAKOSUMI_AUDIT_REPLICATION_(?:KIND|S3_[A-Z0-9_]+)\b/,
    ],
  },
  {
    id: "ambiguous-observability-scope",
    message:
      "observability contracts must identify Stack Workspace/RunGroup explicitly; Resource Shape Space is a separate namespace and physical SQL names stay adapter-private",
    appliesTo: (path) =>
      path.startsWith("core/domains/audit/") ||
      path.startsWith("core/domains/observability/") ||
      path === "core/api/metrics_routes.ts",
    patterns: [
      /\b(?:spaceId|groupId)\b/,
      /takosumi\.(?:space_id|group_id)\b/,
      /\bspace_id\s*:\s*["'`](?!none)/,
    ],
  },
  {
    id: "dashboard-provider-catalog",
    message:
      "provider setup presentation must come from service-side Credential Recipe descriptors, not a dashboard-owned provider catalog",
    appliesTo: (path) =>
      path === "dashboard/src/views/account/lib/connections.ts",
    patterns: [
      /\bconst\s+(?:PROVIDERS|[A-Z0-9_]+_(?:CONSOLE|CREATE_KEY|TOKEN)_URL)\b/,
      /https:\/\/(?:developers\.cloudflare\.com|console\.aws\.amazon\.com|console\.cloud\.google\.com|console\.hetzner\.cloud)\//,
    ],
  },
  {
    id: "fixed-forge-placeholder",
    message:
      "Git source examples must remain forge-neutral unless the user selected a forge-specific helper",
    appliesTo: (path) => path.startsWith("dashboard/src/views/new/"),
    patterns: [/https:\/\/github\.com\/your-name\//i],
  },
  {
    id: "fixed-upstream-provider",
    message:
      "Accounts upstream identity providers must be explicit open descriptors, not fixed Google/OIDC environment slots",
    appliesTo: (path) =>
      path.startsWith("accounts/") ||
      path.startsWith("cli/") ||
      path.startsWith("deploy/"),
    patterns: [/\bTAKOSUMI_ACCOUNTS_UPSTREAM_(?:GOOGLE|OIDC)_[A-Z0-9_]+\b/],
  },
  {
    id: "commercial-billing-in-oss",
    message:
      "OSS owns disabled/showback and extension ports only; payment processors, price books, and managed-capacity implementation belong to the Cloud extension",
    appliesTo: isImplementationPath,
    patterns: [
      /(?:\bstripe(?:\b|_)|stripe[A-Z]|_stripe_)/i,
      /\b(?:publicBillingPlans|workers_for_platforms|dispatch_namespace)\b/,
      /\bWorkersForPlatforms\w*\b/,
      /\bTAKOSUMI_CLOUD_[A-Z0-9_]+\b/,
      /\btakosumi-cloud-[a-z0-9-]+\b/i,
      /\/api\/v1\/billing\/plans\b/,
    ],
  },
  {
    id: "commercial-readiness-schema-in-oss",
    message:
      "OSS platform readiness contains only generic Operator requirements; hosted SKU, billing, entitlement, support/SLA, and customer-operation schemas must arrive through a readiness contribution",
    appliesTo: (path) =>
      path === "cli/src/cli-platform-readiness-constants.ts" ||
      path === "cli/src/cli-platform-readiness.ts",
    patterns: [
      /\b(?:sku|billingMeterRef|supportTier|supportSlaRef|freeTrialPolicyRef|betaScopeRef)\b/,
      /["'`](?:billing-support-runbook|billing-faq|entitlement-event|terms-acceptance|spend-cap|llm-tool-usage-cap|abuse-queue-review|customer-operations|billing-entitlement|billing-operation)["'`]/,
      /\bstripe(?:[A-Z]|_)/i,
    ],
  },
  {
    id: "readiness-schema-name-inference",
    message:
      "readiness validation and templates must consume explicit evidence schema rules, never infer semantics from field suffixes or evidence type tokens",
    appliesTo: (path) => path === "cli/src/cli-platform-readiness.ts",
    patterns: [
      /\.endsWith\(\s*["'`](?:Digest|Hash|Ref|Url)["'`]\s*\)/,
      /function\s+hasValidStructuredEvidence(?:FieldShape|CrossFieldShape)\b/,
      /switch\s*\(\s*(?:type|entry\.id)\s*\)/,
    ],
  },
  {
    id: "retired-readiness-baseline-vocabulary",
    message:
      "the OSS readiness baseline must use capability-neutral IDs; retired commercial/support names are accepted only by the explicit final-model migration",
    appliesTo: (path) =>
      path === "cli/src/cli-platform-readiness-constants.ts" ||
      path === "cli/src/cli-platform-readiness-definition.ts" ||
      path === "cli/src/cli-platform-readiness.ts",
    patterns: [
      /["'`](?:quota-abuse-spend-control|legal-privacy-support|support-note|vulnerability-sla)["'`]/,
    ],
  },
  {
    id: "fixed-oss-showback-rating",
    message:
      "OSS records measurements and delegates prices to ShowbackRater; fixed runner prices, plan base prices, and action weights belong to explicit host composition",
    appliesTo: (path) =>
      path === "contract/billing.ts" ||
      path === "core/domains/deploy-control/billing_service.ts" ||
      path === "core/domains/deploy-control/run-engine/run_engine.ts",
    patterns: [
      /\b(?:RUNNER_MINUTE_USD_MICROS|PLAN_ESTIMATE_BASE_UNITS)\b/,
      /\b(?:runnerMinuteUsdMicros|estimatePlanUsdMicros|planChangeUnits|planActionUnits)\b/,
      /\b(?:RUNNER|PLAN)[A-Z0-9_]*(?:PRICE|RATE|COST|USD_MICROS|UNITS)\b\s*=\s*[1-9][0-9_]*/,
      /case\s+["'`](?:create|replace|update|delete)["'`]:[\s\S]{0,160}\breturn\s+[1-9][0-9_]*/,
    ],
  },
  {
    id: "commercial-accounts-persistence",
    message:
      "OSS Accounts persists identity/OIDC/PAT/privacy only; provider customer, subscription, payment-event, and rated-usage export state belongs to a commercial host extension",
    appliesTo: (path) => path.startsWith("accounts/service/"),
    patterns: [
      /\bBilling(?:AccountRecord|CancellationRecord|DisputeRecord|WebhookEvent(?:Record|ClaimResult)|Usage(?:Record|ExportMark))\b/,
      /\b(?:save|find|claim|list|mark)Billing(?:Account|WebhookEvent|UsageRecord|UsageRecordsForCapsule|UsageRecordsForBillingAccount|UsageRecordsExported)\b/,
      /\b(?:providerCustomerId|providerSubscriptionId|providerPriceId|providerDefaultPaymentMethodId|lastInvoiceId|dunningStartedAt|nextPaymentAttemptUnix|dunningAttemptCount|dunningAction|dunningExhaustedAt|lastCreditEventId|lastCreditKind|lastCreditId|lastCreditAmount|lastCreditCurrency|lastTaxEventId|taxPolicyRef|taxJurisdiction|taxAutomaticStatus|activeDispute|preDisputeStatus)\b/,
      /["'`](?:billing_accounts|billing_webhook_events|billing_usage_records)["'`]/,
    ],
  },
  {
    id: "fixed-commercial-capability-schema",
    message:
      "commercial host functions must use open versioned extension tokens and contributed endpoints, not a fixed OSS commercial/edition capability branch",
    appliesTo: (path) =>
      path === "contract/capabilities.ts" ||
      path === "core/api/openapi.ts" ||
      path === "dashboard/src/lib/runtime-capabilities.ts" ||
      path === "mobile-kit/src/types.ts",
    patterns: [
      /\bTakosumiCommercialCapabilities\b/,
      /\b(?:commercialBilling|paymentEnforcement|operatorTenants)\b/,
      /\bcommercial\s*\??\s*:/,
      /\.commercial\.(?:billing|operator_tenants|payment_enforcement)\b/,
      /\bhasCommercialBillingCapability\b/,
      /readonly\s+(?:billing|operator_tenants)\s*:\s*boolean/,
    ],
  },
  {
    id: "hosted-endpoint-in-shared-client",
    message:
      "shared clients and libraries must receive an explicit operator endpoint; the official hosted deployment is product composition, not a default authority",
    appliesTo: (path) =>
      path.startsWith("mobile-kit/src/") ||
      path.startsWith("contract/") ||
      path.startsWith("core/") ||
      path.startsWith("accounts/") ||
      path.startsWith("dashboard/src/"),
    patterns: [/https:\/\/app\.takosumi\.com(?:\/|["'`])/],
  },
  {
    id: "hosted-environment-inference",
    message:
      "operator environment labels must be explicit and must not be inferred from the official hosted deployment hostname",
    appliesTo: (path) => path === "scripts/smoke-platform-control-plane.ts",
    patterns: [
      /hostname\s*={2,3}\s*["'`]app(?:-staging)?\.takosumi\.com["'`]/,
      /defaultSmokeEnvironment\(/,
    ],
  },
  {
    id: "implicit-provider-smoke-default",
    message:
      "the control-plane smoke must default to providerless OpenTofu and select provider contributions explicitly, never from module paths or InstallConfig ids",
    appliesTo: (path) => path === "scripts/smoke-platform-control-plane.ts",
    patterns: [
      /value\s*===\s*["'`]cloudflare-worker["'`][\s\S]{0,80}return\s+["'`]cloudflare-worker["'`]/,
      /value\s*===\s*["'`]guided["'`][\s\S]{0,80}return\s+["'`]guided["'`]/,
      /defaultSmokeVariableStyle\(/,
      /moduleKey\.includes\(\s*["'`]providers\/cloudflare\//,
      /installConfigId\s*===\s*["'`]cloudflare-(?:hello-worker|worker-service)["'`]/,
      /stringRecordValue\(\s*(?:explicitVars|vars)\s*,\s*["'`](?:appName|name|project_name|worker_name)["'`]\s*\)/,
    ],
  },
  {
    id: "implicit-install-config-selection",
    message:
      "operator smoke tooling must select InstallConfig explicitly or from one unambiguous candidate, never by list order or identifier shape",
    appliesTo: (path) => path === "scripts/smoke-platform-control-plane.ts",
    patterns: [
      /configs\.find\(isSelectableCapsuleInstallConfig\)/,
      /workspaceId\s*!==\s*undefined[\s\S]{0,100}\^icfg_/,
    ],
  },
  {
    id: "production-dev-mode-bypass",
    message:
      "production/staging durability gates must fail closed even when local dev mode is enabled",
    appliesTo: (path) => path === "core/bootstrap.ts",
    patterns: [
      /strict\s*&&\s*!\s*(?:input\.)?allowUnsafeProductionDefaults/,
      /!\s*(?:input\.)?allowUnsafeProductionDefaults\s*&&\s*strict/,
    ],
  },
  {
    id: "retired-fixed-secret-cli",
    message:
      "platform secret storage belongs to the deployment adapter/operator vault; the Takosumi CLI manages Provider Connections",
    appliesTo: (path) =>
      path.startsWith("cli/") || path.startsWith("docs/operations/"),
    patterns: [
      /\btakosumi\s+(?:platform-)?secrets\b/,
      /\bcli-platform-secrets-commands\b/,
    ],
  },
  {
    id: "closed-operator-config-source",
    message:
      "operator configuration is an injected port; its source id must remain an open adapter token",
    appliesTo: (path) => path === "core/adapters/operator-config/types.ts",
    patterns: [
      /type\s+OperatorConfigSource\s*=\s*["']env["']\s*\|\s*["']local["']/,
    ],
  },
  {
    id: "diagnostic-message-inference",
    message:
      "Run and dashboard behavior must use diagnostic codes and structured error reasons, never parse human-readable messages",
    appliesTo: (path) =>
      path === "dashboard/src/views/new/install-helpers.ts" ||
      path === "dashboard/src/views/runs/RunView.tsx" ||
      path === "core/domains/deploy-control/projection.ts" ||
      path === "core/domains/deploy-control/projection_run.ts" ||
      path === "core/domains/deploy-control/run_credential_broker.ts" ||
      path === "core/domains/sources/mod.ts",
    patterns: [
      /diagnostic\.message\s*===/,
      /(?:exec|test)\(\s*diagnostic\.message\s*\)/,
      /(?:exec|test)\(\s*result\.summary\s*\)/,
      /compatibilityCheckLooksTransient[\s\S]{0,800}diagnostic\.message/,
      /(?:exec|test)\([^)]{0,160}apiError\?*\.message/,
      /\b(?:accessIssueFromText|classifiedErrorDiagnostic|compactErrorCode)\b/,
      /\b(?:mapped|error)\.message\.(?:includes|startsWith|endsWith|match|search)\s*\(/,
      /diagnostic\.(?:message|detail)[\s\S]{0,160}\.(?:includes|startsWith|endsWith|match|search)\s*\(/,
      /errorCode\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*Message\b/,
    ],
  },
  {
    id: "structured-code-prefix-inference",
    message:
      "behavior must use an exact structured discriminant or contribution contract, never infer semantics from an error, diagnostic, finding, or status prefix",
    appliesTo: (path) =>
      path.startsWith("contract/") ||
      path.startsWith("core/") ||
      path.startsWith("accounts/") ||
      path.startsWith("dashboard/src/") ||
      path.startsWith("mobile-kit/") ||
      path.startsWith("cli/"),
    patterns: [
      /\b(?:errorCode|findingCode|diagnosticCode)\s*\??\.\s*(?:startsWith|endsWith|includes|match|search)\s*\(/,
      /\b(?:finding|diagnostic|resolution|run)\.(?:code|errorCode|status)\s*\??\.\s*(?:startsWith|endsWith|includes|match|search)\s*\(/,
    ],
  },
  {
    id: "silent-legacy-request-normalization",
    message:
      "current request boundaries must reject conflicting authorities instead of silently dropping legacy discriminator fields",
    appliesTo: (path) => path.startsWith("core/api/"),
    patterns: [/\{\s*kind:\s*_legacyKind\s*,\s*\.\.\./],
  },
  {
    id: "retired-provider-delivery-alias",
    message:
      "CredentialRecipe is provider delivery authority; retired fixed delivery-mode aliases must not remain in the current contract",
    appliesTo: (path) =>
      path === "contract/connections.ts" ||
      path === "contract/provider-resolution.ts",
    patterns: [
      /\bPROVIDER_DELIVERY_MODES\b/,
      /\bProviderDeliveryMode\b/,
      /\bisProviderDeliveryMode\b/,
      /\bPROVIDER_CONNECTION_MATERIALIZATIONS\b/,
    ],
  },
  {
    id: "control-error-message-inference",
    message:
      "control behavior must use error codes and details.reason, never parse human-readable error messages",
    appliesTo: (path) =>
      path === "accounts/service/src/control/shared.ts" ||
      path === "accounts/service/src/control/capsules.ts" ||
      path === "core/api/deploy_control_shared.ts" ||
      path === "dashboard/src/lib/control-api.ts" ||
      path === "scripts/smoke-platform-control-plane.ts",
    patterns: [
      /(?:this\.)?message\.(?:includes|startsWith|endsWith|match|search)\s*\(/,
      /\.test\(\s*(?:this\.)?message\s*\)/,
      /(?:this\.)?message\s*(?:===|!==|==|!=)\s*["'`]/,
      /["'`][^"'`]*["'`]\s*(?:===|!==|==|!=)\s*(?:this\.)?message\b/,
    ],
  },
];

export function findGeneralizationBoundaryViolations(
  sources: readonly GeneralizationBoundarySource[],
): readonly GeneralizationBoundaryViolation[] {
  const violations: GeneralizationBoundaryViolation[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const path = normalizePath(source.path);
    for (const rule of RULES) {
      if (!rule.appliesTo(path)) continue;
      for (const pattern of rule.patterns) {
        const regex = new RegExp(
          pattern.source,
          pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
        );
        for (const match of source.content.matchAll(regex)) {
          const index = match.index ?? 0;
          const line = lineNumberAt(source.content, index);
          if (
            isAllowedResourceShapeSpaceLocation(
              rule.id,
              path,
              source.content,
              index,
            )
          ) {
            continue;
          }
          if (isAllowedHistoryLocation(path, source.content, index)) continue;
          const key = `${rule.id}\0${path}\0${line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          violations.push({
            ruleId: rule.id,
            path,
            line,
            message: rule.message,
            excerpt: lineAt(source.content, line).trim(),
          });
        }
      }
    }
  }
  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

/**
 * `Space` is retired only in the source-and-run model. Resource Shape has a
 * canonical Space namespace, including a few mixed composition/UI files that
 * cannot be excluded as whole paths without hiding genuine stack regressions.
 * Keep those exceptions bounded by existing section/function markers.
 */
function isAllowedResourceShapeSpaceLocation(
  ruleId: string,
  path: string,
  content: string,
  index: number,
): boolean {
  if (
    ruleId !== "retired-stack-alias" &&
    ruleId !== "retired-stack-request-alias"
  ) {
    return false;
  }

  if (
    ruleId === "retired-stack-alias" &&
    startsWithAny(path, RESOURCE_SHAPE_PATHS)
  ) {
    return true;
  }

  if (
    ruleId === "retired-stack-alias" &&
    (path === "dashboard/src/i18n/en.ts" || path === "dashboard/src/i18n/ja.ts")
  ) {
    return isBetweenMarkers(
      content,
      index,
      "// --- Resource Shape",
      "// --- account",
    );
  }

  if (
    ruleId === "retired-stack-alias" &&
    path === "dashboard/src/lib/control-api.ts"
  ) {
    return isBetweenMarkers(
      content,
      index,
      "// --- Resource Shape API",
      "// Helpers shared by the control views",
    );
  }

  if (path !== "deploy/platform/worker.ts") return false;

  if (
    ruleId === "retired-stack-alias" &&
    isBetweenMarkers(
      content,
      index,
      "async function platformResourceShapeExternalRequest(",
      "function platformInterfaceAccessFailure(",
    )
  ) {
    return true;
  }

  if (
    ruleId === "retired-stack-request-alias" &&
    isBetweenMarkers(
      content,
      index,
      "export function createPlatformCanonicalResourceReadAuthority(",
      "async function resolveReadyCompatibilityEvidence(",
    )
  ) {
    return true;
  }

  return isBetweenMarkers(
    content,
    index,
    "function platformResourceShapeRequestedSpaces(",
    "function platformResourceShapeActorContext(",
  );
}

function isBetweenMarkers(
  content: string,
  index: number,
  startMarker: string,
  endMarker: string,
): boolean {
  const start = content.indexOf(startMarker);
  if (start < 0 || index < start) return false;
  const end = content.indexOf(endMarker, start + startMarker.length);
  return end >= 0 && index < end;
}

function isImplementationPath(path: string): boolean {
  return startsWithAny(path, IMPLEMENTATION_ROOTS);
}

function isAllowedHistoryLocation(
  path: string,
  content: string,
  index: number,
): boolean {
  if (path.includes("/migrations/")) return true;
  if (path === "core/adapters/storage/migrations.ts") return true;
  if (path === "cli/src/cli-platform-readiness.ts") {
    const migrationStart = content.indexOf(
      "// Immutable pre-v1 evidence-document migration begins.",
    );
    const migrationEnd = content.indexOf(
      "// Immutable pre-v1 evidence-document migration ends.",
    );
    if (
      migrationStart >= 0 &&
      migrationEnd > migrationStart &&
      index >= migrationStart &&
      index < migrationEnd
    ) {
      return true;
    }
  }
  if (path === "cli/src/cli-accounts-db.ts") {
    const migrationStart = content.indexOf(
      "// Immutable account-plane schema migration catalog begins.",
    );
    const migrationEnd = content.indexOf(
      "// Immutable account-plane schema migration catalog ends.",
    );
    if (
      migrationStart >= 0 &&
      migrationEnd > migrationStart &&
      index >= migrationStart &&
      index < migrationEnd
    ) {
      return true;
    }
  }
  // This file embeds immutable historical SQL after the live store. Use the
  // catalog marker rather than a line number so ordinary edits cannot widen or
  // narrow the exception accidentally.
  if (path === "worker/src/d1_opentofu_store.ts") {
    const migrationCatalog = content.indexOf(
      "const D1_OPEN_TOFU_SCHEMA_MIGRATIONS",
    );
    if (migrationCatalog >= 0 && index >= migrationCatalog) return true;
  }
  return false;
}

function startsWithAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function lineAt(content: string, line: number): string {
  return content.split(/\r?\n/)[line - 1] ?? "";
}
