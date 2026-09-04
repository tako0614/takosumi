import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { dashboardAssetTreeSeal } from "./platform-worker-release.ts";
import { lineageVerdict } from "./lib/deploy-lineage.ts";
import {
  injectPlatformSourcePaths,
  resolvePlatformReleaseSourceAuthority,
  type PlatformReleaseSourceAuthority,
} from "./lib/platform-release-source.ts";

export type RunnerImageReleaseCommand = "build" | "reconcile" | "verify";
export type RunnerImageReleaseEnvironment = "staging" | "production";

export type RunnerImageReleaseOptions = Readonly<{
  command: RunnerImageReleaseCommand;
  config: string;
  environment: RunnerImageReleaseEnvironment;
  release: string;
  evidence: string;
  state?: string;
  buildEvidence?: string;
  platformEvidence?: string;
  review?: string;
  execute: boolean;
}>;

type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type RepositoryIdentity = Readonly<{
  root: string;
  branch: string;
  commit: string;
  remoteCommit: string;
  remoteRepository: string;
}>;

type ReleaseContext = Readonly<{
  repository: RepositoryIdentity;
  releaseSource: PlatformReleaseSourceAuthority;
  config: Readonly<{
    path: string;
    source: string;
    sha256: string;
    workerName: string;
    runnerImage: string;
    runnerApplicationName: string;
  }>;
  dockerfileSha256: string;
}>;

export type RunnerImageBuildRecord = Readonly<{
  kind: "takosumi.runner-image-release@v2";
  operation: "build";
  status: "planned" | "published";
  environment: RunnerImageReleaseEnvironment;
  release: string;
  observedAt: string;
  source: {
    branch: string;
    commit: string;
    dockerfileSha256: string;
    buildContextSha256?: string;
  };
  config: {
    path: string;
    buildSha256: string;
    expectedActivationSha256: string | null;
    previousImage: string;
  };
  image: {
    transportTag: string;
    transportRef: string | null;
    immutableRef: string | null;
    imageConfigDigest?: string | null;
  };
  /** Present only when a later trusted checkout reconciled an earlier attempt. */
  reconciledBy?: {
    branch: string;
    commit: string;
  };
  review: string | null;
}>;

type RunnerPublicationAttempt = Readonly<{
  kind: "takosumi.runner-image-publication-state@v1";
  status: "publication-started";
  environment: RunnerImageReleaseEnvironment;
  release: string;
  observedAt: string;
  source: {
    branch: string;
    commit: string;
    dockerfileSha256: string;
    buildContextSha256: string;
  };
  config: {
    path: string;
    buildSha256: string;
    previousImage: string;
  };
  image: {
    transportTag: string;
    transportRef: string;
    /** Legacy v1 field written from Docker image inspect .Id. */
    localImageId: string;
    /** Explicit descriptor authority written by descriptor-aware publishers. */
    localDescriptorDigest?: string;
  };
  review: string;
}>;

type RunnerPublicationResolution =
  | Readonly<{
      kind: "takosumi.runner-image-publication-state@v1";
      status: "published";
      environment: RunnerImageReleaseEnvironment;
      release: string;
      observedAt: string;
      transportRef: string;
      immutableRef: string;
      imageConfigDigest: string;
      build: RunnerImageBuildRecord;
    }>
  | Readonly<{
      kind: "takosumi.runner-image-publication-state@v1";
      status: "reconciled-absent";
      environment: RunnerImageReleaseEnvironment;
      release: string;
      observedAt: string;
      transportRef: string;
      diagnostic: ReturnType<typeof releaseDiagnostic>;
    }>;
type RunnerPublishedResolution = Extract<
  RunnerPublicationResolution,
  { status: "published" }
>;

type PlatformReadyEvidence = Readonly<{
  kind: "takosumi.platform-worker-release-evidence@v2";
  status: "ready";
  environment: RunnerImageReleaseEnvironment;
  sourceCommit: string;
  configPath: string;
  configSha256: string;
  dashboardAssetsSha256: string;
  predecessorVersionId: string;
  deployedVersionId: string;
  planConfirmation: string;
  reviewer: string;
}>;

type RunnerApplicationVersion = number | string;

type RunnerApplicationHealth = Readonly<{
  failed: number | null;
  starting: number | null;
  scheduling: number | null;
  errorCount: number | null;
}>;

type RunnerApplication = Readonly<{
  id: string;
  name: string;
  state: string;
  image: string;
  version: RunnerApplicationVersion;
  hasActiveRollout: boolean;
  health: RunnerApplicationHealth;
}>;

const DIGEST_IMAGE =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner@sha256:[0-9a-f]{64}$/u;
const TRANSPORT_REF =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner:[a-z0-9][a-z0-9._-]{0,127}$/u;
const RELEASE_LABEL = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE =
  "application/vnd.docker.distribution.manifest.v2+json";
const OCI_IMAGE_MANIFEST_MEDIA_TYPE =
  "application/vnd.oci.image.manifest.v1+json";
const VERSION = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/u;
const WORKER_NAMES = {
  staging: "takosumi-staging",
  production: "takosumi",
} as const;
const RUNNER_APPLICATION_NAMES = {
  staging: "takosumi-staging-opentofurunnerobject",
  production: "takosumi-opentofurunnerobject",
} as const;
const RELEASE_COMMAND_TIMEOUT_MS = 2 * 60_000;
const RELEASE_MUTATION_COMMAND_TIMEOUT_MS = 15 * 60_000;
const RELEASE_BUILD_COMMAND_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TERMINATION_GRACE_MS = 5_000;

export { RUNNER_IMAGE_RELEASE_CONTRACT_SURFACE } from "./runner-image-release-contract.ts";

export type RunnerImageReleaseRuntime = Readonly<{
  repositoryRoot?: string;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  nonce?: () => string;
  accountId?: string;
  materializeSource?: (
    repositoryRoot: string,
    commit: string,
    destination: string,
  ) => Promise<void>;
  commandTimeoutMilliseconds?: number;
  command?: (
    executable: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<CommandResult>;
  git?: (root: string, args: readonly string[]) => Promise<string>;
  /** Test/operator override for the fixed external journal locator directory. */
  publicationJournalRoot?: string;
  /** Deterministic fault seam used to prove atomic canonical lock publication. */
  publicationLockHook?: (
    phase: "prepared" | "linked",
  ) => void | Promise<void>;
  /** Deterministic race seam used to prove descriptor-bound journal access. */
  publicationJournalHook?: (
    phase: "opened" | "before-push",
  ) => void | Promise<void>;
}>;

export const RUNNER_IMAGE_RELEASE_USAGE = `Takosumi runner image release

Usage:
  bun run deploy -- takosumi-runner-image build --config <absolute-wrangler.toml> --environment <staging|production> --release <label> --state <absolute-jsonl> --evidence <absolute-jsonl> [--review <review>] [--execute]
  bun run deploy -- takosumi-runner-image reconcile --config <absolute-wrangler.toml> --environment <staging|production> --release <label> --state <absolute-jsonl> --evidence <absolute-jsonl>
  bun run deploy -- takosumi-runner-image verify --config <absolute-wrangler.toml> --environment <staging|production> --release <label> --evidence <absolute-jsonl> --build-evidence <absolute-jsonl> --platform-evidence <absolute-json> [--review <review>] [--execute]

Build publishes one immutable linux/amd64 takosumi-runner image. Its generated
transport tag is not a version identity; only the remotely read manifest digest
is consumed. An unknown publication blocks every later build until reconcile
reads the exact recorded transport tag. The platform release surface exclusively performs the full Worker
and Container mutation. Verify consumes its exact ready evidence and performs
readback only. Without --execute both commands are read-only.`;

export function createRunnerTransportTag(
  sourceCommit: string,
  dockerfileSha256: string,
  nonce = randomBytes(16).toString("hex"),
): string {
  const dockerfileDigest = dockerfileSha256.replace(/^sha256:/u, "");
  if (
    !/^[0-9a-f]{40}$/u.test(sourceCommit) ||
    !/^[0-9a-f]{64}$/u.test(dockerfileDigest) ||
    !/^[0-9a-f]{32}$/u.test(nonce)
  ) {
    throw new Error("runner_image_transport_identity_invalid");
  }
  return `r-${sourceCommit.slice(0, 12)}-${dockerfileDigest.slice(0, 12)}-${nonce}`;
}

export function assertRunnerImageOnlyConfigChange(
  buildConfigSource: string,
  activationConfigSource: string,
  previousImage: string,
  selectedImage: string,
): string {
  const expected = replaceRunnerImage(
    buildConfigSource,
    previousImage,
    selectedImage,
  );
  if (activationConfigSource !== expected) {
    throw new Error("runner_image_activation_config_not_image_only");
  }
  return sha256(expected);
}

export function parseRemoteRunnerManifest(
  publicationOutput: string,
  manifestOutput: string,
  transportTag: string,
  expectedLocalDescriptorDigest?: string,
): Readonly<{
  transportRef: string;
  immutableRef: string;
  imageConfigDigest: string;
}> {
  if (!RELEASE_LABEL.test(transportTag)) {
    throw new Error("runner_image_remote_manifest_invalid");
  }
  const matches = [
    ...publicationOutput.matchAll(
      /registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner:[a-z0-9][a-z0-9._-]{0,127}/gu,
    ),
  ]
    .map((match) => match[0])
    .filter((reference) => reference.endsWith(`:${transportTag}`));
  const refs = new Set(matches);
  if (refs.size !== 1) {
    throw new Error("runner_image_remote_manifest_invalid");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestOutput) as unknown;
  } catch {
    throw new Error("runner_image_remote_manifest_invalid");
  }
  const schemaV2Manifest =
    isRecord(manifest) && isRecord(manifest.SchemaV2Manifest)
      ? manifest.SchemaV2Manifest
      : null;
  const ociManifest =
    isRecord(manifest) && isRecord(manifest.OCIManifest)
      ? manifest.OCIManifest
      : null;
  const imageManifest = schemaV2Manifest ?? ociManifest;
  const expectedManifestMediaType =
    ociManifest === null
      ? DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE
      : OCI_IMAGE_MANIFEST_MEDIA_TYPE;
  if (
    !isRecord(manifest) ||
    "Platform" in manifest ||
    "manifests" in manifest ||
    (schemaV2Manifest === null) === (ociManifest === null) ||
    !isRecord(manifest.Descriptor) ||
    typeof manifest.Descriptor.digest !== "string" ||
    !SHA256.test(manifest.Descriptor.digest) ||
    manifest.Descriptor.mediaType !== expectedManifestMediaType ||
    !isRecord(manifest.Descriptor.platform) ||
    manifest.Descriptor.platform.os !== "linux" ||
    manifest.Descriptor.platform.architecture !== "amd64" ||
    !isRecord(imageManifest) ||
    imageManifest.schemaVersion !== 2 ||
    imageManifest.mediaType !== expectedManifestMediaType ||
    !isRecord(imageManifest.config) ||
    typeof imageManifest.config.digest !== "string" ||
    !SHA256.test(imageManifest.config.digest)
  ) {
    throw new Error("runner_image_remote_manifest_invalid");
  }
  const imageConfigDigest = imageManifest.config.digest;
  if (
    expectedLocalDescriptorDigest !== undefined &&
    manifest.Descriptor.digest !== expectedLocalDescriptorDigest
  ) {
    throw new Error("runner_image_remote_content_mismatch");
  }
  const transportRef = [...refs][0]!;
  if (!TRANSPORT_REF.test(transportRef)) {
    throw new Error("runner_image_remote_manifest_invalid");
  }
  const repository = transportRef.slice(0, transportRef.lastIndexOf(":"));
  const immutableRef = `${repository}@${manifest.Descriptor.digest}`;
  if (!DIGEST_IMAGE.test(immutableRef)) {
    throw new Error("runner_image_remote_manifest_invalid");
  }
  return { transportRef, immutableRef, imageConfigDigest };
}

export function isRunnerImageReleaseCommand(
  value: string | undefined,
): value is RunnerImageReleaseCommand {
  return value === "build" || value === "reconcile" || value === "verify";
}

export function parseRunnerImageReleaseArgs(
  argv: readonly string[],
): RunnerImageReleaseOptions {
  const [commandValue, ...rest] = argv;
  if (!isRunnerImageReleaseCommand(commandValue)) {
    throw new Error(RUNNER_IMAGE_RELEASE_USAGE);
  }
  const values = new Map<string, string>();
  let execute = false;
  const names = new Set([
    "config",
    "environment",
    "release",
    "evidence",
    "state",
    "build-evidence",
    "platform-evidence",
    "review",
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--execute") {
      if (execute) throw new Error("duplicate argument: --execute");
      execute = true;
      continue;
    }
    if (!token.startsWith("--") || !names.has(token.slice(2))) {
      throw new Error(`unknown argument: ${token}`);
    }
    const name = token.slice(2);
    if (values.has(name)) throw new Error(`duplicate argument: --${name}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    values.set(name, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`missing required argument: --${name}`);
    return value;
  };
  const environment = required("environment");
  if (environment !== "staging" && environment !== "production") {
    throw new Error("environment must be staging or production");
  }
  const release = required("release");
  if (!RELEASE_LABEL.test(release)) {
    throw new Error("runner image release label is invalid");
  }
  const review = values.get("review")?.trim();
  if (commandValue === "reconcile" && execute) {
    throw new Error("reconcile is externally read-only and does not accept --execute");
  }
  if (execute && !review) throw new Error("--execute requires --review");
  if (review !== undefined) assertReview(review);
  const buildEvidence = values.get("build-evidence")?.trim();
  const platformEvidence = values.get("platform-evidence")?.trim();
  if (commandValue === "verify" && (!buildEvidence || !platformEvidence)) {
    throw new Error(
      "verify requires --build-evidence and --platform-evidence",
    );
  }
  if (
    commandValue !== "verify" &&
    (buildEvidence !== undefined || platformEvidence !== undefined)
  ) {
    throw new Error("build and reconcile do not accept verification evidence");
  }
  const state = values.get("state")?.trim();
  if (commandValue !== "verify" && !state) {
    throw new Error("build and reconcile require --state");
  }
  if (commandValue === "verify" && state !== undefined) {
    throw new Error("verify does not accept --state");
  }
  return {
    command: commandValue,
    config: required("config"),
    environment,
    release,
    evidence: required("evidence"),
    ...(state ? { state } : {}),
    ...(buildEvidence ? { buildEvidence } : {}),
    ...(platformEvidence ? { platformEvidence } : {}),
    ...(review ? { review } : {}),
    execute,
  };
}

export async function runRunnerImageRelease(
  options: RunnerImageReleaseOptions,
  runtime: RunnerImageReleaseRuntime = {},
): Promise<unknown> {
  if (options.execute && !options.review?.trim()) {
    throw new Error("--execute requires --review");
  }
  if (options.review !== undefined) assertReview(options.review);
  if (
    runtime.commandTimeoutMilliseconds !== undefined &&
    (!Number.isSafeInteger(runtime.commandTimeoutMilliseconds) ||
      runtime.commandTimeoutMilliseconds <= 0)
  ) {
    throw new Error("command timeout must be a positive integer");
  }
  const repositoryRoot = await canonicalDirectory(
    runtime.repositoryRoot ?? resolve(import.meta.dir, ".."),
  );
  const command = releaseCommand(
    runtime.command,
    runtime.commandTimeoutMilliseconds,
  );
  const git =
    runtime.git ??
    (async (root, args) => {
      const result = await command("git", args, root);
      if (result.exitCode !== 0) {
        throw new Error("runner_image_git_failed");
      }
      return result.stdout.trim();
    });
  const context = await inspectContext(repositoryRoot, options, git);
  const observedAt = (runtime.now ?? (() => new Date()))().toISOString();
  const publicationJournal = options.command === "verify"
    ? undefined
    : publicationJournalIdentity(
        runnerImageRepository(context.config.runnerImage),
        options.environment,
        runtime.publicationJournalRoot ??
          defaultPublicationJournalRoot(
            repositoryRoot,
            runtime.repositoryRoot !== undefined,
          ),
      );
  await assertRunnerImageReleasePathGraph({
    config: context.config.path,
    sourcePin: context.releaseSource.pinPath,
    evidence: options.evidence,
    ...(options.state ? { state: options.state } : {}),
    ...(options.buildEvidence ? { buildEvidence: options.buildEvidence } : {}),
    ...(options.platformEvidence
      ? { platformEvidence: options.platformEvidence }
      : {}),
    ...(publicationJournal ? { publicationJournal } : {}),
  });
  await assertEvidencePath(options.evidence, [repositoryRoot]);
  if (options.command !== "verify") {
    if (!options.state) throw new Error("build and reconcile require --state");
    await assertEvidencePath(options.state, [repositoryRoot]);
  }
  if (options.command === "build") {
    let imageRepository: string;
    try {
      imageRepository = publicationTargetRepository(
        context,
        runtime.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
        options.execute,
      );
    } catch (error) {
      if (options.execute) {
        await prepareEvidenceFile(options.evidence, [repositoryRoot]);
        await appendEvidence(options.evidence, {
          kind: "takosumi.runner-image-release@v2",
          operation: "build",
          status: "failed",
          mutationOutcome: "not-started",
          environment: options.environment,
          release: options.release,
          observedAt,
          source: {
            branch: context.repository.branch,
            commit: context.repository.commit,
            dockerfileSha256: context.dockerfileSha256,
          },
          review: options.review ?? null,
          failureBoundary: "pre-mutation",
          diagnostic: releaseDiagnostic(error),
        });
      }
      throw error;
    }
    const build = (publicationJournal?: PublicationJournal) =>
      buildRunnerImage(
        options,
        context,
        observedAt,
        command,
        runtime.nonce ?? (() => randomBytes(16).toString("hex")),
        imageRepository,
        publicationJournal,
        runtime.publicationJournalHook,
        runtime.materializeSource,
        [repositoryRoot],
      );
    if (!options.state) throw new Error("build requires --state");
    const journal = publicationJournal!;
    if (!options.execute) {
      await assertPublicationJournalBinding(journal, options.state, false);
      return build();
    }
    return withPublicationJournalLock(
      journal,
      options.state,
      build,
      false,
      runtime.publicationLockHook,
      runtime.publicationJournalHook,
    );
  }
  if (options.command === "reconcile") {
    if (!options.state) throw new Error("reconcile requires --state");
    const journal = publicationJournal!;
    return withPublicationJournalLock(
      journal,
      options.state,
      (publicationJournal) =>
        reconcileRunnerImage(
          options,
          context,
          observedAt,
          command,
          publicationJournal,
          git,
          [repositoryRoot],
          runtime.materializeSource,
        ),
      true,
      runtime.publicationLockHook,
      runtime.publicationJournalHook,
      async (attempt) => {
        if (!publicationAttemptMatchesReconciliationContext(
          attempt,
          options,
          context,
        )) {
          throw new Error("runner_image_publication_reconciliation_identity_mismatch");
        }
        await proveLegacyPublicationLocalIdentity(
          attempt,
          command,
          context.repository.root,
        );
      },
    );
  }
  return verifyRunnerImage(
    options,
    context,
    observedAt,
    command,
    runtime.wait ?? wait,
    [repositoryRoot],
  );
}

async function buildRunnerImage(
  options: RunnerImageReleaseOptions,
  context: ReleaseContext,
  observedAt: string,
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  nonce: NonNullable<RunnerImageReleaseRuntime["nonce"]>,
  imageRepository: string,
  publicationJournal: PublicationJournal | undefined,
  publicationJournalHook: RunnerImageReleaseRuntime["publicationJournalHook"],
  materializeSource: RunnerImageReleaseRuntime["materializeSource"],
  sourceRoots: readonly string[],
): Promise<RunnerImageBuildRecord> {
  if (!options.state) throw new Error("build requires --state");
  const unresolved = await unresolvedPublicationAttempts(
    publicationJournal ?? options.state,
  );
  if (unresolved.length !== 0) {
    throw new Error("runner_image_publication_reconciliation_required");
  }
  const transportTag = createRunnerTransportTag(
    context.repository.commit,
    context.dockerfileSha256,
    nonce(),
  );
  const localTag = `takosumi-runner:${transportTag}`;
  if (!options.execute) {
    return buildRecord(
      options,
      context,
      observedAt,
      transportTag,
      null,
      null,
      null,
      "planned",
    );
  }
  await prepareEvidenceFile(options.evidence, sourceRoots);
  await prepareEvidenceFile(options.state, sourceRoots);
  let remoteRef: string | null = null;
  let workspace: string | null = null;
  let publicationAttempted = false;
  try {
    remoteRef = `${imageRepository}:${transportTag}`;
    if (!TRANSPORT_REF.test(remoteRef)) {
      throw new Error("runner_image_transport_identity_invalid");
    }
    workspace = await mkdtemp(
      join(dirname(resolve(options.state)), ".takosumi-runner-build-"),
    );
    await chmod(workspace, 0o700);
    const materialized = await materializeRunnerSource(
      context.repository.root,
      context.repository.commit,
      workspace,
      command,
      materializeSource,
    );
    if (materialized.dockerfileSha256 !== context.dockerfileSha256) {
      throw new Error("runner_image_sealed_source_mismatch");
    }
    const {
      sourceRoot: sealedSource,
      dockerfilePath: sealedDockerfile,
      dockerfileSource,
      buildContext,
    } = materialized;
    const sealedConfig = join(workspace, "wrangler.toml");
    await writeFile(sealedConfig, runnerWranglerConfigSource(context), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await verifyOpenTofuSigstore(
      new TextDecoder("utf-8", { fatal: true }).decode(dockerfileSource),
      workspace,
      command,
      context.repository.root,
    );
    await checkedCommand(
      command,
      "docker",
      [
        "buildx",
        "build",
        "--load",
        "--platform",
        "linux/amd64",
        "--file",
        sealedDockerfile,
        "--tag",
        localTag,
        sealedSource,
      ],
      workspace,
    );
    if (
      JSON.stringify(dashboardAssetTreeSeal(sealedSource)) !==
      JSON.stringify(buildContext)
    ) {
      throw new Error("runner_image_sealed_source_drift");
    }
    const localImage = await checkedCommand(
      command,
      "docker",
      ["image", "inspect", localTag, "--format", "{{json .}}"],
      workspace,
    );
    const localIdentity = parseLocalRunnerImageIdentity(localImage.stdout);
    const attempt: RunnerPublicationAttempt = {
      kind: "takosumi.runner-image-publication-state@v1",
      status: "publication-started",
      environment: options.environment,
      release: options.release,
      observedAt,
      source: {
        branch: context.repository.branch,
        commit: context.repository.commit,
        dockerfileSha256: context.dockerfileSha256,
        buildContextSha256: buildContext.digest,
      },
      config: {
        path: context.config.path,
        buildSha256: context.config.sha256,
        previousImage: context.config.runnerImage,
      },
      image: {
        transportTag,
        transportRef: remoteRef,
        localImageId: localIdentity.imageId,
        localDescriptorDigest: localIdentity.descriptorDigest,
      },
      review: options.review!,
    };
    if (!publicationJournal) {
      throw new Error("runner_image_publication_journal_not_bound");
    }
    await publicationJournal.append(attempt);
    publicationAttempted = true;
    await publicationJournalHook?.("before-push");
    await publicationJournal.assertBound();
    const published = await checkedCommand(
      command,
      "bunx",
      [
        "wrangler",
        "containers",
        "push",
        localTag,
        "--config",
        sealedConfig,
      ],
      workspace,
    );
    const publicationOutput = `${published.stdout}\n${published.stderr}`;
    if (!publicationOutput.includes(remoteRef)) {
      throw new Error("runner_image_remote_manifest_invalid");
    }
    const manifest = await checkedCommand(
      command,
      "docker",
      ["manifest", "inspect", "--verbose", remoteRef],
      workspace,
    );
    const image = parseRemoteRunnerManifest(
      publicationOutput,
      manifest.stdout,
      transportTag,
      localIdentity.descriptorDigest,
    );
    if (image.transportRef !== remoteRef) {
      throw new Error("runner_image_remote_manifest_invalid");
    }
    const expectedSource = replaceRunnerImage(
      context.config.source,
      context.config.runnerImage,
      image.immutableRef,
    );
    const expectedActivationSha256 = assertRunnerImageOnlyConfigChange(
      context.config.source,
      expectedSource,
      context.config.runnerImage,
      image.immutableRef,
    );
    const baseRecord = buildRecord(
      options,
      context,
      observedAt,
      transportTag,
      image.transportRef,
      image.immutableRef,
      expectedActivationSha256,
      "published",
    );
    const record: RunnerImageBuildRecord = {
      ...baseRecord,
      source: {
        ...baseRecord.source,
        buildContextSha256: buildContext.digest,
      },
      image: {
        ...baseRecord.image,
        imageConfigDigest: image.imageConfigDigest,
      },
    };
    const resolution: RunnerPublicationResolution = {
      kind: "takosumi.runner-image-publication-state@v1",
      status: "published",
      environment: options.environment,
      release: options.release,
      observedAt: new Date().toISOString(),
      transportRef: image.transportRef,
      immutableRef: image.immutableRef,
      imageConfigDigest: image.imageConfigDigest,
      build: record,
    };
    await publicationJournal.append(resolution);
    await appendTerminalEvidenceIfAbsent(options.evidence, record);
    return record;
  } catch (error) {
    const diagnostic = releaseDiagnostic(error);
    if (publicationAttempted) {
      await appendEvidence(options.evidence, {
        kind: "takosumi.runner-image-release@v2",
        operation: "build",
        status: "publication-incomplete",
        mutationOutcome: "unknown",
        environment: options.environment,
        release: options.release,
        observedAt,
        source: {
          branch: context.repository.branch,
          commit: context.repository.commit,
          dockerfileSha256: context.dockerfileSha256,
        },
        transportTag,
        transportRef: remoteRef,
        review: options.review ?? null,
        failureBoundary: "post-mutation-unknown",
        diagnostic,
      });
    } else {
      await appendEvidence(options.evidence, {
        kind: "takosumi.runner-image-release@v2",
        operation: "build",
        status: "failed",
        mutationOutcome: "not-started",
        environment: options.environment,
        release: options.release,
        observedAt,
        source: {
          branch: context.repository.branch,
          commit: context.repository.commit,
          dockerfileSha256: context.dockerfileSha256,
        },
        transportTag,
        review: options.review ?? null,
        failureBoundary: "pre-mutation",
        diagnostic,
      });
    }
    throw new Error(publicationAttempted
      ? "runner image publication outcome is incomplete; immutable digest evidence was not established"
      : `runner image build failed before publication: ${diagnostic.message}`,
    { cause: error });
  } finally {
    if (workspace !== null) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

type MaterializedRunnerSource = Readonly<{
  sourceRoot: string;
  dockerfilePath: string;
  dockerfileSource: Uint8Array;
  dockerfileSha256: string;
  buildContext: ReturnType<typeof dashboardAssetTreeSeal>;
}>;

async function materializeRunnerSource(
  repositoryRoot: string,
  commit: string,
  workspace: string,
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  materializeSource: RunnerImageReleaseRuntime["materializeSource"],
): Promise<MaterializedRunnerSource> {
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("runner_image_sealed_source_mismatch");
  }
  const sourceRoot = join(workspace, "source");
  await mkdir(sourceRoot, { mode: 0o700 });
  if (materializeSource) {
    await materializeSource(repositoryRoot, commit, sourceRoot);
  } else {
    const archive = join(workspace, "source.tar");
    await checkedCommand(
      command,
      "git",
      [
        "--no-replace-objects",
        "archive",
        "--format=tar",
        `--output=${archive}`,
        commit,
      ],
      repositoryRoot,
    );
    await checkedCommand(
      command,
      "tar",
      [
        "--extract",
        "--file",
        archive,
        "--directory",
        sourceRoot,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      workspace,
    );
    await rm(archive);
  }
  const dockerfilePath = join(sourceRoot, "runner", "Dockerfile");
  const dockerfileSource = await readStablePhysicalFile(
    dockerfilePath,
    "sealed Dockerfile",
  );
  return {
    sourceRoot,
    dockerfilePath,
    dockerfileSource,
    dockerfileSha256: sha256(dockerfileSource),
    buildContext: dashboardAssetTreeSeal(sourceRoot),
  };
}

function publicationAttemptMatchesReconciliationContext(
  attempt: RunnerPublicationAttempt,
  options: RunnerImageReleaseOptions,
  context: ReleaseContext,
): boolean {
  return (
    attempt.environment === options.environment &&
    attempt.release === options.release &&
    attempt.source.branch === context.repository.branch &&
    attempt.config.path === context.config.path &&
    attempt.config.buildSha256 === context.config.sha256 &&
    attempt.config.previousImage === context.config.runnerImage &&
    attempt.image.transportRef ===
      `${runnerImageRepository(attempt.config.previousImage)}:${attempt.image.transportTag}`
  );
}

async function reconcileRunnerImage(
  options: RunnerImageReleaseOptions,
  context: ReleaseContext,
  observedAt: string,
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  publicationJournal: PublicationJournal,
  git: NonNullable<RunnerImageReleaseRuntime["git"]>,
  sourceRoots: readonly string[],
  materializeSource: RunnerImageReleaseRuntime["materializeSource"],
): Promise<unknown> {
  if (!options.state) throw new Error("reconcile requires --state");
  await prepareEvidenceFile(options.evidence, sourceRoots);
  const attempts = await unresolvedPublicationAttempts(publicationJournal);
  if (attempts.length === 0) {
    const resolution = await uniquePublicationResolution(
      publicationJournal,
      options.environment,
      options.release,
    );
    if (!resolution) throw new Error("runner_image_publication_reconciliation_not_required");
    await appendTerminalEvidenceIfAbsent(options.evidence, resolution.build);
    return resolution.build;
  }
  if (attempts.length !== 1) {
    throw new Error("runner_image_publication_reconciliation_ambiguous");
  }
  const attempt = attempts[0]!;
  if (!publicationAttemptMatchesReconciliationContext(attempt, options, context)) {
    throw new Error("runner_image_publication_reconciliation_identity_mismatch");
  }
  let workspace: string | null = null;
  try {
    await assertHistoricalPublicationCommit(context.repository, attempt, git);
    await publicationJournal.assertBound();
    workspace = await mkdtemp(
      join(dirname(resolve(options.state)), ".takosumi-runner-reconcile-"),
    );
    await chmod(workspace, 0o700);
    const materialized = await materializeRunnerSource(
      context.repository.root,
      attempt.source.commit,
      workspace,
      command,
      materializeSource,
    );
    if (
      materialized.dockerfileSha256 !== attempt.source.dockerfileSha256 ||
      materialized.buildContext.digest !== attempt.source.buildContextSha256
    ) {
      throw new Error("runner_image_historical_source_mismatch");
    }
    if (
      sha256(
        await readStablePhysicalFile(
          context.config.path,
          "reconciliation config path",
        ),
      ) !== attempt.config.buildSha256
    ) {
      throw new Error("runner_image_publication_reconciliation_identity_mismatch");
    }
    let expectedLocalDescriptorDigest = attempt.image.localDescriptorDigest;
    if (expectedLocalDescriptorDigest === undefined) {
      await publicationJournal.assertBound();
      expectedLocalDescriptorDigest = await proveLegacyPublicationLocalIdentity(
        attempt,
        command,
        workspace,
      );
    }
    await publicationJournal.assertBound();
    const manifest = await checkedCommand(
      command,
      "docker",
      ["manifest", "inspect", "--verbose", attempt.image.transportRef],
      context.repository.root,
    );
    const image = parseRemoteRunnerManifest(
      `Pushed image: ${attempt.image.transportRef}`,
      manifest.stdout,
      attempt.image.transportTag,
      expectedLocalDescriptorDigest,
    );
    const expectedActivationSha256 = sha256(
      replaceRunnerImage(
        context.config.source,
        context.config.runnerImage,
        image.immutableRef,
      ),
    );
    const historicalContext: ReleaseContext = {
      ...context,
      repository: {
        ...context.repository,
        branch: attempt.source.branch,
        commit: attempt.source.commit,
      },
      dockerfileSha256: attempt.source.dockerfileSha256,
    };
    const base = buildRecord(
      options,
      historicalContext,
      observedAt,
      attempt.image.transportTag,
      image.transportRef,
      image.immutableRef,
      expectedActivationSha256,
      "published",
    );
    const record: RunnerImageBuildRecord = {
      ...base,
      source: {
        ...base.source,
        buildContextSha256: attempt.source.buildContextSha256,
      },
      image: { ...base.image, imageConfigDigest: image.imageConfigDigest },
      reconciledBy: {
        branch: context.repository.branch,
        commit: context.repository.commit,
      },
      review: attempt.review,
    };
    const resolution: RunnerPublicationResolution = {
      kind: "takosumi.runner-image-publication-state@v1",
      status: "published",
      environment: options.environment,
      release: options.release,
      observedAt,
      transportRef: image.transportRef,
      immutableRef: image.immutableRef,
      imageConfigDigest: image.imageConfigDigest,
      build: record,
    };
    await publicationJournal.append(resolution);
    await appendTerminalEvidenceIfAbsent(options.evidence, record);
    return record;
  } catch (error) {
    if (isExactRemoteManifestAbsence(error, attempt.image.transportRef)) {
      const diagnostic = releaseDiagnostic(error);
      const resolution: RunnerPublicationResolution = {
        kind: "takosumi.runner-image-publication-state@v1",
        status: "reconciled-absent",
        environment: options.environment,
        release: options.release,
        observedAt,
        transportRef: attempt.image.transportRef,
        diagnostic,
      };
      await publicationJournal.append(resolution);
      const record = {
        kind: "takosumi.runner-image-release@v2",
        operation: "reconcile",
        status: "absent",
        mutationOutcome: "read-only",
        environment: options.environment,
        release: options.release,
        observedAt,
        transportRef: attempt.image.transportRef,
        diagnostic,
      } as const;
      await appendEvidence(options.evidence, record);
      return record;
    }
    await appendEvidence(options.evidence, {
      kind: "takosumi.runner-image-release@v2",
      operation: "reconcile",
      status: "incomplete",
      mutationOutcome: "read-only",
      environment: options.environment,
      release: options.release,
      observedAt,
      transportRef: attempt.image.transportRef,
      failureBoundary: "readback",
      diagnostic: releaseDiagnostic(error),
    });
    throw error;
  } finally {
    if (workspace !== null) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

async function assertHistoricalPublicationCommit(
  repository: RepositoryIdentity,
  attempt: RunnerPublicationAttempt,
  git: NonNullable<RunnerImageReleaseRuntime["git"]>,
): Promise<void> {
  try {
    const resolved = (
      await git(repository.root, [
        "--no-replace-objects",
        "rev-parse",
        "--verify",
        `${attempt.source.commit}^{commit}`,
      ])
    ).trim();
    if (resolved !== attempt.source.commit) {
      throw new Error("historical commit resolved differently");
    }
    for (const descendant of [repository.commit, repository.remoteCommit]) {
      await git(repository.root, [
        "--no-replace-objects",
        "merge-base",
        "--is-ancestor",
        attempt.source.commit,
        descendant,
      ]);
    }
  } catch (error) {
    throw new Error("runner_image_publication_attempt_history_invalid", {
      cause: error,
    });
  }
}

function isExactRemoteManifestAbsence(
  error: unknown,
  transportRef: string,
): boolean {
  if (
    !(error instanceof ReleaseCommandError) ||
    !error.commandLabel.startsWith("docker manifest inspect") ||
    error.result.exitCode !== 1
  ) {
    return false;
  }
  const diagnostic = `${error.result.stdout}\n${error.result.stderr}`.toLowerCase();
  if (/unauthorized|forbidden|denied|timeout|network|connection|tls|certificate/u.test(diagnostic)) {
    return false;
  }
  return (
    diagnostic.includes(`no such manifest: ${transportRef}`.toLowerCase()) ||
    (diagnostic.includes("manifest unknown") && diagnostic.includes(transportRef.toLowerCase()))
  );
}

async function verifyOpenTofuSigstore(
  dockerfileSource: string,
  workspace: string,
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  cwd: string,
): Promise<void> {
  const versionMatches = [
    ...dockerfileSource.matchAll(/^ARG OPENTOFU_VERSION=([^\s]+)$/gmu),
  ];
  const checksumMatches = [
    ...dockerfileSource.matchAll(/^ARG OPENTOFU_SHA256=([0-9a-f]{64})$/gmu),
  ];
  if (
    versionMatches.length !== 1 ||
    checksumMatches.length !== 1 ||
    !/^\d+\.\d+\.\d+$/u.test(versionMatches[0]![1]!)
  ) {
    throw new Error("runner_image_opentofu_identity_invalid");
  }
  const version = versionMatches[0]![1]!;
  const expectedChecksum = checksumMatches[0]![1]!;
  const majorMinor = version.split(".").slice(0, 2).join(".");
  const base = `https://github.com/opentofu/opentofu/releases/download/v${version}`;
  const upstream = join(workspace, "opentofu-upstream");
  await mkdir(upstream, { mode: 0o700 });
  const sums = join(upstream, `tofu_${version}_SHA256SUMS`);
  const signature = `${sums}.sig`;
  const certificate = `${sums}.pem`;
  for (const [url, output] of [
    [`${base}/tofu_${version}_SHA256SUMS`, sums],
    [`${base}/tofu_${version}_SHA256SUMS.sig`, signature],
    [`${base}/tofu_${version}_SHA256SUMS.pem`, certificate],
  ] as const) {
    await checkedCommand(
      command,
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--output",
        output,
        url,
      ],
      cwd,
    );
  }
  await checkedCommand(
    command,
    "cosign",
    [
      "verify-blob",
      "--certificate-identity",
      `https://github.com/opentofu/opentofu/.github/workflows/release.yml@refs/heads/v${majorMinor}`,
      "--signature",
      signature,
      "--certificate",
      certificate,
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      sums,
    ],
    cwd,
  );
  const sumsSource = new TextDecoder("utf-8", { fatal: true }).decode(
    await readStablePhysicalFile(sums, "OpenTofu checksums"),
  );
  const asset = `tofu_${version}_linux_amd64.zip`;
  const matching = sumsSource
    .split(/\r?\n/u)
    .filter((line) => line === `${expectedChecksum}  ${asset}`);
  if (matching.length !== 1) {
    throw new Error("runner_image_opentofu_checksum_invalid");
  }
}

function parseLocalRunnerImageIdentity(source: string): Readonly<{
  imageId: string;
  descriptorDigest: string;
}> {
  let value: unknown;
  try {
    value = JSON.parse(source.trim()) as unknown;
  } catch {
    throw new Error("runner_image_local_identity_invalid");
  }
  if (
    !isRecord(value) ||
    typeof value.Id !== "string" ||
    !SHA256.test(value.Id) ||
    !isRecord(value.Descriptor) ||
    typeof value.Descriptor.digest !== "string" ||
    !SHA256.test(value.Descriptor.digest) ||
    (value.Descriptor.mediaType !== DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE &&
      value.Descriptor.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) ||
    value.Os !== "linux" ||
    value.Architecture !== "amd64"
  ) {
    throw new Error("runner_image_local_identity_invalid");
  }
  return {
    imageId: value.Id,
    descriptorDigest: value.Descriptor.digest,
  };
}

async function proveLegacyPublicationLocalIdentity(
  attempt: RunnerPublicationAttempt,
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  cwd: string,
): Promise<string> {
  const localTag = `takosumi-runner:${attempt.image.transportTag}`;
  const localImage = await checkedCommand(
    command,
    "docker",
    ["image", "inspect", localTag, "--format", "{{json .}}"],
    cwd,
  );
  const localIdentity = parseLocalRunnerImageIdentity(localImage.stdout);
  if (
    localIdentity.imageId !== attempt.image.localImageId ||
    localIdentity.descriptorDigest !== attempt.image.localImageId
  ) {
    throw new Error("runner_image_legacy_local_identity_mismatch");
  }
  return localIdentity.descriptorDigest;
}

async function unresolvedPublicationAttempts(
  state: string | PublicationJournal,
): Promise<readonly RunnerPublicationAttempt[]> {
  const records = await readPublicationState(state);
  const unresolved = new Map<string, RunnerPublicationAttempt>();
  for (const entry of records) {
    if (entry.status === "publication-started") {
      if (unresolved.has(entry.image.transportRef)) {
        throw new Error("runner_image_publication_state_invalid");
      }
      unresolved.set(entry.image.transportRef, entry);
      continue;
    }
    const attempt = unresolved.get(entry.transportRef);
    if (
      !attempt ||
      entry.environment !== attempt.environment ||
      entry.release !== attempt.release ||
      (entry.status === "published" &&
        !publicationResolutionMatchesAttempt(entry, attempt))
    ) {
      throw new Error("runner_image_publication_state_invalid");
    }
    unresolved.delete(entry.transportRef);
  }
  return [...unresolved.values()];
}

function publicationResolutionMatchesAttempt(
  resolution: RunnerPublishedResolution,
  attempt: RunnerPublicationAttempt,
): boolean {
  const build = resolution.build;
  const descriptorDigest = resolution.immutableRef.slice(
    resolution.immutableRef.lastIndexOf("@") + 1,
  );
  return (
    descriptorDigest ===
      (attempt.image.localDescriptorDigest ?? attempt.image.localImageId) &&
    resolution.immutableRef === build.image.immutableRef &&
    build.environment === attempt.environment &&
    build.release === attempt.release &&
    build.source.branch === attempt.source.branch &&
    build.source.commit === attempt.source.commit &&
    build.source.dockerfileSha256 === attempt.source.dockerfileSha256 &&
    build.source.buildContextSha256 === attempt.source.buildContextSha256 &&
    build.config.path === attempt.config.path &&
    build.config.buildSha256 === attempt.config.buildSha256 &&
    build.config.previousImage === attempt.config.previousImage &&
    build.image.transportTag === attempt.image.transportTag &&
    build.image.transportRef === attempt.image.transportRef &&
    build.image.imageConfigDigest === resolution.imageConfigDigest &&
    build.review === attempt.review
  );
}

async function uniquePublicationResolution(
  state: string | PublicationJournal,
  environment: RunnerImageReleaseEnvironment,
  release: string,
): Promise<RunnerPublishedResolution | null> {
  const matches = (await readPublicationState(state)).filter(
    (entry): entry is RunnerPublishedResolution =>
      entry.status === "published" &&
      entry.environment === environment &&
      entry.release === release,
  );
  if (matches.length > 1) {
    throw new Error("runner_image_publication_reconciliation_ambiguous");
  }
  return matches[0] ?? null;
}

async function readPublicationState(
  state: string | PublicationJournal,
): Promise<readonly (RunnerPublicationAttempt | RunnerPublicationResolution)[]> {
  let bytes: Uint8Array;
  try {
    bytes = typeof state === "string"
      ? await readStablePrivateFile(state, "publication state")
      : await state.read();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  }
  return parsePublicationState(bytes);
}

function parsePublicationState(
  bytes: Uint8Array,
): readonly (RunnerPublicationAttempt | RunnerPublicationResolution)[] {
  const entries: Array<RunnerPublicationAttempt | RunnerPublicationResolution> = [];
  for (const line of new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .split(/\r?\n/u)
    .filter(Boolean)) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("runner_image_publication_state_invalid");
    }
    if (!isRecord(value) || value.kind !== "takosumi.runner-image-publication-state@v1") {
      throw new Error("runner_image_publication_state_invalid");
    }
    if (value.status === "publication-started") {
      if (!validPublicationAttempt(value)) {
        throw new Error("runner_image_publication_state_invalid");
      }
      entries.push(value as unknown as RunnerPublicationAttempt);
    } else if (
      value.status === "published" ||
      value.status === "reconciled-absent"
    ) {
      if (!validPublicationResolution(value)) {
        throw new Error("runner_image_publication_state_invalid");
      }
      entries.push(value as unknown as RunnerPublicationResolution);
    } else {
      throw new Error("runner_image_publication_state_invalid");
    }
  }
  return entries;
}

function validPublicationAttempt(value: Record<string, unknown>): boolean {
  return (
    (value.environment === "staging" || value.environment === "production") &&
    typeof value.release === "string" &&
    RELEASE_LABEL.test(value.release) &&
    typeof value.observedAt === "string" &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    isRecord(value.source) &&
    isBoundedString(value.source.branch, 512) &&
    typeof value.source.commit === "string" &&
    /^[0-9a-f]{40}$/u.test(value.source.commit) &&
    typeof value.source.dockerfileSha256 === "string" &&
    SHA256.test(value.source.dockerfileSha256) &&
    typeof value.source.buildContextSha256 === "string" &&
    SHA256.test(value.source.buildContextSha256) &&
    isRecord(value.config) &&
    isBoundedString(value.config.path, 4096) &&
    typeof value.config.buildSha256 === "string" &&
    SHA256.test(value.config.buildSha256) &&
    typeof value.config.previousImage === "string" &&
    DIGEST_IMAGE.test(value.config.previousImage) &&
    isRecord(value.image) &&
    typeof value.image.transportTag === "string" &&
    RELEASE_LABEL.test(value.image.transportTag) &&
    typeof value.image.transportRef === "string" &&
    TRANSPORT_REF.test(value.image.transportRef) &&
    value.image.transportRef.endsWith(`:${value.image.transportTag}`) &&
    typeof value.image.localImageId === "string" &&
    SHA256.test(value.image.localImageId) &&
    (value.image.localDescriptorDigest === undefined ||
      (typeof value.image.localDescriptorDigest === "string" &&
        SHA256.test(value.image.localDescriptorDigest))) &&
    typeof value.review === "string" &&
    isBoundedString(value.review, 256)
  );
}

function validPublicationResolution(value: Record<string, unknown>): boolean {
  const common =
    (value.environment === "staging" || value.environment === "production") &&
    typeof value.release === "string" &&
    RELEASE_LABEL.test(value.release) &&
    typeof value.observedAt === "string" &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    typeof value.transportRef === "string" &&
    TRANSPORT_REF.test(value.transportRef);
  if (!common) return false;
  if (value.status === "reconciled-absent") {
    return validReleaseDiagnostic(value.diagnostic);
  }
  return (
    value.status === "published" &&
    typeof value.immutableRef === "string" &&
    DIGEST_IMAGE.test(value.immutableRef) &&
    typeof value.imageConfigDigest === "string" &&
    SHA256.test(value.imageConfigDigest) &&
    validPublishedBuildRecord(value.build) &&
    value.environment === value.build.environment &&
    value.release === value.build.release &&
    value.transportRef === value.build.image.transportRef &&
    value.immutableRef === value.build.image.immutableRef &&
    value.imageConfigDigest === value.build.image.imageConfigDigest
  );
}

function validPublishedBuildRecord(
  value: unknown,
): value is RunnerImageBuildRecord & {
  source: RunnerImageBuildRecord["source"] & { buildContextSha256: string };
  image: RunnerImageBuildRecord["image"] & {
    transportRef: string;
    immutableRef: string;
    imageConfigDigest: string;
  };
  review: string;
} {
  if (
    !isRecord(value) ||
    value.kind !== "takosumi.runner-image-release@v2" ||
    value.operation !== "build" ||
    value.status !== "published" ||
    (value.environment !== "staging" && value.environment !== "production") ||
    typeof value.release !== "string" ||
    !RELEASE_LABEL.test(value.release) ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !isRecord(value.source) ||
    !isBoundedString(value.source.branch, 512) ||
    typeof value.source.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.source.commit) ||
    typeof value.source.dockerfileSha256 !== "string" ||
    !SHA256.test(value.source.dockerfileSha256) ||
    typeof value.source.buildContextSha256 !== "string" ||
    !SHA256.test(value.source.buildContextSha256) ||
    !isRecord(value.config) ||
    !isBoundedString(value.config.path, 4096) ||
    typeof value.config.buildSha256 !== "string" ||
    !SHA256.test(value.config.buildSha256) ||
    typeof value.config.expectedActivationSha256 !== "string" ||
    !SHA256.test(value.config.expectedActivationSha256) ||
    typeof value.config.previousImage !== "string" ||
    !DIGEST_IMAGE.test(value.config.previousImage) ||
    !isRecord(value.image) ||
    typeof value.image.transportTag !== "string" ||
    !RELEASE_LABEL.test(value.image.transportTag) ||
    typeof value.image.transportRef !== "string" ||
    !TRANSPORT_REF.test(value.image.transportRef) ||
    !value.image.transportRef.endsWith(`:${value.image.transportTag}`) ||
    typeof value.image.immutableRef !== "string" ||
    !DIGEST_IMAGE.test(value.image.immutableRef) ||
    typeof value.image.imageConfigDigest !== "string" ||
    !SHA256.test(value.image.imageConfigDigest) ||
    (value.reconciledBy !== undefined &&
      (!isRecord(value.reconciledBy) ||
        !isBoundedString(value.reconciledBy.branch, 512) ||
        value.reconciledBy.branch !== value.source.branch ||
        typeof value.reconciledBy.commit !== "string" ||
        !/^[0-9a-f]{40}$/u.test(value.reconciledBy.commit))) ||
    typeof value.review !== "string" ||
    !isBoundedString(value.review, 256)
  ) {
    return false;
  }
  return true;
}

function validReleaseDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        ["code", "message", "command", "exitCode", "stdout", "stderr"].sort(),
      ) &&
    isBoundedString(value.code, 256) &&
    typeof value.message === "string" &&
    value.message.length <= 2_048 &&
    (value.command === null || isBoundedString(value.command, 160)) &&
    (value.exitCode === null ||
      (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode))) &&
    typeof value.stdout === "string" &&
    value.stdout.length <= 2_048 &&
    typeof value.stderr === "string" &&
    value.stderr.length <= 2_048
  );
}

async function appendTerminalEvidenceIfAbsent(
  path: string,
  record: RunnerImageBuildRecord,
): Promise<void> {
  let source = "";
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      await readStablePrivateFile(path, "terminal evidence"),
    );
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
  const encoded = JSON.stringify(record);
  for (const line of source.split(/\r?\n/u).filter(Boolean)) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("runner_image_terminal_evidence_invalid");
    }
    if (
      isRecord(value) &&
      value.kind === record.kind &&
      value.operation === "build" &&
      value.status === "published" &&
      value.environment === record.environment &&
      value.release === record.release
    ) {
      if (JSON.stringify(value) === encoded) return;
      throw new Error("runner_image_terminal_evidence_conflict");
    }
  }
  await appendEvidence(path, record);
}

async function verifyRunnerImage(
  options: RunnerImageReleaseOptions,
  context: ReleaseContext,
  observedAt: string,
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  waitForNextRead: NonNullable<RunnerImageReleaseRuntime["wait"]>,
  sourceRoots: readonly string[],
): Promise<unknown> {
  if (!options.buildEvidence || !options.platformEvidence) {
    throw new Error(
      "verify requires --build-evidence and --platform-evidence",
    );
  }
  const buildPath = await canonicalEvidenceInput(
    options.buildEvidence,
    sourceRoots,
  );
  const platformPath = await canonicalEvidenceInput(
    options.platformEvidence,
    sourceRoots,
  );
  if (
    resolve(options.evidence) === buildPath ||
    resolve(options.evidence) === platformPath
  ) {
    throw new Error("verification output must be distinct from input evidence");
  }
  const build = await readBuildRecord(
    buildPath,
    options.environment,
    options.release,
  );
  const activationSource = build.reconciledBy ?? build.source;
  if (
    activationSource.branch !== context.repository.branch ||
    activationSource.commit !== context.repository.commit ||
    (build.reconciledBy === undefined &&
      build.source.dockerfileSha256 !== context.dockerfileSha256)
  ) {
    throw new Error("build evidence does not match current runner source");
  }
  const immutableRef = build.image.immutableRef;
  if (!immutableRef || !DIGEST_IMAGE.test(immutableRef)) {
    throw new Error("build evidence has no immutable runner image");
  }
  if (
    build.config.path !== context.config.path ||
    build.config.expectedActivationSha256 !== context.config.sha256 ||
    context.config.runnerImage !== immutableRef ||
    context.config.runnerImage === build.config.previousImage
  ) {
    throw new Error("runner_image_activation_config_not_image_only");
  }
  const reconstructedBuildSource = replaceRunnerImage(
    context.config.source,
    immutableRef,
    build.config.previousImage,
  );
  if (
    sha256(reconstructedBuildSource) !== build.config.buildSha256 ||
    assertRunnerImageOnlyConfigChange(
      reconstructedBuildSource,
      context.config.source,
      build.config.previousImage,
      immutableRef,
    ) !== context.config.sha256
  ) {
    throw new Error("runner_image_activation_config_not_image_only");
  }
  const platform = await readPlatformEvidence(platformPath);
  if (
    platform.environment !== options.environment ||
    platform.sourceCommit !== context.repository.commit ||
    platform.configPath !== context.config.path ||
    platform.configSha256 !== context.config.sha256
  ) {
    throw new Error("platform evidence does not bind the runner activation");
  }
  const planned = {
    kind: "takosumi.runner-image-release@v2",
    operation: "verify",
    status: "planned",
    environment: options.environment,
    release: options.release,
    observedAt,
    source: {
      branch: context.repository.branch,
      commit: context.repository.commit,
    },
    image: immutableRef,
    platformVersionId: platform.deployedVersionId,
  } as const;
  if (!options.execute) return planned;

  await prepareEvidenceFile(options.evidence, sourceRoots);
  let workspace: string | null = null;
  let application: RunnerApplication | null = null;
  let incompleteContainerReadback = false;
  try {
    workspace = await mkdtemp(
      join(dirname(resolve(options.evidence)), ".takosumi-runner-verify-"),
    );
    await chmod(workspace, 0o700);
    const sealedConfig = join(workspace, "wrangler.toml");
    await writeFile(sealedConfig, runnerWranglerConfigSource(context), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const readbackContext: ReleaseContext = {
      ...context,
      config: { ...context.config, path: sealedConfig },
    };
    const deployment = await checkedCommand(
      command,
      "bunx",
      [
        "wrangler",
        "deployments",
        "status",
        "--json",
        "--config",
        sealedConfig,
      ],
      context.repository.root,
    );
    const servingVersionId = parseServingVersion(deployment.stdout);
    if (servingVersionId !== platform.deployedVersionId) {
      throw new Error("platform evidence Worker Version is not serving exactly");
    }
    application = await readRunnerApplication(readbackContext, command);
    if (
      application.image !== immutableRef &&
      application.image !== build.config.previousImage
    ) {
      throw new Error("live runner application has an unexpected image");
    }
    application = await waitForRunnerApplication(
      readbackContext,
      immutableRef,
      command,
      waitForNextRead,
      application,
    );
    if (!isRunnerApplicationComplete(application, immutableRef)) {
      incompleteContainerReadback = true;
      throw new Error(
        "runner image verification did not reach exact healthy state",
      );
    }
    const record = {
      ...planned,
      status: "verified",
      configSha256: context.config.sha256,
      platform: {
        evidence: platformPath,
        planConfirmation: platform.planConfirmation,
        predecessorVersionId: platform.predecessorVersionId,
        deployedVersionId: platform.deployedVersionId,
        dashboardAssetsSha256: platform.dashboardAssetsSha256,
        reviewer: platform.reviewer,
      },
      application,
      review: options.review ?? null,
    } as const;
    await appendEvidence(options.evidence, record);
    return record;
  } catch (error) {
    await appendEvidence(options.evidence, {
      ...planned,
      status: "incomplete",
      mutationOutcome: "not-applicable",
      failure: incompleteContainerReadback
        ? "container-readback-incomplete"
        : "verification-readback-failed",
      failureBoundary: "read-only-post-step",
      ...(application ? { application } : {}),
      diagnostic: releaseDiagnostic(error),
      review: options.review ?? null,
    });
    throw error;
  } finally {
    if (workspace !== null) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

async function inspectContext(
  repositoryRoot: string,
  options: RunnerImageReleaseOptions,
  git: NonNullable<RunnerImageReleaseRuntime["git"]>,
): Promise<ReleaseContext> {
  const repository = await repositoryIdentity(
    repositoryRoot,
    options.environment,
    git,
  );
  const configPath = await canonicalFile(options.config, "config path");
  const configSource = new TextDecoder("utf-8", { fatal: true }).decode(
    await readStablePhysicalFile(configPath, "config path"),
  );
  const workerName = configSource.match(/^name\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  if (workerName !== WORKER_NAMES[options.environment]) {
    throw new Error("realized config worker name does not match environment");
  }
  const releaseSource = resolvePlatformReleaseSourceAuthority({
    configPath,
    configSource,
    repositoryRoot,
    checkoutRepository: repository.remoteRepository,
    checkoutCommit: repository.commit,
  });
  const entryWorkerPath = await canonicalFile(
    releaseSource.entryWorkerPath,
    "Worker entrypoint",
  );
  if (entryWorkerPath !== releaseSource.entryWorkerPath) {
    throw new Error(
      "pinned release source entrypoint must resolve exactly inside its checkout",
    );
  }
  // Dry-run is a release preflight too: prove now that Wrangler can receive
  // the derived path projection, before any build materialization or local
  // Docker work occurs on an executing build.
  injectPlatformSourcePaths(
    configSource,
    releaseSource.entryWorkerPath,
    releaseSource.dashboardAssetsPath,
  );
  const imageSpan = uniqueRunnerImageSpan(configSource);
  if (!DIGEST_IMAGE.test(imageSpan.image)) {
    throw new Error("realized runner image must be an immutable registry digest");
  }
  const dockerfilePath = await canonicalFile(
    resolve(repositoryRoot, "runner/Dockerfile"),
    "runner Dockerfile",
  );
  return {
    repository,
    releaseSource,
    config: {
      path: configPath,
      source: configSource,
      sha256: sha256(configSource),
      workerName,
      runnerImage: imageSpan.image,
      runnerApplicationName: RUNNER_APPLICATION_NAMES[options.environment],
    },
    dockerfileSha256: sha256(
      await readStablePhysicalFile(dockerfilePath, "runner Dockerfile"),
    ),
  };
}

/**
 * Wrangler receives an ephemeral projection of the identity-only realized
 * config. Both paths come from the exact repository/commit source authority;
 * the realized bytes retained in evidence remain pathless and unchanged.
 */
function runnerWranglerConfigSource(context: ReleaseContext): string {
  return injectPlatformSourcePaths(
    context.config.source,
    context.releaseSource.entryWorkerPath,
    context.releaseSource.dashboardAssetsPath,
  );
}

async function repositoryIdentity(
  root: string,
  environment: RunnerImageReleaseEnvironment,
  git: NonNullable<RunnerImageReleaseRuntime["git"]>,
): Promise<RepositoryIdentity> {
  let replaceRefs: string;
  try {
    replaceRefs = await git(root, [
      "--no-replace-objects",
      "for-each-ref",
      "--format=%(refname)",
      "refs/replace",
    ]);
  } catch (error) {
    throw new Error("runner_image_git_replace_refs_invalid", { cause: error });
  }
  if (replaceRefs.trim()) {
    throw new Error("runner_image_git_replace_refs_forbidden");
  }
  if (environment === "production") {
    // The shared `production-routine` lineage class, run through this
    // surface's own injected git seam so the corpus self-test and the real
    // release exercise one predicate: clean, on main, at or an ancestor of a
    // freshly fetched origin/main.
    const answer = await lineageVerdict("production-routine", {
      cwd: root,
      git: async (args, cwd) => {
        try {
          return (await git(cwd, [...args])).trim();
        } catch {
          return null;
        }
      },
    });
    if (answer.verdict !== "accept") {
      throw new Error(`${root} refused by production lineage: ${answer.why}`);
    }
  }
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.trim()) throw new Error(`${root} must be clean`);
  const branch = (await git(root, ["branch", "--show-current"])).trim();
  if (!branch) throw new Error(`${root} must be on an attached branch`);
  const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
  let originCommit = "";
  let remoteCommit = "";
  let remoteRepository = "";
  try {
    remoteRepository = (await git(root, ["remote", "get-url", "origin"])).trim();
    originCommit = (await git(root, ["rev-parse", `origin/${branch}`])).trim();
    remoteCommit = (
      await git(root, [
        "ls-remote",
        "--exit-code",
        "origin",
        `refs/heads/${branch}`,
      ])
    ).trim().split(/\s+/u)[0] ?? "";
  } catch {
    throw new Error(`${root} must equal pushed origin/${branch}`);
  }
  if (
    !/^[0-9a-f]{40}$/u.test(commit) ||
    !remoteRepository ||
    commit !== originCommit ||
    commit !== remoteCommit
  ) {
    throw new Error(`${root} must equal pushed origin/${branch}`);
  }
  return { root, branch, commit, remoteCommit, remoteRepository };
}

async function readRunnerApplication(
  context: ReleaseContext,
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
): Promise<RunnerApplication> {
  const result = await checkedCommand(
    command,
    "bunx",
    [
      "wrangler",
      "containers",
      "list",
      "--json",
      "--config",
      context.config.path,
    ],
    context.repository.root,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("live runner application list readback is invalid");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("live runner application list readback is not an array");
  }
  const matching = parsed.filter(
    (entry) =>
      isRecord(entry) && entry.name === context.config.runnerApplicationName,
  );
  if (
    matching.length !== 1 ||
    !isBoundedString(matching[0]!.id, 256) ||
    !isBoundedString(matching[0]!.name, 256) ||
    !isBoundedString(matching[0]!.state, 64) ||
    !isBoundedString(matching[0]!.image, 512) ||
    !isRunnerApplicationVersion(matching[0]!.version)
  ) {
    throw new Error("live runner application readback is missing or ambiguous");
  }
  const summary = matching[0]!;
  const detailResult = await checkedCommand(
    command,
    "bunx",
    [
      "wrangler",
      "containers",
      "info",
      summary.id as string,
      "--config",
      context.config.path,
    ],
    context.repository.root,
  );
  let detail: unknown;
  try {
    detail = JSON.parse(detailResult.stdout) as unknown;
  } catch {
    throw new Error("live runner application detail readback is invalid");
  }
  if (!isRecord(detail)) {
    throw new Error("live runner application detail readback is not an object");
  }
  const detailImage = runnerApplicationDetailImage(detail);
  const hasDetailState = Object.hasOwn(detail, "state");
  if (
    detail.id !== summary.id ||
    detail.name !== summary.name ||
    detailImage !== summary.image ||
    (hasDetailState &&
      (!isBoundedString(detail.state, 64) || detail.state !== summary.state)) ||
    !isBoundedString(detailImage, 512) ||
    !isRunnerApplicationVersion(detail.version) ||
    detail.version !== summary.version
  ) {
    throw new Error("live runner application list/detail identity differs");
  }
  return {
    id: summary.id as string,
    name: summary.name as string,
    // `containers list --json` supplies the synthesized application state. The
    // raw `containers info` detail may omit state, but must agree when present.
    state: summary.state as string,
    image: detailImage,
    version: detail.version,
    hasActiveRollout:
      detail.active_rollout_id !== undefined &&
      detail.active_rollout_id !== null,
    health: runnerApplicationHealth(detail),
  };
}

async function waitForRunnerApplication(
  context: ReleaseContext,
  expectedImage: string,
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  waitForNextRead: NonNullable<RunnerImageReleaseRuntime["wait"]>,
  initial: RunnerApplication,
): Promise<RunnerApplication> {
  let observed = initial;
  for (
    let attempt = 1;
    attempt < 36 && !isRunnerApplicationComplete(observed, expectedImage);
    attempt += 1
  ) {
    await waitForNextRead(5_000);
    observed = await readRunnerApplication(context, command);
  }
  return observed;
}

function isRunnerApplicationComplete(
  application: RunnerApplication,
  expectedImage: string,
): boolean {
  return (
    application.image === expectedImage &&
    (application.state === "active" || application.state === "ready") &&
    !application.hasActiveRollout &&
    application.health.failed === 0 &&
    application.health.starting === 0 &&
    application.health.scheduling === 0 &&
    application.health.errorCount === 0
  );
}

function isRunnerApplicationVersion(
  value: unknown,
): value is RunnerApplicationVersion {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    isBoundedString(value, 128)
  );
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function runnerApplicationDetailImage(
  detail: Readonly<Record<string, unknown>>,
): string | null {
  const direct = typeof detail.image === "string" ? detail.image : null;
  const configuration = isRecord(detail.configuration)
    ? detail.configuration
    : null;
  const configured =
    configuration && typeof configuration.image === "string"
      ? configuration.image
      : null;
  if (direct !== null && configured !== null && direct !== configured) {
    throw new Error("live runner application detail has conflicting images");
  }
  return direct ?? configured;
}

function runnerApplicationHealth(
  detail: Readonly<Record<string, unknown>>,
): RunnerApplicationHealth {
  const health = isRecord(detail.health) ? detail.health : null;
  const instances = health && isRecord(health.instances)
    ? health.instances
    : null;
  const errorsValue = detail.errors ?? health?.errors;
  return {
    failed: finiteNumber(instances?.failed),
    starting: finiteNumber(instances?.starting),
    scheduling: finiteNumber(instances?.scheduling),
    errorCount:
      errorsValue === undefined
        ? 0
        : Array.isArray(errorsValue)
          ? errorsValue.length
          : null,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildRecord(
  options: RunnerImageReleaseOptions,
  context: ReleaseContext,
  observedAt: string,
  transportTag: string,
  transportRef: string | null,
  immutableRef: string | null,
  expectedActivationSha256: string | null,
  status: RunnerImageBuildRecord["status"],
): RunnerImageBuildRecord {
  return {
    kind: "takosumi.runner-image-release@v2",
    operation: "build",
    status,
    environment: options.environment,
    release: options.release,
    observedAt,
    source: {
      branch: context.repository.branch,
      commit: context.repository.commit,
      dockerfileSha256: context.dockerfileSha256,
    },
    config: {
      path: context.config.path,
      buildSha256: context.config.sha256,
      expectedActivationSha256,
      previousImage: context.config.runnerImage,
    },
    image: { transportTag, transportRef, immutableRef },
    review: options.review ?? null,
  };
}

async function readBuildRecord(
  path: string,
  environment: RunnerImageReleaseEnvironment,
  release: string,
): Promise<RunnerImageBuildRecord> {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    await readStablePrivateFile(path, "build evidence"),
  );
  const records: RunnerImageBuildRecord[] = [];
  for (const line of source.split(/\r?\n/u).filter(Boolean)) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("build evidence is malformed");
    }
    if (
      isRecord(value) &&
      value.kind === "takosumi.runner-image-release@v2" &&
      value.operation === "build" &&
      value.status === "published" &&
      value.environment === environment &&
      value.release === release
    ) {
      records.push(value as RunnerImageBuildRecord);
    }
  }
  if (records.length !== 1) {
    throw new Error("build evidence must contain exactly one matching record");
  }
  const record = records[0]!;
  if (
    !isBoundedString(record.source?.branch, 512) ||
    !/^[0-9a-f]{40}$/u.test(record.source?.commit ?? "") ||
    !SHA256.test(record.source?.dockerfileSha256 ?? "") ||
    !isBoundedString(record.config?.path, 4096) ||
    !SHA256.test(record.config?.buildSha256 ?? "") ||
    !SHA256.test(record.config?.expectedActivationSha256 ?? "") ||
    !DIGEST_IMAGE.test(record.config?.previousImage ?? "") ||
    !RELEASE_LABEL.test(record.image?.transportTag ?? "") ||
    !TRANSPORT_REF.test(record.image?.transportRef ?? "") ||
    !DIGEST_IMAGE.test(record.image?.immutableRef ?? "") ||
    (record.reconciledBy !== undefined &&
      (!isBoundedString(record.reconciledBy.branch, 512) ||
        record.reconciledBy.branch !== record.source.branch ||
        !/^[0-9a-f]{40}$/u.test(record.reconciledBy.commit))) ||
    !isBoundedString(record.review, 256)
  ) {
    throw new Error("build evidence has invalid provenance or image fields");
  }
  assertReview(record.review);
  return record;
}

async function readPlatformEvidence(path: string): Promise<PlatformReadyEvidence> {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readStablePrivateFile(path, "platform ready evidence"),
      ),
    ) as unknown;
  } catch {
    throw new Error("platform ready evidence is malformed");
  }
  if (
    !isRecord(value) ||
    value.kind !== "takosumi.platform-worker-release-evidence@v2" ||
    value.status !== "ready" ||
    (value.environment !== "staging" && value.environment !== "production") ||
    typeof value.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceCommit) ||
    !isBoundedString(value.configPath, 4096) ||
    !SHA256.test(value.configSha256 as string) ||
    !SHA256.test(value.dashboardAssetsSha256 as string) ||
    !VERSION.test(value.predecessorVersionId as string) ||
    !VERSION.test(value.deployedVersionId as string) ||
    !SHA256.test(value.planConfirmation as string) ||
    !isBoundedString(value.reviewer, 256)
  ) {
    throw new Error("platform ready evidence is invalid");
  }
  assertReview(value.reviewer);
  return value as unknown as PlatformReadyEvidence;
}

function parseServingVersion(source: string): string {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("deployment status readback is invalid");
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.versions) ||
    value.versions.length !== 1 ||
    !isRecord(value.versions[0]) ||
    value.versions[0].percentage !== 100 ||
    typeof value.versions[0].version_id !== "string" ||
    !VERSION.test(value.versions[0].version_id)
  ) {
    throw new Error("deployment status is not one exact 100 percent Version");
  }
  return value.versions[0].version_id;
}

async function checkedCommand(
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const result = await command(executable, args, cwd);
  if (result.exitCode !== 0) {
    throw new ReleaseCommandError(
      releaseCommandLabel(executable, args),
      result,
    );
  }
  return result;
}

class ReleaseCommandError extends Error {
  readonly result: CommandResult;
  readonly commandLabel: string;

  constructor(commandLabel: string, result: CommandResult) {
    super(`${commandLabel} failed with exit ${result.exitCode}`);
    this.name = "ReleaseCommandError";
    this.commandLabel = commandLabel;
    this.result = result;
  }
}

class CommandTimeoutError extends Error {
  constructor(label: string, timeoutMilliseconds: number) {
    super(`${label} timed out after ${timeoutMilliseconds}ms`);
    this.name = "CommandTimeoutError";
  }
}

function releaseCommand(
  runtimeCommand: RunnerImageReleaseRuntime["command"],
  timeoutOverride: number | undefined,
): NonNullable<RunnerImageReleaseRuntime["command"]> {
  return (executable, args, cwd) => {
    const timeoutMilliseconds =
      timeoutOverride ?? releaseCommandTimeout(executable, args);
    if (runtimeCommand) {
      return runInjectedCommandWithTimeout(
        runtimeCommand,
        executable,
        args,
        cwd,
        timeoutMilliseconds,
      );
    }
    return runCommand(executable, args, cwd, timeoutMilliseconds);
  };
}

async function runInjectedCommandWithTimeout(
  command: NonNullable<RunnerImageReleaseRuntime["command"]>,
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMilliseconds: number,
): Promise<CommandResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new CommandTimeoutError(
          releaseCommandLabel(executable, args),
          timeoutMilliseconds,
        ),
      );
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => command(executable, args, cwd)),
      timeoutResult,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function releaseCommandTimeout(
  executable: string,
  args: readonly string[],
): number {
  if (executable === "docker" && args[0] === "buildx") {
    return RELEASE_BUILD_COMMAND_TIMEOUT_MS;
  }
  if (
    executable === "bunx" &&
    args[0] === "wrangler" &&
    args[1] === "containers" &&
    args[2] === "push"
  ) {
    return RELEASE_MUTATION_COMMAND_TIMEOUT_MS;
  }
  return RELEASE_COMMAND_TIMEOUT_MS;
}

function releaseCommandLabel(
  executable: string,
  args: readonly string[],
): string {
  return [executable, ...args.slice(0, 3)].join(" ").slice(0, 160);
}

function releaseDiagnostic(error: unknown): Readonly<{
  code: string;
  message: string;
  command: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const commandError = error instanceof ReleaseCommandError ? error : null;
  return {
    code: error instanceof Error ? error.name : "UnknownError",
    message: boundedDiagnosticText(
      error instanceof Error ? error.message : String(error),
    ),
    command: commandError?.commandLabel ?? null,
    exitCode: commandError?.result.exitCode ?? null,
    stdout: boundedDiagnosticText(commandError?.result.stdout ?? ""),
    stderr: boundedDiagnosticText(commandError?.result.stderr ?? ""),
  };
}

function boundedDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:bearer|token|secret|password)\s*[=:]\s*\S+/giu, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_|sk_live_|AKIA)[0-9A-Za-z]{12,}/gu, "[REDACTED]")
    .slice(0, 2_048);
}

async function runCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMilliseconds: number,
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: runnerChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateCommand(child, "SIGTERM");
      terminationTimer = setTimeout(() => {
        terminateCommand(child, "SIGKILL");
      }, COMMAND_TERMINATION_GRACE_MS);
      reject(
        new CommandTimeoutError(
          releaseCommandLabel(executable, args),
          timeoutMilliseconds,
        ),
      );
    }, timeoutMilliseconds);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      stdout += value;
    });
    child.stderr.on("data", (value: string) => {
      stderr += value;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (settled) return;
      settled = true;
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function runnerChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "true",
  };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "BUILDX_BUILDER",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function terminateCommand(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already have exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The direct child may also have exited.
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("source root must be absolute");
  const info = await lstat(path);
  const canonical = await realpath(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("source root must be a physical directory");
  }
  return canonical;
}

async function canonicalFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const info = await lstat(path);
  const canonical = await realpath(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} must be a physical file`);
  }
  return canonical;
}

async function readStablePhysicalFile(
  path: string,
  label: string,
): Promise<Uint8Array> {
  const pathBefore = await lstat(path, { bigint: true });
  if (
    pathBefore.isSymbolicLink() ||
    !pathBefore.isFile() ||
    pathBefore.nlink !== 1n
  ) {
    throw new Error(`${label} must be a single-link physical file`);
  }
  const descriptor = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedBefore = await descriptor.stat({ bigint: true });
    if (!samePhysicalFile(pathBefore, openedBefore)) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = await descriptor.readFile();
    const openedAfter = await descriptor.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      BigInt(bytes.byteLength) !== openedBefore.size ||
      !samePhysicalFile(openedBefore, openedAfter) ||
      !samePhysicalFile(openedAfter, pathAfter)
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await descriptor.close();
  }
}

async function readStablePrivateFile(
  path: string,
  label: string,
): Promise<Uint8Array> {
  const info = await lstat(path);
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`${label} mode must be exactly 0600`);
  }
  if (info.nlink !== 1) {
    throw new Error(`${label} must have exactly one link`);
  }
  if (process.getuid && info.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current operator`);
  }
  return readStablePhysicalFile(path, label);
}

function samePhysicalFile(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function canonicalEvidenceInput(
  path: string,
  sourceRoots: readonly string[],
): Promise<string> {
  await assertEvidencePath(path, sourceRoots, true);
  const canonical = await realpath(path);
  await assertEvidencePath(canonical, sourceRoots, true);
  return canonical;
}

async function assertEvidencePath(
  path: string,
  sourceRoots: readonly string[],
  mustExist = false,
): Promise<void> {
  if (!isAbsolute(path)) throw new Error("evidence path must be absolute");
  const absolute = resolve(path);
  await assertOutsideEveryGitWorktree(absolute);
  if (sourceRoots.some((root) => isInside(absolute, root))) {
    throw new Error("evidence path must be outside source repositories");
  }
  let info: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
  if (info !== null) {
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("evidence path must be a physical file");
    }
    if ((info.mode & 0o777) !== 0o600) {
      throw new Error("existing evidence file mode must be exactly 0600");
    }
    if (info.nlink !== 1) {
      throw new Error("existing evidence file must have exactly one link");
    }
    if (process.getuid && info.uid !== process.getuid()) {
      throw new Error("existing evidence file must be owned by current operator");
    }
    const canonical = await realpath(absolute);
    if (sourceRoots.some((root) => isInside(canonical, root))) {
      throw new Error("evidence path must be outside source repositories");
    }
    return;
  }
  if (mustExist) throw new Error("evidence path must exist");
  const canonicalTarget = await canonicalFuturePath(absolute);
  await assertOutsideEveryGitWorktree(canonicalTarget);
  if (sourceRoots.some((root) => isInside(canonicalTarget, root))) {
    throw new Error("evidence path must be outside source repositories");
  }
}

async function assertOutsideEveryGitWorktree(path: string): Promise<void> {
  const future = await canonicalFuturePath(path);
  let cursor = dirname(future);
  for (;;) {
    try {
      await lstat(join(cursor, ".git"));
      throw new Error("evidence path must be globally outside every Git worktree");
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function canonicalFuturePath(path: string): Promise<string> {
  let cursor = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return resolve(canonical, ...missing);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function prepareEvidenceFile(
  path: string,
  sourceRoots: readonly string[],
): Promise<void> {
  const absolute = resolve(path);
  let existed = true;
  try {
    await lstat(absolute);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
    existed = false;
  }
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(dirname(absolute));
  if (
    parentInfo.isSymbolicLink() ||
    !parentInfo.isDirectory() ||
    (parentInfo.mode & 0o077) !== 0 ||
    (process.getuid && parentInfo.uid !== process.getuid()) ||
    (await realpath(dirname(absolute))) !== dirname(absolute)
  ) {
    throw new Error("evidence parent must be a physical operator-private directory");
  }
  await assertEvidencePath(absolute, sourceRoots);
  const evidence = await open(
    absolute,
    fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await evidence.chmod(0o600);
    const info = await evidence.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n) {
      throw new Error("evidence file must have exactly one link");
    }
    await evidence.sync();
  } finally {
    await evidence.close();
  }
  // A file fsync alone does not make a newly linked journal durable. Flush the
  // containing directory before any remote mutation can follow.
  if (!existed) await syncPhysicalDirectory(dirname(absolute));
  await assertEvidencePath(absolute, sourceRoots, true);
}

async function appendEvidence(path: string, record: unknown): Promise<void> {
  let existed = true;
  try {
    await lstat(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
    existed = false;
  }
  const evidence = await open(
    path,
    fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await evidence.chmod(0o600);
    const before = await evidence.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error("evidence file must have exactly one link");
    }
    await evidence.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await evidence.sync();
    const after = await evidence.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (!sameInode(before, after) || !samePhysicalFile(after, pathAfter)) {
      throw new Error("evidence inode changed while appending");
    }
  } finally {
    await evidence.close();
  }
  if (!existed) await syncPhysicalDirectory(dirname(resolve(path)));
}

type PublicationJournalIdentity = Readonly<{
  scope: string;
  locatorRoot: string;
  locatorPath: string;
  lockPath: string;
}>;

type PublicationJournalFileIdentity = Readonly<{
  dev: string;
  ino: string;
  birthtimeNs: string;
}>;

type PublicationHostIdentity = Readonly<{
  machineIdSha256: string;
  pidNamespaceDev: string;
  pidNamespaceIno: string;
}>;

type PublicationLocator = Readonly<{
  kind: "takosumi.runner-image-publication-locator@v3";
  scope: string;
  journalPath: string;
  journalIdentity: PublicationJournalFileIdentity;
  hostIdentity: PublicationHostIdentity;
  createdAt: string;
}>;

type PublicationJournal = Readonly<{
  path: string;
  read: () => Promise<Uint8Array>;
  append: (record: unknown) => Promise<void>;
  assertBound: () => Promise<void>;
  close: () => Promise<void>;
}>;

type RunnerImageReleasePathGraph = Readonly<{
  config: string;
  sourcePin: string;
  evidence: string;
  state?: string;
  buildEvidence?: string;
  platformEvidence?: string;
  publicationJournal?: PublicationJournalIdentity;
}>;

async function assertRunnerImageReleasePathGraph(
  graph: RunnerImageReleasePathGraph,
): Promise<void> {
  const requested = [
    { label: "config", path: graph.config, callerOwned: true },
    { label: "source-pin", path: graph.sourcePin, callerOwned: true },
    { label: "evidence", path: graph.evidence, callerOwned: true },
    ...(graph.state
      ? [{ label: "state", path: graph.state, callerOwned: true }]
      : []),
    ...(graph.buildEvidence
      ? [
          {
            label: "build-evidence",
            path: graph.buildEvidence,
            callerOwned: true,
          },
        ]
      : []),
    ...(graph.platformEvidence
      ? [
          {
            label: "platform-evidence",
            path: graph.platformEvidence,
            callerOwned: true,
          },
        ]
      : []),
    ...(graph.publicationJournal
      ? [
          {
            label: "publication-locator-root",
            path: graph.publicationJournal.locatorRoot,
            callerOwned: false,
          },
          {
            label: "publication-locator",
            path: graph.publicationJournal.locatorPath,
            callerOwned: false,
          },
          {
            label: "publication-lock",
            path: graph.publicationJournal.lockPath,
            callerOwned: false,
          },
        ]
      : []),
  ] as const;
  const paths = await Promise.all(
    requested.map(async (entry) => {
      if (!isAbsolute(entry.path)) {
        throw new Error("runner_image_release_path_invalid");
      }
      const absolute = resolve(entry.path);
      const canonical = await canonicalFuturePath(absolute);
      let status: BigIntStats | null = null;
      try {
        status = await lstat(absolute, { bigint: true });
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) throw error;
      }
      return { ...entry, absolute, canonical, status };
    }),
  );
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    const left = paths[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const right = paths[rightIndex]!;
      if (
        left.canonical === right.canonical ||
        (left.status !== null &&
          right.status !== null &&
          left.status.dev === right.status.dev &&
          left.status.ino === right.status.ino)
      ) {
        throw new Error("runner_image_release_path_alias");
      }
    }
  }
  if (graph.publicationJournal) {
    const locatorRoot = paths.find(
      (entry) => entry.label === "publication-locator-root",
    )!;
    const pendingPrefix = `${basename(graph.publicationJournal.lockPath)}.pending-`;
    if (
      paths.some(
        (entry) =>
          entry.callerOwned &&
          dirname(entry.canonical) === locatorRoot.canonical &&
          basename(entry.canonical).startsWith(pendingPrefix),
      )
    ) {
      throw new Error("runner_image_release_path_alias");
    }
  }
}

function runnerImageRepository(image: string): string {
  const match = /^(registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner)@sha256:[0-9a-f]{64}$/u.exec(
    image,
  );
  if (!match) throw new Error("runner_image_publication_scope_invalid");
  return match[1]!;
}

function publicationTargetRepository(
  context: ReleaseContext,
  accountId: string | undefined,
  execute: boolean,
): string {
  const configured = runnerImageRepository(context.config.runnerImage);
  if (!execute) return configured;
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/u.test(accountId)) {
    throw new Error("runner_image_cloudflare_account_id_invalid");
  }
  const target = `registry.cloudflare.com/${accountId}/takosumi-runner`;
  if (target !== configured) {
    throw new Error("runner_image_publication_account_mismatch");
  }
  return target;
}

function defaultPublicationJournalRoot(
  repositoryRoot: string,
  repositoryOverride: boolean,
): string {
  // Programmatic repositoryRoot overrides are the isolated test seam. The
  // public CLI uses the real account home from passwd, not caller-controlled
  // HOME/XDG variables, so another checkout or --state path cannot fork the
  // release journal.
  return repositoryOverride
    ? join(dirname(repositoryRoot), ".takosumi-runner-publication")
    : join(
        userInfo().homedir,
        ".local",
        "state",
        "takosumi",
        "runner-image-publication",
      );
}

function publicationJournalIdentity(
  imageRepository: string,
  environment: RunnerImageReleaseEnvironment,
  locatorRoot: string,
): PublicationJournalIdentity {
  if (!/^registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner$/u.test(imageRepository)) {
    throw new Error("runner_image_publication_scope_invalid");
  }
  const scope = JSON.stringify({
    kind: "takosumi.runner-image-publication-scope@v1",
    environment,
    imageRepository,
  });
  const key = sha256(scope).slice("sha256:".length);
  const root = resolve(locatorRoot);
  return {
    scope,
    locatorRoot: root,
    locatorPath: join(root, `${key}.locator.json`),
    lockPath: join(root, `${key}.lock`),
  };
}

async function preparePublicationLocatorDirectory(path: string): Promise<void> {
  await assertOutsideEveryGitWorktree(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const status = await lstat(path);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    (status.mode & 0o777) !== 0o700 ||
    (process.getuid && status.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  ) {
    throw new Error("runner_image_publication_locator_invalid");
  }
}

async function assertPublicationJournalBinding(
  identity: PublicationJournalIdentity,
  requestedStatePath: string,
  create: boolean,
  allowExistingJournalAdoption = false,
): Promise<void> {
  const journal = await openPublicationJournal(
    identity,
    requestedStatePath,
    create,
    allowExistingJournalAdoption,
  );
  await journal?.close();
}

async function legacyPublicationJournalAdoptionStatus(
  path: string,
): Promise<Readonly<{
  status: BigIntStats;
  attempt: RunnerPublicationAttempt;
}>> {
  try {
    const pathBefore = await privateSingleLinkStatus(
      path,
      "publication state",
    );
    const descriptor = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const opened = await descriptor.stat({ bigint: true });
      if (!samePhysicalFile(pathBefore, opened)) {
        throw new Error("publication state changed while opening");
      }
      const bytes = await readDescriptorBytes(
        descriptor,
        opened,
        "publication state",
      );
      const after = await descriptor.stat({ bigint: true });
      const linked = await lstat(path, { bigint: true });
      if (
        !samePhysicalFile(opened, after) ||
        !samePhysicalFile(after, linked)
      ) {
        throw new Error("publication state changed while reading");
      }
      const entries = parsePublicationState(bytes);
      if (
        entries.length !== 1 ||
        entries[0]?.status !== "publication-started" ||
        entries[0].image.localDescriptorDigest !== undefined
      ) {
        throw new Error("publication state is not one legacy attempt");
      }
      return { status: after, attempt: entries[0] };
    } finally {
      await descriptor.close();
    }
  } catch (error) {
    throw new Error("runner_image_publication_journal_adoption_invalid", {
      cause: error,
    });
  }
}

async function openPublicationJournal(
  identity: PublicationJournalIdentity,
  requestedStatePath: string,
  create: boolean,
  allowExistingJournalAdoption: boolean,
  proveLegacyAdoption?: (attempt: RunnerPublicationAttempt) => Promise<void>,
): Promise<PublicationJournal | null> {
  const requested = resolve(requestedStatePath);
  const hostIdentity = await publicationHostIdentity();
  let locatorExists = true;
  try {
    await lstat(identity.locatorPath);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
    locatorExists = false;
  }
  if (!locatorExists) {
    if (!create) return null;
    let journalStatus: BigIntStats;
    if (allowExistingJournalAdoption) {
      const adoption = await legacyPublicationJournalAdoptionStatus(
        requested,
      );
      if (!proveLegacyAdoption) {
        throw new Error("runner_image_publication_journal_adoption_invalid");
      }
      await proveLegacyAdoption(adoption.attempt);
      journalStatus = await lstat(requested, { bigint: true });
      if (!samePhysicalFile(adoption.status, journalStatus)) {
        throw new Error("runner_image_publication_journal_adoption_invalid");
      }
    } else {
      let existing: BigIntStats | null = null;
      try {
        existing = await lstat(requested, { bigint: true });
      } catch (stateError) {
        if (!isFileSystemError(stateError, "ENOENT")) throw stateError;
      }
      if (existing !== null && existing.size > 0n) {
        throw new Error("runner_image_publication_journal_unbound");
      }
      await prepareEvidenceFile(requested, []);
      journalStatus = await lstat(requested, { bigint: true });
    }
    const locator: PublicationLocator = {
      kind: "takosumi.runner-image-publication-locator@v3",
      scope: identity.scope,
      journalPath: requested,
      journalIdentity: publicationJournalFileIdentity(journalStatus),
      hostIdentity,
      createdAt: new Date().toISOString(),
    };
    const descriptor = await open(
      identity.locatorPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await descriptor.chmod(0o600);
      await descriptor.writeFile(`${JSON.stringify(locator)}\n`, "utf8");
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await syncPhysicalDirectory(identity.locatorRoot);
  }

  const locatorPathBefore = await privateSingleLinkStatus(
    identity.locatorPath,
    "publication locator",
  );
  const locatorDescriptor = await open(
    identity.locatorPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let journalDescriptor: FileHandle | null = null;
  try {
    const locatorOpened = await locatorDescriptor.stat({ bigint: true });
    if (!samePhysicalFile(locatorPathBefore, locatorOpened)) {
      throw new Error("runner_image_publication_locator_invalid");
    }
    const locatorBytes = await readDescriptorBytes(
      locatorDescriptor,
      locatorOpened,
      "publication locator",
    );
    const locatorAfter = await locatorDescriptor.stat({ bigint: true });
    const locatorPathAfter = await lstat(identity.locatorPath, { bigint: true });
    if (
      !samePhysicalFile(locatorOpened, locatorAfter) ||
      !samePhysicalFile(locatorAfter, locatorPathAfter)
    ) {
      throw new Error("runner_image_publication_locator_invalid");
    }
    const locator = parsePublicationLocator(locatorBytes, identity);
    if (!samePublicationHostIdentity(locator.hostIdentity, hostIdentity)) {
      throw new Error("runner_image_publication_host_mismatch");
    }
    if (resolve(locator.journalPath) !== requested) {
      throw new Error("runner_image_publication_state_path_mismatch");
    }

    let journalPathBefore: BigIntStats;
    try {
      journalPathBefore = await privateSingleLinkStatus(
        requested,
        "publication state",
      );
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new Error("runner_image_publication_journal_missing");
      }
      throw error;
    }
    assertPublicationFileIdentity(
      journalPathBefore,
      locator.journalIdentity,
      "runner_image_publication_journal_identity_changed",
    );
    journalDescriptor = await open(
      requested,
      fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    const journalOpened = await journalDescriptor.stat({ bigint: true });
    const journalPathAfter = await lstat(requested, { bigint: true });
    if (
      !samePhysicalFile(journalPathBefore, journalOpened) ||
      !samePhysicalFile(journalOpened, journalPathAfter)
    ) {
      throw new Error("runner_image_publication_journal_identity_changed");
    }
    assertPublicationFileIdentity(
      journalOpened,
      locator.journalIdentity,
      "runner_image_publication_journal_identity_changed",
    );

    const assertBound = async (): Promise<void> => {
      const [locatorStatus, journalStatus] = await Promise.all([
        locatorDescriptor.stat({ bigint: true }),
        journalDescriptor!.stat({ bigint: true }),
      ]);
      let locatorLinked: BigIntStats;
      let journalLinked: BigIntStats;
      try {
        [locatorLinked, journalLinked] = await Promise.all([
          lstat(identity.locatorPath, { bigint: true }),
          lstat(requested, { bigint: true }),
        ]);
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) {
          throw new Error("runner_image_publication_journal_identity_changed");
        }
        throw error;
      }
      if (
        !samePhysicalFile(locatorAfter, locatorStatus) ||
        !samePhysicalFile(locatorStatus, locatorLinked) ||
        !samePhysicalFile(journalStatus, journalLinked)
      ) {
        throw new Error("runner_image_publication_journal_identity_changed");
      }
      assertPublicationFileIdentity(
        journalStatus,
        locator.journalIdentity,
        "runner_image_publication_journal_identity_changed",
      );
    };

    const read = async (): Promise<Uint8Array> => {
      await assertBound();
      const before = await journalDescriptor!.stat({ bigint: true });
      const bytes = await readDescriptorBytes(
        journalDescriptor!,
        before,
        "publication state",
      );
      const after = await journalDescriptor!.stat({ bigint: true });
      const linked = await lstat(requested, { bigint: true });
      if (
        !samePhysicalFile(before, after) ||
        !samePhysicalFile(after, linked)
      ) {
        throw new Error("runner_image_publication_journal_identity_changed");
      }
      return bytes;
    };

    const append = async (record: unknown): Promise<void> => {
      await assertBound();
      const before = await journalDescriptor!.stat({ bigint: true });
      const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
      await journalDescriptor!.writeFile(bytes);
      await journalDescriptor!.sync();
      const after = await journalDescriptor!.stat({ bigint: true });
      const linked = await lstat(requested, { bigint: true });
      if (
        !sameInode(before, after) ||
        after.size !== before.size + BigInt(bytes.byteLength) ||
        !samePhysicalFile(after, linked)
      ) {
        throw new Error("runner_image_publication_journal_identity_changed");
      }
      assertPublicationFileIdentity(
        after,
        locator.journalIdentity,
        "runner_image_publication_journal_identity_changed",
      );
    };

    return {
      path: requested,
      read,
      append,
      assertBound,
      close: async () => {
        await journalDescriptor!.close();
        journalDescriptor = null;
        await locatorDescriptor.close();
      },
    };
  } catch (error) {
    await journalDescriptor?.close();
    await locatorDescriptor.close();
    throw error;
  }
}

function parsePublicationLocator(
  bytes: Uint8Array,
  identity: PublicationJournalIdentity,
): PublicationLocator {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    throw new Error("runner_image_publication_locator_invalid", { cause: error });
  }
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          "createdAt",
          "hostIdentity",
          "journalIdentity",
          "journalPath",
          "kind",
          "scope",
        ].sort(),
      ) ||
    value.kind !== "takosumi.runner-image-publication-locator@v3" ||
    value.scope !== identity.scope ||
    typeof value.journalPath !== "string" ||
    !isAbsolute(value.journalPath) ||
    !validPublicationJournalFileIdentity(value.journalIdentity) ||
    !validPublicationHostIdentity(value.hostIdentity) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("runner_image_publication_locator_invalid");
  }
  return value as unknown as PublicationLocator;
}

async function privateSingleLinkStatus(
  path: string,
  label: string,
): Promise<BigIntStats> {
  const status = await lstat(path, { bigint: true });
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.nlink !== 1n ||
    (process.getuid && status.uid !== BigInt(process.getuid())) ||
    (status.mode & 0o777n) !== 0o600n
  ) {
    throw new Error(`${label} must be a current-operator single-link 0600 file`);
  }
  return status;
}

async function readDescriptorBytes(
  descriptor: FileHandle,
  status: BigIntStats,
  label: string,
): Promise<Uint8Array> {
  if (status.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is too large`);
  }
  const bytes = new Uint8Array(Number(status.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = await descriptor.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (read.bytesRead === 0) throw new Error(`${label} changed while reading`);
    offset += read.bytesRead;
  }
  return bytes;
}

async function withPublicationJournalLock<T>(
  identity: PublicationJournalIdentity,
  requestedStatePath: string,
  operation: (journal: PublicationJournal) => Promise<T>,
  allowExistingJournalAdoption = false,
  lockHook?: RunnerImageReleaseRuntime["publicationLockHook"],
  journalHook?: RunnerImageReleaseRuntime["publicationJournalHook"],
  proveLegacyAdoption?: (attempt: RunnerPublicationAttempt) => Promise<void>,
): Promise<T> {
  await preparePublicationLocatorDirectory(identity.locatorRoot);
  const descriptor = await acquirePublicationJournalLock(identity, lockHook);
  const lockSeal = await descriptor.stat({ bigint: true });
  let journal: PublicationJournal | null = null;
  try {
    journal = await openPublicationJournal(
      identity,
      requestedStatePath,
      true,
      allowExistingJournalAdoption,
      proveLegacyAdoption,
    );
    if (!journal) throw new Error("runner_image_publication_journal_not_bound");
    await journalHook?.("opened");
    return await operation(journal);
  } finally {
    await journal?.close();
    const opened = await descriptor.stat({ bigint: true });
    const linked = await lstat(identity.lockPath, { bigint: true }).catch(() => null);
    await descriptor.close();
    if (
      !linked ||
      !samePhysicalFile(lockSeal, opened) ||
      !samePhysicalFile(opened, linked)
    ) {
      throw new Error("runner_image_publication_lock_invalid");
    }
    await unlink(identity.lockPath);
    await syncPhysicalDirectory(identity.locatorRoot);
  }
}

function publicationJournalFileIdentity(
  status: BigIntStats,
): PublicationJournalFileIdentity {
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.nlink !== 1n ||
    (process.getuid && status.uid !== BigInt(process.getuid())) ||
    (status.mode & 0o777n) !== 0o600n
  ) {
    throw new Error("runner_image_publication_journal_invalid");
  }
  return {
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    birthtimeNs: status.birthtimeNs.toString(),
  };
}

function validPublicationJournalFileIdentity(
  value: unknown,
): value is PublicationJournalFileIdentity {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(["birthtimeNs", "dev", "ino"]) &&
    typeof value.dev === "string" &&
    /^[0-9]+$/u.test(value.dev) &&
    typeof value.ino === "string" &&
    /^[0-9]+$/u.test(value.ino) &&
    typeof value.birthtimeNs === "string" &&
    /^[0-9]+$/u.test(value.birthtimeNs)
  );
}

function assertPublicationFileIdentity(
  status: BigIntStats,
  expected: PublicationJournalFileIdentity,
  errorCode: string,
  allowedLinkCounts: readonly bigint[] = [1n],
): void {
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    !allowedLinkCounts.includes(status.nlink) ||
    (process.getuid && status.uid !== BigInt(process.getuid())) ||
    (status.mode & 0o777n) !== 0o600n
  ) {
    throw new Error(errorCode);
  }
  const observed = {
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    birthtimeNs: status.birthtimeNs.toString(),
  };
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(errorCode);
  }
}

async function publicationHostIdentity(): Promise<PublicationHostIdentity> {
  const [machineIdSource, pidNamespace] = await Promise.all([
    readFile("/etc/machine-id", "utf8"),
    stat("/proc/self/ns/pid", { bigint: true }),
  ]);
  const machineId = machineIdSource.trim();
  if (!/^[0-9a-f]{32}$/u.test(machineId) || !pidNamespace.isFile()) {
    throw new Error("runner_image_publication_host_identity_invalid");
  }
  return {
    machineIdSha256: sha256(machineId),
    pidNamespaceDev: pidNamespace.dev.toString(),
    pidNamespaceIno: pidNamespace.ino.toString(),
  };
}

function validPublicationHostIdentity(
  value: unknown,
): value is PublicationHostIdentity {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        ["machineIdSha256", "pidNamespaceDev", "pidNamespaceIno"].sort(),
      ) &&
    typeof value.machineIdSha256 === "string" &&
    SHA256.test(value.machineIdSha256) &&
    typeof value.pidNamespaceDev === "string" &&
    /^[0-9]+$/u.test(value.pidNamespaceDev) &&
    typeof value.pidNamespaceIno === "string" &&
    /^[0-9]+$/u.test(value.pidNamespaceIno)
  );
}

function samePublicationHostIdentity(
  left: PublicationHostIdentity,
  right: PublicationHostIdentity,
): boolean {
  return (
    left.machineIdSha256 === right.machineIdSha256 &&
    left.pidNamespaceDev === right.pidNamespaceDev &&
    left.pidNamespaceIno === right.pidNamespaceIno
  );
}

async function readStablePublicationLock(
  path: string,
): Promise<Readonly<{ bytes: Uint8Array; status: BigIntStats }>> {
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (before.nlink !== 1n && before.nlink !== 2n) ||
    (process.getuid && before.uid !== BigInt(process.getuid())) ||
    (before.mode & 0o777n) !== 0o600n
  ) {
    throw new Error("runner_image_publication_lock_invalid");
  }
  const descriptor = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await descriptor.stat({ bigint: true });
    if (!samePhysicalFile(before, opened)) {
      throw new Error("runner_image_publication_lock_invalid");
    }
    const bytes = await readDescriptorBytes(
      descriptor,
      opened,
      "publication lock",
    );
    const after = await descriptor.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true });
    if (
      !samePhysicalFile(opened, after) ||
      !samePhysicalFile(after, linked)
    ) {
      throw new Error("runner_image_publication_lock_invalid");
    }
    return { bytes, status: after };
  } finally {
    await descriptor.close();
  }
}

function publicationPendingLockName(
  identity: PublicationJournalIdentity,
  value: string,
): boolean {
  const prefix = `${basename(identity.lockPath)}.pending-`;
  if (!value.startsWith(prefix)) return false;
  return /^[0-9]+-[0-9a-f]{32}$/u.test(value.slice(prefix.length));
}

async function assertPublicationPendingLink(
  identity: PublicationJournalIdentity,
  pendingName: string,
  lockStatus: BigIntStats,
): Promise<void> {
  if (lockStatus.nlink === 1n) return;
  if (lockStatus.nlink !== 2n) {
    throw new Error("runner_image_publication_lock_invalid");
  }
  const pending = await lstat(
    join(identity.locatorRoot, pendingName),
    { bigint: true },
  ).catch(() => null);
  if (!pending || !samePhysicalFile(lockStatus, pending)) {
    throw new Error("runner_image_publication_lock_invalid");
  }
}

async function acquirePublicationJournalLock(
  identity: PublicationJournalIdentity,
  hook?: RunnerImageReleaseRuntime["publicationLockHook"],
): Promise<Awaited<ReturnType<typeof open>>> {
  for (;;) {
    const pendingName = `${basename(identity.lockPath)}.pending-${process.pid}-${randomBytes(16).toString("hex")}`;
    const pendingPath = join(identity.locatorRoot, pendingName);
    const descriptor = await open(
      pendingPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    let canonicalLinked = false;
    try {
      const [processIdentity, hostIdentity] = await Promise.all([
        publicationLockProcessIdentity(process.pid),
        publicationHostIdentity(),
      ]);
      await descriptor.chmod(0o600);
      const prepared = await descriptor.stat({ bigint: true });
      const fileIdentity = publicationJournalFileIdentity(prepared);
      await descriptor.writeFile(
        `${JSON.stringify({
          kind: "takosumi.runner-image-publication-lock@v3",
          scope: identity.scope,
          lockPath: identity.lockPath,
          pendingName,
          fileIdentity,
          hostIdentity,
          pid: process.pid,
          bootId: processIdentity.bootId,
          processStartTicks: processIdentity.processStartTicks,
          acquiredAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      await descriptor.sync();
      const complete = await descriptor.stat({ bigint: true });
      assertPublicationFileIdentity(
        complete,
        fileIdentity,
        "runner_image_publication_lock_invalid",
      );
      await hook?.("prepared");
      try {
        await link(pendingPath, identity.lockPath);
        canonicalLinked = true;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
        await descriptor.close();
        await unlink(pendingPath);
        await syncPhysicalDirectory(identity.locatorRoot);
        if (await reclaimStalePublicationJournalLock(identity)) continue;
        throw new Error("runner_image_publication_locked");
      }
      // The canonical name becomes visible only after the complete v3 record
      // is durable in the pending inode. A process crash on either side of
      // this hook therefore leaves either no canonical lock or a parseable one.
      await hook?.("linked");
      await syncPhysicalDirectory(identity.locatorRoot);
      const canonical = await lstat(identity.lockPath, { bigint: true });
      const pending = await lstat(pendingPath, { bigint: true });
      if (
        !samePhysicalFile(canonical, pending) ||
        canonical.nlink !== 2n
      ) {
        throw new Error("runner_image_publication_lock_invalid");
      }
      await unlink(pendingPath);
      await syncPhysicalDirectory(identity.locatorRoot);
      const opened = await descriptor.stat({ bigint: true });
      const linkedStatus = await lstat(identity.lockPath, { bigint: true });
      if (!samePhysicalFile(opened, linkedStatus) || opened.nlink !== 1n) {
        throw new Error("runner_image_publication_lock_invalid");
      }
      return descriptor;
    } catch (error) {
      await descriptor.close().catch(() => undefined);
      if (canonicalLinked) {
        const canonical = await lstat(identity.lockPath, { bigint: true }).catch(
          () => null,
        );
        const pending = await lstat(pendingPath, { bigint: true }).catch(
          () => null,
        );
        if (canonical && pending && samePhysicalFile(canonical, pending)) {
          await unlink(identity.lockPath).catch(() => undefined);
        }
      }
      await unlink(pendingPath).catch(() => undefined);
      await syncPhysicalDirectory(identity.locatorRoot);
      throw error;
    }
  }
}

async function reclaimStalePublicationJournalLock(
  identity: PublicationJournalIdentity,
): Promise<boolean> {
  let lock: Readonly<{ bytes: Uint8Array; status: BigIntStats }>;
  try {
    lock = await readStablePublicationLock(identity.lockPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return true;
    throw new Error("runner_image_publication_lock_invalid", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(lock.bytes),
    ) as unknown;
  } catch (error) {
    throw new Error("runner_image_publication_lock_invalid", { cause: error });
  }
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          "acquiredAt",
          "bootId",
          "fileIdentity",
          "hostIdentity",
          "kind",
          "lockPath",
          "pendingName",
          "pid",
          "processStartTicks",
          "scope",
        ].sort(),
      ) ||
    value.kind !== "takosumi.runner-image-publication-lock@v3" ||
    value.scope !== identity.scope ||
    value.lockPath !== identity.lockPath ||
    typeof value.pendingName !== "string" ||
    !publicationPendingLockName(identity, value.pendingName) ||
    !validPublicationJournalFileIdentity(value.fileIdentity) ||
    !validPublicationHostIdentity(value.hostIdentity) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.bootId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.bootId) ||
    typeof value.processStartTicks !== "string" ||
    !/^[0-9]+$/u.test(value.processStartTicks) ||
    typeof value.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(value.acquiredAt))
  ) {
    throw new Error("runner_image_publication_lock_invalid");
  }
  assertPublicationFileIdentity(
    lock.status,
    value.fileIdentity,
    "runner_image_publication_lock_invalid",
    [1n, 2n],
  );
  const [currentHost, currentProcess] = await Promise.all([
    publicationHostIdentity(),
    publicationLockProcessIdentity(process.pid),
  ]);
  if (!samePublicationHostIdentity(value.hostIdentity, currentHost)) {
    throw new Error("runner_image_publication_lock_foreign_host");
  }
  if (value.bootId !== currentProcess.bootId) {
    throw new Error("runner_image_publication_lock_foreign_boot");
  }
  await assertPublicationPendingLink(identity, value.pendingName, lock.status);
  const running = await publicationProcessStillOwnsLock(
    value.pid as number,
    value.processStartTicks,
  );
  if (running) return false;
  let linked: BigIntStats;
  try {
    linked = await lstat(identity.lockPath, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return true;
    throw error;
  }
  if (!samePhysicalFile(lock.status, linked)) {
    throw new Error("runner_image_publication_lock_invalid");
  }
  await unlink(identity.lockPath);
  const pendingPath = join(identity.locatorRoot, value.pendingName);
  const pending = await lstat(pendingPath, { bigint: true }).catch(() => null);
  if (pending && samePhysicalFile(lock.status, pending)) {
    await unlink(pendingPath);
  }
  await syncPhysicalDirectory(identity.locatorRoot);
  return true;
}

async function publicationProcessStillOwnsLock(
  pid: number,
  processStartTicks: string,
): Promise<boolean> {
  let observed: Readonly<{ bootId: string; processStartTicks: string }>;
  try {
    observed = await publicationLockProcessIdentity(pid);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw new Error("runner_image_publication_lock_liveness_unknown", {
      cause: error,
    });
  }
  return observed.processStartTicks === processStartTicks;
}

async function publicationLockProcessIdentity(
  pid: number,
): Promise<Readonly<{ bootId: string; processStartTicks: string }>> {
  const [bootIdSource, statSource] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ]);
  const bootId = bootIdSource.trim();
  const close = statSource.lastIndexOf(")");
  const fields = close === -1
    ? []
    : statSource.slice(close + 1).trim().split(/\s+/u);
  // /proc/<pid>/stat field 3 starts after the parenthesized command; starttime
  // is field 22, therefore index 19 in this suffix.
  const processStartTicks = fields[19];
  if (
    !/^[0-9a-f-]{36}$/u.test(bootId) ||
    typeof processStartTicks !== "string" ||
    !/^[0-9]+$/u.test(processStartTicks)
  ) {
    throw new Error("runner_image_publication_lock_process_invalid");
  }
  return { bootId, processStartTicks };
}

async function syncPhysicalDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      fsConstants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid
  );
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertReview(review: string): void {
  if (
    review.length === 0 ||
    review.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(review) ||
    /-----BEGIN [^-]*PRIVATE KEY-----/iu.test(review) ||
    /\b(?:bearer|token|secret|password)\s*[=:]\s*\S+/iu.test(review) ||
    /\b(?:gh[pousr]_|sk_live_|AKIA)[0-9A-Za-z]{12,}/u.test(review)
  ) {
    throw new Error(
      "review must be a bounded reviewer identity, not credential material",
    );
  }
}

function replaceRunnerImage(
  source: string,
  previousImage: string,
  selectedImage: string,
): string {
  const span = uniqueRunnerImageSpan(source);
  if (
    span.image !== previousImage ||
    !DIGEST_IMAGE.test(previousImage) ||
    !DIGEST_IMAGE.test(selectedImage) ||
    previousImage === selectedImage
  ) {
    throw new Error("runner_image_activation_config_not_image_only");
  }
  return source.slice(0, span.start) + selectedImage + source.slice(span.end);
}

function uniqueRunnerImageSpan(source: string): Readonly<{
  image: string;
  start: number;
  end: number;
}> {
  const headings = [...source.matchAll(/^\[\[([^\]\r\n]+)\]\]\s*$/gmu)].map(
    (match) => ({ name: match[1]!, start: match.index! }),
  );
  const runnerBlocks = headings.flatMap((heading, index) => {
    if (heading.name !== "containers") return [];
    const end = headings[index + 1]?.start ?? source.length;
    const block = source.slice(heading.start, end);
    return /^class_name\s*=\s*"OpenTofuRunnerObject"\s*$/mu.test(block)
      ? [{ block, start: heading.start }]
      : [];
  });
  if (runnerBlocks.length !== 1) {
    throw new Error("runner_image_activation_config_not_image_only");
  }
  const image = /^(image\s*=\s*")([^"]+)("\s*)$/mu.exec(
    runnerBlocks[0]!.block,
  );
  if (!image || image.index === undefined) {
    throw new Error("runner_image_activation_config_not_image_only");
  }
  const start = runnerBlocks[0]!.start + image.index + image[1]!.length;
  return { image: image[2]!, start, end: start + image[2]!.length };
}

function isInside(path: string, root: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(
  value: unknown,
  code: string,
): value is NodeJS.ErrnoException {
  return (
    value instanceof Error &&
    "code" in value &&
    (value as NodeJS.ErrnoException).code === code
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });
}
