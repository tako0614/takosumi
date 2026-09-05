import { isAbsolute } from "node:path";

import { platformReleaseSourceAuthorityDigest } from "./lib/platform-release-source.ts";

/**
 * The runner image release surface's DECLARATION, separated from its
 * implementation.
 *
 * WHY they are separate files. `scripts/deploy.mjs` has to print every
 * surface's contract eagerly, so it used to import the whole release module at
 * module scope — and takos-control's requiresEnv gate, which walks what each
 * surface's declared scripts can reach, therefore attributed this release's
 * `CLOUDFLARE_ACCOUNT_ID` read to every other surface in the repository,
 * including the npm package publish that never touches Cloudflare. A contract
 * is data; a release is code. Importing the data does not drag the code's
 * capabilities along with it.
 */
export const RUNNER_IMAGE_RELEASE_CONTRACT_SURFACE = {
  surface: "takosumi-runner-image",
  target: "cloudflare-container:takosumi-runner",
  covers: [
    "runner/Dockerfile",
    "runner",
    "scripts/lib/platform-release-source.ts",
    "scripts/runner-image-release.ts",
  ],
  triggers: ["authority", "published-identity"],
  requiresScripts: ["check", "deploy"],
  requiresTools: ["git", "bun", "docker", "wrangler", "tar", "curl", "cosign"],
  requiresEnv: ["CLOUDFLARE_ACCOUNT_ID"],
  obligations: {
    provenance:
      "build, reconciliation, and verification require an identity-only realized config with no main or assets directory plus its stable single-link sibling source pin, and require that exact Git repository and commit to be the clean attached pushed checkout; one canonical domain-separated digest of the exact pin kind, repository, and commit is carried through the publication journal, build evidence, confirmed platform plan, and ready evidence; staging requires HEAD to equal both local and freshly read remote origin/current-branch while production additionally requires main; runner paths are derived only in an ephemeral projection from that pinned checkout while the pathless config bytes remain the evidence identity; build materializes the immutable Git commit in an external sealed context, verifies the Dockerfile-pinned OpenTofu artifact through its upstream Sigstore identity, and binds the exact image-only activation transform plus publication journal to the remotely read content digest; reconciliation accepts only a no-replace-object historical attempt commit from the same repository that is an ancestor of the trusted current tool and fresh remote tip, then re-materializes and seals that exact commit; platform planning and verification require runner build provenance from the same owning Git remote as the Worker sibling pin, validate the runner build commit independently, require platform ready authority to equal the freshly resolved Worker sibling-pin authority before live readback, and do not require the runner and Worker source commits to match",
    "post-conditions":
      "before publication, build boots the exact local image through its native non-root ENTRYPOINT under the sealed Docker restrictions and requires a real provider-free Plan to accept an explicit empty runtime-input map for a matching defaultless ephemeral variable; build records that semantic proof against the immutable image together with the local Docker image ID and an explicit Descriptor digest with exact supported manifest media type and linux/amd64 platform, accepts only Docker's unambiguous remote Descriptor.platform linux/amd64 shape, and requires exact local/remote descriptor-digest equality before recording that immutable descriptor digest as the sole consumer identity and the actual config digest as evidence; a legacy attempt without the explicit descriptor field additionally requires the exact recorded local tag to remain present with both Docker Id and Descriptor equal to the legacy value; platform planning and runner verification refuse an image without that exact proof, while verification requires the platform evidence Worker Version to be exactly serving at 100 percent and the exact environment Container application to be healthy on that digest",
    reversal:
      "build evidence retains the exact previous immutable digest as recovery identity, not as proof of its runtime-input behavior; rollback changes only the realized image literal back to that retained digest and may pass through a new reviewed platform plan and execute only with separate valid proof for that exact predecessor image; a restore from an existing plan proves exact predecessor identity and health only, so the forward image's build evidence cannot verify predecessor compatibility",
    "failure-handling":
      "the executing account is CLOUDFLARE_ACCOUNT_ID and must equal the realized prior-image repository, whose exact target and environment select one external locator bound to a single physical machine/PID namespace and exact journal inode; a complete boot/PID-start/file-identity lock record is fsynced in a private pending inode before atomic no-overwrite publication, foreign host/namespace/boot locks are never reclaimed, and the locked operation holds and revalidates the same locator and journal descriptors immediately before push; the journal and containing directory are fsynced before push, a missing or replaced journal fails closed, and every unresolved unknown blocks every later build until explicit read-only reconciliation proves the exact recorded tag present with matching image bytes or authoritatively absent; this is deliberately local-host authority, not a distributed lock, so shared state across operator hosts is refused; bounded redacted evidence distinguishes pre-mutation failure from post-mutation unknown; verification performs no Worker mutation and fails on platform evidence, config, serving Version, application identity, image, rollout, or health ambiguity",
    "independent-review":
      "executing build or verification requires a named --review value; verification additionally consumes the platform release reviewer and sealed plan evidence",
    "no-overwrite":
      "the source/content/nonce-bound mutable transport tag is never a version identity or consumer input and is not protected by a racy check-then-push claim; the published identity is the content-addressed sha256 descriptor digest, whose exact manifest bytes are bound through local/remote descriptor-digest equality, and verification consumes exactly one matching immutable-digest build record",
  },
} as const;

export const RUNNER_IMAGE_RUNTIME_INPUT_PLAN_PROOF_KIND =
  "takosumi.runner-image-runtime-input-plan-proof@v1" as const;

export type RunnerImageRuntimeInputPlanProof = Readonly<{
  kind: typeof RUNNER_IMAGE_RUNTIME_INPUT_PLAN_PROOF_KIND;
  image: string;
}>;

export type RunnerImageReleaseEnvironment = "staging" | "production";

export type RunnerImageBuildRecord = Readonly<{
  kind: "takosumi.runner-image-release@v3";
  operation: "build";
  status: "planned" | "published";
  environment: RunnerImageReleaseEnvironment;
  release: string;
  observedAt: string;
  source: {
    branch: string;
    repository: string;
    commit: string;
    authoritySha256: string;
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
  runtimeInputPlanProof?: RunnerImageRuntimeInputPlanProof;
  reconciledBy?: {
    branch: string;
    repository: string;
    commit: string;
    authoritySha256: string;
  };
  review: string | null;
}>;

export type PublishedRunnerImageBuildRecord = RunnerImageBuildRecord & {
  readonly status: "published";
  readonly image: RunnerImageBuildRecord["image"] & {
    readonly transportRef: string;
    readonly immutableRef: string;
  };
  readonly review: string;
};

const RUNNER_IMAGE =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner@sha256:[0-9a-f]{64}$/u;
const RUNNER_IMAGE_TRANSPORT_REF =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner:[a-z0-9][a-z0-9._-]{0,127}$/u;
const RELEASE_LABEL = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

export function isRunnerImageRuntimeInputPlanProof(
  value: unknown,
  image: string,
): value is RunnerImageRuntimeInputPlanProof {
  return (
    record(value) &&
    exactKeys(value, ["image", "kind"]) &&
    value.kind === RUNNER_IMAGE_RUNTIME_INPUT_PLAN_PROOF_KIND &&
    value.image === image &&
    RUNNER_IMAGE.test(image)
  );
}

export function isPublishedRunnerImageBuildRecord(
  value: unknown,
): value is PublishedRunnerImageBuildRecord {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "config",
        "environment",
        "image",
        "kind",
        "observedAt",
        "operation",
        "release",
        "review",
        "source",
        "status",
      ],
      ["reconciledBy", "runtimeInputPlanProof"],
    ) ||
    value.kind !== "takosumi.runner-image-release@v3" ||
    value.operation !== "build" ||
    value.status !== "published" ||
    (value.environment !== "staging" && value.environment !== "production") ||
    typeof value.release !== "string" ||
    !RELEASE_LABEL.test(value.release) ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !record(value.source) ||
    !exactKeys(
      value.source,
      [
        "authoritySha256",
        "branch",
        "commit",
        "dockerfileSha256",
        "repository",
      ],
      ["buildContextSha256"],
    ) ||
    !boundedString(value.source.branch, 512) ||
    !validSourceAuthority(value.source) ||
    typeof value.source.dockerfileSha256 !== "string" ||
    !SHA256.test(value.source.dockerfileSha256) ||
    (value.source.buildContextSha256 !== undefined &&
      (typeof value.source.buildContextSha256 !== "string" ||
        !SHA256.test(value.source.buildContextSha256))) ||
    !record(value.config) ||
    !exactKeys(value.config, [
      "buildSha256",
      "expectedActivationSha256",
      "path",
      "previousImage",
    ]) ||
    !boundedString(value.config.path, 4_096) ||
    !isAbsolute(value.config.path) ||
    typeof value.config.buildSha256 !== "string" ||
    !SHA256.test(value.config.buildSha256) ||
    typeof value.config.expectedActivationSha256 !== "string" ||
    !SHA256.test(value.config.expectedActivationSha256) ||
    typeof value.config.previousImage !== "string" ||
    !RUNNER_IMAGE.test(value.config.previousImage) ||
    !record(value.image) ||
    !exactKeys(
      value.image,
      ["immutableRef", "transportRef", "transportTag"],
      ["imageConfigDigest"],
    ) ||
    typeof value.image.transportTag !== "string" ||
    !RELEASE_LABEL.test(value.image.transportTag) ||
    typeof value.image.transportRef !== "string" ||
    !RUNNER_IMAGE_TRANSPORT_REF.test(value.image.transportRef) ||
    !value.image.transportRef.endsWith(`:${value.image.transportTag}`) ||
    typeof value.image.immutableRef !== "string" ||
    !RUNNER_IMAGE.test(value.image.immutableRef) ||
    value.image.immutableRef === value.config.previousImage ||
    value.image.transportRef.slice(0, value.image.transportRef.lastIndexOf(":")) !==
      value.image.immutableRef.slice(0, value.image.immutableRef.lastIndexOf("@")) ||
    (value.image.imageConfigDigest !== undefined &&
      value.image.imageConfigDigest !== null &&
      (typeof value.image.imageConfigDigest !== "string" ||
        !SHA256.test(value.image.imageConfigDigest))) ||
    (value.runtimeInputPlanProof !== undefined &&
      (typeof value.source.buildContextSha256 !== "string" ||
        typeof value.image.imageConfigDigest !== "string" ||
        !isRunnerImageRuntimeInputPlanProof(
          value.runtimeInputPlanProof,
          value.image.immutableRef,
        ))) ||
    !validReview(value.review)
  ) {
    return false;
  }
  return (
    value.reconciledBy === undefined ||
    (record(value.reconciledBy) &&
      exactKeys(value.reconciledBy, [
        "authoritySha256",
        "branch",
        "commit",
        "repository",
      ]) &&
      value.reconciledBy.branch === value.source.branch &&
      validSourceAuthority(value.reconciledBy))
  );
}

export function runnerImageRuntimeInputPlanProofFromBuildRecord(
  value: unknown,
  image: string,
): RunnerImageRuntimeInputPlanProof | null {
  if (
    !isPublishedRunnerImageBuildRecord(value) ||
    value.image.immutableRef !== image ||
    value.runtimeInputPlanProof === undefined
  ) {
    return null;
  }
  return value.runtimeInputPlanProof;
}

function validSourceAuthority(value: unknown): boolean {
  return (
    record(value) &&
    boundedString(value.repository, 4_096) &&
    value.repository.trim().length > 0 &&
    typeof value.commit === "string" &&
    COMMIT.test(value.commit) &&
    typeof value.authoritySha256 === "string" &&
    SHA256.test(value.authoritySha256) &&
    value.authoritySha256 ===
      platformReleaseSourceAuthorityDigest({
        kind: "takosumi.platform-release-source@v1",
        repository: value.repository,
        commit: value.commit,
      })
  );
}

function validReview(value: unknown): value is string {
  return (
    boundedString(value, 256) &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !/-----BEGIN [^-]*PRIVATE KEY-----/iu.test(value) &&
    !/\b(?:bearer|token|secret|password)\s*[=:]\s*\S+/iu.test(value) &&
    !/\b(?:gh[pousr]_|sk_live_|AKIA)[0-9A-Za-z]{12,}/u.test(value)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    keys.every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
