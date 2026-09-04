import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRunnerImageOnlyConfigChange,
  runRunnerImageRelease,
  type RunnerImageBuildRecord,
} from "../../scripts/runner-image-release.ts";
import {
  assertConfigTargetsSource,
  createPlatformReadyEvidence,
  createPlatformReleasePlan,
} from "../../scripts/platform-worker-release.ts";
import { resolvePlatformReleaseSourceAuthority } from "../../scripts/lib/platform-release-source.ts";

const roots: string[] = [];
const COMMIT = "a".repeat(40);
const REPOSITORY = "https://github.com/tako0614/takosumi.git";
const PREVIOUS_IMAGE =
  `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`;
const NEXT_IMAGE =
  `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"d".repeat(64)}`;
const PREDECESSOR_VERSION = "11111111-1111-4111-8111-111111111111";
const DEPLOYED_VERSION = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one pathless realized config composes runner build with platform release", async () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-release-composition-"));
  roots.push(root);
  const repositoryRoot = join(root, "takosumi");
  const operatorRoot = join(root, "operator");
  mkdirSync(join(repositoryRoot, "runner"), { recursive: true });
  mkdirSync(join(repositoryRoot, "deploy/platform"), { recursive: true });
  mkdirSync(join(repositoryRoot, "dashboard/dist"), { recursive: true });
  mkdirSync(operatorRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(repositoryRoot, "runner/Dockerfile"), "FROM scratch\n");
  writeFileSync(
    join(repositoryRoot, "deploy/platform/entry-worker.ts"),
    "export default {};\n",
  );
  writeFileSync(join(repositoryRoot, "dashboard/dist/index.html"), "dashboard\n");

  const config = join(operatorRoot, "wrangler.staging.toml");
  const source = realizedConfig(PREVIOUS_IMAGE);
  writeFileSync(config, source);
  writeFileSync(
    join(operatorRoot, "wrangler.staging.source.json"),
    `${JSON.stringify({
      kind: "takosumi.platform-release-source@v1",
      repository: REPOSITORY,
      commit: COMMIT,
    })}\n`,
  );

  // This is the exact pathless shape accepted by the platform plan seam.
  expect(() => assertConfigTargetsSource(source, "staging")).not.toThrow();

  const build = (await runRunnerImageRelease(
    {
      command: "build",
      config,
      environment: "staging",
      release: "release-1",
      evidence: join(operatorRoot, "runner-build.jsonl"),
      state: join(operatorRoot, "runner-state.jsonl"),
      execute: false,
    },
    {
      repositoryRoot,
      nonce: () => "01".repeat(16),
      git: releaseGit(),
    },
  )) as RunnerImageBuildRecord;

  expect(build).toMatchObject({
    operation: "build",
    status: "planned",
    source: { commit: COMMIT },
  });
  expect(build.config.buildSha256).toBe(sha256(source));

  const buildAuthority = resolvePlatformReleaseSourceAuthority({
    configPath: config,
    configSource: source,
    repositoryRoot,
    checkoutRepository: REPOSITORY,
    checkoutCommit: COMMIT,
  });
  const activatedSource = source.replace(PREVIOUS_IMAGE, NEXT_IMAGE);
  expect(activatedSource).not.toBe(source);
  const activationSha256 = assertRunnerImageOnlyConfigChange(
    source,
    activatedSource,
    PREVIOUS_IMAGE,
    NEXT_IMAGE,
  );
  expect(activationSha256).toBe(sha256(activatedSource));
  writeFileSync(config, activatedSource);

  // Feed the activated bytes through the same pure producers used by platform
  // plan/execute. The runner below consumes their exact ready-evidence output,
  // so a production field rename or identity remap breaks this composition.
  expect(() => assertConfigTargetsSource(activatedSource, "staging")).not.toThrow();
  const platformAuthority = resolvePlatformReleaseSourceAuthority({
    configPath: config,
    configSource: activatedSource,
    repositoryRoot,
    checkoutRepository: REPOSITORY,
    checkoutCommit: COMMIT,
  });
  expect(platformAuthority.pin).toEqual(buildAuthority.pin);
  const closurePath = join(operatorRoot, "platform-plan.closure");
  const restoreClosurePath = join(operatorRoot, "platform-plan.restore-closure");
  const dashboardAssets = assetSeal("index.html", "dashboard\n");
  const platformPlan = createPlatformReleasePlan({
    kind: "takosumi.platform-worker-release-plan@v5",
    createdAt: "2026-09-04T00:00:00.000Z",
    environment: "staging",
    sourceCommit: platformAuthority.pin.commit,
    releaseNonce: "01".repeat(16),
    configPath: config,
    configSha256: activationSha256,
    closurePath,
    closure: assetSeal("source/entry-worker.ts", "export default {};\n"),
    sealedConfigPath: join(closurePath, "wrangler.toml"),
    sealedConfigSha256: `sha256:${"1".repeat(64)}`,
    uploadEntrypointPath: join(closurePath, "dry-run/entry-worker.mjs"),
    checkpointPath: join(operatorRoot, "platform-plan.checkpoint.jsonl"),
    restoreClosurePath,
    restoreClosure: assetSeal("source/entry-worker.ts", "export default {};\n"),
    restoreSealedConfigPath: join(restoreClosurePath, "wrangler.toml"),
    restoreSealedConfigSha256: `sha256:${"2".repeat(64)}`,
    restoreUploadEntrypointPath: join(
      restoreClosurePath,
      "dry-run/entry-worker.mjs",
    ),
    restoreDryRun: assetSeal("entry-worker.mjs", "restore bundle\n"),
    dashboardAssets,
    dryRun: assetSeal("entry-worker.mjs", "forward bundle\n"),
    secretNamesSha256: `sha256:${"3".repeat(64)}`,
    predecessorVersionId: PREDECESSOR_VERSION,
    predecessorContainer: platformContainer(PREVIOUS_IMAGE, 1),
  });
  expect({
    sourceCommit: platformPlan.sourceCommit,
    configPath: platformPlan.configPath,
    configSha256: platformPlan.configSha256,
  }).toEqual({
    sourceCommit: buildAuthority.pin.commit,
    configPath: build.config.path,
    configSha256: activationSha256,
  });

  const publishedBuild: RunnerImageBuildRecord = {
    ...build,
    status: "published",
    config: {
      ...build.config,
      expectedActivationSha256: activationSha256,
    },
    image: {
      ...build.image,
      transportRef:
        `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner:${build.image.transportTag}`,
      immutableRef: NEXT_IMAGE,
    },
    review: "operator:builder",
  };
  const buildEvidence = join(operatorRoot, "published-runner-build.jsonl");
  writePrivate(buildEvidence, `${JSON.stringify(publishedBuild)}\n`);

  const platformEvidence = join(operatorRoot, "platform-evidence.json");
  const readyEvidence = createPlatformReadyEvidence({
    plan: platformPlan,
    completedAt: "2026-09-04T00:01:00.000Z",
    deployedVersionId: DEPLOYED_VERSION,
    deployedContainer: platformContainer(NEXT_IMAGE, 2),
    reviewer: "operator:platform-reviewer",
    lostAcknowledgement: false,
  });
  writePrivate(
    platformEvidence,
    `${JSON.stringify(readyEvidence)}\n`,
  );

  const verify = await runRunnerImageRelease(
    {
      command: "verify",
      config,
      environment: "staging",
      release: "release-1",
      evidence: join(operatorRoot, "runner-verify.jsonl"),
      buildEvidence,
      platformEvidence,
      execute: false,
    },
    {
      repositoryRoot,
      git: releaseGit(),
    },
  );
  expect(verify).toMatchObject({
    operation: "verify",
    status: "planned",
    source: { commit: platformPlan.sourceCommit },
    image: NEXT_IMAGE,
    platformVersionId: DEPLOYED_VERSION,
  });
});

function releaseGit() {
  return async (_root: string, args: readonly string[]): Promise<string> => {
    const command = args.join(" ");
    if (command === "--no-replace-objects for-each-ref --format=%(refname) refs/replace") {
      return "";
    }
    if (command === "status --porcelain=v1 --untracked-files=all") return "";
    if (command === "branch --show-current") return "main";
    if (command === "remote get-url origin") return REPOSITORY;
    if (command === "rev-parse HEAD") return COMMIT;
    if (command === "rev-parse origin/main") return COMMIT;
    if (args[0] === "ls-remote") return `${COMMIT}\trefs/heads/main`;
    throw new Error(`unexpected git command: ${command}`);
  };
}

function writePrivate(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assetSeal(path: string, source: string) {
  const bytes = new TextEncoder().encode(source);
  const entries = [{ path, size: bytes.byteLength, sha256: sha256(bytes) }];
  return {
    digest: sha256(
      JSON.stringify({
        kind: "takosumi.dashboard-asset-tree@v1",
        entries,
      }),
    ),
    entries,
  } as const;
}

function platformContainer(image: string, version: number) {
  return {
    id: `container-${version}`,
    name: "takosumi-staging-opentofurunnerobject",
    state: "ready",
    image,
    version,
    hasActiveRollout: false,
    health: { failed: 0, starting: 0, scheduling: 0, errorCount: 0 },
  } as const;
}

function realizedConfig(image: string): string {
  const extensions = [
    {
      id: "takosumi-hosted-sponsorship",
      basePath: "/api/v1/account/subscription",
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
      },
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
    'instance_type = "dev"',
    "max_instances = 1",
    "[[migrations]]",
    'tag = "v1"',
    'new_sqlite_classes = ["OpenTofuRunnerObject"]',
    "",
  ].join("\n");
}
