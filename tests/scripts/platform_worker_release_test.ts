import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  assertConfigTargetsSource,
  assertPublishedVersion,
  bindingNames,
  parsePlatformWorkerReleaseArgs,
  parsePlatformContainerDetail,
  parseServingVersion,
  platformCommandFailureDiagnostic,
  platformDashboardBuildEnvironment,
  platformTargetForEnvironment,
  remoteBranchContainsCommit,
  selectRecoveredVersion,
  secretNames,
} from "../../scripts/platform-worker-release.ts";

const root = resolve(import.meta.dir, "../..");

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
  const source = (
    service: string,
    main = resolve(root, "deploy/platform/entry-worker.ts"),
    includeBroker = true,
    basePath = "/api/v1/account/subscription",
    includeVersionMetadata = true,
  ) => `
name = "takosumi"
main = "${main}"
[assets]
directory = "${resolve(root, "dashboard/dist")}"
${includeVersionMetadata ? '[version_metadata]\nbinding = "TAKOSUMI_VERSION_METADATA"' : ""}
[[services]]
binding = "HOSTED"
service = "${service}"
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
      selfServicePatScopes: ["resources:read"],
      requestScopeRules: [
        {
          path: "/resources",
          methods: ["GET"],
          requiredScopes: ["resources:read"],
        },
      ],
      capabilities: [
        "takosumi.account.subscription.v1",
        "hosted-resource.inventory.v1",
      ],
      contributions: [
        {
          id: "takoserver-hosted-resources",
          slot: "workspace.hosted-resources",
          href: "/api/v1/account/subscription/resources",
          presentation: "native",
          label: "Hosted resources",
          labels: { ja: "ホスト済みリソース" },
          description: "Resources managed by Takoserver for this Workspace.",
          descriptions: {
            ja: "このワークスペースでTakoserverが管理するリソースです。",
          },
        },
      ],
      ...(includeBroker
        ? {
            runCredential: {
              audience: "takosumi-hosted.takoform.v1",
              requiredScopes: ["takoform.run"],
            },
            providerCredentialBroker: {
              connectionId: "conn_takoserverTakoform01",
              recipeId: "takoserver-takoform-run-v1",
              providerSource: "registry.terraform.io/tako0614/takoform",
              displayName: "Takoserver",
              exchangePath: "/provider-credentials/takoform",
              envNames: [
                "TAKOFORM_ENDPOINT",
                "TAKOFORM_SPACE",
                "TAKOFORM_TOKEN",
              ],
              runCredentialSettings: { requiredAvailableMinor: 2300 },
            },
          }
        : {}),
    },
    {
      id: "takosumi-ai",
      basePath: "/api/v1/ai",
      handlerKey: "HOSTED",
      authDelivery: "context",
      ownsPathSubtree: true,
      workspaceContext: "query-required",
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
  ])}'
`;
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted"),
      "/private/wrangler.toml",
      "production",
    ),
  ).not.toThrow();
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted-staging"),
      "/private/wrangler.toml",
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source("takosumi-hosted", resolve(root, "deploy/platform/worker.ts")),
      "/private/wrangler.toml",
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        resolve(root, "deploy/platform/entry-worker.ts"),
        false,
      ),
      "/private/wrangler.toml",
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        resolve(root, "deploy/platform/entry-worker.ts"),
        true,
        "/v1/hosted/subscription",
      ),
      "/private/wrangler.toml",
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
  expect(() =>
    assertConfigTargetsSource(
      source(
        "takosumi-hosted",
        resolve(root, "deploy/platform/entry-worker.ts"),
        true,
        "/api/v1/hosted/subscription",
        false,
      ),
      "/private/wrangler.toml",
      "production",
    ),
  ).toThrow("platform_worker_release_config_source_invalid");
});

test("platform release parser exposes reviewed plan, execute, recovery, and restore actions", () => {
  expect(
    parsePlatformWorkerReleaseArgs([
      "plan",
      "--config",
      "/private/wrangler.staging.toml",
      "--plan-out",
      "/private/plan.json",
    ]),
  ).toEqual({
    action: "plan",
    config: "/private/wrangler.staging.toml",
    planOut: "/private/plan.json",
  });
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
