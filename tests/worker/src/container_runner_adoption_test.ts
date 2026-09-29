import { expect, test } from "bun:test";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { CloudflareContainerOpenTofuRunner } from "../../../worker/src/container_runner.ts";
import { OpenTofuRunnerExecutionError } from "../../../core/domains/deploy-control/mod.ts";
import { RUNNER_MUTATION_INDETERMINATE_CODE } from "../../../worker/src/runner_protocol.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const STATE_DIGEST =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const STATE_REF =
  "workspaces/ws_adopt/capsules/cap_adopt/environments/production/state-versions/00000001.tfstate.enc";
const RAW_OUTPUT_REF =
  "workspaces/ws_adopt/capsules/cap_adopt/runs/apply_adopt/outputs.raw.json.enc";
const STATE_SCOPE = {
  workspaceId: "ws_adopt",
  subject: { kind: "capsule", id: "cap_adopt" },
  environment: "production",
  generation: 1,
  stateRef: STATE_REF,
};
const INDETERMINATE_PAYLOAD = {
  error: "OpenTofu runner mutation outcome is indeterminate",
  errorCode: RUNNER_MUTATION_INDETERMINATE_CODE,
  retryable: false,
  outcome: "indeterminate",
};
const ADOPTED_PAYLOAD = {
  status: "succeeded",
  exitCode: 0,
  outputs: {},
  state: {
    generation: 1,
    stateRef: STATE_REF,
    digest: STATE_DIGEST,
    ciphertextLength: 32,
  },
  rawOutputRef: RAW_OUTPUT_REF,
};

function applyJob(): Parameters<CloudflareContainerOpenTofuRunner["apply"]>[0] {
  return {
    applyRun: { id: "apply_adopt" },
    planRun: { id: "plan_adopt" },
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://plan_adopt/tfplan",
      digest: PLAN_DIGEST,
    },
    stateScope: STATE_SCOPE,
    rawOutputRef: RAW_OUTPUT_REF,
  } as Parameters<CloudflareContainerOpenTofuRunner["apply"]>[0];
}

function envWithObject(object: Record<string, unknown>): CloudflareWorkerEnv {
  return {
    RUNNER: {
      idFromName: (name: string) => name,
      get: () => object,
    },
  } as unknown as CloudflareWorkerEnv;
}

test("container runner adopts the determined outcome of a lost dispatch response", async () => {
  const allocations: unknown[] = [];
  const runner = new CloudflareContainerOpenTofuRunner(
    envWithObject({
      fetch: async () => Response.json(INDETERMINATE_PAYLOAD, { status: 409 }),
      adoptDeterminedMutation: async (
        applyRunId: string,
        action: string,
        allocation: unknown,
      ) => {
        expect(applyRunId).toBe("apply_adopt");
        expect(action).toBe("apply");
        allocations.push(allocation);
        return Response.json(ADOPTED_PAYLOAD, { status: 200 });
      },
    }),
  );

  const result = await runner.apply(applyJob());

  expect(allocations).toEqual([
    { stateScope: STATE_SCOPE, rawOutputRef: RAW_OUTPUT_REF },
  ]);
  expect(result.stateDigest).toBe(STATE_DIGEST);
  expect(result.rawOutputRef).toBe(RAW_OUTPUT_REF);
});

test("container runner accepts a determined provider failure from the same adoption", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envWithObject({
      fetch: async () => Response.json(INDETERMINATE_PAYLOAD, { status: 409 }),
      // The object's own determined provider-failure reply for a completed
      // mutation: failedProviderExecutionPayload with statePersistence
      // "persisted" plus the state coordinate it was recorded with.
      adoptDeterminedMutation: async () =>
        Response.json(
          {
            status: "failed",
            phase: "apply",
            exitCode: 1,
            errorCode: "provider_execution_failed",
            providerExecutionFailure: {
              kind: "provider_execution_failed",
              statePersistence: "persisted",
            },
            state: {
              generation: 1,
              stateRef: STATE_REF,
              digest: STATE_DIGEST,
              ciphertextLength: 32,
            },
          },
          { status: 500 },
        ),
    }),
  );

  const result = await runner.apply(applyJob());

  expect(result.providerExecutionFailure).toBeDefined();
  expect(result.providerExecutionFailure?.statePersistence).toBe("persisted");
  expect(result.stateDigest).toBe(STATE_DIGEST);
});

test("container runner refuses an adopted success with no persisted state coordinate", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envWithObject({
      fetch: async () => Response.json(INDETERMINATE_PAYLOAD, { status: 409 }),
      // A "succeeded" reply that cannot name the state it persisted is not a
      // determined outcome; adopting it would report a success this call
      // cannot support.
      adoptDeterminedMutation: async () =>
        Response.json(
          { status: "succeeded", exitCode: 0, outputs: {} },
          { status: 200 },
        ),
    }),
  );

  const failure = await runner.apply(applyJob()).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
  expect((failure as OpenTofuRunnerExecutionError).reason).toBe(
    RUNNER_MUTATION_INDETERMINATE_CODE,
  );
});

test("container runner fails closed when the object cannot prove a determined outcome", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envWithObject({
      fetch: async () => Response.json(INDETERMINATE_PAYLOAD, { status: 409 }),
      // The object has the RPC but still cannot prove completion — an
      // allocation that does not match the durable receipt looks exactly like
      // this.
      adoptDeterminedMutation: async () =>
        Response.json(INDETERMINATE_PAYLOAD, { status: 409 }),
    }),
  );

  const failure = await runner.apply(applyJob()).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
  expect((failure as OpenTofuRunnerExecutionError).reason).toBe(
    RUNNER_MUTATION_INDETERMINATE_CODE,
  );
});

test("container runner keeps the indeterminate failure for an object without the adoption RPC", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envWithObject({
      fetch: async () => Response.json(INDETERMINATE_PAYLOAD, { status: 409 }),
    }),
  );

  const failure = await runner.apply(applyJob()).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
  expect((failure as OpenTofuRunnerExecutionError).reason).toBe(
    RUNNER_MUTATION_INDETERMINATE_CODE,
  );
});
