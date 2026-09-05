import { describe, expect, test } from "bun:test";

import {
  buildRunnerProofApplyEnvelope,
  buildRunnerProofPlanEnvelope,
  RUNNER_PROOF_MAIN_TF,
  RUNNER_PROOF_OUTPUTS,
} from "../../scripts/prove-runner-docker-payload.ts";

const REQUESTED_AT = "2026-07-16T00:00:00.000Z";

describe("runner Docker proof payload", () => {
  test("builds a current provider-free Git plan envelope", () => {
    const envelope = buildRunnerProofPlanEnvelope("proof-1", REQUESTED_AT);

    expect(envelope).toMatchObject({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId: "proof-1",
      requestedAt: REQUESTED_AT,
      request: {
        generatedRoot: {
          files: {
            "versions.tf": "terraform {}\n",
            "variables.tf": expect.stringContaining(
              'variable "takosumi_runtime_inputs__probe"',
            ),
            "main.tf": expect.stringContaining('module "proof"'),
            "outputs.tf": expect.stringContaining('output "base_domain"'),
          },
        },
        planRun: {
          id: "proof-1",
          operation: "create",
          source: {
            kind: "git",
            url: "https://proof.invalid/runner.git",
            commit: "0123456789abcdef0123456789abcdef01234567",
          },
          requiredProviders: [],
        },
      },
    });
    expect("operatorModule" in envelope.request).toBe(false);
    expect(envelope.request.credentials).toEqual({
      env: { PROBE_TOKEN: "runner-proof-fake-credential" },
      manifest: {
        bindings: [
          {
            providerSource: "registry.opentofu.org/example/probe",
            connectionId: "runner-proof-connection",
            recipeId: "runner-proof",
            authMode: "token",
            envNames: ["PROBE_TOKEN"],
            fileEnvNames: [],
            requiredEnvGroups: [["PROBE_TOKEN"]],
          },
        ],
      },
      runtimeInputs: [
        {
          variableName: "takosumi_runtime_inputs__probe",
          names: ["PROBE_TOKEN"],
          values: {},
        },
      ],
    });
    expect(envelope.request.outputAllowlist).toEqual(
      Object.fromEntries(
        Object.keys(RUNNER_PROOF_OUTPUTS).map((name) => [name, { from: name }]),
      ),
    );

    for (const name of Object.keys(RUNNER_PROOF_OUTPUTS)) {
      expect(RUNNER_PROOF_MAIN_TF).toContain(`output "${name}"`);
    }
    expect(RUNNER_PROOF_MAIN_TF).toContain(
      'variable "takosumi_runtime_inputs__probe"',
    );
    expect(RUNNER_PROOF_MAIN_TF).toContain("type      = map(string)");
    expect(RUNNER_PROOF_MAIN_TF).toContain("sensitive = true");
    expect(RUNNER_PROOF_MAIN_TF).toContain("ephemeral = true");
    expect(RUNNER_PROOF_MAIN_TF).not.toContain("default =");
    expect(RUNNER_PROOF_MAIN_TF).not.toMatch(
      /\b(?:provider|resource|data)\s+"/u,
    );
    expect(RUNNER_PROOF_MAIN_TF).not.toMatch(/\bmodule\s+"/u);
    expect(RUNNER_PROOF_MAIN_TF).not.toContain("required_providers");
  });

  test("replays the same root and current runner-local artifact for apply", () => {
    const plan = buildRunnerProofPlanEnvelope("proof-1", REQUESTED_AT);
    const apply = buildRunnerProofApplyEnvelope(
      "proof-1",
      "sha256:plan",
      REQUESTED_AT,
    );

    expect(apply.action).toBe("apply");
    expect(apply.request.generatedRoot).toEqual(plan.request.generatedRoot);
    expect(apply.request.planRun.source).toEqual(plan.request.planRun.source);
    expect(apply.request.credentials).toEqual({
      env: { PROBE_TOKEN: "runner-proof-fake-credential" },
      manifest: plan.request.credentials.manifest,
      runtimeInputs: [
        {
          variableName: "takosumi_runtime_inputs__probe",
          names: ["PROBE_TOKEN"],
          values: { PROBE_TOKEN: "runner-proof-fake-token-20260905" },
        },
      ],
    });
    expect(JSON.stringify(apply.request.generatedRoot)).not.toContain(
      "runner-proof-fake-token-20260905",
    );
    expect(apply.request.planArtifact).toEqual({
      kind: "runner-local",
      ref: "runner-local://proof-1/tfplan",
      digest: "sha256:plan",
    });
  });

  test("rejects apply without a reviewed plan digest", () => {
    expect(() => buildRunnerProofApplyEnvelope("proof-1", "")).toThrow(
      "apply mode requires a planDigest argument",
    );
  });
});
