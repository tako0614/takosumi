import { describe, expect, test } from "bun:test";

import {
  buildRunnerProofApplyEnvelope,
  buildRunnerProofPlanEnvelope,
  RUNNER_PROOF_OUTPUTS,
} from "../../scripts/prove-runner-docker-payload.ts";

const REQUESTED_AT = "2026-07-16T00:00:00.000Z";

describe("runner Docker proof payload", () => {
  test("builds a current provider-free generated-root plan envelope", () => {
    const envelope = buildRunnerProofPlanEnvelope("proof-1", REQUESTED_AT);
    const mainTf = envelope.request.generatedRoot.files["main.tf"];

    expect(envelope).toMatchObject({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId: "proof-1",
      requestedAt: REQUESTED_AT,
      request: {
        generatedRoot: { files: { "main.tf": expect.any(String) } },
        operatorModule: { files: [{ path: "main.tf" }] },
        planRun: {
          id: "proof-1",
          operation: "create",
          source: {
            kind: "operator_module",
            digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
          requiredProviders: [],
        },
      },
    });
    expect("moduleFiles" in envelope.request.generatedRoot).toBe(false);
    expect(envelope.request.outputAllowlist).toEqual(
      Object.fromEntries(
        Object.keys(RUNNER_PROOF_OUTPUTS).map((name) => [name, { from: name }]),
      ),
    );

    for (const name of Object.keys(RUNNER_PROOF_OUTPUTS)) {
      expect(mainTf).toContain(`output "${name}"`);
    }
    expect(mainTf).not.toMatch(/\b(?:provider|resource|data)\s+"/u);
    expect(mainTf).not.toMatch(/\bmodule\s+"/u);
    expect(mainTf).not.toContain("required_providers");
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
    expect(apply.request.operatorModule).toEqual(plan.request.operatorModule);
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
