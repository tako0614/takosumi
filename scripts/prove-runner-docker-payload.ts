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

export const RUNNER_PROOF_RUNTIME_INPUT_VARIABLE =
  "takosumi_runtime_inputs__probe" as const;
export const RUNNER_PROOF_RUNTIME_INPUT_NAME = "PROBE_TOKEN" as const;

const RUNNER_PROOF_CREDENTIAL_MANIFEST = {
  bindings: [
    {
      providerSource: "registry.opentofu.org/example/probe",
      connectionId: "runner-proof-connection",
      recipeId: "runner-proof",
      authMode: "token",
      envNames: [RUNNER_PROOF_RUNTIME_INPUT_NAME],
      fileEnvNames: [],
      requiredEnvGroups: [[RUNNER_PROOF_RUNTIME_INPUT_NAME]],
    },
  ],
} as const;

const RUNNER_PROOF_RUNTIME_INPUT_DECLARATION = [
  `variable "${RUNNER_PROOF_RUNTIME_INPUT_VARIABLE}" {`,
  "  type      = map(string)",
  "  sensitive = true",
  "  ephemeral = true",
  "}",
  "",
].join("\n");

export const RUNNER_PROOF_MAIN_TF = [
  "terraform {",
  '  required_version = ">= 1.9.0"',
  "}",
  "",
  RUNNER_PROOF_RUNTIME_INPUT_DECLARATION,
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

function generatedRoot() {
  return {
    files: {
      "versions.tf": "terraform {}\n",
      "variables.tf": RUNNER_PROOF_RUNTIME_INPUT_DECLARATION,
      "main.tf": [
        'module "proof" {',
        '  source = "./module"',
        `  ${RUNNER_PROOF_RUNTIME_INPUT_VARIABLE} = var.${RUNNER_PROOF_RUNTIME_INPUT_VARIABLE}`,
        "}",
        "",
      ].join("\n"),
      "outputs.tf": Object.keys(RUNNER_PROOF_OUTPUTS)
        .map(
          (name) =>
            [
              `output "${name}" {`,
              `  value = module.proof.${name}`,
              "}",
              "",
            ].join("\n"),
        )
        .join("\n"),
    },
  } as const;
}

function runtimeInputCredentials(
  values: Readonly<Record<string, string>>,
) {
  return {
    env: {
      [RUNNER_PROOF_RUNTIME_INPUT_NAME]: "runner-proof-fake-credential",
    },
    manifest: RUNNER_PROOF_CREDENTIAL_MANIFEST,
    runtimeInputs: [
      {
        variableName: RUNNER_PROOF_RUNTIME_INPUT_VARIABLE,
        names: [RUNNER_PROOF_RUNTIME_INPUT_NAME],
        values,
      },
    ],
  } as const;
}

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

function requestBase(
  runId: string,
  runtimeInputValues: Readonly<Record<string, string>>,
) {
  return {
    generatedRoot: generatedRoot(),
    planRun: planRun(runId),
    runnerProfile: {
      id: "runner-docker-proof",
      allowedProviders: [],
      deniedProviders: [],
    },
    credentials: runtimeInputCredentials(runtimeInputValues),
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
      ...requestBase(runId, {}),
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
      ...requestBase(runId, {
        [RUNNER_PROOF_RUNTIME_INPUT_NAME]:
          "runner-proof-fake-token-20260905",
      }),
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
