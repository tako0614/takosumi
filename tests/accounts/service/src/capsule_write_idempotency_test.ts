/**
 * Idempotency-Key on the capsule write lane: a retried plan POST must replay
 * the first response instead of creating a second Run.
 */
import { expect, test } from "bun:test";

import {
  InMemoryPortableHostIdempotencyLedger,
  PortableHostIdempotencyCoordinator,
} from "../../../../core/api/portable_host_idempotency.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleCapsules } from "../../../../accounts/service/src/control/capsules.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const WORKSPACE = {
  id: "ws_idem",
  handle: "idem",
  displayName: "Idem",
  type: "personal" as const,
  ownerUserId: "tsub_owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CAPSULE = {
  id: "cap_idem",
  workspaceId: WORKSPACE.id,
  name: "idem",
  environment: "production",
  status: "active",
  installConfigId: "cfg_idem",
  sourceId: "src_idem",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function planOperations(onPlan: () => void): ControlPlaneOperations {
  let planSeq = 0;
  return {
    capsules: {
      getCapsule: async () => CAPSULE,
    },
    workspaces: {
      getWorkspace: async () => WORKSPACE,
    },
    members: { listMembers: async () => [] },
    getRun: async (runId: string) => ({
      id: runId,
      workspaceId: WORKSPACE.id,
      capsuleId: CAPSULE.id,
      status: "queued",
      operation: "update",
      createdAt: 1,
      updatedAt: 1,
    }),
    getRunCost: async () => {
      throw new Error("no cost projection in this fixture");
    },
    createCapsulePlan: async () => {
      onPlan();
      planSeq += 1;
      return {
        planRun: {
          id: `plan_${planSeq}`,
          workspaceId: WORKSPACE.id,
          capsuleId: CAPSULE.id,
          status: "queued",
          operation: "update",
          createdAt: 1,
          updatedAt: 1,
        },
      };
    },
  } as unknown as ControlPlaneOperations;
}

function planContext(input: {
  readonly operations: ControlPlaneOperations;
  readonly idempotency?: PortableHostIdempotencyCoordinator;
  readonly key?: string;
  readonly body?: string;
}): ControlDispatchContext {
  const url = new URL("https://app.example.test/api/v1/capsules/cap_idem/plan");
  return {
    request: new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.key ? { "idempotency-key": input.key } : {}),
      },
      body: input.body ?? "{}",
    }),
    url,
    operations: input.operations,
    store: new InMemoryAccountsStore(),
    session: { subject: "tsub_owner", requiredAccess: "write" },
    ...(input.idempotency ? { idempotency: input.idempotency } : {}),
  };
}

async function postPlan(ctx: ControlDispatchContext): Promise<Response> {
  const response = await handleCapsules(
    ctx,
    ["capsules", "cap_idem", "plan"],
    "POST",
  );
  expect(response).toBeDefined();
  return response!;
}

test("a retried plan POST with the same key replays instead of creating a second run", async () => {
  let plans = 0;
  const operations = planOperations(() => {
    plans += 1;
  });
  const idempotency = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );
  const key = "install-retry-key-0001";

  const first = await postPlan(
    planContext({ operations, idempotency, key }),
  );
  expect(first.status).toBe(201);
  const firstBody = await first.text();

  const retry = await postPlan(
    planContext({ operations, idempotency, key }),
  );
  expect(retry.status).toBe(201);
  expect(await retry.text()).toBe(firstBody);
  expect(retry.headers.get("idempotency-replayed")).toBe("true");
  // The controller ran exactly once: no duplicate Run was created.
  expect(plans).toBe(1);
});

test("different keys still create separate runs", async () => {
  let plans = 0;
  const operations = planOperations(() => {
    plans += 1;
  });
  const idempotency = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );
  await postPlan(
    planContext({ operations, idempotency, key: "first-key-000001" }),
  );
  await postPlan(
    planContext({ operations, idempotency, key: "second-key-00001" }),
  );
  expect(plans).toBe(2);
});

test("omitting the header keeps today's non-idempotent behavior", async () => {
  let plans = 0;
  const operations = planOperations(() => {
    plans += 1;
  });
  const idempotency = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );
  await postPlan(planContext({ operations, idempotency }));
  await postPlan(planContext({ operations, idempotency }));
  expect(plans).toBe(2);
});

test("a malformed key is rejected before the controller runs", async () => {
  let plans = 0;
  const operations = planOperations(() => {
    plans += 1;
  });
  const response = await postPlan(
    planContext({
      operations,
      idempotency: new PortableHostIdempotencyCoordinator(
        new InMemoryPortableHostIdempotencyLedger(),
      ),
      key: "short",
    }),
  );
  expect(response.status).toBe(400);
  expect(plans).toBe(0);
});

test("the same key with a DIFFERENT body is rejected, not replayed", async () => {
  let plans = 0;
  const operations = planOperations(() => {
    plans += 1;
  });
  const idempotency = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );
  const key = "same-key-diff-body01";

  const first = await postPlan(
    planContext({
      operations,
      idempotency,
      key,
      body: JSON.stringify({ runnerProfileId: "profile-a" }),
    }),
  );
  expect(first.status).toBe(201);

  const mismatched = await postPlan(
    planContext({
      operations,
      idempotency,
      key,
      body: JSON.stringify({ runnerProfileId: "profile-b" }),
    }),
  );
  // Replaying profile-a's result here would tell the caller a plan ran that
  // never did.
  expect(mismatched.status).toBe(409);
  expect(plans).toBe(1);
});

test("an ambiguous failure keeps the key reserved so a retry cannot duplicate", async () => {
  let attempts = 0;
  const operations = {
    ...planOperations(() => undefined),
    createCapsulePlan: async () => {
      attempts += 1;
      // Stands in for "the Capsule was created, then wiring it up failed".
      throw new Error("partial failure after a canonical mutation");
    },
  } as unknown as ControlPlaneOperations;
  const idempotency = new PortableHostIdempotencyCoordinator(
    new InMemoryPortableHostIdempotencyLedger(),
  );
  const key = "ambiguous-failure-01";

  await expect(
    postPlan(planContext({ operations, idempotency, key })),
  ).rejects.toThrow();

  const retry = await postPlan(planContext({ operations, idempotency, key }));
  // The retry is refused rather than executed a second time.
  expect(retry.status).toBe(409);
  expect(attempts).toBe(1);
});
