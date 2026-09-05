import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  completeRelease,
  dashboardAssetTreeSeal,
  runPlatformWorkerRelease,
  type PlatformContainerState,
  type PlatformReleaseCommand,
  type PlatformReleasePlan,
  type PlatformReleasePlanRuntime,
} from "../../scripts/platform-worker-release.ts";
import { platformReleaseSourceAuthorityDigest } from "../../scripts/lib/platform-release-source.ts";

const roots: string[] = [];
const COMMIT = "a".repeat(40);
const REPOSITORY = "https://github.com/tako0614/takosumi.git";
const OTHER_REPOSITORY = "https://github.com/example/takosumi.git";
const PREVIOUS_IMAGE =
  `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`;
const NEXT_IMAGE =
  `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"d".repeat(64)}`;
const PREDECESSOR_VERSION = "11111111-1111-4111-8111-111111111111";
const DEPLOYED_VERSION = "22222222-2222-4222-8222-222222222222";
const OPENTOFU_SHA256 = "9".repeat(64);
const DOCKERFILE = [
  "FROM scratch",
  "ARG OPENTOFU_VERSION=1.12.5",
  `ARG OPENTOFU_SHA256=${OPENTOFU_SHA256}`,
  "",
].join("\n");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real release flow accepts a proved runner image across Worker commits and rejects source drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-release-composition-"));
  roots.push(root);
  const repositoryRoot = join(root, "takosumi");
  const operatorRoot = join(root, "operator");
  mkdirSync(join(repositoryRoot, "runner"), { recursive: true });
  mkdirSync(join(repositoryRoot, "deploy/platform"), { recursive: true });
  mkdirSync(join(repositoryRoot, "dashboard/dist"), { recursive: true });
  mkdirSync(operatorRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(repositoryRoot, "runner/Dockerfile"), DOCKERFILE);
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

  const buildEvidence = join(operatorRoot, "runner-build.jsonl");
  const build = (await runRunnerImageRelease(
    {
      command: "build",
      config,
      environment: "staging",
      release: "release-1",
      evidence: buildEvidence,
      state: join(operatorRoot, "runner-state.jsonl"),
      review: "operator:builder",
      execute: true,
    },
    runnerBuildRuntime(repositoryRoot),
  )) as RunnerImageBuildRecord;

  expect(build).toMatchObject({
    operation: "build",
    status: "published",
    source: { repository: REPOSITORY, commit: COMMIT },
    image: { immutableRef: NEXT_IMAGE },
  });
  expect(build.config.buildSha256).toBe(sha256(source));

  const activatedSource = source.replace(PREVIOUS_IMAGE, NEXT_IMAGE);
  expect(activatedSource).not.toBe(source);
  const activationSha256 = assertRunnerImageOnlyConfigChange(
    source,
    activatedSource,
    PREVIOUS_IMAGE,
    NEXT_IMAGE,
  );
  expect(activationSha256).toBe(sha256(activatedSource));
  expect(build.config.expectedActivationSha256).toBe(activationSha256);
  writeFileSync(config, activatedSource);

  expect(() => assertConfigTargetsSource(activatedSource, "staging")).not.toThrow();
  await expect(
    runPlatformWorkerRelease(
      [
        "plan",
        "--config",
        config,
        "--plan-out",
        join(operatorRoot, "platform-plan-without-runner-proof.json"),
      ],
      "staging",
      platformPlanRuntime(repositoryRoot),
    ),
  ).rejects.toThrow("platform_worker_release_runner_image_proof_required");
  const publishedBuild = JSON.parse(
    readFileSync(buildEvidence, "utf8"),
  ) as RunnerImageBuildRecord;
  const unprovenBuild: Record<string, unknown> = { ...publishedBuild };
  delete unprovenBuild.runtimeInputPlanProof;
  const legacyBuild: Record<string, unknown> = {
    ...unprovenBuild,
    kind: "takosumi.runner-image-release@v2",
  };
  const otherImage =
    `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"e".repeat(64)}`;
  for (const [name, incompatibleBuild] of [
    ["unproven", unprovenBuild],
    ["legacy", legacyBuild],
    [
      "legacy-proof",
      {
        ...publishedBuild,
        runtimeInputPlanProof: {
          kind: "takosumi.runner-image-runtime-input-plan-proof@v0",
          image: NEXT_IMAGE,
        },
      },
    ],
    [
      "different-image",
      {
        ...publishedBuild,
        image: { ...publishedBuild.image, immutableRef: otherImage },
        runtimeInputPlanProof: {
          kind: "takosumi.runner-image-runtime-input-plan-proof@v1",
          image: otherImage,
        },
      },
    ],
    [
      "mismatched-proof",
      {
        ...publishedBuild,
        runtimeInputPlanProof: {
          kind: "takosumi.runner-image-runtime-input-plan-proof@v1",
          image: otherImage,
        },
      },
    ],
    [
      "forged-provenance",
      {
        ...publishedBuild,
        source: {
          ...publishedBuild.source,
          authoritySha256: `sha256:${"0".repeat(64)}`,
        },
      },
    ],
    [
      "foreign-repository",
      {
        ...publishedBuild,
        source: {
          ...publishedBuild.source,
          repository: OTHER_REPOSITORY,
          authoritySha256: platformReleaseSourceAuthorityDigest({
            kind: "takosumi.platform-release-source@v1",
            repository: OTHER_REPOSITORY,
            commit: publishedBuild.source.commit,
          }),
        },
      },
    ],
  ] as const) {
    const incompatibleEvidence = join(
      operatorRoot,
      `runner-build-${name}.jsonl`,
    );
    writeFileSync(
      incompatibleEvidence,
      `${JSON.stringify(incompatibleBuild)}\n`,
      { mode: 0o600 },
    );
    let dashboardBuilds = 0;
    let closureBuilds = 0;
    const runtime = platformPlanRuntime(repositoryRoot);
    await expect(
      runPlatformWorkerRelease(
        [
          "plan",
          "--config",
          config,
          "--runner-build-evidence",
          incompatibleEvidence,
          "--plan-out",
          join(operatorRoot, `platform-plan-${name}.json`),
        ],
        "staging",
        {
          ...runtime,
          buildDashboard: async (environment) => {
            dashboardBuilds += 1;
            return runtime.buildDashboard(environment);
          },
          createClosure: async (input) => {
            closureBuilds += 1;
            return runtime.createClosure(input);
          },
        },
      ),
    ).rejects.toThrow("platform_worker_release_runner_image_proof_invalid");
    expect(dashboardBuilds, name).toBe(0);
    expect(closureBuilds, name).toBe(0);
  }
  const independentRunnerCommit = "e".repeat(40);
  const independentBuild = {
    ...publishedBuild,
    source: {
      ...publishedBuild.source,
      commit: independentRunnerCommit,
      authoritySha256: platformReleaseSourceAuthorityDigest({
      kind: "takosumi.platform-release-source@v1",
      repository: publishedBuild.source.repository,
      commit: independentRunnerCommit,
      }),
    },
  };
  for (const [name, records] of [
    ["historical-unproven-then-proved", [unprovenBuild, independentBuild]],
    ["duplicate-proved", [independentBuild, independentBuild]],
  ] as const) {
    const historyEvidence = join(operatorRoot, `runner-build-${name}.jsonl`);
    const historyPlan = join(operatorRoot, `platform-plan-${name}.json`);
    writeFileSync(
      historyEvidence,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      { mode: 0o600 },
    );
    await runPlatformWorkerRelease(
      [
        "plan",
        "--config",
        config,
        "--runner-build-evidence",
        historyEvidence,
        "--plan-out",
        historyPlan,
      ],
      "staging",
      platformPlanRuntime(repositoryRoot),
    );
    expect(JSON.parse(readFileSync(historyPlan, "utf8"))).toMatchObject({
      runnerImageProof: {
        kind: "takosumi.runner-image-runtime-input-plan-proof@v1",
        image: NEXT_IMAGE,
      },
    });
  }
  const malformedHistoryEvidence = join(
    operatorRoot,
    "runner-build-malformed-then-proved.jsonl",
  );
  writeFileSync(
    malformedHistoryEvidence,
    `${JSON.stringify({
      ...publishedBuild,
      source: {
        ...publishedBuild.source,
        authoritySha256: `sha256:${"0".repeat(64)}`,
      },
    })}\n${JSON.stringify(independentBuild)}\n`,
    { mode: 0o600 },
  );
  let malformedHistoryDashboardBuilds = 0;
  let malformedHistoryClosureBuilds = 0;
  const malformedHistoryRuntime = platformPlanRuntime(repositoryRoot);
  await expect(
    runPlatformWorkerRelease(
      [
        "plan",
        "--config",
        config,
        "--runner-build-evidence",
        malformedHistoryEvidence,
        "--plan-out",
        join(operatorRoot, "platform-plan-malformed-then-proved.json"),
      ],
      "staging",
      {
        ...malformedHistoryRuntime,
        buildDashboard: async (environment) => {
          malformedHistoryDashboardBuilds += 1;
          return malformedHistoryRuntime.buildDashboard(environment);
        },
        createClosure: async (input) => {
          malformedHistoryClosureBuilds += 1;
          return malformedHistoryRuntime.createClosure(input);
        },
      },
    ),
  ).rejects.toThrow("platform_worker_release_runner_image_proof_invalid");
  expect(malformedHistoryDashboardBuilds).toBe(0);
  expect(malformedHistoryClosureBuilds).toBe(0);
  const independentBuildEvidence = join(
    operatorRoot,
    "runner-build-independent-source.jsonl",
  );
  writeFileSync(
    independentBuildEvidence,
    `${JSON.stringify(independentBuild)}\n`,
    { mode: 0o600 },
  );
  const planPath = join(operatorRoot, "platform-plan.json");
  await runPlatformWorkerRelease(
    [
      "plan",
      "--config",
      config,
      "--runner-build-evidence",
      independentBuildEvidence,
      "--plan-out",
      planPath,
    ],
    "staging",
    platformPlanRuntime(repositoryRoot),
  );
  const platformPlan = JSON.parse(
    readFileSync(planPath, "utf8"),
  ) as PlatformReleasePlan;
  expect({
    sourceRepository: platformPlan.sourceRepository,
    sourceCommit: platformPlan.sourceCommit,
    sourceAuthoritySha256: platformPlan.sourceAuthoritySha256,
    configPath: platformPlan.configPath,
    configSha256: platformPlan.configSha256,
  }).toEqual({
    sourceRepository: build.source.repository,
    sourceCommit: build.source.commit,
    sourceAuthoritySha256: build.source.authoritySha256,
    configPath: build.config.path,
    configSha256: activationSha256,
  });
  expect(platformPlan.runnerImageProof).toEqual({
    kind: "takosumi.runner-image-runtime-input-plan-proof@v1",
    image: NEXT_IMAGE,
  });
  expect(independentBuild.source.commit).not.toBe(platformPlan.sourceCommit);

  const platformEvidence = join(operatorRoot, "platform-evidence.json");
  const releaseCommand = successfulPlatformReleaseCommand(platformPlan);
  await completeRelease(
    {
      action: "execute",
      plan: planPath,
      confirmation: platformPlan.confirmation,
      reviewer: "operator:platform-reviewer",
      evidence: platformEvidence,
    },
    platformPlan,
    true,
    undefined,
    releaseCommand,
    undefined,
    async () => {},
    {
      checkoutIdentity: () => ({ repository: REPOSITORY, commit: COMMIT }),
      isAncestor: (ancestor, descendant) => ancestor === descendant,
    },
  );
  expect(JSON.parse(readFileSync(platformEvidence, "utf8"))).toMatchObject({
    kind: "takosumi.platform-worker-release-evidence@v3",
    status: "ready",
    sourceRepository: build.source.repository,
    sourceAuthoritySha256: build.source.authoritySha256,
    planConfirmation: platformPlan.confirmation,
  });

  const recoveryCommit = "f".repeat(40);
  const recoveryEvidence = join(operatorRoot, "platform-recovery-evidence.json");
  const recoveryOptions = {
    action: "recover" as const,
    plan: planPath,
    confirmation: platformPlan.confirmation,
    reviewer: "operator:platform-reviewer",
    evidence: recoveryEvidence,
  };
  const recoveryRuntime = {
    checkoutIdentity: () => ({ repository: REPOSITORY, commit: recoveryCommit }),
    isAncestor: (ancestor: string, descendant: string) =>
      ancestor === COMMIT && descendant === recoveryCommit,
  };
  await completeRelease(
    recoveryOptions,
    platformPlan,
    false,
    recoveryCommit,
    releaseCommand,
    undefined,
    async () => {},
    recoveryRuntime,
  );
  expect(JSON.parse(readFileSync(recoveryEvidence, "utf8"))).toMatchObject({
    sourceRepository: REPOSITORY,
    sourceCommit: COMMIT,
    sourceAuthoritySha256: platformPlan.sourceAuthoritySha256,
    recoverySourceRepository: REPOSITORY,
    recoverySourceCommit: recoveryCommit,
    recoverySourceAuthoritySha256: platformReleaseSourceAuthorityDigest({
      kind: "takosumi.platform-release-source@v1",
      repository: REPOSITORY,
      commit: recoveryCommit,
    }),
  });

  const verify = await runRunnerImageRelease(
    {
      command: "verify",
      config,
      environment: "staging",
      release: "release-1",
      evidence: join(operatorRoot, "runner-verify.jsonl"),
      buildEvidence: independentBuildEvidence,
      platformEvidence: recoveryEvidence,
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
    source: {
      repository: platformPlan.sourceRepository,
      commit: platformPlan.sourceCommit,
      authoritySha256: platformPlan.sourceAuthoritySha256,
    },
    image: NEXT_IMAGE,
    platformVersionId: DEPLOYED_VERSION,
  });

  const lateDriftEvidence = join(operatorRoot, "platform-recovery-drift.json");
  await expect(completeRelease(
    { ...recoveryOptions, evidence: lateDriftEvidence },
    platformPlan,
    false,
    recoveryCommit,
    releaseCommand,
    undefined,
    async () => {
      writeFileSync(join(operatorRoot, "wrangler.staging.source.json"), JSON.stringify({
        kind: "takosumi.platform-release-source@v1",
        repository: OTHER_REPOSITORY,
        commit: COMMIT,
      }));
    },
    recoveryRuntime,
  )).rejects.toThrow("platform_worker_release_incomplete");
  expect(JSON.parse(readFileSync(lateDriftEvidence, "utf8"))).toMatchObject({
    status: "incomplete",
    mutationOutcome: "accepted",
    diagnostic: { message: "platform_worker_release_source_drift" },
  });

  writeFileSync(
    join(operatorRoot, "wrangler.staging.source.json"),
    `${JSON.stringify({
      kind: "takosumi.platform-release-source@v1",
      repository: OTHER_REPOSITORY,
      commit: COMMIT,
    })}\n`,
  );
  let liveReadbackCalls = 0;
  await expect(
    runRunnerImageRelease(
      {
        command: "verify",
        config,
        environment: "staging",
        release: "release-1",
        evidence: join(operatorRoot, "runner-verify-repository-drift.jsonl"),
        buildEvidence,
        platformEvidence,
        review: "operator:verifier",
        execute: true,
      },
      {
        repositoryRoot,
        git: releaseGit(OTHER_REPOSITORY),
        command: async () => {
          liveReadbackCalls += 1;
          throw new Error("live readback must not run after source authority drift");
        },
      },
    ),
  ).rejects.toThrow("runner_image_source_authority_mismatch");
  expect(liveReadbackCalls).toBe(0);
});

function runnerBuildRuntime(repositoryRoot: string) {
  return {
    repositoryRoot,
    nonce: () => "01".repeat(16),
    accountId: "b".repeat(32),
    git: releaseGit(),
    materializeSource: async (
      sourceRoot: string,
      _commit: string,
      destination: string,
    ) => {
      cpSync(sourceRoot, destination, { recursive: true });
    },
    command: async (_executable: string, args: readonly string[]) => {
      if (args[0] === "buildx") return commandResult("");
      if (args[0] === "image") {
        return commandResult(
          JSON.stringify({
            Id: `sha256:${"d".repeat(64)}`,
            Descriptor: {
              digest: `sha256:${"d".repeat(64)}`,
              mediaType:
                "application/vnd.docker.distribution.manifest.v2+json",
            },
            Os: "linux",
            Architecture: "amd64",
          }),
        );
      }
      if (args[0] === "run" || args[0] === "exec") return commandResult("takosumi-runner-boot-ok\n");
      if (args[0] === "rm" && args[1] === "--force") return commandResult("");
      if (args[0] === "manifest") {
        return commandResult(
          JSON.stringify({
            Descriptor: {
              mediaType:
                "application/vnd.docker.distribution.manifest.v2+json",
              digest: `sha256:${"d".repeat(64)}`,
              platform: { os: "linux", architecture: "amd64" },
            },
            SchemaV2Manifest: {
              schemaVersion: 2,
              mediaType:
                "application/vnd.docker.distribution.manifest.v2+json",
              config: { digest: `sha256:${"f".repeat(64)}` },
            },
          }),
        );
      }
      if (args[1] === "containers" && args[2] === "push") {
        const localTag = args[3]!;
        return commandResult(
          `Pushed image: registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner:${localTag.slice(localTag.indexOf(":") + 1)}\n`,
        );
      }
      if (args.includes("--output")) {
        const output = args[args.indexOf("--output") + 1]!;
        const url = args.at(-1)!;
        writeFileSync(
          output,
          url.endsWith("_SHA256SUMS")
            ? `${OPENTOFU_SHA256}  tofu_1.12.5_linux_amd64.zip\n`
            : "sigstore material\n",
        );
        return commandResult("");
      }
      if (args[0] === "verify-blob") return commandResult("Verified OK\n");
      throw new Error(`unexpected runner build command: ${args.join(" ")}`);
    },
  };
}

function platformPlanRuntime(
  repositoryRoot: string,
): PlatformReleasePlanRuntime {
  return {
    repositoryRoot,
    assertCleanAndPushed: async () => {},
    checkoutIdentity: () => ({ repository: REPOSITORY, commit: COMMIT }),
    buildDashboard: async () =>
      dashboardAssetTreeSeal(join(repositoryRoot, "dashboard/dist")),
    readPredecessor: async () => ({
      versionId: PREDECESSOR_VERSION,
      container: platformContainer(PREVIOUS_IMAGE, 1),
    }),
    createClosure: async (input) => {
      const dryRunPath = join(input.closurePath, "dry-run");
      mkdirSync(dryRunPath, { recursive: true });
      const configPath = join(input.closurePath, "wrangler.toml");
      const uploadEntrypointPath = join(dryRunPath, "entry-worker.mjs");
      writeFileSync(configPath, input.configSource, { mode: 0o600 });
      writeFileSync(uploadEntrypointPath, "export default {};\n");
      return {
        configPath,
        configSha256: sha256(input.configSource),
        uploadEntrypointPath,
        dryRun: dashboardAssetTreeSeal(dryRunPath),
        closure: dashboardAssetTreeSeal(input.closurePath),
      };
    },
    readSecretNames: async () => [],
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    nonce: () => "02".repeat(16),
  };
}

function successfulPlatformReleaseCommand(
  plan: PlatformReleasePlan,
): PlatformReleaseCommand {
  let uploaded = false;
  return async (argv) => {
    if (argv[1] === "deployments" && argv[2] === "status") {
      return commandResult(
        JSON.stringify({
          id: "deployment",
          versions: [
            {
              version_id: uploaded
                ? DEPLOYED_VERSION
                : plan.predecessorVersionId,
              percentage: 100,
            },
          ],
        }),
      );
    }
    if (argv[1] === "containers" && argv[2] === "list") {
      const state = uploaded
        ? platformContainer(NEXT_IMAGE, 2)
        : plan.predecessorContainer;
      return commandResult(
        JSON.stringify([
          {
            id: state.id,
            name: state.name,
            state: state.state,
            image: state.image,
            version: state.version,
          },
        ]),
      );
    }
    if (argv[1] === "containers" && argv[2] === "info") {
      const state = uploaded
        ? platformContainer(NEXT_IMAGE, 2)
        : plan.predecessorContainer;
      return commandResult(JSON.stringify(platformContainerDetail(state)));
    }
    if (argv[1] === "deploy") {
      uploaded = true;
      return commandResult(`Current Version ID: ${DEPLOYED_VERSION}\n`);
    }
    if (argv[1] === "versions" && argv[2] === "view") {
      return commandResult(
        JSON.stringify({
          id: DEPLOYED_VERSION,
          annotations: {
            "workers/tag": plan.releaseTag,
            "workers/message":
              `takosumi-platform-release ${plan.confirmation}`,
          },
          resources: {
            script: { handlers: ["fetch"] },
            bindings: [
              { name: "ASSETS", type: "assets" },
              { name: "HOSTED", type: "service", service: "takosumi-hosted-staging" },
              { name: "TAKOSUMI_ACCOUNTS_DB", type: "d1" },
              { name: "TAKOSUMI_CONTROL_DB", type: "d1" },
              {
                name: "TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY",
                type: "secret_text",
              },
              { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" },
            ],
          },
        }),
      );
    }
    throw new Error(`unexpected platform release command: ${argv.join(" ")}`);
  };
}

function commandResult(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" } as const;
}

function platformContainerDetail(state: PlatformContainerState) {
  return {
    id: state.id,
    name: state.name,
    state: state.state,
    version: state.version,
    configuration: { image: state.image },
    active_rollout_id: state.hasActiveRollout ? "rollout" : null,
    health: {
      instances: {
        failed: state.health.failed,
        starting: state.health.starting,
        scheduling: state.health.scheduling,
      },
      errors: Array.from({ length: state.health.errorCount }, () => ({})),
    },
  };
}

function releaseGit(repository = REPOSITORY) {
  return async (_root: string, args: readonly string[]): Promise<string> => {
    const command = args.join(" ");
    if (command === "--no-replace-objects for-each-ref --format=%(refname) refs/replace") {
      return "";
    }
    if (command === "status --porcelain=v1 --untracked-files=all") return "";
    if (command === "branch --show-current") return "main";
    if (command === "remote get-url origin") return repository;
    if (command === "rev-parse HEAD") return COMMIT;
    if (command === "rev-parse origin/main") return COMMIT;
    if (args[0] === "ls-remote") return `${COMMIT}\trefs/heads/main`;
    throw new Error(`unexpected git command: ${command}`);
  };
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
