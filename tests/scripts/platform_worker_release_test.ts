import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PlatformCommandError,
  assertConfigTargetsSource,
  assertPlatformRunnerImageProof,
  assertPlatformWorkerCodeVersionMatchesConfig,
  assertPlatformWorkerStatusVersion,
  assertPublishedVersion,
  bindingNames,
  dashboardAssetTreeSeal,
  hasHostedDiscovery,
  injectPlatformExecutionEvidencePins,
  matchesHostedRenewableEnvDescriptor,
  inspectPlatformWorkerStatus,
  parsePlatformWorkerReleaseArgs,
  parsePlatformContainerDetail,
  parseServingVersion,
  platformCommandFailureDiagnostic,
  platformDashboardBuildEnvironment,
  platformExecutionEvidenceReleasePins,
  platformNativeEnvelope,
  platformTargetForEnvironment,
  readPlatformWorkerCodeTopology,
  readPlatformContainer,
  remoteBranchContainsCommit,
  runPlatformWorkerApiKeyActivation,
  runPlatformWorkerHostedAuthMaintenanceActivation,
  runPlatformWorkerCodeRelease,
  runPlatformWorkerLoginAdmissionRelease,
  selectRecoveredVersion,
  secretNames,
  type PlatformReleaseCommand,
  waitForPlatformContainerReadback,
  withPlatformForwardContainerPreflight,
} from "../../scripts/platform-worker-release.ts";
import { verifyPlatformLoginStart } from "../../scripts/platform-login-admission.ts";
import { platformReleaseSourceAuthorityDigest } from "../../scripts/lib/platform-release-source.ts";
import { runRunnerImageRelease } from "../../scripts/runner-image-release.ts";
import { platformExtensionRoutes } from "../../deploy/platform/platform_extensions.ts";
import { capsulePublicOriginFromPlatformExtensions, platformExtensionProviderCredentialComposition } from "../../deploy/platform/platform_extension_provider_credentials.ts";
import {
  REFERENCE_CREDENTIAL_RECIPES,
  REFERENCE_PROVIDER_RENEWABLE_ENV_CAPABILITIES,
} from "../../providers/credential-recipes.generated.ts";

const root = resolve(import.meta.dir, "../..");
const PROVED_RUNNER_IMAGE =
  `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`;

const STATUS_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const STATUS_CONTAINER_ID = "22222222-2222-4222-8222-222222222222";
const STATUS_CONTAINER_IMAGE =
  `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`;

function statusConfigSource(image = STATUS_CONTAINER_IMAGE): string {
  const broker = {
    connectionId: "conn_takoserverTakoform01",
    recipeId: "takoserver-takoform-run-v1",
    providerSource: "registry.terraform.io/tako0614/takoform",
    displayName: "Takoserver",
    exchangePath: "/provider-credentials/takoform",
    envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
    runCredentialSettings: { requiredAvailableMinor: 2300 },
    publicInputExchangePath: "/public-inputs/http-endpoint",
    publicInputCapabilities: ["http_endpoint_url"],
    runtimeInputs: {
      contract: "takosumi.provider-runtime-inputs/v1",
      nonceArgument: "runtime_input_nonce",
      mapArgument: "runtime_inputs",
      minimumProviderVersion: "4.0.0",
    },
  };
  const extensions = [
    {
      id: "takosumi-hosted-sponsorship",
      basePath: "/api/v1/account/subscription",
      handlerKey: "HOSTED",
      authDelivery: "context",
      ownsPathSubtree: true,
      workspaceContext: "query-required",
      runCredential: {
        audience: "takosumi-hosted.takoform.v1",
        requiredScopes: ["takoform.run"],
      },
      providerCredentialBroker: broker,
    },
    {
      id: "takosumi-ai",
      basePath: "/api/v1/ai",
      handlerKey: "HOSTED",
      authDelivery: "context",
      ownsPathSubtree: true,
      workspaceContext: "query-optional",
      selfServicePatScopes: ["ai.models.read", "ai.chat"],
      requestScopeRules: [
        {
          path: "/models",
          methods: ["GET"],
          requiredScopes: ["ai.models.read"],
        },
        {
          path: "/chat/completions",
          methods: ["POST"],
          requiredScopes: ["ai.chat"],
        },
      ],
      capabilities: ["openai.models.v1", "openai.chat-completions.v1"],
    },
  ];
  return [
    'name = "takosumi-staging"',
    'compatibility_flags = ["nodejs_compat", "enable_request_signal"]',
    "[assets]",
    'binding = "ASSETS"',
    "[version_metadata]",
    'binding = "TAKOSUMI_VERSION_METADATA"',
    "[[services]]",
    'binding = "HOSTED"',
    'service = "takosumi-hosted-staging"',
    "[vars]",
    'TAKOSUMI_ENVIRONMENT = "staging"',
    `TAKOSUMI_PLATFORM_EXTENSIONS = '${JSON.stringify(extensions)}'`,
    "[[containers]]",
    'class_name = "OpenTofuRunnerObject"',
    `image = ${JSON.stringify(image)}`,
    "",
  ].join("\n");
}

function statusVersionSource(
  versionId = STATUS_VERSION_ID,
  hostedService = "takosumi-hosted-staging",
  bindings: readonly Readonly<Record<string, unknown>>[] = [
    { name: "ASSETS", type: "assets" },
    { name: "TAKOSUMI_ACCOUNTS_DB", type: "d1" },
    { name: "TAKOSUMI_CONTROL_DB", type: "d1" },
    { name: "HOSTED", type: "service", service: hostedService },
    { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" },
    {
      name: "TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY",
      type: "secret_text",
    },
  ],
): string {
  return JSON.stringify({
    id: versionId,
    resources: {
      script: { handlers: ["fetch"] },
      bindings,
    },
  });
}

function statusContainerSource(options: {
  readonly state?: string;
  readonly image?: string;
  readonly failed?: number;
  readonly starting?: number;
  readonly scheduling?: number;
  readonly version?: number;
  readonly activeRolloutId?: string | null;
} = {}) {
  const image = options.image ?? STATUS_CONTAINER_IMAGE;
  const summary = {
    id: STATUS_CONTAINER_ID,
    name: "takosumi-staging-opentofurunnerobject",
    state: options.state ?? "ready",
    image,
    version: options.version ?? 4,
  };
  const detail = {
    ...summary,
    configuration: { image },
    active_rollout_id: options.activeRolloutId ?? null,
    health: {
      instances: {
        failed: options.failed ?? 0,
        starting: options.starting ?? 0,
        scheduling: options.scheduling ?? 0,
      },
      errors: [],
    },
  };
  return { summary, detail };
}

function containerReadbackConfig(image: string): { path: string; dispose: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "takosumi-platform-container-readback-"));
  const path = join(directory, "wrangler.toml");
  const accountId = /^registry\.cloudflare\.com\/([0-9a-f]{32})\//u.exec(image)?.[1];
  if (!accountId) throw new Error("test runner image account id missing");
  writeFileSync(
    path,
    `name = "takosumi-platform-staging"\naccount_id = "${accountId}"\n\n[[containers]]\nclass_name = "OpenTofuRunnerObject"\nimage = "${image}"\n`,
    { mode: 0o600 },
  );
  return { path, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const CODE_PREDECESSOR_ID = "33333333-3333-4333-8333-333333333333";
const CODE_DEPLOYED_ID = "44444444-4444-4444-8444-444444444444";
const CODE_BUNDLE = new TextEncoder().encode("export default { fetch() {} };\n");
const CODE_SECRETS = ["TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY"] as const;

function codeConfigSource(): string {
  return statusConfigSource()
    .replace(
      'name = "takosumi-staging"\ncompatibility_flags = ["nodejs_compat", "enable_request_signal"]',
      [
        'name = "takosumi-staging"',
        'compatibility_date = "2026-04-01"',
        'compatibility_flags = ["nodejs_compat", "enable_request_signal"]',
        "workers_dev = true",
        "preview_urls = false",
        'routes = [{ pattern = "app-staging.takosumi.com", custom_domain = true }]',
        "[triggers]",
        'crons = ["* * * * *", "*/5 * * * *"]',
        "[observability]",
        "enabled = true",
        "head_sampling_rate = 1",
        "[observability.logs]",
        "enabled = true",
        "head_sampling_rate = 1",
        "persist = true",
        "invocation_logs = true",
        "[observability.traces]",
        "enabled = false",
        "persist = true",
        "head_sampling_rate = 1",
      ].join("\n"),
    )
    .replace(
      '[assets]\nbinding = "ASSETS"',
      [
        "[assets]",
        'binding = "ASSETS"',
        'not_found_handling = "single-page-application"',
        "run_worker_first = true",
      ].join("\n"),
    )
    .concat(
      [
        "[[d1_databases]]",
        'binding = "TAKOSUMI_ACCOUNTS_DB"',
        'database_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
        'database_name = "human-label-only"',
        "[[d1_databases]]",
        'binding = "TAKOSUMI_CONTROL_DB"',
        'database_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"',
        'database_name = "another-human-label"',
        "[[r2_buckets]]",
        'binding = "R2_STATE"',
        'bucket_name = "state-fixture"',
        "[durable_objects]",
        "[[durable_objects.bindings]]",
        'name = "COORDINATION"',
        'class_name = "CoordinationObject"',
        "[[durable_objects.bindings]]",
        'name = "RUN_OWNER"',
        'class_name = "OpenTofuRunOwnerObject"',
        "[[durable_objects.bindings]]",
        'name = "RUNNER"',
        'class_name = "OpenTofuRunnerObject"',
        "[[migrations]]",
        'tag = "v9"',
        'new_sqlite_classes = ["CoordinationObject", "OpenTofuRunOwnerObject", "OpenTofuRunnerObject"]',
        "",
      ].join("\n"),
    );
}

function codeVersionSource(
  configSource: string,
  versionId: string,
  annotations: Readonly<{ tag: string; message: string }>,
): string {
  const config = Bun.TOML.parse(configSource) as Record<string, any>;
  const bindings: Record<string, unknown>[] = [
    { name: config.assets.binding, type: "assets" },
    ...config.d1_databases.map((value: any) => ({
      name: value.binding,
      database_id: value.database_id,
      id: value.database_id,
      type: "d1",
    })),
    ...config.durable_objects.bindings.map((value: any, index: number) => ({
      name: value.name,
      class_name: value.class_name,
      namespace_id: String(index + 1).repeat(32),
      type: "durable_object_namespace",
    })),
    { name: "HOSTED", environment: "production", service: "takosumi-hosted-staging", type: "service" },
    ...config.r2_buckets.map((value: any) => ({
      name: value.binding,
      bucket_name: value.bucket_name,
      type: "r2_bucket",
    })),
    ...Object.entries(config.vars).map(([name, text]) => ({
      name,
      text,
      type: "plain_text",
    })),
    { name: "TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY", type: "secret_text" },
    { name: config.version_metadata.binding, type: "version_metadata" },
  ];
  for (const name of [
    "TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST",
    "TAKOSUMI_RUNNER_ARTIFACT_DIGEST",
    "TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST",
  ]) {
    if (!Object.hasOwn(config.vars, name)) {
      bindings.push({ name, text: `sha256:${"9".repeat(64)}`, type: "plain_text" });
    }
  }
  return JSON.stringify({
    id: versionId,
    number: 9,
    metadata: {},
    annotations: {
      "workers/message": annotations.message,
      "workers/tag": annotations.tag,
      "workers/triggered_by": "upload",
    },
    resources: {
      script: {
        etag: "e".repeat(64),
        handlers: ["fetch", "scheduled"],
        named_handlers: [
          { name: "CoordinationObject", handlers: ["class"] },
          { name: "OpenTofuRunOwnerObject", handlers: ["class"] },
          { name: "OpenTofuRunnerObject", handlers: ["class"] },
        ],
        last_deployed_from: "wrangler",
      },
      script_runtime: {
        migration_tag: "v9",
        assets: {
          not_found_handling: "single-page-application",
          serve_directly: false,
          raw_run_worker_first: true,
        },
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat", "enable_request_signal"],
        usage_model: "standard",
        containers: [{ class_name: "OpenTofuRunnerObject" }],
      },
      bindings,
    },
  });
}

const CODE_LEGACY_ROUTE = {
  id: "42357ba815864e1d9af2da8ac4a157c0",
  pattern: "*.edge-staging.takos.jp/*",
  script: "takosumi-staging",
  request_limit_fail_open: false,
} as const;

type CodeRouteDrift = "id" | "add" | "remove" | "pattern" | "fail-open";

function codeRoutes(drift?: CodeRouteDrift): readonly Record<string, unknown>[] {
  const current: {
    id: string;
    pattern: string;
    script: string;
    request_limit_fail_open: boolean;
  } = { ...CODE_LEGACY_ROUTE };
  if (drift === "id") current.id = "5".repeat(32);
  if (drift === "pattern") current.pattern = "*.changed-staging.takos.jp/*";
  if (drift === "fail-open") current.request_limit_fail_open = true;
  if (drift === "remove") return [];
  if (drift === "add") {
    return [
      current,
      {
        ...CODE_LEGACY_ROUTE,
        id: "6".repeat(32),
        pattern: "added.edge-staging.takos.jp/*",
      },
    ];
  }
  return [current];
}

// A Container-bearing Worker's `/workers/scripts` entry carries the Durable
// Object classes its Container is attached to. The 2026-10-11 staging readback
// of `takosumi-staging` listed exactly the keys below, `containers` included as
// a one-element array; the element is the same `{ class_name }` attachment the
// Version's `script_runtime.containers` carries.
const CODE_SCRIPT_CONTAINERS = [{ class_name: "OpenTofuRunnerObject" }] as const;

function codeNativeRead(
  configSource: string,
  options: {
    readonly routes?: readonly Readonly<Record<string, unknown>>[];
    readonly unknownSetting?: boolean;
    readonly cronDrift?: boolean;
    readonly domainDrift?: boolean;
    readonly scriptContainers?: unknown;
    readonly omitScriptContainers?: boolean;
  } = {},
) {
  const config = Bun.TOML.parse(configSource) as Record<string, any>;
  const observability = {
    enabled: true,
    head_sampling_rate: 1,
    redact_query_string: false,
    logs: config.observability.logs,
    traces: config.observability.traces,
  };
  const settings: Record<string, unknown> = {
    logpush: false,
    tags: null,
    tail_consumers: null,
    observability,
  };
  if (options.unknownSetting) settings.future_setting = true;
  const values = new Map<string, { result: unknown; resultInfo: unknown }>([
    ["/workers/scripts", {
      result: [{
        created_on: "2026-01-01T00:00:00Z",
        modified_on: "2026-01-02T00:00:00Z",
        id: "takosumi-staging",
        tag: null,
        deployment_id: "deployment-fixture",
        has_assets: true,
        has_modules: true,
        etag: "etag-fixture",
        handlers: ["fetch", "scheduled"],
        named_handlers: [],
        last_deployed_from: "wrangler",
        routes: options.routes ?? codeRoutes(),
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat", "enable_request_signal"],
        migration_tag: "v9",
        usage_model: "standard",
        logpush: false,
        tags: [],
        tail_consumers: null,
        observability,
        ...(options.omitScriptContainers
          ? {}
          : {
            containers: structuredClone(
              options.scriptContainers === undefined
                ? CODE_SCRIPT_CONTAINERS
                : options.scriptContainers,
            ),
          }),
      }],
      resultInfo: null,
    }],
    ["/workers/scripts/takosumi-staging/script-settings", { result: settings, resultInfo: null }],
    ["/workers/scripts/takosumi-staging/subdomain", {
      result: { enabled: true, previews_enabled: false },
      resultInfo: null,
    }],
    ["/workers/scripts/takosumi-staging/schedules", {
      result: { schedules: [
        ...config.triggers.crons,
        ...(options.cronDrift ? ["0 0 * * *"] : []),
      ].map((cron: string) => ({
        cron,
        created_on: "2026-01-01T00:00:00Z",
        modified_on: "2026-01-02T00:00:00Z",
      })) },
      resultInfo: null,
    }],
    ["/workers/domains?service=takosumi-staging&environment=production", {
      result: [{
        id: "domain",
        zone_id: "zone",
        zone_name: "takosumi.com",
        hostname: options.domainDrift
          ? "changed-staging.takosumi.com"
          : "app-staging.takosumi.com",
        service: "takosumi-staging",
        environment: "production",
        cert_id: "cert",
        previews_enabled: false,
        enabled: true,
      }],
      resultInfo: { page: 1, per_page: 1, count: 1, total_count: 1 },
    }],
  ]);
  return async (path: string) => {
    const value = values.get(path);
    if (!value) throw new Error(`unexpected native path: ${path}`);
    return structuredClone(value);
  };
}

async function exerciseCodeLane(options: {
  readonly startupRunner?: readonly NonNullable<Parameters<typeof statusContainerSource>[0]>[];
  readonly startupConfigChanges?: boolean;
  readonly topologyDriftAt?: number;
  readonly routeDrift?: CodeRouteDrift;
  readonly containerDrift?: boolean;
  readonly containerFailsAfterUpload?: boolean;
  readonly containerFailsAfterActivation?: boolean;
  readonly uploadFails?: boolean;
  readonly scopedGateFails?: boolean;
  readonly uploadReadbackFails?: boolean;
  readonly candidateReadFailures?: number;
  readonly candidateReadErrorCode?: number;
  readonly activationFails?: boolean;
  readonly postActivationVersions?: readonly string[];
  readonly postActivationCandidateReadFailures?: number;
  readonly resume?: "valid" | "wrong-tag" | "wrong-digest" | "wrong-version" | "wrong-predecessor" | "already-serving" | "unhealthy" | "source-drift";
  readonly confirm?: "valid" | "wrong-tag" | "wrong-digest" | "wrong-pins" | "not-serving" | "serving-drift";
  readonly loginAdmission?: "transition" | "normal" | "missing" | "partial" | "already-present";
  readonly apiKeys?: "transition" | "routine" | "wrong-predecessor" | "wrong-entry" | "wrong-dashboard" |
    "issuer-changed" | "issuer-split" | "issuer-changed-after-upload" | "product-changed-after-upload" |
    "workspace-assets-changed" | "unserved-secret-version" | "intervening-secret-version";
  readonly hostedMaintenance?: "transition" | "routine" | "wrong-flag" | "missing-cron" |
    "already-present" | "predecessor-secret" | "wrong-entry" | "wrong-dashboard" | "changed-bundle" | "bundle-changed-before-upload" |
    "dependency-changed" | "dependency-split" | "dependency-malformed" | "dependency-changed-before-upload" |
    "dependency-changed-after-upload" | "dependency-changed-after-activation" |
    "unserved-secret-version" | "intervening-secret-version" |
    "late-secret-version-before-upload" | "late-secret-version-before-activation";
  readonly hostedHistoryCustodyDrift?: "config" | "assets" | "bundle";
  readonly loginSmokeFails?: boolean;
  readonly unrelatedBindingDrift?: boolean;
  readonly bindingReplacedBySecret?: string;
  readonly codeSource?: "clean" | "dirty" | "hidden-index-change" | "file-mode-change" | "during-build" | "after-activation";
  readonly verifyRunner?: "ready" | "wrong-source" | "wrong-tag" | "missing-provenance" | "serving-drift";
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "takosumi-code-lane-test-"));
  const configPath = join(directory, "wrangler.toml");
  const maintenance = options.hostedMaintenance;
  const pinnedActivation = options.apiKeys || maintenance;
  const codeRoot = options.codeSource || pinnedActivation ? join(directory, "source") : root;
  const claimPath = join(codeRoot, "source.ts");
  const dashboardPath = join(codeRoot, "dashboard/dist");
  if (pinnedActivation) {
    mkdirSync(dashboardPath, { recursive: true });
    writeFileSync(join(dashboardPath, "index.html"), "sealed dashboard");
  }
  let expectedSourceProvenance: Record<string, string> | undefined;
  if (options.codeSource) {
    mkdirSync(codeRoot);
    writeFileSync(claimPath, "// pinned synthetic source\n");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: codeRoot });
      if (result.exitCode !== 0) throw new Error("synthetic source Git failed");
      return new TextDecoder().decode(result.stdout).trim();
    };
    git("init", "-q");
    if (options.verifyRunner) {
      mkdirSync(join(codeRoot, "runner"));
      mkdirSync(join(codeRoot, "deploy/platform"), { recursive: true });
      mkdirSync(join(codeRoot, "dashboard/dist"), { recursive: true });
      writeFileSync(join(codeRoot, "deploy/platform/entry-worker.ts"), CODE_BUNDLE);
      writeFileSync(join(codeRoot, "runner/Dockerfile"), "FROM scratch\n");
    }
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "-qm", "pin synthetic worker source");
    const pin = {
      kind: "takosumi.platform-release-source@v1",
      repository: "https://github.com/example/takosumi.git",
      commit: git("rev-parse", "HEAD"),
    } as const;
    git("remote", "add", "origin", pin.repository);
    if (options.verifyRunner) git("checkout", "--detach", "-q", pin.commit);
    writeFileSync(join(directory, "wrangler.source.json"), JSON.stringify(pin), { mode: 0o600 });
    expectedSourceProvenance = {
      sourceCommit: pin.commit,
      sourceTree: git("rev-parse", "HEAD^{tree}"),
      sourceAuthoritySha256: platformReleaseSourceAuthorityDigest(pin),
      configSha256: `sha256:${Bun.CryptoHasher.hash("sha256", codeConfigSource(), "hex")}`,
    };
    if (options.codeSource === "hidden-index-change") {
      git("update-index", "--assume-unchanged", "source.ts");
    }
    if (options.codeSource === "dirty" || options.codeSource === "hidden-index-change") {
      writeFileSync(claimPath, "// existing change\n");
    }
    if (options.codeSource === "file-mode-change") {
      git("config", "core.filemode", "false");
      chmodSync(claimPath, 0o755);
    }
  }
  const sharedSource = codeConfigSource().replace("[vars]\n", '[vars]\nTAKOSUMI_SHARED_AUTH_PROFILE = "shared-account"\nTAKOSUMI_SHARED_AUTH_ORIGIN = "https://app-staging.takosumi.com"\n');
  const rateSource = '\n[[ratelimits]]\nname = "HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER"\nnamespace_id = "2026111401"\n[ratelimits.simple]\nlimit = 60\nperiod = 60\n\n[[ratelimits]]\nname = "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER"\nnamespace_id = "2026111402"\n[ratelimits.simple]\nlimit = 10\nperiod = 60\n';
  const apiKeyBaseline = sharedSource.replace("[vars]\n", '[vars]\nTAKOSUMI_ACCOUNTS_ISSUER = "https://app-staging.takosumi.com"\n') + rateSource;
  const apiKeyConfigured = apiKeyBaseline.replace("[vars]\n", '[vars]\nTAKOSUMI_SHARED_AUTH_API_KEYS = "enabled"\n');
  const maintenanceBaseline = maintenance === "missing-cron"
    ? apiKeyConfigured.replace(', "*/5 * * * *"', "") : apiKeyConfigured;
  const maintenanceFlag = "TAKOSUMI_HOSTED_AUTH_MAINTENANCE_ENABLED";
  const source = maintenance
    ? maintenanceBaseline.replace("[vars]\n", `[vars]\n${maintenanceFlag} = "${maintenance === "wrong-flag" ? "0" : "1"}"\n`)
    : options.apiKeys
    ? apiKeyConfigured
    : options.loginAdmission
    ? sharedSource + (options.loginAdmission === "missing" ? "" : rateSource)
    : codeConfigSource();
  writeFileSync(configPath, source, { mode: 0o600 });
  const pins = platformExecutionEvidenceReleasePins(CODE_BUNDLE, STATUS_CONTAINER_IMAGE);
  const finalSource = injectPlatformExecutionEvidencePins(source, pins);
  const tag = `tks-stg-code-${"1".repeat(32)}`;
  const message = `takosumi-platform-staging-code ${pins.controllerArtifactDigest}`;
  const predecessorSource = maintenance
    ? injectPlatformExecutionEvidencePins(maintenance === "already-present" ? source : maintenanceBaseline, pins)
    : options.apiKeys ? injectPlatformExecutionEvidencePins(apiKeyBaseline, pins)
    : options.loginAdmission && options.loginAdmission !== "normal" && options.loginAdmission !== "already-present" ? sharedSource : source;
  const predecessor = JSON.parse(codeVersionSource(predecessorSource, CODE_PREDECESSOR_ID, {
    tag: "predecessor",
    message: "predecessor",
  }));
  const deployed = JSON.parse(codeVersionSource(finalSource, CODE_DEPLOYED_ID, {
    tag,
    message: options.resume === "wrong-digest" ? `takosumi-platform-staging-code sha256:${"0".repeat(64)}` : message,
  }));
  const rateBindings = [
    { name: "HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER", type: "ratelimit", namespace_id: "2026111401", simple: { limit: 60, period: 60 } },
    { name: "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER", type: "ratelimit", namespace_id: "2026111402", simple: { limit: 10, period: 60 } },
  ];
  if (options.confirm === "wrong-pins") {
    const pin = deployed.resources.bindings.find((binding: { name: string }) =>
      binding.name === "TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST"
    );
    if (!pin) throw new Error("test execution pin missing");
    pin.text = `sha256:${"0".repeat(64)}`;
  }
  if (pinnedActivation || (options.loginAdmission && options.loginAdmission !== "missing")) deployed.resources.bindings.push(...rateBindings);
  if (pinnedActivation || options.loginAdmission === "normal" || options.loginAdmission === "already-present") predecessor.resources.bindings.push(...rateBindings);
  if (options.loginAdmission === "partial") predecessor.resources.bindings.push(rateBindings[0]);
  if (options.unrelatedBindingDrift) predecessor.resources.bindings.find((binding: { name: string }) => binding.name === "HOSTED").service = "foreign-service";
  const listedSecrets: string[] = [...CODE_SECRETS];
  if (maintenance === "predecessor-secret") {
    predecessor.resources.bindings.push({ name: maintenanceFlag, type: "secret_text" });
    listedSecrets.push(maintenanceFlag);
  }
  if (options.bindingReplacedBySecret) {
    const name = options.bindingReplacedBySecret;
    for (const version of [predecessor, deployed]) {
      const index = version.resources.bindings.findIndex(
        (binding: { name: string }) => binding.name === name,
      );
      if (index < 0) throw new Error("test binding missing");
      version.resources.bindings[index] = { name, type: "secret_text" };
    }
    listedSecrets.push(name);
  }
  const container = statusContainerSource({ failed: options.resume === "unhealthy" ? 1 : 0 });
  let activated = options.resume === "already-serving" || Boolean(options.confirm && options.confirm !== "not-serving");
  let confirmationReads = 0;
  let uploadCount = 0;
  let activationCount = 0;
  let buildCount = 0;
  let gateCount = 0;
  let sourceCheckCount = 0;
  const operationOrder: string[] = [];
  const readbackWaits: number[] = [];
  const startupWaits: number[] = [];
  let runnerSnapshots = 0;
  const readRunnerSnapshot = () => {
    const states = options.startupRunner;
    return states?.length ? statusContainerSource(states[Math.min(runnerSnapshots, states.length - 1)]) : container;
  };
  const candidateReadWaits: number[] = [];
  const candidateReads: string[] = [];
  let postActivationReadCount = 0;
  let postActivationCandidateReadCount = 0;
  let publicReadbackCount = 0;
  let loginSmokeCount = 0;
  let issuerReadCount = 0;
  const hostedReadPhases: string[] = [];
  let uploadedDashboard: string | undefined;
  let topologySnapshot = 0;
  let uploadArgs: readonly string[] = [];
  let activationArgs: readonly string[] = [];
  let uploadConfigSource = "";
  let activationConfigSource = "";
  let dryRunEntry = "";
  let dryRunAsset = "";
  let lateSecretVersion = false;
  const command: PlatformReleaseCommand = async (argv) => {
    if (argv[1] === "versions" && argv[2] === "upload" && argv.includes("--dry-run")) {
      const output = argv[argv.indexOf("--outdir") + 1]!;
      dryRunEntry = join(output, "index.js");
      writeFileSync(dryRunEntry, maintenance === "changed-bundle" ? "other sealed Worker" : CODE_BUNDLE);
      if (options.hostedHistoryCustodyDrift === "assets") {
        const dryRunConfig = readFileSync(argv[argv.indexOf("--config") + 1]!, "utf8");
        const { assets } = Bun.TOML.parse(dryRunConfig) as { assets: { directory: string } };
        dryRunAsset = join(assets.directory, "index.html");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (argv[1] === "versions" && argv[2] === "upload") {
      uploadCount += 1;
      uploadArgs = argv;
      uploadConfigSource = readFileSync(argv[argv.indexOf("--config") + 1]!, "utf8");
      if (pinnedActivation) {
        const config = Bun.TOML.parse(uploadConfigSource) as { assets: { directory: string } };
        uploadedDashboard = readFileSync(join(config.assets.directory, "index.html"), "utf8");
      }
      if (options.uploadFails) throw new Error("lost upload acknowledgement");
      return {
        exitCode: 0,
        stdout: `Worker Version ID: ${CODE_DEPLOYED_ID}\n`,
        stderr: "",
      };
    }
    if (argv[1] === "versions" && argv[2] === "deploy") {
      operationOrder.push("activate");
      activationCount += 1;
      activationArgs = argv;
      activationConfigSource = readFileSync(
        argv[argv.indexOf("--config") + 1]!,
        "utf8",
      );
      activated = true;
      if (options.activationFails) throw new Error("lost activation acknowledgement");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (argv[1] === "deployments" && argv[2] === "status") {
      operationOrder.push("serving");
      let versionId = activated ? CODE_DEPLOYED_ID : CODE_PREDECESSOR_ID;
      if (!activated && options.apiKeys === "product-changed-after-upload" && issuerReadCount === 3) {
        versionId = STATUS_VERSION_ID;
      }
      if (options.confirm === "serving-drift" && ++confirmationReads > 1) versionId = CODE_PREDECESSOR_ID;
      if (activationCount > 0) {
        versionId = options.postActivationVersions?.[postActivationReadCount] ?? versionId;
        postActivationReadCount++;
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          versions: [{
            version_id: versionId,
            percentage: 100,
          }],
        }),
        stderr: "",
      };
    }
    if (argv[1] === "versions" && argv[2] === "view") {
      if (argv[3] === CODE_DEPLOYED_ID) {
        operationOrder.push("candidate");
        candidateReads.push(argv[3]);
        const shouldFail = activationCount > 0
          ? ++postActivationCandidateReadCount <= (options.postActivationCandidateReadFailures ?? 0)
          : candidateReads.length <= (options.candidateReadFailures ?? 0);
        if (shouldFail) {
          throw new PlatformCommandError(
            argv.slice(0, 4).join(" "),
            1,
            false,
            "",
            `\x1b[31mCloudflare API error [code: ${options.candidateReadErrorCode ?? 100146}]\x1b[0m`,
          );
        }
        if (options.uploadReadbackFails) throw new Error("uploaded Version not visible yet");
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(argv[3] === CODE_PREDECESSOR_ID ? predecessor : deployed),
        stderr: "",
      };
    }
    if (argv[1] === "secret" && argv[2] === "list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(listedSecrets.map((name) => ({ name }))),
        stderr: "",
      };
    }
    if (argv[1] === "containers" && argv[2] === "list") {
      return { exitCode: 0, stdout: JSON.stringify([readRunnerSnapshot().summary]), stderr: "" };
    }
    if (argv[1] === "containers" && argv[2] === "info") {
      const detail = (activated && options.containerFailsAfterActivation) ||
          (uploadCount > 0 && options.containerFailsAfterUpload)
        ? statusContainerSource({ failed: 1 }).detail
        : readRunnerSnapshot().detail;
      runnerSnapshots += 1;
      return { exitCode: 0, stdout: JSON.stringify(detail), stderr: "" };
    }
    throw new Error(`unexpected command: ${argv.slice(1).join(" ")}`);
  };
  const cleanNativeRead = codeNativeRead(source);
  const resultLines: string[] = [];
  const write = process.stdout.write;
  const stdout = spyOn(process.stdout, "write").mockImplementation((...args) => {
    const [chunk] = args;
    if (typeof chunk === "string" && chunk.startsWith('{"kind":"takosumi.platform-worker-staging-')) {
      resultLines.push(chunk);
      return true;
    }
    return Reflect.apply(write, process.stdout, args);
  });
  let error: unknown;
  let runnerVerification: unknown;
  let runnerError: unknown;
  const runnerReads: string[] = [];
  try {
    const apiKeyTransition = options.apiKeys && options.apiKeys !== "routine";
    const maintenanceTransition = maintenance && maintenance !== "routine";
    await (maintenanceTransition ? runPlatformWorkerHostedAuthMaintenanceActivation
      : apiKeyTransition ? runPlatformWorkerApiKeyActivation
      : options.loginAdmission && options.loginAdmission !== "normal" && options.loginAdmission !== "missing" ? runPlatformWorkerLoginAdmissionRelease : runPlatformWorkerCodeRelease)(
      options.confirm
        ? [
          "confirm", "--config", configPath, "--version", CODE_DEPLOYED_ID,
          "--tag", options.confirm === "wrong-tag" ? `tks-stg-code-${"2".repeat(32)}` : tag,
          "--entry-digest", options.confirm === "wrong-digest" ? `sha256:${"0".repeat(64)}` : pins.controllerArtifactDigest,
        ]
        : options.resume
        ? [
          "resume", "--config", configPath,
          "--version", options.resume === "wrong-version" ? STATUS_VERSION_ID : CODE_DEPLOYED_ID,
          "--tag", options.resume === "wrong-tag" ? `tks-stg-code-${"2".repeat(32)}` : tag,
          "--predecessor", options.resume === "wrong-predecessor" ? STATUS_VERSION_ID : CODE_PREDECESSOR_ID,
        ]
        : maintenanceTransition
        ? ["apply", "--config", configPath, "--predecessor", CODE_PREDECESSOR_ID, "--hosted-version", STATUS_VERSION_ID,
          "--entry-digest", maintenance === "wrong-entry" ? `sha256:${"0".repeat(64)}` : pins.controllerArtifactDigest,
          "--dashboard-digest", maintenance === "wrong-dashboard"
            ? `sha256:${"0".repeat(64)}` : dashboardAssetTreeSeal(dashboardPath).digest,
        ]
        : apiKeyTransition
        ? ["apply", "--config", configPath,
          "--predecessor", options.apiKeys === "wrong-predecessor" ? STATUS_VERSION_ID : CODE_PREDECESSOR_ID,
          "--issuer-version", STATUS_VERSION_ID,
          "--entry-digest", options.apiKeys === "wrong-entry" ? `sha256:${"0".repeat(64)}` : pins.controllerArtifactDigest,
          "--dashboard-digest", options.apiKeys === "wrong-dashboard"
            ? `sha256:${"0".repeat(64)}` : dashboardAssetTreeSeal(dashboardPath).digest,
        ] : ["apply", "--config", configPath],
      "staging",
      {
        command,
        repositoryRoot: codeRoot,
        assertSelectedSource: () => {
          sourceCheckCount += 1;
          if (options.resume === "source-drift" && sourceCheckCount === 2) {
            throw new Error("synthetic source pin drift");
          }
        },
        buildDashboard: async () => {
          buildCount += 1;
          if (options.codeSource === "during-build") writeFileSync(claimPath, "// changed during build\n");
          if (pinnedActivation) return dashboardAssetTreeSeal(dashboardPath);
          return { digest: `sha256:${"d".repeat(64)}`, entries: [] };
        },
        runScopedGate: async () => {
          gateCount += 1;
          if (options.scopedGateFails) throw new Error("synthetic Worker build unavailable");
        },
        nativeRead: async (path) => {
          if (pinnedActivation && path === "/workers/scripts/takosumi-staging/versions?page=1&per_page=2") {
            if (options.hostedHistoryCustodyDrift === "config") {
              writeFileSync(configPath, source + "\n# changed during upload history read\n");
            } else if (options.hostedHistoryCustodyDrift === "assets") {
              chmodSync(dryRunAsset, 0o600);
              writeFileSync(dryRunAsset, "changed during upload history read");
            } else if (options.hostedHistoryCustodyDrift === "bundle") {
              writeFileSync(dryRunEntry, "changed during upload history read");
            }
            const ids = [CODE_PREDECESSOR_ID];
            if (pinnedActivation === "unserved-secret-version" ||
              (pinnedActivation === "intervening-secret-version" && uploadCount > 0)) {
              ids.push(STATUS_VERSION_ID);
            }
            if (uploadCount > 0) ids.push(CODE_DEPLOYED_ID);
            // Only immutable Version identity changes; serving and secret-name reads stay the same.
            if (lateSecretVersion) ids.push(STATUS_VERSION_ID);
            return { result: { items: ids.map((id, index) => ({ id, number: 42 + index })).reverse().slice(0, 2) }, resultInfo: { page: 1 } };
          }
          if (options.apiKeys && path === "/workers/scripts/takosumi-auth-staging/deployments") {
            return { result: { deployments: [{ versions: options.apiKeys === "issuer-split"
              ? [{ version_id: STATUS_VERSION_ID, percentage: 50 }, { version_id: CODE_PREDECESSOR_ID, percentage: 50 }]
              : [{ version_id: STATUS_VERSION_ID, percentage: 100 }] }] }, resultInfo: null };
          }
          if (maintenance && path === "/workers/scripts/takosumi-hosted-staging/deployments") {
            const phase = activated ? "after-activate" : uploadCount ? "before-activate" : buildCount ? "before-upload" : "before-build";
            hostedReadPhases.push(phase);
            if (maintenance === "bundle-changed-before-upload" && phase === "before-upload") {
              writeFileSync(dryRunEntry, "changed during dependency read");
            }
            if ((maintenance === "late-secret-version-before-upload" && phase === "before-upload") ||
              (maintenance === "late-secret-version-before-activation" && phase === "before-activate")) {
              lateSecretVersion = true;
            }
            if (maintenance === "dependency-malformed") return { result: { deployments: [] }, resultInfo: null };
            const changed = maintenance === "dependency-changed" ||
              (maintenance === "dependency-changed-before-upload" && phase === "before-upload") ||
              (maintenance === "dependency-changed-after-upload" && phase === "before-activate") ||
              (maintenance === "dependency-changed-after-activation" && phase === "after-activate");
            const versions = maintenance === "dependency-split"
              ? [{ version_id: STATUS_VERSION_ID, percentage: 50 }, { version_id: CODE_PREDECESSOR_ID, percentage: 50 }]
              : [{ version_id: changed ? CODE_PREDECESSOR_ID : STATUS_VERSION_ID, percentage: 100 }];
            return { result: { deployments: [{ versions }] }, resultInfo: null };
          }
          if (path === "/workers/scripts") topologySnapshot += 1;
          if (options.topologyDriftAt === topologySnapshot) {
            return codeNativeRead(
              source,
              options.containerDrift
                ? { scriptContainers: [{ class_name: "CoordinationObject" }] }
                : { routes: codeRoutes(options.routeDrift ?? "add") },
            )(path);
          }
          return cleanNativeRead(path);
        },
        waitForServingVersionRetry: async (milliseconds: number) => {
          readbackWaits.push(milliseconds);
        },
        waitForRunnerStartupRetry: async (milliseconds: number) => {
          startupWaits.push(milliseconds);
          if (options.startupConfigChanges) writeFileSync(configPath, source + "\n# changed during startup\n");
        },
        waitForVersionViewRetry: async (milliseconds: number) => {
          candidateReadWaits.push(milliseconds);
        },
        publicReadback: async (_environment, versionId) => {
          expect(versionId).toBe(CODE_DEPLOYED_ID);
          publicReadbackCount++;
          if (options.codeSource === "after-activation") writeFileSync(claimPath, "// changed during readback\n");
        },
        loginStartReadback: async (versionId) => {
          expect(versionId).toBe(CODE_DEPLOYED_ID);
          loginSmokeCount++;
          if (options.loginSmokeFails) {
            await verifyPlatformLoginStart({
              origin: "https://app-staging.takosumi.com",
              issuer: "https://auth-staging.takos.jp",
              versionId,
              fetcher: async () => new Response("fixture-sensitive-body", { status: 503, headers: {
                "set-cookie": "fixture-sensitive-cookie",
                "x-takosumi-version-id": versionId,
              } }),
            });
          }
        },
        apiKeyIssuerReadback: async (versionId) => {
          expect(versionId).toBe(STATUS_VERSION_ID);
          issuerReadCount++;
          if (options.apiKeys === "workspace-assets-changed" && issuerReadCount === 2) {
            writeFileSync(join(dashboardPath, "index.html"), "changed dashboard");
          }
          if (options.apiKeys === "issuer-changed" ||
            (options.apiKeys === "issuer-changed-after-upload" && uploadCount > 0)) {
            throw new Error("fixture issuer changed");
          }
        },
        nonce: () => "1".repeat(32),
      },
    );
    if (options.verifyRunner && expectedSourceProvenance) {
      const sha256 = (value: string) =>
        `sha256:${Bun.CryptoHasher.hash("sha256", value, "hex")}`;
      const mode = options.verifyRunner;
      const previousImage = PROVED_RUNNER_IMAGE;
      const buildEvidence = join(directory, "build.jsonl");
      const platformEvidence = join(directory, "platform.json");
      const receipt = JSON.parse(resultLines[0]!);
      if (mode === "wrong-source") receipt.sourceProvenance.sourceTree = "0".repeat(40);
      if (mode === "wrong-tag") receipt.releaseTag = `tks-stg-code-${"2".repeat(32)}`;
      if (mode === "missing-provenance") delete receipt.sourceProvenance;
      writeFileSync(platformEvidence, JSON.stringify(receipt), { mode: 0o600 });
      const transportTag = "release-1";
      writeFileSync(buildEvidence, `${JSON.stringify({
        kind: "takosumi.runner-image-release@v3",
        operation: "build",
        status: "published",
        environment: "staging",
        release: transportTag,
        observedAt: "2026-08-27T00:00:00.000Z",
        source: {
          branch: "main",
          repository: "https://github.com/example/takosumi.git",
          commit: expectedSourceProvenance.sourceCommit,
          authoritySha256: expectedSourceProvenance.sourceAuthoritySha256,
          dockerfileSha256: sha256("FROM scratch\n"),
          buildContextSha256: sha256("fixture build context"),
        },
        config: {
          path: configPath,
          buildSha256: sha256(source.replace(STATUS_CONTAINER_IMAGE, previousImage)),
          expectedActivationSha256: sha256(source),
          previousImage,
        },
        image: {
          transportTag,
          transportRef: STATUS_CONTAINER_IMAGE.replace(/@sha256:.+/u, `:${transportTag}`),
          immutableRef: STATUS_CONTAINER_IMAGE,
          imageConfigDigest: sha256("fixture image"),
        },
        runtimeInputPlanProof: {
          kind: "takosumi.runner-image-runtime-input-plan-proof@v1",
          image: STATUS_CONTAINER_IMAGE,
        },
        review: "operator:builder",
      })}\n`, { mode: 0o600 });
      try {
        runnerVerification = await runRunnerImageRelease({
          command: "verify",
          environment: "staging",
          config: configPath,
          release: transportTag,
          stagingCode: true,
          buildEvidence,
          platformEvidence,
          evidence: join(directory, "verify.jsonl"),
          execute: true,
          review: "operator:fixture",
        }, {
          repositoryRoot: codeRoot,
          command: async (executable, args, cwd) => {
            if (executable === "git") {
              const result = Bun.spawnSync([executable, ...args], { cwd });
              return {
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString(),
              };
            }
            const operation = args.slice(1, 3).join(" ");
            runnerReads.push(operation);
            if (!["deployments status", "versions view", "secret list", "containers list", "containers info"].includes(operation)) {
              throw new Error(`unexpected runner operation ${operation}`);
            }
            if (mode === "serving-drift" && operation === "deployments status" && runnerReads.length > 1) {
              return { exitCode: 0, stdout: JSON.stringify({
                versions: [{ version_id: CODE_PREDECESSOR_ID, percentage: 100 }],
              }), stderr: "" };
            }
            return command([...args]);
          },
        });
      } catch (caught) {
        runnerError = caught;
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    stdout.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    error,
    results: resultLines.map((line) => JSON.parse(line) as Record<string, unknown>),
    uploadCount,
    activationCount,
    buildCount,
    gateCount,
    loginSmokeCount,
    issuerReadCount,
    hostedReadPhases,
    uploadedDashboard,
    sourceCheckCount,
    operationOrder,
    candidateReads,
    candidateReadWaits,
    readbackWaits,
    startupWaits,
    postActivationReadCount,
    publicReadbackCount,
    topologySnapshot,
    uploadArgs,
    activationArgs,
    uploadConfigSource,
    activationConfigSource,
    expectedSourceProvenance,
    runnerVerification,
    runnerError,
    runnerReads,
  };
}

test("routine staging waits for the same starting Runner before its single build and upload", async () => {
  const result = await exerciseCodeLane({ startupRunner: [
    { state: "provisioning", scheduling: 1 },
    { state: "provisioning", starting: 1 },
    {},
  ] });
  expect(result.error).toBeUndefined();
  expect(result.startupWaits).toEqual([15_000, 15_000]);
  expect(result.gateCount).toBe(1);
  expect(result.buildCount).toBe(1);
  expect(result.uploadCount).toBe(1);
  expect(result.activationCount).toBe(1);
  expect(result.results).toMatchObject([{ status: "ready" }]);
});

test("routine staging startup exits before build when the selected Runner, timing, or Worker authority changes", async () => {
  const starting = { state: "provisioning", starting: 1 };
  const cases = [
    { startupRunner: [starting, { ...starting, version: 5 }], outcome: "platform_worker_code_startup_runner_drift" },
    { startupRunner: [starting, { ...starting, failed: 1 }], outcome: "platform_worker_release_container_not_ready" },
    {
      startupRunner: [starting, { ...starting, activeRolloutId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      outcome: "platform_worker_release_container_not_ready",
    },
    { startupRunner: [starting], expectedWaits: 8, outcome: "platform_worker_code_runner_startup_timeout" },
    { startupRunner: [starting, {}], topologyDriftAt: 2, outcome: "platform_worker_code_authority_drift" },
    { startupRunner: [starting, {}], startupConfigChanges: true, outcome: "platform_worker_code_config_drift" },
    {
      startupRunner: [{ ...starting, image: PROVED_RUNNER_IMAGE }], expectedWaits: 0,
      outcome: "platform_worker_release_container_not_ready",
    },
    {
      startupRunner: [starting, {}], resume: "valid" as const, expectedWaits: 0,
      outcome: "platform_worker_release_container_not_ready",
    },
  ] satisfies (Parameters<typeof exerciseCodeLane>[0] & { expectedWaits?: number; outcome: string })[];
  for (const { expectedWaits = 1, outcome, ...options } of cases) {
    const result = await exerciseCodeLane(options);
    expect(String(result.error)).toBe(`Error: ${outcome}`);
    expect(result.startupWaits).toHaveLength(expectedWaits);
    expect([result.gateCount, result.buildCount, result.uploadCount, result.activationCount]).toEqual([0, 0, 0, 0]);
    expect(result.results).toEqual([]);
  }
});

test("staging code stops at a failed Worker build before building assets or uploading", async () => {
  const result = await exerciseCodeLane({ scopedGateFails: true });
  expect(String(result.error)).toContain("synthetic Worker build unavailable");
  expect(result.gateCount).toBe(1);
  expect(result.buildCount).toBe(0);
  expect(result.uploadCount).toBe(0);
  expect(result.activationCount).toBe(0);
});

test("routine code Version matcher accepts the observed shape and only three prior digest vars", () => {
  const source = codeConfigSource();
  const predecessor = codeVersionSource(source, CODE_PREDECESSOR_ID, {
    tag: "predecessor",
    message: "predecessor",
  });
  expect(() =>
    assertPlatformWorkerCodeVersionMatchesConfig(
      predecessor,
      source,
      "takosumi-hosted-staging",
      CODE_SECRETS,
      { allowPriorPins: true },
    )
  ).not.toThrow();

  const unknown = JSON.parse(predecessor);
  unknown.resources.bindings[0].future_identity = "no";
  expect(() =>
    assertPlatformWorkerCodeVersionMatchesConfig(
      JSON.stringify(unknown),
      source,
      "takosumi-hosted-staging",
      CODE_SECRETS,
      { allowPriorPins: true },
    )
  ).toThrow("platform_worker_code_native_field_unsupported");

  const pins = platformExecutionEvidenceReleasePins(CODE_BUNDLE, STATUS_CONTAINER_IMAGE);
  const finalSource = injectPlatformExecutionEvidencePins(source, pins);
  const finalVersion = codeVersionSource(finalSource, CODE_DEPLOYED_ID, {
    tag: "final",
    message: "final",
  });
  expect(() =>
    assertPlatformWorkerCodeVersionMatchesConfig(
      finalVersion,
      finalSource,
      "takosumi-hosted-staging",
      CODE_SECRETS,
    )
  ).not.toThrow();
  const changedPin = JSON.parse(finalVersion);
  changedPin.resources.bindings.find(
    (binding: any) => binding.name === "TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST",
  ).text = `sha256:${"0".repeat(64)}`;
  expect(() =>
    assertPlatformWorkerCodeVersionMatchesConfig(
      JSON.stringify(changedPin),
      finalSource,
      "takosumi-hosted-staging",
      CODE_SECRETS,
    )
  ).toThrow("platform_worker_code_binding_mismatch");
});

test("login admission rate-limit bindings have an exact preserved provider tuple", () => {
  const source = codeConfigSource() + '\n[[ratelimits]]\nname = "HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER"\nnamespace_id = "2026111401"\n[ratelimits.simple]\nlimit = 60\nperiod = 60\n\n[[ratelimits]]\nname = "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER"\nnamespace_id = "2026111402"\n[ratelimits.simple]\nlimit = 10\nperiod = 60\n';
  const version = JSON.parse(codeVersionSource(source, CODE_PREDECESSOR_ID, { tag: "predecessor", message: "predecessor" }));
  version.resources.bindings.push(
    { name: "HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER", type: "ratelimit", namespace_id: "2026111401", simple: { limit: 60, period: 60 } },
    { name: "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER", type: "ratelimit", namespace_id: "2026111402", simple: { limit: 10, period: 60 } },
  );
  expect(() => assertPlatformWorkerCodeVersionMatchesConfig(JSON.stringify(version), source, "takosumi-hosted-staging", CODE_SECRETS, { allowPriorPins: true })).not.toThrow();
  for (const change of [
    (binding: Record<string, any>) => binding.namespace_id = "2026111409",
    (binding: Record<string, any>) => binding.simple.limit = 61,
    (binding: Record<string, any>) => binding.simple.period = 10,
    (binding: Record<string, any>) => binding.simple.future = true,
  ]) {
    const changed = structuredClone(version);
    change(changed.resources.bindings.at(-2));
    expect(() => assertPlatformWorkerCodeVersionMatchesConfig(JSON.stringify(changed), source, "takosumi-hosted-staging", CODE_SECRETS, { allowPriorPins: true })).toThrow();
  }
});

test("routine code rejects login limiter secrets before building or uploading", async () => {
  for (const name of [
    "HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER",
    "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER",
  ]) {
    const result = await exerciseCodeLane({
      loginAdmission: "normal",
      bindingReplacedBySecret: name,
    });
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("platform_worker_code_binding_mismatch");
    expect(result.buildCount).toBe(0);
    expect(result.gateCount).toBe(0);
    expect(result.uploadCount).toBe(0);
    expect(result.activationCount).toBe(0);
    expect(result.loginSmokeCount).toBe(0);
  }
});

test("routine code preserves disjoint secrets and rejects typed binding secret collisions", () => {
  const source = codeConfigSource().replace(
    "[vars]\n", '[vars]\nPUBLIC_FIXTURE_MODE = "fixed"\n',
  );
  const version = JSON.parse(codeVersionSource(source, CODE_PREDECESSOR_ID, {
    tag: "predecessor",
    message: "predecessor",
  }));
  version.resources.bindings.push({ name: "EXTRA_OPERATOR_SECRET", type: "secret_text" });
  const secrets = secretNames(JSON.stringify(
    [...CODE_SECRETS, "EXTRA_OPERATOR_SECRET"].map((name) => ({ name })),
  ));
  expect(() => assertPlatformWorkerCodeVersionMatchesConfig(
    JSON.stringify(version), source, "takosumi-hosted-staging", secrets,
    { allowPriorPins: true },
  )).not.toThrow();
  for (const name of ["PUBLIC_FIXTURE_MODE", "TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST"]) {
    const changed = structuredClone(version);
    const index = changed.resources.bindings.findIndex(
      (binding: { name: string }) => binding.name === name,
    );
    changed.resources.bindings[index] = { name, type: "secret_text" };
    const changedSecrets = secretNames(JSON.stringify(
      [...secrets, name].map((secretName) => ({ name: secretName })),
    ));
    expect(() => assertPlatformWorkerCodeVersionMatchesConfig(
      JSON.stringify(changed), source, "takosumi-hosted-staging", changedSecrets,
      { allowPriorPins: true },
    )).toThrow("platform_worker_code_binding_mismatch");
  }
});

test("routine code Version matcher accepts only canonical root asset base path", () => {
  const source = codeConfigSource();
  const version = JSON.parse(codeVersionSource(source, CODE_PREDECESSOR_ID, {
    tag: "predecessor",
    message: "predecessor",
  }));
  const matches = () => assertPlatformWorkerCodeVersionMatchesConfig(
    JSON.stringify(version),
    source,
    "takosumi-hosted-staging",
    CODE_SECRETS,
    { allowPriorPins: true },
  );
  expect(matches).not.toThrow();
  version.resources.script_runtime.assets.base_path = "/";
  expect(matches).not.toThrow();
  for (const invalid of ["", "/nested", null, false, [], {}]) {
    version.resources.script_runtime.assets.base_path = invalid;
    expect(matches).toThrow("platform_worker_code_settings_mismatch");
  }
  version.resources.script_runtime.assets.base_path = "/";
  version.resources.script_runtime.assets.future_identity = "unknown";
  expect(matches).toThrow("platform_worker_code_native_field_unsupported");
});

test("native reads accept proven null diagnostics without accepting failures", () => {
  const result = [{ hostname: "app-staging.takosumi.com" }];
  const resultInfo = { count: 1, total_count: 1 };
  expect(
    platformNativeEnvelope({
      success: true,
      result,
      result_info: resultInfo,
      errors: null,
      messages: null,
    }),
  ).toEqual({ result, resultInfo });
  expect(
    platformNativeEnvelope({
      success: true,
      result,
      errors: [],
      messages: [{ code: 10_000, message: "informational" }],
    }),
  ).toEqual({ result, resultInfo: null });

  for (const envelope of [
    { success: false, result, errors: null, messages: null },
    { success: true, result, errors: [{ code: 1 }], messages: null },
    { success: true, result, errors: {}, messages: null },
    { success: true, result, errors: null, messages: {} },
    { success: true, result, errors: null },
  ]) {
    expect(() => platformNativeEnvelope(envelope)).toThrow(
      "native response envelope invalid",
    );
  }
});

test("routine code preserves the known route and rejects malformed provider state", async () => {
  const source = codeConfigSource();
  await expect(
    readPlatformWorkerCodeTopology(source, "takosumi-staging", codeNativeRead(source)),
  ).resolves.toMatchObject({
    routes: [CODE_LEGACY_ROUTE],
    crons: ["* * * * *", "*/5 * * * *"],
    containers: ["OpenTofuRunnerObject"],
  });
  for (const route of [
    { ...CODE_LEGACY_ROUTE, id: "not-an-id" },
    { ...CODE_LEGACY_ROUTE, pattern: "bad\u0001pattern" },
    { ...CODE_LEGACY_ROUTE, request_limit_fail_open: "false" },
  ]) {
    await expect(
      readPlatformWorkerCodeTopology(
        source,
        "takosumi-staging",
        codeNativeRead(source, { routes: [route] }),
      ),
    ).rejects.toThrow("platform_worker_code_topology_shape_unsupported");
  }
  await expect(
    readPlatformWorkerCodeTopology(
      source,
      "takosumi-staging",
      codeNativeRead(source, {
        routes: [{ ...CODE_LEGACY_ROUTE, script: "foreign-worker" }],
      }),
    ),
  ).rejects.toThrow("platform_worker_code_topology_mismatch");
  await expect(
    readPlatformWorkerCodeTopology(
      source,
      "takosumi-staging",
      codeNativeRead(source, { unknownSetting: true }),
    ),
  ).rejects.toThrow("platform_worker_code_native_field_unsupported");
  for (const drift of [{ cronDrift: true }, { domainDrift: true }]) {
    await expect(
      readPlatformWorkerCodeTopology(
        source,
        "takosumi-staging",
        codeNativeRead(source, drift),
      ),
    ).rejects.toThrow("platform_worker_code_topology_mismatch");
  }
});

test("routine code accepts the listed Container attachment only as the configured class", async () => {
  const source = codeConfigSource();
  const read = (options: Parameters<typeof codeNativeRead>[1]) =>
    readPlatformWorkerCodeTopology(
      source,
      "takosumi-staging",
      codeNativeRead(source, options),
    );
  await expect(read({})).resolves.toMatchObject({
    containers: ["OpenTofuRunnerObject"],
  });
  // The attachment is a passive readback: a future field on it is not
  // silently tolerated.
  await expect(
    read({
      scriptContainers: [{ class_name: "OpenTofuRunnerObject", future: true }],
    }),
  ).rejects.toThrow("platform_worker_code_native_field_unsupported");
  for (const scriptContainers of [
    {},
    "OpenTofuRunnerObject",
    ["OpenTofuRunnerObject"],
    [{ class_name: 1 }],
    [{ class_name: "" }],
  ]) {
    await expect(read({ scriptContainers })).rejects.toThrow(
      "platform_worker_code_topology_shape_unsupported",
    );
  }
  // Attachment drift from the configured `[[containers]]` refuses.
  for (const scriptContainers of [
    [],
    [{ class_name: "CoordinationObject" }],
    [{ class_name: "OpenTofuRunnerObject" }, { class_name: "CoordinationObject" }],
    [{ class_name: "OpenTofuRunnerObject" }, { class_name: "OpenTofuRunnerObject" }],
  ]) {
    await expect(read({ scriptContainers })).rejects.toThrow(
      "platform_worker_code_topology_mismatch",
    );
  }
  await expect(read({ omitScriptContainers: true })).rejects.toThrow(
    "platform_worker_code_topology_mismatch",
  );
  // `null` lists no attachment, exactly like an absent key: it is a mismatch
  // against a configured Container, not an unknown shape.
  await expect(read({ scriptContainers: null })).rejects.toThrow(
    "platform_worker_code_topology_mismatch",
  );
  // A Worker whose config declares no Container must list none.
  const withoutContainer = source.replace(
    /\[\[containers\]\]\nclass_name = "OpenTofuRunnerObject"\nimage = [^\n]+\n/u,
    "",
  );
  expect(withoutContainer).not.toContain("[[containers]]");
  await expect(
    readPlatformWorkerCodeTopology(
      withoutContainer,
      "takosumi-staging",
      codeNativeRead(withoutContainer, { omitScriptContainers: true }),
    ),
  ).resolves.toMatchObject({ containers: [] });
  await expect(
    readPlatformWorkerCodeTopology(
      withoutContainer,
      "takosumi-staging",
      codeNativeRead(withoutContainer, { scriptContainers: null }),
    ),
  ).resolves.toMatchObject({ containers: [] });
  await expect(
    readPlatformWorkerCodeTopology(
      withoutContainer,
      "takosumi-staging",
      codeNativeRead(withoutContainer),
    ),
  ).rejects.toThrow("platform_worker_code_topology_mismatch");
});

test("routine code publishes once and refuses production", async () => {
  const result = await exerciseCodeLane();
  expect(result).toMatchObject({
    error: undefined,
    uploadCount: 1,
    activationCount: 1,
    buildCount: 1,
    gateCount: 1,
    topologySnapshot: 3,
  });
  expect(result.uploadArgs).toEqual(
    expect.arrayContaining(["versions", "upload", "--no-bundle", "--strict"]),
  );
  expect(result.activationArgs).toEqual(
    expect.arrayContaining(["versions", "deploy", `${CODE_DEPLOYED_ID}@100%`, "--yes"]),
  );
  expect(result.uploadConfigSource).not.toContain("[[migrations]]");
  // The upload keeps the realized Container declaration byte-for-value, so the
  // new Version carries the same class attachment; the lane never rolls out or
  // rewrites the Container application itself.
  expect(Bun.TOML.parse(result.uploadConfigSource).containers).toEqual(
    Bun.TOML.parse(codeConfigSource()).containers,
  );
  expect(result.uploadArgs).not.toContain("--containers-rollout");
  expect(Object.keys(Bun.TOML.parse(result.activationConfigSource)).sort()).toEqual([
    "account_id",
    "name",
  ]);
  await expect(
    runPlatformWorkerCodeRelease(["apply", "--config", "/private/config"], "production"),
  ).rejects.toThrow("platform_worker_code_action_invalid");
});

test("routine code reports the source provenance of a clean checkout", async () => {
  const result = await exerciseCodeLane({ codeSource: "clean" });
  expect(result).toMatchObject({ error: undefined, uploadCount: 1, activationCount: 1 });
  expect(result.expectedSourceProvenance).toBeDefined();
  expect(result.results[0]).toMatchObject({
    status: "ready",
    deployedVersionId: CODE_DEPLOYED_ID,
    sourceProvenance: result.expectedSourceProvenance,
  });
});

test("Runner verify consumes the ordinary code receipt from exact detached staging source", async () => {
  const result = await exerciseCodeLane({ codeSource: "clean", verifyRunner: "ready" });
  expect(result.error).toBeUndefined();
  expect(result.runnerError).toBeUndefined();
  expect(result.runnerVerification).toMatchObject({
    status: "verified",
    image: STATUS_CONTAINER_IMAGE,
    platform: {
      kind: "takosumi.platform-worker-staging-code@v1",
      deployedVersionId: CODE_DEPLOYED_ID,
      sourceProvenance: result.expectedSourceProvenance,
    },
  });
  expect(result.runnerReads).toEqual([
    "deployments status", "versions view", "secret list",
    "containers list", "containers info", "deployments status",
  ]);
});

test.each([
  ["wrong-source", "runner_image_staging_code_source_mismatch", []],
  ["missing-provenance", "runner_image_staging_code_evidence_invalid", []],
  ["wrong-tag", "platform_worker_release_version_identity_invalid", ["deployments status", "versions view"]],
  ["serving-drift", "platform evidence Worker Version is not serving exactly", [
    "deployments status", "versions view", "secret list",
    "containers list", "containers info", "deployments status",
  ]],
] as const)("Runner verify refuses the staging receipt with %s", async (verifyRunner, message, reads) => {
  const result = await exerciseCodeLane({ codeSource: "clean", verifyRunner });
  expect(result.error).toBeUndefined();
  expect(result.runnerError).toEqual(new Error(message));
  expect(result.runnerReads).toEqual([...reads]);
});

test.each(["dirty", "hidden-index-change", "file-mode-change", "during-build", "after-activation"] as const)(
  "routine code can deploy while omitting exact source provenance for a %s checkout",
  async (codeSource) => {
    const result = await exerciseCodeLane({ codeSource });
    expect(result).toMatchObject({ error: undefined, uploadCount: 1, activationCount: 1 });
    expect(result.results[0]).toMatchObject({ status: "ready", deployedVersionId: CODE_DEPLOYED_ID });
    expect(result.results[0]).not.toHaveProperty("sourceProvenance");
  },
);

test("routine code waits for the acknowledged Version and activates it once", async () => {
  const result = await exerciseCodeLane({ candidateReadFailures: 2 });
  expect(result).toMatchObject({
    error: undefined,
    uploadCount: 1,
    activationCount: 1,
    buildCount: 1,
    gateCount: 1,
    candidateReadWaits: [1_000, 2_000],
  });
  expect(result.operationOrder.slice(0, 7)).toEqual([
    "serving", "serving", "candidate", "candidate", "candidate", "serving", "activate",
  ]);
  expect(result.candidateReads).toEqual(Array<string>(4).fill(CODE_DEPLOYED_ID));
});

test("routine code keeps the upload receipt when candidate reads do not converge", async () => {
  const result = await exerciseCodeLane({ candidateReadFailures: 30 });
  expect(result).toMatchObject({ uploadCount: 1, activationCount: 0 });
  expect(result.candidateReadWaits.reduce((sum, delay) => sum + delay, 0)).toBe(120_000);
  expect(result.candidateReads).toEqual(Array<string>(12).fill(CODE_DEPLOYED_ID));
  expect(result.results[0]).toMatchObject({
    status: "incomplete",
    mutation: "upload",
    candidateVersionId: CODE_DEPLOYED_ID,
  });
});

test("routine code skips candidate waits on other errors and explicit resume, and refuses drift", async () => {
  for (const options of [
    { candidateReadFailures: 1, candidateReadErrorCode: 10000 },
    { candidateReadFailures: 1, resume: "valid" },
  ] as const) {
    const result = await exerciseCodeLane(options);
    expect(result).toMatchObject({
      activationCount: 0,
      candidateReads: [CODE_DEPLOYED_ID],
      candidateReadWaits: [],
    });
  }
  const drifted = await exerciseCodeLane({
    candidateReadFailures: 1,
    topologyDriftAt: 3,
  });
  expect(drifted).toMatchObject({
    uploadCount: 1,
    activationCount: 0,
    candidateReadWaits: [1_000],
  });
  expect(drifted.results[0]).toMatchObject({
    status: "incomplete",
    mutation: "upload",
    candidateVersionId: CODE_DEPLOYED_ID,
  });
});

test("routine code confirms the already serving Version without building or mutating", async () => {
  const result = await exerciseCodeLane({ confirm: "valid", loginAdmission: "normal" });
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({
    uploadCount: 0, activationCount: 0, buildCount: 0, gateCount: 0,
    publicReadbackCount: 1, loginSmokeCount: 1,
  });
  expect(result.operationOrder).toEqual(["serving", "candidate", "serving"]);
  expect(result.results).toEqual([{
    kind: "takosumi.platform-worker-staging-code-confirmation@v1",
    status: "verified",
    versionId: CODE_DEPLOYED_ID,
    releaseTag: `tks-stg-code-${"1".repeat(32)}`,
    entryDigest: platformExecutionEvidenceReleasePins(CODE_BUNDLE, STATUS_CONTAINER_IMAGE).controllerArtifactDigest,
    configSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    loginStartVerified: true,
  }]);
});

test("routine code confirmation fails closed on unmatched evidence or an unhealthy target", async () => {
  for (const [options, error] of [
    [{ confirm: "not-serving" }, "platform_worker_code_confirm_version_mismatch"],
    [{ confirm: "wrong-tag" }, "platform_worker_release_version_identity_invalid"],
    [{ confirm: "wrong-digest" }, "platform_worker_release_version_identity_invalid"],
    [{ confirm: "wrong-pins" }, "platform_worker_code_binding_mismatch"],
    [{ confirm: "serving-drift" }, "platform_worker_code_confirm_version_mismatch"],
    [{ confirm: "valid", containerFailsAfterActivation: true }, "platform_worker_release_container_not_ready"],
    [{ confirm: "valid", loginSmokeFails: true }, "platform_worker_login_start_readback_invalid"],
  ] as const) {
    const result = await exerciseCodeLane({ loginAdmission: "normal", ...options });
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(error);
    expect(result).toMatchObject({ uploadCount: 0, activationCount: 0, buildCount: 0, gateCount: 0, results: [] });
  }
});

test("routine code confirmation is staging-only and requires its exact identity fields", async () => {
  const args = [
    "confirm", "--config", "/private/staging.toml", "--version", CODE_DEPLOYED_ID,
    "--tag", `tks-stg-code-${"1".repeat(32)}`,
    "--entry-digest", platformExecutionEvidenceReleasePins(CODE_BUNDLE, STATUS_CONTAINER_IMAGE).controllerArtifactDigest,
  ];
  await expect(runPlatformWorkerCodeRelease(args, "production")).rejects.toThrow("platform_worker_code_action_invalid");
  await expect(runPlatformWorkerLoginAdmissionRelease(args, "staging")).rejects.toThrow("platform_worker_code_action_invalid");
  await expect(runPlatformWorkerCodeRelease(args.slice(0, -2))).rejects.toThrow("platform_worker_code_confirm_arguments_invalid");
  await expect(runPlatformWorkerCodeRelease([...args, "--version", STATUS_VERSION_ID])).rejects.toThrow("platform_worker_code_confirm_arguments_invalid");
});

test("routine code resumes an existing exact Version without uploading", async () => {
  const result = await exerciseCodeLane({ resume: "valid", uploadFails: true, loginAdmission: "normal" });
  expect(result).toMatchObject({
    error: undefined,
    uploadCount: 0,
    activationCount: 1,
    buildCount: 1,
    gateCount: 1,
    loginSmokeCount: 1,
    sourceCheckCount: 2,
    topologySnapshot: 3,
  });
  expect(result.operationOrder.slice(0, 4)).toEqual(["serving", "candidate", "serving", "activate"]);
  expect(result.activationArgs).toEqual(expect.arrayContaining([`${CODE_DEPLOYED_ID}@100%`]));
});

test("routine code waits for the candidate while only the predecessor is visible", async () => {
  for (const resume of [undefined, "valid"] as const) {
    const result = await exerciseCodeLane({
      resume,
      loginAdmission: "normal",
      postActivationVersions: [CODE_PREDECESSOR_ID, CODE_PREDECESSOR_ID, CODE_DEPLOYED_ID],
    });
    expect(result).toMatchObject({
      error: undefined,
      uploadCount: resume ? 0 : 1,
      activationCount: 1,
      buildCount: 1,
      gateCount: 1,
      topologySnapshot: 3,
      readbackWaits: [1_000, 2_000],
      postActivationReadCount: 3,
      publicReadbackCount: 1,
      loginSmokeCount: 1,
    });
    expect(result.results[0]).toMatchObject({
      status: "ready",
      deployedVersionId: CODE_DEPLOYED_ID,
    });
  }
});

test("routine code stops on a concurrent Version instead of waiting for the candidate", async () => {
  const result = await exerciseCodeLane({
    postActivationVersions: [CODE_PREDECESSOR_ID, STATUS_VERSION_ID, CODE_DEPLOYED_ID],
  });
  expect(((result.error as Error).cause as Error).message).toBe(
    "platform_worker_release_concurrent_version",
  );
  expect(result).toMatchObject({
    uploadCount: 1,
    activationCount: 1,
    postActivationReadCount: 2,
    readbackWaits: [1_000],
    topologySnapshot: 2,
    publicReadbackCount: 0,
  });
  expect(result.results[0]).toMatchObject({
    status: "incomplete",
    mutation: "activate",
    candidateVersionId: CODE_DEPLOYED_ID,
  });
});

test("routine code retries only the exact Version read after activation", async () => {
  const result = await exerciseCodeLane({
    loginAdmission: "normal",
    postActivationCandidateReadFailures: 1,
  });
  expect(result).toMatchObject({
    error: undefined,
    uploadCount: 1,
    activationCount: 1,
    buildCount: 1,
    gateCount: 1,
    candidateReads: Array<string>(3).fill(CODE_DEPLOYED_ID),
    candidateReadWaits: [1_000],
    postActivationReadCount: 2,
    topologySnapshot: 3,
    publicReadbackCount: 1,
    loginSmokeCount: 1,
  });
  expect(result.operationOrder.slice(-5)).toEqual([
    "activate", "serving", "candidate", "candidate", "serving",
  ]);
  expect(result.results[0]).toMatchObject({
    status: "ready",
    deployedVersionId: CODE_DEPLOYED_ID,
  });
});

test("routine code refuses a concurrent Version after a delayed post-activation read", async () => {
  const result = await exerciseCodeLane({
    postActivationCandidateReadFailures: 1,
    postActivationVersions: [CODE_DEPLOYED_ID, STATUS_VERSION_ID],
  });
  expect(((result.error as Error).cause as Error).message).toBe(
    "platform_worker_release_concurrent_version",
  );
  expect(result).toMatchObject({
    uploadCount: 1,
    activationCount: 1,
    candidateReadWaits: [1_000],
    postActivationReadCount: 2,
    publicReadbackCount: 0,
  });
  expect(result.results[0]).toMatchObject({
    status: "incomplete",
    mutation: "activate",
    candidateVersionId: CODE_DEPLOYED_ID,
    observedServingVersionId: STATUS_VERSION_ID,
  });
});

test("routine code leaves an unverifiable activated Version incomplete without replay", async () => {
  for (const [candidateReadErrorCode, expectedWaitMs] of [[100146, 120_000], [10000, 0]] as const) {
    const result = await exerciseCodeLane({
      postActivationCandidateReadFailures: 20,
      candidateReadErrorCode,
    });
    expect(result).toMatchObject({
      uploadCount: 1,
      activationCount: 1,
      postActivationReadCount: 1,
      publicReadbackCount: 0,
    });
    expect(result.candidateReadWaits.reduce((sum, delay) => sum + delay, 0)).toBe(expectedWaitMs);
    expect(result.results[0]).toMatchObject({
      status: "incomplete",
      mutation: "activate",
      candidateVersionId: CODE_DEPLOYED_ID,
    });
  }
});

test("routine code reports incomplete when the exact predecessor stays visible", async () => {
  const result = await exerciseCodeLane({
    postActivationVersions: Array<string>(17).fill(CODE_PREDECESSOR_ID),
  });
  expect(((result.error as Error).cause as Error).message).toBe(
    "platform_worker_release_predecessor_unchanged",
  );
  expect(result).toMatchObject({
    uploadCount: 1,
    activationCount: 1,
    postActivationReadCount: 16,
    topologySnapshot: 2,
    publicReadbackCount: 0,
  });
  expect(result.readbackWaits.reduce((elapsed, delay) => elapsed + delay, 0)).toBe(180_000);
  expect(result.results[0]).toMatchObject({
    status: "incomplete",
    mutation: "activate",
    candidateVersionId: CODE_DEPLOYED_ID,
    predecessorVersionId: CODE_PREDECESSOR_ID,
  });
  expect(result.results[0]).not.toHaveProperty("observedServingVersionId");
});

test("routine resume refuses a mismatched identity or unhealthy predecessor without any mutation", async () => {
  for (const [resume, message] of [
    ["wrong-tag", "platform_worker_release_version_identity_invalid"],
    ["wrong-digest", "platform_worker_release_version_identity_invalid"],
    ["wrong-version", "platform_worker_release_version_identity_invalid"],
    ["wrong-predecessor", "platform_worker_code_resume_predecessor_changed"],
    ["already-serving", "platform_worker_code_resume_predecessor_changed"],
    ["unhealthy", "platform_worker_release_container_not_ready"],
    ["source-drift", "synthetic source pin drift"],
  ] as const) {
    const refused = await exerciseCodeLane({ resume });
    expect(refused.error).toBeInstanceOf(Error);
    expect((refused.error as Error).message).toBe(message);
    expect(refused).toMatchObject({ uploadCount: 0, activationCount: 0 });
  }
  const drifted = await exerciseCodeLane({ resume: "valid", topologyDriftAt: 2 });
  expect(drifted.error).toBeInstanceOf(Error);
  expect(drifted).toMatchObject({ uploadCount: 0, activationCount: 0 });
});

test("routine resume is not a production or authority-transition action", async () => {
  const args = [
    "resume", "--config", "/private/config.toml", "--version", CODE_DEPLOYED_ID,
    "--tag", `tks-stg-code-${"1".repeat(32)}`, "--predecessor", CODE_PREDECESSOR_ID,
  ];
  await expect(runPlatformWorkerCodeRelease(args, "production")).rejects.toThrow("platform_worker_code_action_invalid");
  await expect(runPlatformWorkerLoginAdmissionRelease(args, "staging")).rejects.toThrow("platform_worker_code_action_invalid");
  await expect(runPlatformWorkerCodeRelease(args.slice(0, -2))).rejects.toThrow("platform_worker_code_resume_arguments_invalid");
});

test("login admission dedicated transition adds only both ports, then normal code preserves them", async () => {
  for (const loginAdmission of ["transition", "normal"] as const) {
    const result = await exerciseCodeLane({ loginAdmission });
    expect(result).toMatchObject({ error: undefined, uploadCount: 1, activationCount: 1, buildCount: 1, gateCount: 1, loginSmokeCount: 1 });
    expect((Bun.TOML.parse(result.uploadConfigSource) as Record<string, unknown>).ratelimits).toEqual([
      { name: "HOSTED_OIDC_LOGIN_GLOBAL_RATE_LIMITER", namespace_id: "2026111401", simple: { limit: 60, period: 60 } },
      { name: "HOSTED_OIDC_LOGIN_IP_RATE_LIMITER", namespace_id: "2026111402", simple: { limit: 10, period: 60 } },
    ]);
    expect(result.activationArgs).not.toContain("--containers-rollout");
  }
});

test("shared staging API-key activation adds one switch to the same sealed Worker and dashboard", async () => {
  const result = await exerciseCodeLane({ apiKeys: "transition" });
  expect(result).toMatchObject({
    error: undefined, uploadCount: 1, activationCount: 1, issuerReadCount: 4, loginSmokeCount: 1,
    uploadedDashboard: "sealed dashboard",
  });
  const concurrentBuild = await exerciseCodeLane({ apiKeys: "workspace-assets-changed" });
  expect(concurrentBuild).toMatchObject({
    error: undefined, uploadCount: 1, activationCount: 1, uploadedDashboard: "sealed dashboard",
  });
  expect((Bun.TOML.parse(result.uploadConfigSource) as { vars: Record<string, unknown> }).vars)
    .toHaveProperty("TAKOSUMI_SHARED_AUTH_API_KEYS", "enabled");
  expect(result.activationArgs).not.toContain("--containers-rollout");
  expect(result.results[0]).toMatchObject({
    kind: "takosumi.platform-worker-staging-api-keys@v1", status: "ready",
    predecessorVersionId: CODE_PREDECESSOR_ID, deployedVersionId: CODE_DEPLOYED_ID,
  });
});

test("shared staging API-key activation fences the prior Version, issuer, unrelated bindings, and artifact bytes", async () => {
  for (const options of [
    { apiKeys: "routine" }, { apiKeys: "wrong-predecessor" }, { apiKeys: "wrong-entry" },
    { apiKeys: "wrong-dashboard" }, { apiKeys: "issuer-changed" }, { apiKeys: "issuer-split" },
    { apiKeys: "unserved-secret-version" },
    { apiKeys: "transition", unrelatedBindingDrift: true },
  ] as const) {
    const result = await exerciseCodeLane(options);
    expect(result.error).toBeDefined();
    expect(result).toMatchObject({ uploadCount: 0, activationCount: 0 });
  }
  for (const apiKeys of ["issuer-changed-after-upload", "product-changed-after-upload"] as const) {
    const drift = await exerciseCodeLane({ apiKeys });
    expect(drift).toMatchObject({ uploadCount: 1, activationCount: 0, issuerReadCount: 3 });
    expect(drift.results[0]).toMatchObject({ status: "incomplete", mutation: "upload" });
  }
  const intervening = await exerciseCodeLane({ apiKeys: "intervening-secret-version" });
  expect(intervening).toMatchObject({ uploadCount: 1, activationCount: 0, issuerReadCount: 2 });
  expect(intervening.results[0]).toMatchObject({ status: "incomplete", mutation: "upload" });
});

test("Hosted auth maintenance activates one exact staged Version and checks Hosted before each write", async () => {
  const result = await exerciseCodeLane({ hostedMaintenance: "transition" });
  expect(result).toMatchObject({
    error: undefined, uploadCount: 1, activationCount: 1, publicReadbackCount: 1,
    issuerReadCount: 0, loginSmokeCount: 0, uploadedDashboard: "sealed dashboard",
    hostedReadPhases: ["before-build", "before-upload", "before-activate", "after-activate"],
  });
  const uploaded = Bun.TOML.parse(result.uploadConfigSource) as {
    vars: Record<string, unknown>; triggers: { crons: string[] };
  };
  expect(uploaded.vars).toMatchObject({
    TAKOSUMI_HOSTED_AUTH_MAINTENANCE_ENABLED: "1",
    TAKOSUMI_SHARED_AUTH_API_KEYS: "enabled",
  });
  expect(uploaded.triggers.crons).toEqual(["* * * * *", "*/5 * * * *"]);
  expect(result.activationArgs).toContain(`${CODE_DEPLOYED_ID}@100%`);
  expect(result.activationArgs).not.toContain("--containers-rollout");
  expect(result.results).toEqual([expect.objectContaining({
    kind: "takosumi.platform-worker-staging-hosted-auth-maintenance@v1", status: "ready",
    predecessorVersionId: CODE_PREDECESSOR_ID, deployedVersionId: CODE_DEPLOYED_ID, hostedVersionId: STATUS_VERSION_ID,
  })]);
});

test("Hosted auth maintenance refuses inexact staging inputs before provider mutation", async () => {
  const args = [
    "apply", "--config", "/configuration/wrangler.toml", "--predecessor", CODE_PREDECESSOR_ID,
    "--hosted-version", STATUS_VERSION_ID, "--entry-digest", `sha256:${"d".repeat(64)}`,
    "--dashboard-digest", `sha256:${"e".repeat(64)}`,
  ];
  for (const [arguments_, environment] of [
    [args, "production"], [args.map((arg) => arg === "--hosted-version" ? "--issuer-version" : arg), "staging"],
    [["resume", ...args.slice(1)], "staging"],
  ] as const) {
    await expect(runPlatformWorkerHostedAuthMaintenanceActivation(arguments_, environment))
      .rejects.toThrow("platform_worker_hosted_auth_maintenance_activation_arguments_invalid");
  }
  for (const options of [
    { hostedMaintenance: "routine" }, { hostedMaintenance: "wrong-flag" }, { hostedMaintenance: "missing-cron" },
    { hostedMaintenance: "already-present" }, { hostedMaintenance: "predecessor-secret" },
    { hostedMaintenance: "wrong-entry" }, { hostedMaintenance: "wrong-dashboard" }, { hostedMaintenance: "changed-bundle" },
    { hostedMaintenance: "unserved-secret-version" }, { hostedMaintenance: "transition", unrelatedBindingDrift: true },
  ] as const) {
    const result = await exerciseCodeLane(options);
    expect(result.error).toBeDefined();
    expect(result).toMatchObject({ uploadCount: 0, activationCount: 0, results: [] });
  }
});

test("Hosted auth maintenance fails closed when the selected Hosted service is ambiguous or changes", async () => {
  for (const hostedMaintenance of ["dependency-changed", "dependency-split", "dependency-malformed"] as const) {
    const result = await exerciseCodeLane({ hostedMaintenance });
    expect(result.error).toBeDefined();
    expect(result).toMatchObject({ gateCount: 0, buildCount: 0, uploadCount: 0, activationCount: 0 });
  }
  const beforeUpload = await exerciseCodeLane({ hostedMaintenance: "dependency-changed-before-upload" });
  expect(beforeUpload.error).toBeDefined();
  expect(beforeUpload).toMatchObject({
    buildCount: 1, uploadCount: 0, activationCount: 0, hostedReadPhases: ["before-build", "before-upload"],
  });
  for (const hostedMaintenance of ["dependency-changed-after-upload", "intervening-secret-version"] as const) {
    const afterUpload = await exerciseCodeLane({ hostedMaintenance });
    expect(afterUpload.error).toBeDefined();
    expect(afterUpload).toMatchObject({ uploadCount: 1, activationCount: 0 });
    expect(afterUpload.results[0]).toMatchObject({ status: "incomplete", mutation: "upload" });
  }
  const afterActivation = await exerciseCodeLane({ hostedMaintenance: "dependency-changed-after-activation" });
  expect(afterActivation.error).toBeDefined();
  expect(afterActivation).toMatchObject({ uploadCount: 1, activationCount: 1, publicReadbackCount: 1 });
  expect(afterActivation.results[0]).toMatchObject({
    status: "incomplete", mutation: "activate", expectedHostedVersionId: STATUS_VERSION_ID,
  });
});

test("Hosted auth maintenance refuses a sealed entry changed during preflight", async () => {
  const result = await exerciseCodeLane({ hostedMaintenance: "bundle-changed-before-upload" });
  expect(result.error).toMatchObject({ message: "platform_worker_hosted_auth_maintenance_activation_artifact_changed" });
  expect(result).toMatchObject({ buildCount: 1, uploadCount: 0, activationCount: 0 });
});

test("Hosted auth maintenance refuses a late secret-only Version before upload", async () => {
  const beforeUpload = await exerciseCodeLane({ hostedMaintenance: "late-secret-version-before-upload" });
  expect(beforeUpload.error).toMatchObject({ message: "platform_worker_hosted_auth_maintenance_activation_secret_predecessor_changed" });
  expect(beforeUpload).toMatchObject({ uploadCount: 0, activationCount: 0, results: [] });
});

test("Hosted auth maintenance refuses a late secret-only Version before activation", async () => {
  const beforeActivation = await exerciseCodeLane({ hostedMaintenance: "late-secret-version-before-activation" });
  expect(beforeActivation.error).toMatchObject({
    message: "platform_worker_code_release_incomplete",
    cause: expect.objectContaining({ message: "platform_worker_hosted_auth_maintenance_activation_secret_predecessor_changed" }),
  });
  expect(beforeActivation).toMatchObject({ uploadCount: 1, activationCount: 0 });
  expect(beforeActivation.results[0]).toMatchObject({ status: "incomplete", mutation: "upload" });
});

test("Hosted auth maintenance checks local configuration and artifacts after reading upload history", async () => {
  for (const hostedHistoryCustodyDrift of ["config", "assets", "bundle"] as const) {
    const result = await exerciseCodeLane({ hostedMaintenance: "transition", hostedHistoryCustodyDrift });
    expect(result.error).toBeDefined();
    expect(result).toMatchObject({ uploadCount: 0, activationCount: 0, results: [] });
  }
});

test("login admission refuses missing composition, partial predecessors and unrelated drift before upload", async () => {
  for (const options of [
    { loginAdmission: "missing" }, { loginAdmission: "partial" }, { loginAdmission: "already-present" },
    { loginAdmission: "transition", unrelatedBindingDrift: true },
  ] as const) {
    const result = await exerciseCodeLane(options);
    expect(result.error).toBeDefined();
    expect(result.uploadCount).toBe(0);
    expect(result.activationCount).toBe(0);
    expect(result.loginSmokeCount).toBe(0);
  }
});

test("login admission failed post-activation smoke stays incomplete without a second mutation", async () => {
  const result = await exerciseCodeLane({ loginAdmission: "transition", loginSmokeFails: true });
  expect((result.error as Error).message).toBe("platform_worker_code_release_incomplete");
  expect(result).toMatchObject({ uploadCount: 1, activationCount: 1, loginSmokeCount: 1 });
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    status: "incomplete",
    mutation: "activate",
    predecessorVersionId: CODE_PREDECESSOR_ID,
    candidateVersionId: CODE_DEPLOYED_ID,
    observedServingVersionId: CODE_DEPLOYED_ID,
    loginStartFailure: { reason: "unexpected_http_status", httpStatus: 503, servingVersion: "match" },
  });
  expect(JSON.stringify(result.results[0])).not.toContain("fixture-sensitive");
});

test("routine code refuses every route drift before upload and after activation", async () => {
  for (const routeDrift of [
    "id",
    "add",
    "remove",
    "pattern",
    "fail-open",
  ] as const) {
    const before = await exerciseCodeLane({ topologyDriftAt: 2, routeDrift });
    expect(before.error).toBeInstanceOf(Error);
    expect(before).toMatchObject({ uploadCount: 0, activationCount: 0 });

    const after = await exerciseCodeLane({ topologyDriftAt: 3, routeDrift });
    expect((after.error as Error).message).toBe(
      "platform_worker_code_release_incomplete",
    );
    expect(after).toMatchObject({ uploadCount: 1, activationCount: 1 });
  }
});

test("routine code refuses Container attachment drift before upload and after activation", async () => {
  const before = await exerciseCodeLane({ topologyDriftAt: 2, containerDrift: true });
  expect((before.error as Error).message).toBe(
    "platform_worker_code_topology_mismatch",
  );
  expect(before).toMatchObject({ uploadCount: 0, activationCount: 0 });

  const after = await exerciseCodeLane({ topologyDriftAt: 3, containerDrift: true });
  expect((after.error as Error).message).toBe(
    "platform_worker_code_release_incomplete",
  );
  expect(((after.error as Error).cause as Error).message).toBe(
    "platform_worker_code_topology_mismatch",
  );
  expect(after).toMatchObject({ uploadCount: 1, activationCount: 1 });
});

test("routine code never retries a lost acknowledgement", async () => {
  const lost = await exerciseCodeLane({ uploadFails: true });
  expect(lost.error).toBeInstanceOf(Error);
  expect((lost.error as Error).message).toBe("platform_worker_code_release_incomplete");
  expect(lost).toMatchObject({ uploadCount: 1, activationCount: 0 });
  const [result] = lost.results;
  expect(lost.results).toHaveLength(1);
  expect(result).toMatchObject({ status: "incomplete", mutation: "upload" });
  expect(result).not.toHaveProperty("candidateVersionId");
  expect(result).not.toHaveProperty("observedServingVersionId");
});

test("incomplete staging code output retains the Version from the upload acknowledgement", async () => {
  const result = await exerciseCodeLane({ uploadReadbackFails: true });
  expect(result).toMatchObject({ uploadCount: 1, activationCount: 0 });
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    kind: "takosumi.platform-worker-staging-code@v1",
    status: "incomplete",
    mutation: "upload",
    predecessorVersionId: CODE_PREDECESSOR_ID,
    candidateVersionId: CODE_DEPLOYED_ID,
    entryDigest: platformExecutionEvidenceReleasePins(CODE_BUNDLE, STATUS_CONTAINER_IMAGE).controllerArtifactDigest,
    dashboardDigest: `sha256:${"d".repeat(64)}`,
    releaseTag: `tks-stg-code-${"1".repeat(32)}`,
  });
  expect(result.results[0]).not.toHaveProperty("observedServingVersionId");
  expect(result.results[0]).not.toHaveProperty("authorityDrift");
});

test("incomplete resume reports observed serving Version and drift sections after activation", async () => {
  const options = { resume: "valid", topologyDriftAt: 3, containerFailsAfterActivation: true } as const;
  const result = await exerciseCodeLane(options);
  expect(result).toMatchObject({ uploadCount: 0, activationCount: 1 });
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    status: "incomplete",
    mutation: "activate",
    candidateVersionId: CODE_DEPLOYED_ID,
    observedServingVersionId: CODE_DEPLOYED_ID,
    authorityDrift: ["container", "topology"],
    containerDriftFields: ["health.failed"],
  });
  expect(((result.error as Error).cause as Error).message).toBe("platform_worker_code_authority_drift");
  const before = await exerciseCodeLane({ ...options, topologyDriftAt: 2 });
  expect(before).toMatchObject({ results: [], uploadCount: 0, activationCount: 0 });
  const lost = await exerciseCodeLane({ resume: "valid", activationFails: true });
  expect(lost).toMatchObject({ uploadCount: 0, activationCount: 1 });
  expect(lost.results).toHaveLength(1);
  expect(lost.results[0]).toMatchObject({ status: "incomplete", candidateVersionId: CODE_DEPLOYED_ID });
  expect(lost.results[0]).not.toHaveProperty("observedServingVersionId");
});

test("incomplete staging code identifies the Container field that blocked activation", async () => {
  const result = await exerciseCodeLane({ candidateReadFailures: 1, containerFailsAfterUpload: true });
  expect(result.uploadCount).toBe(1);
  expect(result.activationCount).toBe(0);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    status: "incomplete",
    mutation: "upload",
    candidateVersionId: CODE_DEPLOYED_ID,
    authorityDrift: ["container"],
    containerDriftFields: ["health.failed"],
  });
});

test("platform release owns isolated staging and production targets", () => {
  expect(platformTargetForEnvironment("staging")).toEqual({
    origin: "https://app-staging.takosumi.com",
    workerName: "takosumi-staging",
    hostedService: "takosumi-hosted-staging",
  });
  expect(platformTargetForEnvironment("production")).toEqual({
    origin: "https://app.takosumi.com",
    workerName: "takosumi",
    hostedService: "takosumi-hosted",
  });
});

test("official platform builds pin the matching Takosumi Store by environment", () => {
  expect(
    platformDashboardBuildEnvironment("staging")
      .VITE_TAKOSUMI_TCS_STORE_URL,
  ).toBe("https://store-staging.takosumi.com");
  expect(
    platformDashboardBuildEnvironment("production")
      .VITE_TAKOSUMI_TCS_STORE_URL,
  ).toBe("https://store.takosumi.com");
});

test("production config must bind the isolated production Hosted service", () => {
  const broker = (overrides: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = {
      connectionId: "conn_takoserverTakoform01",
      recipeId: "takoserver-takoform-run-v1",
      providerSource: "registry.terraform.io/tako0614/takoform",
      displayName: "Takoserver",
      exchangePath: "/provider-credentials/takoform",
      envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
      runCredentialSettings: { requiredAvailableMinor: 2300 },
      publicInputExchangePath: "/public-inputs/http-endpoint",
      publicInputCapabilities: ["http_endpoint_url"],
      runtimeInputs: {
        contract: "takosumi.provider-runtime-inputs/v1",
        nonceArgument: "runtime_input_nonce",
        mapArgument: "runtime_inputs",
        minimumProviderVersion: "4.0.0",
      },
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete base[key];
      else base[key] = value;
    }
    return base;
  };
  const source = (
    service: string,
    includeBroker = true,
    basePath = "/api/v1/account/subscription",
    includeVersionMetadata = true,
    includeRequestSignal = true,
    brokerOverrides: Record<string, unknown> = {},
    extras: {
      readonly descriptors?: readonly unknown[];
      readonly services?: readonly {
        readonly binding: string;
        readonly service: string;
      }[];
    } = {},
  ) => `
name = "takosumi"
compatibility_flags = ["nodejs_compat"${includeRequestSignal ? ', "enable_request_signal"' : ""}]
[assets]
binding = "ASSETS"
${includeVersionMetadata ? '[version_metadata]\nbinding = "TAKOSUMI_VERSION_METADATA"' : ""}
[[services]]
binding = "HOSTED"
service = "${service}"
${(extras.services ?? [])
  .map(
    (entry) =>
      `[[services]]\nbinding = "${entry.binding}"\nservice = "${entry.service}"`,
  )
  .join("\n")}
[vars]
TAKOSUMI_ENVIRONMENT = "production"
TAKOSUMI_PLATFORM_EXTENSIONS = '${JSON.stringify([
    {
      id: "takosumi-hosted-sponsorship",
      basePath,
      handlerKey: "HOSTED",
      authDelivery: "context",
      ownsPathSubtree: true,
      workspaceContext: "query-required",
      ...(includeBroker
        ? {
            runCredential: {
              audience: "takosumi-hosted.takoform.v1",
              requiredScopes: ["takoform.run"],
            },
            providerCredentialBroker: broker(brokerOverrides),
          }
        : {}),
    },
    {
      id: "takosumi-ai",
      basePath: "/api/v1/ai",
      handlerKey: "HOSTED",
      authDelivery: "context",
      ownsPathSubtree: true,
      workspaceContext: "query-optional",
      selfServicePatScopes: ["ai.models.read", "ai.chat"],
      requestScopeRules: [
        {
          path: "/models",
          methods: ["GET"],
          requiredScopes: ["ai.models.read"],
        },
        {
          path: "/chat/completions",
          methods: ["POST"],
          requiredScopes: ["ai.chat"],
        },
      ],
      capabilities: ["openai.models.v1", "openai.chat-completions.v1"],
    },
    ...(extras.descriptors ?? []),
  ])}'
`;
  const billingDescriptor = {
    id: "hosted-workspace-billing",
    basePath: "/api/v1/billing",
    handlerKey: "HOSTED",
    authMode: "platform",
    authDelivery: "context",
    workspaceContext: "query-required",
    ownsPathSubtree: true,
    contributions: [
      {
        id: "hosted-workspace-billing",
        slot: "workspace.billing",
        href: "/api/v1/billing",
        presentation: "link",
        label: "使用量と課金",
        labels: { en: "Usage and billing", ja: "使用量と課金" },
      },
    ],
  };
  const stagingSource = (
    descriptors: readonly unknown[],
    profile = "shared-account",
    origin = "https://app-staging.takosumi.com",
    services: readonly { readonly binding: string; readonly service: string }[] = [],
  ) =>
    source("takosumi-hosted-staging", true, "/api/v1/account/subscription", true, true, {}, { descriptors, services })
      .replace('name = "takosumi"', 'name = "takosumi-staging"')
      .replace(
        'TAKOSUMI_ENVIRONMENT = "production"',
        `TAKOSUMI_ENVIRONMENT = "staging"\nTAKOSUMI_SHARED_AUTH_PROFILE = "${profile}"\nTAKOSUMI_SHARED_AUTH_ORIGIN = "${origin}"`,
      );

  // The staging candidate is accepted only after the release validator gains
  // its exact, shared-auth-gated descriptor exception.
  expect(() =>
    assertConfigTargetsSource(stagingSource([billingDescriptor]), "staging"),
  ).not.toThrow();
  const secondaryRoute = {
    id: "hosted-secondary",
    basePath: "/extensions/secondary",
    handlerKey: "SECONDARY",
    authDelivery: "context",
    ownsPathSubtree: true,
  };
  const secondaryService = { binding: "SECONDARY", service: "takosumi-secondary" };
  const nonOverlappingSource = stagingSource(
    [billingDescriptor, secondaryRoute],
    "shared-account",
    "https://app-staging.takosumi.com",
    [secondaryService],
  );
  expect(() => assertConfigTargetsSource(nonOverlappingSource, "staging")).not.toThrow();
  const nonOverlappingVars = (Bun.TOML.parse(nonOverlappingSource) as {
    vars: Record<string, unknown>;
  }).vars;
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: nonOverlappingVars.TAKOSUMI_PLATFORM_EXTENSIONS,
      TAKOSUMI_SHARED_AUTH_PROFILE: nonOverlappingVars.TAKOSUMI_SHARED_AUTH_PROFILE as string,
      TAKOSUMI_SHARED_AUTH_ORIGIN: nonOverlappingVars.TAKOSUMI_SHARED_AUTH_ORIGIN as string,
    }),
  ).not.toThrow();

  const runtimeRoutesFor = (configSource: string) => {
    const vars = (Bun.TOML.parse(configSource) as {
      vars: Record<string, unknown>;
    }).vars;
    return platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: vars.TAKOSUMI_PLATFORM_EXTENSIONS,
      TAKOSUMI_SHARED_AUTH_PROFILE: vars.TAKOSUMI_SHARED_AUTH_PROFILE as string,
      TAKOSUMI_SHARED_AUTH_ORIGIN: vars.TAKOSUMI_SHARED_AUTH_ORIGIN as string,
    });
  };
  const conflictingRoutes = [
    {
      route: { ...secondaryRoute, basePath: "/api/v1/billing" },
      runtimeError: "platform extension basePath /api/v1/billing has multiple owners",
    },
    {
      route: { ...secondaryRoute, basePath: "/api/v1" },
      runtimeError: "overlaps a Takosumi core route prefix",
    },
    {
      route: { ...secondaryRoute, basePath: "/api/v1/billing/tenant" },
      runtimeError: "overlaps a Takosumi core route prefix",
    },
  ] as const;
  for (const { route, runtimeError } of conflictingRoutes) {
    const conflictingSource = stagingSource(
      [billingDescriptor, route],
      "shared-account",
      "https://app-staging.takosumi.com",
      [secondaryService],
    );
    expect(() => runtimeRoutesFor(conflictingSource)).toThrow(runtimeError);
    // The release validator must reject what the owning runtime parser or
    // merge refuses, while allowing the disjoint /extensions route above.
    expect(() => assertConfigTargetsSource(conflictingSource, "staging")).toThrow(
      "platform_worker_release_config_source_invalid",
    );
  }
  for (const malformed of [
    { ...billingDescriptor, id: "unknown-third-route" },
    { ...billingDescriptor, unexpected: true },
    { ...billingDescriptor, authMode: "handler" },
    { ...billingDescriptor, basePath: "/api/v1/account" },
    {
      ...billingDescriptor,
      contributions: [...billingDescriptor.contributions, billingDescriptor.contributions[0]],
    },
    {
      ...billingDescriptor,
      contributions: [{ ...billingDescriptor.contributions[0], slot: "workspace.admin" }],
    },
  ]) {
    expect(() => assertConfigTargetsSource(stagingSource([malformed]), "staging")).toThrow(
      "platform_worker_release_config_source_invalid",
    );
  }
  expect(() =>
    assertConfigTargetsSource(stagingSource([billingDescriptor, billingDescriptor]), "staging"),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted", true, "/api/v1/account/subscription", true, true, {}, {
        descriptors: [billingDescriptor],
      }),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(stagingSource([billingDescriptor], "disabled"), "staging"),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      stagingSource([billingDescriptor], "shared-account", "https://app.takosumi.com"),
      "staging",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      stagingSource([billingDescriptor]).replace(
        'TAKOSUMI_ENVIRONMENT = "staging"',
        'TAKOSUMI_ENVIRONMENT = "production"',
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted"),
      "production",
    ),
  ).not.toThrow();
  const withSponsorshipField = (field: string, value: unknown) =>
    source("takosumi-hosted").replace(
      '"workspaceContext":"query-required"',
      `"workspaceContext":"query-required","${field}":${JSON.stringify(value)}`,
    );
  for (const [field, value] of [
    ["authMode", "platform"],
    ["selfServicePatScopes", []],
    ["requestScopeRules", []],
    ["capabilities", []],
    ["contributions", []],
  ] as const) {
    expect(() =>
      assertConfigTargetsSource(
        withSponsorshipField(field, value),
        "production",
      ),
    ).toThrow("platform_worker_release_config_source_invalid");
  }
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted").replace(
        '"workspaceContext":"query-optional"',
        '"workspaceContext":"query-required"',
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted").replace(
        '"workspaceContext":"query-required"',
        '"workspaceContext":"query-optional"',
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted-staging"),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  // A realized config carries identity, not paths. Declaring either source
  // path is refused with its own code, because the tool injects both from the
  // commit the config's source pin names.
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted").replace(
        'name = "takosumi"',
        `name = "takosumi"\nmain = "${resolve(root, "deploy/platform/worker.ts")}"`,
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_declares_source_path");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted").replace(
        'name = "takosumi"',
        `name = "takosumi"\n"main" = "${resolve(root, "deploy/platform/worker.ts")}"`,
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_declares_source_path");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted").replace(
        "[assets]",
        `[assets]\ndirectory = "${resolve(root, "dashboard/dist")}"`,
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_declares_source_path");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted").replace(
        "[assets]",
        `[assets]\n"directory" = "${resolve(root, "dashboard/dist")}"`,
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_declares_source_path");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted").replace(
        "[assets]",
        `assets.directory = "${resolve(root, "dashboard/dist")}"`,
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_declares_source_path");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        false,
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        true,
        "/v1/hosted/subscription",
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        true,
        "/api/v1/hosted/subscription",
        false,
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        true,
        "/api/v1/account/subscription",
        true,
        false,
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");

  // The Capsule public-origin seam and the run-scoped sensitive-input lane are
  // REQUIRED of the realized broker, not merely tolerated: a platform released
  // without them serves Capsules that fail closed at plan.
  const withBroker = (
    overrides: Record<string, unknown>,
    extras: {
      readonly descriptors?: readonly unknown[];
      readonly services?: readonly {
        readonly binding: string;
        readonly service: string;
      }[];
    } = {},
  ) =>
    source(
      "takosumi-hosted",
      true,
      "/api/v1/account/subscription",
      true,
      true,
      overrides,
      extras,
    );
  const runtimeInputs = {
    contract: "takosumi.provider-runtime-inputs/v1",
    nonceArgument: "runtime_input_nonce",
    mapArgument: "runtime_inputs",
    minimumProviderVersion: "4.0.0",
  };
  const providerSource = "registry.terraform.io/tako0614/takoform";
  const renewableCapability =
    REFERENCE_PROVIDER_RENEWABLE_ENV_CAPABILITIES.find((entry) =>
      entry.terraformSource.includes(providerSource),
    );
  if (!renewableCapability) {
    throw new Error("takoform_renewable_capability_missing");
  }
  const renewableEnv = renewableCapability.renewableEnv;
  // Existing realized configs retain their exact ten-key composition until
  // the operator explicitly opts in to the newer provider protocol.
  expect(() => assertConfigTargetsSource(withBroker({}), "production")).not.toThrow();
  // The old fixed Connection must never be upgraded in place: the opt-in
  // descriptor carries a second, exact Connection id.
  expect(() =>
    assertConfigTargetsSource(withBroker({ renewableEnv }), "production"),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      withBroker({
        renewableEnv,
        renewableConnectionId: "conn_takoserverTakoformRenew01",
      }),
      "production",
    ),
  ).not.toThrow();
  for (const renewableConnectionId of [
    "conn_takoserverTakoform01",
    "conn_takoserverTakoformRenew02",
  ]) {
    expect(() =>
      assertConfigTargetsSource(
        withBroker({ renewableEnv, renewableConnectionId }),
        "production",
      ),
    ).toThrow("platform_worker_release_config_source_invalid");
  }
  expect(() =>
    assertConfigTargetsSource(
      withBroker({
        renewableConnectionId: "conn_takoserverTakoformRenew01",
      }),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  for (const renewableOverride of [
    { ...renewableEnv, minimumProviderVersion: "4.0.0" },
    { ...renewableEnv, sourceEnvName: "TAKOFORM_ENDPOINT" },
    { ...renewableEnv, fileEnvName: "TAKOFORM_TOKEN" },
    { ...renewableEnv, unrecognized: true },
  ]) {
    expect(() =>
      assertConfigTargetsSource(
        withBroker({
          renewableEnv: renewableOverride,
          renewableConnectionId: "conn_takoserverTakoformRenew01",
        }),
        "production",
      ),
    ).toThrow("platform_worker_release_config_source_invalid");
  }
  for (const envNames of [
    ["PROVIDER_ENDPOINT", "PROVIDER_SPACE", "PROVIDER_OTHER"],
    [
      "PROVIDER_ENDPOINT",
      renewableEnv.sourceEnvName,
      renewableEnv.fileEnvName,
    ],
  ]) {
    expect(() =>
      assertConfigTargetsSource(
        withBroker({
          envNames,
          renewableEnv,
          renewableConnectionId: "conn_takoserverTakoformRenew01",
        }),
        "production",
      ),
    ).toThrow("platform_worker_release_config_source_invalid");
  }
  const referenceRecipe = REFERENCE_CREDENTIAL_RECIPES.find(
    (recipe) => recipe.id === "takoform",
  );
  expect(referenceRecipe?.authModes.token?.renewableEnv).toBeUndefined();
  expect(
    matchesHostedRenewableEnvDescriptor(
      renewableEnv,
      referenceRecipe?.envNames,
      providerSource,
    ),
  ).toBeTrue();
  expect(
    matchesHostedRenewableEnvDescriptor(
      renewableEnv,
      referenceRecipe?.envNames,
      providerSource,
      [],
    ),
  ).toBeFalse();
  expect(
    matchesHostedRenewableEnvDescriptor(
      renewableEnv,
      referenceRecipe?.envNames,
      providerSource,
      [renewableCapability, renewableCapability],
    ),
  ).toBeFalse();
  expect(
    matchesHostedRenewableEnvDescriptor(
      { ...renewableEnv, minimumProviderVersion: "4.2.0" },
      referenceRecipe?.envNames,
      providerSource,
    ),
  ).toBeFalse();
  for (const overrides of [
    { publicInputExchangePath: undefined },
    { publicInputCapabilities: undefined },
    { runtimeInputs: undefined },
    { publicInputExchangePath: "/public-inputs/origin" },
    { publicInputCapabilities: [] },
    { publicInputCapabilities: ["http_endpoint_url", "http_endpoint_url"] },
    { publicInputCapabilities: ["https_endpoint_url"] },
    { publicInputCapabilities: "http_endpoint_url" },
    { runtimeInputs: { ...runtimeInputs, nonceArgument: "nonce" } },
    { runtimeInputs: { ...runtimeInputs, mapArgument: "inputs" } },
    { runtimeInputs: { ...runtimeInputs, minimumProviderVersion: "3.0.0" } },
    { runtimeInputs: { ...runtimeInputs, contract: "takosumi.v1" } },
    {
      runtimeInputs: {
        contract: runtimeInputs.contract,
        nonceArgument: runtimeInputs.nonceArgument,
        mapArgument: runtimeInputs.mapArgument,
      },
    },
    { runtimeInputs: { ...runtimeInputs, sealed: true } },
    { publicInputReservationRef: "ref_1" },
  ]) {
    expect(() =>
      assertConfigTargetsSource(
        withBroker(overrides),
        "production",
      ),
    ).toThrow("platform_worker_release_config_source_invalid");
  }

  // A route that dispatches to a declared binding and answers no public-input
  // question is composable alongside the pinned pair.
  const secondaryBroker = (extra: Record<string, unknown>) => ({
    id: "takosumi-secondary",
    basePath: "/api/v1/secondary",
    handlerKey: "SECONDARY",
    authDelivery: "context",
    ownsPathSubtree: true,
    providerCredentialBroker: {
      connectionId: "conn_secondaryTakoform01",
      recipeId: "secondary-takoform-run-v1",
      providerSource: "registry.terraform.io/tako0614/takoform",
      displayName: "Secondary",
      exchangePath: "/provider-credentials/takoform",
      envNames: ["TAKOFORM_ENDPOINT"],
      ...extra,
    },
  });
  expect(() =>
    assertConfigTargetsSource(
      withBroker(
        {},
        {
          descriptors: [secondaryBroker({})],
          services: [{ binding: "SECONDARY", service: "takosumi-secondary" }],
        },
      ),
      "production",
    ),
  ).not.toThrow();
  // A second route claiming the public-origin question makes
  // `capsulePublicOriginFromPlatformExtensions` throw at runtime, so the
  // release refuses the composition instead of shipping it.
  expect(() =>
    assertConfigTargetsSource(
      withBroker(
        {},
        {
          descriptors: [
            secondaryBroker({
              publicInputExchangePath: "/public-inputs/http-endpoint",
              publicInputCapabilities: ["http_endpoint_url"],
            }),
          ],
          services: [{ binding: "SECONDARY", service: "takosumi-secondary" }],
        },
      ),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  // An unbound handlerKey is an unroutable route that would only fail on the
  // first real request after an irreversible upload.
  expect(() =>
    assertConfigTargetsSource(
      withBroker({}, { descriptors: [secondaryBroker({})] }),
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
});

test("public release readback ignores capabilities owned by another extension", () => {
  const origin = "https://app.takosumi.com";
  const discovery = {
    endpoints: {
      extensions: {
        "openai.models.v1": `${origin}/api/v1/ai`,
        "openai.chat-completions.v1": `${origin}/api/v1/ai`,
        "takosumi.account.subscription.v1": `${origin}/api/v1/account/subscription`,
        "hosted-resource.inventory.v1": `${origin}/api/v1/account/subscription`,
        "generic.extension.v1": `${origin}/api/v1/generic`,
      },
    },
  };
  expect(hasHostedDiscovery(discovery, origin)).toBeTrue();
  expect(
    hasHostedDiscovery(
      {
        endpoints: {
          extensions: {
            ...discovery.endpoints.extensions,
            "openai.models.v1": `${origin}/api/v1/wrong-ai`,
          },
        },
      },
      origin,
    ),
  ).toBeFalse();
});

test("platform release parser exposes reviewed plan, execute, recovery, and restore actions", () => {
  expect(
    parsePlatformWorkerReleaseArgs([
      "status",
      "--config",
      "/private/wrangler.staging.toml",
    ]),
  ).toEqual({
    action: "status",
    config: "/private/wrangler.staging.toml",
  });
  expect(
    parsePlatformWorkerReleaseArgs([
      "plan",
      "--config",
      "/private/wrangler.staging.toml",
      "--runner-build-evidence",
      "/private/runner-build.jsonl",
      "--plan-out",
      "/private/plan.json",
    ]),
  ).toEqual({
    action: "plan",
    config: "/private/wrangler.staging.toml",
    runnerBuildEvidence: "/private/runner-build.jsonl",
    planOut: "/private/plan.json",
  });
  expect(() =>
    parsePlatformWorkerReleaseArgs([
      "plan",
      "--config",
      "/private/wrangler.staging.toml",
      "--plan-out",
      "/private/plan.json",
    ]),
  ).toThrow("platform_worker_release_runner_image_proof_required");
  expect(() =>
    parsePlatformWorkerReleaseArgs([
      "execute",
      "--plan",
      "/private/plan.json",
      "--confirm",
      "sha256:sentinel",
      "--review",
      "operator:reviewer",
      "--evidence",
      "/private/evidence.json",
      "--unknown",
      "sentinel",
    ]),
  ).toThrow("platform_worker_release_arguments_invalid");
  expect(
    parsePlatformWorkerReleaseArgs([
      "recover",
      "--plan",
      "/private/plan.json",
      "--confirm",
      "sha256:confirmation",
      "--review",
      "operator:reviewer",
      "--evidence",
      "/private/recovered.json",
    ]),
  ).toEqual({
    action: "recover",
    plan: "/private/plan.json",
    confirmation: "sha256:confirmation",
    reviewer: "operator:reviewer",
    evidence: "/private/recovered.json",
  });
  expect(
    parsePlatformWorkerReleaseArgs([
      "restore",
      "--plan",
      "/private/plan.json",
      "--confirm",
      "sha256:confirmation",
      "--review",
      "operator:reviewer",
      "--evidence",
      "/private/restored.json",
    ]),
  ).toEqual({
    action: "restore",
    plan: "/private/plan.json",
    confirmation: "sha256:confirmation",
    reviewer: "operator:reviewer",
    evidence: "/private/restored.json",
  });
});

test("read-only platform status accepts a stale source pin and uses only provider read commands", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takosumi-platform-status-"));
  const configPath = join(directory, "wrangler.staging.toml");
  writeFileSync(configPath, statusConfigSource(STATUS_CONTAINER_IMAGE), {
    mode: 0o600,
  });
  writeFileSync(
    `${configPath.slice(0, -".toml".length)}.source.json`,
    JSON.stringify({
      kind: "takosumi.platform-release-source@v1",
      repository: "https://github.com/example/stale-takosumi.git",
      commit: "0".repeat(40),
    }),
    { mode: 0o600 },
  );
  const seen: string[][] = [];
  const container = statusContainerSource();
  const command: PlatformReleaseCommand = async (argv) => {
    seen.push([...argv]);
    if (argv.includes("git") || argv.includes("build") || argv.includes("deploy")) {
      throw new Error("status invoked a forbidden command");
    }
    if (argv[1] === "deployments" && argv[2] === "status") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          versions: [{ version_id: STATUS_VERSION_ID, percentage: 100 }],
        }),
        stderr: "",
      };
    }
    if (argv[1] === "versions" && argv[2] === "view") {
      expect(argv[3]).toBe(STATUS_VERSION_ID);
      return { exitCode: 0, stdout: statusVersionSource(), stderr: "" };
    }
    if (argv[1] === "containers" && argv[2] === "list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([container.summary]),
        stderr: "",
      };
    }
    if (argv[1] === "containers" && argv[2] === "info") {
      return { exitCode: 0, stdout: JSON.stringify(container.detail), stderr: "" };
    }
    throw new Error(`unexpected status command: ${argv.join(" ")}`);
  };

  try {
    const status = await inspectPlatformWorkerStatus(
      configPath,
      "staging",
      { command },
    );
    expect(status).toMatchObject({
      kind: "takosumi.platform-worker-status@v1",
      status: "ready",
      environment: "staging",
      workerName: "takosumi-staging",
      versionId: STATUS_VERSION_ID,
      hostedService: "takosumi-hosted-staging",
      runnerImage: STATUS_CONTAINER_IMAGE,
      sourcePin: {
        repository: "https://github.com/example/stale-takosumi.git",
        commit: "0".repeat(40),
      },
      container: {
        id: STATUS_CONTAINER_ID,
        state: "ready",
        image: STATUS_CONTAINER_IMAGE,
        ready: true,
        hasActiveRollout: false,
        health: { failed: 0, starting: 0, scheduling: 0, errorCount: 0 },
      },
    });
    expect(seen.map((argv) => argv.slice(1, 3))).toEqual([
      ["deployments", "status"],
      ["versions", "view"],
      ["containers", "list"],
      ["containers", "info"],
      ["deployments", "status"],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("platform status rejects wrong immutable Version identity, binding closure, image, and health", async () => {
  const cases = [
    {
      name: "wrong version id",
      version: statusVersionSource("33333333-3333-4333-8333-333333333333"),
      expected: "platform_worker_release_status_version_identity_invalid",
    },
    {
      name: "wrong Hosted service",
      version: statusVersionSource(
        STATUS_VERSION_ID,
        "unreviewed-hosted-service",
      ),
      expected: "platform_worker_release_binding_invalid",
    },
    {
      name: "missing required binding",
      version: statusVersionSource(
        STATUS_VERSION_ID,
        "takosumi-hosted-staging",
        [
          { name: "ASSETS", type: "assets" },
          { name: "HOSTED", type: "service", service: "takosumi-hosted-staging" },
        ],
      ),
      expected: "platform_worker_release_binding_invalid",
    },
  ] as const;
  for (const entry of cases) {
    const directory = mkdtempSync(join(tmpdir(), "takosumi-platform-status-"));
    const configPath = join(directory, "wrangler.staging.toml");
    writeFileSync(configPath, statusConfigSource(STATUS_CONTAINER_IMAGE), {
      mode: 0o600,
    });
    const container = statusContainerSource();
    const command: PlatformReleaseCommand = async (argv) => {
      if (argv[1] === "deployments" && argv[2] === "status") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            versions: [{ version_id: STATUS_VERSION_ID, percentage: 100 }],
          }),
          stderr: "",
        };
      }
      if (argv[1] === "versions" && argv[2] === "view") {
        return { exitCode: 0, stdout: entry.version, stderr: "" };
      }
      if (argv[1] === "containers" && argv[2] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([container.summary]),
          stderr: "",
        };
      }
      if (argv[1] === "containers" && argv[2] === "info") {
        return { exitCode: 0, stdout: JSON.stringify(container.detail), stderr: "" };
      }
      throw new Error(`unexpected status command: ${argv.join(" ")}`);
    };
    try {
      await expect(
        inspectPlatformWorkerStatus(configPath, "staging", { command }),
      ).rejects.toThrow(entry.expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const physicalCases = [
    {
      name: "runner image",
      container: statusContainerSource({
        image:
          `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"d".repeat(64)}`,
      }),
    },
    { name: "unhealthy container", container: statusContainerSource({ failed: 1 }) },
    {
      name: "active rollout",
      container: statusContainerSource({ activeRolloutId: "active-rollout" }),
    },
  ] as const;
  for (const entry of physicalCases) {
    const directory = mkdtempSync(join(tmpdir(), "takosumi-platform-status-"));
    const configPath = join(directory, "wrangler.staging.toml");
    writeFileSync(configPath, statusConfigSource(STATUS_CONTAINER_IMAGE), {
      mode: 0o600,
    });
    const command: PlatformReleaseCommand = async (argv) => {
      if (argv[1] === "deployments" && argv[2] === "status") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            versions: [{ version_id: STATUS_VERSION_ID, percentage: 100 }],
          }),
          stderr: "",
        };
      }
      if (argv[1] === "versions" && argv[2] === "view") {
        return { exitCode: 0, stdout: statusVersionSource(), stderr: "" };
      }
      if (argv[1] === "containers" && argv[2] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([entry.container.summary]),
          stderr: "",
        };
      }
      if (argv[1] === "containers" && argv[2] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(entry.container.detail),
          stderr: "",
        };
      }
      throw new Error(`unexpected status command: ${argv.join(" ")}`);
    };
    try {
      await expect(
        inspectPlatformWorkerStatus(configPath, "staging", { command }),
      ).rejects.toThrow("platform_worker_release_container_not_ready");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("status Version validator does not require release annotations", () => {
  expect(
    assertPlatformWorkerStatusVersion(
      statusVersionSource(),
      "takosumi-hosted-staging",
      STATUS_VERSION_ID,
    ),
  ).toContainEqual({ name: "HOSTED", type: "service" });
});

test("execute rebinds the sealed runner proof to the configured immutable image", () => {
  const config = [
    "[[containers]]",
    'class_name = "OpenTofuRunnerObject"',
    `image = ${JSON.stringify(PROVED_RUNNER_IMAGE)}`,
    "",
  ].join("\n");
  expect(() =>
    assertPlatformRunnerImageProof(config, {
      kind: "takosumi.runner-image-runtime-input-plan-proof@v1",
      image: PROVED_RUNNER_IMAGE,
    }),
  ).not.toThrow();
  expect(() =>
    assertPlatformRunnerImageProof(config, {
      kind: "takosumi.runner-image-runtime-input-plan-proof@v1",
      image:
        `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`,
    }),
  ).toThrow("platform_worker_release_runner_image_proof_invalid");
});

test("platform activation rejects local-only metered v2 and profile-injected v1 proof", () => {
  const config = `[[containers]]\nclass_name = "OpenTofuRunnerObject"\nimage = "${PROVED_RUNNER_IMAGE}"\n`;
  for (const proof of [
    { kind: "takosumi.runner-image-runtime-input-plan-proof@v2", profile: "hosted-metered-v1", qualification: "local-native-only", image: PROVED_RUNNER_IMAGE },
    { kind: "takosumi.runner-image-runtime-input-plan-proof@v1", profile: "hosted-metered-v1", qualification: "local-native-only", image: PROVED_RUNNER_IMAGE },
  ]) expect(() => assertPlatformRunnerImageProof(config, proof)).toThrow("platform_worker_release_runner_image_proof_invalid");
});

test("platform command diagnostics normalize ArrayBuffer output before bounded redaction", () => {
  const encoder = new TextEncoder();
  const stdout = encoder.encode(
    `stdout secret=super-secret ${"x".repeat(3_000)}`,
  ).buffer;
  const stderr = encoder.encode(
    `stderr bearer=super-token ${"y".repeat(3_000)}`,
  ).buffer;

  const diagnostic = platformCommandFailureDiagnostic(
    ["sealed-command", "--config", "/private/config.toml"],
    17,
    false,
    stdout,
    stderr,
  );

  expect(diagnostic).toMatchObject({
    code: "PlatformCommandError",
    message: "sealed-command --config /private/config.toml failed with exit 17",
    command: "sealed-command --config /private/config.toml",
    exitCode: 17,
    timedOut: false,
  });
  expect(diagnostic.stdout.startsWith("stdout [REDACTED] ")).toBeTrue();
  expect(diagnostic.stderr.startsWith("stderr [REDACTED] ")).toBeTrue();
  expect(diagnostic.stdout.length).toBeLessThanOrEqual(2_048);
  expect(diagnostic.stderr.length).toBeLessThanOrEqual(2_048);
});

test("platform release verifies the exact pushed branch without a remote-tracking ref", () => {
  const commit = "4d7194f79cb7a03ce1f99f4d70856c3134aa61f3";
  expect(
    remoteBranchContainsCommit(
      `${commit}\trefs/heads/fix/TASK-0032-generic-install-staging\n`,
      "fix/TASK-0032-generic-install-staging",
      commit,
    ),
  ).toBeTrue();
  expect(
    remoteBranchContainsCommit(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/fix/TASK-0032-generic-install-staging\n",
      "fix/TASK-0032-generic-install-staging",
      commit,
    ),
  ).toBeFalse();
  expect(
    remoteBranchContainsCommit(
      `${commit}\trefs/heads/other\n`,
      "fix/TASK-0032-generic-install-staging",
      commit,
    ),
  ).toBeFalse();
});

test("platform release selects exactly one 100 percent serving Version", () => {
  expect(
    parseServingVersion(
      JSON.stringify({
        id: "deployment-id",
        versions: [
          {
            version_id: "11111111-1111-4111-8111-111111111111",
            percentage: 100,
          },
        ],
      }),
    ),
  ).toBe("11111111-1111-4111-8111-111111111111");
  expect(() =>
    parseServingVersion(
      JSON.stringify([
        { version_id: "11111111-1111-4111-8111-111111111111", percentage: 50 },
        { version_id: "22222222-2222-4222-8222-222222222222", percentage: 50 },
      ]),
    ),
  ).toThrow("platform_worker_release_serving_version_invalid");
});

test("platform container detail may omit state when the unique list state is authoritative", () => {
  const image = `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`;
  const summary = {
    id: "application",
    name: "takosumi-staging-opentofurunnerobject",
    state: "ready",
    image,
    version: 7,
  };
  expect(
    parsePlatformContainerDetail(summary, {
      id: summary.id,
      name: summary.name,
      version: summary.version,
      configuration: { image },
      active_rollout_id: null,
      health: {
        instances: { failed: 0, starting: 0, scheduling: 0 },
        errors: [],
      },
    }),
  ).toMatchObject({
    id: summary.id,
    name: summary.name,
    state: summary.state,
    image,
    version: summary.version,
  });
});

test("platform container detail accepts only a matching bounded present state", () => {
  const image = `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`;
  const summary = {
    id: "application",
    name: "takosumi-staging-opentofurunnerobject",
    state: "ready",
    image,
    version: 7,
  };
  const detail = {
    id: summary.id,
    name: summary.name,
    version: summary.version,
    configuration: { image },
    health: {
      instances: { failed: 0, starting: 0, scheduling: 0 },
      errors: [],
    },
  };
  const cases = [
    { label: "equal", state: "ready", expected: "ready" },
    { label: "mismatch", state: "deploying", expected: null },
    { label: "null", state: null, expected: null },
    { label: "wrong type", state: 7, expected: null },
  ] as const;
  for (const scenario of cases) {
    const candidate = { ...detail, state: scenario.state };
    if (scenario.expected === null) {
      expect(() => parsePlatformContainerDetail(summary, candidate), scenario.label).toThrow(
        "platform_worker_release_container_list_detail_mismatch",
      );
    } else {
      expect(parsePlatformContainerDetail(summary, candidate), scenario.label).toMatchObject({
        state: scenario.expected,
      });
    }
  }
});

test("platform container readback retries a transient list/detail mismatch", async () => {
  const state = {
    id: "application",
    name: "takosumi-staging-opentofurunnerobject",
    state: "ready",
    image: `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`,
    version: 85,
    hasActiveRollout: false,
    health: { failed: 0, starting: 0, scheduling: 0, errorCount: 0 },
  } as const;
  let reads = 0;
  const waits: number[] = [];
  const result = await waitForPlatformContainerReadback(
    state.image,
    async () => {
      reads += 1;
      if (reads === 1) {
        return { ...state, state: "deploying" };
      }
      if (reads === 2) {
        throw new Error("platform_worker_release_container_list_detail_mismatch");
      }
      return state;
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
  );
  expect(result).toEqual(state);
  expect(reads).toBe(3);
  expect(waits).toEqual([5_000, 5_000]);
});

test("platform container readback fails closed after persistent list/detail mismatch", async () => {
  for (const predecessor of [undefined, reviewedRunnerPredecessor]) {
    let reads = 0;
    await expect(
      waitForPlatformContainerReadback(
        reviewedRunnerPredecessor.image,
        async () => {
          reads += 1;
          throw new Error("platform_worker_release_container_list_detail_mismatch");
        },
        async () => {},
        predecessor,
      ),
    ).rejects.toThrow("platform_worker_release_container_list_detail_mismatch");
    expect(reads).toBe(36);
  }
});

const reviewedRunnerPredecessor = {
  id: "application",
  name: "takosumi-staging-opentofurunnerobject",
  state: "ready",
  image: `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`,
  version: 85,
  hasActiveRollout: false,
  health: { failed: 0, starting: 0, scheduling: 0, errorCount: 0 },
} as const;
const reviewedRunnerTarget = {
  ...reviewedRunnerPredecessor,
  image: `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`,
  version: 86,
} as const;

test("reviewed Runner image change can complete after the original read limit", async () => {
  let reads = 0;
  const waits: number[] = [];
  const result = await waitForPlatformContainerReadback(
    reviewedRunnerTarget.image,
    async () => {
      reads += 1;
      if (reads <= 36) {
        return { ...reviewedRunnerPredecessor, hasActiveRollout: true };
      }
      if (reads === 37) {
        return { ...reviewedRunnerTarget, hasActiveRollout: true };
      }
      return reviewedRunnerTarget;
    },
    async (milliseconds) => { waits.push(milliseconds); },
    reviewedRunnerPredecessor,
  );
  expect(result).toEqual(reviewedRunnerTarget);
  expect(reads).toBe(38);
  expect(waits.slice(0, 35)).toEqual(Array<number>(35).fill(5_000));
  expect(waits.slice(35)).toEqual([15_000, 15_000]);
});

test("reviewed Runner image change cannot wait indefinitely on a stale predecessor", async () => {
  let reads = 0;
  const waits: number[] = [];
  await expect(waitForPlatformContainerReadback(
    reviewedRunnerTarget.image,
    async () => { reads += 1; return reviewedRunnerPredecessor; },
    async (milliseconds) => { waits.push(milliseconds); },
    reviewedRunnerPredecessor,
  )).rejects.toThrow("platform_worker_release_container_not_ready");
  expect(reads).toBe(89);
  expect(waits.reduce((sum, delay) => sum + delay, 0)).toBe(960_000);
});

test("reviewed Runner image change refuses a different application or reported failure", async () => {
  for (const [state, diagnostic] of [
    [{ ...reviewedRunnerTarget, id: "recreated" }, "platform_worker_release_container_rollout_mismatch"],
    [{ ...reviewedRunnerTarget, image: reviewedRunnerTarget.image.replace(/c{64}$/u, "d".repeat(64)) },
      "platform_worker_release_container_rollout_mismatch"],
    [{ ...reviewedRunnerTarget, health: { ...reviewedRunnerTarget.health, failed: 1 } },
      "platform_worker_release_container_rollout_failed"],
  ] as const) {
    let reads = 0;
    let waits = 0;
    await expect(waitForPlatformContainerReadback(
      reviewedRunnerTarget.image,
      async () => { reads += 1; return state; },
      async () => { waits += 1; },
      reviewedRunnerPredecessor,
    )).rejects.toThrow(diagnostic);
    expect(reads).toBe(1);
    expect(waits).toBe(0);
  }
});

test("forward preflight rechecks temporary Runner startup before the sole upload", async () => {
  for (const phase of ["starting", "scheduling"] as const) {
    const events: string[] = [];
    const predecessor = reviewedRunnerPredecessor;
    await expect(withPlatformForwardContainerPreflight(
      predecessor,
      async () => {
        events.push("container");
        return events.length === 1
          ? { ...predecessor, health: { ...predecessor.health, [phase]: 1 } }
          : predecessor;
      },
      async () => { events.push("upload"); return CODE_DEPLOYED_ID; },
      async () => { events.push("refresh-worker-and-custody"); },
    )).resolves.toBe(CODE_DEPLOYED_ID);
    expect(events).toEqual(["container", "refresh-worker-and-custody", "container", "upload"]);
  }
});

test("forward preflight bounds startup retries and stops on further drift", async () => {
  const predecessor = reviewedRunnerPredecessor;
  const pending = { ...predecessor, health: { ...predecessor.health, scheduling: 1 } };
  for (const [current, expectedReads] of [
    [pending, 4],
    [{ ...pending, version: predecessor.version + 1 }, 1],
    [{ ...pending, health: { ...pending.health, failed: 1 } }, 1],
  ] as const) {
    let reads = 0;
    let refreshes = 0;
    let uploads = 0;
    await expect(withPlatformForwardContainerPreflight(
      predecessor,
      async () => { reads++; return current; },
      async () => { uploads++; },
      async () => { refreshes++; },
    )).rejects.toThrow("platform_worker_release_predecessor_container_drift");
    expect({ reads, refreshes, uploads }).toEqual({
      reads: expectedReads, refreshes: expectedReads - 1, uploads: 0,
    });
  }
});

type LinkedRolloutFixtureOptions = {
  readonly secondDetail?: (
    detail: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  readonly secondNativeSummary?: (
    summary: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  readonly rollout?: (
    rollout: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
};

function linkedRolloutFixture(options: LinkedRolloutFixtureOptions = {}) {
  const id = "11111111-1111-4111-8111-111111111111";
  const name = "takosumi-staging-opentofurunnerobject";
  const oldImage = `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`;
  const newImage = `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"d".repeat(64)}`;
  const rolloutId = "22222222-2222-4222-8222-222222222222";
  const summary = {
    id,
    name,
    state: "ready",
    image: oldImage,
    version: 113,
  } as const;
  const detail = {
    id,
    name,
    version: 114,
    configuration: { image: newImage },
    health: {
      errors: [],
      instances: {
        active: 0,
        assigned: 0,
        healthy: 7,
        stopped: 0,
        failed: 0,
        scheduling: 0,
        starting: 0,
      },
    },
  } as const;
  const rollout = {
    id: rolloutId,
    kind: "full_auto",
    status: "completed",
    strategy: "rolling",
    created_at: "2026-09-11T00:00:00.000Z",
    last_updated_at: "2026-09-11T00:01:00.000Z",
    current_version: 113,
    target_version: 114,
    current_configuration: { image: oldImage },
    target_configuration: { image: newImage },
    progress: {
      total_steps: 1,
      current_step: 1,
      updated_instances: 7,
      total_instances: 7,
      version_distribution: {
        target_version_instances: 7,
        current_version_instances: 0,
        target_version_percentage: 100,
      },
    },
    health: detail.health,
    steps: [
      {
        id: 1,
        status: "completed",
        step_size: { percentage: 100 },
        started_at: "2026-09-11T00:00:00.000Z",
        completed_at: "2026-09-11T00:00:00.000Z",
      },
    ],
  } as const;
  const settledSummary = {
    ...summary,
    image: newImage,
    version: 114,
  };
  const settledDetail = { ...detail };
  const settledNativeSummary = {
    id,
    name,
    version: 114,
    configuration: { image: newImage },
    account_id: "b".repeat(32),
    health: detail.health,
  };
  const firstNativeSummary = {
    id,
    name,
    version: 113,
    configuration: { image: oldImage },
    account_id: "b".repeat(32),
    health: detail.health,
    active_rollout_id: rolloutId,
  };
  const listPath = `/containers/applications?name=${encodeURIComponent(name)}`;
  const rolloutPath = `/containers/applications/${id}/rollouts/${rolloutId}`;
  const secondDetail = options.secondDetail?.(settledDetail) ?? settledDetail;
  const secondNativeSummary =
    options.secondNativeSummary?.(settledNativeSummary) ?? settledNativeSummary;
  const settledRollout = options.rollout?.(rollout) ?? rollout;
  const nativePaths: string[] = [];
  const commandReads = { list: 0, info: 0 };
  const nativeReads = { list: 0, rollout: 0 };
  const command: PlatformReleaseCommand = async (argv) => {
    const containersIndex = argv.indexOf("containers");
    const action = containersIndex < 0 ? undefined : argv[containersIndex + 1];
    if (action === "list") {
      commandReads.list += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify([commandReads.list === 1 ? summary : settledSummary]),
        stderr: "",
      };
    }
    if (action === "info") {
      commandReads.info += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify(commandReads.info === 1 ? detail : secondDetail),
        stderr: "",
      };
    }
    throw new Error(`unexpected container command: ${argv.join(" ")}`);
  };
  const nativeRead = async (path: string): Promise<unknown> => {
    nativePaths.push(path);
    if (path === listPath) {
      nativeReads.list += 1;
      return [nativeReads.list === 1 ? firstNativeSummary : secondNativeSummary];
    }
    if (path === rolloutPath) {
      nativeReads.rollout += 1;
      return settledRollout;
    }
    throw new Error(`unexpected native path: ${path}`);
  };

  return {
    id,
    name,
    newImage,
    rolloutId,
    listPath,
    rolloutPath,
    command,
    nativeRead,
    nativePaths,
    commandReads,
    nativeReads,
    config: containerReadbackConfig(newImage),
  };
}

test("platform container readback accepts a completed linked rollout", async () => {
  const fixture = linkedRolloutFixture();
  try {
    const state = await readPlatformContainer(
      fixture.config.path,
      "staging",
      fixture.command,
      fixture.nativeRead,
    );

    expect(state).toMatchObject({
      id: fixture.id,
      name: fixture.name,
      state: "ready",
      image: fixture.newImage,
      version: 114,
      hasActiveRollout: false,
      health: { failed: 0, starting: 0, scheduling: 0, errorCount: 0 },
    });
    expect(fixture.commandReads).toEqual({ list: 2, info: 2 });
    expect(fixture.nativeReads).toEqual({ list: 2, rollout: 2 });
    expect(fixture.nativePaths).toHaveLength(4);
    expect(fixture.nativePaths.filter((path) => path === fixture.listPath)).toHaveLength(2);
    expect(fixture.nativePaths.filter((path) => path === fixture.rolloutPath)).toHaveLength(2);
  } finally {
    fixture.config.dispose();
  }
});

test("platform container readback tolerates informational healthy-count drift", async () => {
  const fixture = linkedRolloutFixture({
    secondNativeSummary: (summary) => ({
      ...summary,
      health: {
        errors: [],
        instances: {
          active: 0,
          assigned: 0,
          healthy: 6,
          stopped: 0,
          failed: 0,
          scheduling: 0,
          starting: 0,
        },
      },
    }),
  });
  try {
    const state = await readPlatformContainer(
      fixture.config.path,
      "staging",
      fixture.command,
      fixture.nativeRead,
    );
    expect(state).toMatchObject({
      id: fixture.id,
      name: fixture.name,
      image: fixture.newImage,
      version: 114,
      hasActiveRollout: false,
      health: { failed: 0, starting: 0, scheduling: 0, errorCount: 0 },
    });
  } finally {
    fixture.config.dispose();
  }
});

test("platform container readback rejects a changed second linked-rollout read", async () => {
  const fixture = linkedRolloutFixture({
    secondNativeSummary: (summary) => ({ ...summary, version: 115 }),
  });
  try {
    await expect(
      readPlatformContainer(
        fixture.config.path,
        "staging",
        fixture.command,
        fixture.nativeRead,
      ),
    ).rejects.toThrow(/^platform_worker_release_container_/u);
    expect(fixture.nativeReads.list).toBe(2);
  } finally {
    fixture.config.dispose();
  }
});

test("platform container readback rejects a completed rollout without a full-size step", async () => {
  const fixture = linkedRolloutFixture({
    rollout: (rollout) => ({
      ...rollout,
      steps: [
        {
          id: 1,
          status: "completed",
          completed_at: "2026-09-11T00:00:00.000Z",
        },
      ],
    }),
  });
  try {
    await expect(
      readPlatformContainer(
        fixture.config.path,
        "staging",
        fixture.command,
        fixture.nativeRead,
      ),
    ).rejects.toThrow(/^platform_worker_release_container_/u);
  } finally {
    fixture.config.dispose();
  }
});

test("platform container readback rejects a partially complete rollout", async () => {
  const fixture = linkedRolloutFixture({
    rollout: (rollout) => ({
      ...rollout,
      progress: {
        total_steps: 1,
        current_step: 1,
        updated_instances: 6,
        total_instances: 7,
        version_distribution: {
          target_version_instances: 6,
          current_version_instances: 1,
          target_version_percentage: 86,
        },
      },
    }),
  });
  try {
    await expect(
      readPlatformContainer(
        fixture.config.path,
        "staging",
        fixture.command,
        fixture.nativeRead,
      ),
    ).rejects.toThrow(/^platform_worker_release_container_/u);
  } finally {
    fixture.config.dispose();
  }
});

test("platform container readback refuses an unlinked list/detail mismatch", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const name = "takosumi-staging-opentofurunnerobject";
  const oldImage = `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`;
  const newImage = `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"d".repeat(64)}`;
  const command: PlatformReleaseCommand = async (argv) => {
    const actionIndex = argv.indexOf("containers") + 1;
    const action = argv[actionIndex];
    if (action === "list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ id, name, state: "ready", image: oldImage, version: 113 }]),
        stderr: "",
      };
    }
    if (action === "info") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          id,
          name,
          version: 114,
          configuration: { image: newImage },
          health: {
            errors: [],
            instances: { failed: 0, starting: 0, scheduling: 0 },
          },
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected container command: ${argv.join(" ")}`);
  };

  const config = containerReadbackConfig(newImage);
  try {
    await expect(
      readPlatformContainer(
        config.path,
        "staging",
        command,
        async (path) => {
          if (path === `/containers/applications?name=${name}`) {
            return [
              {
                id,
                name,
                version: 113,
                configuration: { image: oldImage },
                account_id: "b".repeat(32),
                health: {
                  errors: [],
                  instances: { failed: 0, starting: 0, scheduling: 0 },
                },
              },
            ];
          }
          throw new Error(`unexpected native path: ${path}`);
        },
      ),
    ).rejects.toThrow("platform_worker_release_container_list_detail_mismatch");
  } finally {
    config.dispose();
  }
});

test("lost acknowledgement recovery selects one post-plan Version and exact bindings", () => {
  expect(
    selectRecoveredVersion(
      JSON.stringify([
        {
          id: "11111111-1111-4111-8111-111111111111",
          metadata: { created_on: "2026-08-18T16:00:00Z" },
          annotations: { "workers/tag": "platform-release-proof" },
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          metadata: { created_on: "2026-08-18T16:30:00Z" },
          annotations: { "workers/tag": "platform-release-proof" },
        },
      ]),
      "2026-08-18T16:29:00Z",
      "platform-release-proof",
    ),
  ).toBe("22222222-2222-4222-8222-222222222222");
  expect(
    bindingNames(
      JSON.stringify({
        resources: {
          bindings: [{ name: "ASSETS" }, { binding: "HOSTED" }],
        },
      }),
    ),
  ).toEqual(["ASSETS", "HOSTED"]);
});

test("platform release seals the metadata-only secret-name inventory", () => {
  expect(
    secretNames(
      JSON.stringify([
        { name: "OTHER_SECRET", type: "secret_text" },
        {
          name: "TAKOSUMI_HOST_RUNTIME_SECRET_DERIVATION_KEY",
          type: "secret_text",
        },
      ]),
    ),
  ).toEqual([
    "OTHER_SECRET",
    "TAKOSUMI_HOST_RUNTIME_SECRET_DERIVATION_KEY",
  ]);
  expect(() => secretNames('[{"name":"DUP"},{"name":"DUP"}]')).toThrow(
    "platform_worker_release_secret_list_invalid",
  );
});

test("ready evidence requires exact bindings and the fetch handler", () => {
  const version = (
    handlers: readonly string[],
    hostedService = "takosumi-hosted",
    includeRuntimeBinding = true,
  ) =>
    JSON.stringify({
      resources: {
        script: { handlers },
        bindings: [
          { name: "ASSETS", type: "assets" },
          { name: "TAKOSUMI_ACCOUNTS_DB", type: "d1" },
          { name: "TAKOSUMI_CONTROL_DB", type: "d1" },
          {
            name: "HOSTED",
            type: "service",
            service: hostedService,
          },
          { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" },
          ...(includeRuntimeBinding
            ? [
                {
                  name: "TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY",
                  type: "secret_text",
                },
              ]
            : []),
        ],
      },
    });
  expect(() =>
    assertPublishedVersion(version(["fetch"]), "takosumi-hosted"),
  ).not.toThrow();
  expect(() =>
    assertPublishedVersion(
      JSON.stringify({
        resources: {
          script: {
            handlers: ["fetch", "scheduled"],
          },
          bindings: [
            { name: "ASSETS", type: "assets" },
            { name: "TAKOSUMI_ACCOUNTS_DB", type: "d1" },
            { name: "TAKOSUMI_CONTROL_DB", type: "d1" },
            {
              name: "HOSTED",
              type: "service",
              service: "takosumi-hosted",
            },
            {
              name: "TAKOSUMI_VERSION_METADATA",
              type: "version_metadata",
            },
            {
              name: "TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY",
              type: "secret_text",
            },
          ],
        },
      }),
      "takosumi-hosted",
    ),
  ).not.toThrow();
  expect(() =>
    assertPublishedVersion(version(["scheduled"]), "takosumi-hosted"),
  ).toThrow("platform_worker_release_fetch_handler_missing");
  expect(() =>
    assertPublishedVersion(
      version(
        ["fetch"],
        "unreviewed-hosted-service",
      ),
      "takosumi-hosted",
    ),
  ).toThrow("platform_worker_release_binding_invalid");
  expect(() =>
    assertPublishedVersion(
      JSON.stringify({
        resources: {
          script: {
            handlers: ["fetch"],
          },
          bindings: [{ name: "ASSETS" }],
        },
      }),
      "takosumi-hosted",
    ),
  ).toThrow("platform_worker_release_binding_invalid");
  expect(() =>
    assertPublishedVersion(
      version(["fetch"], "takosumi-hosted", false),
      "takosumi-hosted",
    ),
  ).toThrow("platform_worker_release_binding_invalid");
  expect(() =>
    assertPublishedVersion(
      JSON.stringify({
        resources: {
          script: {
            handlers: ["fetch"],
          },
        },
      }),
      "takosumi-hosted",
    ),
  ).toThrow("platform_worker_release_version_invalid");
});

function nativeHostedResourceInventoryConfig() {
  const source = statusConfigSource();
  const parsed = Bun.TOML.parse(source) as { vars: { TAKOSUMI_PLATFORM_EXTENSIONS: string } };
  const inventory = {
    capabilities: ["takosumi.account.subscription.v1", "hosted-resource.inventory.v1"],
    selfServicePatScopes: ["resources:read"],
    requestScopeRules: [{ path: "/resources", methods: ["GET"], requiredScopes: ["resources:read"] }],
    contributions: [{
      id: "takoserver-hosted-resources", slot: "workspace.hosted-resources",
      href: "/api/v1/account/subscription/resources", presentation: "native",
      label: "Hosted resources", labels: { ja: "ホスト済みリソース" },
      description: "Resources managed by Takoserver for this Workspace.",
      descriptions: { ja: "このワークスペースでTakoserverが管理するリソースです。" },
    }],
  };
  const routes = JSON.parse(parsed.vars.TAKOSUMI_PLATFORM_EXTENSIONS) as Array<typeof inventory & Record<string, unknown>>;
  Object.assign(routes[0], inventory);
  return { source, routes, render: (values: unknown) => source.replace(
    /TAKOSUMI_PLATFORM_EXTENSIONS = '[^']+'/u,
    `TAKOSUMI_PLATFORM_EXTENSIONS = '${JSON.stringify(values)}'`,
  ) };
}

test("native Hosted resource inventory survives official platform release validation", () => {
  const { source, routes, render } = nativeHostedResourceInventoryConfig();
  expect(() => assertConfigTargetsSource(source, "staging")).not.toThrow();
  const selected = render(routes);
  expect(() => assertConfigTargetsSource(selected, "staging")).not.toThrow();
  const production = selected.replaceAll('"takosumi-staging"', '"takosumi"')
    .replaceAll('"takosumi-hosted-staging"', '"takosumi-hosted"')
    .replace('TAKOSUMI_ENVIRONMENT = "staging"', 'TAKOSUMI_ENVIRONMENT = "production"');
  expect(() => assertConfigTargetsSource(production, "production")).not.toThrow();
  const runtime = platformExtensionRoutes({ TAKOSUMI_PLATFORM_EXTENSIONS: routes });
  expect(runtime[0]?.contributions?.[0]?.slot).toBe("workspace.hosted-resources");
});

test("native Hosted resource inventory cannot widen release scopes, verbs or contribution authority", () => {
  const { routes, render } = nativeHostedResourceInventoryConfig();
  type InventoryRoute = typeof routes[number];
  const mutations = [
    (route: InventoryRoute) => route.capabilities.push("resources.write"),
    (route: InventoryRoute) => route.selfServicePatScopes.push("resources:write"),
    (route: InventoryRoute) => route.requestScopeRules[0].methods.push("POST"),
    (route: InventoryRoute) => route.requestScopeRules[0].path = "/admin",
    (route: InventoryRoute) => route.contributions[0].href = "/api/v1/account/subscription/other",
    (route: InventoryRoute) => route.contributions[0].slot = "workspace.billing",
    (route: InventoryRoute) => route.contributions[0].presentation = "link",
    (route: InventoryRoute) => route.contributions[0].label = "",
    (route: InventoryRoute) => route.contributions = [],
    (route: InventoryRoute) => route.authMode = "public",
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(routes); mutate(changed[0]);
    expect(() => assertConfigTargetsSource(render(changed), "staging"))
      .toThrow("platform_worker_release_config_source_invalid");
  }
});


test("exact legacy Hosted broker preserves native inventory without advertising unserved protocols", () => {
  const { routes, render } = nativeHostedResourceInventoryConfig();
  const broker = routes[0]!.providerCredentialBroker as Record<string, unknown>;
  delete broker.publicInputExchangePath;
  delete broker.publicInputCapabilities;
  delete broker.runtimeInputs;
  const selected = render(routes);
  expect(() => assertConfigTargetsSource(selected, "staging")).not.toThrow();
  const production = selected.replaceAll('"takosumi-staging"', '"takosumi"')
    .replaceAll('"takosumi-hosted-staging"', '"takosumi-hosted"')
    .replace('TAKOSUMI_ENVIRONMENT = "staging"', 'TAKOSUMI_ENVIRONMENT = "production"');
  expect(() => assertConfigTargetsSource(production, "production")).not.toThrow();
  const env = { TAKOSUMI_PLATFORM_EXTENSIONS: routes, TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com" };
  const composition = platformExtensionProviderCredentialComposition(env)!;
  const mode = composition.credentialRecipes[0]!.authModes.broker!;
  expect(mode.runtimeInputs).toBeUndefined();
  expect(mode.runIssuance).toMatchObject({ audience: "takosumi-hosted.takoform.v1", scopes: ["takoform.run"] });
  const unusedLedger = new Proxy({} as Parameters<typeof capsulePublicOriginFromPlatformExtensions>[1], {
    get() { throw new Error("a legacy broker must never invoke the public-origin ledger"); },
  });
  expect(capsulePublicOriginFromPlatformExtensions(env, unusedLedger)).toBeUndefined();
  expect(platformExtensionRoutes(env)[0]!.contributions?.[0]?.slot).toBe("workspace.hosted-resources");
});

test("legacy Hosted admission rejects partial protocols and widened credential authority", () => {
  const { routes, render } = nativeHostedResourceInventoryConfig();
  const full = structuredClone(routes[0]!.providerCredentialBroker) as Record<string, unknown>;
  const protocol = ["publicInputExchangePath", "publicInputCapabilities", "runtimeInputs"];
  for (let mask = 1; mask < 7; mask++) {
    const changed = structuredClone(routes);
    const broker = changed[0]!.providerCredentialBroker as Record<string, unknown>;
    for (const [index, key] of protocol.entries()) if (!(mask & (1 << index))) delete broker[key];
    expect(() => assertConfigTargetsSource(render(changed), "staging")).toThrow("platform_worker_release_config_source_invalid");
  }
  const changed = structuredClone(routes);
  const broker = changed[0]!.providerCredentialBroker as Record<string, unknown>;
  for (const key of protocol) delete broker[key];
  for (const mutation of [
    { connectionId: "conn_other" }, { exchangePath: "/other" },
    { runCredentialSettings: { requiredAvailableMinor: 0 } },
    { renewableConnectionId: "conn_takoserverTakoformRenew01" },
    { renewableEnv: { sourceEnvName: "TAKOFORM_TOKEN", fileEnvName: "TAKOFORM_TOKEN_FILE", minimumProviderVersion: "4.1.0" } },
    { authMode: "public" },
    { renewableConnectionId: "conn_takoserverTakoformRenew01", renewableEnv: { sourceEnvName: "TAKOFORM_TOKEN", fileEnvName: "TAKOFORM_TOKEN_FILE", minimumProviderVersion: "4.1.0" } },
  ]) {
    const candidate = structuredClone(changed);
    Object.assign(candidate[0]!.providerCredentialBroker as Record<string, unknown>, mutation);
    expect(() => assertConfigTargetsSource(render(candidate), "staging")).toThrow("platform_worker_release_config_source_invalid");
  }
  expect(Object.keys(full)).toHaveLength(10);
});


test("legacy Hosted profile refuses a bound foreign public-origin authority", () => {
  const { routes, render } = nativeHostedResourceInventoryConfig();
  const fullBroker = structuredClone(routes[0]!.providerCredentialBroker) as Record<string, unknown>;
  const broker = routes[0]!.providerCredentialBroker as Record<string, unknown>;
  delete broker.publicInputExchangePath;
  delete broker.publicInputCapabilities;
  delete broker.runtimeInputs;
  const values = [...routes, {
    id: "other-origin", basePath: "/extensions/other-origin", handlerKey: "OTHER",
    authDelivery: "context", ownsPathSubtree: true, workspaceContext: "query-required",
    runCredential: { audience: "other-origin.v1", requiredScopes: ["other.run"] },
    providerCredentialBroker: { ...fullBroker, connectionId: "conn_otherOrigin01", recipeId: "other-origin" },
  }];
  expect(() => platformExtensionRoutes({ TAKOSUMI_PLATFORM_EXTENSIONS: values })).not.toThrow();
  const selected = render(values).replace('[vars]', '[[services]]\nbinding = "OTHER"\nservice = "other-origin"\n[vars]');
  expect(() => assertConfigTargetsSource(selected, "staging")).toThrow("platform_worker_release_config_source_invalid");
});
