import { expect, test } from "bun:test";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { CloudflareContainerOpenTofuRunner } from "../../../worker/src/container_runner.ts";
import {
  OpenTofuRunnerExecutionError,
  OpenTofuRunnerInfrastructureError,
} from "../../../core/domains/deploy-control/mod.ts";
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

function envAnswering(
  respond: (request: Request) => Response,
  headers: (string | null)[] = [],
): CloudflareWorkerEnv {
  return {
    RUNNER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          headers.push(request.headers.get(RUN_DEADLINE_AT_HEADER));
          return respond(request);
        },
      }),
    },
  } as unknown as CloudflareWorkerEnv;
}

test("a dispatch the runner object refused for lack of time is a safe infrastructure retry", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envAnswering(() =>
      Response.json(
        {
          error: "OpenTofu runner run deadline leaves too little time to dispatch",
          errorCode: "runner_run_deadline_exceeded",
          status: "failed",
          phase: "run_dispatch",
          retryable: true,
        },
        { status: 503 },
      ),
    ),
  );

  const failure = await runner
    .apply(mutationJob(), { deadlineAt: Date.now() + 60_000 })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(OpenTofuRunnerInfrastructureError);
  expect((failure as OpenTofuRunnerInfrastructureError).reason).toBe(
    "run_deadline_exceeded",
  );
});

test("a provider failure the run deadline caused carries a fixed diagnostic code", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envAnswering(() =>
      Response.json(
        {
          ...PERSISTED_PROVIDER_FAILURE,
          runDeadlineExceeded: true,
          // A long bounded detail can omit the marker line; the code cannot.
          detail: "x".repeat(8_000),
        },
        { status: 500 },
      ),
    ),
  );

  const applied = await runner.apply(mutationJob(), {
    deadlineAt: Date.now() + 60_000,
  });

  expect(
    applied.diagnostics?.some(
      (diagnostic) =>
        diagnostic.code === "run_deadline_exceeded" &&
        diagnostic.severity === "error",
    ),
  ).toBe(true);
  expect(applied.providerExecutionFailure?.statePersistence).toBe("persisted");
});

test("a plan failure the run deadline caused reports the fixed reason", async () => {
  const runner = new CloudflareContainerOpenTofuRunner(
    envAnswering(() =>
      Response.json(
        {
          status: "failed",
          errorCode: "opentofu_plan_failed",
          phase: "plan",
          runDeadlineExceeded: true,
        },
        { status: 500 },
      ),
    ),
  );

  const failure = await runner
    .plan(
      { planRun: { id: "plan_deadline" } } as Parameters<
        CloudflareContainerOpenTofuRunner["plan"]
      >[0],
      { deadlineAt: Date.now() + 60_000 },
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
  expect((failure as OpenTofuRunnerExecutionError).reason).toBe(
    "run_deadline_exceeded",
  );
});

test("a release command dispatch carries the run deadline", async () => {
  const deadlineAt = Date.parse("2026-10-11T08:30:59.920Z");
  const headers: (string | null)[] = [];
  const runner = new CloudflareContainerOpenTofuRunner(
    envAnswering(
      () => Response.json({ status: "succeeded", commandCount: 1 }),
      headers,
    ),
  );

  await runner.release!(
    {
      runId: "release_apply_deadline",
      commands: [
        {
          id: "migrate",
          phase: "post_apply",
          command: ["bun", "run", "migrate"],
        },
      ],
      sourceSnapshot: {
        id: "snapshot_deadline",
        archiveRef: "workspaces/ws/sources/src/snapshots/snap/source.tar.zst",
        archiveDigest: `sha256:${"a".repeat(64)}`,
        resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
      },
      nonSensitiveOutputs: {},
      providerConfigurations: {
        format: "takosumi.provider-configurations@v1",
        providers: [],
      },
      applyRunId: "apply_deadline",
      workspaceId: "ws_deadline",
      capsuleId: "cap_deadline",
      stateVersionId: "state_deadline",
    } as unknown as Parameters<
      NonNullable<CloudflareContainerOpenTofuRunner["release"]>
    >[0],
    { deadlineAt },
  );

  expect(headers).toEqual([String(deadlineAt)]);
});
