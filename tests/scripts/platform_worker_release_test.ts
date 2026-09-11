import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertConfigTargetsSource,
  assertPlatformRunnerImageProof,
  assertPublishedVersion,
  bindingNames,
  hasHostedDiscovery,
  parsePlatformWorkerReleaseArgs,
  parsePlatformContainerDetail,
  parseServingVersion,
  platformCommandFailureDiagnostic,
  platformDashboardBuildEnvironment,
  platformTargetForEnvironment,
  readPlatformContainer,
  remoteBranchContainsCommit,
  selectRecoveredVersion,
  secretNames,
  type PlatformReleaseCommand,
  waitForPlatformContainerReadback,
} from "../../scripts/platform-worker-release.ts";

const root = resolve(import.meta.dir, "../..");
const PROVED_RUNNER_IMAGE =
  `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`;

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
  let reads = 0;
  await expect(
    waitForPlatformContainerReadback(
      `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`,
      async () => {
        reads += 1;
        throw new Error("platform_worker_release_container_list_detail_mismatch");
      },
      async () => {},
    ),
  ).rejects.toThrow("platform_worker_release_container_list_detail_mismatch");
  expect(reads).toBe(36);
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
