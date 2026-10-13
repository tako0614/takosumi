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

test("slot-bearing Cloud runs probe and rotate the exact owner through the Runner object", async () => {
  const calls: string[] = [];
  const env = {
    RUNNER: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (request: Request) => {
          calls.push(`${name} ${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
          if (request.method === "GET") return Response.json({
            owner: { kind: "apply", id: "apply_deadline" },
            runnerRunId: "apply_deadline",
            capabilities: ["takosumi.runner-private-run-files-refresh@v1"],
          });
          return Response.json({ ok: true, status: "updated", sequence: 1 });
        },
      }),
    },
  } as unknown as CloudflareWorkerEnv;
  const runner = new CloudflareContainerOpenTofuRunner(env);
  await runner.assertPrivateRunFileRefreshCapability!({
    owner: { kind: "apply", id: "apply_deadline" },
    runnerRunId: "apply_deadline",
  });
  await runner.refreshPrivateRunFiles!({
    kind: "takosumi.private-run-files.refresh@v1",
    owner: { kind: "apply", id: "apply_deadline" },
    runnerRunId: "apply_deadline",
    manifestDigest: `sha256:${"a".repeat(64)}`,
    sequence: 1,
    files: [{ slot: "state", endpoint: "https://private.example.test", grant: "artificial-grant" }],
  });
  expect(calls).toEqual([
    "apply_deadline GET /capabilities?ownerKind=apply&ownerId=apply_deadline&runnerRunId=apply_deadline",
    "apply_deadline PUT /runs/apply_deadline/private-run-files",
  ]);
});

test("only slot-bearing Apply and Destroy dispatch under the execution ID", async () => {
  const calls: string[] = [];
  const env = {
    RUNNER: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (request: Request) => {
          calls.push(`${name} ${new URL(request.url).pathname}`);
          return Response.json(PERSISTED_PROVIDER_FAILURE, { status: 500 });
        },
      }),
    },
  } as unknown as CloudflareWorkerEnv;
  const runner = new CloudflareContainerOpenTofuRunner(env);
  const legacy = mutationJob();
  const privateFiles = {
    ...legacy,
    privateRunFiles: [{
      slot: "checkpoint",
      endpoint: "https://private.example.test/internal/private-run-files/v1",
      grant: "artificial-grant",
    }],
  };
  await runner.apply(legacy);
  await runner.destroy(legacy);
  await runner.apply(privateFiles);
  await runner.destroy(privateFiles);
  expect(calls).toEqual([
    "apply_deadline /runs/plan_deadline",
    "apply_deadline /runs/plan_deadline",
    "apply_deadline /runs/apply_deadline",
    "apply_deadline /runs/apply_deadline",
  ]);
});

test("Cloud adapter refuses a private file refresh ACK for the wrong sequence", async () => {
  const runner = new CloudflareContainerOpenTofuRunner({
    RUNNER: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ ok: true, status: "updated", sequence: 0 }) }),
    },
  } as unknown as CloudflareWorkerEnv);
  await expect(runner.refreshPrivateRunFiles({
    kind: "takosumi.private-run-files.refresh@v1",
    owner: { kind: "plan", id: "plan_ack" },
    runnerRunId: "plan_ack",
    manifestDigest: `sha256:${"a".repeat(64)}`,
    sequence: 1,
    files: [{ slot: "checkpoint", endpoint: "https://private.example.test", grant: "artificial-grant" }],
  })).rejects.toThrow("rejected");
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
        diagnostic.severity === "warning",
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

function planEnv(planResourceChanges: unknown): CloudflareWorkerEnv {
  return envAnswering(() =>
    Response.json({
      status: "succeeded",
      planDigest: PLAN_DIGEST,
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_changes/tfplan",
        digest: PLAN_DIGEST,
      },
      ...(planResourceChanges === undefined ? {} : { planResourceChanges }),
    }),
  );
}

test("a known-empty resource change list reaches Core as empty, not unknown", async () => {
  const plan = (env: CloudflareWorkerEnv) =>
    new CloudflareContainerOpenTofuRunner(env).plan({
      planRun: { id: "plan_changes" },
    } as Parameters<CloudflareContainerOpenTofuRunner["plan"]>[0]);

  expect((await plan(planEnv([]))).planResourceChanges).toEqual([]);
  // Absent stays unknown, and so does a list with a row that cannot be read.
  expect((await plan(planEnv(undefined))).planResourceChanges).toBeUndefined();
  expect(
    (
      await plan(
        planEnv([
          {
            address: "cloudflare_workers_script.app",
            type: "cloudflare_workers_script",
            actions: ["create"],
          },
          { address: "malformed" },
        ]),
      )
    ).planResourceChanges,
  ).toBeUndefined();
});

test("an Apply whose init the run deadline stopped keeps its pre-provider reason", async () => {
  // Core decides from the reason whether provider execution could have begun;
  // the deadline must ride alongside it, never replace it.
  const runner = new CloudflareContainerOpenTofuRunner(
    envAnswering(() =>
      Response.json(
        {
          status: "failed",
          errorCode: "opentofu_init_failed",
          phase: "apply",
          runDeadlineExceeded: true,
        },
        { status: 500 },
      ),
    ),
  );

  const failure = await runner
    .apply(mutationJob(), { deadlineAt: Date.now() + 60_000 })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
  expect((failure as OpenTofuRunnerExecutionError).reason).toBe(
    "opentofu_init_failed",
  );
  expect((failure as OpenTofuRunnerExecutionError).runDeadlineExceeded).toBe(
    true,
  );
});
