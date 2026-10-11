import { expect, test } from "bun:test";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { CloudflareContainerOpenTofuRunner } from "../../../worker/src/container_runner.ts";
import {
  parseRunDeadlineAt,
  RUN_DEADLINE_AT_HEADER,
} from "../../../worker/src/runner_protocol.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const STATE_DIGEST =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const STATE_REF =
  "workspaces/ws_deadline/capsules/cap_deadline/environments/production/state-versions/00000001.tfstate.enc";
const STATE_SCOPE = {
  workspaceId: "ws_deadline",
  subject: { kind: "capsule", id: "cap_deadline" },
  environment: "production",
  generation: 1,
  stateRef: STATE_REF,
};
// What the runner object answers for a run its deadline stopped: a provider
// failure whose partial state it already persisted.
const PERSISTED_PROVIDER_FAILURE = {
  status: "failed",
  phase: "apply",
  exitCode: 124,
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
};

function capturingEnv(headers: (string | null)[]): CloudflareWorkerEnv {
  return {
    RUNNER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          headers.push(request.headers.get(RUN_DEADLINE_AT_HEADER));
          return Response.json(PERSISTED_PROVIDER_FAILURE, { status: 500 });
        },
      }),
    },
  } as unknown as CloudflareWorkerEnv;
}

function mutationJob(): Parameters<CloudflareContainerOpenTofuRunner["apply"]>[0] {
  return {
    applyRun: { id: "apply_deadline" },
    planRun: { id: "plan_deadline" },
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://plan_deadline/tfplan",
      digest: PLAN_DIGEST,
    },
    stateScope: STATE_SCOPE,
    rawOutputRef:
      "workspaces/ws_deadline/capsules/cap_deadline/runs/apply_deadline/outputs.raw.json.enc",
  } as Parameters<CloudflareContainerOpenTofuRunner["apply"]>[0];
}

test("the run deadline reaches the runner object for plan, apply, and destroy", async () => {
  const deadlineAt = Date.parse("2026-10-11T08:30:59.920Z");
  const headers: (string | null)[] = [];
  const runner = new CloudflareContainerOpenTofuRunner(capturingEnv(headers));

  await runner
    .plan(
      { planRun: { id: "plan_deadline" } } as Parameters<
        CloudflareContainerOpenTofuRunner["plan"]
      >[0],
      { deadlineAt },
    )
    .catch(() => undefined);
  const applied = await runner.apply(mutationJob(), { deadlineAt });
  const destroyed = await runner.destroy(mutationJob(), { deadlineAt });

  expect(headers).toEqual([
    String(deadlineAt),
    String(deadlineAt),
    String(deadlineAt),
  ]);
  // The deadline only bounds the run; a determined outcome still converges.
  expect(applied.providerExecutionFailure?.statePersistence).toBe("persisted");
  expect(destroyed.providerExecutionFailure?.statePersistence).toBe(
    "persisted",
  );
});

test("a dispatch without a host deadline sends no deadline header", async () => {
  const headers: (string | null)[] = [];
  const runner = new CloudflareContainerOpenTofuRunner(capturingEnv(headers));

  await runner.apply(mutationJob());
  await runner.apply(mutationJob(), {});
  await runner.apply(mutationJob(), { deadlineAt: Number.NaN });

  expect(headers).toEqual([null, null, null]);
});

test("the runner object accepts only a strict epoch-millisecond deadline", () => {
  expect(parseRunDeadlineAt("1791707459920")).toBe(1_791_707_459_920);
  for (const invalid of [null, "", "0", "-1", "1.5", "1e12", "soon"]) {
    expect(parseRunDeadlineAt(invalid)).toBeUndefined();
  }
});
