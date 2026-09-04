import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import {
  parseRunnerImageReleaseArgs,
  runRunnerImageRelease,
} from "../../scripts/runner-image-release.ts";
import {
  dashboardAssetTreeSeal,
  injectPlatformSourcePaths,
} from "../../scripts/platform-worker-release.ts";

const roots: string[] = [];
const COMMIT = "a".repeat(40);
const RECONCILER_COMMIT = "9".repeat(40);
const REPOSITORY = "https://github.com/tako0614/takosumi.git";
const PREVIOUS =
  `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`;
const NEXT =
  `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"d".repeat(64)}`;
const APPLICATION_ID = "application";
const APPLICATION_NAME = "takosumi-staging-opentofurunnerobject";
const PREDECESSOR_VERSION = "11111111-1111-4111-8111-111111111111";
const DEPLOYED_VERSION = "22222222-2222-4222-8222-222222222222";
const OPENTOFU_SHA256 = "9".repeat(64);
const DOCKERFILE = [
  "FROM scratch",
  "ARG OPENTOFU_VERSION=1.12.5",
  `ARG OPENTOFU_SHA256=${OPENTOFU_SHA256}`,
  "",
].join("\n");
const TRANSPORT_TAG = `r-${COMMIT.slice(0, 12)}-${sha256(DOCKERFILE).slice(7, 19)}-${"01".repeat(16)}`;
const TRANSPORT_REF =
  `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner:${TRANSPORT_TAG}`;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type Fixture = ReturnType<typeof fixture>;

function fixture(
  image = PREVIOUS,
  main?: string,
  workerName = "takosumi-staging",
) {
  const directory = mkdtempSync(join(tmpdir(), "takosumi-runner-release-"));
  roots.push(directory);
  const repository = join(directory, "takosumi");
  const operator = join(directory, "operator");
  mkdirSync(join(repository, "runner"), { recursive: true });
  mkdirSync(join(repository, "deploy", "platform"), { recursive: true });
  mkdirSync(join(repository, "dashboard", "dist"), { recursive: true });
  mkdirSync(operator, { recursive: true, mode: 0o700 });
  writeFileSync(join(repository, "runner", "Dockerfile"), DOCKERFILE);
  writeFileSync(
    join(repository, "deploy", "platform", "entry-worker.ts"),
    "export default {};\n",
  );
  writeFileSync(join(repository, "wrong-worker.ts"), "export default {};\n");
  writeFileSync(join(repository, "dashboard", "dist", "index.html"), "ok");
  const config = join(operator, "wrangler.toml");
  const configSource = realizedConfig(
    repository,
    operator,
    image,
    main,
    workerName,
  );
  writeFileSync(config, configSource);
  const sourcePin = join(operator, "wrangler.source.json");
  writeSourcePin(sourcePin, COMMIT);
  return {
    repository,
    operator,
    config,
    sourcePin,
    configSource,
    evidence: join(operator, "runner-release.jsonl"),
    state: join(operator, "runner-publication-state.jsonl"),
    buildEvidence: join(operator, "runner-build.jsonl"),
    platformEvidence: join(operator, "platform-evidence.json"),
  };
}

function realizedConfig(
  repository: string,
  operator: string,
  image: string,
  main?: string,
  workerName = "takosumi-staging",
): string {
  return [
    `name = ${JSON.stringify(workerName)}`,
    ...(main
      ? [`main = ${JSON.stringify(relative(operator, join(repository, main)))}`]
      : []),
    "",
    "[assets]",
    ...(main
      ? [
          `directory = ${JSON.stringify(relative(operator, join(repository, "dashboard", "dist")))}`,
        ]
      : []),
    "",
    "[[containers]]",
    'class_name = "OpenTofuRunnerObject"',
    `image = ${JSON.stringify(image)}`,
    'instance_type = "dev"',
    "max_instances = 1",
    "",
    "[[migrations]]",
    'tag = "v1"',
    'new_sqlite_classes = ["OpenTofuRunnerObject"]',
    "",
  ].join("\n");
}

function writeSourcePin(path: string, commit: string): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      kind: "takosumi.platform-release-source@v1",
      repository: REPOSITORY,
      commit,
    })}\n`,
  );
}

function gitFor(
  branch: string,
  remoteCommitOrOptions:
    | string
    | Readonly<{
        head?: string;
        originCommit?: string;
        remoteCommit?: string;
        replaceRefs?: string;
        missingCommits?: readonly string[];
        resolvedCommits?: Readonly<Record<string, string>>;
        nonAncestorPairs?: readonly string[];
      }> = COMMIT,
) {
  const options = typeof remoteCommitOrOptions === "string"
    ? {
        head: COMMIT,
        originCommit: remoteCommitOrOptions,
        remoteCommit: remoteCommitOrOptions,
      }
    : remoteCommitOrOptions;
  const head = options.head ?? COMMIT;
  const originCommit = options.originCommit ?? options.remoteCommit ?? head;
  const remoteCommit = options.remoteCommit ?? head;
  return async (_root: string, args: readonly string[]): Promise<string> => {
    const noReplaceObjects = args[0] === "--no-replace-objects";
    const gitArgs = noReplaceObjects ? args.slice(1) : args;
    if (gitArgs[0] === "for-each-ref") {
      if (!noReplaceObjects) throw new Error("replace refs must be inspected without replacement");
      return options.replaceRefs ?? "";
    }
    if (gitArgs[0] === "status") return "";
    if (gitArgs.join(" ") === "branch --show-current") return branch;
    if (gitArgs.join(" ") === "remote get-url origin") return REPOSITORY;
    // The shared production-routine lineage predicate
    // (scripts/lib/deploy-lineage.ts) speaks these; the release's own checks
    // speak the ones below. Both run through this one seam.
    if (gitArgs.join(" ") === "symbolic-ref --quiet --short HEAD") {
      if (!branch) throw new Error("detached HEAD");
      return branch;
    }
    if (gitArgs[0] === "fetch") return "";
    if (gitArgs.join(" ") === `rev-parse --verify refs/remotes/origin/${branch}`) {
      return originCommit;
    }
    if (gitArgs.join(" ") === "rev-parse HEAD") return head;
    if (gitArgs.join(" ") === `rev-parse origin/${branch}`) return originCommit;
    if (gitArgs[0] === "ls-remote") {
      return `${remoteCommit}\trefs/heads/${branch}`;
    }
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify") {
      if (!noReplaceObjects) throw new Error("commit resolution must disable replacement");
      const commit = gitArgs[2]?.replace(/\^\{commit\}$/u, "") ?? "";
      if (options.missingCommits?.includes(commit)) throw new Error("missing commit");
      return options.resolvedCommits?.[commit] ?? commit;
    }
    if (gitArgs[0] === "merge-base" && gitArgs[1] === "--is-ancestor") {
      // The lineage predicate asks the plain question; the reconciliation path
      // asks it with replacement disabled, and that distinction is its own.
      if (!noReplaceObjects && gitArgs[2] === head && gitArgs[3] === originCommit) {
        return "";
      }
      if (!noReplaceObjects) throw new Error("ancestry must disable replacement");
      const pair = `${gitArgs[2]}:${gitArgs[3]}`;
      if (options.nonAncestorPairs?.includes(pair)) throw new Error("not an ancestor");
      return "";
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

function buildOptions(
  input: Fixture,
  environment: "staging" | "production" = "staging",
  execute = false,
) {
  return {
    command: "build" as const,
    config: input.config,
    environment,
    release: "release-1",
    evidence: input.evidence,
    state: input.state,
    ...(execute ? { review: "operator:builder" } : {}),
    execute,
  };
}

function verifyOptions(input: Fixture, execute = true) {
  return {
    command: "verify" as const,
    config: input.config,
    environment: "staging" as const,
    release: "release-1",
    evidence: input.evidence,
    buildEvidence: input.buildEvidence,
    platformEvidence: input.platformEvidence,
    ...(execute ? { review: "operator:verifier" } : {}),
    execute,
  };
}

function writeBuildEvidence(
  input: Fixture,
  overrides: Readonly<{
    branch?: string;
    commit?: string;
    configPath?: string;
    expectedActivationSha256?: string;
    immutableRef?: string;
    review?: string;
  }> = {},
): void {
  const buildSource = realizedConfig(
    input.repository,
    input.operator,
    PREVIOUS,
  );
  const record = {
    kind: "takosumi.runner-image-release@v2",
    operation: "build",
    status: "published",
    environment: "staging",
    release: "release-1",
    observedAt: "2026-08-27T00:00:00.000Z",
    source: {
      branch: overrides.branch ?? "fix/TASK-0032-runner-image",
      commit: overrides.commit ?? COMMIT,
      dockerfileSha256: sha256(
        readFileSync(join(input.repository, "runner", "Dockerfile")),
      ),
    },
    config: {
      path: overrides.configPath ?? input.config,
      buildSha256: sha256(buildSource),
      expectedActivationSha256:
        overrides.expectedActivationSha256 ?? sha256(input.configSource),
      previousImage: PREVIOUS,
    },
    image: {
      transportTag: TRANSPORT_TAG,
      transportRef: TRANSPORT_REF,
      immutableRef: overrides.immutableRef ?? NEXT,
    },
    review: overrides.review ?? "operator:builder",
  };
  writePrivate(input.buildEvidence, `${JSON.stringify(record)}\n`);
}

function writePlatformEvidence(
  input: Fixture,
  overrides: Readonly<{
    configSha256?: string;
    configPath?: string;
    sourceCommit?: string;
    deployedVersionId?: string;
  }> = {},
): void {
  const record = {
    kind: "takosumi.platform-worker-release-evidence@v2",
    status: "ready",
    environment: "staging",
    sourceCommit: overrides.sourceCommit ?? COMMIT,
    configPath: overrides.configPath ?? input.config,
    configSha256: overrides.configSha256 ?? sha256(input.configSource),
    dashboardAssetsSha256: `sha256:${"e".repeat(64)}`,
    predecessorVersionId: PREDECESSOR_VERSION,
    deployedVersionId: overrides.deployedVersionId ?? DEPLOYED_VERSION,
    planConfirmation: `sha256:${"f".repeat(64)}`,
    reviewer: "operator:platform-reviewer",
  };
  writePrivate(input.platformEvidence, `${JSON.stringify(record)}\n`);
}

function writePrivate(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function publicationCoordinationPaths(
  root: string,
  environment: "staging" | "production" = "staging",
) {
  const imageRepository = PREVIOUS.slice(0, PREVIOUS.indexOf("@"));
  const scope = JSON.stringify({
    kind: "takosumi.runner-image-publication-scope@v1",
    environment,
    imageRepository,
  });
  const key = sha256(scope).slice("sha256:".length);
  return {
    locator: join(root, `${key}.locator.json`),
    lock: join(root, `${key}.lock`),
  };
}

function publicationAttempt(
  input: Fixture,
  overrides: Readonly<{
    branch?: string;
    commit?: string;
    dockerfileSha256?: string;
    buildContextSha256?: string;
    configPath?: string;
    configSha256?: string;
    previousImage?: string;
    transportRef?: string;
    localImageId?: string;
    localDescriptorDigest?: string | null;
  }> = {},
) {
  const localDescriptorDigest = overrides.localDescriptorDigest === undefined
    ? null
    : overrides.localDescriptorDigest;
  return {
    kind: "takosumi.runner-image-publication-state@v1",
    status: "publication-started",
    environment: "staging",
    release: "release-1",
    observedAt: "2026-08-27T00:00:00.000Z",
    source: {
      branch: overrides.branch ?? "fix/TASK-0032-runner-image",
      commit: overrides.commit ?? COMMIT,
      dockerfileSha256: overrides.dockerfileSha256 ?? sha256(DOCKERFILE),
      buildContextSha256:
        overrides.buildContextSha256 ?? dashboardAssetTreeSeal(input.repository).digest,
    },
    config: {
      path: overrides.configPath ?? input.config,
      buildSha256: overrides.configSha256 ?? sha256(input.configSource),
      previousImage: overrides.previousImage ?? PREVIOUS,
    },
    image: {
      transportTag: TRANSPORT_TAG,
      transportRef: overrides.transportRef ?? TRANSPORT_REF,
      localImageId: overrides.localImageId ?? `sha256:${"d".repeat(64)}`,
      ...(localDescriptorDigest === null ? {} : { localDescriptorDigest }),
    },
    review: "operator:builder",
  } as const;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function healthySummary(image = NEXT, name = APPLICATION_NAME) {
  return {
    id: APPLICATION_ID,
    name,
    state: "ready",
    image,
    version: 7,
  };
}

function healthyDetail(
  image = NEXT,
  overrides: Readonly<{
    id?: string;
    name?: string;
    state?: unknown;
    activeRolloutId?: string | null;
    failed?: number;
    starting?: number;
    scheduling?: number;
    errors?: readonly unknown[];
  }> = {},
) {
  return {
    id: overrides.id ?? APPLICATION_ID,
    name: overrides.name ?? APPLICATION_NAME,
    version: 7,
    ...(Object.hasOwn(overrides, "state") ? { state: overrides.state } : {}),
    configuration: { image },
    active_rollout_id: overrides.activeRolloutId ?? null,
    health: {
      instances: {
        active: 1,
        healthy: 1,
        failed: overrides.failed ?? 0,
        starting: overrides.starting ?? 0,
        scheduling: overrides.scheduling ?? 0,
      },
      errors: overrides.errors ?? [],
    },
  };
}

function verificationCommand(
  overrides: Readonly<{
    servingVersionId?: string;
    summary?: unknown;
    detail?: unknown;
  }> = {},
) {
  const calls: readonly string[][] = [] as unknown as string[][];
  const mutable = calls as string[][];
  return {
    calls,
    command: async (_executable: string, args: readonly string[]) => {
      mutable.push([...args]);
      if (args[1] === "deployments" && args[2] === "status") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "deployment",
            versions: [
              {
                version_id: overrides.servingVersionId ?? DEPLOYED_VERSION,
                percentage: 100,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args[1] === "containers" && args[2] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            overrides.summary ?? healthySummary(),
          ]),
          stderr: "",
        };
      }
      if (args[1] === "containers" && args[2] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(overrides.detail ?? healthyDetail()),
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
}

function buildRuntime(
  input: Fixture,
  handler: (
    executable: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  observed?: string[][],
  localImageInspect: unknown = {
    Id: `sha256:${"d".repeat(64)}`,
    Descriptor: {
      digest: `sha256:${"d".repeat(64)}`,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    },
    Os: "linux",
    Architecture: "amd64",
  },
) {
  return {
    repositoryRoot: input.repository,
    git: gitFor("fix/TASK-0032-runner-image"),
    nonce: () => "01".repeat(16),
    accountId: "b".repeat(32),
    materializeSource: materializeFixtureSource,
    command: async (executable: string, args: readonly string[]) => {
      observed?.push([executable, ...args]);
      if (executable === "curl") {
        const output = args[args.indexOf("--output") + 1]!;
        const url = args.at(-1)!;
        writeFileSync(
          output,
          url.endsWith("_SHA256SUMS")
            ? `${OPENTOFU_SHA256}  tofu_1.12.5_linux_amd64.zip\n`
            : "sigstore material\n",
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (executable === "cosign") {
        return { exitCode: 0, stdout: "Verified OK\n", stderr: "" };
      }
      if (executable === "docker" && args[0] === "image") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(localImageInspect),
          stderr: "",
        };
      }
      return handler(executable, args);
    },
  };
}

async function materializeFixtureSource(
  repositoryRoot: string,
  _commit: string,
  destination: string,
): Promise<void> {
  cpSync(repositoryRoot, destination, { recursive: true });
}

async function successfulPublicationCommand(
  _executable: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (args[0] === "buildx") return { exitCode: 0, stdout: "", stderr: "" };
  if (args[1] === "containers" && args[2] === "push") {
    const localTag = args[3]!;
    const transportTag = localTag.slice(localTag.indexOf(":") + 1);
    return {
      exitCode: 0,
      stdout:
        `Pushed image: registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner:${transportTag}\n`,
      stderr: "",
    };
  }
  if (args[0] === "manifest") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        Descriptor: {
          mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          digest: `sha256:${"d".repeat(64)}`,
          platform: { os: "linux", architecture: "amd64" },
        },
        SchemaV2Manifest: {
          schemaVersion: 2,
          mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          config: { digest: `sha256:${"f".repeat(64)}` },
        },
      }),
      stderr: "",
    };
  }
  throw new Error(`unexpected command: ${args.join(" ")}`);
}

function legacyLocalImageInspect() {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      Id: `sha256:${"d".repeat(64)}`,
      Descriptor: {
        digest: `sha256:${"d".repeat(64)}`,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      },
      Os: "linux",
      Architecture: "amd64",
    }),
    stderr: "",
  };
}

function withLegacyLocalImageProof(
  handler: (
    executable: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
) {
  return async (executable: string, args: readonly string[]) =>
    executable === "docker" && args[0] === "image"
      ? legacyLocalImageInspect()
      : handler(executable, args);
}

async function bindDescriptorAwareAttemptThroughBuild(
  input: Fixture,
  journalRoot: string,
): Promise<void> {
  await expect(
    runRunnerImageRelease(buildOptions(input, "staging", true), {
      ...buildRuntime(input, async (_executable, args) => {
        if (args[0] === "buildx") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[1] === "containers" && args[2] === "push") {
          return { exitCode: 2, stdout: "", stderr: "simulated uncertain push" };
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }),
      publicationJournalRoot: journalRoot,
    }),
  ).rejects.toThrow(
    "runner image publication outcome is incomplete; immutable digest evidence was not established",
  );
  const [attempt] = readFileSync(input.state, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line)) as Array<{
      image: { localDescriptorDigest?: string };
    }>;
  expect(attempt?.image.localDescriptorDigest).toBe(`sha256:${"d".repeat(64)}`);
  expect(existsSync(publicationCoordinationPaths(journalRoot).locator)).toBeTrue();
}

test("staging accepts a clean pushed feature branch and records branch plus commit", async () => {
  const input = fixture();
  const record = await runRunnerImageRelease(buildOptions(input), {
    repositoryRoot: input.repository,
    git: gitFor("fix/TASK-0032-runner-image"),
    nonce: () => "01".repeat(16),
  });
  expect(record).toMatchObject({
    operation: "build",
    status: "planned",
    source: { branch: "fix/TASK-0032-runner-image", commit: COMMIT },
  });
});

test("staging rejects an unpushed or divergent current branch", async () => {
  const input = fixture();
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image", "d".repeat(40)),
    }),
  ).rejects.toThrow("pushed origin/fix/TASK-0032-runner-image");
});

test("production rejects a feature branch and accepts only pushed main", async () => {
  const input = fixture(PREVIOUS, undefined, "takosumi");
  await expect(
    runRunnerImageRelease(buildOptions(input, "production"), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow(
    "not the default branch main",
  );
  await expect(
    runRunnerImageRelease(buildOptions(input, "production"), {
      repositoryRoot: input.repository,
      git: gitFor("main"),
      nonce: () => "01".repeat(16),
    }),
  ).resolves.toMatchObject({ status: "planned", environment: "production" });
});

test("release refuses dirty, detached, and absent origin refs", async () => {
  const input = fixture();
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: async (root, args) =>
        args[0] === "status"
          ? " M runner/Dockerfile"
          : gitFor("fix/TASK-0032-runner-image")(root, args),
    }),
  ).rejects.toThrow("must be clean");
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: async (root, args) =>
        args.join(" ") === "branch --show-current"
          ? ""
          : gitFor("fix/TASK-0032-runner-image")(root, args),
    }),
  ).rejects.toThrow("attached branch");
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: async (root, args) => {
        if (args[0] === "ls-remote") throw new Error("missing");
        return gitFor("fix/TASK-0032-runner-image")(root, args);
      },
    }),
  ).rejects.toThrow("pushed origin/fix/TASK-0032-runner-image");
});

test("release rejects either source path in the realized config", async () => {
  const input = fixture();
  for (const source of [
    input.configSource.replace(
      'name = "takosumi-staging"',
      `name = "takosumi-staging"\nmain = ${JSON.stringify(join(input.repository, "deploy/platform/entry-worker.ts"))}`,
    ),
    input.configSource.replace(
      'name = "takosumi-staging"',
      `name = "takosumi-staging"\n"main" = ${JSON.stringify(join(input.repository, "deploy/platform/entry-worker.ts"))}`,
    ),
    input.configSource.replace(
      "[assets]",
      `[assets]\ndirectory = ${JSON.stringify(join(input.repository, "dashboard/dist"))}`,
    ),
    input.configSource.replace(
      "[assets]",
      `[assets]\n"directory" = ${JSON.stringify(join(input.repository, "dashboard/dist"))}`,
    ),
    input.configSource.replace(
      "[assets]",
      `assets.directory = ${JSON.stringify(join(input.repository, "dashboard/dist"))}`,
    ),
  ]) {
    writeFileSync(input.config, source);
    await expect(
      runRunnerImageRelease(buildOptions(input), {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
      }),
    ).rejects.toThrow("platform_worker_release_config_declares_source_path");
  }
});

test("release dry-run requires an assets table for its derived projection", async () => {
  const input = fixture();
  writeFileSync(input.config, input.configSource.replace("[assets]\n", ""));
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("platform_worker_release_sealed_config_invalid");
});

test("release shares the exact repository/commit pin and reserves its inode from outputs", async () => {
  const input = fixture();
  writeSourcePin(input.sourcePin, "8".repeat(40));
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("platform_worker_release_source_pin_mismatch");

  writeSourcePin(input.sourcePin, COMMIT);
  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), evidence: input.sourcePin },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
      },
    ),
  ).rejects.toThrow("runner_image_release_path_alias");

  const alias = join(input.operator, "source-pin-alias.json");
  linkSync(input.sourcePin, alias);
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("platform_worker_release_source_pin_invalid");

  rmSync(alias);
  const physicalPin = join(input.operator, "physical-source-pin.json");
  renameSync(input.sourcePin, physicalPin);
  symlinkSync(physicalPin, input.sourcePin);
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("platform_worker_release_source_pin_invalid");
});

test("public CLI exposes build and read-only verify, never activate", () => {
  expect(
    parseRunnerImageReleaseArgs([
      "build",
      "--config",
      "/private/wrangler.toml",
      "--environment",
      "staging",
      "--release",
      "release-1",
      "--evidence",
      "/private/build.jsonl",
      "--state",
      "/private/publication-state.jsonl",
    ]),
  ).toMatchObject({ command: "build", release: "release-1", execute: false });
  expect(
    parseRunnerImageReleaseArgs([
      "verify",
      "--config",
      "/private/wrangler.toml",
      "--environment",
      "staging",
      "--release",
      "release-1",
      "--evidence",
      "/private/verify.jsonl",
      "--build-evidence",
      "/private/build.jsonl",
      "--platform-evidence",
      "/private/platform.json",
    ]),
  ).toMatchObject({ command: "verify", execute: false });
  expect(
    parseRunnerImageReleaseArgs([
      "reconcile",
      "--config",
      "/private/wrangler.toml",
      "--environment",
      "staging",
      "--release",
      "release-1",
      "--evidence",
      "/private/build.jsonl",
      "--state",
      "/private/publication-state.jsonl",
    ]),
  ).toMatchObject({ command: "reconcile", execute: false });
  expect(() => parseRunnerImageReleaseArgs(["activate"])).toThrow();
  expect(() =>
    parseRunnerImageReleaseArgs([
      "build",
      "--config",
      "/private/wrangler.toml",
      "--environment",
      "staging",
      "--release",
      "release-1",
      "--evidence",
      "/private/build.jsonl",
      "--state",
      "/private/publication-state.jsonl",
      "--execute",
    ]),
  ).toThrow("--execute requires --review");
});

test("evidence stays external, physical, and exactly mode 0600", async () => {
  const input = fixture();
  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), evidence: join(input.repository, "evidence.jsonl") },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
      },
    ),
  ).rejects.toThrow("outside source repositories");
  writeFileSync(input.evidence, "", { mode: 0o644 });
  chmodSync(input.evidence, 0o644);
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("mode must be exactly 0600");
  rmSync(input.evidence);
  symlinkSync(join(input.operator, "elsewhere"), input.evidence);
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("physical file");
});

test("evidence and publication state reject any Git worktree, hardlink, or inode swap", async () => {
  const input = fixture();
  mkdirSync(join(input.operator, ".git"));
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("outside every Git worktree");
  rmSync(join(input.operator, ".git"), { recursive: true });

  writePrivate(input.state, "");
  const linked = join(input.operator, "linked-state.jsonl");
  Bun.spawnSync(["ln", input.state, linked]);
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("exactly one link");
});

test("release outputs cannot alias config or input evidence through paths or inodes", async () => {
  for (const aliasKind of ["exact", "symlink-parent"] as const) {
    const input = fixture();
    chmodSync(input.config, 0o600);
    const configBytes = readFileSync(input.config);
    let evidence = input.config;
    if (aliasKind === "symlink-parent") {
      const aliasRoot = join(dirname(input.operator), "operator-alias");
      symlinkSync(input.operator, aliasRoot, "dir");
      evidence = join(aliasRoot, basename(input.config));
    }
    const journalRoot = join(input.operator, `coordination-${aliasKind}`);
    let materializations = 0;
    await expect(
      runRunnerImageRelease(
        { ...buildOptions(input, "staging", true), evidence },
        {
          repositoryRoot: input.repository,
          git: gitFor("fix/TASK-0032-runner-image"),
          accountId: "b".repeat(32),
          publicationJournalRoot: journalRoot,
          materializeSource: async () => {
            materializations += 1;
            throw new Error("must fail before materialization");
          },
        },
      ),
    ).rejects.toThrow("runner_image_release_path_alias");
    expect(readFileSync(input.config)).toEqual(configBytes);
    expect(materializations).toBe(0);
    expect(existsSync(journalRoot)).toBeFalse();
  }

  const hardlinked = fixture();
  chmodSync(hardlinked.config, 0o600);
  const original = readFileSync(hardlinked.config);
  linkSync(hardlinked.config, hardlinked.evidence);
  await expect(
    runRunnerImageRelease(buildOptions(hardlinked, "staging", true), {
      repositoryRoot: hardlinked.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      accountId: "b".repeat(32),
    }),
  ).rejects.toThrow(/single-link physical file|runner_image_release_path_alias/);
  expect(readFileSync(hardlinked.config)).toEqual(original);

  const verification = fixture(NEXT);
  writeBuildEvidence(verification);
  writePlatformEvidence(verification);
  const aliasRoot = join(dirname(verification.operator), "verify-operator-alias");
  symlinkSync(verification.operator, aliasRoot, "dir");
  await expect(
    runRunnerImageRelease(
      {
        ...verifyOptions(verification, false),
        evidence: join(aliasRoot, basename(verification.buildEvidence)),
      },
      {
        repositoryRoot: verification.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
      },
    ),
  ).rejects.toThrow("runner_image_release_path_alias");
});

test("terminal evidence cannot alias deterministic publication coordination", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-coordination");
  mkdirSync(journalRoot, { mode: 0o700 });
  const paths = publicationCoordinationPaths(journalRoot);
  const sentinel = "locator-sentinel\n";
  writePrivate(paths.locator, sentinel);

  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input, "staging", true),
        evidence: paths.locator,
      },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        accountId: "c".repeat(32),
        publicationJournalRoot: journalRoot,
        command: async () => {
          throw new Error("must fail before any command");
        },
      },
    ),
  ).rejects.toThrow("runner_image_release_path_alias");
  expect(readFileSync(paths.locator, "utf8")).toBe(sentinel);
  expect(existsSync(paths.lock)).toBeFalse();
});

test("release state and evidence reject every deterministic lock alias before mutation", async () => {
  const cases = [
    {
      name: "state equals evidence",
      paths(input: Fixture, _lock: string, _pending: string) {
        return { evidence: input.evidence, state: input.evidence, sentinel: input.evidence };
      },
    },
    {
      name: "evidence equals lock",
      paths(input: Fixture, lock: string, _pending: string) {
        return { evidence: lock, state: input.state, sentinel: lock };
      },
    },
    {
      name: "state equals lock",
      paths(input: Fixture, lock: string, _pending: string) {
        return { evidence: input.evidence, state: lock, sentinel: lock };
      },
    },
    {
      name: "evidence occupies pending-lock namespace",
      paths(input: Fixture, _lock: string, pending: string) {
        return { evidence: pending, state: input.state, sentinel: pending };
      },
    },
    {
      name: "state occupies pending-lock namespace",
      paths(input: Fixture, _lock: string, pending: string) {
        return { evidence: input.evidence, state: pending, sentinel: pending };
      },
    },
  ] as const;

  for (const entry of cases) {
    const input = fixture();
    const journalRoot = join(input.operator, `coordination-${entry.name.replaceAll(" ", "-")}`);
    mkdirSync(journalRoot, { mode: 0o700 });
    const coordination = publicationCoordinationPaths(journalRoot);
    const pending = `${coordination.lock}.pending-${process.pid}-${"a".repeat(32)}`;
    const paths = entry.paths(input, coordination.lock, pending);
    const sentinel = `${entry.name}\n`;
    writePrivate(paths.sentinel, sentinel);
    const configBytes = readFileSync(input.config);
    let materializations = 0;
    let commands = 0;

    await expect(
      runRunnerImageRelease(
        {
          ...buildOptions(input, "staging", true),
          evidence: paths.evidence,
          state: paths.state,
        },
        {
          repositoryRoot: input.repository,
          git: gitFor("fix/TASK-0032-runner-image"),
          accountId: "b".repeat(32),
          publicationJournalRoot: journalRoot,
          materializeSource: async () => {
            materializations += 1;
            throw new Error("must fail before source materialization");
          },
          command: async () => {
            commands += 1;
            throw new Error("must fail before provider command");
          },
        },
      ),
    ).rejects.toThrow("runner_image_release_path_alias");
    expect(readFileSync(paths.sentinel, "utf8")).toBe(sentinel);
    expect(readFileSync(input.config)).toEqual(configBytes);
    expect(materializations).toBe(0);
    expect(commands).toBe(0);
  }
});

test("an unresolved publication blocks every later nonce until exact read-only reconciliation", async () => {
  const input = fixture();
  writePrivate(
    input.state,
    `${JSON.stringify(publicationAttempt(input))}\n`,
  );
  let nonceCalls = 0;
  await expect(
    runRunnerImageRelease(buildOptions(input, "staging", true), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      accountId: "b".repeat(32),
      nonce: () => {
        nonceCalls += 1;
        return "02".repeat(16);
      },
      command: async () => {
        throw new Error("must not invoke a child command");
      },
    }),
  ).rejects.toThrow("runner_image_publication_journal_unbound");
  expect(nonceCalls).toBe(0);

  const reconciled = await runRunnerImageRelease(
    {
      ...buildOptions(input),
      command: "reconcile",
    },
    {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      materializeSource: materializeFixtureSource,
      command: withLegacyLocalImageProof(async (_executable, args) => {
        expect(args).toEqual(["manifest", "inspect", "--verbose", TRANSPORT_REF]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Descriptor: {
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
              digest: `sha256:${"d".repeat(64)}`,
              platform: { architecture: "amd64", os: "linux" },
            },
            SchemaV2Manifest: {
              schemaVersion: 2,
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
              config: { digest: `sha256:${"f".repeat(64)}` },
            },
          }),
          stderr: "",
        };
      }),
    },
  );
  expect(reconciled).toMatchObject({ status: "published", image: { immutableRef: NEXT } });
});

test("initial journal adoption refuses an explicit descriptor without binding or mutating it", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  const coordination = publicationCoordinationPaths(journalRoot);
  writePrivate(
    input.state,
    `${JSON.stringify(publicationAttempt(input, {
      localDescriptorDigest: `sha256:${"d".repeat(64)}`,
    }))}\n`,
  );
  const beforeBytes = readFileSync(input.state);
  const before = statSync(input.state, { bigint: true });
  let materializations = 0;
  let commands = 0;

  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        publicationJournalRoot: journalRoot,
        materializeSource: async () => {
          materializations += 1;
          throw new Error("unbound explicit attempt must not materialize");
        },
        command: async () => {
          commands += 1;
          throw new Error("unbound explicit attempt must not inspect images");
        },
      },
    ),
  ).rejects.toThrow("runner_image_publication_journal_adoption_invalid");

  const after = statSync(input.state, { bigint: true });
  expect(readFileSync(input.state)).toEqual(beforeBytes);
  expect({
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
    nlink: after.nlink,
    size: after.size,
  }).toEqual({
    dev: before.dev,
    ino: before.ino,
    mode: before.mode,
    nlink: before.nlink,
    size: before.size,
  });
  expect(existsSync(coordination.locator)).toBeFalse();
  expect(existsSync(coordination.lock)).toBeFalse();
  expect(materializations).toBe(0);
  expect(commands).toBe(0);
});

test("a pushed descendant tool reconciles the exact archived attempt under the journal lock", async () => {
  const input = fixture();
  writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
  const attempt = publicationAttempt(input);
  writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
  writeFileSync(
    join(input.repository, "runner", "Dockerfile"),
    `${DOCKERFILE}# current reconciliation tool changed this file\n`,
  );
  let lockLinked = false;
  const operations: string[] = [];

  const reconciled = await runRunnerImageRelease(
    { ...buildOptions(input), command: "reconcile" },
    {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image", {
        head: RECONCILER_COMMIT,
        originCommit: RECONCILER_COMMIT,
        remoteCommit: RECONCILER_COMMIT,
      }),
      publicationLockHook: async (phase) => {
        if (phase === "linked") lockLinked = true;
      },
      materializeSource: async (repositoryRoot, commit, destination) => {
        expect(lockLinked).toBe(true);
        expect(commit).toBe(COMMIT);
        operations.push("materialize");
        cpSync(repositoryRoot, destination, { recursive: true });
        writeFileSync(join(destination, "runner", "Dockerfile"), DOCKERFILE);
      },
      command: async (executable, args) => {
        expect(lockLinked).toBe(true);
        expect(executable).toBe("docker");
        if (args[0] === "image") {
          operations.push("local-inspect");
          return legacyLocalImageInspect();
        }
        expect(args).toEqual(["manifest", "inspect", "--verbose", TRANSPORT_REF]);
        operations.push("remote-readback");
        return successfulPublicationCommand(executable, args);
      },
    },
  );

  expect(operations).toEqual([
    "local-inspect",
    "materialize",
    "local-inspect",
    "remote-readback",
  ]);
  expect(reconciled).toMatchObject({
    status: "published",
    source: {
      branch: attempt.source.branch,
      commit: attempt.source.commit,
      dockerfileSha256: attempt.source.dockerfileSha256,
      buildContextSha256: attempt.source.buildContextSha256,
    },
    reconciledBy: {
      branch: "fix/TASK-0032-runner-image",
      commit: RECONCILER_COMMIT,
    },
    image: { immutableRef: NEXT },
    review: attempt.review,
  });
});

test("historical reconciliation rejects untrusted current or attempt Git history before archive or readback", async () => {
  const branch = "fix/TASK-0032-runner-image";
  const trusted = {
    head: RECONCILER_COMMIT,
    originCommit: RECONCILER_COMMIT,
    remoteCommit: RECONCILER_COMMIT,
  } as const;
  const cases: ReadonlyArray<{
    name: string;
    attemptBranch?: string;
    git: Parameters<typeof gitFor>[1];
    error: string;
  }> = [
    {
      name: "different branch",
      attemptBranch: "other-branch",
      git: trusted,
      error: "runner_image_publication_reconciliation_identity_mismatch",
    },
    {
      name: "unpushed reconciliation tool",
      git: { ...trusted, remoteCommit: "8".repeat(40) },
      error: `must equal pushed origin/${branch}`,
    },
    {
      name: "missing historical commit",
      git: { ...trusted, missingCommits: [COMMIT] },
      error: "runner_image_publication_attempt_history_invalid",
    },
    {
      name: "rewritten historical object",
      git: {
        ...trusted,
        resolvedCommits: { [COMMIT]: "7".repeat(40) },
      },
      error: "runner_image_publication_attempt_history_invalid",
    },
    {
      name: "non-ancestor or shallow history",
      git: {
        ...trusted,
        nonAncestorPairs: [`${COMMIT}:${RECONCILER_COMMIT}`],
      },
      error: "runner_image_publication_attempt_history_invalid",
    },
    {
      name: "replace ref",
      git: { ...trusted, replaceRefs: "refs/replace/aaaaaaaa" },
      error: "runner_image_git_replace_refs_forbidden",
    },
  ];

  for (const scenario of cases) {
    const input = fixture();
    writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
    const attempt = publicationAttempt(input, {
      ...(scenario.attemptBranch ? { branch: scenario.attemptBranch } : {}),
    });
    writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
    let materializations = 0;
    let readbacks = 0;
    await expect(
      runRunnerImageRelease(
        { ...buildOptions(input), command: "reconcile" },
        {
          repositoryRoot: input.repository,
          git: gitFor(branch, scenario.git),
          materializeSource: async () => {
            materializations += 1;
          },
          command: withLegacyLocalImageProof(async () => {
            readbacks += 1;
            throw new Error("untrusted history reached readback");
          }),
        },
      ),
      scenario.name,
    ).rejects.toThrow(scenario.error);
    expect(materializations, scenario.name).toBe(0);
    expect(readbacks, scenario.name).toBe(0);
  }
});

test("historical reconciliation requires the archived Dockerfile and full source seal", async () => {
  for (const mismatch of ["dockerfile", "context"] as const) {
    const input = fixture();
    writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
    const attempt = publicationAttempt(input);
    writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
    let readbacks = 0;

    await expect(
      runRunnerImageRelease(
        { ...buildOptions(input), command: "reconcile" },
        {
          repositoryRoot: input.repository,
          git: gitFor("fix/TASK-0032-runner-image", {
            head: RECONCILER_COMMIT,
            originCommit: RECONCILER_COMMIT,
            remoteCommit: RECONCILER_COMMIT,
          }),
          materializeSource: async (repositoryRoot, commit, destination) => {
            await materializeFixtureSource(repositoryRoot, commit, destination);
            if (mismatch === "dockerfile") {
              writeFileSync(
                join(destination, "runner", "Dockerfile"),
                `${DOCKERFILE}# historical bytes changed\n`,
              );
            } else {
              writeFileSync(join(destination, "unrecorded-source.txt"), "changed\n");
            }
          },
          command: withLegacyLocalImageProof(async () => {
            readbacks += 1;
            throw new Error("mismatched archive reached remote readback");
          }),
        },
      ),
      mismatch,
    ).rejects.toThrow("runner_image_historical_source_mismatch");
    expect(readbacks, mismatch).toBe(0);
  }
});

test("historical reconciliation archives with replace objects disabled and keeps archive failure unresolved", async () => {
  const input = fixture();
  writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
  const attempt = publicationAttempt(input);
  writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
  let archiveCalls = 0;
  let otherCommands = 0;

  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image", {
          head: RECONCILER_COMMIT,
          originCommit: RECONCILER_COMMIT,
          remoteCommit: RECONCILER_COMMIT,
        }),
        command: withLegacyLocalImageProof(async (executable, args) => {
          if (executable === "git") {
            archiveCalls += 1;
            expect(args.slice(0, 3)).toEqual([
              "--no-replace-objects",
              "archive",
              "--format=tar",
            ]);
            expect(args.at(-1)).toBe(COMMIT);
            return { exitCode: 128, stdout: "", stderr: "missing archive object" };
          }
          otherCommands += 1;
          throw new Error("archive failure reached another command");
        }),
      },
    ),
  ).rejects.toThrow("git --no-replace-objects archive --format=tar failed");
  expect(archiveCalls).toBe(1);
  expect(otherCommands).toBe(0);
  expect(readFileSync(input.state, "utf8").trim().split("\n")).toHaveLength(1);
});

test("historical reconciliation keeps config path, bytes, previous image, and transport repository exact", async () => {
  const differentPrevious =
    `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"e".repeat(64)}`;
  const differentTransport =
    `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner:${TRANSPORT_TAG}`;
  for (const drift of ["path", "bytes", "previous-image", "transport"] as const) {
    const input = fixture();
    writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
    const attempt = publicationAttempt(input, {
      ...(drift === "path"
        ? { configPath: join(input.operator, "other-wrangler.toml") }
        : {}),
      ...(drift === "previous-image" ? { previousImage: differentPrevious } : {}),
      ...(drift === "transport" ? { transportRef: differentTransport } : {}),
    });
    writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
    if (drift === "bytes") {
      writeFileSync(input.config, `${input.configSource}# current config drift\n`);
    }
    let materializations = 0;
    let readbacks = 0;

    await expect(
      runRunnerImageRelease(
        { ...buildOptions(input), command: "reconcile" },
        {
          repositoryRoot: input.repository,
          git: gitFor("fix/TASK-0032-runner-image", {
            head: RECONCILER_COMMIT,
            originCommit: RECONCILER_COMMIT,
            remoteCommit: RECONCILER_COMMIT,
          }),
          materializeSource: async () => {
            materializations += 1;
          },
          command: withLegacyLocalImageProof(async () => {
            readbacks += 1;
            throw new Error("identity drift reached readback");
          }),
        },
      ),
      drift,
    ).rejects.toThrow("runner_image_publication_reconciliation_identity_mismatch");
    expect(materializations, drift).toBe(0);
    expect(readbacks, drift).toBe(0);
  }
});

test("historical reconciliation revalidates external config bytes after archive materialization", async () => {
  const input = fixture();
  writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
  const attempt = publicationAttempt(input);
  writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
  let readbacks = 0;
  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image", {
          head: RECONCILER_COMMIT,
          originCommit: RECONCILER_COMMIT,
          remoteCommit: RECONCILER_COMMIT,
        }),
        materializeSource: async (repositoryRoot, commit, destination) => {
          await materializeFixtureSource(repositoryRoot, commit, destination);
          writeFileSync(input.config, `${input.configSource}# raced config bytes\n`);
        },
        command: withLegacyLocalImageProof(async () => {
          readbacks += 1;
          return successfulPublicationCommand("docker", [
            "manifest",
            "inspect",
            "--verbose",
            TRANSPORT_REF,
          ]);
        }),
      },
    ),
  ).rejects.toThrow("runner_image_publication_reconciliation_identity_mismatch");
  expect(readbacks).toBe(0);
});

test("historical reconciliation leaves the attempt unresolved when the remote descriptor differs", async () => {
  const input = fixture();
  writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
  const attempt = publicationAttempt(input);
  writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image", {
          head: RECONCILER_COMMIT,
          originCommit: RECONCILER_COMMIT,
          remoteCommit: RECONCILER_COMMIT,
        }),
        materializeSource: materializeFixtureSource,
        command: withLegacyLocalImageProof(async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            Descriptor: {
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
              digest: `sha256:${"e".repeat(64)}`,
              platform: { architecture: "amd64", os: "linux" },
            },
            SchemaV2Manifest: {
              schemaVersion: 2,
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
              config: { digest: `sha256:${"f".repeat(64)}` },
            },
          }),
          stderr: "",
        })),
      },
    ),
  ).rejects.toThrow("runner_image_remote_content_mismatch");
  expect(readFileSync(input.state, "utf8").trim().split("\n")).toHaveLength(1);
});

test("a recovered historical build verifies activation on the trusted reconciler commit", async () => {
  const input = fixture();
  writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
  const attempt = publicationAttempt(input);
  writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
  writeFileSync(
    join(input.repository, "runner", "Dockerfile"),
    `${DOCKERFILE}# reconciler-only tool change\n`,
  );
  const trustedGit = gitFor("fix/TASK-0032-runner-image", {
    head: RECONCILER_COMMIT,
    originCommit: RECONCILER_COMMIT,
    remoteCommit: RECONCILER_COMMIT,
  });
  const reconciled = await runRunnerImageRelease(
    { ...buildOptions(input), command: "reconcile" },
    {
      repositoryRoot: input.repository,
      git: trustedGit,
      materializeSource: async (repositoryRoot, commit, destination) => {
        await materializeFixtureSource(repositoryRoot, commit, destination);
        writeFileSync(join(destination, "runner", "Dockerfile"), DOCKERFILE);
      },
      command: withLegacyLocalImageProof(successfulPublicationCommand),
    },
  );
  writePrivate(input.buildEvidence, `${JSON.stringify(reconciled)}\n`);
  const activatedConfig = realizedConfig(
    input.repository,
    input.operator,
    NEXT,
  );
  writeFileSync(input.config, activatedConfig);
  writePlatformEvidence(input, {
    sourceCommit: RECONCILER_COMMIT,
    configSha256: sha256(activatedConfig),
  });
  const readback = verificationCommand();

  await expect(
    runRunnerImageRelease(verifyOptions(input), {
      repositoryRoot: input.repository,
      git: trustedGit,
      command: readback.command,
      wait: async () => undefined,
    }),
  ).resolves.toMatchObject({
    operation: "verify",
    status: "verified",
    source: {
      branch: "fix/TASK-0032-runner-image",
      commit: RECONCILER_COMMIT,
    },
    image: NEXT,
  });
});

test("legacy reconciliation proves the recorded Docker Id through the exact local tag before remote readback", async () => {
  const input = fixture();
  writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
  const journalRoot = join(input.operator, "publication-locator");
  const coordination = publicationCoordinationPaths(journalRoot);
  const attempt = publicationAttempt(input, { localDescriptorDigest: null });
  writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
  const operations: string[] = [];

  const reconciled = await runRunnerImageRelease(
    { ...buildOptions(input), command: "reconcile" },
    {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image", {
        head: RECONCILER_COMMIT,
        originCommit: RECONCILER_COMMIT,
        remoteCommit: RECONCILER_COMMIT,
      }),
      publicationJournalRoot: journalRoot,
      materializeSource: async (repositoryRoot, commit, destination) => {
        expect(commit).toBe(COMMIT);
        operations.push("materialize");
        await materializeFixtureSource(repositoryRoot, commit, destination);
      },
      command: async (executable, args) => {
        expect(executable).toBe("docker");
        if (args[0] === "image") {
          expect(args).toEqual([
            "image",
            "inspect",
            `takosumi-runner:${TRANSPORT_TAG}`,
            "--format",
            "{{json .}}",
          ]);
          operations.push("local-inspect");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: `sha256:${"d".repeat(64)}`,
              Descriptor: {
                digest: `sha256:${"d".repeat(64)}`,
                mediaType: "application/vnd.oci.image.manifest.v1+json",
              },
              Os: "linux",
              Architecture: "amd64",
            }),
            stderr: "",
          };
        }
        expect(args).toEqual(["manifest", "inspect", "--verbose", TRANSPORT_REF]);
        operations.push("remote-readback");
        return successfulPublicationCommand(executable, args);
      },
    },
  );

  expect(operations).toEqual([
    "local-inspect",
    "materialize",
    "local-inspect",
    "remote-readback",
  ]);
  expect(reconciled).toMatchObject({
    status: "published",
    source: { commit: COMMIT },
    reconciledBy: { commit: RECONCILER_COMMIT },
    image: { immutableRef: NEXT },
  });
  expect(existsSync(coordination.locator)).toBeTrue();
  expect(existsSync(coordination.lock)).toBeFalse();
});

test("legacy reconciliation stays unresolved when the exact local tag is absent or has different identity", async () => {
  const identities: Array<
    | null
    | Readonly<{ imageId: string; descriptorDigest: string }>
  > = [
    null,
    {
      imageId: `sha256:${"e".repeat(64)}`,
      descriptorDigest: `sha256:${"d".repeat(64)}`,
    },
    {
      imageId: `sha256:${"d".repeat(64)}`,
      descriptorDigest: `sha256:${"e".repeat(64)}`,
    },
  ];
  for (const identity of identities) {
    const input = fixture();
    writeSourcePin(input.sourcePin, RECONCILER_COMMIT);
    const journalRoot = join(input.operator, "publication-locator");
    const coordination = publicationCoordinationPaths(journalRoot);
    const attempt = publicationAttempt(input, { localDescriptorDigest: null });
    writePrivate(input.state, `${JSON.stringify(attempt)}\n`);
    let remoteReadbacks = 0;

    const reconciliation = runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image", {
          head: RECONCILER_COMMIT,
          originCommit: RECONCILER_COMMIT,
          remoteCommit: RECONCILER_COMMIT,
        }),
        materializeSource: materializeFixtureSource,
        publicationJournalRoot: journalRoot,
        command: async (_executable, args) => {
          if (args[0] !== "image") {
            remoteReadbacks += 1;
            throw new Error("remote readback must not follow failed local proof");
          }
          if (identity === null) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: `No such image: takosumi-runner:${TRANSPORT_TAG}`,
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: identity.imageId,
              Descriptor: {
                digest: identity.descriptorDigest,
                mediaType: "application/vnd.oci.image.manifest.v1+json",
              },
              Os: "linux",
              Architecture: "amd64",
            }),
            stderr: "",
          };
        },
      },
    );

    if (identity === null) {
      await expect(reconciliation).rejects.toThrow(
        "docker image inspect takosumi-runner",
      );
    } else {
      await expect(reconciliation).rejects.toThrow(
        "runner_image_legacy_local_identity_mismatch",
      );
    }
    expect(remoteReadbacks).toBe(0);
    expect(readFileSync(input.state, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(coordination.locator)).toBeFalse();
    expect(existsSync(coordination.lock)).toBeFalse();
  }
});

test("an already-bound OCI attempt uses its explicit descriptor and retains the actual config digest", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  await bindDescriptorAwareAttemptThroughBuild(input, journalRoot);
  const descriptorDigest = `sha256:${"d".repeat(64)}`;
  const imageConfigDigest = `sha256:${"3".repeat(64)}`;
  const immutableRef =
    `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@${descriptorDigest}`;
  const reconciled = await runRunnerImageRelease(
    { ...buildOptions(input), command: "reconcile" },
    {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      materializeSource: materializeFixtureSource,
      publicationJournalRoot: journalRoot,
      command: async (_executable, args) => {
        expect(args).toEqual(["manifest", "inspect", "--verbose", TRANSPORT_REF]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Descriptor: {
              mediaType: "application/vnd.oci.image.manifest.v1+json",
              digest: descriptorDigest,
              platform: { architecture: "amd64", os: "linux" },
            },
            OCIManifest: {
              schemaVersion: 2,
              mediaType: "application/vnd.oci.image.manifest.v1+json",
              config: { digest: imageConfigDigest },
            },
          }),
          stderr: "",
        };
      },
    },
  );
  expect(reconciled).toMatchObject({
    status: "published",
    image: { immutableRef, imageConfigDigest },
  });

  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        materializeSource: materializeFixtureSource,
        publicationJournalRoot: journalRoot,
        command: async () => {
          throw new Error("resolved reconciliation must not inspect again");
        },
      },
    ),
  ).resolves.toMatchObject({
    status: "published",
    image: { immutableRef, imageConfigDigest },
  });
});

test("a persisted resolution must bind the attempt to the descriptor rather than only the config", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  await bindDescriptorAwareAttemptThroughBuild(input, journalRoot);
  const localDescriptorDigest = `sha256:${"d".repeat(64)}`;
  await runRunnerImageRelease(
    { ...buildOptions(input), command: "reconcile" },
    {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      materializeSource: materializeFixtureSource,
      publicationJournalRoot: journalRoot,
      command: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          Descriptor: {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: localDescriptorDigest,
            platform: { architecture: "amd64", os: "linux" },
          },
          OCIManifest: {
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            config: { digest: localDescriptorDigest },
          },
        }),
        stderr: "",
      }),
    },
  );
  const [attempt, resolution] = readFileSync(input.state, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line)) as [
    unknown,
    { immutableRef: string; build: { image: { immutableRef: string } } },
  ];
  const mismatchedImmutableRef =
    `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"e".repeat(64)}`;
  resolution.immutableRef = mismatchedImmutableRef;
  resolution.build.image.immutableRef = mismatchedImmutableRef;
  writePrivate(
    input.state,
    `${JSON.stringify(attempt)}\n${JSON.stringify(resolution)}\n`,
  );

  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        materializeSource: materializeFixtureSource,
        publicationJournalRoot: journalRoot,
        command: async () => {
          throw new Error("invalid persisted resolution must not inspect again");
        },
      },
    ),
  ).rejects.toThrow("runner_image_publication_state_invalid");
});

test("a release-scope journal locator rejects an alternate caller-selected state path", async () => {
  const input = fixture();
  writePrivate(input.state, `${JSON.stringify(publicationAttempt(input))}\n`);
  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        materializeSource: materializeFixtureSource,
        command: withLegacyLocalImageProof(async () => ({
          exitCode: 2,
          stdout: "",
          stderr: "network timeout while reading manifest",
        })),
      },
    ),
  ).rejects.toThrow("docker manifest inspect --verbose failed with exit 2");

  const alternateState = join(input.operator, "alternate-publication-state.jsonl");
  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input, "staging", true), state: alternateState },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        accountId: "b".repeat(32),
        nonce: () => "03".repeat(16),
      },
    ),
  ).rejects.toThrow("runner_image_publication_state_path_mismatch");
});

test("the release-scope journal lock serializes unresolved-check and publication attempt", async () => {
  const input = fixture();
  let enteredMaterialization!: () => void;
  const materializationEntered = new Promise<void>((resolve) => {
    enteredMaterialization = resolve;
  });
  let releaseMaterialization!: () => void;
  const holdMaterialization = new Promise<void>((resolve) => {
    releaseMaterialization = resolve;
  });
  const first = runRunnerImageRelease(buildOptions(input, "staging", true), {
    repositoryRoot: input.repository,
    git: gitFor("fix/TASK-0032-runner-image"),
    nonce: () => "02".repeat(16),
    accountId: "b".repeat(32),
    materializeSource: async () => {
      enteredMaterialization();
      await holdMaterialization;
      throw new Error("stop-first-build");
    },
  });
  await materializationEntered;
  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input, "staging", true),
        evidence: join(input.operator, "concurrent-evidence.jsonl"),
      },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        accountId: "b".repeat(32),
        nonce: () => "03".repeat(16),
      },
    ),
  ).rejects.toThrow("runner_image_publication_locked");
  releaseMaterialization();
  await expect(first).rejects.toThrow("stop-first-build");
});

test("publication target account must equal the realized previous-image account before locking or pushing", async () => {
  const input = fixture();
  let childCalls = 0;
  await expect(
    runRunnerImageRelease(buildOptions(input, "staging", true), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      accountId: "c".repeat(32),
      nonce: () => "02".repeat(16),
      command: async () => {
        childCalls += 1;
        throw new Error("must not invoke a child command");
      },
    }),
  ).rejects.toThrow("runner_image_publication_account_mismatch");
  expect(childCalls).toBe(0);
});

test("a mismatched prior-image account cannot fork the lock and race the same publication target", async () => {
  const firstInput = fixture();
  const mismatchedInput = fixture(
    `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner@sha256:${"d".repeat(64)}`,
  );
  const journalRoot = join(firstInput.operator, "publication-locator");
  let enteredMaterialization!: () => void;
  const materializationEntered = new Promise<void>((resolve) => {
    enteredMaterialization = resolve;
  });
  let releaseMaterialization!: () => void;
  const holdMaterialization = new Promise<void>((resolve) => {
    releaseMaterialization = resolve;
  });
  const first = runRunnerImageRelease(
    buildOptions(firstInput, "staging", true),
    {
      repositoryRoot: firstInput.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      accountId: "b".repeat(32),
      nonce: () => "02".repeat(16),
      publicationJournalRoot: journalRoot,
      materializeSource: async () => {
        enteredMaterialization();
        await holdMaterialization;
        throw new Error("stop-first-build");
      },
    },
  );
  await materializationEntered;

  let secondMutationCalls = 0;
  await expect(
    runRunnerImageRelease(
      buildOptions(mismatchedInput, "staging", true),
      {
        repositoryRoot: mismatchedInput.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        accountId: "b".repeat(32),
        nonce: () => {
          secondMutationCalls += 1;
          return "03".repeat(16);
        },
        publicationJournalRoot: journalRoot,
        materializeSource: async () => {
          secondMutationCalls += 1;
        },
        command: async () => {
          secondMutationCalls += 1;
          throw new Error("must not invoke a child command");
        },
      },
    ),
  ).rejects.toThrow("runner_image_publication_account_mismatch");
  expect(secondMutationCalls).toBe(0);

  releaseMaterialization();
  await expect(first).rejects.toThrow("stop-first-build");
});

test("a valid dead-process journal lock is reclaimed without weakening active-lock exclusion", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  await runRunnerImageRelease(buildOptions(input, "staging", true), {
    ...buildRuntime(input, successfulPublicationCommand),
    publicationJournalRoot: journalRoot,
  });
  const locatorName = readdirSync(journalRoot).find((name) =>
    name.endsWith(".locator.json"),
  );
  expect(locatorName).toBeDefined();
  const locator = JSON.parse(
    readFileSync(join(journalRoot, locatorName!), "utf8"),
  ) as {
    scope: string;
    hostIdentity: {
      machineIdSha256: string;
      pidNamespaceDev: string;
      pidNamespaceIno: string;
    };
  };
  const lockPath = join(
    journalRoot,
    locatorName!.replace(/\.locator\.json$/u, ".lock"),
  );
  writePrivate(lockPath, "");
  const lockStatus = statSync(lockPath, { bigint: true });
  const pendingName = `${basename(lockPath)}.pending-2147483647-${"a".repeat(32)}`;
  writePrivate(
    lockPath,
    `${JSON.stringify({
      kind: "takosumi.runner-image-publication-lock@v3",
      scope: locator.scope,
      lockPath,
      pendingName,
      fileIdentity: {
        dev: lockStatus.dev.toString(),
        ino: lockStatus.ino.toString(),
        birthtimeNs: lockStatus.birthtimeNs.toString(),
      },
      hostIdentity: locator.hostIdentity,
      pid: 2_147_483_647,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      processStartTicks: "1",
      acquiredAt: "2026-08-27T00:00:00.000Z",
    })}\n`,
  );
  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input, "staging", true),
        evidence: join(input.operator, "second-build.jsonl"),
      },
      {
        ...buildRuntime(input, successfulPublicationCommand),
        nonce: () => "02".repeat(16),
        publicationJournalRoot: journalRoot,
      },
    ),
  ).resolves.toMatchObject({ status: "published" });
});

test("lock publication is atomic when the owner crashes before the canonical link", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  await expect(
    runRunnerImageRelease(buildOptions(input, "staging", true), {
      ...buildRuntime(input, successfulPublicationCommand),
      publicationJournalRoot: journalRoot,
      publicationLockHook: async (phase) => {
        if (phase === "prepared") throw new Error("simulated-lock-owner-crash");
      },
    }),
  ).rejects.toThrow("simulated-lock-owner-crash");
  expect(
    existsSync(journalRoot) &&
      readdirSync(journalRoot).some((name) => name.endsWith(".lock")),
  ).toBe(false);

  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input, "staging", true),
        evidence: join(input.operator, "retry-after-lock-crash.jsonl"),
      },
      {
        ...buildRuntime(input, successfulPublicationCommand),
        publicationJournalRoot: journalRoot,
      },
    ),
  ).resolves.toMatchObject({ status: "published" });
});

test("a foreign-boot lock is never reclaimed as a dead local process", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  await runRunnerImageRelease(buildOptions(input, "staging", true), {
    ...buildRuntime(input, successfulPublicationCommand),
    publicationJournalRoot: journalRoot,
  });
  const locatorName = readdirSync(journalRoot).find((name) =>
    name.endsWith(".locator.json"),
  )!;
  const locator = JSON.parse(
    readFileSync(join(journalRoot, locatorName), "utf8"),
  ) as {
    scope: string;
    hostIdentity: {
      machineIdSha256: string;
      pidNamespaceDev: string;
      pidNamespaceIno: string;
    };
  };
  const lockPath = join(
    journalRoot,
    locatorName.replace(/\.locator\.json$/u, ".lock"),
  );
  writePrivate(lockPath, "");
  const status = statSync(lockPath, { bigint: true });
  writePrivate(
    lockPath,
    `${JSON.stringify({
      kind: "takosumi.runner-image-publication-lock@v3",
      scope: locator.scope,
      lockPath,
      pendingName: `${basename(lockPath)}.pending-${process.pid}-${"a".repeat(32)}`,
      fileIdentity: {
        dev: status.dev.toString(),
        ino: status.ino.toString(),
        birthtimeNs: status.birthtimeNs.toString(),
      },
      hostIdentity: locator.hostIdentity,
      pid: process.pid,
      bootId: "00000000-0000-4000-8000-000000000001",
      processStartTicks: "1",
      acquiredAt: "2026-08-27T00:00:00.000Z",
    })}\n`,
  );

  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input, "staging", true),
        evidence: join(input.operator, "foreign-boot.jsonl"),
      },
      {
        ...buildRuntime(input, successfulPublicationCommand),
        publicationJournalRoot: journalRoot,
      },
    ),
  ).rejects.toThrow("runner_image_publication_lock_foreign_boot");
  expect(existsSync(lockPath)).toBe(true);
});

test("the fixed journal locator enforces one physical host and PID namespace", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  await runRunnerImageRelease(buildOptions(input, "staging", true), {
    ...buildRuntime(input, successfulPublicationCommand),
    publicationJournalRoot: journalRoot,
  });
  const locatorName = readdirSync(journalRoot).find((name) =>
    name.endsWith(".locator.json"),
  )!;
  const locatorPath = join(journalRoot, locatorName);
  const locator = JSON.parse(readFileSync(locatorPath, "utf8")) as {
    hostIdentity: { machineIdSha256: string };
  };
  writePrivate(
    locatorPath,
    `${JSON.stringify({
      ...locator,
      hostIdentity: {
        ...locator.hostIdentity,
        machineIdSha256: `sha256:${"f".repeat(64)}`,
      },
    })}\n`,
  );
  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input, "staging", true),
        evidence: join(input.operator, "foreign-host.jsonl"),
      },
      {
        ...buildRuntime(input, successfulPublicationCommand),
        publicationJournalRoot: journalRoot,
      },
    ),
  ).rejects.toThrow("runner_image_publication_host_mismatch");
});

test("journal rotation after binding cannot bypass the descriptor-bound unresolved state", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  writePrivate(input.state, `${JSON.stringify(publicationAttempt(input))}\n`);
  await expect(
    runRunnerImageRelease(
      { ...buildOptions(input), command: "reconcile" },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        materializeSource: materializeFixtureSource,
        publicationJournalRoot: journalRoot,
        command: withLegacyLocalImageProof(async () => ({
          exitCode: 2,
          stdout: "",
          stderr: "network timeout while reading manifest",
        })),
      },
    ),
  ).rejects.toThrow("docker manifest inspect --verbose failed with exit 2");

  let nonceCalls = 0;
  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input, "staging", true),
        evidence: join(input.operator, "rotated-journal.jsonl"),
      },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        accountId: "b".repeat(32),
        nonce: () => {
          nonceCalls += 1;
          return "02".repeat(16);
        },
        publicationJournalRoot: journalRoot,
        publicationJournalHook: async (phase) => {
          if (phase !== "opened") return;
          renameSync(input.state, `${input.state}.rotated`);
          writePrivate(input.state, "");
        },
      },
    ),
  ).rejects.toThrow("runner_image_publication_journal_identity_changed");
  expect(nonceCalls).toBe(0);
});

test("a missing bound publication journal is never recreated as empty", async () => {
  const input = fixture();
  const journalRoot = join(input.operator, "publication-locator");
  await runRunnerImageRelease(buildOptions(input, "staging", true), {
    ...buildRuntime(input, successfulPublicationCommand),
    publicationJournalRoot: journalRoot,
  });
  rmSync(input.state);
  let nonceCalls = 0;
  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input, "staging", true),
        evidence: join(input.operator, "missing-journal.jsonl"),
      },
      {
        ...buildRuntime(input, successfulPublicationCommand),
        nonce: () => {
          nonceCalls += 1;
          return "02".repeat(16);
        },
        publicationJournalRoot: journalRoot,
      },
    ),
  ).rejects.toThrow("runner_image_publication_journal_missing");
  expect(nonceCalls).toBe(0);
});

test("a mismatched journal resolution cannot clear an unknown publication", async () => {
  const input = fixture();
  writePrivate(
    input.state,
    [
      JSON.stringify(publicationAttempt(input)),
      JSON.stringify({
        kind: "takosumi.runner-image-publication-state@v1",
        status: "reconciled-absent",
        environment: "staging",
        release: "different-release",
        observedAt: "2026-08-27T00:01:00.000Z",
        transportRef: TRANSPORT_REF,
        diagnostic: {
          code: "ReleaseCommandError",
          message: "manifest absent",
          command: "docker manifest inspect --verbose",
          exitCode: 1,
          stdout: "",
          stderr: `no such manifest: ${TRANSPORT_REF}`,
        },
      }),
      "",
    ].join("\n"),
  );
  let nonceCalls = 0;
  await expect(
    runRunnerImageRelease(buildOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      nonce: () => {
        nonceCalls += 1;
        return "02".repeat(16);
      },
    }),
  ).rejects.toThrow("runner_image_publication_state_invalid");
  expect(nonceCalls).toBe(0);
});

test("read-only reconciliation can prove an exact recorded transport tag absent", async () => {
  const input = fixture();
  writePrivate(input.state, `${JSON.stringify(publicationAttempt(input))}\n`);
  const reconciled = await runRunnerImageRelease(
    { ...buildOptions(input), command: "reconcile" },
    {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      materializeSource: materializeFixtureSource,
      command: withLegacyLocalImageProof(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: `no such manifest: ${TRANSPORT_REF}`,
      })),
    },
  );
  expect(reconciled).toMatchObject({
    operation: "reconcile",
    status: "absent",
    transportRef: TRANSPORT_REF,
  });
  await expect(
    runRunnerImageRelease(
      {
        ...buildOptions(input),
        evidence: join(input.operator, "alternate-build.jsonl"),
      },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        nonce: () => "02".repeat(16),
      },
    ),
  ).resolves.toMatchObject({ status: "planned" });
});

test("build publishes linux amd64 with generated transport identity and records remote digest", async () => {
  const input = fixture();
  const calls: string[][] = [];
  let pushedConfig = "";
  const record = await runRunnerImageRelease(buildOptions(input, "staging", true), {
    ...buildRuntime(input, async (_executable, args) => {
      if (args[0] === "buildx") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[1] === "containers" && args[2] === "push") {
        pushedConfig = readFileSync(args[args.indexOf("--config") + 1]!, "utf8");
        return { exitCode: 0, stdout: `Pushed image: ${TRANSPORT_REF}\n`, stderr: "" };
      }
      if (args[0] === "manifest") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Descriptor: {
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
              digest: `sha256:${"d".repeat(64)}`,
              platform: { os: "linux", architecture: "amd64" },
            },
            SchemaV2Manifest: {
              schemaVersion: 2,
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
              config: { digest: `sha256:${"f".repeat(64)}` },
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    }, calls, {
      Id: `sha256:${"6".repeat(64)}`,
      Descriptor: {
        digest: `sha256:${"d".repeat(64)}`,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      },
      Os: "linux",
      Architecture: "amd64",
    }),
  });
  expect(record).toMatchObject({
    status: "published",
    image: { transportTag: TRANSPORT_TAG, transportRef: TRANSPORT_REF, immutableRef: NEXT },
    config: {
      previousImage: PREVIOUS,
      expectedActivationSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    },
  });
  expect(calls.some((args) => args.includes("linux/amd64"))).toBeTrue();
  expect(pushedConfig).toBe(
    injectPlatformSourcePaths(
      input.configSource,
      join(input.repository, "deploy/platform/entry-worker.ts"),
      join(input.repository, "dashboard/dist"),
    ),
  );
  expect(calls.some((args) => args.some((value) => value.endsWith("/runner/Dockerfile")))).toBeTrue();
  expect(calls.some((args) => args[0] === "cosign" && args[1] === "verify-blob")).toBeTrue();
  expect(
    calls.some((args) =>
      args.some((value) => value.endsWith("refs/heads/v1.12")),
    ),
  ).toBeTrue();
  expect(calls.some((args) => args.includes("images") || args.includes("list"))).toBeFalse();
  expect(statSync(input.evidence).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(input.evidence, "utf8"))).toMatchObject({
    image: { immutableRef: NEXT },
  });
  const [attempt] = readFileSync(input.state, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line)) as [
    { image: { localImageId: string; localDescriptorDigest: string } },
  ];
  expect(attempt.image).toMatchObject({
    localImageId: `sha256:${"6".repeat(64)}`,
    localDescriptorDigest: `sha256:${"d".repeat(64)}`,
  });
});

test("build rejects a missing or invalid local image descriptor before publication", async () => {
  for (const localImageInspect of [
    {
      Id: "not-a-digest",
      Descriptor: {
        digest: `sha256:${"d".repeat(64)}`,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      },
      Os: "linux",
      Architecture: "amd64",
    },
    {
      Id: `sha256:${"d".repeat(64)}`,
      Os: "linux",
      Architecture: "amd64",
    },
    {
      Id: `sha256:${"d".repeat(64)}`,
      Descriptor: {
        digest: "not-a-digest",
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      },
      Os: "linux",
      Architecture: "amd64",
    },
    {
      Id: `sha256:${"d".repeat(64)}`,
      Descriptor: {
        digest: `sha256:${"d".repeat(64)}`,
        mediaType: "application/octet-stream",
      },
      Os: "linux",
      Architecture: "amd64",
    },
    {
      Id: `sha256:${"d".repeat(64)}`,
      Descriptor: {
        digest: `sha256:${"d".repeat(64)}`,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      },
      Os: "linux",
      Architecture: "arm64",
    },
  ]) {
    const input = fixture();
    let publicationCommands = 0;
    await expect(
      runRunnerImageRelease(buildOptions(input, "staging", true), {
        ...buildRuntime(
          input,
          async (_executable, args) => {
            if (args[0] === "buildx") {
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            publicationCommands += 1;
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
          undefined,
          localImageInspect,
        ),
      }),
    ).rejects.toThrow("runner_image_local_identity_invalid");
    expect(publicationCommands).toBe(0);
    expect(JSON.parse(readFileSync(input.evidence, "utf8"))).toMatchObject({
      status: "failed",
      mutationOutcome: "not-started",
      failureBoundary: "pre-mutation",
    });
  }
});

test("build records bounded pre-mutation diagnostics before any publication attempt", async () => {
  const input = fixture();
  await expect(
    runRunnerImageRelease(buildOptions(input, "staging", true), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      nonce: () => "01".repeat(16),
      accountId: "invalid-account",
      command: async () => {
        throw new Error("must not invoke a child command");
      },
    }),
  ).rejects.toThrow("runner_image_cloudflare_account_id_invalid");
  expect(JSON.parse(readFileSync(input.evidence, "utf8"))).toMatchObject({
    status: "failed",
    mutationOutcome: "not-started",
    failureBoundary: "pre-mutation",
    diagnostic: {
      message: "runner_image_cloudflare_account_id_invalid",
      command: null,
      stdout: "",
      stderr: "",
    },
  });
});

test("publication ambiguity records unknown outcome and never claims a digest", async () => {
  const input = fixture();
  await expect(
    runRunnerImageRelease(buildOptions(input, "staging", true), {
      ...buildRuntime(input, async (_executable, args) => {
        if (args[0] === "buildx") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[1] === "containers" && args[2] === "push") {
          return { exitCode: 0, stdout: "push accepted without identity", stderr: "" };
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }),
    }),
  ).rejects.toThrow("publication outcome is incomplete");
  const record = JSON.parse(readFileSync(input.evidence, "utf8"));
  expect(record).toMatchObject({
    status: "publication-incomplete",
    mutationOutcome: "unknown",
    transportTag: TRANSPORT_TAG,
  });
  expect(JSON.stringify(record)).not.toContain("immutableRef");
});

test("a local-tag interleaving race cannot bind different remotely pushed bytes", async () => {
  const input = fixture();
  await expect(
    runRunnerImageRelease(buildOptions(input, "staging", true), {
      ...buildRuntime(input, async (_executable, args) => {
        if (args[0] === "buildx") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[1] === "containers" && args[2] === "push") {
          return { exitCode: 0, stdout: `Pushed image: ${TRANSPORT_REF}\n`, stderr: "" };
        }
        if (args[0] === "manifest") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Descriptor: {
                mediaType: "application/vnd.docker.distribution.manifest.v2+json",
                digest: `sha256:${"e".repeat(64)}`,
                platform: { architecture: "amd64", os: "linux" },
              },
              SchemaV2Manifest: {
                schemaVersion: 2,
                mediaType: "application/vnd.docker.distribution.manifest.v2+json",
                config: { digest: `sha256:${"f".repeat(64)}` },
              },
            }),
            stderr: "",
          };
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }),
    }),
  ).rejects.toThrow("publication outcome is incomplete");
  expect(readFileSync(input.state, "utf8")).not.toContain('"status":"published"');
  expect(readFileSync(input.evidence, "utf8")).toContain(
    "runner_image_remote_content_mismatch",
  );
});

test("verify consumes exact platform evidence and performs no Worker mutation", async () => {
  const input = fixture(NEXT);
  writeBuildEvidence(input);
  writePlatformEvidence(input);
  const runtime = verificationCommand();
  const sealedConfigSources: string[] = [];
  const record = await runRunnerImageRelease(verifyOptions(input), {
    repositoryRoot: input.repository,
    git: gitFor("fix/TASK-0032-runner-image"),
    command: async (executable, args) => {
      const configIndex = args.indexOf("--config");
      if (configIndex !== -1) {
        const configPath = args[configIndex + 1]!;
        expect(configPath).not.toBe(input.config);
        sealedConfigSources.push(readFileSync(configPath, "utf8"));
      }
      return runtime.command(executable, args);
    },
  });
  expect(record).toMatchObject({
    status: "verified",
    image: NEXT,
    platform: { deployedVersionId: DEPLOYED_VERSION },
    application: { name: APPLICATION_NAME, image: NEXT, state: "ready" },
  });
  expect(runtime.calls.some((args) => args[1] === "deploy")).toBeFalse();
  const projectedConfig = injectPlatformSourcePaths(
    input.configSource,
    join(input.repository, "deploy/platform/entry-worker.ts"),
    join(input.repository, "dashboard/dist"),
  );
  expect(sealedConfigSources).toEqual([
    projectedConfig,
    projectedConfig,
    projectedConfig,
  ]);
  expect(statSync(input.evidence).mode & 0o777).toBe(0o600);
});

test("verify accepts a matching detail state but uses the unique list state", async () => {
  const input = fixture(NEXT);
  writeBuildEvidence(input);
  writePlatformEvidence(input);
  const runtime = verificationCommand({
    detail: healthyDetail(NEXT, { state: "ready" }),
  });
  const record = await runRunnerImageRelease(verifyOptions(input), {
    repositoryRoot: input.repository,
    git: gitFor("fix/TASK-0032-runner-image"),
    command: runtime.command,
  });
  expect(record).toMatchObject({
    status: "verified",
    application: { state: "ready" },
  });
});

test("verify rejects platform config or serving Version not bound to the build transform", async () => {
  const input = fixture(NEXT);
  writeBuildEvidence(input);
  writePlatformEvidence(input, { configSha256: `sha256:${"0".repeat(64)}` });
  let calls = 0;
  await expect(
    runRunnerImageRelease(verifyOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      command: async () => {
        calls += 1;
        throw new Error("must not read live state");
      },
    }),
  ).rejects.toThrow("platform evidence does not bind");
  expect(calls).toBe(0);

  rmSync(input.platformEvidence);
  writePlatformEvidence(input);
  const runtime = verificationCommand({ servingVersionId: PREDECESSOR_VERSION });
  await expect(
    runRunnerImageRelease(
      { ...verifyOptions(input), evidence: join(input.operator, "second.jsonl") },
      {
        repositoryRoot: input.repository,
        git: gitFor("fix/TASK-0032-runner-image"),
        command: runtime.command,
      },
    ),
  ).rejects.toThrow("Worker Version is not serving exactly");
});

test("verify rejects any config byte beyond the unique runner image replacement", async () => {
  const input = fixture(NEXT);
  writeBuildEvidence(input);
  writePlatformEvidence(input);
  const changed = input.configSource.replace("max_instances = 1", "max_instances = 2");
  writeFileSync(input.config, changed);
  await expect(
    runRunnerImageRelease(verifyOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
    }),
  ).rejects.toThrow("runner_image_activation_config_not_image_only");
});

test("verify requires exact Container application identity, image, rollout, and health", async () => {
  const scenarios = [
    {
      runtime: verificationCommand({
        summary: healthySummary(NEXT, "other-application"),
      }),
      expected: "missing or ambiguous",
    },
    {
      runtime: verificationCommand({
        summary: healthySummary(PREVIOUS),
        detail: healthyDetail(PREVIOUS, { id: "different" }),
      }),
      expected: "list/detail identity differs",
    },
    {
      runtime: verificationCommand({
        summary: healthySummary(NEXT),
        detail: healthyDetail(PREVIOUS),
      }),
      expected: "list/detail identity differs",
    },
    {
      runtime: verificationCommand({
        summary: healthySummary(NEXT),
        detail: healthyDetail(NEXT, { state: "deploying" }),
      }),
      expected: "list/detail identity differs",
    },
    {
      runtime: verificationCommand({
        summary: healthySummary(NEXT),
        detail: healthyDetail(NEXT, { state: null }),
      }),
      expected: "list/detail identity differs",
    },
    {
      runtime: verificationCommand({
        summary: healthySummary(NEXT),
        detail: healthyDetail(NEXT, { state: 7 }),
      }),
      expected: "list/detail identity differs",
    },
    {
      runtime: verificationCommand({
        summary: healthySummary(
          `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"9".repeat(64)}`,
        ),
        detail: healthyDetail(
          `registry.cloudflare.com/${"b".repeat(32)}/takosumi-runner@sha256:${"9".repeat(64)}`,
        ),
      }),
      expected: "unexpected image",
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const input = fixture(NEXT);
    writeBuildEvidence(input);
    writePlatformEvidence(input);
    await expect(
      runRunnerImageRelease(
        { ...verifyOptions(input), evidence: join(input.operator, `verify-${index}.jsonl`) },
        {
          repositoryRoot: input.repository,
          git: gitFor("fix/TASK-0032-runner-image"),
          command: scenario.runtime.command,
        },
      ),
    ).rejects.toThrow(scenario.expected);
  }
});

test("unsettled Container readback is bounded and records incomplete evidence", async () => {
  const input = fixture(NEXT);
  writeBuildEvidence(input);
  writePlatformEvidence(input);
  const runtime = verificationCommand({
    summary: { ...healthySummary(NEXT), state: "deploying" },
    detail: healthyDetail(NEXT, {
      state: "deploying",
      activeRolloutId: "rollout",
      starting: 1,
    }),
  });
  let waits = 0;
  await expect(
    runRunnerImageRelease(verifyOptions(input), {
      repositoryRoot: input.repository,
      git: gitFor("fix/TASK-0032-runner-image"),
      command: runtime.command,
      wait: async () => {
        waits += 1;
      },
    }),
  ).rejects.toThrow("did not reach exact healthy state");
  expect(waits).toBe(35);
  expect(JSON.parse(readFileSync(input.evidence, "utf8"))).toMatchObject({
    status: "incomplete",
    failure: "container-readback-incomplete",
  });
});
