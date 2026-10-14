/** Closed owning build profiles. A caller never supplies a Dockerfile path. */
export type RunnerImageProfile = "standard" | "hosted-metered-v1";

export const HOSTED_METERED_RUNNER_PROFILE = "hosted-metered-v1" as const;
export const RUNNER_IMAGE_METERED_NATIVE_REPORT_KIND =
  "takosumi.runner-image-hosted-metered-native-report@v1" as const;
export const RUNNER_IMAGE_METERED_NATIVE_PROOF_KIND =
  "takosumi.runner-image-hosted-metered-native-proof@v1" as const;

type MeteredNativeGates = Readonly<{
  nativeEntrypoint: "passed";
  childBoundary: "passed";
  kernelCpuAndDrain: "passed";
  authenticatedRunLifecycle: "passed";
}>;

export type RunnerImageMeteredNativeReport = MeteredNativeGates & Readonly<{
  kind: typeof RUNNER_IMAGE_METERED_NATIVE_REPORT_KIND;
  profile: typeof HOSTED_METERED_RUNNER_PROFILE;
  descriptorDigest: string;
}>;

export type RunnerImageMeteredNativeProof = MeteredNativeGates & Readonly<{
  kind: typeof RUNNER_IMAGE_METERED_NATIVE_PROOF_KIND;
  profile: typeof HOSTED_METERED_RUNNER_PROFILE;
  image: string;
}>;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IMAGE =
  /^registry\.cloudflare\.com\/[0-9a-f]{32}\/takosumi-runner@sha256:[0-9a-f]{64}$/u;
const GATES = [
  "nativeEntrypoint",
  "childBoundary",
  "kernelCpuAndDrain",
  "authenticatedRunLifecycle",
] as const;

export function runnerImageProfile(value: unknown = undefined): RunnerImageProfile {
  if (value === undefined || value === "standard") return "standard";
  if (value === HOSTED_METERED_RUNNER_PROFILE) return value;
  throw new Error("runner_image_profile_invalid");
}

export function runnerImageDockerfile(profile: RunnerImageProfile): string {
  return profile === "standard"
    ? "runner/Dockerfile"
    : "runner/Dockerfile.hosted-metered";
}

export function runnerImageNativeCandidateTag(
  commit: string,
  profile: RunnerImageProfile,
): string {
  return profile === "standard"
    ? `takosumi-runner-native-candidate:${commit}`
    : `takosumi-runner-hosted-metered-native-candidate:${commit}`;
}

export function isRunnerImageMeteredNativeReport(
  value: unknown,
  descriptorDigest?: string,
): value is RunnerImageMeteredNativeReport {
  return record(value) &&
    exactKeys(value, ["kind", "profile", "descriptorDigest", ...GATES]) &&
    value.kind === RUNNER_IMAGE_METERED_NATIVE_REPORT_KIND &&
    value.profile === HOSTED_METERED_RUNNER_PROFILE &&
    typeof value.descriptorDigest === "string" &&
    SHA256.test(value.descriptorDigest) &&
    (descriptorDigest === undefined || value.descriptorDigest === descriptorDigest) &&
    GATES.every((gate) => value[gate] === "passed");
}

export function isRunnerImageMeteredNativeProof(
  value: unknown,
  image: string,
): value is RunnerImageMeteredNativeProof {
  return record(value) &&
    exactKeys(value, ["kind", "profile", "image", ...GATES]) &&
    value.kind === RUNNER_IMAGE_METERED_NATIVE_PROOF_KIND &&
    value.profile === HOSTED_METERED_RUNNER_PROFILE &&
    value.image === image && IMAGE.test(image) &&
    GATES.every((gate) => value[gate] === "passed");
}

export function runnerImageMeteredNativeProof(
  report: RunnerImageMeteredNativeReport,
  image: string,
): RunnerImageMeteredNativeProof {
  if (
    !isRunnerImageMeteredNativeReport(report) || !IMAGE.test(image) ||
    !image.endsWith(`@${report.descriptorDigest}`)
  ) {
    throw new Error("runner_image_metered_native_proof_invalid");
  }
  const { descriptorDigest: _descriptorDigest, ...rest } = report;
  return { ...rest, kind: RUNNER_IMAGE_METERED_NATIVE_PROOF_KIND, image };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
