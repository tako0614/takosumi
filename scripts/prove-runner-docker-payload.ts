/**
 * Emit provider-free plan/apply envelopes for the real runner image proof.
 *
 * The proof uses a pinned Git source that the Docker harness restores into the
 * runner workspace before dispatch. All proof values are produced by the
 * ordinary root main.tf, with no provider, resource, or data source.
 */

export const RUNNER_PROOF_ENVELOPE_KIND = "takosumi.opentofu-run@v1";

export const RUNNER_PROOF_OUTPUTS = {
  base_domain: "proof.example.com",
  public_origin: "https://proof.example.com",
  member_issuer: "https://proof.example.com/auth",
  service_registry_url:
    "https://proof.example.com/.well-known/takosumi-services.json",
} as const;

export const RUNNER_PROOF_MAIN_TF = [
  "terraform {",
  '  required_version = ">= 1.9.0"',
  "}",
  "",
  "locals {",
  `  base_domain          = ${JSON.stringify(RUNNER_PROOF_OUTPUTS.base_domain)}`,
  '  public_origin        = "https://${local.base_domain}"',
  '  member_issuer        = "${local.public_origin}/auth"',
  '  service_registry_url = "${local.public_origin}/.well-known/takosumi-services.json"',
  "}",
  "",
  'output "base_domain" {',
  "  value = local.base_domain",
  "}",
  "",
  'output "public_origin" {',
  "  value = local.public_origin",
  "}",
  "",
  'output "member_issuer" {',
  "  value = local.member_issuer",
  "}",
  "",
  'output "service_registry_url" {',
  "  value = local.service_registry_url",
  "}",
  "",
].join("\n");

function planRun(runId: string) {
  return {
    id: runId,
    operation: "create",
    source: {
      kind: "git",
      url: "https://proof.invalid/runner.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    requiredProviders: [],
  } as const;
}

function requestBase(runId: string) {
  return {
    planRun: planRun(runId),
    runnerProfile: {
      id: "runner-docker-proof",
      allowedProviders: [],
      deniedProviders: [],
    },
  } as const;
}

export function buildRunnerProofPlanEnvelope(
  runId: string,
  requestedAt = new Date().toISOString(),
) {
  return {
    kind: RUNNER_PROOF_ENVELOPE_KIND,
    action: "plan",
    runId,
    requestedAt,
    request: {
      ...requestBase(runId),
      outputAllowlist: Object.fromEntries(
        Object.keys(RUNNER_PROOF_OUTPUTS).map((name) => [name, { from: name }]),
      ),
    },
  } as const;
}

export function buildRunnerProofApplyEnvelope(
  runId: string,
  planDigest: string,
  requestedAt = new Date().toISOString(),
) {
  if (!planDigest) {
    throw new Error("apply mode requires a planDigest argument");
  }
  return {
    kind: RUNNER_PROOF_ENVELOPE_KIND,
    action: "apply",
    runId,
    requestedAt,
    request: {
      ...requestBase(runId),
      planArtifact: {
        kind: "runner-local",
        ref: `runner-local://${runId}/tfplan`,
        digest: planDigest,
      },
    },
  } as const;
}

function main(): void {
  const [mode, runId, planDigest] = process.argv.slice(2);
  if (mode === "source") {
    process.stdout.write(RUNNER_PROOF_MAIN_TF);
    return;
  }
  if (!mode || !runId) {
    console.error(
      "usage: prove-runner-docker-payload.ts <source|plan|apply> [runId] [planDigest]",
    );
    process.exit(2);
  }
  if (mode === "plan") {
    process.stdout.write(JSON.stringify(buildRunnerProofPlanEnvelope(runId)));
    return;
  }
  if (mode === "apply") {
    process.stdout.write(
      JSON.stringify(buildRunnerProofApplyEnvelope(runId, planDigest ?? "")),
    );
    return;
  }
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

if (import.meta.main) main();
